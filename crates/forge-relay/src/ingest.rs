//! Ingest: poll a forge-v2 repository's documents and translate them into GitHub-shaped
//! [`WebhookEvent`]s (PRD 05 §Ingest/§Translate). Platform has no document push
//! subscriptions, so each source is a **stream**: an index that ends in `$createdAt`, with
//! its leading properties pinned by equality, read in ascending order past a cursor.
//!
//! | Stream | Contract | Index (pinned prefix) | GitHub event |
//! |---|---|---|---|
//! | `refUpdate`, `protectedRefUpdate` | forge-core | `reflog (repoId)` | `push` |
//! | `release` | forge-core | `created (repoId)` | `release` published |
//! | `issue` | forge-collab | `created (repoId)` | `issues` opened |
//! | `patch` | forge-collab | `created (repoId)` | `pull_request` opened |
//! | `transition` | forge-collab | `feed (repoId)` | `issues` / `pull_request` closed, reopened, merged, draft, ready, locked, unlocked |
//! | `event`, `authorEvent` | forge-community (RC1) | `feed (repoId)` | `issues` / `pull_request` labeled, assigned, synchronize, ... |
//! | `comment` | forge-collab | `target (targetId)`, per issue/PR | `issue_comment` created |
//! | `review` | forge-collab | `patch (patchId)`, per PR | `pull_request_review` submitted |
//! | `checkRun` | forge-community | `head (repoId, headOid)`, per head seen; not a cursor stream: re-read from the oldest open run and compared by `$revision` ([`crate::checkruns`]) | `check_run` created, completed |
//!
//! ## Cursors
//!
//! Not persisted (only the check runs seen are, [`crate::checkruns`]). A stream's first read
//! establishes its baseline ([`Baseline`]):
//!
//! * [`Baseline::Tail`] (repos found at startup): the newest document becomes the cursor and
//!   nothing older is delivered, except the last `lookback` documents when one is configured.
//! * [`Baseline::Since`] (repos whose first hook appears while running): every document with
//!   `$createdAt` at or after the hook's own is delivered, so activity between writing the hook
//!   and the relay noticing it (up to one refresh interval) is not lost.
//! * [`Baseline::Beginning`] (the comment/review stream of an issue or PR created while
//!   running): everything, since all of it is new.
//!
//! After that the cursor is `(t, seen)`: the newest `$createdAt` delivered and the ids already
//! delivered at exactly `t`. Each read asks for `$createdAt >= t` in ascending order and drops
//! the `seen` ids. No document id is carried from one cycle to the next as a `start_after`:
//! `comment`, `review`, `checkRun` and `release` are deletable (and anyone can comment), and
//! Drive answers a `start_after` naming a deleted document with `StartDocumentNotFound`, which
//! would stop the stream for good. `start_after` is used only between pages of one read, on a
//! document fetched a moment earlier; if even that fails, the read fails and is retried from
//! `t` next cycle. A failed read leaves the cursor where it was: a document can be delivered
//! more than once, and consumers dedupe on `X-GitHub-Delivery`. Every forge-v2 type requires `$createdAt`, and a
//! proved v2 read returns it; a document without one is skipped.
//!
//! The `translate_*` functions are pure (`FetchedDocument` → [`WebhookEvent`]) and tested
//! offline.

use std::collections::{BTreeMap, BTreeSet};

use forge_core::platform::{
    encode_identifier, FetchedDocument, FieldValue, LoadedContract, PlatformClient, QueryFilter,
    QueryOp, QueryOrder,
};
use forge_core::refs::ref_update_from_doc;
use forge_core::rules::{self, ConfigDoc};

use crate::error::Result;
use crate::payload::{
    check_run_event, is_zero_oid, issue_comment_event, issues_event, pull_request_event,
    pull_request_review_event, push_event, release_event, CheckRunAction, CheckRunObj, IssueObj,
    PullRequestObj, ReleaseObj, RepositoryMeta, WebhookEvent,
};

/// forge-core document types the relay reads.
pub const DOC_REF_UPDATE: &str = "refUpdate";
/// Maintainer-only ref updates (protected refs).
pub const DOC_PROTECTED_REF_UPDATE: &str = "protectedRefUpdate";
/// Releases.
pub const DOC_RELEASE: &str = "release";
/// forge-collab document types the relay reads.
pub const DOC_ISSUE: &str = "issue";
/// Pull requests.
pub const DOC_PATCH: &str = "patch";
/// Member events (labels, assignees, retarget, review kinds, ...): forge-community in RC1.
pub const DOC_EVENT: &str = "event";
/// Author events (thread resolution, review requests, head updates): forge-community in RC1.
pub const DOC_AUTHOR_EVENT: &str = "authorEvent";
/// State changes (close, reopen, merge, draft, ready): one legal move each.
pub const DOC_TRANSITION: &str = "transition";
/// Comments on an issue or PR.
pub const DOC_COMMENT: &str = "comment";
/// PR reviews.
pub const DOC_REVIEW: &str = "review";
/// CI check runs.
pub const DOC_CHECK_RUN: &str = "checkRun";

/// Rows per page (Drive's maximum).
const PAGE: u32 = 100;

/// Where a stream starts on its first read. See the module docs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Baseline {
    /// At the current newest document, replaying the last `lookback` (0..=100).
    Tail {
        /// Documents to replay.
        lookback: u32,
    },
    /// Every document with `$createdAt >= since` (ms).
    Since(u64),
    /// Every document.
    Beginning,
}

/// One stream's position: see the module docs.
#[derive(Debug, Clone)]
pub struct Cursor {
    baseline: Baseline,
    primed: bool,
    /// The newest `$createdAt` delivered (or the baseline's).
    since: Option<u64>,
    /// Ids already delivered (or baselined) at exactly `since`.
    seen: BTreeSet<String>,
}

impl Cursor {
    /// A fresh cursor that starts at `baseline`.
    pub fn new(baseline: Baseline) -> Self {
        Self {
            baseline,
            primed: false,
            since: match baseline {
                Baseline::Since(ts) => Some(ts),
                _ => None,
            },
            seen: BTreeSet::new(),
        }
    }

    /// A `Tail { lookback }` cursor primed from `newest_first`, the stream's newest documents
    /// (a descending page, or a complete list reversed): all of them count as seen except the
    /// newest `lookback`, which the next read returns (with anything written since). Priming
    /// from the same read that built a repo's state leaves no gap between the two.
    pub fn primed(newest_first: &[FetchedDocument], lookback: u32) -> Self {
        let lookback = lookback as usize;
        let mut c = Self {
            baseline: Baseline::Tail {
                lookback: u32::try_from(lookback).unwrap_or(u32::MAX),
            },
            primed: true,
            since: None,
            seen: BTreeSet::new(),
        };
        match newest_first.get(lookback) {
            Some(first_skipped) => {
                c.since = first_skipped.created_at;
                c.seen = newest_first[lookback..]
                    .iter()
                    .filter(|d| d.created_at == c.since)
                    .map(|d| d.id.clone())
                    .collect();
            }
            // Everything is replayed. A full page may not be the whole history: start at its
            // oldest document rather than the beginning of time.
            None if newest_first.len() >= PAGE as usize => {
                c.since = newest_first.last().and_then(|d| d.created_at);
            }
            None => {}
        }
        c
    }

    /// Record `d` as delivered, returning whether it is new.
    fn advance(&mut self, d: &FetchedDocument) -> bool {
        let Some(t) = d.created_at else {
            return false;
        };
        match self.since {
            Some(s) if t < s => false,
            Some(s) if t == s => self.seen.insert(d.id.clone()),
            _ => {
                self.since = Some(t);
                self.seen = BTreeSet::from([d.id.clone()]);
                true
            }
        }
    }
}

/// One page of a stream: `(since, order_ascending, limit, start_after)` → documents. The live
/// implementation is [`poll_stream`]'s; tests supply an in-memory one.
pub trait PageSource {
    /// Read one page: `$createdAt >= since` when given, ordered by `$createdAt`.
    fn page(
        &self,
        since: Option<u64>,
        ascending: bool,
        limit: u32,
        start_after: Option<&str>,
    ) -> impl std::future::Future<Output = Result<Vec<FetchedDocument>>>;
}

