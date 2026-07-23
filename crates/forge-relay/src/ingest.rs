//! Ingest: poll each watched repo contract for new documents and translate them into
//! GitHub-shape [`WebhookEvent`]s (PRD 05 §Ingest/§Translate; Platform has no document
//! push subscriptions, so we poll indexed queries with cursors — spike S0.8 / D6).
//!
//! The two halves are kept separate so the mapping is fully unit-testable offline:
//!  * [`poll_new`] — the cursor primitive that returns only documents created since the
//!    last cycle (baselined to "now" at startup unless a lookback is configured).
//!  * the `translate_*` free functions — pure `FetchedDocument` → [`WebhookEvent`] maps.

use std::collections::BTreeMap;

use forge_core::platform::{
    encode_identifier, FetchedDocument, LoadedContract, PlatformClient, QueryFilter, QueryOrder,
};
use forge_core::repo::TESTNET_REGISTRY_CONTRACT_ID;

use crate::error::Result;
use crate::payload::{
    check_run_event, is_zero_oid, issue_comment_event, issues_event, pull_request_event,
    push_event, CheckRunObj, IssueObj, PullRequestObj, RepositoryMeta, WebhookEvent,
};

/// Repo-contract document type names the relay ingests.
pub const DOC_REF_UPDATE: &str = "refUpdate";
pub const DOC_PROTECTED_REF_UPDATE: &str = "protectedRefUpdate";
pub const DOC_ISSUE: &str = "issue";
pub const DOC_PATCH: &str = "patch";
pub const DOC_COMMENT: &str = "comment";
pub const DOC_EVENT: &str = "event";
pub const DOC_CHECK_RUN: &str = "checkRun";
const DOC_CONFIG: &str = "config";
const DOC_REPO_LISTING: &str = "repoListing";

/// A per-(repo, docType) ingest cursor. `primed` marks that the startup baseline has been
/// taken (so historical docs are not replayed); `last_id` is the newest document `$id`
/// delivered so far (the `$createdAt asc` traversal seeks past it).
#[derive(Debug, Default, Clone)]
pub struct Cursor {
    /// The last delivered document `$id`, or `None` when the repo had no docs at prime.
    pub last_id: Option<String>,
    /// Whether the startup baseline has been established.
    pub primed: bool,
}

/// Fetch documents of `doc_type` created since the cursor last advanced, updating the
/// cursor.
///
/// Both the priming pass and steady-state seek traverse in **`$createdAt` ascending**
/// order — the same direction — so the cursor stays consistent even for doc types whose
/// only usable `$createdAt` index is a compound one (`comment` = `(targetId, $createdAt)`,
/// `checkRun` = `(headOid, $createdAt)`): a mixed desc-prime / asc-seek would surface
/// historical rows on those types because the "newest by desc" is not the "last by asc".
///
/// On the first call (`!primed`) it pages to the true chronological tail to establish the
/// baseline: with `lookback == 0` it delivers nothing (start from "now"); with
/// `lookback > 0` it replays the last `lookback` docs so a fresh relay can catch up recent
/// history. Steady-state seeks past the cursor and pages to exhaustion.
/// Poll new documents of `doc_type` since `cursor`, with an optional index `filters`
/// prefix. An empty filter suits types with a standalone `$createdAt` index (`refUpdate`,
/// `issue`, `patch`, `event`); a leading-property filter is required for types whose only
/// `$createdAt` index is compound (`comment` = `(targetId, $createdAt)`, `checkRun` =
/// `(headOid, $createdAt)`) — a global `orderBy $createdAt` on those is not servable, so
/// the caller polls them keyed by the leading index property (per target / per head-oid)
/// with a per-key cursor.
pub async fn poll_new_filtered(
    client: &PlatformClient,
    contract: &LoadedContract,
    doc_type: &str,
    filters: &[QueryFilter],
    cursor: &mut Cursor,
    lookback: u32,
) -> Result<Vec<FetchedDocument>> {
    // Page the whole ascending traversal past the current cursor. On prime the cursor is
    // None, so this walks all history to the tail (bounded by real doc count — fine for M2
    // small repos); steady-state it starts after the last-seen id and returns only new docs.
    let priming = !cursor.primed;
    let mut fresh: Vec<FetchedDocument> = Vec::new();
    let mut start_after = cursor.last_id.clone();
    loop {
        let page = client
            .query_documents(
                contract,
                doc_type,
                filters,
                &[QueryOrder::asc("$createdAt")],
                100,
                start_after.as_deref(),
            )
            .await?;
        let n = page.len();
        if let Some(last) = page.last() {
            start_after = Some(last.id.clone());
            cursor.last_id = Some(last.id.clone());
        }
        fresh.extend(page);
        if n < 100 {
            break;
        }
    }

    if priming {
        cursor.primed = true;
        if lookback == 0 {
            // Baseline established (cursor at the tail); deliver nothing historical.
            return Ok(Vec::new());
        }
        // Replay only the last `lookback` docs (they are chronological; keep the tail).
        let start = fresh.len().saturating_sub(lookback as usize);
        return Ok(fresh.split_off(start));
    }

    Ok(fresh)
}

