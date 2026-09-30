//! forge-v2 collaboration: issues, pull requests (`patch`), comments, reviews, events,
//! releases, labels and stars in the network's shared forge-collab / forge-core contracts
//! (`docs/contracts/forge-v2.md` §2, §3, §5, §6).
//!
//! Everything is keyed by the `repo` document id. Consensus gates the writes (§2): `event`
//! needs a `maintainer` or `writer` document for the repo, `authorEvent` needs the signer to
//! be the target's author (close / reopen only), `release` needs a maintainer, `label` any
//! member; issues, patches, comments, reviews and stars are un-gated. What is left
//! client-side is `FORGE_RULES_V2` ([`crate::rules::v2`]): the next state move
//! ([`next_transition`]), the metadata fold, approvals and well-formedness. Issue and PR state
//! is a chain fact: each close, reopen, merge, draft or ready is one `transition` document, and
//! the running sum of their `delta` is the target's state code (`STATE-COUNTS.md` §2). Numbers
//! are dense: the contract's `dense` rule pins `number` to the repo's issue + PR count.
//!
//! [`Collab`] is the one entry point. Reads need only a client ([`Collab::reader`]); writes
//! need the signer ([`Collab::new`]). [`Collab::create_issue`] / [`Collab::create_patch`] take
//! the dense next number (one count read) and are resumable: the signed create is journaled
//! before it is broadcast, so re-running an interrupted create re-broadcasts the same bytes
//! instead of opening a second issue. The importer creates through
//! [`Collab::create_imported`], which records the source number as `upstreamNumber`.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use super::private::{self, EventValue};
use super::{
    check_len, check_text, doc_engine, event_kind_to_u64, insert_imported, label_from_doc,
    release_from_doc, release_from_sealed, u64_to_event_kind, CommentAnchor, Imported, Label,
    Release, ReleaseFile, ReleaseInput, ReleaseList, ReleaseStore, ReleaseWritten, Verdict,
    DEFAULT_PAGE,
};
use crate::backends::sha256;
use crate::create::replay_landed;
use crate::error::{Error, Result};
use crate::keyring::Keyring;
use crate::keystore::BridgeIdentity;
use crate::members::{self, MemberReader};
use crate::network::ForgeIds;
use crate::platform::{
    self, BroadcastOutcome, FetchedDocument, FieldValue, LoadedContract, LoadedIdentity,
    PlatformClient, QueryFilter, QueryOrder, WriteEngine, WriteIntent,
};
use crate::private::DocKind;
use crate::rules::v2::{
    checks_state, count_approvals, dense_number, fold_pr_review_v2, is_author_kind, is_state_kind,
    is_well_formed, issue_state_v2, merge_transition, names_dense_rule, next_transition,
    pr_state_v2, repo_counts, state_code, status_of_code, Actor, Approvals, CheckRunRow,
    ChecksPolicy, ChecksState, ContentDoc, ContentKind, Policy, PrReviewState, RepoCounts,
    Review as RuleReview, Role, RoleOracle, StateAction, Transition, TransitionMove,
    TransitionTarget, Visibility, TRANSITION_KINDS,
};
use crate::rules::{self, Event, EventKind, IssueState, PrState};
use crate::scope::RepoRef;
use crate::user_error::{codes, UserError};

/// forge-collab document types (issue through milestone); forge-community ones are marked.
pub const DOC_ISSUE: &str = "issue";
/// A pull request.
pub const DOC_PATCH: &str = "patch";
/// A comment on an issue or patch.
pub const DOC_COMMENT: &str = "comment";
/// A review verdict on a patch.
pub const DOC_REVIEW: &str = "review";
/// A member-gated event (labels, assignees, retarget, milestones, review kinds, …).
pub const DOC_EVENT: &str = "event";
/// An author-gated event (thread resolution, review requests, head update).
pub const DOC_AUTHOR_EVENT: &str = "authorEvent";
/// A state change of an issue or PR (close, reopen, merge, draft, ready): immutable,
/// non-deletable, gated to members or the target's author, and judged against the target's
/// state code by the contract's rules.
pub const DOC_TRANSITION: &str = "transition";
/// forge-community: a branch policy (maintainer-gated).
pub const DOC_POLICY: &str = "policy";
/// forge-community: a check run reported on a head (maintainer- or writer-gated).
pub const DOC_CHECK_RUN: &str = "checkRun";
/// forge-community: a star (`indexOnly`).
pub const DOC_STAR: &str = "star";
/// forge-community: a trending beat (`indexOnly`, non-deletable): written beside a star when the starrer counts
/// toward Trending (platform-parity-spec §4.3).
pub const DOC_STAR_BEAT: &str = "starBeat";
/// forge-community: a watch (`indexOnly`): cross-device "watching this repo".
pub const DOC_WATCH: &str = "watch";
/// A milestone definition (maintainer- or writer-gated).
pub const DOC_MILESTONE: &str = "milestone";
/// forge-core: a release (maintainer-gated).
pub const DOC_RELEASE: &str = "release";
/// forge-core: a label definition (member-gated).
pub const DOC_LABEL: &str = "label";

/// Whether a star also counts toward Trending unless the user says otherwise (the owner's
/// default, 2026-09-28; `dg repo star --no-trending` and the `trending` config key opt out).
/// The web app's default is `TRENDING_DEFAULT` in `forge-web/lib/repo/trending.ts`.
pub const TRENDING_DEFAULT: bool = true;

/// The most PRs one push follows ([`Collab::prs_following`]): each costs a few reads.
pub const MAX_FOLLOWING: usize = 20;

/// Attempts at claiming the dense next number before giving up: each refusal (another create
/// took the number first) re-reads the count.
const MAX_NUMBER_ATTEMPTS: usize = 8;

/// The environment variable that turns the client-side role checks off, so a write reaches
/// consensus and is judged there (the e2e suite proves the gates this way). Shared with the
/// remote helper's push pre-check.
pub const SKIP_PRECHECK_ENV: &str = "DASH_FORGE_SKIP_WRITE_PRECHECK";

pub fn precheck_enabled() -> bool {
    !std::env::var(SKIP_PRECHECK_ENV).is_ok_and(|v| !v.is_empty() && v != "0")
}

// ===========================================================================
// Types
// ===========================================================================

/// Issue or pull request.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TargetKind {
    /// An `issue`.
    Issue,
    /// A `patch` (pull request).
    Patch,
}

/// The private-repository document kind of a content kind.
fn doc_kind(kind: ContentKind) -> DocKind {
    match kind {
        ContentKind::Issue => DocKind::Issue,
        ContentKind::Patch => DocKind::Patch,
        ContentKind::Comment => DocKind::Comment,
        ContentKind::Review => DocKind::Review,
        ContentKind::RefUpdate => DocKind::RefUpdate,
        ContentKind::Config => DocKind::Config,
        ContentKind::Release => DocKind::Release,
    }
}

/// The PR's approvals on its current head (§6) over `reviews` already read: member reviews
/// only, dismissed reviews skipped.
#[must_use]
pub fn approvals_over(reviews: &[Review], view: &PatchView, oracle: &RoleOracle) -> Approvals {
    let rule: Vec<RuleReview> = reviews
        .iter()
        .map(|r| RuleReview {
            id: r.document_id.clone(),
            reviewer: r.reviewer.clone(),
            verdict: r.verdict.code(),
            commit_oid: r.commit_oid.clone(),
            created_at: r.created_at,
        })
        .collect();
    count_approvals(&rule, oracle, &view.head, &view.dismissed())
}

/// A well-formed document as the public codecs read it: itself when `keys` is `None` (a public
/// repo), else decrypted, or `None` when it does not open.
fn open_with(
    keys: Option<&Keyring>,
    kind: ContentKind,
    d: FetchedDocument,
) -> Option<FetchedDocument> {
    match keys {
        None => Some(d),
        Some(kr) => {
            let opened = kr.open(doc_kind(kind), &d);
            private::open_doc(opened, d)
        }
    }
}

impl TargetKind {
    /// The `transition` target this is ([`TransitionTarget`]; its code is the stored `tk`).
    #[must_use]
    pub fn transition_target(self) -> TransitionTarget {
        match self {
            TargetKind::Issue => TransitionTarget::Issue,
            TargetKind::Patch => TransitionTarget::Patch,
        }
    }

    /// The content kind of this target's document.
    fn content_kind(self) -> ContentKind {
        match self {
            TargetKind::Issue => ContentKind::Issue,
            TargetKind::Patch => ContentKind::Patch,
        }
    }

    /// The forge-collab document type.
    pub fn doc_type(self) -> &'static str {
        match self {
            TargetKind::Issue => DOC_ISSUE,
            TargetKind::Patch => DOC_PATCH,
        }
    }

    /// "issue" / "pull request", for messages.
    pub fn noun(self) -> &'static str {
        match self {
            TargetKind::Issue => "issue",
            TargetKind::Patch => "pull request",
        }
    }
}

/// What an event or comment is about: an issue or a patch, by id and number.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    /// Issue or patch.
    pub kind: TargetKind,
    /// The document `$id` (base58).
    pub id: String,
    /// Its number in the repo.
    pub number: u32,
    /// Its author (`$ownerId`, base58): who may write an `authorEvent` for it.
    pub author: String,
}

/// An `issue` document, flattened.
#[derive(Debug, Clone)]
pub struct Issue {
    /// The issue number.
    pub number: u32,
    /// Document `$id`.
    pub document_id: String,
    /// Author (`$ownerId`).
    pub author: String,
    /// Title.
    pub title: String,
    /// Body (may be empty).
    pub body: String,
    /// Consensus `$createdAt` (ms).
    pub created_at: u64,
    /// Importer provenance, when the issue was archived from another forge.
    pub imported: Option<Imported>,
    /// The source forge's number (`upstreamNumber`), when an importer recorded it. A free
    /// field: show it only through [`crate::rules::v2::trusted_upstream_number`].
    pub upstream_number: Option<u32>,
}

impl Issue {
    /// This issue as an event / comment target.
    pub fn target(&self) -> Target {
        Target {
            kind: TargetKind::Issue,
            id: self.document_id.clone(),
            number: self.number,
            author: self.author.clone(),
        }
    }
}

/// A `patch` (pull request) document, flattened.
#[derive(Debug, Clone)]
pub struct Patch {
    /// The PR number (independent of issue numbers).
    pub number: u32,
    /// Document `$id`.
    pub document_id: String,
    /// The repo it was opened in (`repoId`, base58): the base repo.
    pub repo_id: String,
    /// Author (`$ownerId`).
    pub author: String,
    /// Title.
    pub title: String,
    /// Body.
    pub body: String,
    /// The base ref in this repo (e.g. `refs/heads/main`).
    pub base_ref_name: String,
    /// The repo holding the PR's objects (`sourceRepoId`): this repo or a fork.
    pub source_repo_id: String,
    /// The branch in the source repo it was opened from.
    pub source_ref_name: Option<String>,
    /// The head commit (hex).
    pub head_oid: String,
    /// A `packManifest` hash in the source repo, when the author recorded one (hex).
    pub patch_manifest_hash: Option<String>,
    /// Consensus `$createdAt` (ms).
    pub created_at: u64,
    /// Importer provenance.
    pub imported: Option<Imported>,
    /// The source forge's number (`upstreamNumber`), as on [`Issue::upstream_number`].
    pub upstream_number: Option<u32>,
}

/// The base a PR's merge is folded against: `baseRefName` as of the patch's `$createdAt`
/// ([`Collab::base_ref_tips`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrBase {
    /// The base ref (`refs/heads/main`).
    pub ref_name: String,
    /// When the PR was opened (ms).
    pub opened_at: u64,
}

impl Patch {
    /// The base this PR's merge is folded against.
    #[must_use]
    pub fn base(&self) -> PrBase {
        PrBase {
            ref_name: self.base_ref_name.clone(),
            opened_at: self.created_at,
        }
    }

    /// This PR as an event / comment target.
    pub fn target(&self) -> Target {
        Target {
            kind: TargetKind::Patch,
            id: self.document_id.clone(),
            number: self.number,
            author: self.author.clone(),
        }
    }
}

/// What a new pull request says.
#[derive(Debug, Clone)]
pub struct PatchInput {
    /// Title (1..=256 chars).
    pub title: String,
    /// Body (≤ 5120).
    pub body: String,
    /// The base ref in the target repo, e.g. `refs/heads/main`.
    pub base_ref_name: String,
    /// The repo id holding the head commit: the target repo itself or a fork.
    pub source_repo_id: String,
    /// The branch in the source repo, e.g. `refs/heads/feature`.
    pub source_ref_name: Option<String>,
    /// The head commit oid (20 bytes for SHA-1).
    pub head_oid: Vec<u8>,
    /// A `packManifest` hash in the source repo, if the author published one.
    pub patch_manifest_hash: Option<[u8; 32]>,
    /// Open as a draft: the create is followed by a draft transition (kind 14), since a
    /// `patch` carries no draft flag of its own.
    pub draft: bool,
}

/// A `comment`, flattened.
#[derive(Debug, Clone)]
pub struct Comment {
    /// Document `$id`.
    pub document_id: String,
    /// Author.
    pub author: String,
    /// Body.
    pub body: String,
    /// The comment this replies to (`replyTo`); `None` for a thread root.
    pub reply_to: Option<String>,
    /// The review it belongs to (`reviewId`).
    pub review_id: Option<String>,
    /// Its anchor fields (read them through [`crate::rules::v2::anchor_of`]).
    pub anchor: crate::rules::v2::AnchorFields,
    /// Consensus `$createdAt` (ms).
    pub created_at: u64,
    /// Importer provenance.
    pub imported: Option<Imported>,
}

/// A `review`, flattened.
#[derive(Debug, Clone)]
pub struct Review {
    /// Document `$id`.
    pub document_id: String,
    /// Reviewer (`$ownerId`).
    pub reviewer: String,
    /// The verdict.
    pub verdict: Verdict,
    /// The commit reviewed (hex).
    pub commit_oid: String,
    /// Body.
    pub body: String,
    /// How many `reviewId` comments the review announced (`commentCount`).
    pub comment_count: Option<u32>,
    /// Consensus `$createdAt` (ms).
    pub created_at: u64,
    /// Importer provenance.
    pub imported: Option<Imported>,
}

/// A target's history: its state changes (`transition`) and its events, by the gate that
/// admitted them (§3).
#[derive(Debug, Clone, Default)]
pub struct TargetLog {
    /// The target's `transition`s, oldest first: their `delta` sum is its state code.
    pub transitions: Vec<Transition>,
    /// Member `event`s (labels, assignees, retarget, milestones, review kinds).
    pub events: Vec<Event>,
    /// The author's own review-kind events (`authorEvent`).
    pub author_events: Vec<Event>,
    /// Private repos: member events whose sealed value is not readable here (kept, without
    /// their value).
    pub hidden_values: usize,
    /// Private repos: member events whose value an older client wrote in plaintext (kept:
    /// member-gated, so authentic, but not encrypted).
    pub plaintext_values: usize,
}

/// One page of a list, newest first.
#[derive(Debug, Clone)]
pub struct Listed<T> {
    /// The well-formed rows.
    pub rows: Vec<T>,
    /// How many rows of the page were skipped as not well-formed (§5).
    pub hidden: usize,
    /// The page was full: older rows exist beyond it.
    pub more: bool,
}

impl TargetLog {
    /// The target's state code: the sum of its transitions' `delta`, mod 16.
    #[must_use]
    pub fn state_code(&self) -> i64 {
        state_code(&self.transitions)
    }

    /// The whole sum of its transitions' `delta` (a lock adds 16).
    #[must_use]
    pub fn state_sum(&self) -> i64 {
        rules::v2::state_sum(&self.transitions)
    }

    /// Whether the conversation is locked (members only may post).
    #[must_use]
    pub fn locked(&self) -> bool {
        rules::v2::is_locked(&self.transitions)
    }
}

impl<T> Listed<T> {
    fn map<U>(self, f: impl FnMut(T) -> U) -> Listed<U> {
        Listed {
            rows: self.rows.into_iter().map(f).collect(),
            hidden: self.hidden,
            more: self.more,
        }
    }
}

/// An issue with its folded state.
#[derive(Debug, Clone)]
pub struct IssueView {
    /// The issue.
    pub issue: Issue,
    /// Open/closed, labels, assignees.
    pub state: IssueState,
    /// Events whose sealed value is not readable here ([`TargetLog::hidden_values`]).
    pub hidden_values: usize,
    /// Events whose value is in plaintext ([`TargetLog::plaintext_values`]).
    pub plaintext_values: usize,
    /// The issue's `transition`, `event` and `authorEvent` documents.
    pub log: TargetLog,
}

impl IssueView {
    /// The events that applied to the issue (every member `event`, and the author's own
    /// review-kind events), in fold order. Its state changes are [`TargetLog::transitions`].
    #[must_use]
    pub fn events(&self) -> Vec<&Event> {
        rules::review::merged_log(
            &self.log.events,
            &self.log.author_events,
            &self.issue.author,
        )
    }
}

/// A pull request with its folded state and approvals.
#[derive(Debug, Clone)]
pub struct PatchView {
    /// The PR.
    pub patch: Patch,
    /// Open/closed/merged, labels, draft.
    pub state: PrState,
    /// The PR's current head (hex): the newest `headUpdate`, else `patch.head_oid` (the head
    /// it was opened with). Approvals, staleness, the diff and merges use this.
    pub head: String,
    /// The review fold ([`fold_pr_review_v2`]) without thread roots, so `resolved_threads` is
    /// empty here; [`PatchView::review_with_threads`] adds them from the PR's comments.
    pub review: PrReviewState,
    /// The base ref's current tip (hex), when it has one.
    pub base_tip: Option<String>,
    /// Whether the head has been a tip of the base ref (a merge naming it would count).
    pub head_on_base: bool,
    /// Every commit the base ref has pointed at (what a merge may name).
    pub base_tips: BTreeSet<String>,
    /// The PR's `transition`, `event` and `authorEvent` documents.
    pub log: TargetLog,
}

impl PatchView {
    /// The review fold with thread resolution: the thread roots are the PR's comments that
    /// reply to nothing.
    #[must_use]
    pub fn review_with_threads(&self, comments: &[Comment]) -> PrReviewState {
        let roots: BTreeSet<String> = comments
            .iter()
            .filter(|c| c.reply_to.is_none())
            .map(|c| c.document_id.clone())
            .collect();
        fold_pr_review_v2(
            &self.log.events,
            &self.log.author_events,
            &self.patch.author,
            &self.patch.head_oid,
            &roots,
        )
    }

    /// The review ids a `reviewDismiss` names.
    #[must_use]
    pub fn dismissed(&self) -> BTreeSet<String> {
        self.review
            .dismissed_reviews
            .iter()
            .map(|d| d.review_id.clone())
            .collect()
    }
}

/// A `checkRun` on a head: the newest by `($createdAt, $id)` per `name` ([`Collab::check_runs`]).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckRun {
    /// Document `$id`.
    pub document_id: String,
    /// The check's name (`build`, `test`).
    pub name: String,
    /// `queued`, `in_progress` or `completed`.
    pub status: String,
    /// The outcome once completed (`success`, `failure`, …); empty before.
    pub conclusion: String,
    /// A link to the run's details.
    pub details_url: String,
    /// A short summary.
    pub summary: String,
    /// Who reported it (`$ownerId`).
    pub reporter: String,
    /// Whether the reporter is a current maintainer, writer or runner of the repo. Consensus
    /// admitted the document from one; a member removed since is no longer trusted (the
    /// approvals rule).
    pub trusted: bool,
    /// When the run started / completed (ms), as the reporter says.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<u64>,
    /// When the run completed (ms), as the reporter says.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<u64>,
    /// Where the log is, and its SHA-256 (hex): a reader verifies the bytes against it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub log_url: Option<String>,
    /// The log's SHA-256 (hex).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub log_sha256: Option<String>,
    /// Consensus `$createdAt` (ms).
    pub created_at: u64,
}

/// One check run per name among `docs` (a head's `checkRun` documents), sorted by name: the
/// newest run whose reporter `is_member`, which is what a merge counts ([`checks_state`]); an
/// untrusted run never shadows it. A name with no trusted run shows its newest run, untrusted.
/// Parity: forge-web `newestCheckRuns`.
pub fn newest_check_runs(
    docs: &[FetchedDocument],
    is_member: impl Fn(&str) -> bool,
) -> Vec<CheckRun> {
    let mut newest: BTreeMap<String, (&FetchedDocument, bool)> = BTreeMap::new();
    for d in docs {
        let Some(name) = d.field_str("name").filter(|n| !n.is_empty()) else {
            continue;
        };
        let trusted = is_member(&d.owner_id);
        let key = (trusted, d.created_at.unwrap_or_default(), &d.id);
        if newest.get(&name).is_none_or(|(e, e_trusted)| {
            key > (*e_trusted, e.created_at.unwrap_or_default(), &e.id)
        }) {
            newest.insert(name, (d, trusted));
        }
    }
    let newest = newest.into_iter().map(|(name, (d, _))| (name, d));
    newest
        .into_iter()
        .map(|(name, d)| CheckRun {
            document_id: d.id.clone(),
            name,
            status: d.field_str("status").unwrap_or_default(),
            conclusion: d.field_str("conclusion").unwrap_or_default(),
            details_url: d.field_str("detailsUrl").unwrap_or_default(),
            summary: d.field_str("summary").unwrap_or_default(),
            trusted: is_member(&d.owner_id),
            reporter: d.owner_id.clone(),
            created_at: d.created_at.unwrap_or_default(),
            started_at: d.field_u64("startedAt"),
            completed_at: d.field_u64("completedAt"),
            log_url: d.field_str("logUrl"),
            log_sha256: d.field_hex("logSha256"),
        })
        .collect()
}

/// Every `checkRun` on commit `oid` in `repo` (the `head (repoId, headOid, $createdAt)` index).
pub(crate) async fn check_run_docs(
    client: &PlatformClient,
    community: &LoadedContract,
    repo: &RepoRef,
    oid: Vec<u8>,
) -> Result<Vec<FetchedDocument>> {
    client
        .query_all_documents(
            community,
            DOC_CHECK_RUN,
            &[
                Collab::repo_filter(repo)?,
                QueryFilter::eq("headOid", FieldValue::bytes(oid)),
            ],
            &[
                QueryOrder::asc("repoId"),
                QueryOrder::asc("headOid"),
                QueryOrder::asc("$createdAt"),
            ],
        )
        .await
}

/// The payload of a state event (forge-v2.md §3 kinds table).
#[derive(Debug, Clone, Default)]
pub struct EventPayload<'a> {
    /// `value`: a label, an assignee, a retarget base, a dismissal reason, a milestone.
    pub value: Option<&'a str>,
    /// `oid`: a merge commit or a new head.
    pub oid: Option<&'a [u8]>,
    /// `refId` (base58): a thread root comment, a reviewer identity, a review.
    pub ref_id: Option<&'a str>,
}

/// How an allocated, journaled create ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Created {
    /// The number claimed.
    pub number: u32,
    /// The document id.
    pub document_id: String,
    /// `true` when an interrupted earlier run's transition was re-broadcast and confirmed
    /// (nothing was paid twice).
    pub resumed: bool,
    /// A PR opened as a draft: the draft transition's id.
    pub draft_transition: Option<String>,
}

/// One issue or PR as [`Collab::imported_targets`] reads it.
#[derive(Debug, Clone)]
pub struct ImportedRow {
    /// The target.
    pub target: Target,
    /// Its `imported` provenance (opened, in a private repo).
    pub imported: Option<Imported>,
    /// Its `upstreamNumber`.
    pub upstream_number: Option<u32>,
    /// A PR's base (for its merge check); `None` for an issue.
    pub base: Option<PrBase>,
}

/// A fetched (and opened) issue or patch as an [`ImportedRow`].
fn imported_row(kind: TargetKind, d: &FetchedDocument) -> ImportedRow {
    match kind {
        TargetKind::Issue => {
            let i = issue_from_doc(d);
            ImportedRow {
                target: i.target(),
                imported: i.imported,
                upstream_number: i.upstream_number,
                base: None,
            }
        }
        TargetKind::Patch => {
            let p = patch_from_doc(d);
            ImportedRow {
                target: p.target(),
                base: Some(p.base()),
                imported: p.imported,
                upstream_number: p.upstream_number,
            }
        }
    }
}

/// What [`Collab::create_imported`] creates.
#[derive(Debug, Clone, Copy)]
pub enum ImportedTarget<'a> {
    /// An issue.
    Issue {
        /// Title.
        title: &'a str,
        /// Body.
        body: &'a str,
    },
    /// A pull request (its `draft` is ignored: the importer writes state as transitions).
    Patch(&'a PatchInput),
}

/// Which gate an event, or a state change, went through.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StateRoute {
    /// A member (maintainer or writer): an `event`, or a `transition` with `asAuthor` 0.
    Member,
    /// The target's author: an `authorEvent`, or a `transition` with `asAuthor` = its number.
    Author,
}

/// A state change written ([`Collab::set_state`]).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StateChange {
    /// The gate: a member, or the target's author.
    pub route: StateRoute,
    /// The `transition` document id.
    pub transition_id: String,
    /// Its kind (1, 2, 11–17).
    pub kind: u8,
    /// The state code after it.
    pub after: i64,
}

// ===========================================================================
// Document codecs (pure)
// ===========================================================================

fn imported_of(d: &FetchedDocument) -> Option<Imported> {
    match d.fields.get("imported") {
        Some(FieldValue::Object(m)) => Some(Imported {
            author: m
                .get("author")
                .and_then(FieldValue::as_str)
                .unwrap_or_default()
                .to_string(),
            created_at: m
                .get("createdAt")
                .and_then(FieldValue::as_u64)
                .unwrap_or_default(),
            url: m
                .get("url")
                .and_then(FieldValue::as_str)
                .unwrap_or_default()
                .to_string(),
        }),
        _ => None,
    }
}

/// `upstreamNumber`, when set and in range.
fn upstream_number_of(d: &FetchedDocument) -> Option<u32> {
    d.field_u64("upstreamNumber")
        .and_then(|n| u32::try_from(n).ok())
        .filter(|&n| n > 0)
}

fn number_of(d: &FetchedDocument) -> u32 {
    d.field_u64("number")
        .and_then(|n| u32::try_from(n).ok())
        .unwrap_or_default()
}

/// A fetched `issue` as a [`Issue`].
pub fn issue_from_doc(d: &FetchedDocument) -> Issue {
    Issue {
        number: number_of(d),
        document_id: d.id.clone(),
        author: d.owner_id.clone(),
        title: d.field_str("title").unwrap_or_default(),
        body: d.field_str("body").unwrap_or_default(),
        created_at: d.created_at.unwrap_or_default(),
        imported: imported_of(d),
        upstream_number: upstream_number_of(d),
    }
}

/// A fetched `patch` as a [`Patch`].
pub fn patch_from_doc(d: &FetchedDocument) -> Patch {
    Patch {
        number: number_of(d),
        document_id: d.id.clone(),
        repo_id: id_field(d, "repoId").unwrap_or_default(),
        author: d.owner_id.clone(),
        title: d.field_str("title").unwrap_or_default(),
        body: d.field_str("body").unwrap_or_default(),
        base_ref_name: d.field_str("baseRefName").unwrap_or_default(),
        source_repo_id: d
            .field_bytes32("sourceRepoId")
            .map(platform::encode_identifier)
            .unwrap_or_default(),
        source_ref_name: d.field_str("sourceRefName"),
        head_oid: d.field_hex("headOid").unwrap_or_default(),
        patch_manifest_hash: d.field_hex("patchManifestHash"),
        created_at: d.created_at.unwrap_or_default(),
        imported: imported_of(d),
        upstream_number: upstream_number_of(d),
    }
}

/// A fetched `transition` as a rules [`Transition`]; `None` for a kind the contract does not
/// have (a newer client's).
pub fn transition_from_doc(d: &FetchedDocument) -> Option<Transition> {
    let kind = d
        .field_u64("kind")
        .and_then(|k| u8::try_from(k).ok())
        .filter(|k| TRANSITION_KINDS.contains(k))?;
    Some(Transition {
        id: d.id.clone(),
        kind,
        actor: d.owner_id.clone(),
        oid: d.field_hex("oid"),
        as_author: d
            .field_u64("asAuthor")
            .and_then(|n| u32::try_from(n).ok())
            .unwrap_or(0),
        created_at: d.created_at.unwrap_or_default(),
    })
}

/// The target a fetched `transition` names (`targetId`, base58).
fn transition_target_of(d: &FetchedDocument) -> Option<String> {
    id_field(d, "targetId")
}

fn id_field(d: &FetchedDocument, name: &str) -> Option<String> {
    d.field_bytes32(name).map(platform::encode_identifier)
}

fn comment_from_doc(d: &FetchedDocument) -> Comment {
    Comment {
        document_id: d.id.clone(),
        author: d.owner_id.clone(),
        body: d.field_str("body").unwrap_or_default(),
        reply_to: id_field(d, "replyTo"),
        review_id: id_field(d, "reviewId"),
        anchor: crate::rules::v2::AnchorFields {
            path: d.field_str("path"),
            line: d.field_u64("line"),
            start_line: d.field_u64("startLine"),
            side: d.field_u64("side"),
            commit_oid: d.field_hex("commitOid"),
        },
        created_at: d.created_at.unwrap_or_default(),
        imported: imported_of(d),
    }
}

fn review_from_doc(d: &FetchedDocument) -> Review {
    Review {
        document_id: d.id.clone(),
        reviewer: d.owner_id.clone(),
        verdict: Verdict::from_code(d.field_u64("verdict").unwrap_or_default()),
        commit_oid: d.field_hex("commitOid").unwrap_or_default(),
        body: d.field_str("body").unwrap_or_default(),
        comment_count: d
            .field_u64("commentCount")
            .and_then(|n| u32::try_from(n).ok()),
        created_at: d.created_at.unwrap_or_default(),
        imported: imported_of(d),
    }
}

/// A fetched `policy` as a [`Policy`].
pub fn policy_from_doc(d: &FetchedDocument) -> Policy {
    let small = |name: &str| {
        d.field_u64(name)
            .and_then(|n| u8::try_from(n).ok())
            .unwrap_or(0)
    };
    Policy {
        required_approvals: d
            .field_u64("requiredApprovals")
            .and_then(|n| u32::try_from(n).ok())
            .unwrap_or(0),
        approver_role: small("approverRole"),
        require_checks: d.field_bool("requireChecks"),
        merge_methods: small("mergeMethods"),
        required_checks: crate::scope::doc_text_list(d, "requiredChecks"),
        // Identifiers (base58); an empty array reads back as empty bytes.
        required_check_sources: match d.fields.get("requiredCheckSources") {
            Some(FieldValue::List(items)) => items
                .iter()
                .filter_map(|i| i.as_bytes()?.try_into().ok())
                .map(platform::encode_identifier)
                .collect(),
            _ => Vec::new(),
        },
    }
}

