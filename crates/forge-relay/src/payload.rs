//! GitHub-compatible webhook payload construction (PRD 05 §Translate).
//!
//! The relay's value proposition is that existing CI tooling
//! (Blacksmith/Depot/Jenkins/GitHub Actions runners) integrates with near-zero work:
//! the JSON bodies here reuse GitHub's field names and shapes for `push`, `issues`,
//! `pull_request`, `issue_comment`, `pull_request_review`, `release` and `check_run`.
//! Fields GitHub derives server-side are mapped as below. Nothing here trusts the relay: a
//! verifying consumer re-fetches from Platform (see the reference `examples/ci_consumer.rs`).
//!
//! * **Ids.** GitHub's `id`s are integers: go-github decodes them as `int64`, and JavaScript's
//!   `JSON.parse` rounds anything above 2^53 − 1. Every `id` here is [`github_id`] of the
//!   Platform id: a deterministic integer in `1..=2^53 − 1`, the same on every relay. The
//!   base58 id itself is in `node_id`, GitHub's opaque global id. `repository` also carries
//!   it as `dash_repo_id` (D-605).
//! * **Links.** `html_url`s point at forge-web's real routes, under `--web-base-url` (default
//!   [`forge_core::user_error::WEB_ORIGIN`]). forge-web is a static export with query routes
//!   (`forge-web/hooks/use-query-param.ts` `repoHref`). It has no compare page and no
//!   per-comment or per-review anchors, so `compare` links the pushed commit (the repo, for a
//!   branch deletion), and a comment or review links its issue or PR (D-606).
//!
//! Every builder is a pure `FetchedDocument`/scalar → `serde_json::Value` function so the
//! whole mapping layer is unit-testable without a network.

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

/// The largest integer JavaScript represents exactly (`Number.MAX_SAFE_INTEGER`, 2^53 − 1).
/// Every `id` in a payload is at most this, so it also fits GitHub clients' `int64`.
pub const MAX_SAFE_ID: u64 = (1 << 53) - 1;

/// The integer `id` for a Platform id (a document or identity id, base58). It is the first 8
/// bytes of `sha256(id)`, big-endian, masked to 53 bits, and never 0. It is deterministic, so
/// every relay instance sends the same `id` for the same document.
pub fn github_id(platform_id: &str) -> u64 {
    let digest = Sha256::digest(platform_id.as_bytes());
    let n = u64::from_be_bytes(digest[..8].try_into().expect("sha256 has 8+ bytes"));
    (n & MAX_SAFE_ID).max(1)
}

/// An all-zero git oid (40 hex zeros) — the sentinel for "ref did not exist" (`before`
/// on a branch create) or "ref deleted" (`after` on a delete), matching git/GitHub.
pub const ZERO_OID: &str = "0000000000000000000000000000000000000000";

/// Whether an oid hex string is the all-zero sentinel (empty counts as zero too).
pub fn is_zero_oid(oid: &str) -> bool {
    oid.is_empty() || oid.bytes().all(|b| b == b'0')
}

/// Static metadata describing the repository a payload is about, mapped to GitHub's
/// `repository` object shape. Built from the forge-v2 `repo` document (and its newest
/// `config`) and cloned into every payload.
#[derive(Debug, Clone)]
pub struct RepositoryMeta {
    /// The forge-v2 `repo` document id (base58) — GitHub's `node_id` / our `dash_repo_id`.
    /// Consumers must verify against a repo id they configured, never this one.
    pub repo_id: String,
    /// The repo owner identity id (base58) — GitHub's `owner.login`.
    pub owner_id: String,
    /// The repository name (`repo.name`, the immutable slug), e.g. `dash-forge`.
    pub name: String,
    /// The default branch (newest `config`, else `repo.defaultBranch`), e.g. `main`.
    pub default_branch: String,
    /// The forge-web base URL used to synthesize `html_url` / `compare` links.
    pub web_base_url: String,
}