/// A stream over a live index: `prefix` pins the leading properties of an index that ends in
/// `$createdAt`.
pub struct LiveStream<'a> {
    /// The client.
    pub client: &'a PlatformClient,
    /// The contract that holds `doc_type` (forge-core, forge-collab or forge-community).
    pub contract: &'a LoadedContract,
    /// The document type.
    pub doc_type: &'a str,
    /// The pinned index prefix.
    pub prefix: &'a [QueryFilter],
}

impl PageSource for LiveStream<'_> {
    async fn page(
        &self,
        since: Option<u64>,
        ascending: bool,
        limit: u32,
        start_after: Option<&str>,
    ) -> Result<Vec<FetchedDocument>> {
        let mut filters = self.prefix.to_vec();
        if let Some(ts) = since {
            filters.push(QueryFilter {
                field: "$createdAt".into(),
                op: QueryOp::Gte,
                value: forge_core::platform::FieldValue::uint64(ts),
            });
        }
        let order = if ascending {
            QueryOrder::asc("$createdAt")
        } else {
            QueryOrder::desc("$createdAt")
        };
        Ok(self
            .client
            .query_documents(
                self.contract,
                self.doc_type,
                &filters,
                &[order],
                limit,
                start_after,
            )
            .await?)
    }
}

/// Read the documents of one stream that are new since `cursor`, advancing a copy of it; the
/// caller commits the copy only when the read succeeded (see the module docs).
pub async fn poll_stream(
    source: &impl PageSource,
    cursor: &mut Cursor,
) -> Result<Vec<FetchedDocument>> {
    if let (false, Baseline::Tail { lookback }) = (cursor.primed, cursor.baseline) {
        // The newest page, descending (no cursor, which every protocol proves). Everything in
        // it is baselined except the newest `lookback`, which the read below returns.
        let tail = source.page(None, false, PAGE, None).await?;
        *cursor = Cursor::primed(&tail, lookback);
    }

    let mut out = Vec::new();
    let mut start_after: Option<String> = None;
    loop {
        let page = source
            .page(cursor.since, true, PAGE, start_after.as_deref())
            .await?;
        let full = page.len() >= PAGE as usize;
        start_after = page.last().map(|d| d.id.clone());
        for d in page {
            if cursor.advance(&d) {
                out.push(d);
            }
        }
        if !full {
            break;
        }
    }
    cursor.primed = true;
    Ok(out)
}

/// What an `event`/`comment`/`review` `targetId` points at: enough to fill the embedded
/// issue or PR object without a fetch per event.
#[derive(Debug, Clone)]
pub struct TargetInfo {
    /// Whether the target is a pull request (`patch`) rather than an issue.
    pub is_pr: bool,
    /// The issue/PR number.
    pub number: u64,
    /// The author identity id.
    pub author: String,
    /// The title (empty in a private repo: it is inside `enc`).
    pub title: String,
    /// The base ref (PRs only).
    pub base_ref: String,
    /// The PR's current head (PRs only, hex): the newest `headUpdate` seen
    /// ([`TargetInfo::apply_head_update`]), else the head it was opened with.
    pub head_oid: String,
    /// The `($createdAt, $id)` of the `headUpdate` that set [`Self::head_oid`], if any: a head
    /// update applies only when newer, so the order the event and authorEvent streams are read
    /// in cannot move the head back (forge-core `fold_pr_review_v2` orders both as one log).
    pub head_set_by: Option<(u64, String)>,
    /// `baseRefNameHash` (PRs only, hex): the ref a merge must land on; after a retarget,
    /// `sha256` of the retarget's base ([`TargetInfo::apply_retarget`]).
    pub base_ref_hash: String,
    /// The retargets (event kind 8) seen, as `($createdAt, $id, base)`, in that order: the
    /// newest is [`Self::base_ref`]; a merge is judged against the newest written by then
    /// ([`TargetInfo::merge_base_at`], forge-core `pr_merge_base`).
    pub retargets: Vec<(u64, String, String)>,
    /// The base the PR was opened against (`baseRefName`, `baseRefNameHash`), once a retarget
    /// moved [`Self::base_ref`] off it.
    pub opened_base: Option<(String, String)>,
    /// Where this target's comment and review streams start.
    pub baseline: Baseline,
    /// The newest `$createdAt` seen on the target or anything about it (ms).
    pub last_activity: u64,
    /// A draft PR now (its state code at startup, then each transition seen).
    pub draft: bool,
    /// A merged PR (terminal: its state code at startup, or a `PR_MERGE` transition seen
    /// since). Kept so a later lock/unlock on an already-merged PR reports `merged: true`
    /// rather than the lock/unlock's own hardcoded `false` ([`translate_transition`]).
    pub merged: bool,
}

impl TargetInfo {
    /// From an `issue` document.
    pub fn from_issue(d: &FetchedDocument, baseline: Baseline) -> Self {
        Self {
            is_pr: false,
            number: d.field_u64("number").unwrap_or_default(),
            author: d.owner_id.clone(),
            title: d.field_str("title").unwrap_or_default(),
            base_ref: String::new(),
            head_oid: String::new(),
            head_set_by: None,
            base_ref_hash: String::new(),
            retargets: Vec::new(),
            opened_base: None,
            baseline,
            last_activity: d.created_at.unwrap_or(0),
            draft: false,
            merged: false,
        }
    }

    /// From a `patch` (PR) document.
    pub fn from_patch(d: &FetchedDocument, baseline: Baseline) -> Self {
        Self {
            is_pr: true,
            number: d.field_u64("number").unwrap_or_default(),
            author: d.owner_id.clone(),
            title: d.field_str("title").unwrap_or_default(),
            base_ref: d.field_str("baseRefName").unwrap_or_default(),
            head_oid: d.field_hex("headOid").unwrap_or_default(),
            head_set_by: None,
            base_ref_hash: d.field_hex("baseRefNameHash").unwrap_or_default(),
            retargets: Vec::new(),
            opened_base: None,
            baseline,
            last_activity: d.created_at.unwrap_or(0),
            draft: false,
            merged: false,
        }
    }

    /// Apply a `headUpdate` (kind 16) document — from a member (`event`) or the PR's author
    /// (`authorEvent`, the author path of forge's review fold) — whose `oid` is a 40/64-hex
    /// commit id (forge-core `fold_pr_review_v2`) and which is newer by `($createdAt, $id)` than
    /// the update that set the current head. Returns the new head when it moved. Any order of
    /// application gives the fold's head.
    pub fn apply_head_update(&mut self, d: &FetchedDocument, author_path: bool) -> Option<String> {
        if !self.is_pr
            || d.field_u64("kind") != Some(16)
            || (author_path && d.owner_id != self.author)
        {
            return None;
        }
        let oid = d.field_hex("oid").filter(|o| matches!(o.len(), 40 | 64))?;
        let key = (d.created_at.unwrap_or(0), d.id.clone());
        if self.head_set_by.as_ref().is_some_and(|k| *k >= key) {
            return None;
        }
        self.head_set_by = Some(key);
        (oid != self.head_oid).then(|| {
            self.head_oid.clone_from(&oid);
            oid
        })
    }

    /// Apply a retarget (member `event` kind 8) whose `value` is a legal ref name: the PR now
    /// merges into the newest one by `($createdAt, $id)` (forge-core `pr_merge_base`), whatever
    /// order they are read in. Returns the base it was retargeted from when it moved. A caller
    /// that has seen the PR's merge applies no later retarget (a merged PR's base is where it
    /// was merged, [`Self::settle_merge`]).
    pub fn apply_retarget(&mut self, d: &FetchedDocument) -> Option<String> {
        if !self.is_pr || d.field_u64("kind") != Some(8) {
            return None;
        }
        let value = d
            .field_str("value")
            .filter(|v| rules::is_legal_ref_name(v))?;
        let entry = (d.created_at.unwrap_or(0), d.id.clone(), value);
        if self.retargets.contains(&entry) {
            return None;
        }
        if self.opened_base.is_none() {
            self.opened_base = Some((self.base_ref.clone(), self.base_ref_hash.clone()));
        }
        self.retargets.push(entry);
        self.retargets.sort();
        let (newest, hash) = self.merge_base_at(u64::MAX);
        if newest == self.base_ref {
            return None;
        }
        self.base_ref_hash = hash;
        Some(std::mem::replace(&mut self.base_ref, newest))
    }

