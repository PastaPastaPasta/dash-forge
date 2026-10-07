//! Rules at merge time: which branch rules applied when a pull request was merged, and whether
//! the merge met them.
//!
//! Branch rules are a client rule (forge-v2.md §6): consensus admits a merge `transition` from
//! any maintainer or role-1 writer, with or without approvals, and a maintainer may append a
//! weaker `policy`, merge, and append the old one back. Nothing re-judged a merge after the fact.
//! [`audit_merge`] does, from what is on chain: the newest `policy` written no later than the
//! merge, the base branch's protection then, the reviews, dismissals and check runs written no
//! later than the merge, and a policy-bypass event (kind 23) a maintainer recorded for the merge
//! commit. It reuses the merge box's own rules ([`count_approvals`], [`meets_policy`],
//! [`checks_state`]) with the membership as it stood at the merge.
//!
//! `review` and `checkRun` documents are deletable and revoked members' documents are gone, so a
//! rule found unmet now may have been met then: readers say so. A recorded bypass is an
//! immutable event and always stands. Shared with forge-web's `merge-audit.ts` through the
//! `merge_audit__*` vectors.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use super::parity::{checks_state, CheckRunRow, ChecksState};
use super::review::{meets_policy, Policy, PolicyStatus};
use super::v2::{count_approvals, Membership, Review, Role, RoleOracle};

/// How long before a merge a change to the branch rules is flagged (one hour, ms).
pub const RULES_CHANGE_WINDOW_MS: u64 = 3_600_000;

/// One `policy` document of the repository.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyDoc {
    /// Document `$id`.
    pub id: String,
    /// Consensus `$createdAt` (ms).
    pub created_at: u64,
    /// The policy it sets.
    pub policy: Policy,
}

/// Whether one `config` document protected the base branch (its `protectedPatterns` match it).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtectionDoc {
    /// Document `$id`.
    pub id: String,
    /// Consensus `$createdAt` (ms).
    pub created_at: u64,
    /// The base branch matched one of the config's protected patterns.
    pub protected: bool,
}

/// A `reviewDismiss` event (kind 15): the review it names stops counting from `created_at`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DismissalAt {
    /// The dismissed review's `$id`.
    pub review_id: String,
    /// Consensus `$createdAt` (ms) of the dismissal.
    pub created_at: u64,
}

/// A policy-bypass event (kind 23) on the pull request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BypassEvent {
    /// Document `$id`.
    pub id: String,
    /// Who wrote it (`$ownerId`).
    pub actor: String,
    /// Consensus `$createdAt` (ms).
    pub created_at: u64,
    /// The merge commit it names (`oid`, hex).
    #[serde(default)]
    pub oid: String,
    /// The rules it says were not met.
    #[serde(default)]
    pub value: String,
}

/// What [`audit_merge`] judges.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MergeAuditInput {
    /// The merge transition's `$createdAt` (ms).
    pub merged_at: u64,
    /// Who wrote the merge transition.
    pub merger: String,
    /// The merge transition's commit, hex.
    pub merge_oid: String,
    /// The PR's head when it was merged (`merge_check::head_at`).
    pub merge_head: String,
    /// The PR's author (their own reviews never count).
    pub pr_author: String,
    /// Every `policy` document of the repository.
    #[serde(default)]
    pub policies: Vec<PolicyDoc>,
    /// Every `config` document of the repository, judged against the base branch.
    #[serde(default)]
    pub protection: Vec<ProtectionDoc>,
    /// The repository's current membership documents.
    #[serde(default)]
    pub memberships: Vec<Membership>,
    /// The PR's reviews.
    #[serde(default)]
    pub reviews: Vec<Review>,
    /// The PR's review dismissals.
    #[serde(default)]
    pub dismissals: Vec<DismissalAt>,
    /// The check runs on `merge_head` (with `updated_at`); `None` when they were not read.
    #[serde(default)]
    pub runs: Option<Vec<CheckRunRow>>,
    /// The repository's current runners.
    #[serde(default)]
    pub runners: BTreeSet<String>,
    /// The PR's policy-bypass events.
    #[serde(default)]
    pub bypasses: Vec<BypassEvent>,
}