/// What every edit checks on the stored document before any key or signing work, and its
/// revision: it belongs to `repo` (its `repoId`), so the repo's visibility, not the caller's
/// argument, decides whether the edit is sealed (an id of a private repo's comment named with a
/// public repo must never take the plaintext path); `signer` wrote it (consensus admits a
/// replace from the owner only); and it has a `$revision` for the guard.
fn edit_check(
    repo: &RepoRef,
    doc_type: &str,
    stored: &FetchedDocument,
    signer: &str,
) -> Result<u64> {
    let own = stored
        .field_bytes32("repoId")
        .is_some_and(|r| platform::encode_identifier(r) == repo.id());
    if !own {
        return Err(UserError::new(
            codes::INVALID_REPO_REF,
            format!("{doc_type} {} is not in {}", stored.id, repo.display()),
        )
        .fix("name the repository the document belongs to; nothing was written")
        .into());
    }
    if stored.owner_id != signer {
        return Err(Error::NotPermitted {
            action: format!("edit this {doc_type}"),
            reason: "you are not its author; consensus admits an edit from the author only".into(),
            needs: "owner".into(),
        });
    }
    stored.revision.ok_or_else(|| {
        Error::Platform(format!(
            "{doc_type} {} came back without a $revision; it cannot be edited safely",
            stored.id
        ))
    })
}

/// A private replace's changes plus the removal of any plaintext text an older client left next
/// to `enc` on an issue or PR (its mutable `title` / `body`; a comment's `body` likewise), so
/// the re-sealed text is the only text the document carries.
fn clear_plaintext(
    kind: DocKind,
    stored: &FetchedDocument,
    mut sealed: BTreeMap<String, Option<FieldValue>>,
) -> BTreeMap<String, Option<FieldValue>> {
    let mutable: &[&str] = match kind {
        DocKind::Issue | DocKind::Patch => &["title", "body"],
        DocKind::Comment => &["body"],
        _ => &[],
    };
    for f in mutable {
        if stored.fields.contains_key(*f) {
            sealed.insert((*f).to_string(), None);
        }
    }
    sealed
}

/// The keys a PR edit re-seals under: the PR's own `epoch` (its ref-name hashes are keyed by it,
/// §4.5), which must be held and not `burned`.
fn patch_epoch_keys<'k>(
    burned: &BTreeSet<u32>,
    writer: &'k crate::private::Private,
    epoch: u32,
) -> Result<&'k crate::private::EpochKeys> {
    if burned.contains(&epoch) {
        return Err(UserError::new(
            codes::ROTATION_PENDING,
            format!("this PR was opened under key epoch {epoch}, which is closed; it can no longer be edited"),
        )
        .into());
    }
    writer.epoch_keys(epoch).ok_or_else(|| {
        UserError::new(
            codes::NOT_A_KEY_HOLDER,
            format!("you do not hold key epoch {epoch}, the epoch this PR is sealed under"),
        )
        .into()
    })
}

/// An issue's state: open or closed from its transitions, labels and assignees from its
/// member events.
fn fold_issue(log: &TargetLog) -> IssueState {
    issue_state_v2(log.state_code(), &log.events)
}

/// An `event` / `authorEvent` document as a fold [`Event`]; `None` for an unknown kind.
pub fn event_from_doc(d: &FetchedDocument) -> Option<Event> {
    let kind = d.field_u64("kind").and_then(u64_to_event_kind)?;
    Some(Event {
        id: d.id.clone(),
        target_id: d
            .field_bytes32("targetId")
            .map(platform::encode_identifier)
            .unwrap_or_default(),
        kind,
        actor: d.owner_id.clone(),
        value: d.field_str("value"),
        oid: d.field_hex("oid"),
        ref_id: id_field(d, "refId"),
        created_at: d.created_at.unwrap_or_default(),
    })
}

/// The §5 content view of a fetched document of `kind`.
fn content_of(kind: ContentKind, d: &FetchedDocument) -> ContentDoc {
    ContentDoc {
        kind,
        title: d.field_str("title"),
        body: d.field_str("body"),
        ref_name: d.field_str("refName"),
        base_ref_name: d.field_str("baseRefName"),
        source_ref_name: d.field_str("sourceRefName"),
        ref_name_hash: d.field_hex("refNameHash"),
        base_ref_name_hash: d.field_hex("baseRefNameHash"),
        source_ref_name_hash: d.field_hex("sourceRefNameHash"),
        path: d.field_str("path"),
        default_branch: None,
        protected_patterns: None,
        enc: d.field_hex("enc").filter(|h| !h.is_empty()),
        epoch: d.field_u64("epoch").and_then(|e| u32::try_from(e).ok()),
        release_fields: if kind == ContentKind::Release {
            crate::rules::v2::RELEASE_PLAINTEXT_FIELDS
                .iter()
                .filter(|k| d.fields.contains_key(**k))
                .map(|k| (*k).to_string())
                .collect()
        } else {
            Vec::new()
        },
    }
}

/// Whether a fetched document is well-formed for a repo of `visibility` (§5, the shared
/// [`is_well_formed`] rule). Readers skip the rest.
///
/// That includes a patch whose ref names do not hash to their indexed hashes: readers find
/// the base's history by `baseRefNameHash`, and `dg pr merge` pushes to `baseRefName`, so a
/// patch whose two disagree would be folded against one ref and merged into another.
pub fn well_formed(kind: ContentKind, d: &FetchedDocument, visibility: Visibility) -> bool {
    is_well_formed(&content_of(kind, d), visibility)
}

/// The source of an imported issue or PR: its provenance and, when known, the source forge's
/// number (`upstreamNumber`).
#[derive(Debug, Clone, Copy, Default)]
pub struct Provenance<'a> {
    /// The `imported` object.
    pub imported: Option<&'a Imported>,
    /// The source number.
    pub upstream_number: Option<u32>,
}

/// `tk` (the target kind tag `transition.targetKind` agrees on), `number`, and the
/// provenance of a new issue or PR.
///
/// `upstreamNumber` is a plain top-level integer (D-2): the sparse `upstream (repoId,
/// upstreamNumber)` index keys it, and an indexed property cannot be sealed, so it stays
/// plaintext in a private repo too (it says no more than the number itself does).
fn target_head(
    kind: TargetKind,
    number: u32,
    from: Provenance<'_>,
) -> Result<BTreeMap<String, FieldValue>> {
    let mut p = BTreeMap::new();
    p.insert("number".to_string(), FieldValue::integer(u64::from(number)));
    p.insert(
        "tk".to_string(),
        FieldValue::integer(u64::from(kind.transition_target().code())),
    );
    if let Some(n) = from.upstream_number.filter(|&n| n > 0) {
        p.insert(
            "upstreamNumber".to_string(),
            FieldValue::integer(u64::from(n)),
        );
    }
    insert_imported(&mut p, from.imported)?;
    Ok(p)
}

/// The creator-side properties of a new `issue`.
pub fn issue_props(
    number: u32,
    title: &str,
    body: &str,
    from: Provenance<'_>,
) -> Result<BTreeMap<String, FieldValue>> {
    check_title(title)?;
    check_text("issue body", body, 5120, 5120)?;
    let mut p = target_head(TargetKind::Issue, number, from)?;
    p.insert("title".to_string(), FieldValue::text(title));
    if !body.is_empty() {
        p.insert("body".to_string(), FieldValue::text(body));
    }
    Ok(p)
}

/// The creator-side properties of a new `patch`. A draft is not a property: it is a kind-14
/// transition written after the create ([`Collab::create_patch`]).
pub fn patch_props(
    number: u32,
    input: &PatchInput,
    from: Provenance<'_>,
) -> Result<BTreeMap<String, FieldValue>> {
    check_title(&input.title)?;
    check_text("PR body", &input.body, 5120, 5120)?;
    // Written into un-gated data a maintainer's client renders and hands to git: refuse what
    // the contract's ref-name grammar refuses (the `refUpdate` guard, mirrored). The "illegal
    // PR" prefix is what forge-import's item errors match on.
    if !rules::is_legal_ref_name(&input.base_ref_name) {
        return Err(Error::Config(format!(
            "illegal PR base ref name {:?}: {REF_NAME_RULE}",
            input.base_ref_name
        )));
    }
    if let Some(s) = &input.source_ref_name {
        if !rules::is_legal_ref_name(s) {
            return Err(Error::Config(format!(
                "illegal PR source ref name {s:?}: {REF_NAME_RULE}"
            )));
        }
    }
    // R-10 `oidWidth`: a SHA-1 (20) or SHA-256 (32) commit id, nothing in between.
    if !matches!(input.head_oid.len(), 20 | 32) {
        return Err(Error::Config(format!(
            "PR head oid must be 20 or 32 bytes (SHA-1 or SHA-256), got {}",
            input.head_oid.len()
        )));
    }
    let mut p = target_head(TargetKind::Patch, number, from)?;
    p.insert("title".to_string(), FieldValue::text(&input.title));
    if !input.body.is_empty() {
        p.insert("body".to_string(), FieldValue::text(&input.body));
    }
    p.insert(
        "baseRefNameHash".to_string(),
        FieldValue::bytes32(sha256(input.base_ref_name.as_bytes())),
    );
    p.insert(
        "baseRefName".to_string(),
        FieldValue::text(&input.base_ref_name),
    );
    p.insert(
        "sourceRepoId".to_string(),
        FieldValue::identifier(platform::decode_identifier(&input.source_repo_id)?),
    );
    if let Some(s) = &input.source_ref_name {
        p.insert(
            "sourceRefNameHash".to_string(),
            FieldValue::bytes32(sha256(s.as_bytes())),
        );
        p.insert("sourceRefName".to_string(), FieldValue::text(s));
    }
    p.insert(
        "headOid".to_string(),
        FieldValue::bytes(input.head_oid.clone()),
    );
    if let Some(h) = input.patch_manifest_hash {
        p.insert("patchManifestHash".to_string(), FieldValue::bytes32(h));
    }
    Ok(p)
}

/// What a legal ref name is, for a refusal: the contract's grammar (git check-ref-format).
const REF_NAME_RULE: &str = "a full ref name under refs/ (such as refs/heads/main) that git \
     check-ref-format accepts: no '..', '@{', control characters, spaces or ~^:?*[\\, no \
     component starting with '.' or ending in '.lock', at most 255 bytes";

fn check_title(title: &str) -> Result<()> {
    if title.trim().is_empty() {
        return Err(Error::Config("a title is required".into()));
    }
    check_text("title", title, 256, 1024)
}

/// The properties of a member `event` (without `repoId`, which the scope adds).
pub fn event_props(
    target: &Target,
    kind: EventKind,
    value: Option<&str>,
    oid: Option<&[u8]>,
) -> Result<BTreeMap<String, FieldValue>> {
    event_payload_props(
        target,
        kind,
        &EventPayload {
            value,
            oid,
            ref_id: None,
        },
    )
}

/// The properties of an `event` or `authorEvent` of any kind, with the payload its kind needs
/// (forge-v2.md §3): 11–15 a `ref_id`, 16 an `oid` (20–32 bytes), 17 a `value`, 8 a legal ref
/// name. A missing payload is refused before signing (the folds would ignore the document).
pub fn event_payload_props(
    target: &Target,
    kind: EventKind,
    payload: &EventPayload<'_>,
) -> Result<BTreeMap<String, FieldValue>> {
    let EventPayload { value, oid, ref_id } = *payload;
    if is_state_kind(kind) {
        return Err(Error::Config(format!(
            "a {} is a state change: it is written as a `transition`, not an event",
            kind_verb(kind)
        )));
    }
    // an empty value is no value: never written, and a kind that needs one is refused
    let value = value.filter(|v| !v.is_empty());
    if let Some(v) = value {
        check_text("event value", v, 120, 480)?;
    }
    let missing = |what: &str| {
        Err(Error::Config(format!(
            "a {} event needs {what}",
            kind_verb(kind)
        )))
    };
    match kind {
        EventKind::Retarget if !value.is_some_and(rules::is_legal_ref_name) => {
            return Err(Error::Config(format!(
                "illegal retarget base ref name {value:?}: {REF_NAME_RULE}"
            )));
        }
        EventKind::ThreadResolve
        | EventKind::ThreadUnresolve
        | EventKind::ReviewRequest
        | EventKind::ReviewRequestRemove
        | EventKind::ReviewDismiss
            if ref_id.is_none() =>
        {
            return missing("a refId");
        }
        EventKind::HeadUpdate if !oid.is_some_and(|o| matches!(o.len(), 20 | 32)) => {
            return missing("a 20- or 32-byte commit oid (SHA-1 or SHA-256)");
        }
        EventKind::MilestoneSet if value.is_none() => {
            return missing("a milestone name");
        }
        // The assignee in `value` (the fold) and in `refId` (the `addressee` index), the same
        // identity (platform-parity-spec §1.2; forge-web `targetEventData`).
        EventKind::Assign | EventKind::Unassign
            if value.is_none_or(str::is_empty) || ref_id != value =>
        {
            return missing("the assignee as both value and refId");
        }
        EventKind::LabelAdd | EventKind::LabelRemove
            if value.is_none_or(|v| v.trim().is_empty() || v.trim() != v) =>
        {
            return missing("a label name without surrounding spaces");
        }
        _ => {}
    }
    let mut p = target_props(target)?;
    p.insert(
        "kind".to_string(),
        FieldValue::integer(event_kind_to_u64(kind)),
    );
    if let Some(v) = value {
        p.insert("value".to_string(), FieldValue::text(v));
    }
    if let Some(o) = oid {
        p.insert("oid".to_string(), FieldValue::bytes(o.to_vec()));
    }
    if let Some(r) = ref_id {
        p.insert(
            "refId".to_string(),
            FieldValue::identifier(platform::decode_identifier(r)?),
        );
    }
    Ok(p)
}

/// The properties of the `transition` that carries out `mv` on `target` (without `repoId`):
/// `targetId`, `targetNumber`, `targetKind`, `kind`, `delta`, `asAuthor`, and for a merge
/// (kind 13) the merge commit `oid` (20 or 32 bytes; the contract's `e_mergeOid`).
pub fn transition_props(
    target: &Target,
    mv: &TransitionMove,
    oid: Option<&[u8]>,
) -> Result<BTreeMap<String, FieldValue>> {
    if mv.target_kind != target.kind.transition_target().code() {
        return Err(Error::Config(format!(
            "a kind-{} transition does not apply to {} #{}",
            mv.kind,
            target.kind.noun(),
            target.number
        )));
    }
    let merge = mv.kind == crate::rules::transition::PR_MERGE;
    let oid = oid.filter(|o| !o.is_empty());
    match oid {
        Some(o) if !matches!(o.len(), 20 | 32) => {
            return Err(Error::Config(format!(
                "a merge names a 20- or 32-byte commit oid, got {} bytes",
                o.len()
            )))
        }
        None if merge => return Err(Error::Config("a merge names the merge commit (oid)".into())),
        Some(_) if !merge => {
            return Err(Error::Config(format!(
                "only a merge names a commit; a kind-{} transition does not",
                mv.kind
            )))
        }
        _ => {}
    }
    let mut p = target_props(target)?;
    p.insert(
        "targetKind".to_string(),
        FieldValue::integer(u64::from(mv.target_kind)),
    );
    p.insert("kind".to_string(), FieldValue::integer(u64::from(mv.kind)));
    p.insert("delta".to_string(), FieldValue::signed(mv.delta));
    p.insert(
        "asAuthor".to_string(),
        FieldValue::integer(u64::from(mv.as_author)),
    );
    if let Some(o) = oid {
        p.insert("oid".to_string(), FieldValue::bytes(o.to_vec()));
    }
    Ok(p)
}

/// The request a state change is: its [`StateAction`], and the verb the messages use.
fn action_verb(action: StateAction) -> &'static str {
    match action {
        StateAction::Close => "close",
        StateAction::Reopen => "reopen",
        StateAction::Merge => "merge",
        StateAction::Draft => "convert to a draft",
        StateAction::Ready => "mark ready",
        StateAction::Lock => "lock",
        StateAction::Unlock => "unlock",
    }
}

/// What a target's state code reads as, for a refusal ("it is already closed").
fn state_words(kind: TargetKind, code: i64) -> &'static str {
    let s = status_of_code(code);
    match (s.merged, s.open, kind == TargetKind::Patch && s.draft) {
        (true, _, _) => "merged",
        (_, true, true) => "an open draft",
        (_, true, false) => "open",
        (_, false, true) => "a closed draft",
        (_, false, false) => "closed",
    }
}

/// The transition sum `action` is a legal move from (a PR's close and reopen also have draft
/// forms, 8 → 9 and 9 → 8; an unlock needs a lock).
fn legal_from(action: StateAction) -> i64 {
    match action {
        StateAction::Close | StateAction::Merge | StateAction::Draft | StateAction::Lock => 0,
        StateAction::Reopen => 1,
        StateAction::Ready => 8,
        StateAction::Unlock => rules::v2::LOCK_DELTA,
    }
}

/// The move `action` is from the state it is legal from ([`legal_from`]), written as `actor`
/// with no actor gate: what the client attempts with the pre-check off, so consensus judges
/// every rule (a non-member's gate, `f_authorNoMerge` for an author's merge, the `c*` state
/// rules). `None` for an action the target kind has no transition for.
fn forced_move(
    target: TransitionTarget,
    action: StateAction,
    actor: Actor,
    number: u32,
) -> Option<TransitionMove> {
    let mv = next_transition(target, legal_from(action), action, Actor::Member, number)?;
    Some(TransitionMove {
        as_author: if actor == Actor::Author { number } else { 0 },
        ..mv
    })
}

/// Why `action` cannot be carried out on `target` in state `code` by `actor` (no legal
/// move): the user error, raised before anything is signed.
fn no_move(target: &Target, code: i64, action: StateAction, actor: Actor) -> Error {
    let what = format!(
        "{} {} #{}",
        action_verb(action),
        target.kind.noun(),
        target.number
    );
    if actor == Actor::Other {
        return Error::NotPermitted {
            action: what,
            reason: format!(
                "you are neither a member nor the {}'s author",
                target.kind.noun()
            ),
            needs: "writer".into(),
        };
    }
    if action == StateAction::Merge && actor == Actor::Author && status_of_code(code).open {
        return Error::NotPermitted {
            action: what,
            reason: "only a maintainer or writer can merge".into(),
            needs: "writer".into(),
        };
    }
    if matches!(action, StateAction::Lock | StateAction::Unlock) {
        if actor == Actor::Author {
            return Error::NotPermitted {
                action: what,
                reason: "only a maintainer or writer can lock or unlock a conversation".into(),
                needs: "writer".into(),
            };
        }
        let state = if status_of_code(code).locked {
            "already locked"
        } else {
            "not locked"
        };
        return UserError::new(codes::REJECTED, format!("cannot {what}: it is {state}"))
            .note("checked before anything was signed; nothing was written or paid")
            .into();
    }
    let hint = match (action, status_of_code(code)) {
        (StateAction::Merge, s) if s.draft && s.open => " (mark it ready first)",
        _ => "",
    };
    UserError::new(
        codes::REJECTED,
        format!(
            "cannot {what}: it is {}{hint}",
            state_words(target.kind, code)
        ),
    )
    .note("checked before anything was signed; nothing was written or paid")
    .into()
}

/// The properties of a `policy` (without `repoId`). Refuses what forge-community would: over
/// 10 approvals, an unknown approver role, merge methods over 15, more than 10 required checks
/// (or a repeated, empty or oversized name), and check sources that do not pair up with the
/// names (`sourcesMatchNames`: as many as the names, or none).
pub fn policy_props(policy: &Policy) -> Result<BTreeMap<String, FieldValue>> {
    if policy.required_approvals > 10 || policy.approver_role > 1 {
        return Err(Error::Config(
            "a policy takes 0-10 required approvals and approver role 0 (any member) or 1 \
             (maintainers)"
                .into(),
        ));
    }
    if policy.merge_methods > 15 {
        return Err(Error::Config(format!(
            "merge methods {} is not a mask of ff (1), merge (2), squash (4) and rebase (8)",
            policy.merge_methods
        )));
    }
    let names = &policy.required_checks;
    let unique: BTreeSet<&String> = names.iter().collect();
    if names.len() > 10
        || unique.len() != names.len()
        || names
            .iter()
            .any(|n| n.is_empty() || n.chars().count() > 100 || n.len() > 200)
    {
        return Err(Error::Config(
            "a policy takes at most 10 required checks, each named once in 1-100 characters".into(),
        ));
    }
    let sources = &policy.required_check_sources;
    if !sources.is_empty() && sources.len() != names.len() {
        return Err(Error::Config(format!(
            "{} check source(s) for {} required check(s): name one source per check, in the \
             same order, or none",
            sources.len(),
            names.len()
        )));
    }
    let source_ids = sources
        .iter()
        .map(|s| platform::decode_identifier(s).map(FieldValue::identifier))
        .collect::<Result<Vec<_>>>()?;
    let mut p = BTreeMap::new();
    p.insert(
        "requiredApprovals".to_string(),
        FieldValue::integer(u64::from(policy.required_approvals)),
    );
    p.insert(
        "approverRole".to_string(),
        FieldValue::integer(u64::from(policy.approver_role)),
    );
    p.insert(
        "requireChecks".to_string(),
        FieldValue::boolean(policy.require_checks),
    );
    p.insert(
        "mergeMethods".to_string(),
        FieldValue::integer(u64::from(policy.merge_methods)),
    );
    if !names.is_empty() {
        p.insert(
            "requiredChecks".to_string(),
            FieldValue::text_list(names.iter().cloned()),
        );
    }
    if !source_ids.is_empty() {
        p.insert(
            "requiredCheckSources".to_string(),
            FieldValue::List(source_ids),
        );
    }
    Ok(p)
}

/// The properties of a `comment` (without `repoId`): its target, body and anchor. Refuses an
/// empty body and a range whose start follows its line before anything is signed.
pub fn comment_props(
    target_id: &str,
    body: &str,
    anchor: Option<&CommentAnchor>,
    imported: Option<&Imported>,
) -> Result<BTreeMap<String, FieldValue>> {
    if body.trim().is_empty() {
        return Err(Error::Config("a comment needs a body".into()));
    }
    check_text("comment body", body, 5120, 5120)?;
    let mut p = BTreeMap::new();
    p.insert(
        "targetId".to_string(),
        FieldValue::identifier(platform::decode_identifier(target_id)?),
    );
    p.insert("body".to_string(), FieldValue::text(body));
    if let Some(a) = anchor {
        if let Some(r) = &a.reply_to {
            p.insert(
                "replyTo".to_string(),
                FieldValue::identifier(platform::decode_identifier(r)?),
            );
        }
        if let Some(o) = &a.commit_oid {
            p.insert("commitOid".to_string(), FieldValue::bytes(o.clone()));
        }
        if let Some(path) = &a.path {
            check_text("comment path", path, 500, 1000)?;
            p.insert("path".to_string(), FieldValue::text(path));
        }
        if let Some(l) = a.line {
            p.insert("line".to_string(), FieldValue::integer(l));
        }
        if let Some(s) = a.side {
            p.insert("side".to_string(), FieldValue::integer(s));
        }
        if let Some(start) = a.start_line {
            if a.line.is_none_or(|l| start > l) {
                return Err(Error::Config(
                    "a range comment needs a line, and its start line may not follow it".into(),
                ));
            }
            p.insert("startLine".to_string(), FieldValue::integer(start));
        }
        if let Some(r) = &a.review_id {
            p.insert(
                "reviewId".to_string(),
                FieldValue::identifier(platform::decode_identifier(r)?),
            );
        }
    }
    insert_imported(&mut p, imported)?;
    Ok(p)
}

/// The properties of a `review` (without `repoId`): `verdict` on `commit_oid`, with the number
/// of `reviewId` comments its submit will write.
pub fn review_props(
    patch_id: &str,
    verdict: Verdict,
    commit_oid: &[u8],
    body: &str,
    comment_count: Option<u16>,
    imported: Option<&Imported>,
) -> Result<BTreeMap<String, FieldValue>> {
    if !(1..=5).contains(&verdict.code()) {
        return Err(Error::Config(format!("unknown verdict {}", verdict.code())));
    }
    check_text("review body", body, 5120, 5120)?;
    let mut p = BTreeMap::new();
    p.insert(
        "patchId".to_string(),
        FieldValue::identifier(platform::decode_identifier(patch_id)?),
    );
    p.insert("verdict".to_string(), FieldValue::integer(verdict.code()));
    p.insert(
        "commitOid".to_string(),
        FieldValue::bytes(commit_oid.to_vec()),
    );
    if !body.is_empty() {
        p.insert("body".to_string(), FieldValue::text(body));
    }
    if let Some(n) = comment_count {
        p.insert(
            "commentCount".to_string(),
            FieldValue::integer(u64::from(n)),
        );
    }
    insert_imported(&mut p, imported)?;
    Ok(p)
}

/// Whether a star of `repo` by `signer` also beats for Trending: RC1's `starBeat` names a public
/// repository (`vis: "public"`, proved against it) and its owner (`repoOwner`, which may not be
/// the signer: an owner's own star does not trend).
fn beats(repo: &RepoRef, signer: &str) -> bool {
    repo.visibility == Visibility::Public && signer != repo.owner_id()
}

/// Whether a document's `asMember` proof is required rather than optional: an import or an
/// upstream number (`i_provenance`), or a member verdict (1 / 2, `memberVerdict`). (A post to a
/// locked thread needs it too, `lockGate`, which a write cannot see from its properties.)
fn proof_required(props: &BTreeMap<String, FieldValue>) -> bool {
    props.contains_key("imported")
        || props.contains_key("upstreamNumber")
        || props
            .get("verdict")
            .and_then(FieldValue::as_u64)
            .is_some_and(|v| Verdict::from_code(v).needs_member_proof())
}

/// Refuse a write of `doc_type` into a contract the RC1 layout does not put it in.
fn check_layout(repo: &RepoRef, contract: &LoadedContract, doc_type: &str) -> Result<()> {
    match repo.forge().contract_id_of(doc_type) {
        Some(id) if id == contract.id() => Ok(()),
        want => Err(Error::Config(format!(
            "internal: a {doc_type} belongs in {}, not in contract {}",
            want.unwrap_or("no forge-v2 contract"),
            contract.id()
        ))),
    }
}

fn target_props(target: &Target) -> Result<BTreeMap<String, FieldValue>> {
    let mut p = BTreeMap::new();
    p.insert(
        "targetId".to_string(),
        FieldValue::identifier(platform::decode_identifier(&target.id)?),
    );
    p.insert(
        "targetNumber".to_string(),
        FieldValue::integer(u64::from(target.number)),
    );
    Ok(p)
}

/// Who `signer` is to a state change of `target` (§3): a member (`asAuthor` 0), else the
/// target's author (`asAuthor` = its number), else no one the contract admits. A member who is
/// also the author writes as a member, which admits every kind (a merge too).
pub fn state_actor(signer_role: Option<Role>, signer: &str, target: &Target) -> Actor {
    if signer_role.is_some() {
        Actor::Member
    } else if signer == target.author {
        Actor::Author
    } else {
        Actor::Other
    }
}

/// How an event of `kind` by `signer` is written: a member's `event`, else — for an author
/// kind ([`is_author_kind`]) — the author's `authorEvent`. `None`: consensus admits neither.
/// A state kind (close, reopen, merge, draft, ready) is never an event: it is `None` here
/// ([`state_actor`] routes it).
pub fn kind_route(
    signer_role: Option<Role>,
    signer: &str,
    target: &Target,
    kind: EventKind,
) -> Option<StateRoute> {
    if is_state_kind(kind) {
        None
    } else if signer_role.is_some() {
        Some(StateRoute::Member)
    } else if signer == target.author && is_author_kind(kind) {
        Some(StateRoute::Author)
    } else {
        None
    }
}

/// Whether `e` says the dense number was taken: consensus refused the number (a 10422 naming
/// `dense`, or the unique `number` index once the rules pass) because another create took it
/// between the count read and the write. Nothing landed; count again.
fn number_taken(e: &Error) -> bool {
    match e {
        Error::DuplicateUniqueIndex(_) => true,
        Error::RuleRefused { rule, .. } if rule == crate::rules::v2::DENSE_RULE => true,
        Error::RuleRefused { detail, .. } | Error::Platform(detail) => names_dense_rule(detail),
        _ => false,
    }
}

/// The fields that identify a create's content: an issue's or PR's number, kind tag, text,
/// provenance and (a PR's) refs and head, as the signer wrote them.
const CONTENT_FIELDS: [&str; 9] = [
    "number",
    "tk",
    "title",
    "body",
    "upstreamNumber",
    "imported",
    "headOid",
    "baseRefName",
    "sourceRefName",
];

/// Whether two field values hold the same data (integers by value whatever their width,
/// byte arrays whatever their kind, objects field by field).
fn same_value(a: Option<&FieldValue>, b: Option<&FieldValue>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(a), Some(b)) => {
            if let (Some(x), Some(y)) = (a.as_i64(), b.as_i64()) {
                return x == y;
            }
            if let (Some(x), Some(y)) = (a.as_bytes(), b.as_bytes()) {
                return x == y;
            }
            match (a, b) {
                (FieldValue::Object(x), FieldValue::Object(y)) => {
                    x.len() == y.len() && x.iter().all(|(k, v)| same_value(Some(v), y.get(k)))
                }
                _ => a == b,
            }
        }
        _ => false,
    }
}

/// Whether `stored` (the document now at the number a create was refused, opened in a private
/// repo) is the signer's own create of `plain`: an earlier attempt of the same create landed
/// (a consumed nonce whose read lagged), so it is the result, not a reason to take the next
/// number and write the issue twice.
fn is_own_copy(
    stored: &FetchedDocument,
    signer: &str,
    plain: &BTreeMap<String, FieldValue>,
) -> bool {
    stored.owner_id == signer
        && CONTENT_FIELDS
            .iter()
            .all(|k| same_value(stored.fields.get(*k), plain.get(*k)))
}

/// Whether the document now at a refused number is this create's own landed attempt: one of
/// the ids this call signed (`attempts`), and the signer's copy of `plain` ([`is_own_copy`]).
/// Content alone is not enough: the signer may file the same title and body twice on purpose,
/// and the earlier issue must never stand in for the new one.
fn adoptable(
    stored: &FetchedDocument,
    signer: &str,
    plain: &BTreeMap<String, FieldValue>,
    attempts: &[(u32, String)],
) -> bool {
    attempts.iter().any(|(_, id)| *id == stored.id) && is_own_copy(stored, signer, plain)
}

/// Whether `e` is a refusal of a state move by the contract's sum rules (`c1`…`c5`): the
/// target's state changed between the read and the write.
fn is_state_rule_refusal(e: &Error) -> bool {
    matches!(e, Error::RuleRefused { document_type, rule, .. }
        if document_type == DOC_TRANSITION
            && rule.starts_with('c')
            && rule.as_bytes().get(1).is_some_and(u8::is_ascii_digit)
            && rule.as_bytes().get(2) == Some(&b'_'))
}

/// A grouped answer's key that does not decode: the contract's encoding is not the one this
/// reader expects, so nothing read from it can be trusted (never silently "open").
fn undecodable(what: &str, key: &[u8]) -> Error {
    Error::Platform(format!(
        "a grouped {what} came back keyed by {} ({} bytes), which this client cannot read",
        hex::encode(key),
        key.len()
    ))
}