impl RepositoryMeta {
    /// A forge-web route of this repo, `<web base><route>/?owner=<owner>&name=<name>&<extra>`:
    /// the shape forge-web's `repoHref` builds (trailing slash, `URLSearchParams` encoding).
    fn web_href(&self, route: &str, extra: &[(&str, &str)]) -> String {
        let mut q = url::form_urlencoded::Serializer::new(String::new());
        q.append_pair("owner", &self.owner_id)
            .append_pair("name", &self.name);
        for (k, v) in extra {
            q.append_pair(k, v);
        }
        format!(
            "{}{route}/?{}",
            self.web_base_url.trim_end_matches('/'),
            q.finish()
        )
    }

    /// The repo home (`/repo/?owner=&name=`).
    fn html_url(&self) -> String {
        self.web_href("/repo", &[])
    }

    /// An issue (`/repo/issue/?…&number=`) or a PR (`/repo/pull/?…&number=`). Issues and PRs
    /// are numbered independently, so the route must match the kind. Number 0 (an unknown
    /// target) links the repo.
    fn thread_url(&self, is_pr: bool, number: u64) -> String {
        match (number, is_pr) {
            (0, _) => self.html_url(),
            (_, true) => self.web_href("/repo/pull", &[("number", &number.to_string())]),
            (_, false) => self.web_href("/repo/issue", &[("number", &number.to_string())]),
        }
    }

    /// A commit (`/repo/commit/?…&oid=`).
    fn commit_url(&self, oid: &str) -> String {
        self.web_href("/repo/commit", &[("oid", oid)])
    }

    /// A release (`/repo/release/?…&tag=`).
    fn release_url(&self, tag: &str) -> String {
        self.web_href("/repo/release", &[("tag", tag)])
    }

    /// GitHub's `full_name` (`owner/repo`). Owner is the identity id (there is no
    /// separate username namespace on Platform).
    fn full_name(&self) -> String {
        format!("{}/{}", self.owner_id, self.name)
    }

    /// The GitHub-shape `repository` object.
    pub fn to_json(&self) -> Value {
        json!({
            "id": github_id(&self.repo_id),
            "node_id": self.repo_id,
            "dash_repo_id": self.repo_id,
            "name": self.name,
            "full_name": self.full_name(),
            "private": false,
            "owner": self.user_json(&self.owner_id),
            "html_url": self.html_url(),
            "url": self.html_url(),
            "default_branch": self.default_branch,
        })
    }

    /// A GitHub-shape `user` object for an identity id (used for `owner`, `sender`, and
    /// comment and issue authors). Platform identities have no login or email, so the base58
    /// identity id is the `login` and the `node_id`, and `html_url` is its forge-web profile
    /// (`/u/?name=<id>`).
    pub fn user_json(&self, identity_id: &str) -> Value {
        let mut q = url::form_urlencoded::Serializer::new(String::new());
        q.append_pair("name", identity_id);
        json!({
            "login": identity_id,
            "id": github_id(identity_id),
            "node_id": identity_id,
            "type": "User",
            "html_url": format!("{}/u/?{}", self.web_base_url.trim_end_matches('/'), q.finish()),
        })
    }
}

/// Every GitHub event name the relay produces (the `event` of a [`WebhookEvent`]).
pub const ALL_EVENTS: [&str; 7] = [
    "push",
    "release",
    "issues",
    "pull_request",
    "issue_comment",
    "pull_request_review",
    "check_run",
];