/// The audit's verdict.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AuditVerdict {
    /// No branch rule applied: no policy and an unprotected base.
    None,
    /// Every rule that applied was met.
    Met,
    /// A maintainer recorded a bypass of the rules for this merge.
    Bypassed,
    /// A rule was not met by what is on chain now, and no bypass was recorded.
    Unmet,
    /// Nothing found unmet, but the required checks were not read.
    Unknown,
}

/// The rules in force at a merge and how the merge stood against them.
#[allow(clippy::struct_excessive_bools)] // a report: each flag is one finding readers show
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeAudit {
    /// The verdict.
    pub verdict: AuditVerdict,
    /// The policy in force at the merge, or `None`.
    pub policy: Option<Policy>,
    /// The base branch was protected at the merge.
    pub protected: bool,
    /// The merger's role at the merge (`None`: no current membership document says).
    pub merger_role: Option<Role>,
    /// A protected base was merged by someone other than a maintainer.
    pub protection_unmet: bool,
    /// The approvals at the merge against the policy; `None` without a policy.
    pub approvals: Option<PolicyStatus>,
    /// The required checks at the merge; `None` when none were required or the runs were not read.
    pub checks: Option<ChecksState>,
    /// The policy required checks and the runs were not read.
    pub checks_unread: bool,
    /// The bypass a maintainer recorded for this merge, the first one.
    pub bypass: Option<BypassEvent>,
    /// The policy or the base's protection changed within [`RULES_CHANGE_WINDOW_MS`] before the merge.
    pub rules_changed: bool,
}

/// The newest of `items` written at or before `at`, by `(created_at, id)`.
fn newest_at<T>(items: &[T], at: u64, key: impl Fn(&T) -> (u64, &str)) -> Option<&T> {
    items
        .iter()
        .filter(|x| key(x).0 <= at)
        .max_by(|a, b| key(a).cmp(&key(b)))
}

/// Whether a document in `items` written in the window before `at` changed what the one before
/// it said (`same` compares two documents' rules); the first document ever counts as a change
/// only from nothing to something that `applies`.
fn changed_before<T>(
    items: &[T],
    at: u64,
    key: impl Fn(&T) -> (u64, &str),
    same: impl Fn(&T, &T) -> bool,
    applies: impl Fn(&T) -> bool,
) -> bool {
    let mut sorted: Vec<&T> = items.iter().filter(|x| key(x).0 <= at).collect();
    sorted.sort_by(|a, b| key(a).cmp(&key(b)));
    let from = at.saturating_sub(RULES_CHANGE_WINDOW_MS);
    sorted.iter().enumerate().any(|(i, x)| {
        key(x).0 > from
            && match i.checked_sub(1).and_then(|p| sorted.get(p)) {
                Some(prev) => !same(prev, x),
                None => applies(x),
            }
    })
}

/// The approvals standing at the merge (reviews and dismissals written no later, the membership
/// `then`) against `policy`.
fn approvals_at(input: &MergeAuditInput, then: &RoleOracle, policy: &Policy) -> PolicyStatus {
    let at = input.merged_at;
    let dismissed: BTreeSet<String> = input
        .dismissals
        .iter()
        .filter(|d| d.created_at <= at)
        .map(|d| d.review_id.clone())
        .collect();
    let reviews: Vec<Review> = input
        .reviews
        .iter()
        .filter(|r| r.created_at <= at)
        .cloned()
        .collect();
    let counted = count_approvals(
        &reviews,
        then,
        &input.merge_head,
        &dismissed,
        &input.pr_author,
    );
    meets_policy(&counted, then, policy)
}

