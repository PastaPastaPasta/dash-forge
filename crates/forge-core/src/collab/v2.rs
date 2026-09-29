//! forge-v2 collaboration: issues, pull requests (`patch`), comments, reviews, events,
//! releases, labels and stars in the network's shared forge-collab / forge-core contracts
//! (`docs/contracts/forge-v2.md` §2, §3, §5, §6).
//!
//! Everything is keyed by the `repo` document id. Consensus gates the writes (§2): `event`
//! needs a `maintainer` or `writer` document for the repo, `authorEvent` needs the signer to
//! be the target's author (close / reopen only), `release` needs a maintainer, `label` any
//! member; issues, patches, comments, reviews and stars are un-gated. What is left
//! client-side is `FORGE_RULES_V2` ([`crate::rules::v2`]): numbering ([`allocate_number`]),
//! the state fold, approvals and well-formedness.
//!
//! [`Collab`] is the one entry point. Reads need only a client ([`Collab::reader`]); writes
//! need the signer ([`Collab::new`]). The explicit-number creates
//! ([`Collab::create_issue_numbered`], [`Collab::create_patch_numbered`]) are the primitive
//! the importer builds on; [`Collab::create_issue`] / [`Collab::create_patch`] allocate the
//! number by the §6 rule and are resumable: the signed create is journaled before it is
//! broadcast, so re-running an interrupted create re-broadcasts the same bytes instead of
//! opening a second issue.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use super::private::{self, EventValue};
use super::{
    check_len, check_text, doc_engine, event_kind_to_u64, insert_imported, label_from_doc,
    release_from_doc, u64_to_event_kind, CommentAnchor, Imported, Label, Release, ReleaseInput,
    Verdict, DEFAULT_PAGE,
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
    allocate_number, checks_state, count_approvals, fold_issue_state_v2, fold_pr_review_v2,
    fold_pr_state_v2, is_author_kind, is_well_formed, number_ceiling, Approvals, CheckRunRow,
    ChecksPolicy, ChecksState, ContentDoc, ContentKind, Policy, PrReviewState,
    Review as RuleReview, Role, RoleOracle, Visibility,
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
/// A member-gated state event.
pub const DOC_EVENT: &str = "event";
/// An author-gated state event (close, reopen, draft, ready, thread resolution, review
/// requests, head update).
pub const DOC_AUTHOR_EVENT: &str = "authorEvent";
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

/// Attempts at claiming a number before giving up: each collision re-reads the index, so
/// the next attempt starts above whatever took the number.
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

/// Concurrent `author`-index reads one allocation makes (one per trusted identity).
const TRUSTED_READS: usize = 8;

/// The owner, then each other maintainer once (sorted).
fn trusted_authors<'a>(owner: &str, maintainers: impl IntoIterator<Item = &'a str>) -> Vec<String> {
    let rest: BTreeSet<&str> = maintainers.into_iter().filter(|m| *m != owner).collect();
    std::iter::once(owner)
        .chain(rest)
        .map(str::to_string)
        .collect()
}

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
    /// Opened as a draft (`draft`); `draft` / `ready` events override it ([`PatchView::state`]).
    pub draft: bool,
    /// Consensus `$createdAt` (ms).
    pub created_at: u64,
    /// Importer provenance.
    pub imported: Option<Imported>,
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
    /// Open as a draft.
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

/// A target's state documents, by the gate that admitted them (§3).
#[derive(Debug, Clone, Default)]
pub struct TargetLog {
    /// Member `event`s.
    pub events: Vec<Event>,
    /// The author's own close / reopen (`authorEvent`).
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
    /// The issue's `event` and `authorEvent` documents.
    pub log: TargetLog,
}

impl IssueView {
    /// The events that applied to the issue (every member `event`, and the author's own
    /// close / reopen), in fold order: its history as the web's timeline shows it.
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
    /// Every commit the base ref has pointed at (what a merge event may name).
    pub base_tips: BTreeSet<String>,
    /// The PR's `event` and `authorEvent` documents.
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

/// How a create with an explicit number ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Numbered {
    /// Written by this call.
    Created {
        /// The new document id.
        document_id: String,
    },
    /// The number is already taken in this repo (consensus refused the duplicate, or a read
    /// found it first). `existing` is the document holding it, when it could be read.
    Taken {
        /// The document id holding the number.
        existing_id: Option<String>,
        /// Its author.
        existing_author: Option<String>,
    },
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
}

/// Which gate a close / reopen went through.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StateRoute {
    /// A member `event` (maintainer or writer).
    Member,
    /// The author's `authorEvent`.
    Author,
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
        draft: d.field_bool("draft"),
        created_at: d.created_at.unwrap_or_default(),
        imported: imported_of(d),
    }
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