    /// The base a merge written at `at` is judged against, and its ref-name hash: the newest
    /// retarget written by then, else the base the PR was opened against.
    #[must_use]
    pub fn merge_base_at(&self, at: u64) -> (String, String) {
        match self.retargets.iter().rev().find(|(t, _, _)| *t <= at) {
            Some((_, _, base)) => (
                base.clone(),
                hex::encode(<sha2::Sha256 as sha2::Digest>::digest(base.as_bytes())),
            ),
            None => self
                .opened_base
                .clone()
                .unwrap_or_else(|| (self.base_ref.clone(), self.base_ref_hash.clone())),
        }
    }

    /// A merge written at `at` was seen: the PR's base is where it was merged, whatever a
    /// later retarget read in the same poll said.
    pub fn settle_merge(&mut self, at: u64) {
        (self.base_ref, self.base_ref_hash) = self.merge_base_at(at);
    }

    /// Every base ref hash a merge of this PR may be judged against (its current base and every
    /// retarget's), for the tips to track.
    #[must_use]
    pub fn base_hashes(&self) -> Vec<String> {
        let mut out = vec![self.base_ref_hash.to_ascii_lowercase()];
        if let Some((_, h)) = &self.opened_base {
            out.push(h.to_ascii_lowercase());
        }
        out.extend(
            self.retargets
                .iter()
                .map(|(_, _, b)| hex::encode(<sha2::Sha256 as sha2::Digest>::digest(b.as_bytes()))),
        );
        out
    }

    fn issue_obj(&self, id: &str, open: bool) -> IssueObj {
        IssueObj {
            number: self.number,
            document_id: id.to_string(),
            author: self.author.clone(),
            title: self.title.clone(),
            body: String::new(),
            open,
            is_pr: self.is_pr,
        }
    }

    fn pr_obj(&self, id: &str, open: bool, merged: bool) -> PullRequestObj {
        PullRequestObj {
            number: self.number,
            document_id: id.to_string(),
            author: self.author.clone(),
            title: self.title.clone(),
            body: String::new(),
            base_ref: self.base_ref.clone(),
            head_oid: self.head_oid.clone(),
            open,
            merged,
            draft: self.draft,
        }
    }
}

/// A 32-byte identifier field as base58.
fn id_field(d: &FetchedDocument, field: &str) -> Option<String> {
    d.field_bytes32(field).map(encode_identifier)
}

// ===========================================================================
// Pure translations (unit-tested offline)
// ===========================================================================

/// Whether a ref-update document moves its ref by forge's own rule
/// (`forge_core::rules::is_update_valid`): a legal `refName` that hashes to its `refNameHash`,
/// and a `protectedRefUpdate` when the config in force at its `$createdAt` protects the ref.
/// A plain `refUpdate` on a protected ref is inert and must not be reported as a push.
pub fn ref_update_is_valid(d: &FetchedDocument, protected: bool, configs: &[ConfigDoc]) -> bool {
    let Some(hash) = d.field_hex("refNameHash") else {
        return false;
    };
    d.field_str("refName").is_some()
        && rules::is_update_valid(&ref_update_from_doc(d, &hash, protected), configs)
}

/// A `refUpdate` / `protectedRefUpdate` → `push`. `None` for a private repo's update (its
/// `refName` is inside `enc`). Check [`ref_update_is_valid`] first.
pub fn translate_ref_update(repo: &RepositoryMeta, d: &FetchedDocument) -> Option<WebhookEvent> {
    let ref_name = d.field_str("refName")?;
    Some(push_event(
        repo,
        &d.id,
        &ref_name,
        &d.field_hex("prevOid").unwrap_or_default(),
        &d.field_hex("newOid").unwrap_or_default(),
        d.field_bool("force"),
        &d.owner_id,
    ))
}

/// Whether a ref update deletes its ref (all-zero or absent `newOid`).
pub fn is_ref_deletion(d: &FetchedDocument) -> bool {
    d.field_hex("newOid").is_none_or(|o| is_zero_oid(&o))
}

/// An `issue` → `issues` opened.
pub fn translate_issue(repo: &RepositoryMeta, d: &FetchedDocument) -> Option<WebhookEvent> {
    let issue = IssueObj {
        number: d.field_u64("number")?,
        document_id: d.id.clone(),
        author: d.owner_id.clone(),
        title: d.field_str("title").unwrap_or_default(),
        body: d.field_str("body").unwrap_or_default(),
        open: true,
        is_pr: false,
    };
    Some(issues_event(repo, &d.id, "opened", &issue))
}

/// A `patch` → `pull_request` opened.
pub fn translate_patch(repo: &RepositoryMeta, d: &FetchedDocument) -> Option<WebhookEvent> {
    let pr = PullRequestObj {
        number: d.field_u64("number")?,
        document_id: d.id.clone(),
        author: d.owner_id.clone(),
        title: d.field_str("title").unwrap_or_default(),
        body: d.field_str("body").unwrap_or_default(),
        base_ref: d.field_str("baseRefName").unwrap_or_default(),
        head_oid: d.field_hex("headOid").unwrap_or_default(),
        open: true,
        merged: false,
        draft: false,
    };
    Some(pull_request_event(repo, &d.id, "opened", &pr))
}

/// A `comment` → `issue_comment` created. An unknown target yields a minimal stub.
pub fn translate_comment(
    repo: &RepositoryMeta,
    d: &FetchedDocument,
    targets: &BTreeMap<String, TargetInfo>,
) -> Option<WebhookEvent> {
    let target_id = id_field(d, "targetId")?;
    let issue = targets.get(&target_id).map_or_else(
        || IssueObj {
            number: 0,
            document_id: target_id.clone(),
            author: String::new(),
            title: String::new(),
            body: String::new(),
            open: true,
            is_pr: false,
        },
        |t| t.issue_obj(&target_id, true),
    );
    Some(issue_comment_event(
        repo,
        &d.id,
        &issue,
        &d.id,
        &d.owner_id,
        &d.field_str("body").unwrap_or_default(),
    ))
}

/// A `review` → `pull_request_review` submitted. Needs its PR in `targets`. Its embedded PR's
/// `open`/`merged` are the relay's last-seen fold (`closed`) and [`TargetInfo::merged`], same
/// as [`translate_event`] -- a review carries no fold of its own either.
pub fn translate_review(
    repo: &RepositoryMeta,
    d: &FetchedDocument,
    targets: &BTreeMap<String, TargetInfo>,
    closed: &BTreeSet<String>,
) -> Option<WebhookEvent> {
    let patch_id = id_field(d, "patchId")?;
    let target = targets.get(&patch_id).filter(|t| t.is_pr)?;
    let open = !closed.contains(&patch_id);
    Some(pull_request_review_event(
        repo,
        &d.id,
        &target.pr_obj(&patch_id, open, target.merged),
        &d.owner_id,
        d.field_u64("verdict")?,
        &d.field_hex("commitOid").unwrap_or_default(),
        &d.field_str("body").unwrap_or_default(),
    ))
}

/// A `release` → `release` published, or `unpublished` when it newly marks the tag yanked.
/// `was_yanked` is whether the tag's previous revision was already yanked (the caller's own
/// per-tag cache, so this stays a pure function of its arguments): a further delta-0 revision on
/// an already-yanked tag is `edited`, not a repeated `unpublished`.
pub fn translate_release(
    repo: &RepositoryMeta,
    d: &FetchedDocument,
    was_yanked: bool,
) -> Option<WebhookEvent> {
    let assets = d
        .field_str("assets")
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::Value::Array(Vec::new()));
    let r = ReleaseObj {
        document_id: d.id.clone(),
        tag_name: d.field_str("tagName")?,
        name: d.field_str("name").unwrap_or_default(),
        body: d.field_str("notes").unwrap_or_default(),
        yanked: d.field_bool("yanked"),
        author: d.owner_id.clone(),
        assets,
    };
    Some(release_event(
        repo,
        &d.id,
        release_action(d, r.yanked, was_yanked),
        &r,
    ))
}