/// The per-target transition sums of a grouped sum ([`Collab::state_sums`]), by target id: a
/// target with no transitions is absent from the answer and reads 0.
fn sums_by_target(sums: BTreeMap<Vec<u8>, i64>) -> Result<BTreeMap<String, i64>> {
    sums.into_iter()
        .map(|(k, v)| {
            platform::decode_identifier_key(&k)
                .map(|id| (id, v))
                .ok_or_else(|| undecodable("sum of transition.delta", &k))
        })
        .collect()
}

/// A grouped count of `transition.kind` ([`Collab::repo_state_counts`]) as counts per kind.
fn counts_by_kind(counts: BTreeMap<Vec<u8>, u64>) -> Result<BTreeMap<u8, u64>> {
    counts
        .into_iter()
        .map(|(k, v)| {
            platform::decode_u8_key(&k)
                .map(|kind| (kind, v))
                .ok_or_else(|| undecodable("count of transition.kind", &k))
        })
        .collect()
}

/// A PR's view from its log and its base ref's tips (pure; [`Collab::patch_view`] and
/// [`Collab::list_patch_views`] read the inputs). "Merged" is the chain fact (a member
/// recorded a merge, D-9); [`PrState::merge_on_base`] says whether its commit was a tip of the
/// base, so readers label a merge they cannot find there.
fn view_of(patch: Patch, log: TargetLog, base: rules::MergeBaseTips) -> PatchView {
    let merge_oid = merge_transition(&log.transitions).and_then(|t| t.oid.clone());
    let state = pr_state_v2(
        log.state_code(),
        merge_oid.as_deref(),
        &log.events,
        base.tip.as_deref(),
        |oid, _| base.contains(oid),
    );
    let review = fold_pr_review_v2(
        &log.events,
        &log.author_events,
        &patch.author,
        &patch.head_oid,
        &BTreeSet::new(),
    );
    let head = review.head.clone();
    let head_on_base = base.contains(&head);
    PatchView {
        patch,
        state,
        head,
        review,
        base_tip: base.current,
        head_on_base,
        base_tips: base.historical.into_iter().collect(),
        log,
    }
}

/// The row cap of `dg pr list`'s review lookup and member siblings (Drive's page maximum).
const LOOKUP_CAP: u32 = 100;
/// [`LOOKUP_CAP`] as a length.
const LOOKUP_CAP_LEN: usize = LOOKUP_CAP as usize;

/// A list's page size: `limit`, capped at [`DEFAULT_PAGE`], which 0 also means.
fn page_limit(limit: u32) -> u32 {
    if limit == 0 {
        DEFAULT_PAGE
    } else {
        limit.min(DEFAULT_PAGE)
    }
}

/// The order of a plain `patchId in [..]` review read (an `in` is a range to Drive and needs
/// one). The composite lookup is left unordered: Drive walks it in the page's direction and
/// refuses an explicit ordering of it ("a documents sub-query's outer ordering must match the
/// page's direction", measured on moutai). [`reviews_to_reread`] does not depend on either.
fn review_lookup_order() -> Vec<QueryOrder> {
    vec![QueryOrder::asc("patchId"), QueryOrder::asc("$createdAt")]
}

/// `dg pr list`'s one composite read: the PR page, the page's reviews (bound to its `$id`s),
/// and the repo's maintainers and writers.
fn pr_list_reads<'c>(
    collab: &'c LoadedContract,
    core: &'c LoadedContract,
    scope: &crate::scope::DocScope,
    limit: u32,
) -> [crate::platform::BatchRead<'c>; 4] {
    use crate::platform::{BatchBind, BatchRead};
    let member = |role: Role| BatchRead {
        contract: core,
        document_type: members::doc_type(role),
        filters: scope.filters([]),
        order: vec![QueryOrder::desc("memberId")],
        limit: LOOKUP_CAP,
        bind: None,
    };
    [
        BatchRead {
            contract: collab,
            document_type: DOC_PATCH,
            filters: scope.filters([]),
            order: vec![QueryOrder::desc("$createdAt")],
            limit,
            bind: None,
        },
        BatchRead {
            contract: collab,
            document_type: DOC_REVIEW,
            filters: Vec::new(),
            order: Vec::new(),
            limit: LOOKUP_CAP,
            bind: Some(BatchBind {
                source: 0,
                source_property: "$id".into(),
                field: "patchId".into(),
            }),
        },
        member(Role::Maintainer),
        member(Role::Writer),
    ]
}

/// After a review read of `wanted` PRs that returned `rows` capped at [`LOOKUP_CAP`]: the PRs
/// whose reviews are known complete, and those that must be read again. Independent of the
/// walk's direction: a short read is complete for every PR; a full one is complete only for
/// the PRs it returned rows of, except the one its last row belongs to (the read may have
/// stopped inside it). Every other wanted PR, returned or not, is read again.
fn reviews_to_reread(rows: &[FetchedDocument], wanted: &[[u8; 32]]) -> Vec<[u8; 32]> {
    if rows.len() < LOOKUP_CAP_LEN {
        return Vec::new();
    }
    let cut = rows.last().and_then(|d| d.field_bytes32("patchId"));
    let complete: BTreeSet<[u8; 32]> = rows
        .iter()
        .filter_map(|d| d.field_bytes32("patchId"))
        .filter(|p| Some(*p) != cut)
        .collect();
    wanted
        .iter()
        .filter(|id| !complete.contains(*id))
        .copied()
        .collect()
}

/// Rows grouped by the identifier in their `field` (base58), each group in read order.
fn per_target(rows: Vec<FetchedDocument>, field: &str) -> BTreeMap<String, Vec<FetchedDocument>> {
    let mut by: BTreeMap<String, Vec<FetchedDocument>> = BTreeMap::new();
    for d in rows {
        if let Some(t) = d.field_bytes32(field) {
            by.entry(platform::encode_identifier(t))
                .or_default()
                .push(d);
        }
    }
    by
}

/// The membership oracle over complete `maintainer` and `writer` document lists.
fn oracle_of(maintainers: &[FetchedDocument], writers: &[FetchedDocument]) -> RoleOracle {
    let of = |docs: &[FetchedDocument], role| {
        docs.iter()
            .filter_map(move |d| members::Member::from_doc(d, role))
            .collect::<Vec<_>>()
    };
    let mut all = of(maintainers, Role::Maintainer);
    all.extend(of(writers, Role::Writer));
    members::oracle(&all)
}

// ===========================================================================
// The service
// ===========================================================================

/// forge-v2 collaboration reads and writes for one repository at a time.
///
/// On a private repository (`docs/security/private-repos.md` §4) the free text of issues,
/// patches, comments and reviews is sealed on write and opened on read ([`super::private`]);
/// documents this reader cannot open are counted as hidden, like malformed ones. The keys are
/// resolved once per `Collab` (one command): every sealed write of the command uses them.
pub struct Collab<'a> {
    client: &'a PlatformClient,
    signer: Option<(&'a LoadedIdentity, &'a BridgeIdentity)>,
    keyring: crate::repo::KeyringCache,
    /// A private repo's decrypted ref updates, read once per `Collab` (a PR list folds every
    /// row's base against them), keyed by repository id. Dropped by
    /// [`Collab::refs_changed`] after a push this command made.
    private_updates: std::sync::Mutex<Option<([u8; 32], Arc<crate::refs::PrivateUpdates>)>>,
    /// Whether the signer holds a maintainer or writer document of the repository (by id),
    /// read once per `Collab`: what `asMember` proves on every issue, PR, comment and review
    /// the command writes ([`Self::stamp`]).
    member: std::sync::Mutex<Option<(String, bool)>>,
}

impl<'a> Collab<'a> {
    /// Reads and writes, signing as `identity`.
    pub fn new(
        client: &'a PlatformClient,
        identity: &'a LoadedIdentity,
        bridge: &'a BridgeIdentity,
    ) -> Self {
        Self {
            client,
            signer: Some((identity, bridge)),
            keyring: crate::repo::KeyringCache::default(),
            private_updates: std::sync::Mutex::default(),
            member: std::sync::Mutex::default(),
        }
    }