/// A fully-built webhook event: the GitHub event name (for `X-GitHub-Event`), the
/// serialized body, and the source document id (the dedup/delivery-id seed — a document can
/// be delivered more than once, so consumers dedupe on the delivery id; PRD 05 §Deliver).
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
    // forge-web has no compare view: link the pushed commit, or the repo for a deletion.
    let compare = if deleted {
        repo.html_url()
    } else {
        repo.commit_url(after)
    };
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
    let html_url = repo.thread_url(true, pr.number);
    let payload = json!({
        "action": action,
        "number": pr.number,
        "pull_request": {
            "id": github_id(&pr.document_id),
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
    /// Whether it is a pull request. As on GitHub, an `issue_comment` on a PR embeds the PR
    /// as its `issue`, with a `pull_request` key.
    pub is_pr: bool,
}

impl IssueObj {
    fn to_json(&self, repo: &RepositoryMeta) -> Value {
        let state = if self.open { "open" } else { "closed" };
        let html_url = repo.thread_url(self.is_pr, self.number);
        let mut v = json!({
            "id": github_id(&self.document_id),
            "node_id": self.document_id,
            "number": self.number,
            "state": state,
            "title": self.title,
            "body": self.body,
            "html_url": html_url,
            "user": repo.user_json(&self.author),
        });
        if self.is_pr {
            v["pull_request"] = json!({ "html_url": html_url });
        }
        v
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
    // forge-web has no per-comment anchor: the comment links its issue or PR.
    let html_url = repo.thread_url(issue.is_pr, issue.number);
    let payload = json!({
        "action": "created",
        "issue": issue.to_json(repo),
        "comment": {
            "id": github_id(comment_id),
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

/// Build a `pull_request_review` event (`action` = `submitted`). `verdict` is the `review`
/// document's (1 approve, 2 request changes, 3 comment); GitHub's `state` is lowercase.
pub fn pull_request_review_event(
    repo: &RepositoryMeta,
    source_doc_id: &str,
    pr: &PullRequestObj,
    reviewer: &str,
    verdict: u64,
    commit_oid: &str,
    body: &str,
) -> WebhookEvent {
    let state = match verdict {
        1 => "approved",
        2 => "changes_requested",
        _ => "commented",
    };
    let pr_event = pull_request_event(repo, &pr.document_id, "submitted", pr);
    // forge-web has no per-review anchor: the review links its PR.
    let html_url = repo.thread_url(true, pr.number);
    let payload = json!({
        "action": "submitted",
        "review": {
            "id": github_id(source_doc_id),
            "node_id": source_doc_id,
            "state": state,
            "body": body,
            "commit_id": if commit_oid.is_empty() { Value::Null } else { Value::from(commit_oid) },
            "html_url": html_url,
            "user": repo.user_json(reviewer),
        },
        "pull_request": pr_event.payload["pull_request"].clone(),
        "repository": repo.to_json(),
        "sender": repo.user_json(reviewer),
    });
    WebhookEvent {
        event: "pull_request_review",
        action: Some("submitted"),
        payload,
        source_doc_id: source_doc_id.to_string(),
    }
}

/// A release (subset of GitHub's `release` object).
#[derive(Debug, Clone)]
pub struct ReleaseObj {
    /// Document id.
    pub document_id: String,
    /// The tag (`v1.2.0`).
    pub tag_name: String,
    /// The display name.
    pub name: String,
    /// Release notes.
    pub body: String,
    /// Whether the release is yanked (reported as `prerelease: false`, `dash_yanked: true`).
    pub yanked: bool,
    /// The publishing maintainer.
    pub author: String,
    /// The `assets` field as stored (a JSON list), parsed when it is valid JSON.
    pub assets: Value,
}

/// Build a `release` event (`action` = `published`, or `unpublished` for a yanked tag).
pub fn release_event(
    repo: &RepositoryMeta,
    source_doc_id: &str,
    action: &'static str,
    r: &ReleaseObj,
) -> WebhookEvent {
    let html_url = repo.release_url(&r.tag_name);
    let payload = json!({
        "action": action,
        "release": {
            "id": github_id(&r.document_id),
            "node_id": r.document_id,
            "tag_name": r.tag_name,
            "name": r.name,
            "body": r.body,
            "draft": false,
            "prerelease": false,
            "dash_yanked": r.yanked,
            "html_url": html_url,
            "author": repo.user_json(&r.author),
            "assets": r.assets,
        },
        "repository": repo.to_json(),
        "sender": repo.user_json(&r.author),
    });
    WebhookEvent {
        event: "release",
        action: Some(action),
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
    /// The CI's own run id (`externalId`), empty when absent.
    pub external_id: String,
    /// Runner identity id (who attested — the check is as trustworthy as this identity).
    pub runner_id: String,
}

/// The `check_run` actions the relay sends. GitHub has four (`created`, `completed`,
/// `rerequested`, `requested_action`); a repository webhook receives only the first two, and
/// the other two are requests from GitHub's UI to a GitHub App, which Forge has no analogue
/// of. A replace that moves a run to `in_progress` has no action of its own on GitHub either,
/// so it is not delivered.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CheckRunAction {
    /// The run's document appeared (whatever its status).
    Created,
    /// The run's status became `completed` (on creation or by a replace).
    Completed,
}

impl CheckRunAction {
    /// The GitHub `action` string.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Created => "created",
            Self::Completed => "completed",
        }
    }
}

/// Build a `check_run` event with `action`. `source_doc_id` is the dedup key (the delivery id
/// seed): distinct per action and revision of one document, see `daemon::poll_check_runs`.
pub fn check_run_event(
    repo: &RepositoryMeta,
    source_doc_id: &str,
    action: CheckRunAction,
    cr: &CheckRunObj,
) -> WebhookEvent {
    let action = action.as_str();
    let opt = |s: &str| {
        if s.is_empty() {
            Value::Null
        } else {
            Value::String(s.to_string())
        }
    };
    let payload = json!({
        "action": action,
        "check_run": {
            "id": github_id(&cr.document_id),
            "node_id": cr.document_id,
            "head_sha": cr.head_oid,
            "external_id": opt(&cr.external_id),
            "name": cr.name,
            "status": cr.status,
            "conclusion": opt(&cr.conclusion),
            // forge-web has no page per check run: its commit's page is the nearest.
            "html_url": repo.commit_url(&cr.head_oid),
            "details_url": opt(&cr.details_url),
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

    const OWNER: &str = "8hJmcHWTsdvkHyCrk4UgjbyugDAmE7QfuCTQXpXAc7nB";

    fn repo() -> RepositoryMeta {
        RepositoryMeta {
            repo_id: "5rrwgjjVUqMghnessfiXPXubpiM2QLNNXH142Hv4PDyX".into(),
            owner_id: OWNER.into(),
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
        assert!(p["compare"]
            .as_str()
            .unwrap()
            .ends_with("&oid=2222222222222222222222222222222222222222"));
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
            is_pr: false,
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
            external_id: "gh-run-42".into(),
            runner_id: "runner1".into(),
        };
        let e = check_run_event(&repo(), "cr1:completed:3", CheckRunAction::Completed, &cr);
        assert_eq!(e.event, "check_run");
        assert_eq!(e.action, Some("completed"));
        assert_eq!(e.payload["action"], "completed");
        assert_eq!(e.source_doc_id, "cr1:completed:3");
        let run = &e.payload["check_run"];
        assert_eq!(run["id"], github_id("cr1"));
        assert_eq!(run["node_id"], "cr1");
        assert_eq!(run["head_sha"], "deadbeef");
        assert_eq!(run["external_id"], "gh-run-42");
        assert_eq!(run["conclusion"], "success");
        assert_eq!(run["status"], "completed");
        assert_eq!(run["details_url"], "https://ci.example/1");
        assert_eq!(
            run["html_url"],
            format!(
                "https://forge.example/repo/commit/?owner={OWNER}&name=dash-forge&oid=deadbeef"
            )
        );
    }

    #[test]
    fn check_run_created_is_the_action_asked_for() {
        let cr = CheckRunObj {
            document_id: "cr2".into(),
            head_oid: "d".into(),
            name: "build".into(),
            status: "in_progress".into(),
            conclusion: String::new(),
            details_url: String::new(),
            summary: String::new(),
            external_id: String::new(),
            runner_id: "runner1".into(),
        };
        let e = check_run_event(&repo(), "cr2", CheckRunAction::Created, &cr);
        assert_eq!(e.payload["action"], "created");
        assert!(e.payload["check_run"]["conclusion"].is_null());
        assert!(e.payload["check_run"]["external_id"].is_null());
        assert!(e.payload["check_run"]["details_url"].is_null());
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
            is_pr: false,
        };
        let e = issues_event(&repo(), "i12", "closed", &issue);
        assert_eq!(e.event, "issues");
        assert_eq!(e.payload["action"], "closed");
        assert_eq!(e.payload["issue"]["state"], "closed");
    }

    #[test]
    fn review_payload_maps_verdicts_to_github_states() {
        let pr = PullRequestObj {
            number: 4,
            document_id: "pr4".into(),
            author: "author1".into(),
            title: "T".into(),
            body: String::new(),
            base_ref: "refs/heads/main".into(),
            head_oid: "cafe".into(),
            open: true,
            merged: false,
        };
        for (verdict, state) in [(1, "approved"), (2, "changes_requested"), (3, "commented")] {
            let e = pull_request_review_event(&repo(), "rv1", &pr, "rev", verdict, "cafe", "ok");
            assert_eq!(e.event, "pull_request_review");
            assert_eq!(e.payload["action"], "submitted");
            assert_eq!(e.payload["review"]["state"], state);
            assert_eq!(e.payload["review"]["commit_id"], "cafe");
            assert_eq!(e.payload["review"]["user"]["login"], "rev");
            assert_eq!(e.payload["pull_request"]["number"], 4);
            assert_eq!(e.source_doc_id, "rv1");
        }
        let e = pull_request_review_event(&repo(), "rv2", &pr, "rev", 1, "", "");
        assert!(e.payload["review"]["commit_id"].is_null());
    }

    #[test]
    fn release_payload_shape() {
        let r = ReleaseObj {
            document_id: "rel1".into(),
            tag_name: "v1.0.0".into(),
            name: "One".into(),
            body: "notes".into(),
            yanked: false,
            author: "maint".into(),
            assets: serde_json::json!([{"name": "a.tgz"}]),
        };
        let e = release_event(&repo(), "rel1", "published", &r);
        assert_eq!(e.event, "release");
        assert_eq!(e.payload["action"], "published");
        assert_eq!(e.payload["release"]["tag_name"], "v1.0.0");
        assert_eq!(e.payload["release"]["assets"][0]["name"], "a.tgz");
        assert!(e.payload["release"]["html_url"]
            .as_str()
            .unwrap()
            .ends_with("/repo/release/?owner=8hJmcHWTsdvkHyCrk4UgjbyugDAmE7QfuCTQXpXAc7nB&name=dash-forge&tag=v1.0.0"));
        assert_eq!(
            e.payload["repository"]["dash_repo_id"],
            "5rrwgjjVUqMghnessfiXPXubpiM2QLNNXH142Hv4PDyX"
        );
    }

    #[test]
    fn numeric_repo_id_is_stable() {
        let a = repo().to_json()["id"].as_u64().unwrap();
        let b = repo().to_json()["id"].as_u64().unwrap();
        assert_eq!(a, b);
    }

    /// One event of every kind the relay sends, with real-length base58 ids.
    fn every_event() -> Vec<WebhookEvent> {
        let r = repo();
        let doc = "9r27eDsuXEqoMNymW1A2MKFrpBhzSkepVKwXrGzq9dUD";
        let who = "Dd1m1JJM3M5DjBaXaCbC5hXBsU6248KHpGcBAtaHsqc7";
        let pr = PullRequestObj {
            number: 6,
            document_id: doc.into(),
            author: who.into(),
            title: "T".into(),
            body: String::new(),
            base_ref: "refs/heads/main".into(),
            head_oid: "ab".repeat(20),
            open: true,
            merged: false,
        };
        let issue = |is_pr| IssueObj {
            number: 1,
            document_id: doc.into(),
            author: who.into(),
            title: "T".into(),
            body: String::new(),
            open: true,
            is_pr,
        };
        let rel = ReleaseObj {
            document_id: doc.into(),
            tag_name: "v2.0.0".into(),
            name: "Two".into(),
            body: String::new(),
            yanked: false,
            author: who.into(),
            assets: json!([]),
        };
        let cr = CheckRunObj {
            document_id: doc.into(),
            head_oid: "ab".repeat(20),
            name: "build".into(),
            status: "completed".into(),
            conclusion: "success".into(),
            details_url: String::new(),
            summary: String::new(),
            external_id: String::new(),
            runner_id: who.into(),
        };
        vec![
            push_event(
                &r,
                doc,
                "refs/heads/main",
                ZERO_OID,
                &"ab".repeat(20),
                false,
                who,
            ),
            pull_request_event(&r, doc, "opened", &pr),
            issues_event(&r, doc, "opened", &issue(false)),
            issue_comment_event(&r, doc, &issue(false), doc, who, "x"),
            issue_comment_event(&r, doc, &issue(true), doc, who, "x"),
            pull_request_review_event(&r, doc, &pr, who, 1, "", ""),
            release_event(&r, doc, "published", &rel),
            check_run_event(&r, doc, CheckRunAction::Created, &cr),
        ]
    }

    /// Every `id` anywhere in `v`, with its JSON path.
    fn ids<'a>(v: &'a Value, path: &str, out: &mut Vec<(String, &'a Value)>) {
        match v {
            Value::Object(m) => {
                for (k, x) in m {
                    let p = format!("{path}.{k}");
                    if k == "id" {
                        out.push((p.clone(), x));
                    }
                    ids(x, &p, out);
                }
            }
            Value::Array(a) => a.iter().for_each(|x| ids(x, path, out)),
            _ => {}
        }
    }

    /// D-605: go-github decodes every `id` as `int64` and JavaScript's `JSON.parse` rounds
    /// integers above 2^53 − 1. Before the fix, `repository.id` was a full u64 and the others
    /// were base58 strings.
    #[test]
    fn every_id_is_a_js_safe_integer_and_node_id_keeps_the_platform_id() {
        for e in every_event() {
            let mut found = Vec::new();
            ids(&e.payload, e.event, &mut found);
            assert!(
                found.len() >= 3,
                "{}: repository, owner, sender at least",
                e.event
            );
            for (path, id) in found {
                let n = id
                    .as_u64()
                    .unwrap_or_else(|| panic!("{path} is not an integer: {id}"));
                assert!(
                    (1..=MAX_SAFE_ID).contains(&n),
                    "{path} = {n} is not JS-safe"
                );
                assert!(i64::try_from(n).is_ok(), "{path} fits int64");
            }
            assert!(e.payload["repository"]["node_id"].is_string());
        }
        // The id is derived from the Platform id alone, and keeps it in `node_id`.
        let e = &every_event()[1];
        let pr = &e.payload["pull_request"];
        assert_eq!(
            pr["node_id"],
            "9r27eDsuXEqoMNymW1A2MKFrpBhzSkepVKwXrGzq9dUD"
        );
        assert_eq!(
            pr["id"],
            github_id("9r27eDsuXEqoMNymW1A2MKFrpBhzSkepVKwXrGzq9dUD")
        );
        assert_eq!(
            e.payload["repository"]["dash_repo_id"],
            e.payload["repository"]["node_id"]
        );
        // Stable across relay instances: a fixed input, a fixed value.
        assert_eq!(
            github_id("5rrwgjjVUqMghnessfiXPXubpiM2QLNNXH142Hv4PDyX"),
            u64::from_be_bytes(
                Sha256::digest(b"5rrwgjjVUqMghnessfiXPXubpiM2QLNNXH142Hv4PDyX")[..8]
                    .try_into()
                    .unwrap()
            ) & MAX_SAFE_ID
        );
        assert_ne!(github_id("a"), github_id("b"));
    }

    /// D-605, end to end: go-github's `ParseWebHook` (v66, `testdata/webhook-parse`) decodes
    /// every payload into its typed event. Before the fix it refused push (`repository.id`
    /// over int64) and issues/pull_request (string ids): the same checker run on the QA
    /// pass's recorded deliveries fails all 52. Needs `go` and the module (cached, or fetched
    /// from the proxy). It is skipped with a note when `go` is absent or cannot build the
    /// checker (offline, no module cache); the numeric bounds above hold regardless.
    #[test]
    fn payloads_parse_with_go_github() {
        if std::process::Command::new("go")
            .arg("version")
            .output()
            .is_err()
        {
            eprintln!("skipping: go is not available");
            return;
        }
        let dir = std::env::temp_dir().join(format!("relay-gogh-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for (i, e) in every_event().iter().enumerate() {
            std::fs::write(
                dir.join(format!("{}.{i}.json", e.event)),
                serde_json::to_vec(&e.payload).unwrap(),
            )
            .unwrap();
        }
        let out = std::process::Command::new("go")
            .args(["run", "."])
            .arg(&dir)
            .current_dir(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/testdata/webhook-parse"
            ))
            .output()
            .unwrap();
        let _ = std::fs::remove_dir_all(&dir);
        let stdout = String::from_utf8_lossy(&out.stdout);
        let stderr = String::from_utf8_lossy(&out.stderr);
        // The checker prints one line per payload once it runs; nothing on stdout means `go`
        // could not build it (no network and no module cache), not a refused payload.
        if stdout.trim().is_empty() && !out.status.success() {
            eprintln!("skipping: the go-github checker did not build: {stderr}");
            return;
        }
        assert!(
            out.status.success(),
            "go-github refused payloads:\n{stdout}{stderr}"
        );
        assert_eq!(
            stdout.matches(": ok").count(),
            every_event().len(),
            "{stdout}"
        );
    }

    /// D-606: every synthesized link is a forge-web route (`repoHref`'s shape: route with a
    /// trailing slash, `owner`/`name` query params). Before, they were `/<owner>/<name>/…`
    /// paths that 404, `compare` and `#comment-` anchors included.
    #[test]
    fn links_are_forge_web_query_routes() {
        let base = format!("https://forge.example/repo/?owner={OWNER}&name=dash-forge");
        let at = |route: &str, extra: &str| {
            format!("https://forge.example/repo/{route}/?owner={OWNER}&name=dash-forge&{extra}")
        };
        let who = "https://forge.example/u/?name=Dd1m1JJM3M5DjBaXaCbC5hXBsU6248KHpGcBAtaHsqc7";
        let ev = every_event();
        assert_eq!(ev[0].payload["repository"]["html_url"], base);
        assert_eq!(
            ev[0].payload["compare"],
            at("commit", &format!("oid={}", "ab".repeat(20))),
            "no compare page: the pushed commit"
        );
        assert_eq!(ev[0].payload["sender"]["html_url"], who);
        assert_eq!(
            ev[1].payload["pull_request"]["html_url"],
            at("pull", "number=6")
        );
        assert_eq!(ev[2].payload["issue"]["html_url"], at("issue", "number=1"));
        assert_eq!(
            ev[3].payload["comment"]["html_url"],
            at("issue", "number=1")
        );
        assert_eq!(
            ev[4].payload["comment"]["html_url"],
            at("pull", "number=1"),
            "a comment on a PR links the PR route"
        );
        assert!(ev[4].payload["issue"]["pull_request"].is_object());
        assert!(ev[3].payload["issue"].get("pull_request").is_none());
        assert_eq!(ev[5].payload["review"]["html_url"], at("pull", "number=6"));
        assert_eq!(
            ev[6].payload["release"]["html_url"],
            at("release", "tag=v2.0.0")
        );
        for e in &ev {
            let s = e.payload.to_string();
            assert!(
                !s.contains("#comment-") && !s.contains("#review-"),
                "no anchors"
            );
            assert!(!s.contains("/compare/") && !s.contains("/releases/tag/"));
        }

        // A deletion links the repo; values are query-encoded; a trailing slash is ignored.
        let mut r = repo();
        r.web_base_url = "https://forge.example/".into();
        r.name = "a b&c".into();
        let del = push_event(&r, "d", "refs/heads/x", "aa", ZERO_OID, false, "x");
        assert_eq!(
            del.payload["compare"],
            format!("https://forge.example/repo/?owner={OWNER}&name=a+b%26c")
        );
        let rel = ReleaseObj {
            document_id: "d".into(),
            tag_name: "v1.0/rc+1".into(),
            name: String::new(),
            body: String::new(),
            yanked: false,
            author: "x".into(),
            assets: json!([]),
        };
        assert!(
            release_event(&r, "d", "published", &rel).payload["release"]["html_url"]
                .as_str()
                .unwrap()
                .ends_with("&tag=v1.0%2Frc%2B1")
        );
    }
}
