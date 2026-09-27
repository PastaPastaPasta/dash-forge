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

use serde::{Deserialize, Serialize};

use super::{
    check_len, check_text, doc_engine, event_kind_to_u64, insert_imported, label_from_doc,
    release_from_doc, u64_to_event_kind, CommentAnchor, Imported, Label, Release, ReleaseInput,
    Verdict, DEFAULT_PAGE,
};
use crate::backends::sha256;
use crate::create::replay_landed;
use crate::error::{Error, Result};
use crate::keystore::BridgeIdentity;
use crate::members::{self, MemberReader};
use crate::network::ForgeIds;
use crate::platform::{
    self, BroadcastOutcome, FetchedDocument, FieldValue, LoadedContract, LoadedIdentity,
    PlatformClient, QueryFilter, QueryOrder, WriteEngine, WriteIntent,
};
use crate::rules::v2::{
    allocate_number, count_approvals, fold_issue_state_v2, fold_pr_review_v2, fold_pr_state_v2,
    is_author_kind, is_well_formed, number_ceiling, Approvals, ContentDoc, ContentKind, Policy,
    PrReviewState, Review as RuleReview, Role, RoleOracle, Visibility,
};
use crate::rules::{self, Event, EventKind, IssueState, PrState};
use crate::scope::RepoRef;

/// forge-collab document types.
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
/// A branch policy (maintainer-gated).
pub const DOC_POLICY: &str = "policy";
/// A star (`indexOnly`).
pub const DOC_STAR: &str = "star";
/// forge-core: a release (maintainer-gated).
pub const DOC_RELEASE: &str = "release";
/// forge-core: a label definition (member-gated).
pub const DOC_LABEL: &str = "label";

/// Attempts at claiming a number before giving up: each collision re-reads the index, so
/// the next attempt starts above whatever took the number.
const MAX_NUMBER_ATTEMPTS: usize = 8;

/// The environment variable that turns the client-side role checks off, so a write reaches
/// consensus and is judged there (the e2e suite proves the gates this way). Shared with the
/// remote helper's push pre-check.
pub const SKIP_PRECHECK_ENV: &str = "DASH_FORGE_SKIP_WRITE_PRECHECK";