    /// Reads only. A private repository needs a signer (its keys are the signer's).
    /// The client this reads and writes through.
    pub(super) fn client(&self) -> &'a PlatformClient {
        self.client
    }

    pub fn reader(client: &'a PlatformClient) -> Self {
        Self {
            client,
            signer: None,
            keyring: crate::repo::KeyringCache::default(),
            private_updates: std::sync::Mutex::default(),
            member: std::sync::Mutex::default(),
        }
    }

    /// The keys of private `repo` as the signer holds them, loaded once per `Collab`.
    pub async fn keyring(&self, repo: &RepoRef) -> Result<Arc<Keyring>> {
        let (identity, bridge) = self.signer.ok_or_else(|| {
            Error::from(crate::user_error::private_needs_identity(&repo.display()))
        })?;
        let signer = crate::keyring::PrivateSigner {
            client: self.client,
            identity,
            bridge,
        };
        // a key source with no ENCRYPTION key at all (a limited `dg auth login` key): say so
        // (E306) rather than "no maintainer wrapped the key to you" (E307)
        if signer.encryption_keys(repo).is_empty() {
            return Err(crate::keyring::no_encryption_key(
                &identity.id(),
                &format!("private repo {}", repo.display()),
            ));
        }
        crate::repo::cached_keyring(
            &self.keyring,
            repo,
            || async move { signer.keyring(repo).await },
        )
        .await
    }

    /// The repository's refs changed since this `Collab` read them (a push the command made,
    /// through git): the next base-branch fold reads them again. Without it a PR merged by
    /// pushing its head would still read as unmerged against the reflog read before the push.
    pub fn refs_changed(&self) {
        *self
            .private_updates
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
    }

    /// The keys of private `repo` read NOW, replacing the cached ones: a writer re-reads the
    /// anchors before every write (§5.3), so nothing is sealed under an epoch a rotation
    /// superseded while the command waited (a prompt, a long import). Reads keep the cache.
    async fn fresh_keyring(&self, repo: &RepoRef) -> Result<Arc<Keyring>> {
        *self
            .keyring
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
        self.keyring(repo).await
    }

    /// `props` of a new `kind` document, sealed when `repo` is private (under the write epoch
    /// of keys resolved just now, §5.3), else unchanged.
    pub async fn seal_if_private(
        &self,
        repo: &RepoRef,
        kind: ContentKind,
        props: BTreeMap<String, FieldValue>,
    ) -> Result<BTreeMap<String, FieldValue>> {
        self.seal_kind_if_private(repo, doc_kind(kind), props).await
    }

    async fn seal_kind_if_private(
        &self,
        repo: &RepoRef,
        kind: DocKind,
        props: BTreeMap<String, FieldValue>,
    ) -> Result<BTreeMap<String, FieldValue>> {
        if repo.visibility != Visibility::Private {
            return Ok(props);
        }
        let kr = self.fresh_keyring(repo).await?;
        let w = kr.writer(repo)?;
        let owner = platform::decode_identifier(&self.signer_id()?)?;
        private::seal_props(w.write_keys(), kind, owner, props)
    }

    /// The reader's keys when `repo` is private (`None` for a public one). A reader with no key
    /// at all is told why (E306 / E307), rather than shown nothing with everything hidden.
    async fn private_keys(&self, repo: &RepoRef) -> Result<Option<Arc<Keyring>>> {
        if repo.visibility != Visibility::Private {
            return Ok(None);
        }
        let kr = self.keyring(repo).await?;
        kr.require_key(repo)?;
        Ok(Some(kr))
    }

    /// An issue or patch by number as the public codecs read it (decrypted in a private repo).
    /// One that exists but does not open for this reader is an error saying so, not "not
    /// found".
    async fn readable_target(
        &self,
        repo: &RepoRef,
        kind: TargetKind,
        number: u32,
    ) -> Result<Option<FetchedDocument>> {
        let Some(d) = self.target_doc(repo, kind, number).await? else {
            return Ok(None);
        };
        if !well_formed(kind.content_kind(), &d, repo.visibility) {
            return Ok(None);
        }
        let Some(kr) = self.private_keys(repo).await? else {
            return Ok(Some(d));
        };
        let opened = kr.open(doc_kind(kind.content_kind()), &d);
        let bucket = crate::keyring::hidden_bucket(&opened);
        match private::open_doc(opened, d) {
            Some(d) => Ok(Some(d)),
            None => Err(crate::user_error::UserError::new(
                crate::user_error::codes::NOT_A_KEY_HOLDER,
                format!(
                    "{} #{number} of {} cannot be read",
                    kind.noun(),
                    repo.display()
                ),
            )
            .cause(bucket.unwrap_or("not readable with your keys").to_string())
            .fix(format!(
                "`dg repo keys status {}` explains the keys you hold",
                repo.display()
            ))
            .into()),
        }
    }

    /// A page of documents as the public codecs read them (decrypted in a private repo): the
    /// rows that read, and how many did not (malformed, or not readable to this reader).
    async fn readable_all(
        &self,
        repo: &RepoRef,
        kind: ContentKind,
        docs: Vec<FetchedDocument>,
    ) -> Result<(Vec<FetchedDocument>, usize)> {
        // resolved once, even for an empty page: a non-member learns why, not "no issues"
        let keys = self.private_keys(repo).await?;
        let total = docs.len();
        let out: Vec<FetchedDocument> = docs
            .into_iter()
            .filter(|d| well_formed(kind, d, repo.visibility))
            .filter_map(|d| open_with(keys.as_deref(), kind, d))
            .collect();
        let hidden = total - out.len();
        Ok((out, hidden))
    }

    /// The signer's identity id.
    pub fn signer_id(&self) -> Result<String> {
        Ok(self.signer()?.0.id())
    }

    fn signer(&self) -> Result<(&'a LoadedIdentity, &'a BridgeIdentity)> {
        self.signer
            .ok_or_else(|| Error::Config("this operation signs; no identity was given".into()))
    }

    pub(super) fn engine(&self) -> Result<WriteEngine<'a>> {
        let (identity, bridge) = self.signer()?;
        doc_engine(self.client, identity, bridge)
    }

    pub(super) async fn collab_contract(&self, repo: &RepoRef) -> Result<LoadedContract> {
        self.client.fetch_contract(&repo.forge().collab).await
    }

    /// forge-community: stars, beats, watches, follows, check runs, policies, webhooks and
    /// profiles (`docs/contracts/forge-v2.md` §2).
    pub(super) async fn community_contract(&self, repo: &RepoRef) -> Result<LoadedContract> {
        self.client.fetch_contract(&repo.forge().community).await
    }

    pub(super) async fn core_contract(&self, repo: &RepoRef) -> Result<LoadedContract> {
        self.client.fetch_contract(&repo.forge().core).await
    }

    pub(super) fn repo_filter(repo: &RepoRef) -> Result<QueryFilter> {
        Ok(QueryFilter::eq(
            "repoId",
            FieldValue::identifier(platform::decode_identifier(repo.id())?),
        ))
    }

    pub(super) fn with_repo(
        repo: &RepoRef,
        mut props: BTreeMap<String, FieldValue>,
    ) -> Result<BTreeMap<String, FieldValue>> {
        props.insert(
            "repoId".to_string(),
            FieldValue::identifier(platform::decode_identifier(repo.id())?),
        );
        Ok(props)
    }

    /// Create one document of `repo` (its `repoId` added, stamped by [`Self::stamp`]) in
    /// `contract`, as the signer. `contract` must be the one the RC1 layout puts `doc_type` in
    /// ([`crate::layout`]); anything else is refused before signing.
    pub(super) async fn write(
        &self,
        repo: &RepoRef,
        contract: &LoadedContract,
        doc_type: &str,
        props: BTreeMap<String, FieldValue>,
    ) -> Result<String> {
        check_layout(repo, contract, doc_type)?;
        // A private repo's member `event` carries its `value` (label or milestone name, dismiss
        // reason, assignee, retarget base) sealed (§7): every event write passes here.
        let props = if doc_type == DOC_EVENT && props.contains_key("value") {
            self.seal_kind_if_private(repo, DocKind::Event, props)
                .await?
        } else {
            props
        };
        let engine = self.engine()?;
        self.create_stamped(repo, doc_type, Self::with_repo(repo, props)?, async |all| {
            engine.create_document(contract, doc_type, all).await
        })
        .await
    }

    /// Run `create` on `props` stamped for `doc_type` ([`Self::stamp`]). When consensus refuses
    /// an optional `asMember` ([`Self::proof_refused`]), the props are re-stamped without it and
    /// `create` runs once more; a required proof keeps the refusal.
    async fn create_stamped<T>(
        &self,
        repo: &RepoRef,
        doc_type: &str,
        props: BTreeMap<String, FieldValue>,
        mut create: impl AsyncFnMut(BTreeMap<String, FieldValue>) -> Result<T>,
    ) -> Result<T> {
        let mut retried = false;
        loop {
            let mut all = props.clone();
            self.stamp(repo, doc_type, &mut all).await?;
            let optional = !proof_required(&all);
            match create(all).await {
                Err(e) if !retried && optional && self.proof_refused(repo, &e) => retried = true,
                res => return res,
            }
        }
    }

    /// Whether `e` refused the write's `asMember` (40120 on it: the signer's membership was
    /// removed after this `Collab` read it). The membership is then known to be gone, so the
    /// cache says so: a write whose proof was optional is re-stamped without it and retried
    /// once; one that needs the proof keeps the refusal.
    fn proof_refused(&self, repo: &RepoRef, e: &Error) -> bool {
        let refused =
            matches!(e, Error::NotAMember { detail, .. } if detail.ends_with("for path asMember"));
        if refused {
            *crate::history::lock(&self.member) = Some((repo.id().to_string(), false));
        }
        refused
    }

    /// Whether the signer holds a maintainer or writer document of `repo` now (read once per
    /// `Collab` and repository).
    pub async fn is_member(&self, repo: &RepoRef) -> Result<bool> {
        if let Some((_, m)) = crate::history::lock(&self.member)
            .as_ref()
            .filter(|(id, _)| id == repo.id())
        {
            return Ok(*m);
        }
        let m = self.signer_role(repo).await?.is_some();
        *crate::history::lock(&self.member) = Some((repo.id().to_string(), m));
        Ok(m)
    }

    /// Stamp a new `doc_type` document's properties as RC1 requires: `vis` (the repository's
    /// visibility, or `"public"` where only that is accepted) and, on an issue, PR, comment or
    /// review, `asMember` = the signer when the signer is a member. The proof is what admits an
    /// import (`i_provenance`), a member verdict (`memberVerdict`, 1 and 2) and a post to a
    /// locked thread (`lockGate`); a non-member's verdict (4 or 5) never carries it. A write that
    /// needs the proof from a non-member is refused here, before signing (with the pre-check off
    /// it is attempted, and consensus refuses it).
    pub(super) async fn stamp(
        &self,
        repo: &RepoRef,
        doc_type: &str,
        props: &mut BTreeMap<String, FieldValue>,
    ) -> Result<()> {
        crate::layout::stamp_vis_for(doc_type, props, repo.visibility);
        if !crate::layout::MEMBER_PROOF_TYPES.contains(&doc_type) {
            return Ok(());
        }
        let verdict = props
            .get("verdict")
            .and_then(FieldValue::as_u64)
            .map(Verdict::from_code);
        if matches!(
            verdict,
            Some(Verdict::ApproveNonMember | Verdict::RequestChangesNonMember)
        ) {
            return Ok(());
        }
        let needs = proof_required(props);
        let member = self.is_member(repo).await?;
        if member || (needs && !precheck_enabled()) {
            props.insert(
                crate::layout::AS_MEMBER.to_string(),
                FieldValue::identifier(platform::decode_identifier(&self.signer_id()?)?),
            );
        } else if needs {
            return Err(Error::NotPermitted {
                action: format!("write this {doc_type}"),
                reason: format!(
                    "it carries a member's proof (an imported item, an upstream number or an \
                     approve / request-changes verdict), and you are not a member of {}",
                    repo.display()
                ),
                needs: "writer".into(),
            });
        }
        Ok(())
    }

    /// Refuse, before signing, a non-member's post to a locked conversation (`lockGate`: only a
    /// write with `asMember` passes). Off when [`SKIP_PRECHECK_ENV`] is set.
    pub async fn require_unlocked_or_member(&self, repo: &RepoRef, target_id: &str) -> Result<()> {
        if !precheck_enabled() || self.is_member(repo).await? {
            return Ok(());
        }
        if status_of_code(self.state_sum(repo, target_id).await?).locked {
            return Err(Error::NotPermitted {
                action: "post to this conversation".into(),
                reason: format!(
                    "it is locked, and only members of {} can post to a locked conversation",
                    repo.display()
                ),
                needs: "writer".into(),
            });
        }
        Ok(())
    }

    /// A private repo's member events as the folds read them ([`private::readable_event`]):
    /// every event kept, a sealed `value` opened in place or dropped when it does not open.
    /// Also how many values were hidden, and how many were plaintext (an older client's).
    async fn readable_events(
        &self,
        repo: &RepoRef,
        docs: Vec<FetchedDocument>,
    ) -> Result<(Vec<FetchedDocument>, usize, usize)> {
        if repo.visibility != Visibility::Private {
            return Ok((docs, 0, 0));
        }
        let kr = self.keyring(repo).await?;
        let (mut hidden, mut plaintext) = (0, 0);
        let docs = docs
            .into_iter()
            .map(|d| {
                let (d, v) = private::readable_event(|d| kr.open(DocKind::Event, d), d);
                match v {
                    EventValue::Hidden => hidden += 1,
                    EventValue::Plaintext => plaintext += 1,
                    EventValue::None | EventValue::Sealed => {}
                }
                d
            })
            .collect();
        Ok((docs, hidden, plaintext))
    }

    // --- membership ------------------------------------------------------------

    /// The signer's best current role in `repo`, if any.
    pub async fn signer_role(&self, repo: &RepoRef) -> Result<Option<Role>> {
        let me = self.signer_id()?;
        Ok(MemberReader::new(self.client)
            .roles_of(repo, &me)
            .await?
            .iter()
            .map(|m| m.role)
            .min())
    }

    /// Refuse, before signing, a write the signer's role cannot make. `needs` is the least
    /// role that can (maintainer or writer). Off when [`SKIP_PRECHECK_ENV`] is set.
    pub async fn require_role(&self, repo: &RepoRef, needs: Role, action: &str) -> Result<()> {
        if !precheck_enabled() {
            return Ok(());
        }
        let role = self.signer_role(repo).await?;
        if role.is_some_and(|r| r <= needs) {
            return Ok(());
        }
        let need = members::doc_type(needs);
        Err(Error::NotPermitted {
            action: action.to_string(),
            reason: match role {
                Some(r) => format!(
                    "you are a {} of {}; this needs a {need}",
                    members::doc_type(r),
                    repo.display()
                ),
                None => format!("you are not a member of {}", repo.display()),
            },
            needs: need.to_string(),
        })
    }

    // --- reads: issues / patches ------------------------------------------------

    async fn target_doc(
        &self,
        repo: &RepoRef,
        kind: TargetKind,
        number: u32,
    ) -> Result<Option<FetchedDocument>> {
        let collab = self.collab_contract(repo).await?;
        let docs = self
            .client
            .query_documents(
                &collab,
                kind.doc_type(),
                &[
                    Self::repo_filter(repo)?,
                    QueryFilter::eq("number", FieldValue::integer(u64::from(number))),
                ],
                &[],
                1,
                None,
            )
            .await?;
        Ok(docs.into_iter().next())
    }

    /// Issue `number` of `repo`, if it exists, is well-formed and (private) opens.
    pub async fn issue(&self, repo: &RepoRef, number: u32) -> Result<Option<Issue>> {
        Ok(self
            .readable_target(repo, TargetKind::Issue, number)
            .await?
            .map(|d| issue_from_doc(&d)))
    }

    /// Pull request `number` of `repo`, if it exists, is well-formed and (private) opens.
    pub async fn patch(&self, repo: &RepoRef, number: u32) -> Result<Option<Patch>> {
        Ok(self
            .readable_target(repo, TargetKind::Patch, number)
            .await?
            .map(|d| patch_from_doc(&d)))
    }

    /// The newest `limit` well-formed issues or patches of `repo` (`$createdAt`
    /// descending), and how many were hidden on the way (malformed, or not readable to this
    /// reader).
    async fn newest(
        &self,
        repo: &RepoRef,
        kind: TargetKind,
        limit: u32,
    ) -> Result<Listed<FetchedDocument>> {
        let collab = self.collab_contract(repo).await?;
        let limit = if limit == 0 {
            DEFAULT_PAGE
        } else {
            limit.min(DEFAULT_PAGE)
        };
        let content = match kind {
            TargetKind::Issue => ContentKind::Issue,
            TargetKind::Patch => ContentKind::Patch,
        };
        let docs = self
            .client
            .query_documents(
                &collab,
                kind.doc_type(),
                &[Self::repo_filter(repo)?],
                &[QueryOrder::desc("$createdAt")],
                limit,
                None,
            )
            .await?;
        let more = docs.len() >= limit as usize;
        let (shown, hidden) = self.readable_all(repo, content, docs).await?;
        Ok(Listed {
            hidden,
            more,
            rows: shown,
        })
    }

    /// Every readable issue and pull request of `repo` (complete, oldest first), as flattened
    /// targets with their importer provenance and source number: in a private repo
    /// `imported.author` / `.url` are sealed, so this is the only way an importer finds what it
    /// already mirrored. A pull request also carries the base its merge is checked against
    /// (`baseRefName`, and its `$createdAt`: see [`Self::base_ref_tips`]).
    pub async fn imported_targets(&self, repo: &RepoRef) -> Result<Vec<ImportedRow>> {
        let collab = self.collab_contract(repo).await?;
        let mut out = Vec::new();
        for kind in [TargetKind::Issue, TargetKind::Patch] {
            let docs = self
                .client
                .query_all_documents(
                    &collab,
                    kind.doc_type(),
                    &[Self::repo_filter(repo)?],
                    &[QueryOrder::asc("$createdAt")],
                )
                .await?;
            let (docs, _) = self.readable_all(repo, kind.content_kind(), docs).await?;
            out.extend(docs.iter().map(|d| imported_row(kind, d)));
        }
        Ok(out)
    }

    /// The `kind` documents of `repo` whose `upstreamNumber` is `n` (the sparse `upstream
    /// (repoId, upstreamNumber)` index; whoever wrote them), opened in a private repo: how an
    /// importer finds the copy of source item #n in one read. The number is plaintext (it is
    /// indexed); the provenance beside it may be sealed.
    pub async fn upstream_targets(
        &self,
        repo: &RepoRef,
        kind: TargetKind,
        n: u32,
    ) -> Result<Vec<ImportedRow>> {
        let filters = [
            Self::repo_filter(repo)?,
            QueryFilter::eq("upstreamNumber", FieldValue::integer(u64::from(n))),
        ];
        self.upstream_rows(repo, kind, &filters, &[], None).await
    }

    /// The `kind` documents of `repo` that carry an `upstreamNumber`, highest first: one page
    /// of 100 (`all`: every one). A range from 1 up binds the sparse index (a missing value
    /// never meets it), so Drive answers from it. Whoever wrote them: the caller filters.
    pub async fn upstream_numbered(
        &self,
        repo: &RepoRef,
        kind: TargetKind,
        all: bool,
    ) -> Result<Vec<ImportedRow>> {
        let filters = [
            Self::repo_filter(repo)?,
            QueryFilter::gte("upstreamNumber", FieldValue::integer(1)),
        ];
        let order = [QueryOrder::desc("upstreamNumber")];
        let mut rows = self
            .upstream_rows(repo, kind, &filters, &order, (!all).then_some(DEFAULT_PAGE))
            .await?;
        rows.sort_by_key(|r| std::cmp::Reverse(r.upstream_number));
        Ok(rows)
    }

    async fn upstream_rows(
        &self,
        repo: &RepoRef,
        kind: TargetKind,
        filters: &[QueryFilter],
        order: &[QueryOrder],
        page: Option<u32>,
    ) -> Result<Vec<ImportedRow>> {
        let collab = self.collab_contract(repo).await?;
        let docs = match page {
            Some(limit) => {
                self.client
                    .query_documents(&collab, kind.doc_type(), filters, order, limit, None)
                    .await?
            }
            None => {
                self.client
                    .query_all_documents(&collab, kind.doc_type(), filters, order)
                    .await?
            }
        };
        let (docs, _) = self.readable_all(repo, kind.content_kind(), docs).await?;
        Ok(docs.iter().map(|d| imported_row(kind, d)).collect())
    }

    /// The newest `limit` issues (0 = one page of 100), newest first.
    pub async fn list_issues(&self, repo: &RepoRef, limit: u32) -> Result<Listed<Issue>> {
        Ok(self
            .newest(repo, TargetKind::Issue, limit)
            .await?
            .map(|d| issue_from_doc(&d)))
    }

    /// The repository's feed (`transition` in forge-collab, `event` and `authorEvent` in
    /// forge-community) as history specs, in [`Self::feed_logs`] order. All three are immutable
    /// and non-deletable with a `(repoId, $createdAt)` index, so the feed is read through the
    /// delta cache ([`crate::history`]): after the first read each call costs one request for
    /// what landed since.
    fn feed_specs<'c>(
        collab: &'c LoadedContract,
        community: &'c LoadedContract,
        scope: &crate::scope::DocScope,
    ) -> [crate::history::HistorySpec<'c>; 3] {
        [
            crate::history::HistorySpec::new(collab, DOC_TRANSITION, scope),
            crate::history::HistorySpec::new(community, DOC_EVENT, scope),
            crate::history::HistorySpec::new(community, DOC_AUTHOR_EVENT, scope),
        ]
    }

    /// The repo feed's rows (as Platform holds them; a private repo's member event values are
    /// opened here, never stored opened) as one log per target: the target's transitions
    /// (its state) and its events (labels, assignees, the base ref, the review kinds).
    async fn feed_logs(
        &self,
        repo: &RepoRef,
        [transitions, events, author_events]: [Vec<FetchedDocument>; 3],
    ) -> Result<BTreeMap<String, TargetLog>> {
        // A private repo's member events: their sealed values opened (§8.1).
        let (events, _, _) = self.readable_events(repo, events).await?;
        let mut logs: BTreeMap<String, TargetLog> = BTreeMap::new();
        for d in &transitions {
            if let (Some(tid), Some(t)) = (transition_target_of(d), transition_from_doc(d)) {
                logs.entry(tid).or_default().transitions.push(t);
            }
        }
        for e in events.iter().filter_map(event_from_doc) {
            logs.entry(e.target_id.clone()).or_default().events.push(e);
        }
        for e in author_events.iter().filter_map(event_from_doc) {
            logs.entry(e.target_id.clone())
                .or_default()
                .author_events
                .push(e);
        }
        Ok(logs)
    }

    /// Every well-formed issue of `repo` (newest first) with its state, and how many were
    /// skipped as malformed: one keyset walk of the `created` index (`$createdAt <=` the
    /// oldest row read, 100 per page, deduped by id) and ONE read of the repo feed
    /// (`transition` / `event` / `authorEvent` by `(repoId, $createdAt)`) through the delta
    /// cache. Open or closed is the sum of each issue's transitions; labels and assignees fold
    /// from its events. Requests: about `⌈issues/100⌉` plus the feed's new rows.
    pub async fn issues_with_state(&self, repo: &RepoRef) -> Result<(Vec<IssueView>, usize)> {
        let collab = self.collab_contract(repo).await?;
        let mut docs: Vec<FetchedDocument> = Vec::new();
        let mut seen = BTreeSet::new();
        let mut before: Option<u64> = None;
        loop {
            let mut filters = vec![Self::repo_filter(repo)?];
            if let Some(b) = before {
                filters.push(QueryFilter::lte("$createdAt", FieldValue::uint64(b)));
            }
            let page = self
                .client
                .query_documents(
                    &collab,
                    DOC_ISSUE,
                    &filters,
                    &[QueryOrder::desc("$createdAt")],
                    DEFAULT_PAGE,
                    None,
                )
                .await?;
            let full = page.len() >= DEFAULT_PAGE as usize;
            let oldest = page.last().and_then(|d| d.created_at);
            let mut added = 0;
            for d in page {
                if seen.insert(d.id.clone()) {
                    docs.push(d);
                    added += 1;
                }
            }
            // A full page that added nothing sits on one timestamp shared by 100+ issues.
            if !full || oldest.is_none() || (added == 0 && before == oldest) {
                break;
            }
            before = oldest;
        }
        let community = self.community_contract(repo).await?;
        let feed: [Vec<FetchedDocument>; 3] = crate::history::take(
            crate::history::sync(
                self.client,
                &Self::feed_specs(&collab, &community, &repo.scope()?),
                crate::history::Freshness::Now,
            )
            .await?,
        );
        let logs = self.feed_logs(repo, feed).await?;
        // Malformed rows, and in a private repo rows this reader cannot open, are hidden.
        let (readable, hidden) = self.readable_all(repo, ContentKind::Issue, docs).await?;
        let shown: Vec<IssueView> = readable
            .iter()
            .map(|d| {
                let issue = issue_from_doc(d);
                let log = logs.get(&issue.document_id).cloned().unwrap_or_default();
                IssueView {
                    state: fold_issue(&log),
                    issue,
                    hidden_values: log.hidden_values,
                    plaintext_values: log.plaintext_values,
                    log,
                }
            })
            .collect();
        Ok((shown, hidden))
    }

    /// The newest `limit` pull requests (0 = one page of 100), newest first.
    pub async fn list_patches(&self, repo: &RepoRef, limit: u32) -> Result<Listed<Patch>> {
        Ok(self
            .newest(repo, TargetKind::Patch, limit)
            .await?
            .map(|d| patch_from_doc(&d)))
    }

    /// The pull requests whose objects live in `source_repo_id` (the `source` index), any
    /// target repo — what a fork's owner opened upstream.
    ///
    /// Public source repositories only: a private repo's patches are sealed and indexed by a
    /// keyed hash, so they are left out (a private repo cannot be forked, `require_public`).
    pub async fn patches_from_source(
        &self,
        forge: &ForgeIds,
        source_repo_id: &str,
    ) -> Result<Vec<Patch>> {
        let collab = self.client.fetch_contract(&forge.collab).await?;
        let docs = self
            .client
            .query_all_documents(
                &collab,
                DOC_PATCH,
                &[QueryFilter::eq(
                    "sourceRepoId",
                    FieldValue::identifier(platform::decode_identifier(source_repo_id)?),
                )],
                &[QueryOrder::asc("sourceRepoId")],
            )
            .await?;
        Ok(docs
            .iter()
            .filter(|d| well_formed(ContentKind::Patch, d, Visibility::Public))
            .map(patch_from_doc)
            .collect())
    }

    // --- reads: logs ---------------------------------------------------------------

    async fn by_target(
        &self,
        collab: &LoadedContract,
        doc_type: &str,
        field: &str,
        target_id: &str,
    ) -> Result<Vec<FetchedDocument>> {
        // Complete: a fold over a partial log is wrong, and `comment` / `review` are
        // un-gated, so anyone can pad them.
        self.client
            .query_all_documents(
                collab,
                doc_type,
                &[QueryFilter::eq(
                    field,
                    FieldValue::identifier(platform::decode_identifier(target_id)?),
                )],
                &[QueryOrder::asc("$createdAt")],
            )
            .await
    }

    /// Every `transition`, `event` and `authorEvent` of a target, complete. The transitions
    /// are read on the `perTarget (targetId)` index (a target's history is short); their sum
    /// is the state code, the same number the proved sum query returns.
    pub async fn target_log(&self, repo: &RepoRef, target_id: &str) -> Result<TargetLog> {
        let collab = self.collab_contract(repo).await?;
        let community = self.community_contract(repo).await?;
        // Boxed: three complete reads in parallel make a large future for every caller.
        let (transitions, events, author_events) = Box::pin(async {
            futures::try_join!(
                self.transitions_of(&collab, target_id),
                self.by_target(&community, DOC_EVENT, "targetId", target_id),
                self.by_target(&community, DOC_AUTHOR_EVENT, "targetId", target_id),
            )
        })
        .await?;
        let (events, hidden_values, plaintext_values) = self.readable_events(repo, events).await?;
        Ok(TargetLog {
            transitions,
            events: events.iter().filter_map(event_from_doc).collect(),
            author_events: author_events.iter().filter_map(event_from_doc).collect(),
            hidden_values,
            plaintext_values,
        })
    }

    /// A target's transitions, oldest first (`$createdAt`, then `$id`), complete.
    async fn transitions_of(
        &self,
        collab: &LoadedContract,
        target_id: &str,
    ) -> Result<Vec<Transition>> {
        let docs = self
            .client
            .query_all_documents(
                collab,
                DOC_TRANSITION,
                &[QueryFilter::eq(
                    "targetId",
                    FieldValue::identifier(platform::decode_identifier(target_id)?),
                )],
                &[QueryOrder::asc("targetId")],
            )
            .await?;
        let mut out: Vec<Transition> = docs.iter().filter_map(transition_from_doc).collect();
        out.sort_by(|a, b| (a.created_at, &a.id).cmp(&(b.created_at, &b.id)));
        Ok(out)
    }

    /// Every well-formed (and, private, readable) comment on a target, oldest first.
    pub async fn comments(&self, repo: &RepoRef, target_id: &str) -> Result<Vec<Comment>> {
        Ok(self.comments_counted(repo, target_id).await?.0)
    }

    /// [`Self::comments`] and how many were hidden (malformed, or not readable to you).
    pub async fn comments_counted(
        &self,
        repo: &RepoRef,
        target_id: &str,
    ) -> Result<(Vec<Comment>, usize)> {
        let collab = self.collab_contract(repo).await?;
        let docs = self
            .by_target(&collab, DOC_COMMENT, "targetId", target_id)
            .await?;
        let (docs, hidden) = self.readable_all(repo, ContentKind::Comment, docs).await?;
        Ok((docs.iter().map(comment_from_doc).collect(), hidden))
    }

    /// Every well-formed review on a patch, oldest first. In a private repo only reviews this
    /// reader can open are returned, so an unreadable review is never counted (§8.1).
    pub async fn reviews(&self, repo: &RepoRef, patch_id: &str) -> Result<Vec<Review>> {
        Ok(self.reviews_counted(repo, patch_id).await?.0)
    }

    /// [`Self::reviews`] and how many were hidden (malformed, or not readable to you).
    pub async fn reviews_counted(
        &self,
        repo: &RepoRef,
        patch_id: &str,
    ) -> Result<(Vec<Review>, usize)> {
        let collab = self.collab_contract(repo).await?;
        let docs = self
            .by_target(&collab, DOC_REVIEW, "patchId", patch_id)
            .await?;
        let (docs, hidden) = self.readable_all(repo, ContentKind::Review, docs).await?;
        Ok((docs.iter().map(review_from_doc).collect(), hidden))
    }

    // --- reads: folded state --------------------------------------------------------

    /// An issue's state: its transitions' sum, and its events' labels and assignees.
    pub async fn issue_state(&self, repo: &RepoRef, issue: &Issue) -> Result<IssueState> {
        let log = self.target_log(repo, &issue.document_id).await?;
        Ok(fold_issue(&log))
    }

    /// The issue and its state, or `None`.
    pub async fn issue_view(&self, repo: &RepoRef, number: u32) -> Result<Option<IssueView>> {
        let Some(issue) = self.issue(repo, number).await? else {
            return Ok(None);
        };
        let log = self.target_log(repo, &issue.document_id).await?;
        Ok(Some(IssueView {
            state: fold_issue(&log),
            issue,
            hidden_values: log.hidden_values,
            plaintext_values: log.plaintext_values,
            log,
        }))
    }

    /// The base ref as merge verification sees it for a PR opened at `opened_at`
    /// ([`rules::pr_base_tips`]): every oid it has validly pointed at (the monotonic
    /// merge-reachability set, the same one forge-web uses), its newest tip and where it points
    /// now. A plain `refUpdate` on a protected branch is inert (§4) and contributes nothing,
    /// and a base that was no branch when the PR was opened has no tips (D-501).
    pub async fn base_ref_tips(
        &self,
        repo: &RepoRef,
        base_ref_name: &str,
        opened_at: u64,
    ) -> Result<rules::MergeBaseTips> {
        let core = self.core_contract(repo).await?;
        let scope = repo.scope()?;
        if repo.visibility == Visibility::Private {
            let kr = self.keyring(repo).await?;
            let cached = self
                .private_updates
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .clone()
                .filter(|(id, _)| *id == scope.repo_id)
                .map(|(_, u)| u);
            let updates = if let Some(u) = cached {
                u
            } else {
                let u = Arc::new(
                    crate::refs::read_private_updates(self.client, &core, &scope, &kr).await?,
                );
                *self
                    .private_updates
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner) =
                    Some((scope.repo_id, Arc::clone(&u)));
                u
            };
            return Ok(crate::refs::private_merge_base(
                &updates,
                &kr,
                base_ref_name,
                opened_at,
            ));
        }
        crate::refs::read_merge_base(
            self.client,
            &core,
            &scope,
            base_ref_name,
            opened_at,
            crate::history::Freshness::Now,
        )
        .await
    }

    /// A pull request's state (§3 fold; a merge counts once its oid has been a tip of a base
    /// that existed when the PR was opened), its current head (the review fold's) and review
    /// state.
    pub async fn patch_view(&self, repo: &RepoRef, patch: Patch) -> Result<PatchView> {
        let log = self.target_log(repo, &patch.document_id).await?;
        let base = self
            .base_ref_tips(repo, &patch.base_ref_name, patch.created_at)
            .await?;
        Ok(view_of(patch, log, base))
    }

    /// The newest `limit` pull requests (≤ 100) with their state, head and approvals, in a
    /// fixed number of requests whatever the count (`dg pr list`; D-500: it was about 9 per
    /// PR).
    ///
    /// Two requests in the usual case (`platform-parity-spec.md` §3.3):
    /// - ONE composite read: the PR page, every PR's `review`s as a lookup bound to the page's
    ///   `$id`s (reviews can be deleted, so they are read live), and the repo's `maintainer`
    ///   and `writer` documents as siblings;
    /// - ONE delta read ([`crate::history`]) of everything append-only the folds need: the
    ///   repo's feed (`transition`, `event`, `authorEvent`) and its ref history (`refUpdate`,
    ///   `protectedRefUpdate`, `config`), so every PR's state, merge commit, labels and base
    ///   tips come from it.
    ///
    /// A review lookup or a member sibling that fills its 100-row cap may be cut short, so
    /// what it covers is re-read completely rather than folded from a partial list. A private
    /// repo's rows are opened here (patches, reviews, event values, ref names), never stored
    /// opened.
    pub async fn list_patch_views(
        &self,
        repo: &RepoRef,
        limit: u32,
    ) -> Result<Listed<(PatchView, Approvals)>> {
        let forge = repo.forge();
        self.client
            .prefetch_contracts(&[&forge.collab, &forge.core, &forge.community])
            .await?;
        let collab = self.collab_contract(repo).await?;
        let core = self.core_contract(repo).await?;
        let community = self.community_contract(repo).await?;
        let scope = repo.scope()?;
        let limit = page_limit(limit);
        let reads = pr_list_reads(&collab, &core, &scope, limit);
        let [feed_a, feed_b, feed_c] = Self::feed_specs(&collab, &community, &scope);
        let [refs_a, refs_b, refs_c] = crate::refs::GitState::specs(&core, &scope);
        let history = [feed_a, feed_b, feed_c, refs_a, refs_b, refs_c];
        let (batch, synced) = futures::join!(
            self.client.query_batch(&reads),
            crate::history::sync(self.client, &history, crate::history::Freshness::Now)
        );
        let [page, reviews, maintainers, writers] = crate::history::take(batch?);
        let [transitions, events, author_events, ref_updates, protected_ref_updates, configs] =
            crate::history::take(synced?);
        let state = crate::refs::GitState::from_rows([ref_updates, protected_ref_updates, configs]);

        let more = page.len() >= limit as usize;
        let page_ids: Vec<[u8; 32]> = page
            .iter()
            .filter_map(|d| platform::decode_identifier(&d.id).ok())
            .collect();
        let (patches, hidden) = self.readable_all(repo, ContentKind::Patch, page).await?;
        // Membership siblings are capped at 100 per role: a full one is read completely.
        let oracle = if maintainers.len() >= LOOKUP_CAP_LEN || writers.len() >= LOOKUP_CAP_LEN {
            self.member_oracle(repo).await?
        } else {
            oracle_of(&maintainers, &writers)
        };
        let mut logs = self
            .feed_logs(repo, [transitions, events, author_events])
            .await?;
        let reviews = self.complete_reviews(&collab, reviews, &page_ids).await?;
        let (reviews, _) = self
            .readable_all(repo, ContentKind::Review, reviews)
            .await?;
        let mut reviews = per_target(reviews, "patchId");
        // The base branch of every row folds against one read of the ref history.
        let base_of: Box<dyn Fn(&Patch) -> rules::MergeBaseTips + Send + Sync> =
            if repo.visibility == Visibility::Private {
                let kr = self.keyring(repo).await?;
                let updates = crate::refs::private_updates_of(&state, &kr);
                Box::new(move |p: &Patch| {
                    crate::refs::private_merge_base(&updates, &kr, &p.base_ref_name, p.created_at)
                })
            } else {
                let configs = state.config_history();
                Box::new(move |p: &Patch| {
                    crate::refs::merge_base_of(&state, &configs, &p.base_ref_name, p.created_at)
                })
            };

        let mut rows = Vec::with_capacity(patches.len());
        for patch in patches.iter().map(patch_from_doc) {
            let id = &patch.document_id;
            let log = logs.remove(id).unwrap_or_default();
            let mut docs = reviews.remove(id).unwrap_or_default();
            docs.sort_by(|a, b| (a.created_at, &a.id).cmp(&(b.created_at, &b.id)));
            let patch_reviews: Vec<Review> = docs.iter().map(review_from_doc).collect();
            let base = base_of(&patch);
            let view = view_of(patch, log, base);
            let approvals = approvals_over(&patch_reviews, &view, &oracle);
            rows.push((view, approvals));
        }
        Ok(Listed { rows, hidden, more })
    }

    /// Complete the review lookup of [`Self::list_patch_views`] ([`reviews_to_reread`]): the
    /// PRs a full lookup may have cut short are read again with `patchId in [..]`, a page at
    /// a time, until a short page proves the rest complete. One request per 100 reviews,
    /// never one per PR. A PR that fills a whole page by itself is read on its own.
    async fn complete_reviews(
        &self,
        collab: &LoadedContract,
        first: Vec<FetchedDocument>,
        page_ids: &[[u8; 32]],
    ) -> Result<Vec<FetchedDocument>> {
        let mut out = Vec::new();
        let mut rows = first;
        let mut wanted = page_ids.to_vec();
        loop {
            let reread = reviews_to_reread(&rows, &wanted);
            // A full page of one PR's reviews settles nothing: that PR is read on its own.
            let first = rows.first().and_then(|d| d.field_bytes32("patchId"));
            let last = rows.last().and_then(|d| d.field_bytes32("patchId"));
            let alone = (!reread.is_empty() && first == last)
                .then_some(last)
                .flatten();
            out.extend(rows.into_iter().filter(|d| {
                d.field_bytes32("patchId")
                    .is_some_and(|p| !reread.contains(&p))
            }));
            wanted = reread;
            if let Some(whole) = alone {
                wanted.retain(|id| *id != whole);
                out.extend(
                    self.by_target(
                        collab,
                        DOC_REVIEW,
                        "patchId",
                        &platform::encode_identifier(whole),
                    )
                    .await?,
                );
            }
            if wanted.is_empty() {
                return Ok(out);
            }
            rows = self
                .client
                .query_documents(
                    collab,
                    DOC_REVIEW,
                    &[QueryFilter::in_list(
                        "patchId",
                        wanted
                            .iter()
                            .map(|id| FieldValue::identifier(*id))
                            .collect(),
                    )],
                    &review_lookup_order(),
                    LOOKUP_CAP,
                    None,
                )
                .await?;
        }
    }

    /// The PR's approvals on its current head (§6): member reviews only, dismissed reviews
    /// skipped.
    pub async fn approvals(
        &self,
        repo: &RepoRef,
        view: &PatchView,
    ) -> Result<(Approvals, Vec<Review>)> {
        let oracle = self.member_oracle(repo).await?;
        self.approvals_with(repo, view, &oracle).await
    }

    /// The repo's current membership as the rules take it (read once for a whole list).
    pub async fn member_oracle(&self, repo: &RepoRef) -> Result<RoleOracle> {
        Ok(members::oracle(
            &MemberReader::new(self.client).list(repo).await?,
        ))
    }

    /// [`Self::approvals`] against a membership the caller already read.
    pub async fn approvals_with(
        &self,
        repo: &RepoRef,
        view: &PatchView,
        oracle: &RoleOracle,
    ) -> Result<(Approvals, Vec<Review>)> {
        let reviews = self.reviews(repo, &view.patch.document_id).await?;
        Ok((approvals_over(&reviews, view, oracle), reviews))
    }

    /// The branch policy in force: the newest `policy` of `repo` by `($createdAt, $id)`
    /// (forge-v2.md §2), or `None`.
    pub async fn policy(&self, repo: &RepoRef) -> Result<Option<Policy>> {
        let community = self.community_contract(repo).await?;
        let docs = self
            .client
            .query_all_documents(
                &community,
                DOC_POLICY,
                &[Self::repo_filter(repo)?],
                &[QueryOrder::asc("$createdAt")],
            )
            .await?;
        Ok(docs
            .iter()
            .max_by(|a, b| (a.created_at, &a.id).cmp(&(b.created_at, &b.id)))
            .map(policy_from_doc))
    }

    /// The open-or-closed PRs whose head branch is `source_ref_name` in `source_repo_id` (the
    /// `sourceRef` index): what a push to that branch may have to move with a `headUpdate`.
    ///
    /// Public source repositories only (the index key is `sha256(name)`; a private repo's is a
    /// keyed hash, and its patches are sealed): private ones never match.
    pub async fn patches_from_branch(
        &self,
        forge: &ForgeIds,
        source_repo_id: &str,
        source_ref_name: &str,
    ) -> Result<Vec<Patch>> {
        let collab = self.client.fetch_contract(&forge.collab).await?;
        let docs = self
            .client
            .query_all_documents(
                &collab,
                DOC_PATCH,
                &[
                    QueryFilter::eq(
                        "sourceRepoId",
                        FieldValue::identifier(platform::decode_identifier(source_repo_id)?),
                    ),
                    QueryFilter::eq(
                        "sourceRefNameHash",
                        FieldValue::bytes32(sha256(source_ref_name.as_bytes())),
                    ),
                ],
                &[
                    QueryOrder::asc("sourceRepoId"),
                    QueryOrder::asc("sourceRefNameHash"),
                ],
            )
            .await?;
        // A public patch whose name does not hash to its key is malformed (§5); the query
        // matched the hash, so compare the name too.
        Ok(docs
            .iter()
            .filter(|d| well_formed(ContentKind::Patch, d, Visibility::Public))
            .map(patch_from_doc)
            .filter(|p| p.source_ref_name.as_deref() == Some(source_ref_name))
            .collect())
    }

    /// The open PRs a push of `source_ref_name` to `source_repo_id` should move, with their
    /// target repos and views: PRs from that branch ([`Self::patches_from_branch`]) authored
    /// by `author` (anyone can open a PR naming someone's branch; only the author's are
    /// read further), re-read well-formed in their own repo, open, whose folded head is not
    /// already `new_head`. At most [`MAX_FOLLOWING`] are read. A PR that cannot be read
    /// (its repo gone, private, or malformed) is skipped, never failing the others. What
    /// `git push` and `dg pr sync` post a `headUpdate` for.
    pub async fn prs_following(
        &self,
        forge: &ForgeIds,
        source_repo_id: &str,
        source_ref_name: &str,
        new_head: &str,
        author: &str,
    ) -> Result<Vec<(RepoRef, PatchView)>> {
        let mut out = Vec::new();
        let mine = self
            .patches_from_branch(forge, source_repo_id, source_ref_name)
            .await?
            .into_iter()
            .filter(|p| p.author == author)
            .take(MAX_FOLLOWING);
        for p in mine {
            let read = async {
                let repo = crate::resolve::resolve_id(self.client, &p.repo_id).await?;
                // The branch query saw the raw document; the reader rule (§5) is per repo.
                let Some(p) = self.patch(&repo, p.number).await? else {
                    return Ok(None);
                };
                let view = self.patch_view(&repo, p).await?;
                Ok::<_, Error>(Some((repo, view)))
            };
            match read.await {
                Ok(Some((repo, view)))
                    if view.state.open && !view.head.eq_ignore_ascii_case(new_head) =>
                {
                    out.push((repo, view));
                }
                Ok(_) => {}
                Err(e) => {
                    tracing::warn!(pr = p.number, repo = %p.repo_id, error = %e, "skipping a pull request that cannot be read");
                }
            }
        }
        Ok(out)
    }

    /// The check runs reported on `head_oid` in `repo` (the `checkRun` `head` index): the
    /// newest per `name`, each marked trusted when its reporter is a current maintainer,
    /// writer or runner ([`newest_check_runs`]).
    pub async fn check_runs(&self, repo: &RepoRef, head_oid: &str) -> Result<Vec<CheckRun>> {
        let docs = self.check_run_docs(repo, head_oid).await?;
        if docs.is_empty() {
            return Ok(Vec::new());
        }
        let oracle = self.member_oracle(repo).await?;
        let runners = self.runner_ids(repo).await?;
        Ok(newest_check_runs(&docs, |who| {
            oracle.current_role(who).is_some() || runners.contains(who)
        }))
    }

    /// Whether the check runs on `head_oid` meet `policy`'s check rules ([`checks_state`], the
    /// rule the web merge box applies too): the newest **trusted** run per name decides it.
    pub async fn head_checks(
        &self,
        repo: &RepoRef,
        head_oid: &str,
        oracle: &RoleOracle,
        policy: &ChecksPolicy,
    ) -> Result<ChecksState> {
        let docs = self.check_run_docs(repo, head_oid).await?;
        let rows: Vec<CheckRunRow> = docs
            .iter()
            .map(|d| CheckRunRow {
                id: d.id.clone(),
                head_oid: head_oid.to_ascii_lowercase(),
                name: d.field_str("name").unwrap_or_default(),
                status: d.field_str("status").unwrap_or_default(),
                conclusion: d.field_str("conclusion"),
                reporter: d.owner_id.clone(),
                created_at: d.created_at.unwrap_or_default(),
            })
            .collect();
        let runners = if rows.is_empty() {
            BTreeSet::new()
        } else {
            self.runner_ids(repo).await?
        };
        Ok(checks_state(&rows, head_oid, oracle, &runners, policy))
    }

    async fn check_run_docs(&self, repo: &RepoRef, head_oid: &str) -> Result<Vec<FetchedDocument>> {
        let community = self.community_contract(repo).await?;
        let oid = hex::decode(head_oid)
            .map_err(|_| Error::Config(format!("{head_oid:?} is not a hex commit id")))?;
        check_run_docs(self.client, &community, repo, oid).await
    }

    async fn runner_ids(&self, repo: &RepoRef) -> Result<BTreeSet<String>> {
        Ok(crate::ci::RunnerReader::new(self.client)
            .list(repo)
            .await?
            .into_iter()
            .map(|r| r.identity_id)
            .collect())
    }

    // --- state and counts -----------------------------------------------------------------

    /// The transition sums of `target_ids` (base58): the proved sum of `transition.delta` per
    /// target (`perTarget`, `summable: delta`), one grouped request per 100 targets. A target
    /// with no transitions reads 0 (open). A sum is not a state code: fold it
    /// ([`status_of_code`], [`rules::v2::fold_sum`]; 16 or more is locked).
    pub async fn state_sums(
        &self,
        repo: &RepoRef,
        target_ids: &[String],
    ) -> Result<BTreeMap<String, i64>> {
        let collab = self.collab_contract(repo).await?;
        let ids: BTreeSet<[u8; 32]> = target_ids
            .iter()
            .map(|id| platform::decode_identifier(id))
            .collect::<Result<_>>()?;
        let ids: Vec<[u8; 32]> = ids.into_iter().collect();
        let mut out: BTreeMap<String, i64> = target_ids.iter().map(|id| (id.clone(), 0)).collect();
        for chunk in ids.chunks(LOOKUP_CAP_LEN) {
            let filter = QueryFilter::in_list(
                "targetId",
                chunk.iter().map(|id| FieldValue::identifier(*id)).collect(),
            );
            let sums = self
                .client
                .sum_documents_grouped(&collab, DOC_TRANSITION, &[filter], "targetId", "delta")
                .await?;
            out.extend(sums_by_target(sums)?);
        }
        Ok(out)
    }

    /// One target's transition sum ([`Self::state_sums`]).
    pub async fn state_sum(&self, repo: &RepoRef, target_id: &str) -> Result<i64> {
        Ok(self
            .state_sums(repo, &[target_id.to_string()])
            .await?
            .get(target_id)
            .copied()
            .unwrap_or(0))
    }

    /// The repo's open / closed / merged / draft totals (`STATE-COUNTS.md` §4), from three
    /// proved counts read in parallel: the `issue` and `patch` totals (`perRepo`), and the
    /// `transition`s grouped by `kind` (`perRepoKind`, one count tree per kind).
    pub async fn repo_state_counts(&self, repo: &RepoRef) -> Result<RepoCounts> {
        let collab = self.collab_contract(repo).await?;
        let by_repo = [Self::repo_filter(repo)?];
        let kinds = [
            Self::repo_filter(repo)?,
            QueryFilter::in_list(
                "kind",
                TRANSITION_KINDS
                    .iter()
                    .map(|k| FieldValue::integer(u64::from(*k)))
                    .collect(),
            ),
        ];
        let (issues, patches, kinds) = futures::try_join!(
            self.client.count_documents(&collab, DOC_ISSUE, &by_repo),
            self.client.count_documents(&collab, DOC_PATCH, &by_repo),
            self.client
                .count_documents_grouped(&collab, DOC_TRANSITION, &kinds, "kind"),
        )?;
        Ok(repo_counts(issues, patches, &counts_by_kind(kinds)?))
    }

    // --- numbering --------------------------------------------------------------------

    /// The number the next issue or PR of `repo` must carry: the contract's `dense` rule pins
    /// it to the repo's issue count plus its PR count, the new document included (issues and
    /// PRs share one sequence). Two proved counts (`perRepo`), read in parallel.
    pub async fn next_number(&self, repo: &RepoRef) -> Result<u32> {
        let collab = self.collab_contract(repo).await?;
        let by_repo = [Self::repo_filter(repo)?];
        let (issues, patches) = futures::try_join!(
            self.client.count_documents(&collab, DOC_ISSUE, &by_repo),
            self.client.count_documents(&collab, DOC_PATCH, &by_repo),
        )?;
        dense_number(issues, patches)
            .ok_or_else(|| Error::Config(format!("{} has used every issue number", repo.display())))
    }

    // --- writes: numbered creates ------------------------------------------------------

    /// Open an issue at the dense next number. Resumable: see the module docs.
    pub async fn create_issue(
        &self,
        repo: &RepoRef,
        title: &str,
        body: &str,
        journal_dir: &Path,
    ) -> Result<Created> {
        issue_props(1, title, body, Provenance::default())?;
        let fingerprint = [title, "\0", body].concat();
        self.create_dense(
            repo,
            TargetKind::Issue,
            Some((journal_dir, &fingerprint)),
            |n| issue_props(n, title, body, Provenance::default()),
        )
        .await
    }

    /// Open a pull request at the dense next number. Resumable. A draft (`input.draft`) is the
    /// create followed by a draft transition (kind 14): a `patch` has no draft flag. When the
    /// PR lands but the draft transition does not, the error says so (E106) and names the
    /// command that finishes it.
    pub async fn create_patch(
        &self,
        repo: &RepoRef,
        input: &PatchInput,
        journal_dir: &Path,
    ) -> Result<Created> {
        patch_props(1, input, Provenance::default())?;
        let fingerprint = format!(
            "{}\0{}\0{}\0{}\0{}",
            input.title,
            input.body,
            input.base_ref_name,
            input.source_repo_id,
            hex::encode(&input.head_oid)
        );
        let mut created = self
            .create_dense(
                repo,
                TargetKind::Patch,
                Some((journal_dir, &fingerprint)),
                |n| patch_props(n, input, Provenance::default()),
            )
            .await?;
        if input.draft {
            created.draft_transition = self.mark_new_draft(repo, &created).await?;
        }
        Ok(created)
    }

    /// The draft transition of a PR this command opened: its id, or `None` when the PR already
    /// reads as a draft (a resumed create whose transition landed on the earlier run). A PR
    /// just created is at code 0. When the transition cannot be written the state is read
    /// again first: a draft that landed anyway (a timed-out wait) is done, not an error.
    async fn mark_new_draft(&self, repo: &RepoRef, created: &Created) -> Result<Option<String>> {
        let target = Target {
            kind: TargetKind::Patch,
            id: created.document_id.clone(),
            number: created.number,
            author: self.signer_id()?,
        };
        let is_draft = |code: i64| status_of_code(code).draft;
        let code = if created.resumed {
            self.state_sum(repo, &target.id).await?
        } else {
            0
        };
        if is_draft(code) {
            return Ok(None);
        }
        let e = match self
            .set_state_from(repo, &target, StateAction::Draft, None, Some(code))
            .await
        {
            Ok(c) => return Ok(Some(c.transition_id)),
            Err(e) => e,
        };
        if self.state_sum(repo, &target.id).await.is_ok_and(is_draft) {
            return Ok(None);
        }
        // A refusal is conclusive; anything else (the network) may hide a landed transition.
        let refused = matches!(
            e,
            Error::RuleRefused { .. }
                | Error::NotPermitted { .. }
                | Error::NotAMember { .. }
                | Error::ReferenceNotFound { .. }
                | Error::User(_)
        );
        Err(UserError::new(
            codes::PARTIAL,
            format!(
                "opened pull request #{} in {}, but {} as a draft",
                created.number,
                repo.display(),
                if refused {
                    "did not mark it"
                } else {
                    "could not confirm it is marked"
                }
            ),
        )
        .cause(e.to_string())
        .fix(format!(
            "`dg pr view {} {}` shows its state; `dg pr draft {} {}` marks it a draft",
            repo.display(),
            created.number,
            repo.display(),
            created.number
        ))
        .into())
    }

    /// Create an imported issue or PR (the importer's primitive) at the dense next number,
    /// recording its provenance and source number (`upstreamNumber`). Not journaled: the
    /// importer finds what it already wrote on chain (`imported.url`, `upstreamNumber`).
    pub async fn create_imported(
        &self,
        repo: &RepoRef,
        what: ImportedTarget<'_>,
        from: Provenance<'_>,
    ) -> Result<Created> {
        match what {
            ImportedTarget::Issue { title, body } => {
                self.create_dense(repo, TargetKind::Issue, None, |n| {
                    issue_props(n, title, body, from)
                })
                .await
            }
            ImportedTarget::Patch(input) => {
                self.create_dense(repo, TargetKind::Patch, None, |n| {
                    patch_props(n, input, from)
                })
                .await
            }
        }
    }

    /// Where a journaled create of `kind` by `me` is saved (`None`: not journaled). A private
    /// repo's title and body must not be guessable from a local file name: the fingerprint is
    /// keyed with a per-install secret there.
    fn journal_path(
        &self,
        repo: &RepoRef,
        kind: TargetKind,
        me: &str,
        journal: Option<(&Path, &str)>,
    ) -> Result<Option<PathBuf>> {
        let Some((dir, fingerprint)) = journal else {
            return Ok(None);
        };
        let key = (repo.visibility == Visibility::Private)
            .then(|| journal_secret(dir))
            .transpose()?;
        Ok(Some(create_journal_path(
            dir,
            &self.client.target().network.key(),
            repo.id(),
            kind,
            me,
            fingerprint,
            key.as_ref(),
        )))
    }

    /// Finish an interrupted create saved at `path`: re-broadcast its bytes and, when they
    /// landed, return it. A saved create that never landed (refused, or its number taken) is
    /// dropped, and the caller numbers afresh.
    async fn resume_create(
        &self,
        engine: &WriteEngine<'_>,
        collab: &LoadedContract,
        kind: TargetKind,
        path: Option<&Path>,
    ) -> Result<Option<Created>> {
        let Some(path) = path else { return Ok(None) };
        let Some(saved) = CreateJournal::load(path, &collab.id()) else {
            return Ok(None);
        };
        let landed = replay_landed(engine, collab, kind.doc_type(), &saved.intent).await?;
        CreateJournal::remove(path);
        if landed {
            return Ok(Some(Created {
                number: saved.number,
                document_id: saved.intent.document_id,
                resumed: true,
                draft_transition: None,
            }));
        }
        tracing::warn!(
            document = %saved.intent.document_id,
            "a saved create from an interrupted run never landed; numbering afresh"
        );
        Ok(None)
    }

    /// This call's own create of `plain` at `number`, when that is what holds it
    /// ([`adoptable`]): an earlier attempt of it landed though its read lagged.
    async fn own_create_at(
        &self,
        repo: &RepoRef,
        kind: TargetKind,
        number: u32,
        (me, plain): (&str, &BTreeMap<String, FieldValue>),
        signed: &[(u32, String)],
    ) -> Option<Created> {
        let d = self.readable_target(repo, kind, number).await.ok()??;
        let own = adoptable(&d, me, plain, signed);
        own.then_some(Created {
            number,
            document_id: d.id,
            resumed: false,
            draft_transition: None,
        })
    }

    /// Create a `kind` document at the dense next number ([`Self::next_number`]), counting
    /// again when another create took it first: consensus refuses a stale number by the
    /// `dense` rule (10422, before execution: nothing landed, and a stale write is refused at
    /// CheckTx for free) or, when the count moved on after the rules ran, by the unique
    /// `number` index. `journal` (a directory and the content's fingerprint) makes it
    /// resumable: the signed create is saved before its first broadcast.
    #[allow(clippy::too_many_lines)] // one numbered-create loop, its outcomes side by side
    async fn create_dense(
        &self,
        repo: &RepoRef,
        kind: TargetKind,
        journal: Option<(&Path, &str)>,
        props: impl Fn(u32) -> Result<BTreeMap<String, FieldValue>>,
    ) -> Result<Created> {
        let me = self.signer_id()?;
        let collab = self.collab_contract(repo).await?;
        let engine = self.engine()?;
        let path = self.journal_path(repo, kind, &me, journal)?;
        if let Some(done) = self
            .resume_create(&engine, &collab, kind, path.as_deref())
            .await?
        {
            return Ok(done);
        }
        // A read right after a refusal can lag the block that took the number, so never try
        // a number at or below one already refused.
        let mut floor = 0u32;
        // Every create this call signs, with its number (a retry re-signs with fresh entropy,
        // so a number can have several): only these may be adopted as landed.
        let mut signed: Vec<(u32, String)> = Vec::new();
        let mut proof_retried = false;
        for attempt in 0..MAX_NUMBER_ATTEMPTS {
            let number = self.next_number(repo).await?.max(floor);
            let plain = props(number)?;
            // sealed per number: the AD binds it (§4.4), so a renumbered retry re-seals
            let sealed = self
                .seal_if_private(repo, kind.content_kind(), plain.clone())
                .await?;
            let mut all = Self::with_repo(repo, sealed)?;
            self.stamp(repo, kind.doc_type(), &mut all).await?;
            let optional_proof = !proof_required(&all);
            let res = engine
                .create_journaled(&collab, kind.doc_type(), all, |p| {
                    signed.push((number, p.document_id().to_string()));
                    match &path {
                        Some(path) => CreateJournal {
                            saved_at: unix_now(),
                            contract: collab.id(),
                            number,
                            intent: WriteIntent::for_prepared(0, p),
                        }
                        .save(path),
                        None => Ok(()),
                    }
                })
                .await;
            let forget = || {
                if let Some(path) = &path {
                    CreateJournal::remove(path);
                }
            };
            match res {
                Ok(prepared) => {
                    forget();
                    return Ok(Created {
                        number,
                        document_id: prepared.document_id().to_string(),
                        resumed: false,
                        draft_transition: None,
                    });
                }
                // The number is taken: by an earlier attempt of this same create (it landed, but
                // the read after its consumed nonce lagged), which is the result; else by
                // another create, and nothing of ours landed: count again.
                Err(e) if number_taken(&e) => {
                    forget();
                    let own = self.own_create_at(repo, kind, number, (&me, &plain), &signed);
                    if let Some(done) = own.await {
                        return Ok(done);
                    }
                    floor = number.saturating_add(1);
                    tracing::warn!(number, attempt, "number taken; counting again");
                }
                // The membership was removed since it was read: nothing landed; once, sign
                // again without the (optional) proof.
                Err(e) if !proof_retried && optional_proof && self.proof_refused(repo, &e) => {
                    forget();
                    proof_retried = true;
                }
                // Refusals that prove nothing landed: forget the transition, or the same
                // command would replay it (and be refused) forever. Anything else — a failed
                // read after the broadcast, an unrecognised SDK error — may hide a landed
                // create, so the journal stays and the next run resumes it.
                Err(
                    e @ (Error::NotAMember { .. }
                    | Error::ReferenceNotFound { .. }
                    | Error::StaleProtocolVersion(_)
                    | Error::RuleRefused { .. }),
                ) => {
                    forget();
                    return Err(e);
                }
                // Anything else (a wait that timed out, a failed read, a nonce lost after lagging
                // reads) may hide a landed create: a proved read of every id this call signed
                // settles it. Unsettled, a journaled create stays saved for the next run; the
                // importer (not journaled) finds its copy on chain.
                Err(e) => {
                    for (n, id) in signed.iter().rev() {
                        if engine
                            .landed(&collab, kind.doc_type(), id, true)
                            .await
                            .unwrap_or(false)
                        {
                            forget();
                            return Ok(Created {
                                number: *n,
                                document_id: id.clone(),
                                resumed: false,
                                draft_transition: None,
                            });
                        }
                    }
                    return Err(e);
                }
            }
        }
        Err(Error::Platform(format!(
            "could not claim a {} number after {MAX_NUMBER_ATTEMPTS} attempts (other creates \
             kept taking it); run the command again",
            kind.noun()
        )))
    }

    // --- writes: edits (document replace) --------------------------------------------------

    /// Edit an issue's or PR's title and/or body, as its author (consensus admits a replace only
    /// from the owner; `number`, and a PR's refs and head, are immutable or untouched). An empty
    /// `body` removes it. Returns whether an edit landed (`false`: it already read that way,
    /// nothing was signed). In a private repo the content is re-sealed as a whole and the
    /// replace sets only `enc` / `epoch` ([`Self::private_edit`]).
    pub async fn update_target(
        &self,
        repo: &RepoRef,
        target: &Target,
        title: Option<&str>,
        body: Option<&str>,
    ) -> Result<bool> {
        let mut changes = BTreeMap::new();
        if let Some(t) = title {
            check_title(t)?;
            changes.insert("title".to_string(), Some(FieldValue::text(t)));
        }
        if let Some(b) = body {
            let what = match target.kind {
                TargetKind::Issue => "issue body",
                TargetKind::Patch => "PR body",
            };
            check_text(what, b, 5120, 5120)?;
            changes.insert(
                "body".to_string(),
                (!b.is_empty()).then(|| FieldValue::text(b)),
            );
        }
        if changes.is_empty() {
            return Err(Error::Config(
                "nothing to change: pass a new title or body".into(),
            ));
        }
        self.require_author(
            &target.author,
            &format!("edit {} #{}", target.kind.noun(), target.number),
        )?;
        let collab = self.collab_contract(repo).await?;
        let kind = match target.kind {
            TargetKind::Issue => DocKind::Issue,
            TargetKind::Patch => DocKind::Patch,
        };
        self.replace_content(repo, &collab, kind, &target.id, changes)
            .await
    }

    /// A private PR's key epoch and the repo's current write epoch, when the PR's is older: an
    /// edit re-seals under the PR's own epoch (§4.5), so the edited text stays readable to
    /// anyone who held that epoch's key, including members removed since. `None` for a public
    /// repo or a PR under the write epoch.
    pub async fn pr_edit_epochs(
        &self,
        repo: &RepoRef,
        patch_id: &str,
    ) -> Result<Option<(u32, u32)>> {
        if repo.visibility != Visibility::Private {
            return Ok(None);
        }
        let collab = self.collab_contract(repo).await?;
        let Some(stored) = self
            .client
            .fetch_document(&collab, DOC_PATCH, patch_id)
            .await?
        else {
            return Ok(None);
        };
        let pr_epoch = stored
            .field_u64("epoch")
            .and_then(|e| u32::try_from(e).ok());
        let write = self.keyring(repo).await?.resolution().write_epoch;
        Ok(match (pr_epoch, write) {
            (Some(p), Some(w)) if p < w => Some((p, w)),
            _ => None,
        })
    }

    /// Edit one of the signer's comments (the body only: the anchor, thread and review are
    /// immutable), re-sealed in a private repo like [`Self::update_target`].
    pub async fn update_comment(
        &self,
        repo: &RepoRef,
        comment_id: &str,
        body: &str,
    ) -> Result<bool> {
        if body.trim().is_empty() {
            return Err(Error::Config("a comment needs a body".into()));
        }
        check_text("comment body", body, 5120, 5120)?;
        let collab = self.collab_contract(repo).await?;
        let changes = BTreeMap::from([("body".to_string(), Some(FieldValue::text(body)))]);
        self.replace_content(repo, &collab, DocKind::Comment, comment_id, changes)
            .await
    }

    /// Replace the text of the signer's `kind` document `id` of `repo`. The stored document is
    /// read first ([`edit_check`]: it is `repo`'s and the signer's). Public: the plaintext
    /// `changes`. Private: [`Self::private_edit`]'s `enc` / `epoch`, guarded by the revision
    /// read here.
    async fn replace_content(
        &self,
        repo: &RepoRef,
        collab: &LoadedContract,
        kind: DocKind,
        id: &str,
        changes: BTreeMap<String, Option<FieldValue>>,
    ) -> Result<bool> {
        let doc_type = kind.type_name();
        let stored = self
            .client
            .fetch_document(collab, doc_type, id)
            .await?
            .ok_or(Error::NotFound)?;
        let revision = edit_check(repo, doc_type, &stored, &self.signer_id()?)?;
        let mut changes = if repo.visibility == Visibility::Private {
            self.private_edit(repo, kind, &stored, &changes).await?
        } else {
            changes
        };
        for field in self.dead_references(repo, collab, &stored).await? {
            changes.insert(field.to_string(), None);
        }
        self.engine()?
            .replace_document_guarded(collab, doc_type, id, &changes, Some(revision))
            .await
    }

    /// The references of the signer's stored document that no longer hold, which a replace
    /// must clear: a replace re-checks every reference to a deletable document, touched or not,
    /// and an immutable one may be cleared once its target is gone. `replyTo` (the root was
    /// deleted: the reply becomes a root of its own), `reviewId` (the review was deleted) and
    /// `asMember` (the signer is no longer a member: what they wrote as one stays editable).
    /// An imported item or one with an upstream number needs the proof (`i_provenance`), so its
    /// former member cannot edit it: refused here, before signing.
    async fn dead_references(
        &self,
        repo: &RepoRef,
        collab: &LoadedContract,
        stored: &FetchedDocument,
    ) -> Result<Vec<&'static str>> {
        let mut dead = Vec::new();
        for (field, doc_type) in [("replyTo", DOC_COMMENT), ("reviewId", DOC_REVIEW)] {
            if let Some(id) = id_field(stored, field) {
                if self
                    .client
                    .fetch_document(collab, doc_type, &id)
                    .await?
                    .is_none()
                {
                    dead.push(field);
                }
            }
        }
        let proved = stored.fields.contains_key(crate::layout::AS_MEMBER);
        if proved && !self.is_member(repo).await? {
            if stored.fields.contains_key("imported")
                || stored.fields.contains_key("upstreamNumber")
            {
                return Err(Error::NotPermitted {
                    action: "edit this imported item".into(),
                    reason: format!(
                        "an imported item carries its importer's membership proof, and you are no \
                         longer a member of {}",
                        repo.display()
                    ),
                    needs: "writer".into(),
                });
            }
            dead.push(crate::layout::AS_MEMBER);
        }
        Ok(dead)
    }

    /// The changes a private edit of the signer's `kind` document `stored` writes
    /// (docs/security/private-repos.md §4.5, §5.3; the web's `sealEdit`): it is opened with keys
    /// resolved now and its content re-sealed as a whole with `changes` applied
    /// ([`private::reseal_edit`], the `private_collab_seal` transform), an issue or comment
    /// under the current write epoch, a PR under its own epoch (its ref-name hashes are keyed by
    /// it), which must still be held and not burned. Only `enc` / `epoch` are set, and any
    /// plaintext text an older client left is cleared ([`clear_plaintext`]). Unchanged text
    /// keeps the stored `enc`, so nothing is written.
    async fn private_edit(
        &self,
        repo: &RepoRef,
        kind: DocKind,
        stored: &FetchedDocument,
        changes: &BTreeMap<String, Option<FieldValue>>,
    ) -> Result<BTreeMap<String, Option<FieldValue>>> {
        let doc_type = kind.type_name();
        let kr = self.fresh_keyring(repo).await?;
        let opened = private::open_doc(kr.open(kind, stored), stored.clone()).ok_or_else(|| {
            Error::from(
                UserError::new(
                    codes::NOT_A_KEY_HOLDER,
                    format!(
                        "this {doc_type} cannot be read with your keys, so it cannot be edited"
                    ),
                )
                .fix(format!(
                    "`dg repo keys status {}` explains the keys you hold",
                    repo.display()
                )),
            )
        })?;
        // an empty value is no value, on either side
        let text: BTreeMap<String, Option<String>> = changes
            .iter()
            .map(|(k, v)| {
                let v = v
                    .as_ref()
                    .and_then(FieldValue::as_str)
                    .filter(|s| !s.is_empty());
                (k.clone(), v.map(str::to_owned))
            })
            .collect();
        if text
            .iter()
            .all(|(k, v)| opened.field_str(k).filter(|s| !s.is_empty()) == *v)
        {
            // already reads that way: the stored enc/epoch, which the replace sees as held
            return Ok(["enc", "epoch"]
                .into_iter()
                .map(|k| (k.to_string(), stored.fields.get(k).cloned()))
                .collect());
        }
        let writer = kr.writer(repo)?;
        let keys = if kind == DocKind::Patch {
            let epoch = stored
                .field_u64("epoch")
                .and_then(|e| u32::try_from(e).ok())
                .ok_or(Error::NotFound)?;
            patch_epoch_keys(&kr.resolution().burned, &writer, epoch)?
        } else {
            writer.write_keys()
        };
        let owner = platform::decode_identifier(&self.signer_id()?)?;
        let sealed = private::reseal_edit(keys, kind, owner, &opened, &text)?;
        Ok(clear_plaintext(kind, stored, sealed))
    }

    /// Refuse, before anything is signed, an edit of a document the signer does not own.
    fn require_author(&self, author: &str, action: &str) -> Result<()> {
        if self.signer_id()? == author {
            return Ok(());
        }
        Err(Error::NotPermitted {
            action: action.to_string(),
            reason: "you are not its author; consensus admits an edit from the author only".into(),
            needs: "owner".into(),
        })
    }

    // --- writes: comments, reviews ----------------------------------------------------------

    /// Comment on an issue or PR. Un-gated.
    pub async fn comment(
        &self,
        repo: &RepoRef,
        target_id: &str,
        body: &str,
        anchor: Option<&CommentAnchor>,
        imported: Option<&Imported>,
    ) -> Result<String> {
        let collab = self.collab_contract(repo).await?;
        // A reply names its thread's root ([`Self::thread_root`]).
        let mut anchor = anchor.cloned();
        if let Some(a) = &mut anchor {
            if let Some(parent) = &a.reply_to {
                a.reply_to = Some(self.thread_root(repo, &collab, target_id, parent).await?);
            }
        }
        let p = comment_props(target_id, body, anchor.as_ref(), imported)?;
        self.require_unlocked_or_member(repo, target_id).await?;
        let p = self.seal_if_private(repo, ContentKind::Comment, p).await?;
        self.write(repo, &collab, DOC_COMMENT, p).await
    }

    /// The root comment of the thread `comment_id` (a comment of `target_id`) belongs to: the
    /// comment itself when it is a root, else the root it replies to. A reply names a root
    /// (`replyTo.refersTo … where replyTo = noParent`), so one step always reaches it.
    pub async fn thread_root(
        &self,
        repo: &RepoRef,
        collab: &LoadedContract,
        target_id: &str,
        comment_id: &str,
    ) -> Result<String> {
        let parent = self
            .client
            .fetch_document(collab, DOC_COMMENT, comment_id)
            .await?
            .ok_or_else(|| {
                Error::Config(format!(
                    "comment {comment_id} does not exist (or was deleted)"
                ))
            })?;
        let same_thread = id_field(&parent, "targetId").as_deref() == Some(target_id)
            && id_field(&parent, "repoId").as_deref() == Some(repo.id());
        if !same_thread {
            return Err(Error::Config(format!(
                "comment {comment_id} is not on this issue or pull request"
            )));
        }
        let Some(root) = id_field(&parent, "replyTo") else {
            return Ok(parent.id);
        };
        if self
            .client
            .fetch_document(collab, DOC_COMMENT, &root)
            .await?
            .is_none()
        {
            return Err(Error::Config(format!(
                "the first comment of the thread of {comment_id} was deleted, so the thread takes \
                 no replies; post a new comment instead"
            )));
        }
        Ok(root)
    }

    /// Review a PR: `verdict` on `commit_oid` (the head a reviewer saw). Un-gated; only
    /// members' reviews count (§6).
    #[allow(clippy::too_many_arguments)]
    pub async fn review(
        &self,
        repo: &RepoRef,
        patch_id: &str,
        verdict: Verdict,
        commit_oid: &[u8],
        body: &str,
        comment_count: Option<u16>,
        imported: Option<&Imported>,
    ) -> Result<String> {
        let verdict = self.verdict_for(repo, verdict).await?;
        let p = review_props(patch_id, verdict, commit_oid, body, comment_count, imported)?;
        self.require_unlocked_or_member(repo, patch_id).await?;
        let p = self.seal_if_private(repo, ContentKind::Review, p).await?;
        let collab = self.collab_contract(repo).await?;
        self.write(repo, &collab, DOC_REVIEW, p).await
    }

    /// The code `verdict` is written as by the signer ([`Verdict::as_written_by`]): a member's
    /// approve / request changes is 1 / 2, anyone else's 4 / 5. This decides what a legal
    /// document looks like, not who may write it, so it holds with the pre-check off too.
    pub async fn verdict_for(&self, repo: &RepoRef, verdict: Verdict) -> Result<Verdict> {
        Ok(verdict.as_written_by(self.is_member(repo).await?))
    }

    /// Create one forge-collab document of `repo` exactly once across runs: the signed
    /// transition is handed to `persist` before its first broadcast, and `saved` (an earlier
    /// run's persisted transition, if any) is re-broadcast instead of signing a new one. A
    /// saved transition that provably never landed is dropped and a fresh one signed. Returns
    /// the document id. What a resumable batch (a pending review's submit) builds on.
    pub async fn create_once(
        &self,
        repo: &RepoRef,
        kind: ContentKind,
        props: BTreeMap<String, FieldValue>,
        saved: Option<&WriteIntent>,
        mut persist: impl FnMut(&WriteIntent) -> Result<()>,
    ) -> Result<String> {
        let doc_type = match kind {
            ContentKind::Comment => DOC_COMMENT,
            ContentKind::Review => DOC_REVIEW,
            other => {
                return Err(Error::Config(format!(
                    "create_once writes comments and reviews, not {other:?}"
                )))
            }
        };
        let collab = self.collab_contract(repo).await?;
        let engine = self.engine()?;
        if let Some(intent) = saved {
            if replay_landed(&engine, &collab, doc_type, intent).await? {
                return Ok(intent.document_id.clone());
            }
            tracing::warn!(
                document = %intent.document_id,
                "a saved write from an interrupted run never landed; signing it afresh"
            );
        }
        // Sealed only when signing afresh: a replay re-broadcasts the saved (sealed) bytes.
        let props = self.seal_if_private(repo, kind, props).await?;
        let prepared = self
            .create_stamped(repo, doc_type, Self::with_repo(repo, props)?, async |all| {
                engine
                    .create_journaled(&collab, doc_type, all, |p| {
                        persist(&WriteIntent::for_prepared(0, p))
                    })
                    .await
            })
            .await?;
        Ok(prepared.document_id().to_string())
    }

    // --- writes: events ------------------------------------------------------------------

    /// Post a member `event` (any kind but a state kind, which is a transition: see
    /// [`Self::set_state`]). Consensus admits it only from a current maintainer or writer; the
    /// client checks first unless [`SKIP_PRECHECK_ENV`] is set.
    pub async fn post_event(
        &self,
        repo: &RepoRef,
        target: &Target,
        kind: EventKind,
        value: Option<&str>,
        oid: Option<&[u8]>,
    ) -> Result<String> {
        let props = event_props(target, kind, value, oid)?;
        self.require_role(
            repo,
            Role::Writer,
            &format!(
                "{} {} #{}",
                kind_verb(kind),
                target.kind.noun(),
                target.number
            ),
        )
        .await?;
        let community = self.community_contract(repo).await?;
        self.write(repo, &community, DOC_EVENT, props).await
    }

    /// Carry out `action` (close, reopen, merge, draft, ready) on `target`: one `transition`
    /// whose kind, `delta` and `asAuthor` follow from the target's state code (read now, a
    /// proved sum) and who the signer is ([`state_actor`]: a member writes `asAuthor` 0, the
    /// target's author its number). A merge names its commit (`merge_oid`).
    ///
    /// Refused before anything is signed when there is no legal move ("it is already
    /// closed") or the signer is neither a member nor the author ([`Error::NotPermitted`]);
    /// with [`SKIP_PRECHECK_ENV`] set, the move is attempted anyway and consensus judges it.
    /// When consensus refuses it by a state rule (`c1`…`c5`: another client moved the target
    /// first) the state is read again and the error says what it is now.
    pub async fn set_state(
        &self,
        repo: &RepoRef,
        target: &Target,
        action: StateAction,
        merge_oid: Option<&[u8]>,
    ) -> Result<StateChange> {
        self.set_state_from(repo, target, action, merge_oid, None)
            .await
    }

    /// Write the transition `mv` on `target` as it is (the importer's primitive: it computed
    /// the move from the state code it read, as a member). No pre-check: consensus judges it,
    /// and a move the target's state no longer allows is refused before execution
    /// ([`Error::RuleRefused`] naming a `c*` rule).
    pub async fn write_transition(
        &self,
        repo: &RepoRef,
        target: &Target,
        mv: &TransitionMove,
        merge_oid: Option<&[u8]>,
    ) -> Result<String> {
        let props = transition_props(target, mv, merge_oid)?;
        let collab = self.collab_contract(repo).await?;
        self.write(repo, &collab, DOC_TRANSITION, props).await
    }

    /// [`Self::set_state`] from a state code the caller already knows (`None`: read it).
    async fn set_state_from(
        &self,
        repo: &RepoRef,
        target: &Target,
        action: StateAction,
        merge_oid: Option<&[u8]>,
        known_code: Option<i64>,
    ) -> Result<StateChange> {
        let me = self.signer_id()?;
        let role = self.signer_role(repo).await?;
        let mut actor = state_actor(role, &me, target);
        if actor == Actor::Other && !precheck_enabled() {
            // judged by consensus (the e2e suite proves the gate this way)
            actor = Actor::Member;
        }
        let code = match known_code {
            Some(c) => c,
            None => self.state_sum(repo, &target.id).await?,
        };
        let route = match actor {
            Actor::Author => StateRoute::Author,
            _ => StateRoute::Member,
        };
        let tt = target.kind.transition_target();
        let (mv, forced) = match next_transition(tt, code, action, actor, target.number) {
            Some(mv) => (mv, false),
            // With the pre-check off, the move is attempted from the state it is legal from,
            // without the actor gate, and consensus judges it (the e2e suite proves the rules
            // this way).
            None if !precheck_enabled() => (
                forced_move(tt, action, actor, target.number)
                    .ok_or_else(|| no_move(target, code, action, actor))?,
                true,
            ),
            None => return Err(no_move(target, code, action, actor)),
        };
        let props = transition_props(target, &mv, merge_oid)?;
        let collab = self.collab_contract(repo).await?;
        match self.write(repo, &collab, DOC_TRANSITION, props).await {
            Ok(transition_id) => Ok(StateChange {
                route,
                transition_id,
                kind: mv.kind,
                after: mv.after,
            }),
            Err(e) if is_state_rule_refusal(&e) => {
                let now = self.state_sum(repo, &target.id).await.unwrap_or(code);
                // A move attempted though it was known illegal, or one whose target has not
                // moved since the read: the rule refused this move itself, not a race.
                let cause = if forced || now == code {
                    format!("consensus refused it ({e})")
                } else {
                    format!("another change landed first; consensus refused this one ({e})")
                };
                Err(UserError::new(
                    codes::REJECTED,
                    format!(
                        "cannot {} {} #{}: it is {} now",
                        action_verb(action),
                        target.kind.noun(),
                        target.number,
                        state_words(target.kind, now)
                    ),
                )
                .cause(cause)
                .note("refused before execution: nothing was written")
                .into())
            }
            Err(e) => Err(e),
        }
    }

    /// Post a PR/issue event of any kind through whichever gate admits the signer
    /// ([`kind_route`]): a member's `event`, else — for an author kind — the author's
    /// `authorEvent`. Review kinds: resolve / unresolve a thread (`ref_id` = its root comment),
    /// request / unrequest a reviewer (`ref_id` = the identity), dismiss a review (members;
    /// `ref_id` = the review, `value` = the reason), move the head (`oid`), set / clear a
    /// milestone (members). [`Error::NotPermitted`] before signing when no gate admits the
    /// signer (unless [`SKIP_PRECHECK_ENV`] is set: then a member event is attempted).
    pub async fn post_target_event(
        &self,
        repo: &RepoRef,
        target: &Target,
        kind: EventKind,
        payload: &EventPayload<'_>,
    ) -> Result<(StateRoute, String)> {
        let props = event_payload_props(target, kind, payload)?;
        let me = self.signer_id()?;
        let role = self.signer_role(repo).await?;
        let route = match kind_route(role, &me, target, kind) {
            Some(r) => r,
            None if !precheck_enabled() => StateRoute::Member,
            None => {
                return Err(Error::NotPermitted {
                    action: format!(
                        "{} {} #{}",
                        kind_verb(kind),
                        target.kind.noun(),
                        target.number
                    ),
                    reason: if is_author_kind(kind) {
                        format!(
                            "you are neither a member of {} nor the {}'s author",
                            repo.display(),
                            target.kind.noun()
                        )
                    } else {
                        format!("you are not a member of {}", repo.display())
                    },
                    needs: "writer".into(),
                })
            }
        };
        let doc_type = match route {
            StateRoute::Member => DOC_EVENT,
            StateRoute::Author => DOC_AUTHOR_EVENT,
        };
        let community = self.community_contract(repo).await?;
        let id = self.write(repo, &community, doc_type, props).await?;
        Ok((route, id))
    }

    /// Set the branch policy (maintainers only at consensus; the client checks first unless
    /// [`SKIP_PRECHECK_ENV`] is set). Policies are append-only; the newest wins.
    pub async fn set_policy(&self, repo: &RepoRef, policy: &Policy) -> Result<String> {
        let props = policy_props(policy)?;
        self.require_role(repo, Role::Maintainer, "set the branch policy")
            .await?;
        let community = self.community_contract(repo).await?;
        self.write(repo, &community, DOC_POLICY, props).await
    }

    // --- releases and labels (forge-core) ---------------------------------------------------

    /// Publish (or supersede) a release. Maintainer-only at consensus.
    ///
    /// RC1 `release_ledger`: the revision carries `delta` +1 when it publishes a tag that is not
    /// live, and 0 when it edits (or yanks) a live one ([`release_delta`]); the contract's
    /// `oneLive` rule refuses anything else, so a concurrent publish of the same tag loses.
    ///
    /// A private repository's release is sealed ([`Self::create_release_stored`]); one with
    /// new files needs a store, so this refuses it.
    pub async fn create_release(&self, repo: &RepoRef, input: &ReleaseInput) -> Result<String> {
        Ok(self
            .create_release_stored(repo, input, None)
            .await?
            .document_id)
    }

    /// [`Self::create_release`], storing a private repository's new files in `store`.
    ///
    /// A private repository's revision is sealed (`private-repos.md` §16) under the write
    /// epoch of keys read now. The tag's newest revision is carried forward (§16.3). New files
    /// and a new asset list are sealed and stored first, as a kind-4 `packManifest`; if a final
    /// re-read of the anchors finds the epoch moved meanwhile, they are sealed and stored again
    /// under the new one (§16.5). The revision has `delta` 0, so consensus no longer keeps one
    /// live release per tag: the tag is read again after the write, and
    /// [`ReleaseWritten::warning`] says when this revision is not its newest.
    pub async fn create_release_stored(
        &self,
        repo: &RepoRef,
        input: &ReleaseInput,
        store: Option<&ReleaseStore<'_>>,
    ) -> Result<ReleaseWritten> {
        if repo.visibility == Visibility::Private {
            return self.create_sealed_release(repo, input, store).await;
        }
        Ok(ReleaseWritten {
            document_id: self.create_public_release(repo, input).await?,
            ..ReleaseWritten::default()
        })
    }

    async fn create_public_release(&self, repo: &RepoRef, input: &ReleaseInput) -> Result<String> {
        if !input.files.is_empty()
            || input.prerelease.is_some()
            || input.draft.is_some()
            || input.unpublished
        {
            return Err(Error::Config(
                "files to seal, and the draft, pre-release and unpublish flags, are for a \
                 private repository's sealed release"
                    .into(),
            ));
        }
        check_tag_name(&input.tag_name)?;
        check_text("release name", &input.name, 120, 480)?;
        check_text("release notes", &input.notes, 5120, 5120)?;
        let mut p = BTreeMap::new();
        p.insert("tagName".to_string(), FieldValue::text(&input.tag_name));
        if !input.name.is_empty() {
            p.insert("name".to_string(), FieldValue::text(&input.name));
        }
        if !input.notes.is_empty() {
            p.insert("notes".to_string(), FieldValue::text(&input.notes));
        }
        p.insert("yanked".to_string(), FieldValue::boolean(input.yanked));
        if !input.assets.is_empty() {
            let json = serde_json::to_string(&input.assets)?;
            if json.len() > 4096 {
                return Err(Error::Config(format!(
                    "the release's asset list is {} bytes as JSON; the contract holds 4096 \
                     (fewer assets, or shorter names and URLs)",
                    json.len()
                )));
            }
            p.insert("assets".to_string(), FieldValue::text(json));
        }
        self.require_role(
            repo,
            Role::Maintainer,
            &format!("publish release {}", input.tag_name),
        )
        .await?;
        let core = self.core_contract(repo).await?;
        // The tag's revisions, read now: whether this one publishes or edits.
        let revisions = self
            .client
            .query_all_documents(
                &core,
                DOC_RELEASE,
                &[
                    Self::repo_filter(repo)?,
                    QueryFilter::eq("tagName", FieldValue::text(&input.tag_name)),
                ],
                &[QueryOrder::asc("$createdAt")],
            )
            .await?;
        let live = tag_is_live(revisions.iter().map(|d| release_from_doc(d).delta));
        crate::layout::stamp_vis(&mut p, repo.visibility);
        let with_delta = |live: bool| {
            let mut p = p.clone();
            p.insert("delta".to_string(), FieldValue::signed(release_delta(live)));
            p
        };
        match self.write(repo, &core, DOC_RELEASE, with_delta(live)).await {
            // The node that answered the read had not seen the tag's newest revision (a
            // publish, or another client's unpublish): `oneLive` refused the delta it implied,
            // which proves the other one. Nothing was written; retry once with it.
            Err(Error::RuleRefused { rule, .. }) if rule == ONE_LIVE_RULE => {
                self.write(repo, &core, DOC_RELEASE, with_delta(!live))
                    .await
            }
            other => other,
        }
    }

    /// A private repository's release revision (§16): see [`Self::create_release_stored`].
    async fn create_sealed_release(
        &self,
        repo: &RepoRef,
        input: &ReleaseInput,
        store: Option<&ReleaseStore<'_>>,
    ) -> Result<ReleaseWritten> {
        use crate::private::release::{self, ReleaseFields};
        let tag = &input.tag_name;
        check_tag_name(tag)?;
        check_text("release name", &input.name, 120, 480)?;
        check_text("release notes", &input.notes, 5120, 5120)?;
        if !input.assets.is_empty() {
            return Err(Error::Config(
                "a private repository's assets are sealed files, never plaintext entries".into(),
            ));
        }
        self.require_role(repo, Role::Maintainer, &format!("publish release {tag}"))
            .await?;
        let owner = platform::decode_identifier(&self.signer_id()?)?;
        // Every revision of the tag, read now from the `created` listing (§16.3): what this
        // one does not change is carried forward from the newest readable one.
        let before = self.releases(repo).await?;
        let carried = newest_revision(&before, tag)
            .and_then(|r| r.sealed.as_ref())
            .map(|s| s.fields.clone())
            .unwrap_or_default();
        // New files or notes build a new asset list from the previous one; anything else
        // keeps naming it, unopened.
        let rebuild = !input.files.is_empty() || !input.notes.is_empty();
        let prev_manifest = match &carried.asset_manifest {
            Some(_) if rebuild => Some(self.release_manifest(repo, &carried).await?),
            _ => None,
        };
        let mut fields = ReleaseFields {
            tag: tag.clone(),
            name: non_empty(&input.name).or(carried.name.clone()),
            target_oid: carried.target_oid.clone(),
            imported_author: carried.imported_author.clone(),
            imported_url: carried.imported_url.clone(),
            imported_created_at: carried.imported_created_at,
            prerelease: input.prerelease.unwrap_or(carried.prerelease),
            draft: input.draft.unwrap_or(carried.draft),
            yanked: input.yanked,
            unpublished: input.unpublished,
            // an edit of nothing but the name or the flags keeps the notes and the list as
            // they are: the same prefix, flag and manifest
            notes: carried.notes.clone(),
            notes_continue: carried.notes_continue,
            asset_manifest: carried.asset_manifest.clone(),
        };
        // the full notes, as the new revision states them
        let full_notes = match (non_empty(&input.notes), &prev_manifest) {
            (Some(n), _) => n,
            (None, Some(m)) if carried.notes_continue => m.notes.clone().unwrap_or_default(),
            (None, _) => carried.notes.clone().unwrap_or_default(),
        };
        let mut sealed_assets = Vec::new();
        let mut attempts = 0;
        let (keys, epoch) = loop {
            attempts += 1;
            // the write epoch of keys read now (§5.3)
            let w = self.fresh_keyring(repo).await?.writer(repo)?;
            if !rebuild {
                break (w.write_keys().clone(), w.write_epoch());
            }
            (fields, sealed_assets) = self
                .rebuild_asset_list(
                    repo,
                    w.write_keys(),
                    RebuildFrom {
                        fields: fields.clone(),
                        notes: &full_notes,
                        files: &input.files,
                        prev: prev_manifest.as_ref(),
                    },
                    store,
                )
                .await?;
            // The final anchor re-read before signing (§5.3, §16.5): a rotation during the
            // upload would leave the new artifacts readable to the member it removed.
            let now = self.fresh_keyring(repo).await?.writer(repo)?;
            if now.write_epoch() == w.write_epoch() {
                break (now.write_keys().clone(), now.write_epoch());
            }
            if attempts >= 2 {
                return Err(Error::Config(format!(
                    "release {tag} not written: the key epoch of {} moved twice while its \
                     assets were uploaded; run the command again",
                    repo.display()
                )));
            }
        };
        let (tag_name, enc) = release::seal(&keys, &owner, &fields).map_err(|e| match e {
            crate::private::PrivateError::TooLarge(..) => Error::Config(format!(
                "release {tag} not written: a private release holds 1507 bytes of tag, name, \
                 notes preview and provenance, and this one does not fit (a shorter name)"
            )),
            other => other.into(),
        })?;
        let core = self.core_contract(repo).await?;
        // delta 0 always (`oneLive`): there is no ledger to retry against (§16.3)
        let document_id = self
            .write(
                repo,
                &core,
                DOC_RELEASE,
                sealed_release_props(&tag_name, epoch, enc),
            )
            .await?;
        let after = self.releases(repo).await?;
        Ok(ReleaseWritten {
            warning: not_newest_warning(&after, tag, &document_id),
            document_id,
            sealed_assets,
        })
    }

    /// A revision's new asset list under `keys` (§16.5): the previous list's assets but those a
    /// new file replaces, then the new files sealed and stored, and the full notes when they
    /// do not fit `enc`. Returns the fields with their notes fitted and TLV 21 set (none when
    /// there is no asset and nothing continues), and the list's entries.
    async fn rebuild_asset_list(
        &self,
        repo: &RepoRef,
        keys: &crate::private::EpochKeys,
        from: RebuildFrom<'_>,
        store: Option<&ReleaseStore<'_>>,
    ) -> Result<(
        crate::private::release::ReleaseFields,
        Vec<crate::private::release::ManifestAsset>,
    )> {
        use crate::private::release::{self, ReleaseFields, ReleaseManifest};
        let mut assets = from.prev.map(|m| m.assets.clone()).unwrap_or_default();
        assets.retain(|a| !from.files.iter().any(|f| f.name == a.name));
        assets.extend(self.seal_release_files(keys, from.files, store).await?);
        let (mut fields, notes_continue) = release::fit_notes(
            ReleaseFields {
                asset_manifest: None,
                ..from.fields
            },
            from.notes,
        );
        fields.asset_manifest = if assets.is_empty() && !notes_continue {
            None
        } else {
            let manifest = ReleaseManifest {
                v: 1,
                tag: fields.tag.clone(),
                total: assets.len() as u64,
                source: from.prev.and_then(|m| m.source.clone()),
                notes: notes_continue.then(|| from.notes.to_string()),
                assets: assets.clone(),
            };
            let hash = self
                .store_release_manifest(repo, keys, &manifest, notes_continue, store)
                .await?;
            Some(hex::encode(hash))
        };
        Ok((fields, assets))
    }

    /// Seal each of `files` under `keys` and store it, as manifest entries (§16.5): the
    /// plaintext's `sha256` and size, and the sealed object's, which also names it in storage
    /// (never the plaintext hash).
    async fn seal_release_files(
        &self,
        keys: &crate::private::EpochKeys,
        files: &[ReleaseFile],
        store: Option<&ReleaseStore<'_>>,
    ) -> Result<Vec<crate::private::release::ManifestAsset>> {
        let mut out = Vec::new();
        for f in files {
            let sealed = crate::private::pack::seal(keys, &f.bytes)?;
            let uris = store_sealed(store, &sealed, &f.name).await?.uris();
            out.push(crate::private::release::ManifestAsset {
                name: f.name.clone(),
                sha256: hex::encode(sha256(&f.bytes)),
                size_bytes: f.bytes.len() as u64,
                uris: asset_uris(uris),
                sealed_sha256: Some(hex::encode(sha256(&sealed))),
                sealed_size_bytes: Some(sealed.len() as u64),
            });
        }
        Ok(out)
    }

    /// Seal `manifest` under `keys`, store it, and record it as a kind-4 `packManifest` that
    /// publishes nothing about the list (`objectCount` 0, no `tips`, no `supersedes`, §16.5).
    /// Returns its `packHash`.
    async fn store_release_manifest(
        &self,
        repo: &RepoRef,
        keys: &crate::private::EpochKeys,
        manifest: &crate::private::release::ReleaseManifest,
        notes_continue: bool,
        store: Option<&ReleaseStore<'_>>,
    ) -> Result<[u8; 32]> {
        let sealed = crate::private::release::seal_manifest(keys, manifest, notes_continue)?;
        let rep = store_sealed(store, &sealed, "the release's asset list").await?;
        let stored = crate::repo::StoredArtifact::from_replication(&rep, &sealed)?;
        let pack_hash = sha256(&sealed);
        self.repo_service()?
            .write_pack_manifest(repo, &release_manifest_input(pack_hash, &sealed, stored))
            .await?;
        Ok(pack_hash)
    }

    /// The kind-4 asset list a sealed revision names (§16.5): the size cap before anything is
    /// fetched, then each copy by the reader rule, its hash against TLV 21, §3.5 under the key
    /// of its header's epoch, and the canonical and per-key checks.
    pub async fn release_manifest(
        &self,
        repo: &RepoRef,
        fields: &crate::private::release::ReleaseFields,
    ) -> Result<crate::private::release::ReleaseManifest> {
        use crate::private::release::{open_manifest, ManifestError, MAX_MANIFEST_BYTES};
        let hash = fields
            .asset_manifest_hash()
            .ok_or_else(|| Error::Config(format!("release {} has no asset list", fields.tag)))?;
        let kr = self.keyring(repo).await?;
        let svc = self.repo_service()?;
        let copies: Vec<_> = svc
            .read_pack_copies(repo, hash)
            .await?
            .into_iter()
            .filter(|m| m.kind == u64::from(crate::pack::KIND_RELEASE_ASSETS))
            .collect();
        let unavailable = |why: String| {
            UserError::new(
                codes::SEALED_PACK_CORRUPT,
                format!("the asset list of release {} is unavailable", fields.tag),
            )
            .cause(why)
            .into()
        };
        let reader = crate::storage::PackReader::from_user_config();
        let mut last = format!("no copy of asset list {} is recorded", hex::encode(hash));
        for copy in copies {
            if copy.size_bytes > MAX_MANIFEST_BYTES {
                last = format!(
                    "a copy claims {} bytes, over the 1 MiB cap",
                    copy.size_bytes
                );
                continue;
            }
            let sealed = match svc.fetch_artifact(repo, &copy, &reader).await {
                Ok(b) => b,
                Err(e) => {
                    last = e.to_string();
                    continue;
                }
            };
            match open_manifest(
                &sealed,
                copy.size_bytes,
                &hash,
                &fields.tag,
                fields.notes_continue,
                |e| kr.epoch_keys(e),
            ) {
                Ok(m) => return Ok(m),
                Err(ManifestError::Mismatch) => {
                    last = "the asset list does not match the release that names it".into();
                }
                Err(ManifestError::Pack(e)) => last = e.to_string(),
            }
        }
        Err(unavailable(last))
    }

    /// A sealed asset's file from its stored `sealed` bytes (already checked against
    /// `sealedSha256`): opened, truncated to its size and checked against its `sha256` (§16.5).
    pub async fn open_release_asset(
        &self,
        repo: &RepoRef,
        entry: &crate::private::release::ManifestAsset,
        sealed: &[u8],
    ) -> Result<Vec<u8>> {
        let kr = self.keyring(repo).await?;
        crate::private::release::open_asset(sealed, entry, |e| kr.epoch_keys(e))
            .map_err(|e| crate::keyring::sealed_error(&e))
    }

    /// The pack-manifest service for this signer, sharing this `Collab`'s keyring.
    fn repo_service(&self) -> Result<crate::repo::RepoService<'a>> {
        let (identity, bridge) = self.signer.ok_or_else(|| {
            Error::from(crate::user_error::private_needs_identity("the repository"))
        })?;
        Ok(crate::repo::RepoService::with_keyring(
            self.client,
            identity,
            bridge,
            Arc::clone(&self.keyring),
        ))
    }

    /// Every release of `repo`: the newest revision of each tag not unpublished (see
    /// [`newest_per_tag`]), in [`release_order`]; `previous` holds the other revisions, an
    /// unpublished tag's included, newest first.
    ///
    /// A private repository's revisions are opened and folded per §16.3 ([`sealed_releases`]),
    /// and need a member's keys: a reader without them gets the keyring's error, never a list
    /// of tags named by their hash. Every read lists the repository through `created`
    /// (`repoId, $createdAt`) and filters locally: nothing queries a keyed `tagName`.
    pub async fn releases(&self, repo: &RepoRef) -> Result<ReleaseList> {
        let keys = self.private_keys(repo).await?;
        let core = self.core_contract(repo).await?;
        let docs = self
            .client
            .query_all_documents(
                &core,
                DOC_RELEASE,
                &[Self::repo_filter(repo)?],
                &[QueryOrder::asc("$createdAt")],
            )
            .await?;
        if let Some(kr) = keys {
            return Ok(sealed_releases(&docs, |d| kr.open_release(d)));
        }
        // a public reader holds no key: a revision carrying `enc` is malformed (§16.2)
        let (plain, sealed): (Vec<_>, Vec<_>) = docs
            .iter()
            .partition(|d| well_formed(ContentKind::Release, d, repo.visibility));
        let (current, previous) = newest_per_tag(plain.into_iter().map(release_from_doc).collect());
        Ok(ReleaseList {
            current,
            previous,
            hidden: sealed.len(),
            ..ReleaseList::default()
        })
    }

    /// Define (or supersede) a label. Member-gated.
    pub async fn create_label(
        &self,
        repo: &RepoRef,
        name: &str,
        color: &str,
        description: &str,
        retired: bool,
    ) -> Result<String> {
        if name.is_empty() {
            return Err(Error::Config("a label needs a name".into()));
        }
        check_len("label name", name, 30)?;
        check_len("label description", description, 200)?;
        if !color.is_empty() && !is_hex_color(color) {
            return Err(Error::Config(format!(
                "label color {color:?} must look like #1f883d"
            )));
        }
        let mut p = BTreeMap::new();
        p.insert("name".to_string(), FieldValue::text(name));
        if !color.is_empty() {
            p.insert("color".to_string(), FieldValue::text(color));
        }
        if !description.is_empty() {
            p.insert("description".to_string(), FieldValue::text(description));
        }
        p.insert("retired".to_string(), FieldValue::boolean(retired));
        self.require_role(repo, Role::Writer, &format!("define label {name}"))
            .await?;
        let core = self.core_contract(repo).await?;
        self.write(repo, &core, DOC_LABEL, p).await
    }

    /// Delete label `name`. A `label` document is deletable by its owner only, so: when every
    /// definition of the name is the signer's, delete them all (the label is gone); otherwise
    /// write a retirement first (the newest definition wins, so readers stop offering it) and
    /// delete the signer's older definitions, keeping that retirement. Applied labels (events)
    /// are history and stay. Returns `(retired, deleted documents)`; `(false, 0)` when there is
    /// no such label.
    pub async fn delete_label(&self, repo: &RepoRef, name: &str) -> Result<(bool, usize)> {
        let me = self.signer_id()?;
        let core = self.core_contract(repo).await?;
        let docs = self.label_docs(repo, name).await?;
        if docs.is_empty() {
            return Ok((false, 0));
        }
        let all_mine = docs.iter().all(|d| d.owner_id == me);
        if !all_mine {
            self.create_label(repo, name, "", "", true).await?;
        }
        let engine = self.engine()?;
        let mut n = 0;
        for d in docs.iter().filter(|d| d.owner_id == me) {
            engine.delete_document(&core, DOC_LABEL, &d.id).await?;
            n += 1;
        }
        Ok((!all_mine, n))
    }

    /// Every definition document of label `name` in `repo`, oldest first.
    async fn label_docs(&self, repo: &RepoRef, name: &str) -> Result<Vec<FetchedDocument>> {
        let core = self.core_contract(repo).await?;
        self.client
            .query_all_documents(
                &core,
                DOC_LABEL,
                &[
                    Self::repo_filter(repo)?,
                    QueryFilter::eq("name", FieldValue::text(name)),
                ],
                &[QueryOrder::asc("name"), QueryOrder::asc("$createdAt")],
            )
            .await
    }

    /// Assign or unassign `assignee` (base58) on `target`: a member `event` (kinds 6/7) with the
    /// identity as `value` (what the fold reads) and as `refId`, so the sparse `addressee
    /// (refId)` index answers "assigned to me" (platform-parity-spec §1.2). Members only.
    pub async fn set_assignee(
        &self,
        repo: &RepoRef,
        target: &Target,
        assignee: &str,
        assign: bool,
    ) -> Result<String> {
        platform::decode_identifier(assignee)?;
        let kind = if assign {
            EventKind::Assign
        } else {
            EventKind::Unassign
        };
        let props = event_payload_props(
            target,
            kind,
            &EventPayload {
                value: Some(assignee),
                oid: None,
                ref_id: Some(assignee),
            },
        )?;
        self.require_role(
            repo,
            Role::Writer,
            &format!(
                "{} {} #{}",
                kind_verb(kind),
                target.kind.noun(),
                target.number
            ),
        )
        .await?;
        let community = self.community_contract(repo).await?;
        self.write(repo, &community, DOC_EVENT, props).await
    }

    /// Every label of `repo`, newest definition per name.
    pub async fn labels(&self, repo: &RepoRef) -> Result<Vec<Label>> {
        let core = self.core_contract(repo).await?;
        let docs = self
            .client
            .query_all_documents(
                &core,
                DOC_LABEL,
                &[Self::repo_filter(repo)?],
                &[QueryOrder::asc("name"), QueryOrder::asc("$createdAt")],
            )
            .await?;
        let mut newest: BTreeMap<String, Label> = BTreeMap::new();
        for l in docs.iter().map(label_from_doc) {
            let replace = newest
                .get(&l.name)
                .is_none_or(|e| (l.created_at, &l.document_id) > (e.created_at, &e.document_id));
            if replace {
                newest.insert(l.name.clone(), l);
            }
        }
        Ok(newest.into_values().collect())
    }

    // --- stars (indexOnly) -----------------------------------------------------------------

    /// The star count of `repo` (the countable `byRepo` index).
    pub async fn star_count(&self, repo: &RepoRef) -> Result<u64> {
        let community = self.community_contract(repo).await?;
        self.client
            .count_documents(&community, DOC_STAR, &[Self::repo_filter(repo)?])
            .await
    }

    /// The signer's own row of an indexOnly `doc_type` keyed by repo (`star`, `starBeat`,
    /// `watch`): its `byOwner` index, `repoId` the terminal.
    pub(super) async fn own_index_only(
        &self,
        collab: &LoadedContract,
        repo: &RepoRef,
        doc_type: &str,
    ) -> Result<Option<FetchedDocument>> {
        let me = platform::decode_identifier(&self.signer_id()?)?;
        let docs = self
            .client
            .query_documents(
                collab,
                doc_type,
                &[
                    QueryFilter::eq("$ownerId", FieldValue::identifier(me)),
                    Self::repo_filter(repo)?,
                ],
                &[],
                1,
                None,
            )
            .await?;
        Ok(docs.into_iter().next())
    }

    /// Create the signer's row of an indexOnly `doc_type` for `repo`, unless it exists.
    /// `false` when it did (or a concurrent write won: one row per identity and repo is
    /// structural). indexOnly: no stored row, so a spent nonce is settled by looking for the
    /// signer's row, not by reading a document id back.
    pub(super) async fn create_own_index_only(
        &self,
        collab: &LoadedContract,
        repo: &RepoRef,
        doc_type: &str,
        props: BTreeMap<String, FieldValue>,
    ) -> Result<bool> {
        if self.own_index_only(collab, repo, doc_type).await?.is_some() {
            return Ok(false);
        }
        let probe = || async { Ok(self.own_index_only(collab, repo, doc_type).await?.is_some()) };
        let mut props = Self::with_repo(repo, props)?;
        crate::layout::stamp_vis_for(doc_type, &mut props, repo.visibility);
        match self
            .engine()?
            .create_index_only(collab, doc_type, props, probe)
            .await
        {
            Ok(_) => Ok(true),
            Err(Error::DuplicateUniqueIndex(_)) => Ok(false),
            Err(e) => Err(e),
        }
    }

    async fn own_star(
        &self,
        community: &LoadedContract,
        repo: &RepoRef,
    ) -> Result<Option<FetchedDocument>> {
        self.own_index_only(community, repo, DOC_STAR).await
    }

    /// Whether the signer has starred `repo`.
    pub async fn is_starred(&self, repo: &RepoRef) -> Result<bool> {
        let community = self.community_contract(repo).await?;
        Ok(self.own_star(&community, repo).await?.is_some())
    }

    /// Star `repo`; with `trending`, a new star also counts toward Trending (a `starBeat`,
    /// once per identity and repo, platform-parity-spec §4.3). Returns `false` when it was
    /// already starred (nothing written, no beat either).
    pub async fn star(&self, repo: &RepoRef, trending: bool) -> Result<bool> {
        let community = self.community_contract(repo).await?;
        let starred = self
            .create_own_index_only(&community, repo, DOC_STAR, BTreeMap::new())
            .await?;
        if starred && trending && beats(repo, &self.signer_id()?) {
            // The star stands whatever happens to the beat, which only feeds a ranking. A beat
            // from an earlier star of this repo makes this a no-op (one per identity and repo,
            // ever: it cannot be deleted).
            let owner = FieldValue::identifier(platform::decode_identifier(repo.owner_id())?);
            let beat = BTreeMap::from([("repoOwner".to_string(), owner)]);
            if let Err(e) = self
                .create_own_index_only(&community, repo, DOC_STAR_BEAT, beat)
                .await
            {
                tracing::warn!(error = %e, "the star landed; its Trending beat did not");
            }
        }
        Ok(starred)
    }

    /// Unstar `repo` (the values-carrying `indexOnly` delete). Returns `false` when it was
    /// not starred.
    pub async fn unstar(&self, repo: &RepoRef) -> Result<bool> {
        let community = self.community_contract(repo).await?;
        self.delete_own_index_only(&community, repo, DOC_STAR).await
    }

    /// Delete the signer's row of an indexOnly `doc_type` for `repo` (the values-carrying
    /// delete). `false` when there was none, or another process deleted it first.
    pub(super) async fn delete_own_index_only(
        &self,
        collab: &LoadedContract,
        repo: &RepoRef,
        doc_type: &str,
    ) -> Result<bool> {
        let Some(row) = self.own_index_only(collab, repo, doc_type).await? else {
            return Ok(false);
        };
        let engine = self.engine()?;
        for _ in 0..2 {
            let values = Self::with_repo(repo, BTreeMap::new())?;
            match engine
                .delete_with_values(collab, doc_type, &row.id, values, None)
                .await
            {
                Ok(BroadcastOutcome::NonceConsumed) => {
                    // Our delete landed earlier, or another write by this identity took the
                    // nonce: the row's presence says which.
                    if self.own_index_only(collab, repo, doc_type).await?.is_none() {
                        return Ok(true);
                    }
                    tracing::debug!(
                        doc_type,
                        "another write took the delete's nonce; re-preparing"
                    );
                }
                Ok(_) => return Ok(true),
                Err(Error::NotFound) => return Ok(false),
                Err(e) => return Err(e),
            }
        }
        Err(Error::Nonce)
    }
}

