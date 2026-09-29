//! Issue and PR state as `transition` documents (`docs/contracts/forge-v2.md` §3, the
//! fresh-registration design in `STATE-COUNTS.md` §2 and §4).
//!
//! Every state change of an issue or PR is one immutable, non-deletable `transition` document
//! with a signed `delta`. Consensus accepts a transition only when it is a legal move from the
//! target's current state: the running sum of `delta` over the target's transitions is its
//! **state code**, and the contract's `c1`…`c5` rules pin the sum after each kind. So a reader
//! never replays or filters transitions: the sum *is* the state.
//!
//! | code | issue  | PR                  |
//! |------|--------|---------------------|
//! | 0    | open   | open, ready         |
//! | 1    | closed | closed, not merged  |
//! | 2    | —      | merged (terminal)   |
//! | 8    | —      | open draft          |
//! | 9    | —      | closed draft        |
//!
//! The code is a bit set: bit 0 closed, bit 1 merged, bit 3 draft ([`status_of_code`]).
//!
//! What stays client-side, and must be identical in every client, is here:
//!
//! * [`next_transition`] — the kind (and `delta`, `asAuthor`) of the move a client writes for a
//!   close, reopen, merge, draft or ready, or `None` when consensus would refuse it.
//! * [`state_code`] — the code a target's transitions sum to (for a reader that holds them).
//! * [`repo_counts`] — the open / closed / merged / draft totals of a repo from its two target
//!   totals and one count of transitions grouped by kind (§4).
//!
//! The `"rules": "v2"` vectors `transition__*` in `forge-contracts/vectors/` hold this module in
//! parity with `forge-web/lib/rules/transition.ts`.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::Oid;

/// Issue close (`delta` +1, 0 → 1).
pub const ISSUE_CLOSE: u8 = 1;
/// Issue reopen (−1, 1 → 0).
pub const ISSUE_REOPEN: u8 = 2;
/// PR close (+1, 0 → 1).
pub const PR_CLOSE: u8 = 11;
/// PR reopen (−1, 1 → 0).
pub const PR_REOPEN: u8 = 12;
/// PR merge (+2, 0 → 2; `oid` required, members only).
pub const PR_MERGE: u8 = 13;
/// PR marked draft (+8, 0 → 8).
pub const PR_DRAFT: u8 = 14;
/// PR marked ready for review (−8, 8 → 0).
pub const PR_READY: u8 = 15;
/// A draft PR closed (+1, 8 → 9).
pub const PR_DRAFT_CLOSE: u8 = 16;
/// A closed draft PR reopened (−1, 9 → 8).
pub const PR_DRAFT_REOPEN: u8 = 17;

/// Every `transition.kind` the contract accepts (its `kind` enum).
pub const TRANSITION_KINDS: [u8; 9] = [
    ISSUE_CLOSE,
    ISSUE_REOPEN,
    PR_CLOSE,
    PR_REOPEN,
    PR_MERGE,
    PR_DRAFT,
    PR_READY,
    PR_DRAFT_CLOSE,
    PR_DRAFT_REOPEN,
];

/// The `delta` the contract pins for `kind` (`b1`…`b3`), or `None` for a kind it does not have.
#[must_use]
pub fn delta_of(kind: u8) -> Option<i64> {
    match kind {
        ISSUE_CLOSE | PR_CLOSE | PR_DRAFT_CLOSE => Some(1),
        ISSUE_REOPEN | PR_REOPEN | PR_DRAFT_REOPEN => Some(-1),
        PR_MERGE => Some(2),
        PR_DRAFT => Some(8),
        PR_READY => Some(-8),
        _ => None,
    }
}

/// What a transition names: an `issue` (`targetKind` 0, `tk` 0) or a `patch` (1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TransitionTarget {
    /// An `issue`.
    Issue,
    /// A `patch` (pull request).
    Patch,
}

impl TransitionTarget {
    /// The stored `targetKind` (and the target's `tk`): `kind / 10` (`a_kindOfTarget`).
    #[must_use]
    pub fn code(self) -> u8 {
        match self {
            Self::Issue => 0,
            Self::Patch => 1,
        }
    }
}

/// A state change a user asks for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StateAction {
    /// Close (a draft PR stays a draft: kind 16).
    Close,
    /// Reopen (a closed draft reopens as a draft: kind 17).
    Reopen,
    /// Merge (PRs, members only, from open and ready).
    Merge,
    /// Convert an open PR to a draft.
    Draft,
    /// Mark a draft PR ready for review.
    Ready,
}