/// What an `event`/`comment` `targetId` points at — enough to fill the embedded
/// issue/PR object faithfully without a second fetch per event.
#[derive(Debug, Clone)]
pub struct TargetInfo {
    /// Whether the target is a pull request (`patch`) rather than an issue.
    pub is_pr: bool,
    /// The issue/PR number.
    pub number: u64,
    /// The author identity id.
    pub author: String,
    /// The title.
    pub title: String,
    /// The base ref (PRs only).
    pub base_ref: String,
    /// The head oid (PRs only, hex).
    pub head_oid: String,
}

/// The resolved static context for one watched repo, held across poll cycles.
pub struct RepoContext {
    /// The repo contract handle.
    pub contract: LoadedContract,
    /// GitHub-shape repository metadata.
    pub meta: RepositoryMeta,
    /// Per-cursor-key cursors (`"issue"`, `"comment:<targetId>"`, `"checkRun:<oid>"`, …).
    pub cursors: BTreeMap<String, Cursor>,
    /// `$id` → target info for issues/PRs (for comment/event translation, and the set of
    /// targets whose comments are polled per-target).
    pub targets: BTreeMap<String, TargetInfo>,
    /// Head oids seen on ingested pushes/PRs — the keys whose `checkRun` docs are polled
    /// per-oid (`checkRun` has no standalone `$createdAt` index). Hex.
    pub head_oids: std::collections::BTreeSet<String>,
    /// Cached webhook subscriptions (refreshed every `SUBS_REFRESH_CYCLES`, not every
    /// cycle — reading the on-Platform `webhook` docs every poll would sit on the hot path
    /// ahead of the fast push poll and inflate push-delivery latency under flaky nodes).
    pub subs: Vec<crate::subscriptions::WebhookSub>,
    /// Poll cycles elapsed (drives the subscription-refresh cadence).
    pub cycle: u64,
}

impl RepoContext {
    /// A mutable cursor for `doc_type` (created on first use).
    pub fn cursor(&mut self, doc_type: &str) -> &mut Cursor {
        self.cursors.entry(doc_type.to_string()).or_default()
    }
}

/// Build the GitHub-shape [`RepositoryMeta`] for a repo contract: owner from the contract,
/// name from the registry `repoListing`, default branch from the newest `config`.
pub async fn build_repo_meta(
    client: &PlatformClient,
    contract: &LoadedContract,
    web_base_url: &str,
) -> Result<RepositoryMeta> {
    let owner_id = contract.owner_id();
    let contract_id = contract.id();

    // Default branch from the newest config.
    let default_branch = client
        .query_documents(
            contract,
            DOC_CONFIG,
            &[],
            &[QueryOrder::desc("$createdAt")],
            1,
            None,
        )
        .await?
        .first()
        .and_then(|d| d.field_str("defaultBranch"))
        .unwrap_or_else(|| "main".to_string());

    // Name from the registry listing (best-effort; owner-scoped scan, match contract id).
    let name = resolve_repo_name(client, &owner_id, &contract_id)
        .await
        .unwrap_or(None)
        .unwrap_or_else(|| contract_id.clone());

    Ok(RepositoryMeta {
        contract_id,
        owner_id,
        name,
        default_branch,
        web_base_url: web_base_url.to_string(),
    })
}