fn kind_verb(kind: EventKind) -> &'static str {
    match kind {
        EventKind::Close => "close",
        EventKind::Reopen => "reopen",
        EventKind::Merge => "merge",
        EventKind::LabelAdd => "label",
        EventKind::LabelRemove => "unlabel",
        EventKind::Assign => "assign",
        EventKind::Unassign => "unassign",
        EventKind::Retarget => "retarget",
        EventKind::Draft => "mark draft",
        EventKind::Ready => "mark ready",
        EventKind::ThreadResolve => "resolve a thread on",
        EventKind::ThreadUnresolve => "unresolve a thread on",
        EventKind::ReviewRequest => "request a review on",
        EventKind::ReviewRequestRemove => "remove a review request on",
        EventKind::ReviewDismiss => "dismiss a review on",
        EventKind::HeadUpdate => "move the head of",
        EventKind::MilestoneSet => "set the milestone of",
        EventKind::MilestoneClear => "clear the milestone of",
        EventKind::Pin => "pin",
        EventKind::Unpin => "unpin",
        EventKind::Lock => "lock",
        EventKind::Unlock => "unlock",
    }
}

fn is_hex_color(c: &str) -> bool {
    c.len() == 7 && c.starts_with('#') && c[1..].bytes().all(|b| b.is_ascii_hexdigit())
}

