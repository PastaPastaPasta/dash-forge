//! CI re-run requests: member `event` kind 26 (`ciRerun`, forge-v2.md §3.3), a client
//! convention inside the contract's open `event.kind` (4–255), like the policy bypass (23). No
//! schema change: it uses `event`'s existing properties and its sparse `addressee (refId)`
//! index.
//!
//! A request asks the repository's runners to run a pull request's checks again:
//!
//! * `targetId` / `targetNumber`: the pull request (an issue's request is never honoured);
//! * `oid`: the commit whose checks run again (20 or 32 bytes), the PR head when it was asked;
//! * `refId`: **the repository's own id**. It puts the request in the `addressee` index under
//!   the repository, so a runner reads exactly the repository's requests, newest past its
//!   cursor, with one query (`refId == repoId`, `$createdAt >=` the cursor) instead of paging
//!   the whole event feed. No other kind names a repository there (they name an identity, a
//!   comment or a review), so the index entry is unambiguous;
//! * `value` (optional): the check's name, as its run is named (≤ 100 characters and 200 bytes,
//!   the `checkRun.name` bounds). Absent: every check of the head (the PR's
//!   runs and its branch's push runs). In a private
//!   repository it is sealed in `enc` like every event value.
//!
//! Consensus admits the `event` from any maintainer or role-1/role-2 writer (`t_triageKinds`
//! is a deny-list, and 26 is not on it). The convention is stricter, as GitHub is (re-running
//! a workflow needs write access): a request **counts** only when its writer is the repository
//! owner, or a maintainer or role-1 writer at its `$createdAt` ([`rerun_counts`],
//! `RoleOracle::approver_at`). Clients refuse a triage member's request before signing, and a
//! runner ignores one that does not count.
//!
//! What a runner does with a counted request is its own policy (docs/guides/self-host-runner.md
//! §Re-runs): forge-runner runs it only when `oid` is still the PR's head, and only what its
//! own polls would have run.

use serde::{Deserialize, Serialize};

use super::v2::RoleOracle;

/// The `event.kind` of a CI re-run request.
pub const CI_RERUN_KIND: u64 = 26;

/// A check name's bounds: characters, then UTF-8 bytes (`checkRun.name`).
pub const CHECK_NAME_MAX: (usize, usize) = (100, 200);

/// Whether `name` is a check name a run can carry (1–100 characters, at most 200 bytes).
#[must_use]
pub fn is_check_name(name: &str) -> bool {
    !name.is_empty() && name.chars().count() <= CHECK_NAME_MAX.0 && name.len() <= CHECK_NAME_MAX.1
}

/// Whether `hex` is a commit id: 40 or 64 hex digits.
fn is_oid_hex(hex: &str) -> bool {
    matches!(hex.len(), 40 | 64) && hex.bytes().all(|b| b.is_ascii_hexdigit())
}

/// An `event` document as the re-run rule reads it (`oid` as hex, ids as base58).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RerunEvent {
    /// `$id`.
    pub id: String,
    /// `repoId`: the repository the event belongs to.
    pub repo_id: String,
    /// `targetId`.
    pub target_id: String,
    /// `targetNumber`.
    pub target_number: u64,
    /// `kind`.
    pub kind: u64,
    /// `refId`, when present.
    #[serde(default)]
    pub ref_id: Option<String>,
    /// `oid` as hex, when present.
    #[serde(default)]
    pub oid: Option<String>,
    /// `value` (opened, in a private repository), when present.
    #[serde(default)]
    pub value: Option<String>,
    /// A private repository's sealed `value` this reader could not open: which check was asked
    /// for is unknown, so it is no request (never "every check").
    #[serde(default)]
    pub value_hidden: bool,
    /// `$ownerId`: who asked.
    pub actor: String,
    /// `$createdAt` (ms).
    pub created_at: u64,
}

/// A well-formed re-run request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RerunRequest {
    /// The event's `$id`.
    pub id: String,
    /// The pull request's document id.
    pub target_id: String,
    /// The pull request's number.
    pub number: u32,
    /// The commit (lowercase hex).
    pub sha: String,
    /// The check to run again; `None`: every check of the head (the PR's and its branch's push runs).
    pub check: Option<String>,
    /// Who asked.
    pub requester: String,
    /// When (`$createdAt`, ms).
    pub created_at: u64,
}

/// The request `e` makes to the repository `repo_id`, or `None` when it is not a well-formed
/// one: another kind, an event of another repository (its `repoId`; the index is keyed by
/// `refId` alone, which any member of any repository can set), a `refId` that is not the
/// repository, an `oid` that is not a commit id, a `value` that is no check name or that this
/// reader could not open, or no target number.
#[must_use]
pub fn rerun_request(repo_id: &str, e: &RerunEvent) -> Option<RerunRequest> {
    if e.kind != CI_RERUN_KIND
        || e.repo_id != repo_id
        || e.ref_id.as_deref() != Some(repo_id)
        || e.value_hidden
    {
        return None;
    }
    let sha = e.oid.as_deref().filter(|o| is_oid_hex(o))?;
    if e.value.as_deref().is_some_and(|v| !is_check_name(v)) {
        return None;
    }
    let number = u32::try_from(e.target_number).ok().filter(|n| *n > 0)?;
    Some(RerunRequest {
        id: e.id.clone(),
        target_id: e.target_id.clone(),
        number,
        sha: sha.to_ascii_lowercase(),
        check: e.value.clone(),
        requester: e.actor.clone(),
        created_at: e.created_at,
    })
}