/// The check runs as they stood at the merge `at`: those created no later, each completed run
/// keeping its conclusion only when its last replace (`updated_at`) came no later; otherwise it
/// was still running at the merge as far as anyone can tell. A run is replaced as its status
/// moves on, so its current conclusion alone says nothing about the merge. This fails safe: a
/// run whose `updated_at` was not read, or that was replaced again after the merge (even with
/// the same result), reads as still running then, never as passed.
fn runs_at(runs: &[CheckRunRow], at: u64) -> Vec<CheckRunRow> {
    runs.iter()
        .filter(|r| r.created_at <= at)
        .map(|r| {
            let mut r = r.clone();
            if r.status == "completed" && r.updated_at.is_none_or(|u| u > at) {
                r.status = "in_progress".into();
                r.conclusion = None;
            }
            r
        })
        .collect()
}

/// The first bypass recorded for this merge: only a maintainer's record naming the merge's
/// commit counts (the merge box and `dg` write it right after the merge).
fn recorded_bypass(input: &MergeAuditInput, oracle: &RoleOracle) -> Option<BypassEvent> {
    input
        .bypasses
        .iter()
        .filter(|b| {
            b.oid.eq_ignore_ascii_case(&input.merge_oid)
                && oracle.role_at(&b.actor, b.created_at) == Some(Role::Maintainer)
        })
        .min_by(|a, b| (a.created_at, &a.id).cmp(&(b.created_at, &b.id)))
        .cloned()
}

/// Judge a merge against the branch rules in force when it was recorded (see the module docs).
#[must_use]
pub fn audit_merge(input: &MergeAuditInput) -> MergeAudit {
    let at = input.merged_at;
    let oracle = RoleOracle::new(input.memberships.clone());
    // The membership as it stood at the merge: members added since never counted then.
    let then = RoleOracle::new(
        input
            .memberships
            .iter()
            .filter(|m| m.created_at <= at)
            .cloned()
            .collect(),
    );
    let policy =
        newest_at(&input.policies, at, |p| (p.created_at, p.id.as_str())).map(|p| p.policy.clone());
    let protected = newest_at(&input.protection, at, |p| (p.created_at, p.id.as_str()))
        .is_some_and(|p| p.protected);
    let merger_role = oracle.role_at(&input.merger, at);
    let protection_unmet = protected && merger_role != Some(Role::Maintainer);

    let approvals = policy
        .as_ref()
        .map(|policy| approvals_at(input, &then, policy));

    let checks_required = policy
        .as_ref()
        .is_some_and(|p| p.require_checks || p.required_checks.iter().any(|n| !n.is_empty()));
    let checks = match (&policy, &input.runs) {
        (Some(policy), Some(runs)) if checks_required => {
            let runs = runs_at(runs, at);
            Some(checks_state(
                &runs,
                &input.merge_head,
                &then,
                &input.runners,
                &policy.checks_policy(),
            ))
        }
        _ => None,
    };
    let checks_unread = checks_required && input.runs.is_none();

    let bypass = recorded_bypass(input, &oracle);

    let policy_changed = changed_before(
        &input.policies,
        at,
        |p| (p.created_at, p.id.as_str()),
        |a, b| a.policy == b.policy,
        |_| true,
    );
    let protection_changed = changed_before(
        &input.protection,
        at,
        |p| (p.created_at, p.id.as_str()),
        |a, b| a.protected == b.protected,
        |p| p.protected,
    );

    let unmet = protection_unmet
        || approvals.as_ref().is_some_and(|a| !a.met)
        || checks.as_ref().is_some_and(|c| !c.met);
    let verdict = if bypass.is_some() {
        AuditVerdict::Bypassed
    } else if unmet {
        AuditVerdict::Unmet
    } else if checks_unread {
        AuditVerdict::Unknown
    } else if policy.is_none() && !protected {
        AuditVerdict::None
    } else {
        AuditVerdict::Met
    };
    MergeAudit {
        verdict,
        policy,
        protected,
        merger_role,
        protection_unmet,
        approvals,
        checks,
        checks_unread,
        bypass,
        rules_changed: policy_changed || protection_changed,
    }
}