/// A tag's version: its numeric dot-separated parts from the first digit on, and the
/// pre-release suffix after them (`v24.0.0-rc.1` → `[24, 0, 0]`, `rc.1`). `None` when the tag
/// holds no number. Parity: forge-web `tagVersion`.
pub fn tag_version(tag: &str) -> Option<(Vec<u64>, String)> {
    // The version is the `digits(.digits)*` run starting at the tag's first digit (`jq-1.7.1`
    // → `1.7.1`); whatever follows it is the pre-release suffix.
    let start = tag.find(|c: char| c.is_ascii_digit())?;
    let rest = &tag[start..];
    let mut end = 0;
    let bytes = rest.as_bytes();
    while end < bytes.len()
        && (bytes[end].is_ascii_digit()
            || (bytes[end] == b'.' && bytes.get(end + 1).is_some_and(u8::is_ascii_digit)))
    {
        end += 1;
    }
    let parts = rest[..end]
        .split('.')
        .map(|p| p.parse::<u64>().unwrap_or(u64::MAX))
        .collect();
    let suffix = &rest[end..];
    let suffix = suffix.split('+').next().unwrap_or_default();
    let pre = suffix
        .strip_prefix(['-', '.'])
        .unwrap_or(suffix)
        .to_string();
    Some((parts, pre))
}

/// Whether `tag` names a pre-release (`-rc.1`, `-beta`, …).
pub fn is_prerelease(tag: &str) -> bool {
    tag_version(tag).is_some_and(|(_, pre)| !pre.is_empty())
}

/// The releases' order (L-14): tags with a version, highest first (a release above its
/// pre-releases); then the rest, newest first. A mirror writes a repo's whole release history
/// in one run, so `$createdAt` says when a release was mirrored, not published. Parity:
/// forge-web `releaseOrder`.
pub fn release_order(a: &Release, b: &Release) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    let newest = || newest_first(a, b);
    match (tag_version(&a.tag_name), tag_version(&b.tag_name)) {
        (Some((pa, ra)), Some((pb, rb))) => {
            let len = pa.len().max(pb.len());
            let at = |p: &[u64], i: usize| p.get(i).copied().unwrap_or(0);
            (0..len)
                .map(|i| at(&pb, i).cmp(&at(&pa, i)))
                .find(|o| o.is_ne())
                .unwrap_or(Ordering::Equal)
                .then_with(|| match (ra.is_empty(), rb.is_empty()) {
                    (true, true) => Ordering::Equal,
                    (true, false) => Ordering::Less,
                    (false, true) => Ordering::Greater,
                    (false, false) => natural(&rb, &ra),
                })
                .then_with(newest)
        }
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => newest(),
    }
}

/// One run of a pre-release suffix: a number, or lower-cased text (separators dropped).
#[derive(Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Run {
    /// Digits, compared as a number; a number sorts before text (`1` < `beta`).
    Num(u64),
    /// Letters and anything else but `.`/`-`/`_`, compared lower-cased (`RC` = `rc`).
    Text(String),
}

/// `a` vs `b` by their runs ([`Run`]), so `rc.10` > `rc.9`, `rc.1` = `rc1`, `RC1` = `rc1`.
/// Parity: forge-web `naturalRuns`.
fn natural(a: &str, b: &str) -> std::cmp::Ordering {
    let runs = |s: &str| {
        let mut out = Vec::new();
        let mut rest = s;
        while let Some(c) = rest.chars().next() {
            let digit = c.is_ascii_digit();
            let n = rest
                .find(|x: char| x.is_ascii_digit() != digit || matches!(x, '.' | '-' | '_'))
                .unwrap_or(rest.len());
            if n == 0 {
                rest = &rest[c.len_utf8()..]; // a separator
                continue;
            }
            out.push(if digit {
                Run::Num(rest[..n].parse().unwrap_or(u64::MAX))
            } else {
                Run::Text(rest[..n].to_lowercase())
            });
            rest = &rest[n..];
        }
        out
    };
    runs(a).cmp(&runs(b))
}