/// A release document's GitHub action from its RC1 `delta` (+1 publish, 0 edit / yank /
/// sealed, −1 unpublish): `published`, `unpublished`, or for 0 `edited` -- unless this revision
/// newly sets `yanked` (it was not set on the tag's previous revision), which is `unpublished`
/// instead. `delta` is a required field of the contract's `release` schema, so the `None` arm
/// (a document with none at all) is unreachable in practice; it is kept only as a defensive
/// fallback, not a real pre-RC1 case.
fn release_action(d: &FetchedDocument, yanked: bool, was_yanked: bool) -> &'static str {
    let newly_yanked = yanked && !was_yanked;
    match d.fields.get("delta").and_then(FieldValue::as_i64) {
        Some(1) => "published",
        Some(-1) => "unpublished",
        _ if newly_yanked => "unpublished",
        Some(_) => "edited",
        None => "published",
    }
}

/// A `checkRun` → `check_run` with `action` (chosen by [`crate::checkruns::diff`]). `None`
/// without a head oid. The dedup key is [`crate::checkruns::event_key`].
pub fn translate_check_run(
    repo: &RepositoryMeta,
    d: &FetchedDocument,
    action: CheckRunAction,
) -> Option<WebhookEvent> {
    let cr = CheckRunObj {
        document_id: d.id.clone(),
        head_oid: d.field_hex("headOid")?,
        name: d.field_str("name").unwrap_or_default(),
        status: d
            .field_str("status")
            .unwrap_or_else(|| "completed".to_string()),
        conclusion: d.field_str("conclusion").unwrap_or_default(),
        details_url: d.field_str("detailsUrl").unwrap_or_default(),
        summary: d.field_str("summary").unwrap_or_default(),
        external_id: d.field_str("externalId").unwrap_or_default(),
        runner_id: d.owner_id.clone(),
    };
    Some(check_run_event(
        repo,
        &crate::checkruns::event_key(d, action),
        action,
        &cr,
    ))
}

/// An event `kind` (`forge-v2.md` §3) as a GitHub action for an issue or a PR:
/// `(action, open)`. `None` for kinds with no GitHub analogue on that target, and for the
/// state kinds (1, 2, 3, 9, 10): state changes are `transition`s ([`translate_transition`]).
fn event_action(kind: u64, is_pr: bool) -> Option<(&'static str, bool)> {
    Some(match kind {
        4 => ("labeled", true),
        5 => ("unlabeled", true),
        6 => ("assigned", true),
        7 => ("unassigned", true),
        8 if is_pr => ("edited", true),
        // The PR's head moved (forge `headUpdate`): GitHub's `synchronize`.
        16 if is_pr => ("synchronize", true),
        _ => return None,
    })
}

/// A transition `kind` (`STATE-COUNTS.md` §2) as a GitHub action: `(action, open, merged)`.
/// A closed draft stays a draft, but GitHub has one `closed`/`reopened` for both.
#[must_use]
pub fn transition_action(kind: u64) -> Option<(&'static str, bool, bool)> {
    use forge_core::rules::transition as t;
    let kind = u8::try_from(kind).ok()?;
    Some(match kind {
        t::ISSUE_CLOSE | t::PR_CLOSE | t::PR_DRAFT_CLOSE => ("closed", false, false),
        t::ISSUE_REOPEN | t::PR_REOPEN | t::PR_DRAFT_REOPEN => ("reopened", true, false),
        t::PR_MERGE => ("closed", false, true),
        t::PR_DRAFT => ("converted_to_draft", true, false),
        t::PR_READY => ("ready_for_review", true, false),
        _ => return None,
    })
}

/// A lock transition `kind` as GitHub's action and the `locked` it leaves: `("locked", true)`
/// or `("unlocked", false)`; `None` for any other kind.
///
/// The RC1 lock transitions (`thread_lock`, delta ±16) are issue lock / unlock 3 / 4 and PR
/// lock / unlock 18 / 19. They leave the state (open, closed, merged, draft) as it is.
#[must_use]
pub fn lock_action(kind: u64) -> Option<(&'static str, bool)> {
    use forge_core::rules::transition as t;
    match u8::try_from(kind).ok()? {
        t::ISSUE_LOCK | t::PR_LOCK => Some(("locked", true)),
        t::ISSUE_UNLOCK | t::PR_UNLOCK => Some(("unlocked", false)),
        _ => None,
    }
}

/// Whether a PR is a draft after a transition of `kind`, from the kind alone: a draft, a
/// closed draft and a reopened draft are drafts; a ready, a ready close / reopen and a merge
/// are not. (A lock or unlock leaves the draft flag alone: it is not a state kind.)
#[must_use]
pub fn draft_after(kind: u64) -> bool {
    use forge_core::rules::transition as t;
    matches!(
        u8::try_from(kind),
        Ok(t::PR_DRAFT | t::PR_DRAFT_CLOSE | t::PR_DRAFT_REOPEN)
    )
}

/// A `transition` → `issues` / `pull_request` with the matching action ([`transition_action`]).
/// Needs the target in `targets`; a kind of the other target kind (a PR kind on an issue) is
/// skipped (consensus refuses it: `a_kindOfTarget`).
///
/// A merge (kind 13) is `merged: true`: "merged" is the chain fact (a member recorded it, D-9).
/// Consensus admits a merge naming any commit the base once held, and the relay reads no git
/// objects, so it cannot tell whether that commit contains the PR. Every merge therefore adds
/// `dash_merge_unverified: true` and `dash_merge_check`: `"not_on_base"` when the relay did not
/// find its `oid` as the tip of a valid update of the PR's base ref (`merge_on_base == false`,
/// the label forge readers show as "merge commit not found on the base"), else
/// `"content_unchecked"`. A receiver that acts on merges (a release, a deploy) checks the
/// commit itself (`dg pr verify`).
///
/// A lock or unlock ([`lock_action`]) is `locked` / `unlocked` with the object's `locked` set
/// and its state as the relay last saw it: open unless the target is in `closed`, and merged
/// per [`TargetInfo::merged`] (a lock/unlock is no state move, so it never changes either).
pub fn translate_transition(
    repo: &RepositoryMeta,
    d: &FetchedDocument,
    targets: &BTreeMap<String, TargetInfo>,
    merge_on_base: bool,
    closed: &BTreeSet<String>,
) -> Option<WebhookEvent> {
    let target_id = id_field(d, "targetId")?;
    let target = targets.get(&target_id)?;
    let kind = d.field_u64("kind")?;
    if kind / 10 != u64::from(target.is_pr) {
        return None;
    }
    if let Some((action, locked)) = lock_action(kind) {
        let open = !closed.contains(&target_id);
        let (mut e, obj) = if target.is_pr {
            let pr = target.pr_obj(&target_id, open, target.merged);
            (pull_request_event(repo, &d.id, action, &pr), "pull_request")
        } else {
            let issue = target.issue_obj(&target_id, open);
            (issues_event(repo, &d.id, action, &issue), "issue")
        };
        e.payload[obj]["locked"] = serde_json::Value::Bool(locked);
        e.payload["sender"] = repo.user_json(&d.owner_id);
        return Some(e);
    }
    let (action, open, merged) = transition_action(kind)?;
    let mut e = if target.is_pr {
        let mut pr = target.pr_obj(&target_id, open, merged);
        pr.draft = draft_after(kind);
        pull_request_event(repo, &d.id, action, &pr)
    } else {
        issues_event(repo, &d.id, action, &target.issue_obj(&target_id, open))
    };
    // The actor is the transition's writer, not the target's author.
    e.payload["sender"] = repo.user_json(&d.owner_id);
    if merged {
        e.payload["dash_merge_unverified"] = serde_json::Value::Bool(true);
        e.payload["dash_merge_check"] = serde_json::Value::from(if merge_on_base {
            "content_unchecked"
        } else {
            "not_on_base"
        });
    }
    Some(e)
}