/// The fields of the `transition` document a client writes (besides `repoId`, `targetId`,
/// `targetNumber` and, for a merge, `oid`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransitionMove {
    /// `transition.kind`.
    pub kind: u8,
    /// `transition.delta`.
    pub delta: i64,
    /// `transition.targetKind`.
    pub target_kind: u8,
    /// `transition.asAuthor`: 0 for a member, the target's number for its author. The contract
    /// admits an author only when `asAuthor == number`, so 0 proves membership.
    pub as_author: u32,
    /// The state code after the move.
    pub after: i64,
}

/// The move that carries out `action` on a `target` whose state code is `code`, written by a
/// member (`member`) or by the target's author; `None` when consensus would refuse it: an
/// illegal move from this state (`c1`…`c5`), or a merge by a non-member (`f_authorNoMerge`).
///
/// A member writes `asAuthor = 0`; an author who is not a member writes the target's
/// `number` (the author operands of `ownerRefersTo` agree on `number == asAuthor`).
#[must_use]
pub fn next_transition(
    target: TransitionTarget,
    code: i64,
    action: StateAction,
    member: bool,
    target_number: u32,
) -> Option<TransitionMove> {
    use StateAction::{Close, Draft, Merge, Ready, Reopen};
    let kind = match (target, action, code) {
        (TransitionTarget::Issue, Close, 0) => ISSUE_CLOSE,
        (TransitionTarget::Issue, Reopen, 1) => ISSUE_REOPEN,
        (TransitionTarget::Patch, Close, 0) => PR_CLOSE,
        (TransitionTarget::Patch, Close, 8) => PR_DRAFT_CLOSE,
        (TransitionTarget::Patch, Reopen, 1) => PR_REOPEN,
        (TransitionTarget::Patch, Reopen, 9) => PR_DRAFT_REOPEN,
        (TransitionTarget::Patch, Merge, 0) if member => PR_MERGE,
        (TransitionTarget::Patch, Draft, 0) => PR_DRAFT,
        (TransitionTarget::Patch, Ready, 8) => PR_READY,
        _ => return None,
    };
    let delta = delta_of(kind)?;
    Some(TransitionMove {
        kind,
        delta,
        target_kind: target.code(),
        as_author: if member { 0 } else { target_number },
        after: code + delta,
    })
}

/// A target's state, read off its code.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StateStatus {
    /// Neither closed nor merged.
    pub open: bool,
    /// Merged (terminal).
    pub merged: bool,
    /// A draft (open or closed).
    pub draft: bool,
}

/// The state a code stands for (bit 0 closed, bit 1 merged, bit 3 draft).
#[must_use]
pub fn status_of_code(code: i64) -> StateStatus {
    let (closed, merged, draft) = (code & 1 != 0, code & 2 != 0, code & 8 != 0);
    StateStatus {
        open: !closed && !merged,
        merged,
        draft,
    }
}

/// One `transition` document, flattened.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Transition {
    /// Document `$id`.
    #[serde(default)]
    pub id: String,
    /// `transition.kind`.
    pub kind: u8,
    /// Document `$ownerId`.
    #[serde(default)]
    pub actor: String,
    /// The merge commit (kind 13), hex.
    #[serde(default)]
    pub oid: Option<Oid>,
    /// `transition.asAuthor` (0: written by a member).
    #[serde(default)]
    pub as_author: u32,
    /// Consensus `$createdAt` (ms).
    #[serde(default)]
    pub created_at: u64,
}

/// The state code a target's transitions sum to (unknown kinds count 0). On chain every stored
/// transition was a legal move, so this is the same number the proved sum query returns.
#[must_use]
pub fn state_code(transitions: &[Transition]) -> i64 {
    transitions.iter().filter_map(|t| delta_of(t.kind)).sum()
}

/// The target's merge transition (kind 13), if any: a merged PR has exactly one.
#[must_use]
pub fn merge_transition(transitions: &[Transition]) -> Option<&Transition> {
    transitions.iter().find(|t| t.kind == PR_MERGE)
}

/// A repository's issue and PR totals by state (`STATE-COUNTS.md` §4).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoCounts {
    /// Open issues.
    pub issues_open: u64,
    /// Closed issues.
    pub issues_closed: u64,
    /// Open PRs, drafts included (GitHub's open tab).
    pub prs_open: u64,
    /// Closed, not merged PRs (closed drafts included).
    pub prs_closed: u64,
    /// Merged PRs.
    pub prs_merged: u64,
    /// Open drafts (a subset of `prs_open`).
    pub prs_draft: u64,
}