/// The repo's latest release, as GitHub picks it: the first in [`release_order`] that is
/// neither a pre-release nor yanked (else the first not yanked). A draft is never the latest
/// (§16.3).
pub fn latest_release(current: &[Release]) -> Option<&Release> {
    let candidates = || current.iter().filter(|r| !r.yanked && !r.is_draft());
    candidates()
        .find(|r| !r.is_prerelease())
        .or_else(|| candidates().next())
}

/// `a` vs `b`, newest revision first (`$createdAt`, then `$id`).
fn newest_first(a: &Release, b: &Release) -> std::cmp::Ordering {
    (b.created_at, &b.document_id).cmp(&(a.created_at, &a.document_id))
}

/// The RC1 `release` rule that keeps one live release per tag.
const ONE_LIVE_RULE: &str = "oneLive";

/// Whether a public tag is live: its `release.delta` sum, as the contract's `perTag` summable
/// index holds it, is 1 while the tag is live, 0 before its first publish and after an
/// unpublish.
fn tag_is_live(deltas: impl IntoIterator<Item = i64>) -> bool {
    deltas.into_iter().sum::<i64>() >= 1
}

/// The `delta` of a new public revision of a tag (RC1 `oneLive`: the tag's sum after the write
/// must be `min(delta + 1, 1)`): `+1` publishes a tag that is not live, `0` edits or yanks a
/// live one. Unpublishing (`-1`) has no writer in this client; a release cannot be deleted.
fn release_delta(live: bool) -> i64 {
    i64::from(!live)
}

/// Refuse a release tag the RC1 contract would refuse (`release.tagName`: 1-63 bytes of the
/// git ref grammar, `@{` included), before anything is signed or uploaded.
pub fn check_tag_name(tag: &str) -> Result<()> {
    if rules::is_legal_tag_name(tag) {
        return Ok(());
    }
    Err(Error::Config(format!(
        "illegal release tag {tag:?}: a tag is 1-63 bytes and must pass `git check-ref-format` \
         (no spaces, control characters, `~^:?*[\\`, `..`, `@{{`, or a component that starts \
         with `.`)"
    )))
}

/// Split release revisions into the newest per live tag (in [`release_order`]) and the rest
/// (newest first). A tag whose newest revision unpublishes it (`delta` −1) is not live: every
/// revision of it is previous. For a public tag this is exactly "its deltas sum below 1"
/// (`oneLive` admits only +1 after an unpublish). Public revisions only: a private
/// repository's are folded by [`sealed_releases`].
fn newest_per_tag(all: Vec<Release>) -> (Vec<Release>, Vec<Release>) {
    let mut by_tag: BTreeMap<String, Vec<Release>> = BTreeMap::new();
    for r in all {
        by_tag.entry(r.tag_name.clone()).or_default().push(r);
    }
    let mut current = Vec::new();
    let mut previous = Vec::new();
    for (_, mut revs) in by_tag {
        revs.sort_by(newest_first);
        let mut it = revs.into_iter().peekable();
        if it.peek().is_some_and(|newest| newest.delta >= 0) {
            current.extend(it.next());
        }
        previous.extend(it);
    }
    current.sort_by(release_order);
    previous.sort_by(newest_first);
    (current, previous)
}

/// What a sealed revision's new asset list is built from ([`Collab::rebuild_asset_list`]).
struct RebuildFrom<'i> {
    /// The revision's fields so far (every field but the notes and TLV 21).
    fields: crate::private::release::ReleaseFields,
    /// Its full notes.
    notes: &'i str,
    /// The new files.
    files: &'i [ReleaseFile],
    /// The previous revision's asset list.
    prev: Option<&'i crate::private::release::ReleaseManifest>,
}

/// The newest readable revision of `tag`: its release when live, else the newest of its
/// history (an unpublished tag's included).
fn newest_revision<'l>(list: &'l ReleaseList, tag: &str) -> Option<&'l Release> {
    list.current
        .iter()
        .find(|r| r.tag_name == tag)
        .or_else(|| list.previous.iter().find(|r| r.tag_name == tag))
}

fn non_empty(s: &str) -> Option<String> {
    (!s.is_empty()).then(|| s.to_string())
}

/// The URIs a sealed asset entry records: 1–8 (§16.5), private `s3://` copies dropped first.
fn asset_uris(mut uris: Vec<String>) -> Vec<String> {
    const MAX: usize = 8;
    if uris.len() > MAX {
        uris.retain(|u| !u.starts_with("s3://"));
    }
    uris.truncate(MAX);
    uris
}

/// Store `sealed` (a sealed asset or asset list, `what` for messages) on `store`, named by its
/// own hash.
async fn store_sealed(
    store: Option<&ReleaseStore<'_>>,
    sealed: &[u8],
    what: &str,
) -> Result<crate::storage::Replication> {
    let store = store.ok_or_else(|| {
        Error::Config(format!(
            "{what} must be stored, and no storage was given: release assets are stored on \
             your own storage (`--storage <name>`)"
        ))
    })?;
    let meta = crate::backends::PackMeta::for_bytes(sealed);
    crate::storage::replicate(&store.targets, sealed, &meta, store.required)
        .await
        .map_err(|e| UserError::storage_policy_not_met(&e, &format!("store {what}"), false).into())
}

/// The kind-4 `packManifest` of a sealed asset list (§16.5): `objectCount` 0, no `tips`, no
/// `supersedes`, so the document publishes nothing about the list.
fn release_manifest_input(
    pack_hash: [u8; 32],
    sealed: &[u8],
    stored: crate::repo::StoredArtifact,
) -> crate::repo::PackManifestInput {
    crate::repo::PackManifestInput {
        pack_hash,
        kind: u64::from(crate::pack::KIND_RELEASE_ASSETS),
        size_bytes: sealed.len() as u64,
        object_count: 0,
        chunk_count: stored.chunk_count,
        storage: stored.storage,
        uris: stored.uris,
        supersedes: Vec::new(),
        tips: Vec::new(),
    }
}

/// A sealed revision's properties besides `repoId` (§16.2): exactly `tagName`, `vis`,
/// `delta` 0, `epoch` and `enc`. Never `name`, `notes`, `assets`, `assetManifest`, `yanked`
/// or `imported`.
fn sealed_release_props(tag_name: &str, epoch: u32, enc: Vec<u8>) -> BTreeMap<String, FieldValue> {
    let mut p = BTreeMap::new();
    p.insert("tagName".to_string(), FieldValue::text(tag_name));
    p.insert("delta".to_string(), FieldValue::integer(0));
    p.insert("epoch".to_string(), FieldValue::integer(u64::from(epoch)));
    p.insert("enc".to_string(), FieldValue::bytes(enc));
    crate::layout::stamp_vis(&mut p, Visibility::Private);
    p
}

/// The warning a sealed writer gives when its revision `ours` is not the newest of `tag`
/// after the write (§16.3): a concurrent revision (a lost update) or a clock behind another
/// writer's, since `$createdAt` is client-set. `None` when it is, or is not visible yet.
fn not_newest_warning(after: &ReleaseList, tag: &str, ours: &str) -> Option<String> {
    let newest = newest_revision(after, tag)?;
    let seen = newest.document_id == ours || after.previous.iter().any(|r| r.document_id == ours);
    (seen && newest.document_id != ours).then(|| {
        format!(
            "your revision of release {tag} is older than {}'s ({}): another maintainer wrote \
             one meanwhile, or your clock is behind theirs; check it with `dg release list`",
            newest.publisher, newest.document_id
        )
    })
}

/// A private repository's releases (§16.3): every revision opened with `open`, then folded by
/// its decrypted tag across epochs. Unreadable revisions are counted, replays ignored.
fn sealed_releases(
    docs: &[FetchedDocument],
    open: impl Fn(&FetchedDocument) -> crate::private::release::Opened,
) -> ReleaseList {
    use crate::private::release::{self, Opened};
    use crate::private::Unreadable;
    let opened: Vec<Opened> = docs.iter().map(open).collect();
    let ids: Vec<Vec<u8>> = docs
        .iter()
        .map(|d| platform::decode_identifier(&d.id).map_or_else(|_| Vec::new(), Vec::from))
        .collect();
    let encs: Vec<Vec<u8>> = docs
        .iter()
        .map(|d| d.field_bytes("enc").unwrap_or_default())
        .collect();
    let tag_names: Vec<String> = docs
        .iter()
        .map(|d| d.field_str("tagName").unwrap_or_default())
        .collect();
    let revs: Vec<release::Revision<'_>> = docs
        .iter()
        .enumerate()
        .map(|(i, d)| release::Revision {
            id: &ids[i],
            created_at: d.created_at.unwrap_or(0),
            epoch: d
                .field_u64("epoch")
                .and_then(|e| u32::try_from(e).ok())
                .unwrap_or(u32::MAX),
            tag_name: &tag_names[i],
            opened: &opened[i],
            enc: &encs[i],
        })
        .collect();
    let fold = release::fold(&revs);
    let release_at = |i: usize| {
        let Opened::Readable(f) = &opened[i] else {
            unreachable!("the fold lists readable revisions only")
        };
        release_from_sealed(&docs[i], revs[i].epoch, (**f).clone())
    };
    let mut current: Vec<Release> = fold.live.iter().map(|&i| release_at(i)).collect();
    current.sort_by(release_order);
    ReleaseList {
        current,
        previous: fold.history.iter().map(|&i| release_at(i)).collect(),
        hidden: fold.hidden,
        earlier_use: opened
            .iter()
            .filter(|o| matches!(o, Opened::Unreadable(Unreadable::EarlierUse)))
            .count(),
        replays: fold.replays.len(),
        unknown_tags: fold.unknown_tags,
        stale: fold.stale,
    }
}

// ===========================================================================
// The create journal
// ===========================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateJournal {
    /// When the transition was signed (unix seconds). A journal older than
    /// [`JOURNAL_TTL_SECS`] is not resumed: it is an old command's, not an interrupted one.
    #[serde(default)]
    saved_at: u64,
    /// The contract the transition targets (a re-registered contract voids it).
    contract: String,
    /// The number the transition claims.
    number: u32,
    /// The signed create.
    intent: WriteIntent,
}

impl CreateJournal {
    fn load(path: &Path, contract: &str) -> Option<Self> {
        let j = std::fs::read(path)
            .ok()
            .and_then(|b| serde_json::from_slice::<Self>(&b).ok())
            .filter(|j| j.contract == contract);
        if j.as_ref()
            .is_some_and(|j| unix_now().saturating_sub(j.saved_at) > JOURNAL_TTL_SECS)
        {
            Self::remove(path);
            return None;
        }
        j
    }

    fn save(&self, path: &Path) -> Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| Error::Io(e.to_string()))?;
        }
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(self)?)
            .map_err(|e| Error::Io(e.to_string()))?;
        std::fs::rename(&tmp, path).map_err(|e| Error::Io(e.to_string()))
    }

    fn remove(path: &Path) {
        let _ = std::fs::remove_file(path);
    }
}

/// How long an interrupted create is resumed by re-running the same command. After that the
/// same title and body is a new issue (someone filing it again on purpose), not a resume.
const JOURNAL_TTL_SECS: u64 = 60 * 60;

fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

/// This install's secret for keying private journal names (created once, 0600).
fn journal_secret(dir: &Path) -> Result<[u8; 32]> {
    let path = dir.join(".name-key");
    if let Ok(b) = std::fs::read(&path) {
        if let Ok(k) = <[u8; 32]>::try_from(b.as_slice()) {
            return Ok(k);
        }
    }
    let mut k = [0u8; 32];
    getrandom::getrandom(&mut k).map_err(|e| Error::Config(format!("randomness: {e}")))?;
    std::fs::create_dir_all(dir)
        .map_err(|e| Error::Config(format!("creating {}: {e}", dir.display())))?;
    crate::keystore::write_private_file(&path, &k)?;
    Ok(k)
}