/// An `event` or `authorEvent` → `issues` / `pull_request` with the matching action. Needs
/// the target in `targets`. None of these kinds move the fold themselves ([`event_action`]'s
/// own `open` is always `true`, so it is not used here), so `open` is the relay's last-seen
/// fold (`closed`), and a PR's `merged` is [`TargetInfo::merged`] -- matching how
/// [`translate_transition`]'s lock arm reads the same two facts. A label or assignee event
/// adds GitHub's `label` / `assignee` object.
pub fn translate_event(
    repo: &RepositoryMeta,
    d: &FetchedDocument,
    targets: &BTreeMap<String, TargetInfo>,
    closed: &BTreeSet<String>,
) -> Option<WebhookEvent> {
    let target_id = id_field(d, "targetId")?;
    let target = targets.get(&target_id)?;
    let kind = d.field_u64("kind")?;
    let (action, _) = event_action(kind, target.is_pr)?;
    let open = !closed.contains(&target_id);
    let mut e = if target.is_pr {
        pull_request_event(
            repo,
            &d.id,
            action,
            &target.pr_obj(&target_id, open, target.merged),
        )
    } else {
        issues_event(repo, &d.id, action, &target.issue_obj(&target_id, open))
    };
    // The actor is the event's writer, not the target's author.
    e.payload["sender"] = repo.user_json(&d.owner_id);
    if let Some(value) = d.field_str("value") {
        match kind {
            4 | 5 => e.payload["label"] = serde_json::json!({ "name": value }),
            6 | 7 => e.payload["assignee"] = repo.user_json(&value),
            _ => {}
        }
    }
    Some(e)
}

#[cfg(test)]
mod tests {
    use super::*;
    use forge_core::platform::FieldValue;

    fn meta() -> RepositoryMeta {
        RepositoryMeta {
            repo_id: "REPO".into(),
            owner_id: "OWNER".into(),
            name: "repo".into(),
            default_branch: "main".into(),
            web_base_url: "https://forge.example".into(),
        }
    }

    fn doc(id: &str, owner: &str, fields: Vec<(&str, FieldValue)>) -> FetchedDocument {
        FetchedDocument {
            id: id.into(),
            owner_id: owner.into(),
            created_at: Some(1000),
            created_at_block_height: None,
            updated_at_block_height: None,
            revision: None,
            fields: fields
                .into_iter()
                .map(|(k, v)| (k.to_string(), v))
                .collect(),
        }
    }

    fn target(is_pr: bool, number: u64) -> TargetInfo {
        TargetInfo {
            is_pr,
            number,
            author: "AUTH".into(),
            title: "T".into(),
            base_ref: if is_pr {
                "refs/heads/main".into()
            } else {
                String::new()
            },
            head_oid: if is_pr { "cafe".into() } else { String::new() },
            head_set_by: None,
            retargets: Vec::new(),
            opened_base: None,
            base_ref_hash: String::new(),
            baseline: Baseline::Beginning,
            last_activity: 0,
            draft: false,
            merged: false,
        }
    }

    fn targets(id: [u8; 32], t: TargetInfo) -> BTreeMap<String, TargetInfo> {
        BTreeMap::from([(encode_identifier(id), t)])
    }

    #[test]
    fn ref_update_translates_to_push() {
        let d = doc(
            "ref1",
            "PUSHER",
            vec![
                ("repoId", FieldValue::identifier([1; 32])),
                ("refName", FieldValue::text("refs/heads/main")),
                ("newOid", FieldValue::bytes(vec![0x22; 20])),
                ("prevOid", FieldValue::bytes(vec![0x11; 20])),
                ("force", FieldValue::boolean(true)),
            ],
        );
        let e = translate_ref_update(&meta(), &d).unwrap();
        assert_eq!(e.event, "push");
        assert_eq!(e.payload["ref"], "refs/heads/main");
        assert_eq!(e.payload["after"], "22".repeat(20));
        assert_eq!(e.payload["before"], "11".repeat(20));
        assert_eq!(e.payload["forced"], true);
        assert_eq!(e.payload["pusher"]["name"], "PUSHER");
        assert_eq!(e.payload["repository"]["dash_repo_id"], "REPO");
        assert_eq!(e.source_doc_id, "ref1");
        assert!(!is_ref_deletion(&d));
    }

    #[test]
    fn a_private_ref_update_is_not_delivered() {
        let d = doc(
            "ref2",
            "PUSHER",
            vec![
                ("enc", FieldValue::bytes(vec![1; 48])),
                ("newOid", FieldValue::bytes(vec![0x22; 20])),
            ],
        );
        assert!(translate_ref_update(&meta(), &d).is_none());
        let del = doc(
            "ref3",
            "P",
            vec![("refName", FieldValue::text("refs/heads/x"))],
        );
        assert!(is_ref_deletion(&del));
    }

    #[test]
    fn issue_and_patch_translate() {
        let issue = doc(
            "i1",
            "AUTH",
            vec![
                ("number", FieldValue::integer(5)),
                ("title", FieldValue::text("Bug")),
                ("body", FieldValue::text("desc")),
            ],
        );
        let e = translate_issue(&meta(), &issue).unwrap();
        assert_eq!(
            (e.event, e.payload["action"].as_str()),
            ("issues", Some("opened"))
        );
        assert_eq!(e.payload["issue"]["number"], 5);

        let patch = doc(
            "p1",
            "AUTH",
            vec![
                ("number", FieldValue::integer(9)),
                ("title", FieldValue::text("PR")),
                ("baseRefName", FieldValue::text("refs/heads/main")),
                ("headOid", FieldValue::bytes(vec![0xca, 0xfe])),
            ],
        );
        let e = translate_patch(&meta(), &patch).unwrap();
        assert_eq!(e.event, "pull_request");
        assert_eq!(e.payload["pull_request"]["base"]["ref"], "refs/heads/main");
        assert_eq!(e.payload["pull_request"]["head"]["sha"], "cafe");
    }

    #[test]
    fn comment_uses_the_target_index() {
        let c = doc(
            "c1",
            "COMMENTER",
            vec![
                ("targetId", FieldValue::identifier([7; 32])),
                ("body", FieldValue::text("nice")),
            ],
        );
        let e = translate_comment(&meta(), &c, &targets([7; 32], target(false, 42))).unwrap();
        assert_eq!(e.event, "issue_comment");
        assert_eq!(e.payload["issue"]["number"], 42);
        assert_eq!(e.payload["comment"]["body"], "nice");
        assert_eq!(e.payload["comment"]["user"]["login"], "COMMENTER");
        // Unknown target: a stub, still delivered.
        let e = translate_comment(&meta(), &c, &BTreeMap::new()).unwrap();
        assert_eq!(e.payload["issue"]["number"], 0);
    }

    #[test]
    fn review_translates_with_its_pr() {
        let r = doc(
            "rv1",
            "REVIEWER",
            vec![
                ("patchId", FieldValue::identifier([3; 32])),
                ("verdict", FieldValue::integer(2)),
                ("commitOid", FieldValue::bytes(vec![0xab; 20])),
                ("body", FieldValue::text("needs work")),
            ],
        );
        let empty = BTreeSet::new();
        let e = translate_review(&meta(), &r, &targets([3; 32], target(true, 8)), &empty).unwrap();
        assert_eq!(e.event, "pull_request_review");
        assert_eq!(e.payload["review"]["state"], "changes_requested");
        assert_eq!(e.payload["review"]["commit_id"], "ab".repeat(20));
        assert_eq!(e.payload["pull_request"]["number"], 8);
        assert_eq!(e.payload["pull_request"]["state"], "open");
        assert_eq!(e.payload["sender"]["login"], "REVIEWER");
        // A review of an issue id, or of an unknown PR, is not delivered.
        assert!(
            translate_review(&meta(), &r, &targets([3; 32], target(false, 8)), &empty).is_none()
        );
        assert!(translate_review(&meta(), &r, &BTreeMap::new(), &empty).is_none());
        // A review of a PR the relay has seen closed or merged carries that fold, same as
        // translate_event and translate_transition's lock arm.
        let mut merged_t = target(true, 8);
        merged_t.merged = true;
        let e = translate_review(&meta(), &r, &targets([3; 32], merged_t), &empty).unwrap();
        assert_eq!(e.payload["pull_request"]["merged"], true);
        let closed = BTreeSet::from([encode_identifier([3; 32])]);
        let e = translate_review(&meta(), &r, &targets([3; 32], target(true, 8)), &closed).unwrap();
        assert_eq!(e.payload["pull_request"]["state"], "closed");
    }

