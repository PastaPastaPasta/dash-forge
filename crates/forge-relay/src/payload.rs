//! GitHub-compatible webhook payload construction (PRD 05 §Translate).
//!
//! The relay's value proposition is that existing CI tooling
//! (Blacksmith/Depot/Jenkins/GitHub Actions runners) integrates with near-zero work:
//! the JSON bodies here reuse GitHub's field names and shapes for the four core event
//! types — `push`, `pull_request`, `issue_comment`, `check_run` (plus `issues`, which
//! falls out for free). Fields GitHub derives server-side (compare/commit URLs, the
//! integer `repository.id`) are mapped onto forge-web URL conventions or a deterministic
//! surrogate; nothing here trusts the relay — a verifying consumer re-fetches from
//! Platform (see the reference `examples/ci_consumer.rs`).
//!
//! Every builder is a pure `FetchedDocument`/scalar → `serde_json::Value` function so the
//! whole mapping layer is unit-testable without a network.

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

/// An all-zero git oid (40 hex zeros) — the sentinel for "ref did not exist" (`before`
/// on a branch create) or "ref deleted" (`after` on a delete), matching git/GitHub.
pub const ZERO_OID: &str = "0000000000000000000000000000000000000000";

/// Whether an oid hex string is the all-zero sentinel (empty counts as zero too).
pub fn is_zero_oid(oid: &str) -> bool {
    oid.is_empty() || oid.bytes().all(|b| b == b'0')
}

/// Static metadata describing the repository a payload is about, mapped to GitHub's
/// `repository` object shape. Built once per watched repo and cloned into every payload.
#[derive(Debug, Clone)]
pub struct RepositoryMeta {
    /// The repo data-contract id (base58) — GitHub's `node_id` / our `dash_contract_id`.
    pub contract_id: String,
    /// The repo owner identity id (base58) — GitHub's `owner.login`.
    pub owner_id: String,
    /// The repository name (from the registry `repoListing`), e.g. `dash-forge`.
    pub name: String,
    /// The default branch (from the newest `config`), e.g. `main`.
    pub default_branch: String,
    /// The forge-web base URL used to synthesize `html_url` / `compare` links.
    pub web_base_url: String,
}

impl RepositoryMeta {
    /// A deterministic unsigned surrogate for GitHub's integer `repository.id` (some
    /// tooling insists the field is numeric). Derived from the contract id so it is
    /// stable across relay instances and restarts.
    fn numeric_id(&self) -> u64 {
        let digest = Sha256::digest(self.contract_id.as_bytes());
        u64::from_be_bytes(digest[..8].try_into().expect("sha256 has 8+ bytes"))
    }

    /// `<web_base>/<owner>/<name>` — the forge-web repo home.
    fn html_url(&self) -> String {
        format!(
            "{}/{}/{}",
            self.web_base_url.trim_end_matches('/'),
            self.owner_id,
            self.name
        )
    }

    /// GitHub's `full_name` (`owner/repo`). Owner is the identity id (there is no
    /// separate username namespace on Platform).
    fn full_name(&self) -> String {
        format!("{}/{}", self.owner_id, self.name)
    }

    /// The GitHub-shape `repository` object.
    pub fn to_json(&self) -> Value {
        json!({
            "id": self.numeric_id(),
            "node_id": self.contract_id,
            "dash_contract_id": self.contract_id,
            "name": self.name,
            "full_name": self.full_name(),
            "private": false,
            "owner": self.user_json(&self.owner_id),
            "html_url": self.html_url(),
            "url": self.html_url(),
            "default_branch": self.default_branch,
        })
    }

    /// A GitHub-shape `user` object for an identity id (used for `owner`, `sender`,
    /// `pusher`, comment/issue authors). Platform identities have no login/email, so the
    /// base58 identity id is used as the login and a synthetic profile URL is derived.
    pub fn user_json(&self, identity_id: &str) -> Value {
        json!({
            "login": identity_id,
            "id": identity_id,
            "node_id": identity_id,
            "type": "User",
            "html_url": format!("{}/{}", self.web_base_url.trim_end_matches('/'), identity_id),
        })
    }
}

/// A fully-built webhook event: the GitHub event name (for `X-GitHub-Event`), the
/// serialized body, and the source document id (the dedup/delivery-id seed — consumers
/// dedupe on the delivery id at-least-once semantics require, PRD 05 §Deliver).
#[derive(Debug, Clone)]
pub struct WebhookEvent {
    /// The GitHub event name: `push` / `pull_request` / `issue_comment` / `check_run` /
    /// `issues`. Sent verbatim as the `X-GitHub-Event` header.
    pub event: &'static str,
    /// The `action` sub-type where GitHub has one (`opened`, `closed`, `created`, …).
    pub action: Option<&'static str>,
    /// The JSON body to POST.
    pub payload: Value,
    /// The Platform document id this event was translated from — the stable dedup key.
    pub source_doc_id: String,
}

