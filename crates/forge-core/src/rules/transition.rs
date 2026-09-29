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
//! A lock (kinds 3 / 18, `delta` +16) and an unlock (4 / 19, −16) move bit 4 of the running
//! sum, which is the thread's lock. So a reader folds the sum **mod 16** into the state code
//! and reads the thread as locked when the sum is ≥ 16 ([`fold_sum`]; the contract's
//! `c1`…`c6` take the same modulo). Only members lock (`g_memberLock`).
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
/// Issue conversation locked (+16; members only).
pub const ISSUE_LOCK: u8 = 3;
/// Issue conversation unlocked (−16; members only).
pub const ISSUE_UNLOCK: u8 = 4;
/// PR conversation locked (+16; members only).
pub const PR_LOCK: u8 = 18;
/// PR conversation unlocked (−16; members only).
pub const PR_UNLOCK: u8 = 19;
/// The `delta` of a lock: the bit above every state code.
pub const LOCK_DELTA: i64 = 16;

/// Every `transition.kind` the contract accepts (its `kind` enum).
pub const TRANSITION_KINDS: [u8; 13] = [
    ISSUE_CLOSE,
    ISSUE_REOPEN,
    ISSUE_LOCK,
    ISSUE_UNLOCK,
    PR_CLOSE,
    PR_REOPEN,
    PR_MERGE,
    PR_DRAFT,
    PR_READY,
    PR_DRAFT_CLOSE,
    PR_DRAFT_REOPEN,
    PR_LOCK,
    PR_UNLOCK,
];

/// The `delta` the contract pins for `kind` (`b1`…`b4`), or `None` for a kind it does not have.
#[must_use]
pub fn delta_of(kind: u8) -> Option<i64> {
    match kind {
        ISSUE_CLOSE | PR_CLOSE | PR_DRAFT_CLOSE => Some(1),
        ISSUE_REOPEN | PR_REOPEN | PR_DRAFT_REOPEN => Some(-1),
        PR_MERGE => Some(2),
        PR_DRAFT => Some(8),
        PR_READY => Some(-8),
        ISSUE_LOCK | PR_LOCK => Some(LOCK_DELTA),
        ISSUE_UNLOCK | PR_UNLOCK => Some(-LOCK_DELTA),
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
    /// Lock the conversation (members only; any state).
    Lock,
    /// Unlock the conversation (members only).
    Unlock,
}

/// Who asks for a state change, as the contract's `ownerRefersTo` operands see them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Actor {
    /// A current maintainer or writer (admitted by the membership operands, `asAuthor` 0).
    Member,
    /// The target's author who is not a member (admitted by the author operands).
    Author,
    /// Anyone else: no operand admits them.
    Other,
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

/// The move that carries out `action` on a `target` whose transitions sum to `sum`, written by
/// `actor`; `None` when consensus would refuse it: a writer no operand admits (40120), an
/// illegal move from this state (`c1`…`c6`), a merge by a non-member (`f_authorNoMerge`) or a
/// lock or unlock by one (`g_memberLock`).
///
/// A member writes `asAuthor = 0`; an author who is not a member writes the target's
/// `number` (the author operands of `ownerRefersTo` agree on `number == asAuthor`). A state
/// code below 16 is its own sum, so a caller that holds only the code may pass it.
#[must_use]
pub fn next_transition(
    target: TransitionTarget,
    sum: i64,
    action: StateAction,
    actor: Actor,
    target_number: u32,
) -> Option<TransitionMove> {
    use StateAction::{Close, Draft, Lock, Merge, Ready, Reopen, Unlock};
    let member = match actor {
        Actor::Member => true,
        Actor::Author => false,
        Actor::Other => return None,
    };
    let (code, locked) = fold_sum(sum);
    let kind = match (target, action, code) {
        (TransitionTarget::Issue, Lock, _) if member && !locked => ISSUE_LOCK,
        (TransitionTarget::Issue, Unlock, _) if member && locked => ISSUE_UNLOCK,
        (TransitionTarget::Patch, Lock, _) if member && !locked => PR_LOCK,
        (TransitionTarget::Patch, Unlock, _) if member && locked => PR_UNLOCK,
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
        after: sum + delta,
    })
}

/// A target's transition sum folded into its state code (the sum mod 16) and whether its
/// conversation is locked (the sum is ≥ 16): the reading `c1`…`c6` pin.
#[must_use]
pub fn fold_sum(sum: i64) -> (i64, bool) {
    (sum.rem_euclid(LOCK_DELTA), sum >= LOCK_DELTA)
}