    #[test]
    fn release_translates() {
        let d = doc(
            "rel1",
            "MAINT",
            vec![
                ("tagName", FieldValue::text("v1.2.0")),
                ("name", FieldValue::text("Twelve")),
                ("notes", FieldValue::text("changes")),
                ("assets", FieldValue::text(r#"[{"name":"x.tgz"}]"#)),
            ],
        );
        let e = translate_release(&meta(), &d, false).unwrap();
        assert_eq!(e.event, "release");
        assert_eq!(e.payload["action"], "published");
        assert_eq!(e.payload["release"]["tag_name"], "v1.2.0");
        assert_eq!(e.payload["release"]["body"], "changes");
        assert_eq!(e.payload["release"]["assets"][0]["name"], "x.tgz");
        let bad_assets = doc(
            "rel2",
            "M",
            vec![
                ("tagName", FieldValue::text("v2")),
                ("assets", FieldValue::text("not json")),
            ],
        );
        let e = translate_release(&meta(), &bad_assets, false).unwrap();
        assert_eq!(e.payload["release"]["assets"], serde_json::json!([]));
    }

    #[test]
    fn check_run_translates() {
        let d = doc(
            "cr1",
            "RUNNER",
            vec![
                ("headOid", FieldValue::bytes(vec![0xde, 0xad])),
                ("name", FieldValue::text("build")),
                ("conclusion", FieldValue::text("success")),
            ],
        );
        let e = translate_check_run(&meta(), &d, CheckRunAction::Completed).unwrap();
        assert_eq!(e.payload["check_run"]["head_sha"], "dead");
        assert_eq!(e.payload["action"], "completed");
        assert_eq!(e.source_doc_id, "cr1:completed:1");
        let e = translate_check_run(&meta(), &d, CheckRunAction::Created).unwrap();
        assert_eq!(e.payload["action"], "created");
        assert_eq!(
            e.source_doc_id, "cr1",
            "created keeps the document id as its key"
        );
    }

    #[test]
    fn head_updates_move_the_pr_head_and_synchronize() {
        // Each update later than the last (the feed's order), with its own id.
        let clock = std::cell::Cell::new(1000u64);
        let head = |owner: &str, oid: &str| {
            clock.set(clock.get() + 1);
            let mut d = doc(
                &format!("h{}", clock.get()),
                owner,
                vec![
                    ("targetId", FieldValue::identifier([9; 32])),
                    ("kind", FieldValue::integer(16)),
                    ("oid", FieldValue::bytes(hex::decode(oid).unwrap())),
                ],
            );
            d.created_at = Some(clock.get());
            d
        };
        let new = "ab".repeat(20);
        let mut t = target(true, 3);
        // The author's authorEvent moves it; a stranger's authorEvent does not.
        assert_eq!(t.apply_head_update(&head("MALLORY", &new), true), None);
        assert_eq!(
            t.apply_head_update(&head("AUTH", &new), true),
            Some(new.clone())
        );
        assert_eq!(t.head_oid, new);
        // A member's event moves it too; the same head again is no move.
        let newer = "cd".repeat(20);
        assert_eq!(
            t.apply_head_update(&head("MEMBER", &newer), false),
            Some(newer.clone())
        );
        assert_eq!(t.apply_head_update(&head("MEMBER", &newer), false), None);
        // A short oid is inert (forge's fold), as is an issue target.
        assert_eq!(t.apply_head_update(&head("MEMBER", "abcd"), false), None);
        assert_eq!(
            target(false, 1).apply_head_update(&head("AUTH", &new), true),
            None
        );
        // An older update read later (another stream) does not move the head back.
        let mut older = head("MEMBER", &"ef".repeat(20));
        older.created_at = Some(1);
        assert_eq!(t.apply_head_update(&older, false), None);
        assert_eq!(t.head_oid, newer);
        // The webhook: `synchronize` with the new head.
        let prs = targets([9; 32], t);
        let e = translate_event(&meta(), &head("MEMBER", &newer), &prs, &BTreeSet::new()).unwrap();
        assert_eq!(e.payload["action"], "synchronize");
        assert_eq!(e.payload["pull_request"]["head"]["sha"], newer);
    }

    #[test]
    fn member_and_author_events_translate() {
        let ev = |id: &str, kind: u64, value: Option<&str>, t: [u8; 32]| {
            let mut f = vec![
                ("targetId", FieldValue::identifier(t)),
                ("kind", FieldValue::integer(kind)),
            ];
            if let Some(v) = value {
                f.push(("value", FieldValue::text(v)));
            }
            doc(id, "ACTOR", f)
        };
        let issues = targets([1; 32], target(false, 8));
        let empty = BTreeSet::new();
        let e =
            translate_event(&meta(), &ev("l", 4, Some("bug"), [1; 32]), &issues, &empty).unwrap();
        assert_eq!(e.payload["action"], "labeled");
        assert_eq!(e.payload["label"]["name"], "bug");
        assert_eq!(e.payload["sender"]["login"], "ACTOR");
        assert_eq!(e.payload["issue"]["state"], "open");
        let e =
            translate_event(&meta(), &ev("a", 6, Some("BOB"), [1; 32]), &issues, &empty).unwrap();
        assert_eq!(e.payload["assignee"]["login"], "BOB");

        // The relay's last-seen fold, not the event's own: a labeled event on an issue the
        // relay has seen closed still reports the issue closed.
        let closed = BTreeSet::from([encode_identifier([1; 32])]);
        let e =
            translate_event(&meta(), &ev("l", 4, Some("bug"), [1; 32]), &issues, &closed).unwrap();
        assert_eq!(e.payload["issue"]["state"], "closed");
        // Likewise a PR event carries TargetInfo::merged forward.
        let mut merged_pr = target(true, 3);
        merged_pr.merged = true;
        let prs_merged = targets([9; 32], merged_pr);
        let e = translate_event(
            &meta(),
            &ev("l", 4, Some("bug"), [9; 32]),
            &prs_merged,
            &empty,
        )
        .unwrap();
        assert_eq!(e.payload["pull_request"]["merged"], true);

        // State kinds are transitions now: an event of one is never a webhook. Retarget means
        // nothing on an issue; unknown targets and kinds are skipped.
        let prs = targets([9; 32], target(true, 3));
        for kind in [1, 2, 3, 9, 10] {
            assert!(
                translate_event(&meta(), &ev("x", kind, None, [9; 32]), &prs, &empty).is_none()
            );
            assert!(
                translate_event(&meta(), &ev("x", kind, None, [1; 32]), &issues, &empty).is_none()
            );
        }
        for kind in [8, 11] {
            assert!(
                translate_event(&meta(), &ev("x", kind, None, [1; 32]), &issues, &empty).is_none()
            );
        }
        assert!(
            translate_event(&meta(), &ev("x", 4, Some("b"), [5; 32]), &issues, &empty).is_none()
        );
    }

    /// Each transition kind is the GitHub action a receiver expects, on the right target kind.
    #[test]
    fn each_transition_kind_is_its_webhook_action() {
        let tr = |kind: u64, t: [u8; 32]| {
            doc(
                &format!("t{kind}"),
                "ACTOR",
                vec![
                    ("targetId", FieldValue::identifier(t)),
                    ("kind", FieldValue::integer(kind)),
                ],
            )
        };
        let issues = targets([1; 32], target(false, 8));
        let prs = targets([9; 32], target(true, 3));
        let none = BTreeSet::new();
        for (kind, action, state) in [(1, "closed", "closed"), (2, "reopened", "open")] {
            let e =
                translate_transition(&meta(), &tr(kind, [1; 32]), &issues, true, &none).unwrap();
            assert_eq!(e.event, "issues");
            assert_eq!(e.payload["action"], action, "kind {kind}");
            assert_eq!(e.payload["issue"]["state"], state);
            assert_eq!(e.payload["sender"]["login"], "ACTOR");
        }
        for (kind, action, state, merged) in [
            (11, "closed", "closed", false),
            (12, "reopened", "open", false),
            (13, "closed", "closed", true),
            (14, "converted_to_draft", "open", false),
            (15, "ready_for_review", "open", false),
            (16, "closed", "closed", false),
            (17, "reopened", "open", false),
        ] {
            let e = translate_transition(&meta(), &tr(kind, [9; 32]), &prs, true, &none).unwrap();
            assert_eq!(e.event, "pull_request");
            assert_eq!(e.payload["action"], action, "kind {kind}");
            assert_eq!(e.payload["pull_request"]["state"], state, "kind {kind}");
            assert_eq!(e.payload["pull_request"]["merged"], merged, "kind {kind}");
            assert_eq!(
                e.payload["pull_request"]["draft"],
                matches!(kind, 14 | 16 | 17),
                "kind {kind}"
            );
            assert_eq!(
                e.payload.get("dash_merge_unverified").is_some(),
                merged,
                "kind {kind}: only a merge carries the merge flags"
            );
        }
        // A review (or any event) on a draft PR says draft, as the relay last saw it.
        let mut drafted = target(true, 3);
        drafted.draft = true;
        assert!(drafted.pr_obj("p", true, false).draft);
        // Merged is the chain fact (D-9). The relay reads no git, so no merge is verified: a
        // commit found on the base still needs its content checked, and one not found is labelled.
        let e = translate_transition(&meta(), &tr(13, [9; 32]), &prs, true, &none).unwrap();
        assert_eq!(e.payload["pull_request"]["merged"], true);
        assert_eq!(e.payload["dash_merge_unverified"], true);
        assert_eq!(e.payload["dash_merge_check"], "content_unchecked");
        let e = translate_transition(&meta(), &tr(13, [9; 32]), &prs, false, &none).unwrap();
        assert_eq!(e.payload["pull_request"]["merged"], true);
        assert_eq!(e.payload["dash_merge_unverified"], true);
        assert_eq!(e.payload["dash_merge_check"], "not_on_base");
        // A PR kind on an issue (or the reverse), an unknown kind or target: nothing.
        assert!(translate_transition(&meta(), &tr(11, [1; 32]), &issues, true, &none).is_none());
        assert!(translate_transition(&meta(), &tr(1, [9; 32]), &prs, true, &none).is_none());
        assert!(translate_transition(&meta(), &tr(5, [1; 32]), &issues, true, &none).is_none());
        assert!(translate_transition(&meta(), &tr(1, [5; 32]), &issues, true, &none).is_none());
        assert_eq!(transition_action(18), None);
    }

    /// RC1 lock kinds (3/4 issue, 18/19 PR) are GitHub's `locked` / `unlocked`, keeping the
    /// state the relay last saw.
    #[test]
    fn lock_transitions_are_locked_and_unlocked() {
        let tr = |kind: u64, t: [u8; 32]| {
            doc(
                &format!("t{kind}"),
                "ACTOR",
                vec![
                    ("targetId", FieldValue::identifier(t)),
                    ("kind", FieldValue::integer(kind)),
                ],
            )
        };
        let issues = targets([1; 32], target(false, 8));
        let mut draft = target(true, 3);
        draft.draft = true;
        let prs = targets([9; 32], draft);
        let none = BTreeSet::new();
        let closed = BTreeSet::from([encode_identifier([1; 32])]);
        for (kind, action, locked) in [(3, "locked", true), (4, "unlocked", false)] {
            let e =
                translate_transition(&meta(), &tr(kind, [1; 32]), &issues, true, &none).unwrap();
            assert_eq!(e.event, "issues");
            assert_eq!(e.payload["action"], action);
            assert_eq!(e.payload["issue"]["locked"], locked);
            assert_eq!(e.payload["issue"]["state"], "open");
            assert_eq!(e.payload["sender"]["login"], "ACTOR");
            let e =
                translate_transition(&meta(), &tr(kind, [1; 32]), &issues, true, &closed).unwrap();
            assert_eq!(
                e.payload["issue"]["state"], "closed",
                "a closed issue stays closed"
            );
        }
        for (kind, action, locked) in [(18, "locked", true), (19, "unlocked", false)] {
            let e = translate_transition(&meta(), &tr(kind, [9; 32]), &prs, true, &none).unwrap();
            assert_eq!(e.event, "pull_request");
            assert_eq!(e.payload["action"], action);
            assert_eq!(e.payload["pull_request"]["locked"], locked);
            assert_eq!(
                e.payload["pull_request"]["draft"], true,
                "a lock keeps the draft"
            );
        }
        // An issue kind on a PR (or the reverse) is nothing.
        assert!(translate_transition(&meta(), &tr(3, [9; 32]), &prs, true, &none).is_none());
        assert!(translate_transition(&meta(), &tr(18, [1; 32]), &issues, true, &none).is_none());
    }

    /// A lock or unlock on an already-merged PR reports `merged: true` (the chain fact),
    /// not the lock/unlock's own state — merging is terminal and a lock/unlock never
    /// changes it (`TargetInfo::merged`).
    #[test]
    fn a_lock_on_a_merged_pr_still_reports_merged() {
        let tr = |kind: u64| {
            doc(
                &format!("t{kind}"),
                "ACTOR",
                vec![
                    ("targetId", FieldValue::identifier([7; 32])),
                    ("kind", FieldValue::integer(kind)),
                ],
            )
        };
        let mut merged_pr = target(true, 4);
        merged_pr.merged = true;
        let prs = targets([7; 32], merged_pr);
        let closed = BTreeSet::from([encode_identifier([7; 32])]);
        for kind in [18, 19] {
            let e = translate_transition(&meta(), &tr(kind), &prs, true, &closed).unwrap();
            assert_eq!(
                e.payload["pull_request"]["merged"], true,
                "kind {kind} on an already-merged PR"
            );
            assert_eq!(e.payload["pull_request"]["state"], "closed");
        }
    }

    /// An in-memory index ordered by `($createdAt, $id)`. A `start_after` naming a document
    /// that is not there fails like Drive's `StartDocumentNotFound`.
    struct Mem(std::cell::RefCell<Vec<FetchedDocument>>);

    impl Mem {
        fn new(rows: &[(&str, u64)]) -> Self {
            Self(std::cell::RefCell::new(
                rows.iter().map(|(id, t)| at(id, *t)).collect(),
            ))
        }
        fn push(&self, id: &str, t: u64) {
            self.0.borrow_mut().push(at(id, t));
        }
        fn delete(&self, id: &str) {
            self.0.borrow_mut().retain(|d| d.id != id);
        }
    }

    fn at(id: &str, t: u64) -> FetchedDocument {
        FetchedDocument {
            id: id.into(),
            owner_id: "O".into(),
            created_at: Some(t),
            created_at_block_height: None,
            updated_at_block_height: None,
            revision: None,
            fields: BTreeMap::new(),
        }
    }

    #[allow(clippy::unused_async_trait_impl)]
    impl PageSource for Mem {
        async fn page(
            &self,
            since: Option<u64>,
            ascending: bool,
            limit: u32,
            start_after: Option<&str>,
        ) -> Result<Vec<FetchedDocument>> {
            let mut rows: Vec<FetchedDocument> = self
                .0
                .borrow()
                .iter()
                .filter(|d| since.is_none_or(|s| d.created_at.unwrap() >= s))
                .cloned()
                .collect();
            rows.sort_by(|a, b| (a.created_at, &a.id).cmp(&(b.created_at, &b.id)));
            if !ascending {
                rows.reverse();
            }
            if let Some(after) = start_after {
                let Some(i) = rows.iter().position(|d| d.id == after) else {
                    return Err(crate::error::RelayError::Config(
                        "start document not found".into(),
                    ));
                };
                rows.drain(..=i);
            }
            rows.truncate(limit as usize);
            Ok(rows)
        }
    }

    fn ids(docs: &[FetchedDocument]) -> Vec<&str> {
        docs.iter().map(|d| d.id.as_str()).collect()
    }

    #[tokio::test]
    async fn a_deleted_cursor_document_does_not_stop_the_stream() {
        let idx = Mem::new(&[("a", 10), ("b", 20)]);
        let mut c = Cursor::new(Baseline::Tail { lookback: 0 });
        assert!(poll_stream(&idx, &mut c).await.unwrap().is_empty());
        // The newest document the cursor last saw is deleted (a comment, a review, ...).
        idx.delete("b");
        idx.push("c", 30);
        assert_eq!(ids(&poll_stream(&idx, &mut c).await.unwrap()), ["c"]);
        idx.delete("c");
        assert!(poll_stream(&idx, &mut c).await.unwrap().is_empty());
        idx.push("d", 40);
        assert_eq!(ids(&poll_stream(&idx, &mut c).await.unwrap()), ["d"]);
    }

    #[tokio::test]
    async fn documents_sharing_the_cursors_timestamp_are_delivered_once() {
        let idx = Mem::new(&[("a", 10)]);
        let mut c = Cursor::new(Baseline::Tail { lookback: 0 });
        poll_stream(&idx, &mut c).await.unwrap();
        // Same block as the baseline: sorting before and after it.
        idx.push("0", 10);
        idx.push("z", 10);
        assert_eq!(ids(&poll_stream(&idx, &mut c).await.unwrap()), ["0", "z"]);
        assert!(poll_stream(&idx, &mut c).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn baselines() {
        let idx = Mem::new(&[("a", 10), ("b", 20), ("c", 30)]);
        let mut c = Cursor::new(Baseline::Tail { lookback: 2 });
        assert_eq!(ids(&poll_stream(&idx, &mut c).await.unwrap()), ["b", "c"]);
        assert!(poll_stream(&idx, &mut c).await.unwrap().is_empty());
        let mut c = Cursor::new(Baseline::Since(20));
        assert_eq!(ids(&poll_stream(&idx, &mut c).await.unwrap()), ["b", "c"]);
        let mut c = Cursor::new(Baseline::Since(99));
        assert!(poll_stream(&idx, &mut c).await.unwrap().is_empty());
        let mut c = Cursor::new(Baseline::Beginning);
        assert_eq!(
            ids(&poll_stream(&idx, &mut c).await.unwrap()),
            ["a", "b", "c"]
        );
        // Lookback at least the whole stream: everything.
        let mut c = Cursor::new(Baseline::Tail { lookback: 9 });
        assert_eq!(
            ids(&poll_stream(&idx, &mut c).await.unwrap()),
            ["a", "b", "c"]
        );
    }

    #[tokio::test]
    async fn a_cursor_primed_from_a_state_read_misses_nothing_written_after_it() {
        let idx = Mem::new(&[("a", 10), ("b", 20), ("b2", 20)]);
        // The state was built from this complete read (newest first)...
        let snapshot: Vec<FetchedDocument> = vec![at("b2", 20), at("b", 20), at("a", 10)];
        let mut c = Cursor::primed(&snapshot, 0);
        // ...then more landed before the first poll, one in the same block as the newest.
        idx.push("b3", 20);
        idx.push("c", 30);
        assert_eq!(ids(&poll_stream(&idx, &mut c).await.unwrap()), ["b3", "c"]);
        // With a lookback, the newest `lookback` of the snapshot come back too.
        let mut c = Cursor::primed(&snapshot, 1);
        assert_eq!(
            ids(&poll_stream(&idx, &mut c).await.unwrap()),
            ["b2", "b3", "c"]
        );
        // An empty stream: everything later is new.
        let mut c = Cursor::primed(&[], 0);
        assert_eq!(ids(&poll_stream(&idx, &mut c).await.unwrap()).len(), 5);
    }

    #[tokio::test]
    async fn a_long_backlog_pages_to_the_end() {
        let rows: Vec<(String, u64)> = (0..250).map(|i| (format!("d{i:03}"), 100 + i)).collect();
        let refs: Vec<(&str, u64)> = rows.iter().map(|(i, t)| (i.as_str(), *t)).collect();
        let idx = Mem::new(&refs);
        let mut c = Cursor::new(Baseline::Beginning);
        assert_eq!(poll_stream(&idx, &mut c).await.unwrap().len(), 250);
        assert!(poll_stream(&idx, &mut c).await.unwrap().is_empty());
    }

    fn ref_doc(name: &str, hash_of: &str) -> FetchedDocument {
        use sha2::Digest;
        doc(
            "u1",
            "W",
            vec![
                ("refName", FieldValue::text(name)),
                (
                    "refNameHash",
                    FieldValue::bytes32(sha2::Sha256::digest(hash_of.as_bytes()).into()),
                ),
                ("newOid", FieldValue::bytes(vec![0x22; 20])),
            ],
        )
    }

    #[test]
    fn a_plain_ref_update_on_a_protected_ref_is_not_a_push() {
        let configs = vec![ConfigDoc {
            id: "cfg".into(),
            created_at: 500,
            protected_patterns: vec!["refs/heads/main".into()],
        }];
        let main = ref_doc("refs/heads/main", "refs/heads/main");
        // After the config (the doc is at t=1000): only a protectedRefUpdate moves main.
        assert!(!ref_update_is_valid(&main, false, &configs));
        assert!(ref_update_is_valid(&main, true, &configs));
        // An unprotected branch: either type.
        let feat = ref_doc("refs/heads/feat", "refs/heads/feat");
        assert!(ref_update_is_valid(&feat, false, &configs));
        // Protection applies as of the update's time: a config newer than it does not.
        let later = vec![ConfigDoc {
            created_at: 5000,
            ..configs[0].clone()
        }];
        assert!(ref_update_is_valid(&main, false, &later));
        // A name that does not hash to its key, or an illegal name: inert.
        assert!(!ref_update_is_valid(
            &ref_doc("refs/heads/main", "refs/heads/x"),
            true,
            &[]
        ));
        assert!(!ref_update_is_valid(
            &ref_doc("refs/heads/a b", "refs/heads/a b"),
            true,
            &[]
        ));
    }

    #[test]
    fn yanked_releases_are_unpublished() {
        let yanked = doc(
            "r",
            "M",
            vec![
                ("tagName", FieldValue::text("v1")),
                ("yanked", FieldValue::boolean(true)),
            ],
        );
        let e = translate_release(&meta(), &yanked, false).unwrap();
        assert_eq!(e.payload["action"], "unpublished");
    }

    /// RC1 `release.delta`: +1 publish, 0 edit (or yank), −1 unpublish. `was_yanked` is always
    /// `false` here (a tag never yanked before), so 0-and-yanked is the moment it becomes yanked.
    #[test]
    fn a_release_action_follows_its_delta() {
        let rel = |delta: i64, yanked: bool| {
            doc(
                "r",
                "M",
                vec![
                    ("tagName", FieldValue::text("v1")),
                    ("delta", FieldValue::signed(delta)),
                    ("yanked", FieldValue::boolean(yanked)),
                ],
            )
        };
        for (delta, yanked, action) in [
            (1, false, "published"),
            (-1, false, "unpublished"),
            (0, false, "edited"),
            (0, true, "unpublished"),
        ] {
            let e = translate_release(&meta(), &rel(delta, yanked), false).unwrap();
            assert_eq!(
                e.payload["action"], action,
                "delta {delta}, yanked {yanked}"
            );
        }
    }

    /// A further delta-0 edit of a release already yanked (`was_yanked: true`) is `edited`, not
    /// a repeated `unpublished` -- only the revision that newly sets `yanked` is `unpublished`.
    /// Un-yanking (publishing again without `--yanked`) is likewise `edited`, not a webhook
    /// action of its own: GitHub has none for it, and the tag's publish state did not change.
    #[test]
    fn editing_an_already_yanked_release_is_edited_not_unpublished_again() {
        let rel = |yanked: bool| {
            doc(
                "r",
                "M",
                vec![
                    ("tagName", FieldValue::text("v1")),
                    ("delta", FieldValue::signed(0)),
                    ("yanked", FieldValue::boolean(yanked)),
                ],
            )
        };
        // Newly yanked: was_yanked false, yanked true -> unpublished.
        let e = translate_release(&meta(), &rel(true), false).unwrap();
        assert_eq!(e.payload["action"], "unpublished");
        // Still yanked on a later edit: was_yanked true, yanked true -> edited.
        let e = translate_release(&meta(), &rel(true), true).unwrap();
        assert_eq!(e.payload["action"], "edited");
        // Un-yanked: was_yanked true, yanked false -> edited.
        let e = translate_release(&meta(), &rel(false), true).unwrap();
        assert_eq!(e.payload["action"], "edited");
        // Never yanked: was_yanked false, yanked false -> edited.
        let e = translate_release(&meta(), &rel(false), false).unwrap();
        assert_eq!(e.payload["action"], "edited");
    }
}