/// Build a `push` event. `before`/`after` are hex oids (`after` all-zero = branch
/// delete, `before` all-zero = branch create); `forced` mirrors the refUpdate `force`
/// flag; `pusher_id` is the update author's identity id.
pub fn push_event(
    repo: &RepositoryMeta,
    source_doc_id: &str,
    ref_name: &str,
    before: &str,
    after: &str,
    forced: bool,
    pusher_id: &str,
) -> WebhookEvent {
    let created = is_zero_oid(before);
    let deleted = is_zero_oid(after);
    let before = if before.is_empty() { ZERO_OID } else { before };
    let after = if after.is_empty() { ZERO_OID } else { after };
    let compare = format!(
        "{}/{}/{}/compare/{}...{}",
        repo.web_base_url.trim_end_matches('/'),
        repo.owner_id,
        repo.name,
        before,
        after
    );
    let payload = json!({
        "ref": ref_name,
        "before": before,
        "after": after,
        "created": created,
        "deleted": deleted,
        "forced": forced,
        "base_ref": Value::Null,
        "compare": compare,
        // The relay has no commit graph (consumers re-fetch objects from Platform to
        // build one), so the commit list is empty and head_commit is null — a faithful,
        // pragmatic omission GitHub tooling tolerates.
        "commits": Value::Array(vec![]),
        "head_commit": Value::Null,
        "repository": repo.to_json(),
        "pusher": { "name": pusher_id, "email": Value::Null },
        "sender": repo.user_json(pusher_id),
    });
    WebhookEvent {
        event: "push",
        action: None,
        payload,
        source_doc_id: source_doc_id.to_string(),
    }
}

/// A pull-request object (subset of GitHub's `pull_request`).
#[derive(Debug, Clone)]
pub struct PullRequestObj {
    /// PR number.
    pub number: u64,
    /// Document id (GitHub's `node_id`).
    pub document_id: String,
    /// Author identity id.
    pub author: String,
    /// Title.
    pub title: String,
    /// Body.
    pub body: String,
    /// Base ref name (`refs/heads/main`).
    pub base_ref: String,
    /// Head oid (hex).
    pub head_oid: String,
    /// Open (`true`) / closed (`false`).
    pub open: bool,
    /// Merged.
    pub merged: bool,
}

/// Build a `pull_request` event (`action` = `opened` / `closed` / `reopened`).
pub fn pull_request_event(
    repo: &RepositoryMeta,
    source_doc_id: &str,
    action: &'static str,
    pr: &PullRequestObj,
) -> WebhookEvent {
    let state = if pr.open { "open" } else { "closed" };
    let html_url = format!(
        "{}/{}/{}/pull/{}",
        repo.web_base_url.trim_end_matches('/'),
        repo.owner_id,
        repo.name,
        pr.number
    );
    let payload = json!({
        "action": action,
        "number": pr.number,
        "pull_request": {
            "id": pr.document_id,
            "node_id": pr.document_id,
            "number": pr.number,
            "state": state,
            "title": pr.title,
            "body": pr.body,
            "html_url": html_url,
            "merged": pr.merged,
            "user": repo.user_json(&pr.author),
            "head": { "ref": Value::Null, "sha": pr.head_oid },
            "base": { "ref": pr.base_ref, "sha": Value::Null },
        },
        "repository": repo.to_json(),
        "sender": repo.user_json(&pr.author),
    });
    WebhookEvent {
        event: "pull_request",
        action: Some(action),
        payload,
        source_doc_id: source_doc_id.to_string(),
    }
}

/// A minimal issue object embedded in issue / issue_comment payloads.
#[derive(Debug, Clone)]
pub struct IssueObj {
    /// Issue number.
    pub number: u64,
    /// Document id.
    pub document_id: String,
    /// Author identity id.
    pub author: String,
    /// Title.
    pub title: String,
    /// Body.
    pub body: String,
    /// Open / closed.
    pub open: bool,
}

impl IssueObj {
    fn to_json(&self, repo: &RepositoryMeta) -> Value {
        let state = if self.open { "open" } else { "closed" };
        let html_url = format!(
            "{}/{}/{}/issues/{}",
            repo.web_base_url.trim_end_matches('/'),
            repo.owner_id,
            repo.name,
            self.number
        );
        json!({
            "id": self.document_id,
            "node_id": self.document_id,
            "number": self.number,
            "state": state,
            "title": self.title,
            "body": self.body,
            "html_url": html_url,
            "user": repo.user_json(&self.author),
        })
    }
}