/// Find the repo name by scanning the registry owner's `repoListing`s for one whose
/// `repoContractId` matches. Testnet registry only; returns `None` if not found.
async fn resolve_repo_name(
    client: &PlatformClient,
    owner_id: &str,
    contract_id: &str,
) -> Result<Option<String>> {
    let registry = client.fetch_contract(TESTNET_REGISTRY_CONTRACT_ID).await?;
    let owner_bytes = forge_core::platform::decode_identifier(owner_id)?;
    let want = forge_core::platform::decode_identifier(contract_id)?;
    let mut start_after: Option<String> = None;
    loop {
        let page = client
            .query_documents(
                &registry,
                DOC_REPO_LISTING,
                &[QueryFilter::eq(
                    "$ownerId",
                    forge_core::platform::FieldValue::identifier(owner_bytes),
                )],
                // Order by normalizedName to match the registry's compound `ownerName`
                // index ($ownerId, normalizedName) — the registry has no ($ownerId,
                // $createdAt) index, so ordering by $createdAt is rejected as non-indexed.
                &[QueryOrder::asc("normalizedName")],
                100,
                start_after.as_deref(),
            )
            .await?;
        let n = page.len();
        for d in &page {
            if d.field_bytes("repoContractId").as_deref() == Some(want.as_slice()) {
                return Ok(d.field_str("name"));
            }
        }
        if n < 100 {
            return Ok(None);
        }
        start_after = page.last().map(|d| d.id.clone());
    }
}

/// Preload the `$id` → [`TargetInfo`] index from existing issues and patches so events and
/// comments on pre-existing threads translate to the correct event type.
pub async fn preload_targets(
    client: &PlatformClient,
    contract: &LoadedContract,
) -> Result<BTreeMap<String, TargetInfo>> {
    let mut map = BTreeMap::new();
    for issue in client
        .query_documents(
            contract,
            DOC_ISSUE,
            &[],
            &[QueryOrder::desc("$createdAt")],
            0,
            None,
        )
        .await?
    {
        map.insert(issue.id.clone(), target_info_from_issue(&issue));
    }
    for pr in client
        .query_documents(
            contract,
            DOC_PATCH,
            &[],
            &[QueryOrder::desc("$createdAt")],
            0,
            None,
        )
        .await?
    {
        map.insert(pr.id.clone(), target_info_from_patch(&pr));
    }
    Ok(map)
}

/// Build a [`TargetInfo`] from an `issue` document.
pub fn target_info_from_issue(d: &FetchedDocument) -> TargetInfo {
    TargetInfo {
        is_pr: false,
        number: d.field_u64("number").unwrap_or_default(),
        author: d.owner_id.clone(),
        title: d.field_str("title").unwrap_or_default(),
        base_ref: String::new(),
        head_oid: String::new(),
    }
}

/// Build a [`TargetInfo`] from a `patch` (PR) document.
pub fn target_info_from_patch(d: &FetchedDocument) -> TargetInfo {
    TargetInfo {
        is_pr: true,
        number: d.field_u64("number").unwrap_or_default(),
        author: d.owner_id.clone(),
        title: d.field_str("title").unwrap_or_default(),
        base_ref: d.field_str("baseRefName").unwrap_or_default(),
        head_oid: d.field_hex("headOid").unwrap_or_default(),
    }
}

// ===========================================================================
// Pure translations (unit-tested offline)
// ===========================================================================

/// Translate a `refUpdate` / `protectedRefUpdate` document into a `push` event.
pub fn translate_ref_update(repo: &RepositoryMeta, d: &FetchedDocument) -> Option<WebhookEvent> {
    let ref_name = d.field_str("refName")?;
    let after = d.field_hex("newOid").unwrap_or_default();
    let before = d.field_hex("prevOid").unwrap_or_default();
    let forced = d.field_bool("force");
    Some(push_event(
        repo,
        &d.id,
        &ref_name,
        &before,
        &after,
        forced,
        &d.owner_id,
    ))
}

/// Translate an `issue` create into an `issues` `opened` event.
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

/// Translate a `patch` create into a `pull_request` `opened` event.
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

/// Translate a `comment` into an `issue_comment` `created` event. Uses `targets` to fill
/// the embedded issue object; an unknown target falls back to a minimal stub.
pub fn translate_comment(
    repo: &RepositoryMeta,
    d: &FetchedDocument,
    targets: &BTreeMap<String, TargetInfo>,
) -> Option<WebhookEvent> {
    let target_id = d
        .field_bytes("targetId")
        .and_then(|b| <[u8; 32]>::try_from(b).ok())
        .map(encode_identifier)?;
    let body = d.field_str("body").unwrap_or_default();
    let issue = match targets.get(&target_id) {
        Some(t) => IssueObj {
            number: t.number,
            document_id: target_id.clone(),
            author: t.author.clone(),
            title: t.title.clone(),
            body: String::new(),
            open: true,
        },
        None => IssueObj {
            number: 0,
            document_id: target_id.clone(),
            author: String::new(),
            title: String::new(),
            body: String::new(),
            open: true,
        },
    };
    Some(issue_comment_event(
        repo,
        &d.id,
        &issue,
        &d.id,
        &d.owner_id,
        &body,
    ))
}

