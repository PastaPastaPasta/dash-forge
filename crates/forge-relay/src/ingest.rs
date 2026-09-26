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
//! | `event`, `authorEvent` | forge-collab | `feed (repoId)` | `issues` / `pull_request` closed, reopened, merged, labeled, ... |
//! | `comment` | forge-collab | `target (targetId)`, per issue/PR | `issue_comment` created |
//! | `review` | forge-collab | `patch (patchId)`, per PR | `pull_request_review` submitted |
//! | `checkRun` | forge-collab | `head (repoId, headOid)`, per head seen | `check_run` |
//!
//! ## Cursors
//!
//! Stateless across restarts. A stream's first read establishes its baseline ([`Baseline`]):
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
//! `t` next cycle. A failed read leaves the cursor where it was: delivery is at-least-once and
//! consumers dedupe on `X-GitHub-Delivery`. Every forge-v2 type requires `$createdAt`, and a
//! proved v2 read returns it; a document without one is skipped.
//!
//! The `translate_*` functions are pure (`FetchedDocument` → [`WebhookEvent`]) and tested
//! offline.

use std::collections::{BTreeMap, BTreeSet};

use forge_core::platform::{
    encode_identifier, FetchedDocument, LoadedContract, PlatformClient, QueryFilter, QueryOp,
    QueryOrder,
};
use forge_core::refs::ref_update_from_doc;
use forge_core::rules::{self, ConfigDoc};