/// Build an `issues` event (`action` = `opened` / `closed` / `reopened`).
pub fn issues_event(
    repo: &RepositoryMeta,
    source_doc_id: &str,
    action: &'static str,
    issue: &IssueObj,
) -> WebhookEvent {
    let payload = json!({
        "action": action,
        "issue": issue.to_json(repo),
        "repository": repo.to_json(),
        "sender": repo.user_json(&issue.author),
    });
    WebhookEvent {
        event: "issues",
        action: Some(action),
        payload,
        source_doc_id: source_doc_id.to_string(),
    }
}

/// Build an `issue_comment` event (`action` = `created`). `issue` is the commented-on
/// issue/PR; when the target could not be resolved a minimal stub is used.
pub fn issue_comment_event(
    repo: &RepositoryMeta,
    source_doc_id: &str,
    issue: &IssueObj,
    comment_id: &str,
    commenter: &str,
    body: &str,
) -> WebhookEvent {
    let html_url = format!(
        "{}/{}/{}/issues/{}#comment-{}",
        repo.web_base_url.trim_end_matches('/'),
        repo.owner_id,
        repo.name,
        issue.number,
        comment_id
    );
    let payload = json!({
        "action": "created",
        "issue": issue.to_json(repo),
        "comment": {
            "id": comment_id,
            "node_id": comment_id,
            "body": body,
            "html_url": html_url,
            "user": repo.user_json(commenter),
        },
        "repository": repo.to_json(),
        "sender": repo.user_json(commenter),
    });
    WebhookEvent {
        event: "issue_comment",
        action: Some("created"),
        payload,
        source_doc_id: source_doc_id.to_string(),
    }
}

/// A check-run object (mirrors GitHub's modern check-runs shape — the legacy
/// commit-status API is an explicit non-goal, PRD 05).
#[derive(Debug, Clone)]
pub struct CheckRunObj {
    /// Document id.
    pub document_id: String,
    /// The head commit oid the run is for (hex).
    pub head_oid: String,
    /// Check name.
    pub name: String,
    /// Status: `queued` / `in_progress` / `completed`.
    pub status: String,
    /// Conclusion (when completed): `success` / `failure` / …
    pub conclusion: String,
    /// Details URL.
    pub details_url: String,
    /// Summary text.
    pub summary: String,
    /// Runner identity id (who attested — the check is as trustworthy as this identity).
    pub runner_id: String,
}

