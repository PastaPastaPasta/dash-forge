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
//! After that each read pages ascending with `start_after` = the last document seen, to a
//! short page. forge-v2 is protocol 14, where `start_after` is bounded by document id, so
//! documents of the cursor's own block that sort after it are not skipped (the protocol-13
//! whole-timestamp exclusion `PlatformClient::query_all_documents` works around does not
//! apply). A failed read leaves the cursor where it was, so the next cycle retries: delivery
//! is at-least-once and consumers dedupe on `X-GitHub-Delivery`.
//!
//! The `translate_*` functions are pure (`FetchedDocument` → [`WebhookEvent`]) and tested
//! offline.

use std::collections::BTreeMap;

use forge_core::platform::{
    encode_identifier, FetchedDocument, LoadedContract, PlatformClient, QueryFilter, QueryOp,
    QueryOrder,
};

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

/// One stream's position.
#[derive(Debug, Clone)]
pub struct Cursor {
    baseline: Baseline,
    /// The last document delivered (or the baseline tail).
    last_id: Option<String>,
    primed: bool,
}

impl Cursor {
    /// A fresh cursor that starts at `baseline`.
    pub fn new(baseline: Baseline) -> Self {
        Self {
            baseline,
            last_id: None,
            primed: false,
        }
    }
}

/// Read the documents of one stream that are new since `cursor`, advancing a copy of it; the
/// caller commits the copy only when every page was read (see the module docs).
///
/// `prefix` pins the leading properties of an index that ends in `$createdAt`.
pub async fn poll_stream(
    client: &PlatformClient,
    contract: &LoadedContract,
    doc_type: &str,
    prefix: &[QueryFilter],
    cursor: &mut Cursor,
) -> Result<Vec<FetchedDocument>> {
    if let (false, Baseline::Tail { lookback }) = (cursor.primed, cursor.baseline) {
        // The tail in one descending page (no cursor, which every protocol proves).
        let tail = client
            .query_documents(
                contract,
                doc_type,
                prefix,
                &[QueryOrder::desc("$createdAt")],
                lookback.clamp(1, PAGE),
                None,
            )
            .await?;
        cursor.last_id = tail.first().map(|d| d.id.clone());
        cursor.primed = true;
        let mut replay: Vec<_> = tail.into_iter().take(lookback as usize).collect();
        replay.reverse();
        return Ok(replay);
    }

    let mut out = Vec::new();
    loop {
        let mut filters = prefix.to_vec();
        // Until a first document is seen, a `Since` stream stays bounded below by its time
        // (an empty first read must not fall back to the whole history).
        if let (None, Baseline::Since(ts)) = (&cursor.last_id, cursor.baseline) {
            filters.push(QueryFilter {
                field: "$createdAt".into(),
                op: QueryOp::Gte,
                value: forge_core::platform::FieldValue::uint64(ts),
            });
        }
        let page = client
            .query_documents(
                contract,
                doc_type,
                &filters,
                &[QueryOrder::asc("$createdAt")],
                PAGE,
                cursor.last_id.as_deref(),
            )
            .await?;
        let n = page.len();
        if let Some(last) = page.last() {
            cursor.last_id = Some(last.id.clone());
        }
        out.extend(page);
        if n < PAGE as usize {
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
    /// Where this target's comment and review streams start.
    pub baseline: Baseline,
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
            baseline,
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
            baseline,
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

/// A `refUpdate` / `protectedRefUpdate` → `push`. `None` for a private repo's update (its
/// `refName` is inside `enc`).
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

/// A `release` → `release` published.
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
    Some(release_event(repo, &d.id, &r))
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
fn event_action(kind: u64, is_pr: bool) -> Option<(&'static str, bool, bool)> {
    Some(match kind {
        1 => ("closed", false, false),
        2 => ("reopened", true, false),
        // Merge: `merged` is what the event claims. Whether `oid` is reachable from the base
        // tip is a client rule the relay does not check; a consumer verifies it.
        3 if is_pr => ("closed", false, true),
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
pub fn translate_event(
    repo: &RepositoryMeta,
    d: &FetchedDocument,
    targets: &BTreeMap<String, TargetInfo>,
) -> Option<WebhookEvent> {
    let target_id = id_field(d, "targetId")?;
    let target = targets.get(&target_id)?;
    let kind = d.field_u64("kind")?;
    let (action, open, merged) = event_action(kind, target.is_pr)?;
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
            baseline: Baseline::Beginning,
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
        let e = translate_event(&meta(), &ev("m", 3, None, [9; 32]), &prs).unwrap();
        assert_eq!(e.event, "pull_request");
        assert_eq!(e.payload["action"], "closed");
        assert_eq!(e.payload["pull_request"]["merged"], true);
        assert_eq!(e.payload["sender"]["login"], "ACTOR");

        let issues = targets([1; 32], target(false, 8));
        let e = translate_event(&meta(), &ev("c", 1, None, [1; 32]), &issues).unwrap();
        assert_eq!(e.event, "issues");
        assert_eq!(e.payload["issue"]["state"], "closed");
        let e = translate_event(&meta(), &ev("r", 2, None, [1; 32]), &issues).unwrap();
        assert_eq!(e.payload["action"], "reopened");
        assert_eq!(e.payload["issue"]["state"], "open");

        let e = translate_event(&meta(), &ev("l", 4, Some("bug"), [1; 32]), &issues).unwrap();
        assert_eq!(e.payload["action"], "labeled");
        assert_eq!(e.payload["label"]["name"], "bug");
        let e = translate_event(&meta(), &ev("a", 6, Some("BOB"), [1; 32]), &issues).unwrap();
        assert_eq!(e.payload["assignee"]["login"], "BOB");

        // Merge, retarget, draft and ready mean nothing on an issue; unknown targets and
        // kinds are skipped.
        for kind in [3, 8, 9, 10, 11] {
            assert!(translate_event(&meta(), &ev("x", kind, None, [1; 32]), &issues).is_none());
        }
        assert!(translate_event(&meta(), &ev("x", 1, None, [5; 32]), &issues).is_none());
    }
}