/// An issue's state from its log (§3 fold).
fn fold_issue(log: &TargetLog, issue: &Issue) -> IssueState {
    fold_issue_state_v2(&log.events, &log.author_events, &issue.author)
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

/// The creator-side properties of a new `issue`.
pub fn issue_props(
    number: u32,
    title: &str,
    body: &str,
    imported: Option<&Imported>,
) -> Result<BTreeMap<String, FieldValue>> {
    check_title(title)?;
    check_text("issue body", body, 5120, 5120)?;
    let mut p = BTreeMap::new();
    p.insert("number".to_string(), FieldValue::integer(u64::from(number)));
    p.insert("title".to_string(), FieldValue::text(title));
    if !body.is_empty() {
        p.insert("body".to_string(), FieldValue::text(body));
    }
    insert_imported(&mut p, imported)?;
    Ok(p)
}

/// The creator-side properties of a new `patch`.
pub fn patch_props(
    number: u32,
    input: &PatchInput,
    imported: Option<&Imported>,
) -> Result<BTreeMap<String, FieldValue>> {
    check_title(&input.title)?;
    check_text("PR body", &input.body, 5120, 5120)?;
    // Written into un-gated data a maintainer's client renders and hands to git: refuse a
    // name that could smuggle a newline or an option (the `refUpdate` guard, mirrored).
    if !rules::is_legal_ref_name(&input.base_ref_name) || input.base_ref_name.len() > 255 {
        return Err(Error::Config(format!(
            "illegal PR base ref name {:?}: 1-255 bytes, no leading '-', no whitespace or \
             control characters",
            input.base_ref_name
        )));
    }
    if let Some(s) = &input.source_ref_name {
        if !rules::is_legal_ref_name(s) || s.len() > 255 {
            return Err(Error::Config(format!(
                "illegal PR source ref name {s:?}: 1-255 bytes, no leading '-', no whitespace \
                 or control characters"
            )));
        }
    }
    if !(20..=32).contains(&input.head_oid.len()) {
        return Err(Error::Config(format!(
            "PR head oid must be 20-32 bytes, got {}",
            input.head_oid.len()
        )));
    }
    let mut p = BTreeMap::new();
    p.insert("number".to_string(), FieldValue::integer(u64::from(number)));
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
    if input.draft {
        p.insert("draft".to_string(), FieldValue::boolean(true));
    }
    insert_imported(&mut p, imported)?;
    Ok(p)
}

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
                "illegal retarget base ref name {value:?}"
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

/// The properties of an `authorEvent` close or reopen.
pub fn author_event_props(target: &Target, close: bool) -> Result<BTreeMap<String, FieldValue>> {
    event_props(target, close_kind(close), None, None)
}

/// The properties of a `policy` (without `repoId`).
pub fn policy_props(policy: &Policy) -> Result<BTreeMap<String, FieldValue>> {
    if policy.required_approvals > 10 || policy.approver_role > 1 {
        return Err(Error::Config(
            "a policy takes 0-10 required approvals and approver role 0 (any member) or 1 \
             (maintainers)"
                .into(),
        ));
    }
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
    if !(1..=3).contains(&verdict.code()) {
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

fn close_kind(close: bool) -> EventKind {
    if close {
        EventKind::Close
    } else {
        EventKind::Reopen
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

/// How a close / reopen by `signer` must be written (§3): a member writes an `event`, the
/// target's author (who is not a member) an `authorEvent`. `None`: neither, so consensus
/// would refuse both. A member who is also the author uses the member route, which carries
/// every kind.
pub fn state_route(signer_role: Option<Role>, signer: &str, target: &Target) -> Option<StateRoute> {
    kind_route(signer_role, signer, target, EventKind::Close)
}

/// [`state_route`] for any kind: the author route only for an author kind
/// ([`is_author_kind`]); merge, labels, assignees, retarget, dismissals and milestones are
/// members only.
pub fn kind_route(
    signer_role: Option<Role>,
    signer: &str,
    target: &Target,
    kind: EventKind,
) -> Option<StateRoute> {
    if signer_role.is_some() {
        Some(StateRoute::Member)
    } else if signer == target.author && is_author_kind(kind) {
        Some(StateRoute::Author)
    } else {
        None
    }
}

/// Every taken number the §6 allocator needs, from a probe of the `number` index: `base`
/// and the contiguous run above it. `page(after)` returns up to one page of taken numbers
/// `> after`, ascending; this pages until the run breaks (a gap, or a short page).
pub async fn contiguous_run_above<F, Fut>(
    base: u32,
    page_size: usize,
    mut page: F,
) -> Result<Vec<u32>>
where
    F: FnMut(u32) -> Fut,
    Fut: std::future::Future<Output = Result<Vec<u32>>>,
{
    let mut run = Vec::new();
    let mut last = base;
    loop {
        let rows = page(last).await?;
        let full = rows.len() >= page_size;
        for n in rows {
            if u64::from(n) != u64::from(last) + 1 {
                return Ok(run);
            }
            run.push(n);
            last = n;
        }
        if !full || last == u32::MAX {
            return Ok(run);
        }
    }
}

/// A PR's view folded from its log and its base ref's tips (pure; [`Collab::patch_view`] and
/// [`Collab::list_patch_views`] read the inputs).
fn view_of(patch: Patch, log: TargetLog, base: rules::MergeBaseTips) -> PatchView {
    let state = fold_pr_state_v2(
        &log.events,
        &log.author_events,
        &patch.author,
        base.tip.as_deref(),
        |oid, _| base.contains(oid),
        patch.draft,
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

    /// Create one document of `repo` (its `repoId` added) in `contract`, as the signer.
    pub(super) async fn write(
        &self,
        repo: &RepoRef,
        contract: &LoadedContract,
        doc_type: &str,
        props: BTreeMap<String, FieldValue>,
    ) -> Result<String> {
        // A private repo's member `event` carries its `value` (label or milestone name, dismiss
        // reason, assignee, retarget base) sealed (§7): every event write passes here.
        let props = if doc_type == DOC_EVENT && props.contains_key("value") {
            self.seal_kind_if_private(repo, DocKind::Event, props)
                .await?
        } else {
            props
        };
        self.engine()?
            .create_document(contract, doc_type, Self::with_repo(repo, props)?)
            .await
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
    /// targets with their importer provenance: in a private repo `imported.author` / `.url`
    /// are sealed, so this is the only way an importer finds what it already mirrored. A pull
    /// request also carries the base its merge is folded against (`baseRefName`, and its
    /// `$createdAt`: see [`Self::base_ref_tips`]).
    pub async fn imported_targets(
        &self,
        repo: &RepoRef,
    ) -> Result<Vec<(Target, Option<Imported>, Option<PrBase>)>> {
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
            out.extend(docs.iter().map(|d| match kind {
                TargetKind::Issue => {
                    let i = issue_from_doc(d);
                    (i.target(), i.imported, None)
                }
                TargetKind::Patch => {
                    let p = patch_from_doc(d);
                    let base = p.base();
                    (p.target(), p.imported, Some(base))
                }
            }));
        }
        Ok(out)
    }

    /// The newest `limit` issues (0 = one page of 100), newest first.
    pub async fn list_issues(&self, repo: &RepoRef, limit: u32) -> Result<Listed<Issue>> {
        Ok(self
            .newest(repo, TargetKind::Issue, limit)
            .await?
            .map(|d| issue_from_doc(&d)))
    }

    /// The repository's event feed (`event`, `authorEvent`) as history specs, in
    /// [`Self::feed_logs`] order. Both types are immutable and non-deletable, so the feed is
    /// read through the delta cache ([`crate::history`]): after the first read each call costs
    /// one request for what landed since.
    fn feed_specs<'c>(
        collab: &'c LoadedContract,
        scope: &crate::scope::DocScope,
    ) -> [crate::history::HistorySpec<'c>; 2] {
        [
            crate::history::HistorySpec::new(collab, DOC_EVENT, scope),
            crate::history::HistorySpec::new(collab, DOC_AUTHOR_EVENT, scope),
        ]
    }

    /// The repo feed's rows (as Platform holds them; a private repo's member event values are
    /// opened here, never stored opened) folded into one log per target.
    async fn feed_logs(
        &self,
        repo: &RepoRef,
        events: Vec<FetchedDocument>,
        author_events: Vec<FetchedDocument>,
    ) -> Result<BTreeMap<String, TargetLog>> {
        // A private repo's member events: their sealed values opened (§8.1).
        let (events, _, _) = self.readable_events(repo, events).await?;
        let mut logs: BTreeMap<String, TargetLog> = BTreeMap::new();
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

    /// Every well-formed issue of `repo` (newest first) with its folded state, and how many
    /// were skipped as malformed: one keyset walk of the `created` index (`$createdAt <=` the
    /// oldest row read, 100 per page, deduped by id) and ONE read of the repo feed (`event` /
    /// `authorEvent` by `(repoId, $createdAt)`) through the delta cache, folded per issue.
    /// Requests: about `⌈issues/100⌉` plus the feed's new rows, where the old list paid 2 per
    /// row.
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
        let [events, author_events] = crate::history::take(
            crate::history::sync(
                self.client,
                &Self::feed_specs(&collab, &repo.scope()?),
                crate::history::Freshness::Now,
            )
            .await?,
        );
        let logs = self.feed_logs(repo, events, author_events).await?;
        // Malformed rows, and in a private repo rows this reader cannot open, are hidden.
        let (readable, hidden) = self.readable_all(repo, ContentKind::Issue, docs).await?;
        let shown: Vec<IssueView> = readable
            .iter()
            .map(|d| {
                let issue = issue_from_doc(d);
                let log = logs.get(&issue.document_id).cloned().unwrap_or_default();
                IssueView {
                    state: fold_issue(&log, &issue),
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

    /// Every `event` and `authorEvent` of a target, complete.
    pub async fn target_log(&self, repo: &RepoRef, target_id: &str) -> Result<TargetLog> {
        let collab = self.collab_contract(repo).await?;
        let events = self
            .by_target(&collab, DOC_EVENT, "targetId", target_id)
            .await?;
        let (events, hidden_values, plaintext_values) = self.readable_events(repo, events).await?;
        let author_events = self
            .by_target(&collab, DOC_AUTHOR_EVENT, "targetId", target_id)
            .await?;
        Ok(TargetLog {
            events: events.iter().filter_map(event_from_doc).collect(),
            author_events: author_events.iter().filter_map(event_from_doc).collect(),
            hidden_values,
            plaintext_values,
        })
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

    /// An issue's state (§3 fold).
    pub async fn issue_state(&self, repo: &RepoRef, issue: &Issue) -> Result<IssueState> {
        let log = self.target_log(repo, &issue.document_id).await?;
        Ok(fold_issue(&log, issue))
    }

    /// The issue and its state, or `None`.
    pub async fn issue_view(&self, repo: &RepoRef, number: u32) -> Result<Option<IssueView>> {
        let Some(issue) = self.issue(repo, number).await? else {
            return Ok(None);
        };
        let log = self.target_log(repo, &issue.document_id).await?;
        Ok(Some(IssueView {
            state: fold_issue(&log, &issue),
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
    ///   repo's event feed (`event`, `authorEvent`) and its ref history (`refUpdate`,
    ///   `protectedRefUpdate`, `config`), so every PR's state and base tips fold from it.
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
            .prefetch_contracts(&[&forge.collab, &forge.core])
            .await?;
        let collab = self.collab_contract(repo).await?;
        let core = self.core_contract(repo).await?;
        let scope = repo.scope()?;
        let limit = page_limit(limit);
        let reads = pr_list_reads(&collab, &core, &scope, limit);
        let [feed_a, feed_b] = Self::feed_specs(&collab, &scope);
        let [refs_a, refs_b, refs_c] = crate::refs::GitState::specs(&core, &scope);
        let history = [feed_a, feed_b, refs_a, refs_b, refs_c];
        let (batch, synced) = futures::join!(
            self.client.query_batch(&reads),
            crate::history::sync(self.client, &history, crate::history::Freshness::Now)
        );
        let [page, reviews, maintainers, writers] = crate::history::take(batch?);
        let [events, author_events, ref_updates, protected_ref_updates, configs] =
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
        let mut logs = self.feed_logs(repo, events, author_events).await?;
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

    // --- numbering --------------------------------------------------------------------

    /// The identities whose numbers a repo's allocation trusts (§6): the owner and its current
    /// maintainers, once each. When the maintainers cannot be read, the owner alone: a
    /// numbering gap is better than a failed create.
    pub async fn numbering_trust(&self, repo: &RepoRef) -> Vec<String> {
        let maintainers = match MemberReader::new(self.client).maintainers(repo).await {
            Ok(m) => m,
            Err(e) => {
                tracing::warn!(error = %e, "maintainers unread; trusting the owner's numbers only");
                Vec::new()
            }
        };
        trusted_authors(
            repo.owner_id(),
            maintainers.iter().map(|m| m.identity_id.as_str()),
        )
    }

    /// The largest number among `repo`'s issues (or PRs) written by one of `trusted`, or 0:
    /// one `number desc, limit 1` read of the `author` index (`$ownerId, repoId, number`)
    /// each, at most [`TRUSTED_READS`] at a time.
    async fn trusted_max_number(
        &self,
        collab: &LoadedContract,
        repo_filter: &QueryFilter,
        kind: TargetKind,
        trusted: &[String],
    ) -> Result<u32> {
        use futures::{StreamExt as _, TryStreamExt as _};
        let highest: Vec<u32> = futures::stream::iter(trusted)
            .map(|author| async move {
                let owner = FieldValue::identifier(platform::decode_identifier(author)?);
                Ok::<u32, Error>(
                    self.client
                        .query_documents(
                            collab,
                            kind.doc_type(),
                            &[QueryFilter::eq("$ownerId", owner), repo_filter.clone()],
                            &[QueryOrder::desc("number")],
                            1,
                            None,
                        )
                        .await?
                        .first()
                        .map_or(0, number_of),
                )
            })
            .buffer_unordered(TRUSTED_READS)
            .try_collect()
            .await?;
        Ok(highest.into_iter().max().unwrap_or(0))
    }

    /// The lowest number above `above` that no issue (or PR) of `repo` holds: an ascending
    /// probe of the `number` index, paged to the end of the contiguous run. Not the §6 rule:
    /// forge-import stores an upstream item whose number is taken here, where it cannot take
    /// a number a later upstream item needs (on GitHub, issues and PRs share one number
    /// space, so each kind's mirror has the other's numbers free).
    pub async fn lowest_free_number(
        &self,
        repo: &RepoRef,
        kind: TargetKind,
        above: u32,
    ) -> Result<u32> {
        let collab = self.collab_contract(repo).await?;
        let repo_filter = Self::repo_filter(repo)?;
        let run = contiguous_run_above(above, DEFAULT_PAGE as usize, |after| {
            let filters = [
                repo_filter.clone(),
                QueryFilter::gt("number", FieldValue::integer(u64::from(after))),
            ];
            let collab = &collab;
            async move {
                Ok(self
                    .client
                    .query_documents(
                        collab,
                        kind.doc_type(),
                        &filters,
                        &[QueryOrder::asc("number")],
                        DEFAULT_PAGE,
                        None,
                    )
                    .await?
                    .iter()
                    .map(number_of)
                    .collect())
            }
        })
        .await?;
        run.last()
            .copied()
            .unwrap_or(above)
            .checked_add(1)
            .ok_or_else(|| {
                Error::Config(format!(
                    "every {} number above {above} is taken",
                    kind.noun()
                ))
            })
    }

    /// The number a new issue or PR would claim now (§6), trusting the numbers of `trusted`
    /// ([`Self::numbering_trust`], read once per action and reused across its retries).
    pub async fn next_number(
        &self,
        repo: &RepoRef,
        kind: TargetKind,
        trusted: &[String],
    ) -> Result<u32> {
        let collab = self.collab_contract(repo).await?;
        let repo_filter = Self::repo_filter(repo)?;
        let (count, trusted_max) = futures::future::try_join(
            self.client.count_documents(
                &collab,
                kind.doc_type(),
                std::slice::from_ref(&repo_filter),
            ),
            self.trusted_max_number(&collab, &repo_filter, kind, trusted),
        )
        .await?;
        let ceiling = number_ceiling(count);
        let base = self
            .client
            .query_documents(
                &collab,
                kind.doc_type(),
                &[
                    repo_filter.clone(),
                    QueryFilter::lte("number", FieldValue::integer(ceiling)),
                ],
                &[QueryOrder::desc("number")],
                1,
                None,
            )
            .await?
            .first()
            .map_or(0, number_of)
            .max(trusted_max);
        let mut taken = vec![base];
        // Below the ceiling `base + 1` is free by construction; only a base at or above it
        // (the ceiling itself, or a trusted number past it) can have squatters directly
        // above it, and the probe steps over the whole run.
        if u64::from(base) >= ceiling {
            let page = DEFAULT_PAGE as usize;
            let run = contiguous_run_above(base, page, |after| {
                let filters = [
                    repo_filter.clone(),
                    QueryFilter::gt("number", FieldValue::integer(u64::from(after))),
                ];
                let collab = &collab;
                async move {
                    Ok(self
                        .client
                        .query_documents(
                            collab,
                            kind.doc_type(),
                            &filters,
                            &[QueryOrder::asc("number")],
                            DEFAULT_PAGE,
                            None,
                        )
                        .await?
                        .iter()
                        .map(number_of)
                        .collect())
                }
            })
            .await?;
            taken.extend(run);
        }
        taken.retain(|n| *n > 0);
        allocate_number(count, &taken, trusted_max).ok_or_else(|| {
            Error::Config(format!(
                "every {} number above {base} is taken",
                kind.noun()
            ))
        })
    }

    // --- writes: numbered creates ------------------------------------------------------

    async fn create_numbered(
        &self,
        repo: &RepoRef,
        kind: TargetKind,
        number: u32,
        props: BTreeMap<String, FieldValue>,
    ) -> Result<Numbered> {
        let collab = self.collab_contract(repo).await?;
        let props = self
            .seal_if_private(repo, kind.content_kind(), props)
            .await?;
        let props = Self::with_repo(repo, props)?;
        match self
            .engine()?
            .create_document(&collab, kind.doc_type(), props)
            .await
        {
            Ok(document_id) => Ok(Numbered::Created { document_id }),
            Err(Error::DuplicateUniqueIndex(_)) => {
                let existing = self.target_doc(repo, kind, number).await.ok().flatten();
                Ok(Numbered::Taken {
                    existing_id: existing.as_ref().map(|d| d.id.clone()),
                    existing_author: existing.map(|d| d.owner_id),
                })
            }
            Err(e) => Err(e),
        }
    }

    /// Create issue `number` of `repo` (the importer's primitive). A number already taken
    /// is [`Numbered::Taken`], not an error.
    pub async fn create_issue_numbered(
        &self,
        repo: &RepoRef,
        number: u32,
        title: &str,
        body: &str,
        imported: Option<&Imported>,
    ) -> Result<Numbered> {
        let props = issue_props(number, title, body, imported)?;
        self.create_numbered(repo, TargetKind::Issue, number, props)
            .await
    }

    /// Create pull request `number` of `repo` (the importer's primitive).
    pub async fn create_patch_numbered(
        &self,
        repo: &RepoRef,
        number: u32,
        input: &PatchInput,
        imported: Option<&Imported>,
    ) -> Result<Numbered> {
        let props = patch_props(number, input, imported)?;
        self.create_numbered(repo, TargetKind::Patch, number, props)
            .await
    }

    // --- writes: allocated, journaled creates ---------------------------------------------

    /// Open an issue, numbered by the §6 rule. Resumable: see the module docs.
    pub async fn create_issue(
        &self,
        repo: &RepoRef,
        title: &str,
        body: &str,
        journal_dir: &Path,
    ) -> Result<Created> {
        issue_props(1, title, body, None)?;
        let fingerprint = [title, "\0", body].concat();
        self.create_allocated(repo, TargetKind::Issue, &fingerprint, journal_dir, |n| {
            issue_props(n, title, body, None)
        })
        .await
    }

    /// Open a pull request, numbered by the §6 rule. Resumable.
    pub async fn create_patch(
        &self,
        repo: &RepoRef,
        input: &PatchInput,
        journal_dir: &Path,
    ) -> Result<Created> {
        patch_props(1, input, None)?;
        let fingerprint = format!(
            "{}\0{}\0{}\0{}\0{}",
            input.title,
            input.body,
            input.base_ref_name,
            input.source_repo_id,
            hex::encode(&input.head_oid)
        );
        self.create_allocated(repo, TargetKind::Patch, &fingerprint, journal_dir, |n| {
            patch_props(n, input, None)
        })
        .await
    }

    async fn create_allocated(
        &self,
        repo: &RepoRef,
        kind: TargetKind,
        fingerprint: &str,
        journal_dir: &Path,
        props: impl Fn(u32) -> Result<BTreeMap<String, FieldValue>>,
    ) -> Result<Created> {
        let me = self.signer_id()?;
        let collab = self.collab_contract(repo).await?;
        let engine = self.engine()?;
        // A private repo's title and body must not be guessable from a local file name: the
        // fingerprint is keyed with a per-install secret there.
        let key = (repo.visibility == Visibility::Private)
            .then(|| journal_secret(journal_dir))
            .transpose()?;
        let path = create_journal_path(
            journal_dir,
            &self.client.target().network.key(),
            repo.id(),
            kind,
            &me,
            fingerprint,
            key.as_ref(),
        );
        if let Some(saved) = CreateJournal::load(&path, &collab.id()) {
            if replay_landed(&engine, &collab, kind.doc_type(), &saved.intent).await? {
                CreateJournal::remove(&path);
                return Ok(Created {
                    number: saved.number,
                    document_id: saved.intent.document_id,
                    resumed: true,
                });
            }
            tracing::warn!(
                document = %saved.intent.document_id,
                "a saved create from an interrupted run never landed; allocating afresh"
            );
            CreateJournal::remove(&path);
        }
        // A read right after a collision can lag the block that took the number, so never
        // try a number at or below one already refused.
        let mut floor = 0u32;
        let trusted = self.numbering_trust(repo).await;
        for attempt in 0..MAX_NUMBER_ATTEMPTS {
            let number = self.next_number(repo, kind, &trusted).await?.max(floor);
            // sealed per number: the AD binds it (§4.4), so a renumbered retry re-seals
            let sealed = self
                .seal_if_private(repo, kind.content_kind(), props(number)?)
                .await?;
            let all = Self::with_repo(repo, sealed)?;
            let res = engine
                .create_journaled(&collab, kind.doc_type(), all, |p| {
                    CreateJournal {
                        saved_at: unix_now(),
                        contract: collab.id(),
                        number,
                        intent: WriteIntent::for_prepared(0, p),
                    }
                    .save(&path)
                })
                .await;
            match res {
                Ok(prepared) => {
                    CreateJournal::remove(&path);
                    return Ok(Created {
                        number,
                        document_id: prepared.document_id().to_string(),
                        resumed: false,
                    });
                }
                // Someone claimed the number first: nothing landed; read again and retry.
                Err(Error::DuplicateUniqueIndex(_)) => {
                    CreateJournal::remove(&path);
                    floor = number.saturating_add(1);
                    tracing::warn!(number, attempt, "number taken; allocating again");
                }
                // Refusals that prove nothing landed: forget the transition, or the same
                // command would replay it (and be refused) forever. Anything else — a failed
                // read after the broadcast, an unrecognised SDK error — may hide a landed
                // create, so the journal stays and the next run resumes it.
                Err(e @ (Error::NotAMember { .. } | Error::StaleProtocolVersion(_))) => {
                    CreateJournal::remove(&path);
                    return Err(e);
                }
                Err(e) => return Err(e),
            }
        }
        Err(Error::Platform(format!(
            "could not claim a {} number after {MAX_NUMBER_ATTEMPTS} attempts",
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
        let changes = if repo.visibility == Visibility::Private {
            self.private_edit(repo, kind, &stored, &changes).await?
        } else {
            changes
        };
        self.engine()?
            .replace_document_guarded(collab, doc_type, id, &changes, Some(revision))
            .await
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
        let p = comment_props(target_id, body, anchor, imported)?;
        let collab = self.collab_contract(repo).await?;
        let p = self.seal_if_private(repo, ContentKind::Comment, p).await?;
        self.write(repo, &collab, DOC_COMMENT, p).await
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
        let p = review_props(patch_id, verdict, commit_oid, body, comment_count, imported)?;
        let p = self.seal_if_private(repo, ContentKind::Review, p).await?;
        let collab = self.collab_contract(repo).await?;
        self.write(repo, &collab, DOC_REVIEW, p).await
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
        let prepared = engine
            .create_journaled(&collab, doc_type, Self::with_repo(repo, props)?, |p| {
                persist(&WriteIntent::for_prepared(0, p))
            })
            .await?;
        Ok(prepared.document_id().to_string())
    }

    // --- writes: events ------------------------------------------------------------------

    /// Post a member `event` (any kind). Consensus admits it only from a current
    /// maintainer or writer; the client checks first unless [`SKIP_PRECHECK_ENV`] is set.
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
        let collab = self.collab_contract(repo).await?;
        self.write(repo, &collab, DOC_EVENT, props).await
    }

    /// Close or reopen `target`, through whichever gate admits the signer: a member's
    /// `event`, else the author's `authorEvent`. Neither is [`Error::NotPermitted`] before
    /// anything is signed (unless [`SKIP_PRECHECK_ENV`] is set: then a member event is
    /// attempted and consensus refuses it).
    pub async fn set_open(
        &self,
        repo: &RepoRef,
        target: &Target,
        close: bool,
    ) -> Result<(StateRoute, String)> {
        let me = self.signer_id()?;
        let role = self.signer_role(repo).await?;
        let verb = if close { "close" } else { "reopen" };
        let route = match state_route(role, &me, target) {
            Some(r) => r,
            None if !precheck_enabled() => StateRoute::Member,
            None => {
                return Err(Error::NotPermitted {
                    action: format!("{verb} {} #{}", target.kind.noun(), target.number),
                    reason: format!(
                        "you are neither a member of {} nor the {}'s author",
                        repo.display(),
                        target.kind.noun()
                    ),
                    needs: "writer".into(),
                })
            }
        };
        let (doc_type, props) = match route {
            StateRoute::Member => (
                DOC_EVENT,
                event_props(target, close_kind(close), None, None)?,
            ),
            StateRoute::Author => (DOC_AUTHOR_EVENT, author_event_props(target, close)?),
        };
        let collab = self.collab_contract(repo).await?;
        let id = self.write(repo, &collab, doc_type, props).await?;
        Ok((route, id))
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
        let collab = self.collab_contract(repo).await?;
        let id = self.write(repo, &collab, doc_type, props).await?;
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
    pub async fn create_release(&self, repo: &RepoRef, input: &ReleaseInput) -> Result<String> {
        // release notes and assets are not encrypted in this release (§7, §12.5)
        repo.require_public("releases")?;
        if input.tag_name.is_empty() || input.tag_name.len() > 63 {
            return Err(Error::Config("a release tag is 1-63 bytes".into()));
        }
        check_len("release name", &input.name, 120)?;
        check_len("release notes", &input.notes, 5120)?;
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
        self.write(repo, &core, DOC_RELEASE, p).await
    }

    /// Every release of `repo`, newest revision per tag, newest first; `previous` holds the
    /// superseded revisions (a revoked maintainer can delete theirs, so readers fall back).
    pub async fn releases(&self, repo: &RepoRef) -> Result<(Vec<Release>, Vec<Release>)> {
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
        Ok(newest_per_tag(docs.iter().map(release_from_doc).collect()))
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
        let collab = self.collab_contract(repo).await?;
        self.write(repo, &collab, DOC_EVENT, props).await
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
    ) -> Result<bool> {
        if self.own_index_only(collab, repo, doc_type).await?.is_some() {
            return Ok(false);
        }
        let probe = || async { Ok(self.own_index_only(collab, repo, doc_type).await?.is_some()) };
        match self
            .engine()?
            .create_index_only(
                collab,
                doc_type,
                Self::with_repo(repo, BTreeMap::new())?,
                probe,
            )
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
            .create_own_index_only(&community, repo, DOC_STAR)
            .await?;
        if starred && trending {
            // The star stands whatever happens to the beat, which only feeds a ranking. A beat
            // from an earlier star of this repo makes this a no-op (one per identity and repo,
            // ever: it cannot be deleted).
            if let Err(e) = self
                .create_own_index_only(&community, repo, DOC_STAR_BEAT)
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
/// neither a pre-release nor yanked (else the first not yanked).
pub fn latest_release(current: &[Release]) -> Option<&Release> {
    current
        .iter()
        .find(|r| !r.yanked && !is_prerelease(&r.tag_name))
        .or_else(|| current.iter().find(|r| !r.yanked))
}

/// `a` vs `b`, newest revision first (`$createdAt`, then `$id`).
fn newest_first(a: &Release, b: &Release) -> std::cmp::Ordering {
    (b.created_at, &b.document_id).cmp(&(a.created_at, &a.document_id))
}

/// Split release revisions into the newest per tag (in [`release_order`]) and the rest
/// (newest first).
fn newest_per_tag(all: Vec<Release>) -> (Vec<Release>, Vec<Release>) {
    let mut by_tag: BTreeMap<String, Vec<Release>> = BTreeMap::new();
    for r in all {
        by_tag.entry(r.tag_name.clone()).or_default().push(r);
    }
    let mut current = Vec::new();
    let mut previous = Vec::new();
    for (_, mut revs) in by_tag {
        revs.sort_by(newest_first);
        let mut it = revs.into_iter();
        current.extend(it.next());
        previous.extend(it);
    }
    current.sort_by(release_order);
    previous.sort_by(newest_first);
    (current, previous)
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
    fn close_and_reopen_route_members_to_event_and_authors_to_author_event() {
        let t = target("alice");
        // A member always writes a member event, author or not.
        assert_eq!(
            state_route(Some(Role::Writer), "bob", &t),
            Some(StateRoute::Member)
        );
        assert_eq!(
            state_route(Some(Role::Maintainer), "alice", &t),
            Some(StateRoute::Member)
        );
        // The author who is not a member writes an authorEvent.
        assert_eq!(state_route(None, "alice", &t), Some(StateRoute::Author));
        // Anyone else: no gate admits them.
        assert_eq!(state_route(None, "mallory", &t), None);
    }

    #[test]
    fn event_documents_name_their_target_by_id_and_number() {
        let p = event_props(&target("a"), EventKind::LabelAdd, Some("bug"), None).unwrap();
        assert!(matches!(p.get("targetId"), Some(FieldValue::Identifier(_))));
        assert_eq!(p.get("targetNumber"), Some(&FieldValue::integer(3)));
        assert_eq!(p.get("kind"), Some(&FieldValue::integer(4)));
        assert_eq!(p.get("value"), Some(&FieldValue::text("bug")));
        assert!(!p.contains_key("repoId"), "the service adds repoId");
        // authorEvent: close = 1, reopen = 2, and nothing else.
        let a = author_event_props(&target("a"), true).unwrap();
        assert_eq!(a.get("kind"), Some(&FieldValue::integer(1)));
        assert_eq!(a.len(), 3);
        let r = author_event_props(&target("a"), false).unwrap();
        assert_eq!(r.get("kind"), Some(&FieldValue::integer(2)));
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
        // The author may resolve and move the head, never dismiss, label or merge.
        assert_eq!(
            kind_route(None, "alice", &t, EventKind::HeadUpdate),
            Some(StateRoute::Author)
        );
        for kind in [
            EventKind::ReviewDismiss,
            EventKind::LabelAdd,
            EventKind::Merge,
        ] {
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
        let p = patch_props(7, &input, None).unwrap();
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
        assert!(patch_props(7, &bad, None).is_err());
        let mut short = input.clone();
        short.head_oid = vec![1; 4];
        assert!(patch_props(7, &short, None).is_err());
        let mut untitled = input;
        untitled.title = "  ".into();
        assert!(patch_props(7, &untitled, None).is_err());
    }

    #[test]
    fn imported_provenance_rides_on_issues() {
        let imp = Imported {
            author: "octocat".into(),
            created_at: 1_600_000_000,
            url: "https://github.com/o/r/issues/1".into(),
        };
        let p = issue_props(1, "t", "b", Some(&imp)).unwrap();
        assert!(matches!(p.get("imported"), Some(FieldValue::Object(_))));
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
        let got = issue.imported.unwrap();
        assert_eq!(got.author, "octocat");
        assert_eq!(got.created_at, 1_600_000_000);
    }

    #[tokio::test]
    async fn the_contiguous_run_is_paged_to_its_first_gap() {
        // Taken above base 100: 101..=250 (a run across two full pages), then 252.
        let taken: Vec<u32> = (101..=250).chain([252, 253]).collect();
        let pages = std::sync::Mutex::new(0);
        let run = contiguous_run_above(100, 100, |after| {
            *pages.lock().unwrap() += 1;
            let rows: Vec<u32> = taken
                .iter()
                .copied()
                .filter(|n| *n > after)
                .take(100)
                .collect();
            async move { Ok(rows) }
        })
        .await
        .unwrap();
        assert_eq!(run.first(), Some(&101));
        assert_eq!(
            run.last(),
            Some(&250),
            "the run ends at the first gap (251)"
        );
        assert_eq!(run.len(), 150);
        assert_eq!(
            *pages.lock().unwrap(),
            2,
            "a second page, not stopping after one"
        );
        // The allocator, fed the run, claims the gap.
        let count = 0; // the ceiling is 100 = base
        let mut all = vec![100];
        all.extend(run);
        assert_eq!(allocate_number(count, &all, 0), Some(251));
    }

    #[tokio::test]
    async fn an_empty_probe_is_an_empty_run() {
        let run = contiguous_run_above(7, 100, |_| async { Ok(Vec::new()) })
            .await
            .unwrap();
        assert!(run.is_empty());
        // A page starting with a gap ends the run at once.
        let run = contiguous_run_above(7, 100, |_| async { Ok(vec![9, 10]) })
            .await
            .unwrap();
        assert!(run.is_empty());
    }

    #[test]
    fn numbering_trusts_the_owner_and_each_maintainer_once() {
        // The owner is trusted without a maintainer document of its own.
        assert_eq!(trusted_authors("owner", []), vec!["owner"]);
        // Duplicates, and the owner's own maintainer document, collapse.
        assert_eq!(
            trusted_authors("owner", ["m2", "owner", "m1", "m2"]),
            vec!["owner", "m1", "m2"]
        );
    }

    #[test]
    fn a_squatter_far_ahead_does_not_move_numbering() {
        // Three issues, and a squatter at 4294967295: the ceiling is 106, base 3.
        assert_eq!(allocate_number(4, &[3], 0), Some(4));
    }

    #[test]
    fn the_newest_release_per_tag_wins_and_older_ones_are_previous() {
        let rel = |tag: &str, at: u64, id: &str| Release {
            document_id: id.into(),
            tag_name: tag.into(),
            name: String::new(),
            notes: String::new(),
            yanked: false,
            assets: Vec::new(),
            publisher: "m".into(),
            created_at: at,
        };
        let (cur, prev) = newest_per_tag(vec![
            rel("v1", 1, "a"),
            rel("v1", 3, "b"),
            rel("v2", 2, "c"),
        ]);
        assert_eq!(
            cur.iter()
                .map(|r| r.document_id.as_str())
                .collect::<Vec<_>>(),
            ["c", "b"],
            "v2 before v1, by version"
        );
        assert_eq!(prev.len(), 1);
        assert_eq!(prev[0].document_id, "a");
    }

    /// L-14: the rail's "Latest release" was the OLDEST (an import writes newest-first, so
    /// the oldest release had the newest `$createdAt`). Version order, and the latest is the
    /// highest non-prerelease, as on GitHub.
    #[test]
    fn releases_are_ordered_by_version_and_the_latest_skips_prereleases() {
        let rel = |tag: &str, at: u64| Release {
            document_id: tag.into(),
            tag_name: tag.into(),
            name: String::new(),
            notes: String::new(),
            yanked: false,
            assets: Vec::new(),
            publisher: "m".into(),
            created_at: at,
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
        let ok = doc(issue_props(1, "t", "", None).unwrap());
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
        let honest = patch_props(1, &input, None).unwrap();
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
        assert!(issue_props(1, "t", &body, None).is_err());
        assert!(issue_props(1, "t", &"€".repeat(1700), None).is_ok());
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