/// Build a `check_run` event. `action` is `completed` when the run has a terminal
/// status, else `created`.
pub fn check_run_event(
    repo: &RepositoryMeta,
    source_doc_id: &str,
    cr: &CheckRunObj,
) -> WebhookEvent {
    let action = if cr.status == "completed" {
        "completed"
    } else {
        "created"
    };
    let conclusion = if cr.conclusion.is_empty() {
        Value::Null
    } else {
        Value::String(cr.conclusion.clone())
    };
    let payload = json!({
        "action": action,
        "check_run": {
            "id": cr.document_id,
            "node_id": cr.document_id,
            "head_sha": cr.head_oid,
            "name": cr.name,
            "status": cr.status,
            "conclusion": conclusion,
            "details_url": cr.details_url,
            "output": { "title": cr.name, "summary": cr.summary },
            "app": repo.user_json(&cr.runner_id),
        },
        "repository": repo.to_json(),
        "sender": repo.user_json(&cr.runner_id),
    });
    WebhookEvent {
        event: "check_run",
        action: Some(action),
        payload,
        source_doc_id: source_doc_id.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo() -> RepositoryMeta {
        RepositoryMeta {
            contract_id: "5rrwgjjVUqMghnessfiXPXubpiM2QLNNXH142Hv4PDyX".into(),
            owner_id: "8hJmcHWTsdvkHyCrk4UgjbyugDAmE7QfuCTQXpXAc7nB".into(),
            name: "dash-forge".into(),
            default_branch: "main".into(),
            web_base_url: "https://forge.example".into(),
        }
    }

    #[test]
    fn zero_oid_detection() {
        assert!(is_zero_oid(ZERO_OID));
        assert!(is_zero_oid(""));
        assert!(!is_zero_oid("deadbeef"));
    }

    #[test]
    fn push_payload_has_github_fields() {
        let e = push_event(
            &repo(),
            "doc1",
            "refs/heads/main",
            "1111111111111111111111111111111111111111",
            "2222222222222222222222222222222222222222",
            false,
            "8hJmcHWTsdvkHyCrk4UgjbyugDAmE7QfuCTQXpXAc7nB",
        );
        assert_eq!(e.event, "push");
        let p = &e.payload;
        assert_eq!(p["ref"], "refs/heads/main");
        assert_eq!(p["before"], "1111111111111111111111111111111111111111");
        assert_eq!(p["after"], "2222222222222222222222222222222222222222");
        assert_eq!(p["created"], false);
        assert_eq!(p["deleted"], false);
        assert_eq!(p["forced"], false);
        assert!(p["commits"].is_array());
        assert!(p["repository"]["id"].is_u64());
        assert_eq!(p["repository"]["name"], "dash-forge");
        assert_eq!(p["repository"]["default_branch"], "main");
        assert_eq!(
            p["pusher"]["name"],
            "8hJmcHWTsdvkHyCrk4UgjbyugDAmE7QfuCTQXpXAc7nB"
        );
        assert!(p["compare"].as_str().unwrap().contains("compare/1111"));
    }

    #[test]
    fn push_created_and_deleted_flags() {
        let created = push_event(&repo(), "d", "refs/heads/feat", ZERO_OID, "aa", false, "x");
        assert_eq!(created.payload["created"], true);
        assert_eq!(created.payload["deleted"], false);

        let deleted = push_event(&repo(), "d", "refs/heads/feat", "aa", ZERO_OID, false, "x");
        assert_eq!(deleted.payload["created"], false);
        assert_eq!(deleted.payload["deleted"], true);
    }

    #[test]
    fn pull_request_payload_shape() {
        let pr = PullRequestObj {
            number: 7,
            document_id: "pr7doc".into(),
            author: "author1".into(),
            title: "Add feature".into(),
            body: "body".into(),
            base_ref: "refs/heads/main".into(),
            head_oid: "cafe".into(),
            open: true,
            merged: false,
        };
        let e = pull_request_event(&repo(), "pr7doc", "opened", &pr);
        assert_eq!(e.event, "pull_request");
        assert_eq!(e.payload["action"], "opened");
        assert_eq!(e.payload["number"], 7);
        assert_eq!(e.payload["pull_request"]["state"], "open");
        assert_eq!(e.payload["pull_request"]["title"], "Add feature");
        assert_eq!(e.payload["pull_request"]["base"]["ref"], "refs/heads/main");
        assert_eq!(e.payload["pull_request"]["head"]["sha"], "cafe");
    }

    #[test]
    fn issue_comment_payload_shape() {
        let issue = IssueObj {
            number: 3,
            document_id: "issue3".into(),
            author: "author1".into(),
            title: "Bug".into(),
            body: String::new(),
            open: true,
        };
        let e = issue_comment_event(&repo(), "cmt1", &issue, "cmt1", "commenter1", "looks good");
        assert_eq!(e.event, "issue_comment");
        assert_eq!(e.payload["action"], "created");
        assert_eq!(e.payload["issue"]["number"], 3);
        assert_eq!(e.payload["comment"]["body"], "looks good");
        assert_eq!(e.payload["comment"]["user"]["login"], "commenter1");
    }

    #[test]
    fn check_run_completed_action() {
        let cr = CheckRunObj {
            document_id: "cr1".into(),
            head_oid: "deadbeef".into(),
            name: "build".into(),
            status: "completed".into(),
            conclusion: "success".into(),
            details_url: "https://ci.example/1".into(),
            summary: "ok".into(),
            runner_id: "runner1".into(),
        };
        let e = check_run_event(&repo(), "cr1", &cr);
        assert_eq!(e.event, "check_run");
        assert_eq!(e.payload["action"], "completed");
        assert_eq!(e.payload["check_run"]["head_sha"], "deadbeef");
        assert_eq!(e.payload["check_run"]["conclusion"], "success");
        assert_eq!(e.payload["check_run"]["status"], "completed");
    }

    #[test]
    fn check_run_created_when_not_completed() {
        let cr = CheckRunObj {
            document_id: "cr2".into(),
            head_oid: "d".into(),
            name: "build".into(),
            status: "in_progress".into(),
            conclusion: String::new(),
            details_url: String::new(),
            summary: String::new(),
            runner_id: "runner1".into(),
        };
        let e = check_run_event(&repo(), "cr2", &cr);
        assert_eq!(e.payload["action"], "created");
        assert!(e.payload["check_run"]["conclusion"].is_null());
    }

    #[test]
    fn issues_event_shape() {
        let issue = IssueObj {
            number: 12,
            document_id: "i12".into(),
            author: "a".into(),
            title: "T".into(),
            body: "B".into(),
            open: false,
        };
        let e = issues_event(&repo(), "i12", "closed", &issue);
        assert_eq!(e.event, "issues");
        assert_eq!(e.payload["action"], "closed");
        assert_eq!(e.payload["issue"]["state"], "closed");
    }

    #[test]
    fn numeric_repo_id_is_stable() {
        let a = repo().to_json()["id"].as_u64().unwrap();
        let b = repo().to_json()["id"].as_u64().unwrap();
        assert_eq!(a, b);
    }
}