/// The journal of one pending create: per network, repo, kind, signer and content, so the
/// same command re-run resumes it and a different one does not.
fn create_journal_path(
    dir: &Path,
    network: &str,
    repo_id: &str,
    kind: TargetKind,
    signer: &str,
    fingerprint: &str,
    key: Option<&[u8; 32]>,
) -> PathBuf {
    let digest = match key {
        None => hex::encode(sha256(fingerprint.as_bytes())),
        Some(k) => {
            use hmac::{Hmac, Mac as _};
            let mut mac = Hmac::<sha2::Sha256>::new_from_slice(k).expect("any key length");
            mac.update(fingerprint.as_bytes());
            hex::encode(mac.finalize().into_bytes())
        }
    };
    dir.join(format!(
        "{}-{network}-{repo_id}-{signer}-{}.json",
        kind.doc_type(),
        &digest[..16]
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    const ME: &str = "GM7ozWV1MNuAxyMnrf4JngAyGSDickvLznGi72WMp8EL";
    const OTHER_REPO: &str = "9sGUjxras61DAe457iUfbJcKTfVT7qVj16PJ3xstqMKr";

    fn repo_ref(visibility: Visibility) -> RepoRef {
        RepoRef {
            forge: ForgeIds::test_forge(),
            repo_id: ME.into(),
            owner_id: ME.into(),
            name: "proj".into(),
            visibility,
        }
    }

    fn stored(repo_id: &str, owner: &str, revision: Option<u64>) -> FetchedDocument {
        FetchedDocument {
            id: ME.into(),
            owner_id: owner.into(),
            created_at: Some(1),
            created_at_block_height: Some(10),
            updated_at_block_height: None,
            fields: [(
                "repoId".to_string(),
                FieldValue::identifier(platform::decode_identifier(repo_id).unwrap()),
            )]
            .into(),
            revision,
        }
    }

    #[test]
    fn an_edit_is_refused_for_a_document_of_another_repo() {
        // HIGH: an id from a private repo edited "through" a public one must not take the
        // plaintext path; the document's own repo decides.
        let err = edit_check(
            &repo_ref(Visibility::Public),
            "comment",
            &stored(OTHER_REPO, ME, Some(2)),
            ME,
        )
        .unwrap_err();
        assert!(err.to_string().contains("not in"), "{err}");
        assert_eq!(
            edit_check(
                &repo_ref(Visibility::Public),
                "comment",
                &stored(ME, ME, Some(2)),
                ME
            )
            .unwrap(),
            2
        );
    }

    #[test]
    fn an_edit_by_a_non_author_is_refused_before_any_key_work() {
        let err = edit_check(
            &repo_ref(Visibility::Private),
            "comment",
            &stored(ME, OTHER_REPO, Some(2)),
            ME,
        )
        .unwrap_err();
        assert!(
            matches!(&err, Error::NotPermitted { needs, .. } if needs == "owner"),
            "{err:?}"
        );
    }

    #[test]
    fn an_edit_of_a_document_without_a_revision_says_so() {
        let err = edit_check(
            &repo_ref(Visibility::Private),
            "comment",
            &stored(ME, ME, None),
            ME,
        )
        .unwrap_err();
        assert!(
            matches!(&err, Error::Platform(m) if m.contains("revision")),
            "{err:?}"
        );
    }

    #[test]
    fn a_private_replace_clears_legacy_plaintext_next_to_enc() {
        let mut d = stored(ME, ME, Some(1));
        d.fields.insert("title".into(), FieldValue::text("legacy"));
        d.fields.insert("body".into(), FieldValue::text("legacy"));
        let sealed: BTreeMap<String, Option<FieldValue>> = [
            ("enc".to_string(), Some(FieldValue::bytes(vec![1; 40]))),
            ("epoch".to_string(), Some(FieldValue::integer(0))),
        ]
        .into();
        let c = clear_plaintext(DocKind::Issue, &d, sealed.clone());
        assert_eq!(c.get("title"), Some(&None));
        assert_eq!(c.get("body"), Some(&None));
        // nothing stored in plaintext: nothing to clear
        assert_eq!(
            clear_plaintext(DocKind::Issue, &stored(ME, ME, Some(1)), sealed.clone()),
            sealed
        );
    }

    #[test]
    fn a_pr_edit_uses_the_pr_epoch_keys_only_while_held_and_not_burned() {
        use crate::private::{EpochKey, EpochResolution, Private};
        let res = EpochResolution {
            write_epoch: Some(2),
            keys: [
                (1, EpochKey::from_bytes([1; 32])),
                (2, EpochKey::from_bytes([2; 32])),
            ]
            .into(),
            ..EpochResolution::default()
        };
        let w = Private::from_resolution(&[0x11; 32], &res).unwrap();
        assert_eq!(
            patch_epoch_keys(&BTreeSet::new(), &w, 1).unwrap().epoch(),
            1
        );
        let burned = patch_epoch_keys(&[1].into(), &w, 1).unwrap_err();
        assert!(
            matches!(&burned, Error::User(u) if u.code == codes::ROTATION_PENDING),
            "{burned:?}"
        );
        let unheld = patch_epoch_keys(&BTreeSet::new(), &w, 0).unwrap_err();
        assert!(
            matches!(&unheld, Error::User(u) if u.code == codes::NOT_A_KEY_HOLDER),
            "{unheld:?}"
        );
    }

    /// A `review` row of PR `patch` (its id byte repeated).
    fn review_row(patch: u8, n: u32) -> FetchedDocument {
        let mut fields = BTreeMap::new();
        fields.insert("patchId".into(), FieldValue::Identifier([patch; 32]));
        FetchedDocument {
            id: format!("r{patch:03}-{n:04}"),
            owner_id: "o".into(),
            created_at: Some(u64::from(n)),
            created_at_block_height: None,
            updated_at_block_height: None,
            revision: None,
            fields,
        }
    }

    /// Reviews for `patches` (in walk order), `per` each, cut at the lookup cap.
    fn walk(patches: &[u8], per: u32) -> Vec<FetchedDocument> {
        patches
            .iter()
            .flat_map(|p| (0..per).map(move |n| review_row(*p, n)))
            .take(LOOKUP_CAP_LEN)
            .collect()
    }

    /// Review finding: Drive walks the lookup in the PAGE's direction (descending here), so
    /// a full page holds the HIGHEST patch ids and every lower one is unread. The re-read
    /// set must not depend on the direction.
    #[test]
    fn a_full_review_lookup_rereads_every_pr_it_did_not_finish_either_direction() {
        let wanted: Vec<[u8; 32]> = (1..=6).map(|p| [p; 32]).collect();
        // Descending: 6, 5, 4 fill the page (40 each → 4 is cut at 20).
        let desc = walk(&[6, 5, 4, 3, 2, 1], 40);
        let reread = reviews_to_reread(&desc, &wanted);
        let expect: Vec<[u8; 32]> = [1, 2, 3, 4].iter().map(|p| [*p; 32]).collect();
        let mut got = reread.clone();
        got.sort_unstable();
        assert_eq!(got, expect, "the cut PR and every unread one");
        // Ascending: 1, 2 whole, 3 cut.
        let asc = walk(&[1, 2, 3, 4, 5, 6], 40);
        let mut got = reviews_to_reread(&asc, &wanted);
        got.sort_unstable();
        let expect: Vec<[u8; 32]> = [3, 4, 5, 6].iter().map(|p| [*p; 32]).collect();
        assert_eq!(got, expect);
        // A short page settles everything.
        assert!(reviews_to_reread(&walk(&[1, 2], 10), &wanted).is_empty());
    }

    fn target(author: &str) -> Target {
        Target {
            kind: TargetKind::Issue,
            id: "A2KL77ngVM1ft1t1em2XKt1rWCBZANdAJMyfWrDGCcd1".into(),
            number: 3,
            author: author.into(),
        }
    }

    #[test]
    fn a_state_change_is_a_member_s_or_the_author_s_transition() {
        let t = target("alice");
        // A member always writes as a member (asAuthor 0), author or not.
        assert_eq!(state_actor(Some(Role::Writer), "bob", &t), Actor::Member);
        assert_eq!(
            state_actor(Some(Role::Maintainer), "alice", &t),
            Actor::Member
        );
        // The author who is not a member writes as the author.
        assert_eq!(state_actor(None, "alice", &t), Actor::Author);
        // Anyone else: no operand admits them.
        assert_eq!(state_actor(None, "mallory", &t), Actor::Other);
        // State kinds are never events, on either gate.
        for kind in [
            EventKind::Close,
            EventKind::Reopen,
            EventKind::Merge,
            EventKind::Draft,
            EventKind::Ready,
        ] {
            assert_eq!(kind_route(Some(Role::Writer), "bob", &t, kind), None);
            assert_eq!(kind_route(None, "alice", &t, kind), None);
            assert!(event_props(&t, kind, None, None).is_err(), "{kind:?}");
        }
    }

    fn pr(author: &str) -> Target {
        Target {
            kind: TargetKind::Patch,
            number: 9,
            ..target(author)
        }
    }

    fn mv(target: &Target, code: i64, action: StateAction, actor: Actor) -> TransitionMove {
        next_transition(
            target.kind.transition_target(),
            code,
            action,
            actor,
            target.number,
        )
        .unwrap()
    }

    /// Every action and role writes the exact transition fields the contract's rules pin:
    /// `targetKind` = `kind / 10`, the per-kind `delta`, and `asAuthor` 0 for a member, the
    /// target's number for its author; a merge carries its commit.
    #[test]
    fn transition_documents_carry_the_pinned_fields_for_each_action_and_role() {
        use StateAction::{Close, Draft, Merge, Ready, Reopen};
        let fields = |t: &Target, m: &TransitionMove, oid: Option<&[u8]>| {
            let p = transition_props(t, m, oid).unwrap();
            assert!(matches!(p.get("targetId"), Some(FieldValue::Identifier(_))));
            assert!(!p.contains_key("repoId"), "the service adds repoId");
            (
                p.get("targetNumber").and_then(FieldValue::as_u64),
                p.get("targetKind").and_then(FieldValue::as_u64),
                p.get("kind").and_then(FieldValue::as_u64),
                p.get("delta").and_then(FieldValue::as_i64),
                p.get("asAuthor").and_then(FieldValue::as_u64),
                p.get("oid").and_then(FieldValue::as_bytes),
            )
        };
        let (issue, pr) = (target("alice"), pr("alice"));
        let cases: [(&Target, i64, StateAction, Actor, u64, i64, u64); 14] = [
            (&issue, 0, Close, Actor::Member, 1, 1, 0),
            (&issue, 0, Close, Actor::Author, 1, 1, 3),
            (&issue, 1, Reopen, Actor::Member, 2, -1, 0),
            (&issue, 1, Reopen, Actor::Author, 2, -1, 3),
            (&pr, 0, Close, Actor::Member, 11, 1, 0),
            (&pr, 0, Close, Actor::Author, 11, 1, 9),
            (&pr, 1, Reopen, Actor::Author, 12, -1, 9),
            (&pr, 0, Draft, Actor::Author, 14, 8, 9),
            (&pr, 0, Draft, Actor::Member, 14, 8, 0),
            (&pr, 8, Ready, Actor::Author, 15, -8, 9),
            (&pr, 8, Close, Actor::Member, 16, 1, 0),
            (&pr, 9, Reopen, Actor::Author, 17, -1, 9),
            (&pr, 1, Reopen, Actor::Member, 12, -1, 0),
            (&pr, 8, Ready, Actor::Member, 15, -8, 0),
        ];
        for (t, code, action, actor, kind, delta, as_author) in cases {
            let m = mv(t, code, action, actor);
            let tk = u64::from(t.kind.transition_target().code());
            assert_eq!(
                fields(t, &m, None),
                (
                    Some(u64::from(t.number)),
                    Some(tk),
                    Some(kind),
                    Some(delta),
                    Some(as_author),
                    None
                ),
                "{:?} {code} {action:?} {actor:?}",
                t.kind
            );
        }
        // A merge: a member's, from open and ready, with its commit.
        let m = mv(&pr, 0, Merge, Actor::Member);
        assert_eq!(
            fields(&pr, &m, Some(&[7; 20])),
            (
                Some(9),
                Some(1),
                Some(13),
                Some(2),
                Some(0),
                Some(vec![7; 20])
            )
        );
        // ... never without one, and only a merge names one.
        assert!(transition_props(&pr, &m, None).is_err());
        assert!(transition_props(&pr, &m, Some(&[7; 4])).is_err());
        let close = mv(&pr, 0, Close, Actor::Member);
        assert!(transition_props(&pr, &close, Some(&[7; 20])).is_err());
        // A PR move never names an issue (a_kindOfTarget / the tk agreement).
        assert!(transition_props(&issue, &close, None).is_err());
    }

    /// No legal move: a clear refusal before anything is signed.
    #[test]
    fn an_illegal_state_change_says_what_the_target_is() {
        let pr = pr("alice");
        let msg = |code, action, actor| no_move(&pr, code, action, actor).to_string();
        assert!(msg(1, StateAction::Close, Actor::Member).contains("it is closed"));
        assert!(msg(2, StateAction::Reopen, Actor::Member).contains("it is merged"));
        assert!(msg(8, StateAction::Merge, Actor::Member).contains("mark it ready first"));
        assert!(msg(0, StateAction::Ready, Actor::Member).contains("it is open"));
        assert!(matches!(
            no_move(&pr, 0, StateAction::Merge, Actor::Author),
            Error::NotPermitted { .. }
        ));
        assert!(matches!(
            no_move(&pr, 0, StateAction::Close, Actor::Other),
            Error::NotPermitted { .. }
        ));
        assert_eq!(
            state_words(TargetKind::Issue, 1),
            "closed",
            "an issue has no draft"
        );
        for a in [
            StateAction::Close,
            StateAction::Reopen,
            StateAction::Merge,
            StateAction::Draft,
            StateAction::Ready,
        ] {
            assert!(
                next_transition(TransitionTarget::Patch, legal_from(a), a, Actor::Member, 1)
                    .is_some(),
                "{a:?}"
            );
        }
    }

    /// With the pre-check off the move is attempted without the actor gate, so consensus
    /// judges an author's merge (`f_authorNoMerge`) and a stranger's move (its gate).
    #[test]
    fn a_forced_move_skips_only_the_actor_gate() {
        let tt = TransitionTarget::Patch;
        let m = forced_move(tt, StateAction::Merge, Actor::Author, 9).unwrap();
        assert_eq!((m.kind, m.delta, m.as_author), (13, 2, 9));
        let m = forced_move(tt, StateAction::Close, Actor::Other, 9).unwrap();
        assert_eq!((m.kind, m.as_author), (11, 0));
        let m = forced_move(tt, StateAction::Ready, Actor::Member, 9).unwrap();
        assert_eq!((m.kind, m.delta), (15, -8));
        // An issue has no merge, draft or ready transition at all.
        for a in [StateAction::Merge, StateAction::Draft, StateAction::Ready] {
            assert!(forced_move(TransitionTarget::Issue, a, Actor::Member, 3).is_none());
        }
    }

    /// A create refused as "taken" by an earlier attempt of itself (it landed; the read after
    /// the consumed nonce lagged) is the result: the signer's own copy with the same content.
    #[test]
    fn a_landed_attempt_of_the_same_create_is_recognised() {
        let imp = Imported {
            author: "octocat".into(),
            created_at: 1_600_000_000,
            url: "https://github.com/o/r/issues/7".into(),
        };
        let from = Provenance {
            imported: Some(&imp),
            upstream_number: Some(7),
        };
        let plain = issue_props(4, "t", "b", from).unwrap();
        let doc = |owner: &str, fields: BTreeMap<String, FieldValue>| FetchedDocument {
            id: "landed".into(),
            owner_id: owner.into(),
            created_at: Some(5),
            created_at_block_height: None,
            updated_at_block_height: None,
            revision: Some(1),
            fields,
        };
        // As stored: integers read back at another width, the nested createdAt too.
        let mut stored = plain.clone();
        stored.insert("imported".into(), {
            let Some(FieldValue::Object(mut m)) = stored.get("imported").cloned() else {
                unreachable!()
            };
            m.insert("createdAt".into(), FieldValue::Integer(1_600_000_000));
            FieldValue::Object(m)
        });
        stored.insert("repoId".into(), FieldValue::identifier([1; 32]));
        assert!(is_own_copy(&doc(ME, stored.clone()), ME, &plain));
        // Only an id this create signed is adopted: the signer's earlier, separate issue with
        // the same title and body (filed twice on purpose) is not.
        let signed = [(4, "landed".to_string())];
        assert!(adoptable(&doc(ME, stored.clone()), ME, &plain, &signed));
        assert!(!adoptable(
            &doc(ME, stored.clone()),
            ME,
            &plain,
            &[(4, "another-attempt".to_string())]
        ));
        assert!(!adoptable(&doc(ME, stored.clone()), ME, &plain, &[]));
        // Someone else's issue at that number, or other content: count again.
        assert!(!is_own_copy(&doc("other", stored.clone()), ME, &plain));
        let mut edited = stored;
        edited.insert("title".into(), FieldValue::text("another"));
        assert!(!is_own_copy(&doc(ME, edited), ME, &plain));
    }

    #[test]
    fn only_imports_upstream_numbers_and_member_verdicts_require_the_proof() {
        let with = |k: &str, v: FieldValue| BTreeMap::from([(k.to_string(), v)]);
        assert!(!proof_required(&with("body", FieldValue::text("hi"))));
        assert!(proof_required(&with(
            "upstreamNumber",
            FieldValue::integer(3)
        )));
        assert!(proof_required(&with(
            "imported",
            FieldValue::Object(BTreeMap::new())
        )));
        for (code, needs) in [(1, true), (2, true), (3, false), (4, false), (5, false)] {
            assert_eq!(
                proof_required(&with("verdict", FieldValue::integer(code))),
                needs,
                "verdict {code}"
            );
        }
    }

    /// A create refused because another took the number counts again; so does the unique
    /// index; a state-rule refusal is recognised apart from both.
    #[test]
    fn a_dense_or_duplicate_refusal_means_count_again() {
        let dense = Error::RuleRefused {
            document_type: "issue".into(),
            rule: "dense".into(),
            detail: "A document of type \"issue\" breaks its propertyConstraints rule \"dense\": it does not hold".into(),
        };
        assert!(number_taken(&dense));
        assert!(number_taken(&Error::DuplicateUniqueIndex("number".into())));
        // The message alone (an error the SDK did not decode) still counts.
        assert!(number_taken(&Error::Platform("state transition broadcast error: A document of type \"patch\" breaks its propertyConstraints rule \"dense\": it does not hold".into())));
        let title = Error::RuleRefused {
            document_type: "issue".into(),
            rule: "hasTitle".into(),
            detail: "…".into(),
        };
        assert!(!number_taken(&title));
        assert!(!is_state_rule_refusal(&dense));
        let closed = Error::RuleRefused {
            document_type: "transition".into(),
            rule: "c1_closedAfter".into(),
            detail: "…".into(),
        };
        assert!(is_state_rule_refusal(&closed));
        // Only the transition's c<digit>_ rules: checkRun's conclusionIfDone is not one.
        for (doc, rule) in [
            ("checkRun", "conclusionIfDone"),
            ("checkRun", "completedAtIfDone"),
            ("transition", "f_authorNoMerge"),
            ("issue", "c1_closedAfter"),
        ] {
            let e = Error::RuleRefused {
                document_type: doc.into(),
                rule: rule.into(),
                detail: String::new(),
            };
            assert!(!is_state_rule_refusal(&e), "{doc} {rule}");
        }
        assert!(!number_taken(&closed));
    }

    /// The per-target codes of a grouped sum (keys: the 32 id bytes) and the per-kind counts
    /// of a grouped count (keys: the kind's u8 tree key), as the readers take them.
    #[test]
    fn grouped_answers_become_codes_and_repo_counts() {
        let a = [1u8; 32];
        let b = [2u8; 32];
        let codes = sums_by_target(BTreeMap::from([(a.to_vec(), 1), (b.to_vec(), 8)])).unwrap();
        assert_eq!(codes.get(&platform::encode_identifier(a)), Some(&1));
        assert_eq!(codes.get(&platform::encode_identifier(b)), Some(&8));
        let key = |k: u8| vec![k ^ 0x80];
        // A key of another width is an error, never a silent 0 or "open".
        assert!(counts_by_kind(BTreeMap::from([(vec![1, 2], 1)])).is_err());
        assert!(sums_by_target(BTreeMap::from([(vec![1; 31], 1)])).is_err());
        let kinds = counts_by_kind(BTreeMap::from([
            (key(1), 5),
            (key(2), 1),
            (key(13), 3),
            (key(14), 2),
            (key(11), 1),
        ]))
        .unwrap();
        assert_eq!(kinds.get(&13), Some(&3));
        let c = repo_counts(10, 7, &kinds);
        assert_eq!((c.issues_open, c.issues_closed), (6, 4));
        assert_eq!(
            (c.prs_merged, c.prs_closed, c.prs_draft, c.prs_open),
            (3, 1, 2, 3)
        );
    }

    #[test]
    fn event_documents_name_their_target_by_id_and_number() {
        let p = event_props(&target("a"), EventKind::LabelAdd, Some("bug"), None).unwrap();
        assert!(matches!(p.get("targetId"), Some(FieldValue::Identifier(_))));
        assert_eq!(p.get("targetNumber"), Some(&FieldValue::integer(3)));
        assert_eq!(p.get("kind"), Some(&FieldValue::integer(4)));
        assert_eq!(p.get("value"), Some(&FieldValue::text("bug")));
        assert!(!p.contains_key("repoId"), "the service adds repoId");
        // A retarget must name a legal ref.
        assert!(event_props(&target("a"), EventKind::Retarget, Some("-x"), None).is_err());
        assert!(event_props(&target("a"), EventKind::Retarget, None, None).is_err());
    }

    #[test]
    fn assign_events_name_the_assignee_in_value_and_ref_id() {
        let who = "A2KL77ngVM1ft1t1em2XKt1rWCBZANdAJMyfWrDGCcd1";
        let pay = |value, ref_id| EventPayload {
            value,
            oid: None,
            ref_id,
        };
        let p = event_payload_props(&target("a"), EventKind::Assign, &pay(Some(who), Some(who)))
            .unwrap();
        assert_eq!(p.get("kind"), Some(&FieldValue::integer(6)));
        assert_eq!(p.get("value"), Some(&FieldValue::text(who)));
        assert!(matches!(p.get("refId"), Some(FieldValue::Identifier(_))));
        // The addressee index needs refId; the fold needs value; they must agree.
        for (kind, v, r) in [
            (EventKind::Assign, Some(who), None),
            (EventKind::Unassign, None, Some(who)),
            (EventKind::Assign, Some("x"), Some(who)),
        ] {
            assert!(event_payload_props(&target("a"), kind, &pay(v, r)).is_err());
        }
        // A label event needs a name.
        assert!(event_props(&target("a"), EventKind::LabelAdd, Some(" "), None).is_err());
        assert!(event_props(&target("a"), EventKind::LabelRemove, None, None).is_err());
        assert!(event_props(&target("a"), EventKind::LabelAdd, Some(" bug"), None).is_err());
    }

    #[test]
    fn a_value_kind_needs_a_non_empty_value() {
        for kind in [
            EventKind::LabelAdd,
            EventKind::LabelRemove,
            EventKind::Assign,
            EventKind::Unassign,
            EventKind::MilestoneSet,
        ] {
            assert!(
                event_props(&target("a"), kind, Some(""), None).is_err(),
                "{kind:?} empty"
            );
            assert!(
                event_props(&target("a"), kind, None, None).is_err(),
                "{kind:?} none"
            );
        }
        // a dismissal's reason is optional, and an empty one is written as none
        let p = event_payload_props(
            &target("a"),
            EventKind::ReviewDismiss,
            &EventPayload {
                value: Some(""),
                oid: None,
                ref_id: Some("A2KL77ngVM1ft1t1em2XKt1rWCBZANdAJMyfWrDGCcd1"),
            },
        )
        .unwrap();
        assert!(!p.contains_key("value"));
    }

    #[test]
    fn review_events_carry_their_payload_and_route_by_kind() {
        let t = target("alice");
        let root = "A2KL77ngVM1ft1t1em2XKt1rWCBZANdAJMyfWrDGCcd1";
        let p = event_payload_props(
            &t,
            EventKind::ThreadResolve,
            &EventPayload {
                ref_id: Some(root),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(p.get("kind"), Some(&FieldValue::integer(11)));
        assert!(matches!(p.get("refId"), Some(FieldValue::Identifier(_))));
        // A payload-less review kind is refused before signing.
        for kind in [
            EventKind::ThreadResolve,
            EventKind::ReviewRequest,
            EventKind::ReviewDismiss,
            EventKind::HeadUpdate,
            EventKind::MilestoneSet,
        ] {
            assert!(event_payload_props(&t, kind, &EventPayload::default()).is_err());
        }
        let head = event_payload_props(
            &t,
            EventKind::HeadUpdate,
            &EventPayload {
                oid: Some(&[7; 20]),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(head.get("kind"), Some(&FieldValue::integer(16)));
        // The author may resolve and move the head, never dismiss or label (a merge is a
        // transition, never an event).
        assert_eq!(
            kind_route(None, "alice", &t, EventKind::HeadUpdate),
            Some(StateRoute::Author)
        );
        for kind in [EventKind::ReviewDismiss, EventKind::LabelAdd] {
            assert_eq!(kind_route(None, "alice", &t, kind), None);
            assert_eq!(
                kind_route(Some(Role::Writer), "bob", &t, kind),
                Some(StateRoute::Member)
            );
        }
        assert_eq!(
            kind_route(None, "mallory", &t, EventKind::ThreadResolve),
            None
        );
    }

    #[test]
    fn policies_are_bounded_like_the_schema() {
        let mut policy = Policy {
            required_approvals: 2,
            approver_role: 1,
            require_checks: true,
            merge_methods: 3,
            ..Policy::default()
        };
        let p = policy_props(&policy).unwrap();
        assert_eq!(p.get("requiredApprovals"), Some(&FieldValue::integer(2)));
        assert_eq!(p.get("requireChecks"), Some(&FieldValue::boolean(true)));
        policy.required_approvals = 11;
        assert!(policy_props(&policy).is_err());
        policy.required_approvals = 1;
        policy.approver_role = 2;
        assert!(policy_props(&policy).is_err());
    }

    #[test]
    fn patch_documents_carry_hashes_and_refuse_injection() {
        let input = PatchInput {
            title: "t".into(),
            body: String::new(),
            base_ref_name: "refs/heads/main".into(),
            source_repo_id: "A2KL77ngVM1ft1t1em2XKt1rWCBZANdAJMyfWrDGCcd1".into(),
            source_ref_name: Some("refs/heads/feature".into()),
            head_oid: vec![0xab; 20],
            patch_manifest_hash: None,
            draft: false,
        };
        let p = patch_props(7, &input, Provenance::default()).unwrap();
        // The target kind tag; a draft is never a property (a kind-14 transition instead).
        assert_eq!(p.get("tk"), Some(&FieldValue::integer(1)));
        assert!(!p.contains_key("draft"));
        let drafted = PatchInput {
            draft: true,
            ..input.clone()
        };
        assert_eq!(
            patch_props(7, &drafted, Provenance::default()).unwrap(),
            p,
            "the draft flag writes nothing on the patch"
        );
        assert_eq!(
            p.get("baseRefNameHash"),
            Some(&FieldValue::bytes32(sha256(b"refs/heads/main")))
        );
        assert_eq!(
            p.get("sourceRefNameHash"),
            Some(&FieldValue::bytes32(sha256(b"refs/heads/feature")))
        );
        assert!(matches!(
            p.get("sourceRepoId"),
            Some(FieldValue::Identifier(_))
        ));
        assert!(!p.contains_key("body"), "an empty body is omitted");
        let mut bad = input.clone();
        bad.source_ref_name = Some("+refs/heads/x:refs/heads/main\n".into());
        assert!(patch_props(7, &bad, Provenance::default()).is_err());
        let mut short = input.clone();
        short.head_oid = vec![1; 4];
        assert!(patch_props(7, &short, Provenance::default()).is_err());
        let mut untitled = input;
        untitled.title = "  ".into();
        assert!(patch_props(7, &untitled, Provenance::default()).is_err());
    }

    #[test]
    fn imported_provenance_rides_on_issues() {
        let imp = Imported {
            author: "octocat".into(),
            created_at: 1_600_000_000,
            url: "https://github.com/o/r/issues/1".into(),
        };
        let from = Provenance {
            imported: Some(&imp),
            upstream_number: Some(7761),
        };
        let p = issue_props(1, "t", "b", from).unwrap();
        assert!(matches!(p.get("imported"), Some(FieldValue::Object(_))));
        assert_eq!(p.get("tk"), Some(&FieldValue::integer(0)));
        // A top-level integer (D-2), never inside `imported`.
        assert_eq!(p.get("upstreamNumber"), Some(&FieldValue::integer(7761)));
        let Some(FieldValue::Object(inner)) = p.get("imported") else {
            unreachable!()
        };
        assert!(!inner.contains_key("number"));
        // No source number, no property (the sparse index skips the document).
        let plain = issue_props(1, "t", "b", Provenance::default()).unwrap();
        assert!(!plain.contains_key("upstreamNumber") && !plain.contains_key("imported"));
        // Read back through the codec.
        let doc = FetchedDocument {
            id: "x".into(),
            owner_id: "o".into(),
            created_at: Some(5),
            created_at_block_height: None,
            updated_at_block_height: None,
            revision: None,
            fields: p,
        };
        let issue = issue_from_doc(&doc);
        assert_eq!(issue.number, 1);
        assert_eq!(issue.upstream_number, Some(7761));
        let got = issue.imported.unwrap();
        assert_eq!(got.author, "octocat");
        assert_eq!(got.created_at, 1_600_000_000);
    }

    #[test]
    fn transitions_read_back_with_their_target_and_kind() {
        let doc = |kind: u64, delta: FieldValue| FetchedDocument {
            id: format!("t{kind}"),
            owner_id: "m".into(),
            created_at: Some(5),
            created_at_block_height: None,
            updated_at_block_height: None,
            revision: None,
            fields: BTreeMap::from([
                ("targetId".into(), FieldValue::identifier([3; 32])),
                ("kind".into(), FieldValue::integer(kind)),
                ("delta".into(), delta),
                ("asAuthor".into(), FieldValue::integer(4)),
                ("oid".into(), FieldValue::bytes(vec![0xab; 20])),
            ]),
        };
        let t = transition_from_doc(&doc(13, FieldValue::integer(2))).unwrap();
        assert_eq!((t.kind, t.as_author), (13, 4));
        assert_eq!(t.oid.as_deref(), Some("ab".repeat(20).as_str()));
        assert_eq!(
            transition_target_of(&doc(13, FieldValue::integer(2))),
            Some(platform::encode_identifier([3; 32]))
        );
        // A reopen (a signed delta) reads too; its sum is the state code.
        let log = TargetLog {
            transitions: vec![
                transition_from_doc(&doc(11, FieldValue::integer(1))).unwrap(),
                transition_from_doc(&doc(12, FieldValue::Signed(-1))).unwrap(),
                transition_from_doc(&doc(14, FieldValue::integer(8))).unwrap(),
            ],
            ..TargetLog::default()
        };
        assert_eq!(log.state_code(), 8);
        // A kind the contract does not have is not a transition.
        assert!(transition_from_doc(&doc(5, FieldValue::integer(2))).is_none());
    }

    #[test]
    fn the_newest_release_per_tag_wins_and_older_ones_are_previous() {
        let rel = |tag: &str, at: u64, id: &str, delta: i64| Release {
            document_id: id.into(),
            tag_name: tag.into(),
            name: String::new(),
            notes: String::new(),
            yanked: false,
            assets: Vec::new(),
            publisher: "m".into(),
            created_at: at,
            delta,
            sealed: None,
        };
        let (cur, prev) = newest_per_tag(vec![
            rel("v1", 1, "a", 1),
            rel("v1", 3, "b", 0),
            rel("v2", 2, "c", 1),
            // Published, then unpublished: every revision is previous.
            rel("v3", 4, "d", 1),
            rel("v3", 5, "e", -1),
            // A sealed release (another client's): delta 0 always, still shown.
            rel("v4", 6, "f", 0),
        ]);
        assert_eq!(
            cur.iter()
                .map(|r| r.document_id.as_str())
                .collect::<Vec<_>>(),
            ["f", "c", "b"],
            "by version; v3 is unpublished"
        );
        assert_eq!(
            prev.iter()
                .map(|r| r.document_id.as_str())
                .collect::<Vec<_>>(),
            ["e", "d", "a"]
        );
    }

    /// RC1 `oneLive`: a revision publishes (+1) a tag that is not live and edits (0) a live
    /// one; the tag's sum after it is then 1 either way.
    #[test]
    fn a_release_publishes_a_tag_once_and_edits_it_after() {
        for (history, want) in [
            (vec![], 1),
            (vec![1], 0),
            (vec![1, 0, 0], 0),
            (vec![1, -1], 1),
            (vec![1, -1, 1], 0),
        ] {
            let delta = release_delta(tag_is_live(history.iter().copied()));
            assert_eq!(delta, want, "{history:?}");
            assert_eq!(history.into_iter().chain([delta]).sum::<i64>(), 1);
        }
    }

    #[test]
    fn release_tags_follow_the_contract_grammar() {
        for ok in [
            "v1.2.3",
            "release/2026",
            "-Ab3_x9QkZ",
            "v1@b",
            &"a".repeat(63),
        ] {
            assert!(check_tag_name(ok).is_ok(), "{ok}");
        }
        for bad in [
            "",
            "v1 beta",
            "v1^0",
            "v1..2",
            ".hidden",
            "v1@{0}",
            "v1/",
            &"a".repeat(64),
        ] {
            assert!(check_tag_name(bad).is_err(), "{bad:?}");
        }
    }

    /// §16.3 over stored documents: a sealed revision opens to its tag, a later yank is the
    /// release, a replayed `enc` cannot un-yank it, a plaintext release in a private repo is
    /// hidden, a draft is listed but not counted, and no tag is ever shown by its hash.
    #[test]
    fn sealed_releases_open_and_fold_and_never_show_a_hash() {
        use crate::private::doc::{AnchorRef, OpenContext};
        use crate::private::release::{self, ReleaseFields};
        use crate::private::{EpochKey, EpochKeys};
        let (repo_id, owner) = ([0x11; 32], [0x22; 32]);
        let keys = EpochKeys::derive(&repo_id, 0, &EpochKey::from_bytes([1; 32]));
        let ctx = OpenContext {
            keys: [(0, keys.clone())].into(),
            anchors: [(
                0,
                AnchorRef {
                    id: [9; 32],
                    height: 1,
                },
            )]
            .into(),
            ..OpenContext::default()
        };
        let seal = |f: &ReleaseFields, nonce: u8| {
            let s = release::seal_with_nonce(&keys, &owner, f, [nonce; 12]).unwrap();
            (s.tag_name, s.enc)
        };
        let doc = |id: u8, at: u64, (tag_name, enc): &(String, Vec<u8>)| {
            let mut fields: BTreeMap<String, FieldValue> = [
                ("tagName", FieldValue::text(tag_name.clone())),
                ("vis", FieldValue::text("private")),
                ("delta", FieldValue::integer(0)),
                ("epoch", FieldValue::integer(0)),
            ]
            .into_iter()
            .map(|(k, v)| (k.to_string(), v))
            .collect();
            if !enc.is_empty() {
                fields.insert("enc".into(), FieldValue::bytes(enc.clone()));
            }
            FetchedDocument {
                id: platform::encode_identifier([id; 32]),
                owner_id: platform::encode_identifier(owner),
                created_at: Some(at),
                created_at_block_height: None,
                updated_at_block_height: None,
                revision: None,
                fields,
            }
        };
        let v1 = ReleaseFields {
            tag: "v1.0.0".into(),
            name: Some("One".into()),
            ..ReleaseFields::default()
        };
        let published = seal(&v1, 1);
        let yanked = seal(
            &ReleaseFields {
                yanked: true,
                ..v1.clone()
            },
            2,
        );
        let draft = seal(
            &ReleaseFields {
                tag: "v2.0.0".into(),
                draft: true,
                ..ReleaseFields::default()
            },
            3,
        );
        let docs = [
            doc(1, 100, &published),
            doc(2, 200, &yanked),
            doc(3, 300, &published), // a replay of the first revision
            doc(4, 400, &("v9.9.9".into(), Vec::new())), // plaintext: malformed
            doc(5, 500, &draft),
        ];
        let list = sealed_releases(&docs, |d| {
            release::open(&ctx, &crate::keyring::stored_release(d).unwrap())
        });
        let tags: Vec<&str> = list.current.iter().map(|r| r.tag_name.as_str()).collect();
        assert_eq!(tags, ["v2.0.0", "v1.0.0"]);
        let v1_now = &list.current[1];
        assert_eq!(v1_now.document_id, docs[1].id, "the yank is the release");
        assert!(v1_now.yanked && v1_now.name == "One");
        assert!(list.current[0].is_draft());
        assert_eq!(
            list.count(),
            1,
            "a draft is not counted; a yanked release is"
        );
        assert!(
            latest_release(&list.current).is_none(),
            "a draft or a yanked release is never the latest"
        );
        assert_eq!(list.previous.len(), 1);
        assert_eq!(list.previous[0].document_id, docs[0].id);
        assert_eq!((list.replays, list.hidden), (1, 1));
        assert!(!list.stale && list.unknown_tags.is_empty());
    }

    /// Every document the sealed writer builds is one RC1 accepts (§16.2, §16.5): the revision
    /// with exactly `tagName`, `vis`, `delta` 0, `epoch` and `enc`, and its kind-4 asset list
    /// with `objectCount` 0 and no `tips`.
    #[test]
    fn the_sealed_writers_documents_are_rc1_valid() {
        use crate::private::release::{self, ReleaseFields, ReleaseManifest};
        use crate::private::{EpochKey, EpochKeys};
        use crate::test_support::rc1;
        let keys = EpochKeys::derive(&[0x11; 32], 3, &EpochKey::from_bytes([1; 32]));
        let (fields, _) = release::fit_notes(
            ReleaseFields {
                tag: "v1.0.0-rc.1".into(),
                name: Some("One".into()),
                prerelease: true,
                ..ReleaseFields::default()
            },
            &"notes ".repeat(600),
        );
        let (tag_name, enc) = release::seal(&keys, &rc1::OWNER, &fields).unwrap();
        let scope = crate::scope::DocScope {
            contract_id: "CORE".into(),
            repo_id: [0x11; 32],
        };
        let props = scope.scoped(sealed_release_props(&tag_name, 3, enc));
        let keys_of: Vec<&str> = props.keys().map(String::as_str).collect();
        assert_eq!(
            keys_of,
            ["delta", "enc", "epoch", "repoId", "tagName", "vis"]
        );
        // (`oneLive`, which refuses a sealed revision with delta 1, is a consensus total: the
        // live suite judges it, `rc1-live.mjs` "a sealed release that publishes")
        rc1::assert_valid("release", &props);

        let manifest = ReleaseManifest {
            v: 1,
            tag: "v1.0.0-rc.1".into(),
            total: 0,
            source: None,
            notes: Some("notes ".repeat(600)),
            assets: Vec::new(),
        };
        let sealed = release::seal_manifest(&keys, &manifest, true).unwrap();
        let stored = crate::repo::StoredArtifact {
            storage: 1,
            chunk_count: 0,
            uris: vec!["https://bucket.example/o".into()],
        };
        let input = release_manifest_input(sha256(&sealed), &sealed, stored);
        assert_eq!((input.object_count, input.tips.len()), (0, 0));
        rc1::assert_valid("packManifest", &input.props(&scope).unwrap());
    }

    /// §16.3: a writer is warned when, read back, its revision is not the tag's newest; not
    /// when it is, nor when it is not visible yet.
    #[test]
    fn a_sealed_writer_is_warned_when_its_revision_is_not_the_newest() {
        let rel = |id: &str, at: u64| Release {
            document_id: id.into(),
            tag_name: "v1".into(),
            name: String::new(),
            notes: String::new(),
            yanked: false,
            assets: Vec::new(),
            publisher: "bob".into(),
            created_at: at,
            delta: 0,
            sealed: None,
        };
        let list = ReleaseList {
            current: vec![rel("theirs", 2)],
            previous: vec![rel("ours", 1)],
            ..ReleaseList::default()
        };
        let w = not_newest_warning(&list, "v1", "ours").unwrap();
        assert!(w.contains("bob") && w.contains("theirs"), "{w}");
        assert_eq!(not_newest_warning(&list, "v1", "theirs"), None);
        assert_eq!(not_newest_warning(&list, "v1", "unseen"), None);
    }

    /// `ContentKind::Release` (§16.2): a private release without `enc`, or with plaintext
    /// content next to it, and a public one with `enc`, are malformed.
    #[test]
    fn release_well_formedness_follows_visibility() {
        let doc = |fields: &[(&str, FieldValue)]| FetchedDocument {
            id: "x".into(),
            owner_id: "o".into(),
            created_at: Some(1),
            created_at_block_height: None,
            updated_at_block_height: None,
            revision: None,
            fields: fields
                .iter()
                .map(|(k, v)| ((*k).to_string(), v.clone()))
                .collect(),
        };
        let enc = ("enc", FieldValue::bytes(vec![1; 40]));
        let epoch = ("epoch", FieldValue::integer(0));
        let tag = ("tagName", FieldValue::text("v1"));
        let sealed = doc(&[tag.clone(), enc.clone(), epoch.clone()]);
        let plain = doc(&[tag.clone(), ("yanked", FieldValue::Bool(false))]);
        let both = doc(&[tag, enc, epoch, ("yanked", FieldValue::Bool(false))]);
        let (k, public, private) = (
            ContentKind::Release,
            Visibility::Public,
            Visibility::Private,
        );
        assert!(well_formed(k, &sealed, private) && !well_formed(k, &sealed, public));
        assert!(well_formed(k, &plain, public) && !well_formed(k, &plain, private));
        assert!(!well_formed(k, &both, private));
    }

    /// L-14: the rail's "Latest release" was the OLDEST (an import writes newest-first, so
    /// the oldest release had the newest `$createdAt`). Version order, and the latest is the
    /// highest non-prerelease, as on GitHub.
    #[test]
    fn releases_are_ordered_by_version_and_the_latest_skips_prereleases() {
        let rel = |tag: &str, at: u64| Release {
            delta: 1,
            document_id: tag.into(),
            tag_name: tag.into(),
            name: String::new(),
            notes: String::new(),
            yanked: false,
            assets: Vec::new(),
            publisher: "m".into(),
            created_at: at,
            sealed: None,
        };
        // Written in GitHub's listing order: newest release first (lowest $createdAt).
        let (cur, _) = newest_per_tag(vec![
            rel("v24.0.0-rc.1", 1),
            rel("v23.1.2", 2),
            rel("v23.1.10", 3),
            rel("v24.0.0-rc.10", 4),
            rel("v0.9.13.15", 5),
            rel("nightly", 6),
            rel("jq-1.7.1", 7),
        ]);
        let order: Vec<&str> = cur.iter().map(|r| r.tag_name.as_str()).collect();
        assert_eq!(
            order,
            [
                "v24.0.0-rc.10",
                "v24.0.0-rc.1",
                "v23.1.10",
                "v23.1.2",
                "jq-1.7.1",
                "v0.9.13.15",
                "nightly"
            ]
        );
        assert_eq!(
            latest_release(&cur).map(|r| r.tag_name.as_str()),
            Some("v23.1.10")
        );
        assert!(
            is_prerelease("v24.0.0-rc.1") && !is_prerelease("15.2.0") && !is_prerelease("v1+build")
        );
        // Only pre-releases: the highest of them.
        assert_eq!(
            latest_release(&cur[..2]).map(|r| r.tag_name.as_str()),
            Some("v24.0.0-rc.10")
        );
        // Pre-release suffixes: a number before text, separators and case ignored. The same
        // fixture as forge-web's releases.test.ts.
        let (pre, _) = newest_per_tag(
            [
                "1.0.0-beta",
                "1.0.0-1",
                "1.0.0-rc.2",
                "1.0.0-RC1",
                "1.0.0-rc10",
                "1.0.0-alpha",
            ]
            .iter()
            .enumerate()
            .map(|(i, t)| rel(t, i as u64))
            .collect(),
        );
        let order: Vec<&str> = pre.iter().map(|r| r.tag_name.as_str()).collect();
        assert_eq!(
            order,
            [
                "1.0.0-rc10",
                "1.0.0-rc.2",
                "1.0.0-RC1",
                "1.0.0-beta",
                "1.0.0-alpha",
                "1.0.0-1"
            ]
        );
    }

    #[test]
    fn journals_are_keyed_by_content() {
        let d = Path::new("/j");
        let a = create_journal_path(d, "n", "R", TargetKind::Issue, "me", "t\0b", None);
        assert_eq!(
            a,
            create_journal_path(d, "n", "R", TargetKind::Issue, "me", "t\0b", None)
        );
        assert_ne!(
            a,
            create_journal_path(d, "n", "R", TargetKind::Issue, "me", "t\0c", None)
        );
        assert_ne!(
            a,
            create_journal_path(d, "n", "R", TargetKind::Patch, "me", "t\0b", None)
        );
        assert_ne!(
            a,
            create_journal_path(d, "n", "R", TargetKind::Issue, "you", "t\0b", None)
        );
    }

    #[test]
    fn a_private_journal_name_does_not_reveal_its_title() {
        let d = Path::new("/j");
        let public = create_journal_path(d, "n", "R", TargetKind::Issue, "me", "secret\0b", None);
        let keyed = |k: u8| {
            create_journal_path(
                d,
                "n",
                "R",
                TargetKind::Issue,
                "me",
                "secret\0b",
                Some(&[k; 32]),
            )
        };
        // a dictionary of sha256(title) no longer matches the file name
        assert_ne!(public, keyed(1));
        // stable for one install's key (a re-run resumes), different across installs
        assert_eq!(keyed(1), keyed(1));
        assert_ne!(keyed(1), keyed(2));
    }

    #[test]
    fn well_formedness_skips_ciphertext_in_a_public_repo() {
        let doc = |fields: BTreeMap<String, FieldValue>| FetchedDocument {
            id: "x".into(),
            owner_id: "o".into(),
            created_at: Some(1),
            created_at_block_height: None,
            updated_at_block_height: None,
            revision: None,
            fields,
        };
        let ok = doc(issue_props(1, "t", "", Provenance::default()).unwrap());
        assert!(well_formed(ContentKind::Issue, &ok, Visibility::Public));
        let mut enc = BTreeMap::new();
        enc.insert("number".into(), FieldValue::integer(1));
        enc.insert("enc".into(), FieldValue::bytes(vec![1; 32]));
        enc.insert("epoch".into(), FieldValue::integer(0));
        assert!(!well_formed(
            ContentKind::Issue,
            &doc(enc),
            Visibility::Public
        ));
    }

    #[test]
    fn a_patch_whose_ref_names_do_not_hash_to_their_keys_is_malformed() {
        let input = PatchInput {
            title: "t".into(),
            body: String::new(),
            base_ref_name: "refs/heads/main".into(),
            source_repo_id: "A2KL77ngVM1ft1t1em2XKt1rWCBZANdAJMyfWrDGCcd1".into(),
            source_ref_name: Some("refs/heads/feature".into()),
            head_oid: vec![0xab; 20],
            patch_manifest_hash: None,
            draft: false,
        };
        let doc = |fields: BTreeMap<String, FieldValue>| FetchedDocument {
            id: "x".into(),
            owner_id: "o".into(),
            created_at: Some(1),
            created_at_block_height: None,
            updated_at_block_height: None,
            revision: None,
            fields,
        };
        let honest = patch_props(1, &input, Provenance::default()).unwrap();
        assert!(well_formed(
            ContentKind::Patch,
            &doc(honest.clone()),
            Visibility::Public
        ));
        // Folded against one ref, merged into another: refused.
        let mut lying = honest.clone();
        lying.insert(
            "baseRefNameHash".into(),
            FieldValue::bytes32(sha256(b"refs/heads/other")),
        );
        assert!(!well_formed(
            ContentKind::Patch,
            &doc(lying),
            Visibility::Public
        ));
        let mut lying_source = honest;
        lying_source.insert("sourceRefNameHash".into(), FieldValue::bytes32([0; 32]));
        assert!(!well_formed(
            ContentKind::Patch,
            &doc(lying_source),
            Visibility::Public
        ));
    }

    #[test]
    fn text_limits_count_bytes_too() {
        // 1500 three-byte characters: under 5120 characters, over 5120 bytes.
        let body = "€".repeat(1800);
        assert!(issue_props(1, "t", &body, Provenance::default()).is_err());
        assert!(issue_props(1, "t", &"€".repeat(1700), Provenance::default()).is_ok());
    }

    #[test]
    fn an_old_create_journal_is_not_resumed() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("j.json");
        let intent = WriteIntent {
            seq: 0,
            document_id: "D".into(),
            operation: platform::WriteOp::Create,
            transition: platform::SignedTransition {
                bytes: vec![1],
                nonce: 1,
            },
        };
        let fresh = CreateJournal {
            saved_at: unix_now(),
            contract: "C".into(),
            number: 3,
            intent: intent.clone(),
        };
        fresh.save(&path).unwrap();
        assert_eq!(CreateJournal::load(&path, "C").unwrap().number, 3);
        assert!(
            CreateJournal::load(&path, "OTHER").is_none(),
            "another contract's"
        );
        let stale = CreateJournal {
            saved_at: unix_now() - JOURNAL_TTL_SECS - 1,
            ..fresh
        };
        stale.save(&path).unwrap();
        assert!(CreateJournal::load(&path, "C").is_none());
        assert!(!path.exists(), "a stale journal is removed");
    }

    #[test]
    fn label_colors_are_checked() {
        assert!(is_hex_color("#1f883d"));
        assert!(!is_hex_color("1f883d"));
        assert!(!is_hex_color("#zzzzzz"));
    }
}