/// Whether `req` counts: its writer is the repository `owner`, or held a maintainer or role-1
/// writer document at its `$createdAt` (`oracle`: the repository's current memberships). A
/// triage member's request (consensus admits it) does not.
#[must_use]
pub fn rerun_counts(req: &RerunRequest, owner: &str, oracle: &RoleOracle) -> bool {
    req.requester == owner || oracle.approver_at(&req.requester, req.created_at)
}

/// What a request on the pull request `number` of `repo_id` stores, for a commit `sha` (hex)
/// and an optional `check`: the `event` properties beside `targetId` and the repository scope
/// (`kind`, `oid` as hex, `refId`, `value`). `Err` names what is wrong before anything is
/// signed.
///
/// # Errors
/// A `sha` that is not 40 or 64 hex digits, or a `check` that is no check name.
pub fn rerun_fields(repo_id: &str, sha: &str, check: Option<&str>) -> Result<RerunFields, String> {
    if !is_oid_hex(sha) {
        return Err(format!("{sha:?} is not a commit id (40 or 64 hex digits)"));
    }
    if let Some(c) = check {
        if !is_check_name(c) {
            return Err(format!(
                "{c:?} is not a check name (1 to {} characters, at most {} bytes)",
                CHECK_NAME_MAX.0, CHECK_NAME_MAX.1
            ));
        }
    }
    Ok(RerunFields {
        kind: CI_RERUN_KIND,
        oid: sha.to_ascii_lowercase(),
        ref_id: repo_id.to_string(),
        value: check.map(str::to_string),
    })
}

/// The fields [`rerun_fields`] decides.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RerunFields {
    /// [`CI_RERUN_KIND`].
    pub kind: u64,
    /// The commit (lowercase hex).
    pub oid: String,
    /// The repository's id (base58).
    pub ref_id: String,
    /// The check's name, when one is asked for.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rules::v2::{Membership, Role};

    fn ev(kind: u64, ref_id: &str, oid: &str, value: Option<&str>) -> RerunEvent {
        RerunEvent {
            id: "E".into(),
            repo_id: "R".into(),
            target_id: "T".into(),
            target_number: 4,
            kind,
            ref_id: Some(ref_id.into()),
            oid: Some(oid.into()),
            value: value.map(str::to_string),
            value_hidden: false,
            actor: "W".into(),
            created_at: 50,
        }
    }

    #[test]
    fn a_request_names_the_repository_a_commit_and_maybe_a_check() {
        let a = "AB".repeat(20);
        let r = rerun_request("R", &ev(26, "R", &a, Some("CI / build"))).unwrap();
        assert_eq!(r.sha, "ab".repeat(20));
        assert_eq!(r.check.as_deref(), Some("CI / build"));
        assert_eq!(r.number, 4);
        assert!(rerun_request("R", &ev(26, "R", &a, None))
            .unwrap()
            .check
            .is_none());
        assert!(rerun_request("R", &ev(25, "R", &a, None)).is_none());
        assert!(rerun_request("R", &ev(26, "X", &a, None)).is_none());
        assert!(rerun_request("R", &ev(26, "R", "abc", None)).is_none());
        assert!(rerun_request("R", &ev(26, "R", &a, Some(&"x".repeat(101)))).is_none());
        assert!(rerun_request("R", &ev(26, "R", &a, Some(""))).is_none());
        let other_repo = RerunEvent {
            repo_id: "B".into(),
            ..ev(26, "R", &a, None)
        };
        assert!(
            rerun_request("R", &other_repo).is_none(),
            "another repository's event"
        );
        let hidden = RerunEvent {
            value_hidden: true,
            ..ev(26, "R", &a, None)
        };
        assert!(
            rerun_request("R", &hidden).is_none(),
            "an unreadable check is not every check"
        );
    }

    #[test]
    fn only_the_owner_maintainers_and_role_1_writers_count() {
        let oracle = RoleOracle::new(vec![
            Membership {
                identity: "W".into(),
                role: Role::Writer,
                created_at: 10,
            },
            Membership {
                identity: "T".into(),
                role: Role::Triage,
                created_at: 10,
            },
        ]);
        let mut r = rerun_request("R", &ev(26, "R", &"a".repeat(40), None)).unwrap();
        assert!(rerun_counts(&r, "O", &oracle));
        r.requester = "T".into();
        assert!(!rerun_counts(&r, "O", &oracle));
        r.requester = "O".into();
        assert!(rerun_counts(&r, "O", &oracle));
        r.requester = "W".into();
        r.created_at = 5;
        assert!(
            !rerun_counts(&r, "O", &oracle),
            "before the writer document"
        );
    }

    #[test]
    fn the_fields_are_checked_before_signing() {
        let f = rerun_fields("R", &"AB".repeat(20), Some("build")).unwrap();
        assert_eq!(f.oid, "ab".repeat(20));
        assert_eq!((f.kind, f.ref_id.as_str()), (26, "R"));
        assert!(rerun_fields("R", "abc", None).is_err());
        assert!(rerun_fields("R", &"a".repeat(64), Some("")).is_err());
    }
}