/// A target's state, read off its code.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(clippy::struct_excessive_bools)] // the bits of the state code, read out
pub struct StateStatus {
    /// Neither closed nor merged.
    pub open: bool,
    /// Merged (terminal).
    pub merged: bool,
    /// A draft (open or closed).
    pub draft: bool,
    /// The conversation is locked (members only may post). Serialized only when set, so the
    /// shared `status_of_code` vectors (codes below 16) read unchanged.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub locked: bool,
}

/// The state a code or a whole transition sum stands for (bit 0 closed, bit 1 merged, bit 3
/// draft; a sum of 16 or more is also locked, [`fold_sum`]).
#[must_use]
pub fn status_of_code(sum: i64) -> StateStatus {
    let (code, locked) = fold_sum(sum);
    let (closed, merged, draft) = (code & 1 != 0, code & 2 != 0, code & 8 != 0);
    StateStatus {
        open: !closed && !merged,
        merged,
        draft,
        locked,
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

/// The sum of a target's transition deltas (unknown kinds count 0). On chain every stored
/// transition was a legal move, so this is the same number the proved sum query returns.
#[must_use]
pub fn state_sum(transitions: &[Transition]) -> i64 {
    transitions.iter().filter_map(|t| delta_of(t.kind)).sum()
}

/// The state code a target's transitions fold to: their sum mod 16 ([`fold_sum`]).
#[must_use]
pub fn state_code(transitions: &[Transition]) -> i64 {
    fold_sum(state_sum(transitions)).0
}

/// Whether a target's conversation is locked: its transitions sum to 16 or more.
#[must_use]
pub fn is_locked(transitions: &[Transition]) -> bool {
    fold_sum(state_sum(transitions)).1
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
    let prs_closed = ready_closed.saturating_add(draft_closed);
    RepoCounts {
        issues_open: issues.saturating_sub(issues_closed),
        issues_closed,
        prs_open: patches.saturating_sub(prs_merged.saturating_add(prs_closed)),
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
        assert_eq!(delta_of(5), None);
        assert_eq!(delta_of(9), None);
    }

    #[test]
    fn a_lock_is_bit_four_of_the_sum() {
        assert_eq!(fold_sum(0), (0, false));
        assert_eq!(fold_sum(17), (1, true));
        assert_eq!(fold_sum(24), (8, true));
        let lock = next_transition(
            TransitionTarget::Issue,
            1,
            StateAction::Lock,
            Actor::Member,
            3,
        )
        .unwrap();
        assert_eq!((lock.kind, lock.delta, lock.after), (ISSUE_LOCK, 16, 17));
        assert!(status_of_code(lock.after).locked && !status_of_code(lock.after).open);
        // locked already; unlock only when locked; members only
        assert_eq!(
            next_transition(
                TransitionTarget::Issue,
                17,
                StateAction::Lock,
                Actor::Member,
                3
            ),
            None
        );
        assert_eq!(
            next_transition(
                TransitionTarget::Patch,
                0,
                StateAction::Unlock,
                Actor::Member,
                3
            ),
            None
        );
        assert_eq!(
            next_transition(
                TransitionTarget::Patch,
                0,
                StateAction::Lock,
                Actor::Author,
                3
            ),
            None
        );
        let unlock = next_transition(
            TransitionTarget::Patch,
            18,
            StateAction::Unlock,
            Actor::Member,
            3,
        )
        .unwrap();
        assert_eq!(
            (unlock.kind, unlock.delta, unlock.after),
            (PR_UNLOCK, -16, 2)
        );
        // a locked, closed issue reopens and stays locked
        let reopen = next_transition(
            TransitionTarget::Issue,
            17,
            StateAction::Reopen,
            Actor::Author,
            3,
        )
        .unwrap();
        assert_eq!((reopen.kind, reopen.after), (ISSUE_REOPEN, 16));
        assert!(status_of_code(16).locked && status_of_code(16).open);
        let t = |kind| Transition {
            id: String::new(),
            kind,
            actor: String::new(),
            oid: None,
            as_author: 0,
            created_at: 0,
        };
        let log = [t(ISSUE_CLOSE), t(ISSUE_LOCK)];
        assert_eq!(
            (state_sum(&log), state_code(&log), is_locked(&log)),
            (17, 1, true)
        );
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
                    if let Some(m) = next_transition(target, code, a, Actor::Member, 5) {
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
                next_transition(TransitionTarget::Patch, 2, a, Actor::Member, 1),
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