/// The totals by state, from the proved counts: `issues` and `patches` (the `perRepo` counts
/// of `issue` and `patch`) and `kinds` (the `perRepoKind` count of `transition` grouped by
/// `kind`; a kind with no transitions may be absent). Every stored transition is a legal move,
/// so per target closes and reopens alternate and the differences are exact. A count read at a
/// different height than another can make a difference negative: it saturates at 0.
#[must_use]
pub fn repo_counts(issues: u64, patches: u64, kinds: &BTreeMap<u8, u64>) -> RepoCounts {
    let c = |k: u8| kinds.get(&k).copied().unwrap_or(0);
    let issues_closed = c(ISSUE_CLOSE).saturating_sub(c(ISSUE_REOPEN));
    let ready_closed = c(PR_CLOSE).saturating_sub(c(PR_REOPEN));
    let draft_closed = c(PR_DRAFT_CLOSE).saturating_sub(c(PR_DRAFT_REOPEN));
    let prs_merged = c(PR_MERGE);
    let prs_closed = ready_closed + draft_closed;
    RepoCounts {
        issues_open: issues.saturating_sub(issues_closed),
        issues_closed,
        prs_open: patches.saturating_sub(prs_merged + prs_closed),
        prs_closed,
        prs_merged,
        prs_draft: c(PR_DRAFT)
            .saturating_sub(c(PR_READY))
            .saturating_sub(draft_closed),
    }
}

/// The number the next issue or PR of a repo must carry: the contract's `dense` rule requires
/// `number == countOf(issue) + countOf(patch)` counted with the new document, so one more than
/// the two totals read before the write.
#[must_use]
pub fn dense_number(issues: u64, patches: u64) -> Option<u32> {
    u32::try_from(issues.saturating_add(patches).saturating_add(1)).ok()
}

/// The `propertyConstraints` rule that refuses a create whose number is not the dense next one.
pub const DENSE_RULE: &str = "dense";

/// Whether a consensus refusal's text names the `dense` rule (code 10422:
/// *breaks its propertyConstraints rule "dense"*): the count moved between the read and the
/// write, so the create is retried with a fresh count.
#[must_use]
pub fn names_dense_rule(message: &str) -> bool {
    message.contains("rule \"dense\"") || message.contains("rule \\\"dense\\\"")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_kind_has_a_delta_and_a_target() {
        for k in TRANSITION_KINDS {
            assert!(delta_of(k).is_some(), "kind {k}");
            assert!(k / 10 <= 1, "kind {k} names issue or patch");
        }
        assert_eq!(delta_of(3), None);
        assert_eq!(delta_of(9), None);
    }

    #[test]
    fn every_legal_move_lands_on_a_state_code() {
        let codes = [0, 1, 2, 8, 9];
        let actions = [
            StateAction::Close,
            StateAction::Reopen,
            StateAction::Merge,
            StateAction::Draft,
            StateAction::Ready,
        ];
        for target in [TransitionTarget::Issue, TransitionTarget::Patch] {
            for code in codes {
                for a in actions {
                    if let Some(m) = next_transition(target, code, a, true, 5) {
                        assert!(codes.contains(&m.after), "{target:?} {code} {a:?}");
                        assert_eq!(m.kind / 10, target.code());
                        assert_eq!(m.as_author, 0);
                    }
                }
            }
        }
    }

    #[test]
    fn a_merged_pr_is_terminal() {
        for a in [
            StateAction::Close,
            StateAction::Reopen,
            StateAction::Merge,
            StateAction::Draft,
            StateAction::Ready,
        ] {
            assert_eq!(
                next_transition(TransitionTarget::Patch, 2, a, true, 1),
                None
            );
        }
    }

    #[test]
    fn the_dense_refusal_is_recognised() {
        let msg = "A document of type \"issue\" breaks its propertyConstraints rule \"dense\": it does not hold";
        assert!(names_dense_rule(msg));
        assert!(!names_dense_rule(
            "A document of type \"issue\" breaks its propertyConstraints rule \"hasTitle\": it does not hold"
        ));
        assert_eq!(dense_number(3, 4), Some(8));
        assert_eq!(dense_number(u64::from(u32::MAX), 0), None);
    }
}