/// Translate a `checkRun` into a `check_run` event.
pub fn translate_check_run(repo: &RepositoryMeta, d: &FetchedDocument) -> Option<WebhookEvent> {
    // A checkRun without a head oid is malformed (there is nothing to attach the run to);
    // skip it rather than emit a check_run with an empty head_sha.
    let head_oid = d.field_hex("headOid")?;
    let cr = CheckRunObj {
        document_id: d.id.clone(),
        head_oid,
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

/// Map an event `kind` (data-contracts §2.3) to a GitHub action for an issue vs a PR.
/// Returns `None` for kinds that have no clean GitHub analogue.
fn event_action(kind: u64, is_pr: bool) -> Option<(&'static str, bool)> {
    // (action, sets_merged)
    Some(match kind {
        1 => ("closed", false),                      // close
        2 => ("reopened", false),                    // reopen
        3 if is_pr => ("closed", true),              // merge (PR only)
        4 => ("labeled", false),                     // label+
        5 => ("unlabeled", false),                   // label-
        6 => ("assigned", false),                    // assign
        7 => ("unassigned", false),                  // unassign
        8 if is_pr => ("edited", false),             // retarget (PR base changed)
        9 if is_pr => ("converted_to_draft", false), // draft
        10 if is_pr => ("ready_for_review", false),  // ready
        _ => return None,
    })
}

/// Translate an `event` document into an `issues` or `pull_request` action event, using
/// `targets` to know which and to fill the embedded object. Unknown targets or kinds with
/// no GitHub analogue yield `None` (the cursor still advances past them).
pub fn translate_event(
    repo: &RepositoryMeta,
    d: &FetchedDocument,
    targets: &BTreeMap<String, TargetInfo>,
) -> Option<WebhookEvent> {
    let target_id = d
        .field_bytes("targetId")
        .and_then(|b| <[u8; 32]>::try_from(b).ok())
        .map(encode_identifier)?;
    let kind = d.field_u64("kind")?;
    let target = targets.get(&target_id)?;
    let (action, merged) = event_action(kind, target.is_pr)?;
    let open = !matches!(action, "closed");

    if target.is_pr {
        let pr = PullRequestObj {
            number: target.number,
            document_id: target_id.clone(),
            author: target.author.clone(),
            title: target.title.clone(),
            body: String::new(),
            base_ref: target.base_ref.clone(),
            head_oid: target.head_oid.clone(),
            open,
            merged,
        };
        Some(pull_request_event(repo, &d.id, action, &pr))
    } else {
        let issue = IssueObj {
            number: target.number,
            document_id: target_id.clone(),
            author: target.author.clone(),
            title: target.title.clone(),
            body: String::new(),
            open,
        };
        Some(issues_event(repo, &d.id, action, &issue))
    }
}

/// Whether a push doc represents a branch deletion (all-zero `newOid`) — surfaced so the
/// daemon can log it distinctly.
pub fn is_ref_deletion(d: &FetchedDocument) -> bool {
    match d.field_hex("newOid") {
        Some(o) => is_zero_oid(&o),
        None => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use forge_core::platform::FieldValue;

    fn meta() -> RepositoryMeta {
        RepositoryMeta {
            contract_id: "CONTRACT".into(),
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

    #[test]
    fn ref_update_translates_to_push() {
        let d = doc(
            "ref1",
            "OWNER",
            vec![
                ("refName", FieldValue::text("refs/heads/main")),
                ("newOid", FieldValue::bytes(hex::decode("22").unwrap())),
                ("prevOid", FieldValue::bytes(hex::decode("11").unwrap())),
                ("force", FieldValue::boolean(true)),
            ],
        );
        let e = translate_ref_update(&meta(), &d).unwrap();
        assert_eq!(e.event, "push");
        assert_eq!(e.payload["ref"], "refs/heads/main");
        assert_eq!(e.payload["after"], "22");
        assert_eq!(e.payload["before"], "11");
        assert_eq!(e.payload["forced"], true);
        assert_eq!(e.source_doc_id, "ref1");
    }

    #[test]
    fn ref_update_without_prev_is_branch_create() {
        let d = doc(
            "ref2",
            "OWNER",
            vec![
                ("refName", FieldValue::text("refs/heads/feature")),
                ("newOid", FieldValue::bytes(hex::decode("aa").unwrap())),
            ],
        );
        let e = translate_ref_update(&meta(), &d).unwrap();
        assert_eq!(e.payload["created"], true);
        assert!(!is_ref_deletion(&d));
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
        assert_eq!(e.event, "issues");
        assert_eq!(e.payload["action"], "opened");
        assert_eq!(e.payload["issue"]["number"], 5);

        let patch = doc(
            "p1",
            "AUTH",
            vec![
                ("number", FieldValue::integer(9)),
                ("title", FieldValue::text("PR")),
                ("baseRefName", FieldValue::text("refs/heads/main")),
                ("headOid", FieldValue::bytes(hex::decode("cafe").unwrap())),
            ],
        );
        let e = translate_patch(&meta(), &patch).unwrap();
        assert_eq!(e.event, "pull_request");
        assert_eq!(e.payload["pull_request"]["base"]["ref"], "refs/heads/main");
        assert_eq!(e.payload["pull_request"]["head"]["sha"], "cafe");
    }

    #[test]
    fn comment_uses_target_index() {
        let target_id = forge_core::platform::encode_identifier([7u8; 32]);
        let mut targets = BTreeMap::new();
        targets.insert(
            target_id.clone(),
            TargetInfo {
                is_pr: false,
                number: 42,
                author: "AUTH".into(),
                title: "Bug".into(),
                base_ref: String::new(),
                head_oid: String::new(),
            },
        );
        let c = doc(
            "c1",
            "COMMENTER",
            vec![
                ("targetId", FieldValue::identifier([7u8; 32])),
                ("body", FieldValue::text("nice")),
            ],
        );
        let e = translate_comment(&meta(), &c, &targets).unwrap();
        assert_eq!(e.event, "issue_comment");
        assert_eq!(e.payload["issue"]["number"], 42);
        assert_eq!(e.payload["comment"]["body"], "nice");
        assert_eq!(e.payload["comment"]["user"]["login"], "COMMENTER");
    }

    #[test]
    fn check_run_translates() {
        let d = doc(
            "cr1",
            "RUNNER",
            vec![
                (
                    "headOid",
                    FieldValue::bytes(hex::decode("deadbeef").unwrap()),
                ),
                ("name", FieldValue::text("build")),
                ("status", FieldValue::text("completed")),
                ("conclusion", FieldValue::text("success")),
                ("summary", FieldValue::text("ok")),
            ],
        );
        let e = translate_check_run(&meta(), &d).unwrap();
        assert_eq!(e.event, "check_run");
        assert_eq!(e.payload["check_run"]["head_sha"], "deadbeef");
        assert_eq!(e.payload["check_run"]["conclusion"], "success");
    }

    #[test]
    fn event_close_on_pr_sets_merged_for_merge_kind() {
        let target_id = forge_core::platform::encode_identifier([9u8; 32]);
        let mut targets = BTreeMap::new();
        targets.insert(
            target_id,
            TargetInfo {
                is_pr: true,
                number: 3,
                author: "AUTH".into(),
                title: "PR".into(),
                base_ref: "refs/heads/main".into(),
                head_oid: "cafe".into(),
            },
        );
        // kind 3 = merge.
        let d = doc(
            "ev1",
            "MAINT",
            vec![
                ("targetId", FieldValue::identifier([9u8; 32])),
                ("kind", FieldValue::integer(3)),
            ],
        );
        let e = translate_event(&meta(), &d, &targets).unwrap();
        assert_eq!(e.event, "pull_request");
        assert_eq!(e.payload["action"], "closed");
        assert_eq!(e.payload["pull_request"]["merged"], true);
        assert_eq!(e.payload["pull_request"]["state"], "closed");
    }

    #[test]
    fn event_close_on_issue() {
        let target_id = forge_core::platform::encode_identifier([1u8; 32]);
        let mut targets = BTreeMap::new();
        targets.insert(
            target_id,
            TargetInfo {
                is_pr: false,
                number: 8,
                author: "AUTH".into(),
                title: "Bug".into(),
                base_ref: String::new(),
                head_oid: String::new(),
            },
        );
        let d = doc(
            "ev2",
            "MAINT",
            vec![
                ("targetId", FieldValue::identifier([1u8; 32])),
                ("kind", FieldValue::integer(1)),
            ],
        );
        let e = translate_event(&meta(), &d, &targets).unwrap();
        assert_eq!(e.event, "issues");
        assert_eq!(e.payload["action"], "closed");
        assert_eq!(e.payload["issue"]["state"], "closed");
    }

    #[test]
    fn event_unknown_target_is_skipped() {
        let d = doc(
            "ev3",
            "MAINT",
            vec![
                ("targetId", FieldValue::identifier([5u8; 32])),
                ("kind", FieldValue::integer(1)),
            ],
        );
        assert!(translate_event(&meta(), &d, &BTreeMap::new()).is_none());
    }
}