use crate::error::Result;
use crate::payload::{
    check_run_event, is_zero_oid, issue_comment_event, issues_event, pull_request_event,
    pull_request_review_event, push_event, release_event, CheckRunObj, IssueObj, PullRequestObj,
    ReleaseObj, RepositoryMeta, WebhookEvent,
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
/// Member state changes (close, reopen, merge, label, ...).
pub const DOC_EVENT: &str = "event";
/// Author state changes (close, reopen).
pub const DOC_AUTHOR_EVENT: &str = "authorEvent";
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
    /// forge-core or forge-collab.
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
    /// The head oid (PRs only, hex).
    pub head_oid: String,
    /// `baseRefNameHash` (PRs only, hex): the ref a merge must land on.
    pub base_ref_hash: String,
    /// Where this target's comment and review streams start.
    pub baseline: Baseline,
    /// The newest `$createdAt` seen on the target or anything about it (ms).
    pub last_activity: u64,
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
            base_ref_hash: String::new(),
            baseline,
            last_activity: d.created_at.unwrap_or(0),
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
            base_ref_hash: d.field_hex("baseRefNameHash").unwrap_or_default(),
            baseline,
            last_activity: d.created_at.unwrap_or(0),
        }
    }

    fn issue_obj(&self, id: &str, open: bool) -> IssueObj {
        IssueObj {
            number: self.number,
            document_id: id.to_string(),
            author: self.author.clone(),
            title: self.title.clone(),
            body: String::new(),
            open,
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

/// A `review` → `pull_request_review` submitted. Needs its PR in `targets`.
pub fn translate_review(
    repo: &RepositoryMeta,
    d: &FetchedDocument,
    targets: &BTreeMap<String, TargetInfo>,
) -> Option<WebhookEvent> {
    let patch_id = id_field(d, "patchId")?;
    let target = targets.get(&patch_id).filter(|t| t.is_pr)?;
    Some(pull_request_review_event(
        repo,
        &d.id,
        &target.pr_obj(&patch_id, true, false),
        &d.owner_id,
        d.field_u64("verdict")?,
        &d.field_hex("commitOid").unwrap_or_default(),
        &d.field_str("body").unwrap_or_default(),
    ))
}

/// A `release` → `release` published, or `unpublished` when it marks the tag yanked.
pub fn translate_release(repo: &RepositoryMeta, d: &FetchedDocument) -> Option<WebhookEvent> {
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
    let action = if r.yanked { "unpublished" } else { "published" };
    Some(release_event(repo, &d.id, action, &r))
}

/// A `checkRun` → `check_run`. `None` without a head oid.
pub fn translate_check_run(repo: &RepositoryMeta, d: &FetchedDocument) -> Option<WebhookEvent> {
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
        runner_id: d.owner_id.clone(),
    };
    Some(check_run_event(repo, &d.id, &cr))
}

/// An event `kind` (`forge-v2.md` §3) as a GitHub action for an issue or a PR:
/// `(action, open, merged)`. `None` for kinds with no GitHub analogue on that target.
fn event_action(
    kind: u64,
    is_pr: bool,
    merge_verified: bool,
) -> Option<(&'static str, bool, bool)> {
    Some(match kind {
        1 => ("closed", false, false),
        2 => ("reopened", true, false),
        // Merge: `merged` only when verified (see `translate_event`).
        3 if is_pr => ("closed", false, merge_verified),
        4 => ("labeled", true, false),
        5 => ("unlabeled", true, false),
        6 => ("assigned", true, false),
        7 => ("unassigned", true, false),
        8 if is_pr => ("edited", true, false),
        9 if is_pr => ("converted_to_draft", true, false),
        10 if is_pr => ("ready_for_review", true, false),
        _ => return None,
    })
}

/// An `event` or `authorEvent` → `issues` / `pull_request` with the matching action. Needs
/// the target in `targets`. The `open` state is the action's own (an event about an issue
/// carries no fold); a label or assignee event adds GitHub's `label` / `assignee` object.
///
/// A merge (kind 3) is reported `merged: true` only when `merge_verified`: the caller found
/// the event's `oid` as the tip of a valid update of the PR's base ref. forge's rule is that
/// `oid` is reachable from the base tip; the relay has no commit graph, so "was a base tip"
/// is the part it can check. Otherwise the payload says `merged: false` and
/// `dash_merge_unverified: true` (a member can post a merge event for any oid).
pub fn translate_event(
    repo: &RepositoryMeta,
    d: &FetchedDocument,
    targets: &BTreeMap<String, TargetInfo>,
    merge_verified: bool,
) -> Option<WebhookEvent> {
    let target_id = id_field(d, "targetId")?;
    let target = targets.get(&target_id)?;
    let kind = d.field_u64("kind")?;
    let (action, open, merged) = event_action(kind, target.is_pr, merge_verified)?;
    let mut e = if target.is_pr {
        pull_request_event(
            repo,
            &d.id,
            action,
            &target.pr_obj(&target_id, open, merged),
        )
    } else {
        issues_event(repo, &d.id, action, &target.issue_obj(&target_id, open))
    };
    // The actor is the event's writer, not the target's author.
    e.payload["sender"] = repo.user_json(&d.owner_id);
    if kind == 3 && !merge_verified {
        e.payload["dash_merge_unverified"] = serde_json::Value::Bool(true);
    }
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
            base_ref_hash: String::new(),
            baseline: Baseline::Beginning,
            last_activity: 0,
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
        let e = translate_review(&meta(), &r, &targets([3; 32], target(true, 8))).unwrap();
        assert_eq!(e.event, "pull_request_review");
        assert_eq!(e.payload["review"]["state"], "changes_requested");
        assert_eq!(e.payload["review"]["commit_id"], "ab".repeat(20));
        assert_eq!(e.payload["pull_request"]["number"], 8);
        assert_eq!(e.payload["sender"]["login"], "REVIEWER");
        // A review of an issue id, or of an unknown PR, is not delivered.
        assert!(translate_review(&meta(), &r, &targets([3; 32], target(false, 8))).is_none());
        assert!(translate_review(&meta(), &r, &BTreeMap::new()).is_none());
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
        let e = translate_release(&meta(), &d).unwrap();
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
        let e = translate_release(&meta(), &bad_assets).unwrap();
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
        let e = translate_check_run(&meta(), &d).unwrap();
        assert_eq!(e.payload["check_run"]["head_sha"], "dead");
        assert_eq!(e.payload["action"], "completed");
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
        let prs = targets([9; 32], target(true, 3));
        let e = translate_event(&meta(), &ev("m", 3, None, [9; 32]), &prs, true).unwrap();
        assert_eq!(e.event, "pull_request");
        assert_eq!(e.payload["action"], "closed");
        assert_eq!(e.payload["pull_request"]["merged"], true);
        assert_eq!(e.payload["sender"]["login"], "ACTOR");

        let issues = targets([1; 32], target(false, 8));
        let e = translate_event(&meta(), &ev("c", 1, None, [1; 32]), &issues, false).unwrap();
        assert_eq!(e.event, "issues");
        assert_eq!(e.payload["issue"]["state"], "closed");
        let e = translate_event(&meta(), &ev("r", 2, None, [1; 32]), &issues, false).unwrap();
        assert_eq!(e.payload["action"], "reopened");
        assert_eq!(e.payload["issue"]["state"], "open");

        let e =
            translate_event(&meta(), &ev("l", 4, Some("bug"), [1; 32]), &issues, false).unwrap();
        assert_eq!(e.payload["action"], "labeled");
        assert_eq!(e.payload["label"]["name"], "bug");
        let e =
            translate_event(&meta(), &ev("a", 6, Some("BOB"), [1; 32]), &issues, false).unwrap();
        assert_eq!(e.payload["assignee"]["login"], "BOB");

        // Merge, retarget, draft and ready mean nothing on an issue; unknown targets and
        // kinds are skipped.
        for kind in [3, 8, 9, 10, 11] {
            assert!(
                translate_event(&meta(), &ev("x", kind, None, [1; 32]), &issues, false).is_none()
            );
        }
        assert!(translate_event(&meta(), &ev("x", 1, None, [5; 32]), &issues, false).is_none());
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
    fn unverified_merges_and_yanked_releases() {
        let prs = targets([9; 32], target(true, 3));
        let merge = doc(
            "m",
            "ACTOR",
            vec![
                ("targetId", FieldValue::identifier([9; 32])),
                ("kind", FieldValue::integer(3)),
            ],
        );
        let e = translate_event(&meta(), &merge, &prs, false).unwrap();
        assert_eq!(e.payload["action"], "closed");
        assert_eq!(e.payload["pull_request"]["merged"], false);
        assert_eq!(e.payload["dash_merge_unverified"], true);
        let e = translate_event(&meta(), &merge, &prs, true).unwrap();
        assert!(e.payload.get("dash_merge_unverified").is_none());

        let yanked = doc(
            "r",
            "M",
            vec![
                ("tagName", FieldValue::text("v1")),
                ("yanked", FieldValue::boolean(true)),
            ],
        );
        let e = translate_release(&meta(), &yanked).unwrap();
        assert_eq!(e.payload["action"], "unpublished");
    }
}