fn precheck_enabled() -> bool {
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

impl TargetKind {
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

impl Patch {
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
        EventKind::MilestoneSet if value.is_none_or(str::is_empty) => {
            return missing("a milestone name");
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

// ===========================================================================
// The service
// ===========================================================================

/// forge-v2 collaboration reads and writes for one repository at a time.
pub struct Collab<'a> {
    client: &'a PlatformClient,
    signer: Option<(&'a LoadedIdentity, &'a BridgeIdentity)>,
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
        }
    }

    /// Reads only.
    pub fn reader(client: &'a PlatformClient) -> Self {
        Self {
            client,
            signer: None,
        }
    }

    /// The signer's identity id.
    pub fn signer_id(&self) -> Result<String> {
        Ok(self.signer()?.0.id())
    }

    fn signer(&self) -> Result<(&'a LoadedIdentity, &'a BridgeIdentity)> {
        self.signer
            .ok_or_else(|| Error::Config("this operation signs; no identity was given".into()))
    }

    fn engine(&self) -> Result<WriteEngine<'a>> {
        let (identity, bridge) = self.signer()?;
        doc_engine(self.client, identity, bridge)
    }

    /// The forge-v2 contracts of `repo`, refusing private repos.
    fn forge(repo: &RepoRef) -> Result<&ForgeIds> {
        repo.require_public("issues, pull requests and releases")?;
        Ok(repo.forge())
    }

    async fn collab_contract(&self, repo: &RepoRef) -> Result<LoadedContract> {
        self.client.fetch_contract(&Self::forge(repo)?.collab).await
    }

    async fn core_contract(&self, repo: &RepoRef) -> Result<LoadedContract> {
        self.client.fetch_contract(&Self::forge(repo)?.core).await
    }

    fn repo_filter(repo: &RepoRef) -> Result<QueryFilter> {
        Ok(QueryFilter::eq(
            "repoId",
            FieldValue::identifier(platform::decode_identifier(repo.id())?),
        ))
    }

    fn with_repo(
        repo: &RepoRef,
        mut props: BTreeMap<String, FieldValue>,
    ) -> Result<BTreeMap<String, FieldValue>> {
        props.insert(
            "repoId".to_string(),
            FieldValue::identifier(platform::decode_identifier(repo.id())?),
        );
        Ok(props)
    }

    fn visibility(repo: &RepoRef) -> Visibility {
        repo.visibility
    }

    /// Create one document of `repo` (its `repoId` added) in `contract`, as the signer.
    async fn write(
        &self,
        repo: &RepoRef,
        contract: &LoadedContract,
        doc_type: &str,
        props: BTreeMap<String, FieldValue>,
    ) -> Result<String> {
        self.engine()?
            .create_document(contract, doc_type, Self::with_repo(repo, props)?)
            .await
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

    /// Issue `number` of `repo`, if it exists and is well-formed.
    pub async fn issue(&self, repo: &RepoRef, number: u32) -> Result<Option<Issue>> {
        Ok(self
            .target_doc(repo, TargetKind::Issue, number)
            .await?
            .filter(|d| well_formed(ContentKind::Issue, d, Self::visibility(repo)))
            .map(|d| issue_from_doc(&d)))
    }

    /// Pull request `number` of `repo`, if it exists and is well-formed.
    pub async fn patch(&self, repo: &RepoRef, number: u32) -> Result<Option<Patch>> {
        Ok(self
            .target_doc(repo, TargetKind::Patch, number)
            .await?
            .filter(|d| well_formed(ContentKind::Patch, d, Self::visibility(repo)))
            .map(|d| patch_from_doc(&d)))
    }

    /// The newest `limit` well-formed issues or patches of `repo` (`$createdAt`
    /// descending), and how many malformed ones were skipped on the way.
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
        let total = docs.len();
        let more = total >= limit as usize;
        let shown: Vec<FetchedDocument> = docs
            .into_iter()
            .filter(|d| well_formed(content, d, Self::visibility(repo)))
            .collect();
        Ok(Listed {
            hidden: total - shown.len(),
            more,
            rows: shown,
        })
    }

    /// The newest `limit` issues (0 = one page of 100), newest first.
    pub async fn list_issues(&self, repo: &RepoRef, limit: u32) -> Result<Listed<Issue>> {
        Ok(self
            .newest(repo, TargetKind::Issue, limit)
            .await?
            .map(|d| issue_from_doc(&d)))
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
        Ok(docs.iter().map(patch_from_doc).collect())
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
        let author_events = self
            .by_target(&collab, DOC_AUTHOR_EVENT, "targetId", target_id)
            .await?;
        Ok(TargetLog {
            events: events.iter().filter_map(event_from_doc).collect(),
            author_events: author_events.iter().filter_map(event_from_doc).collect(),
        })
    }

    /// Every well-formed comment on a target, oldest first.
    pub async fn comments(&self, repo: &RepoRef, target_id: &str) -> Result<Vec<Comment>> {
        let collab = self.collab_contract(repo).await?;
        Ok(self
            .by_target(&collab, DOC_COMMENT, "targetId", target_id)
            .await?
            .iter()
            .filter(|d| well_formed(ContentKind::Comment, d, Self::visibility(repo)))
            .map(comment_from_doc)
            .collect())
    }

    /// Every well-formed review on a patch, oldest first.
    pub async fn reviews(&self, repo: &RepoRef, patch_id: &str) -> Result<Vec<Review>> {
        let collab = self.collab_contract(repo).await?;
        Ok(self
            .by_target(&collab, DOC_REVIEW, "patchId", patch_id)
            .await?
            .iter()
            .filter(|d| well_formed(ContentKind::Review, d, Self::visibility(repo)))
            .map(review_from_doc)
            .collect())
    }

    // --- reads: folded state --------------------------------------------------------

    /// An issue's state (§3 fold).
    pub async fn issue_state(&self, repo: &RepoRef, issue: &Issue) -> Result<IssueState> {
        let log = self.target_log(repo, &issue.document_id).await?;
        Ok(fold_issue_state_v2(
            &log.events,
            &log.author_events,
            &issue.author,
        ))
    }

    /// The issue and its state, or `None`.
    pub async fn issue_view(&self, repo: &RepoRef, number: u32) -> Result<Option<IssueView>> {
        let Some(issue) = self.issue(repo, number).await? else {
            return Ok(None);
        };
        let state = self.issue_state(repo, &issue).await?;
        Ok(Some(IssueView { issue, state }))
    }

    /// The base ref as merge verification sees it ([`rules::merge_base_tips`]): every oid it
    /// has validly pointed at (the monotonic merge-reachability set, the same one forge-web
    /// uses), its newest tip and where it points now. A plain `refUpdate` on a protected
    /// branch is inert (§4) and contributes nothing.
    pub async fn base_ref_tips(
        &self,
        repo: &RepoRef,
        base_ref_name: &str,
    ) -> Result<rules::MergeBaseTips> {
        let core = self.core_contract(repo).await?;
        crate::refs::read_merge_base(self.client, &core, &repo.scope()?, base_ref_name).await
    }

    /// A pull request's state (§3 fold; a merge counts once its oid has been a base tip), its
    /// current head (the review fold's) and review state.
    pub async fn patch_view(&self, repo: &RepoRef, patch: Patch) -> Result<PatchView> {
        let log = self.target_log(repo, &patch.document_id).await?;
        let base = self.base_ref_tips(repo, &patch.base_ref_name).await?;
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
        Ok(PatchView {
            patch,
            state,
            head,
            review,
            base_tip: base.current,
            head_on_base,
            base_tips: base.historical.into_iter().collect(),
            log,
        })
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
        Ok((
            count_approvals(&rule, oracle, &view.head, &view.dismissed()),
            reviews,
        ))
    }

    /// The branch policy in force: the newest `policy` of `repo` by `($createdAt, $id)`
    /// (forge-v2.md §2), or `None`.
    pub async fn policy(&self, repo: &RepoRef) -> Result<Option<Policy>> {
        let collab = self.collab_contract(repo).await?;
        let docs = self
            .client
            .query_all_documents(
                &collab,
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
            .map(patch_from_doc)
            .filter(|p| p.source_ref_name.as_deref() == Some(source_ref_name))
            .collect())
    }

    // --- numbering --------------------------------------------------------------------

    /// The number a new issue or PR would claim now (§6).
    pub async fn next_number(&self, repo: &RepoRef, kind: TargetKind) -> Result<u32> {
        let collab = self.collab_contract(repo).await?;
        let repo_filter = Self::repo_filter(repo)?;
        let count = self
            .client
            .count_documents(&collab, kind.doc_type(), std::slice::from_ref(&repo_filter))
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
            .map_or(0, number_of);
        let mut taken = vec![base];
        // Below the ceiling `base + 1` is free by construction; only a base AT the ceiling
        // can have squatters directly above it, and the probe steps over the whole run.
        if u64::from(base) == ceiling && base > 0 {
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
        allocate_number(count, &taken).ok_or_else(|| {
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
        let path = create_journal_path(
            journal_dir,
            &self.client.target().network.key(),
            repo.id(),
            kind,
            &me,
            fingerprint,
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
        for attempt in 0..MAX_NUMBER_ATTEMPTS {
            let number = self.next_number(repo, kind).await?.max(floor);
            let all = Self::with_repo(repo, props(number)?)?;
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
        if body.trim().is_empty() {
            return Err(Error::Config("a comment needs a body".into()));
        }
        check_text("comment body", body, 5120, 5120)?;
        let collab = self.collab_contract(repo).await?;
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
        if !(1..=3).contains(&verdict.code()) {
            return Err(Error::Config(format!("unknown verdict {}", verdict.code())));
        }
        check_text("review body", body, 5120, 5120)?;
        let collab = self.collab_contract(repo).await?;
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
        self.write(repo, &collab, DOC_REVIEW, p).await
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
        let collab = self.collab_contract(repo).await?;
        self.write(repo, &collab, DOC_POLICY, props).await
    }

    // --- releases and labels (forge-core) ---------------------------------------------------

    /// Publish (or supersede) a release. Maintainer-only at consensus.
    pub async fn create_release(&self, repo: &RepoRef, input: &ReleaseInput) -> Result<String> {
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
        let collab = self.collab_contract(repo).await?;
        self.client
            .count_documents(&collab, DOC_STAR, &[Self::repo_filter(repo)?])
            .await
    }

    /// The signer's star on `repo`, if any (the `byOwner` index, `repoId` its terminal).
    async fn own_star(
        &self,
        collab: &LoadedContract,
        repo: &RepoRef,
    ) -> Result<Option<FetchedDocument>> {
        let me = platform::decode_identifier(&self.signer_id()?)?;
        let docs = self
            .client
            .query_documents(
                collab,
                DOC_STAR,
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

    /// Whether the signer has starred `repo`.
    pub async fn is_starred(&self, repo: &RepoRef) -> Result<bool> {
        let collab = self.collab_contract(repo).await?;
        Ok(self.own_star(&collab, repo).await?.is_some())
    }

    /// Star `repo`. Returns `false` when it was already starred (nothing written).
    pub async fn star(&self, repo: &RepoRef) -> Result<bool> {
        let collab = self.collab_contract(repo).await?;
        if self.own_star(&collab, repo).await?.is_some() {
            return Ok(false);
        }
        // indexOnly: a star has no stored row, so a spent nonce is settled by looking for
        // this identity's star, not by reading the (row-less) document id back.
        let probe = || async { Ok(self.own_star(&collab, repo).await?.is_some()) };
        match self
            .engine()?
            .create_index_only(
                &collab,
                DOC_STAR,
                Self::with_repo(repo, BTreeMap::new())?,
                probe,
            )
            .await
        {
            Ok(_) => Ok(true),
            // One star per (repo, identity) is structural: a concurrent star won.
            Err(Error::DuplicateUniqueIndex(_)) => Ok(false),
            Err(e) => Err(e),
        }
    }

    /// Unstar `repo` (the values-carrying `indexOnly` delete). Returns `false` when it was
    /// not starred.
    pub async fn unstar(&self, repo: &RepoRef) -> Result<bool> {
        let collab = self.collab_contract(repo).await?;
        let Some(star) = self.own_star(&collab, repo).await? else {
            return Ok(false);
        };
        let engine = self.engine()?;
        for _ in 0..2 {
            let values = Self::with_repo(repo, BTreeMap::new())?;
            match engine
                .delete_with_values(&collab, DOC_STAR, &star.id, values, None)
                .await
            {
                Ok(BroadcastOutcome::NonceConsumed) => {
                    // Our delete landed earlier, or another write by this identity took the
                    // nonce: the star's presence says which.
                    if self.own_star(&collab, repo).await?.is_none() {
                        return Ok(true);
                    }
                    tracing::warn!("another write took the unstar's nonce; re-preparing");
                }
                Ok(_) => return Ok(true),
                // Already gone (another process unstarred it first).
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
    }
}

fn is_hex_color(c: &str) -> bool {
    c.len() == 7 && c.starts_with('#') && c[1..].bytes().all(|b| b.is_ascii_hexdigit())
}

/// Split release revisions into the newest per tag (newest first) and the rest.
fn newest_per_tag(all: Vec<Release>) -> (Vec<Release>, Vec<Release>) {
    let mut by_tag: BTreeMap<String, Vec<Release>> = BTreeMap::new();
    for r in all {
        by_tag.entry(r.tag_name.clone()).or_default().push(r);
    }
    let mut current = Vec::new();
    let mut previous = Vec::new();
    for (_, mut revs) in by_tag {
        revs.sort_by(|a, b| (b.created_at, &b.document_id).cmp(&(a.created_at, &a.document_id)));
        let mut it = revs.into_iter();
        current.extend(it.next());
        previous.extend(it);
    }
    current.sort_by(|a, b| (b.created_at, &b.document_id).cmp(&(a.created_at, &a.document_id)));
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

/// The journal of one pending create: per network, repo, kind, signer and content, so the
/// same command re-run resumes it and a different one does not.
fn create_journal_path(
    dir: &Path,
    network: &str,
    repo_id: &str,
    kind: TargetKind,
    signer: &str,
    fingerprint: &str,
) -> PathBuf {
    let digest = hex::encode(sha256(fingerprint.as_bytes()));
    dir.join(format!(
        "{}-{network}-{repo_id}-{signer}-{}.json",
        kind.doc_type(),
        &digest[..16]
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target(author: &str) -> Target {
        Target {
            kind: TargetKind::Issue,
            id: "GM7ozWV1MNuAxyMnrf4JngAyGSDickvLznGi72WMp8EL".into(),
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
    fn review_events_carry_their_payload_and_route_by_kind() {
        let t = target("alice");
        let root = "GM7ozWV1MNuAxyMnrf4JngAyGSDickvLznGi72WMp8EL";
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
            source_repo_id: "GM7ozWV1MNuAxyMnrf4JngAyGSDickvLznGi72WMp8EL".into(),
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
        assert_eq!(allocate_number(count, &all), Some(251));
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
    fn a_squatter_far_ahead_does_not_move_numbering() {
        // Three issues, and a squatter at 4294967295: the ceiling is 106, base 3.
        assert_eq!(allocate_number(4, &[3]), Some(4));
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
            ["b", "c"]
        );
        assert_eq!(prev.len(), 1);
        assert_eq!(prev[0].document_id, "a");
    }

    #[test]
    fn journals_are_keyed_by_content() {
        let d = Path::new("/j");
        let a = create_journal_path(d, "n", "R", TargetKind::Issue, "me", "t\0b");
        assert_eq!(
            a,
            create_journal_path(d, "n", "R", TargetKind::Issue, "me", "t\0b")
        );
        assert_ne!(
            a,
            create_journal_path(d, "n", "R", TargetKind::Issue, "me", "t\0c")
        );
        assert_ne!(
            a,
            create_journal_path(d, "n", "R", TargetKind::Patch, "me", "t\0b")
        );
        assert_ne!(
            a,
            create_journal_path(d, "n", "R", TargetKind::Issue, "you", "t\0b")
        );
    }

    #[test]
    fn well_formedness_skips_ciphertext_in_a_public_repo() {
        let doc = |fields: BTreeMap<String, FieldValue>| FetchedDocument {
            id: "x".into(),
            owner_id: "o".into(),
            created_at: Some(1),
            created_at_block_height: None,
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
            source_repo_id: "GM7ozWV1MNuAxyMnrf4JngAyGSDickvLznGi72WMp8EL".into(),
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
