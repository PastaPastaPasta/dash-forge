//! Merge integrity: does a recorded merge really contain the pull request?
//!
//! Consensus admits a merge `transition` (kind 13) from a maintainer or role-1 writer with any
//! `oid`, and a merged PR is final (D-9). The fold only checks that the `oid` has been a valid
//! tip of the base (`pr_state_v2`'s `merge_on_base`), never that the PR's commits are in it, so
//! a member could mark any PR merged by naming an old tip. Readers close that gap here: from git
//! facts the client gathers (an ancestry walk and three tree-level diffs), [`merge_content`]
//! labels a merge as containing the PR, as a squash or a rebase of it, or as not containing it.
//! Consensus can never check this (it cannot read git objects), so it stays a reader rule, shared
//! with forge-web's `merge-content.ts` through the `merge_content__*` vectors.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::review::PrReviewState;

/// A tree-level change between two commits: each changed path and the blob it ends with (`""`
/// when the change deletes it). Renames are a delete plus an add.
pub type TreeChange = BTreeMap<String, String>;

/// What a reader found in git about a recorded merge. `None` means "could not be read" (the
/// objects are missing or a walk hit its limit): the rule then says `unknown`, never `missing`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MergeFacts {
    /// The PR's head when it was merged ([`head_at`]).
    pub head_oid: String,
    /// The merge transition's `oid`.
    pub merge_oid: String,
    /// The base's valid tip just before `merge_oid` first became one; `""` when there is none
    /// (the merge commit was the base's first tip, or never a tip).
    #[serde(default)]
    pub tip_before: String,
    /// `merge_oid`'s parents, in order.
    #[serde(default)]
    pub merge_parents: Vec<String>,
    /// `head_oid` is `merge_oid` or one of its ancestors.
    #[serde(default)]
    pub head_in_merge: Option<bool>,
    /// `tip_before` is an ancestor of `merge_oid` (the merge built on the base, not a rewrite).
    #[serde(default)]
    pub tip_before_in_merge: Option<bool>,
    /// What the merge changed: `tip_before` → `merge_oid`.
    #[serde(default)]
    pub merge_change: Option<TreeChange>,
    /// What the PR changes: `merge-base(head_oid, tip_before)` → `head_oid`.
    #[serde(default)]
    pub pr_change: Option<TreeChange>,
    /// What the base changed meanwhile: `merge-base(head_oid, tip_before)` → `tip_before`.
    #[serde(default)]
    pub base_change: Option<TreeChange>,
}

/// How a recorded merge relates to the PR ([`merge_content`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MergeVerdict {
    /// The PR's head is the merge commit or one of its ancestors.
    Contains,
    /// One commit on the base's previous tip that makes exactly the PR's changes.
    Squash,
    /// Commits on the base's previous tip that together make exactly the PR's changes.
    Rebase,
    /// The merge commit neither contains the PR's head nor makes its changes.
    Missing,
    /// The commits could not be read, so nothing is claimed.
    Unknown,
}

/// [`merge_content`]'s answer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeContent {
    /// The label.
    pub verdict: MergeVerdict,
    /// For a squash or a rebase: the paths whose merged content differs from the PR's because
    /// the base changed them too (git combined both sides), sorted. Empty otherwise.
    pub combined: Vec<String>,
}

impl MergeContent {
    fn of(verdict: MergeVerdict) -> Self {
        Self {
            verdict,
            combined: Vec::new(),
        }
    }
}

/// Whether the merge's change is the PR's change. `Ok(Some(combined))` when the merge changes
/// exactly the paths the PR changes, each to the PR's blob or, where the base changed that path
/// too, to any blob (git combined both sides; those paths are `combined`). `Ok(None)` when it
/// does not. `Err(())` when a fact needed to decide could not be read.
fn same_changes(f: &MergeFacts) -> Result<Option<Vec<String>>, ()> {
    if f.tip_before.is_empty() || f.tip_before_in_merge == Some(false) {
        return Ok(None);
    }
    let (Some(true), Some(merge), Some(pr)) =
        (f.tip_before_in_merge, &f.merge_change, &f.pr_change)
    else {
        return Err(());
    };
    if merge.len() != pr.len() || merge.keys().any(|p| !pr.contains_key(p)) {
        return Ok(None);
    }
    let differing: Vec<String> = merge
        .iter()
        .filter(|(path, blob)| pr.get(*path) != Some(blob))
        .map(|(path, _)| path.clone())
        .collect();
    if differing.is_empty() {
        return Ok(Some(differing));
    }
    let Some(base) = &f.base_change else {
        return Err(());
    };
    Ok(differing
        .iter()
        .all(|p| base.contains_key(p))
        .then_some(differing))
}

/// Label a recorded merge from git facts (see [`MergeFacts`]):
///
/// - `contains` when the PR head is the merge commit or an ancestor of it (a fast-forward or a
///   merge commit);
/// - else `squash` or `rebase` when the merge was built on the base's previous tip and its
///   tree-level change is the PR's own (`merge-base(head, tip_before)` → `head`): the same paths,
///   each with the PR's blob, except where the base changed the path too (listed in
///   `combined`). `squash` when the merge commit is one commit whose only parent is that tip;
///   `rebase` otherwise;
/// - else `missing` when the head is known not to be in it;
/// - else `unknown`: a fact needed to decide could not be read.
#[must_use]
pub fn merge_content(f: &MergeFacts) -> MergeContent {
    if f.head_in_merge == Some(true) || (!f.head_oid.is_empty() && f.head_oid == f.merge_oid) {
        return MergeContent::of(MergeVerdict::Contains);
    }
    match same_changes(f) {
        Ok(Some(combined)) => {
            let squash = f.merge_parents.len() == 1 && f.merge_parents[0] == f.tip_before;
            MergeContent {
                verdict: if squash {
                    MergeVerdict::Squash
                } else {
                    MergeVerdict::Rebase
                },
                combined,
            }
        }
        Ok(None) if f.head_in_merge == Some(false) => MergeContent::of(MergeVerdict::Missing),
        _ => MergeContent::of(MergeVerdict::Unknown),
    }
}

/// The PR's head when it was merged at `merged_at` (the merge transition's `$createdAt`): the
/// newest applied head update written no later, else `initial_head` (the patch's `headOid`). A
/// head update written after the merge does not change what was merged.
#[must_use]
pub fn head_at(review: &PrReviewState, initial_head: &str, merged_at: u64) -> String {
    review
        .head_updates
        .iter()
        .rev()
        .find(|u| u.created_at <= merged_at)
        .map_or_else(|| initial_head.to_string(), |u| u.oid.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn change(pairs: &[(&str, &str)]) -> TreeChange {
        pairs
            .iter()
            .map(|(p, b)| ((*p).to_string(), (*b).to_string()))
            .collect()
    }

    fn squash_facts() -> MergeFacts {
        MergeFacts {
            head_oid: "h".into(),
            merge_oid: "m".into(),
            tip_before: "t".into(),
            merge_parents: vec!["t".into()],
            head_in_merge: Some(false),
            tip_before_in_merge: Some(true),
            merge_change: Some(change(&[("a", "1")])),
            pr_change: Some(change(&[("a", "1")])),
            base_change: Some(change(&[])),
        }
    }

    #[test]
    fn the_head_itself_contains_the_pr_without_any_walk() {
        let f = MergeFacts {
            head_oid: "h".into(),
            merge_oid: "h".into(),
            ..MergeFacts::default()
        };
        assert_eq!(merge_content(&f).verdict, MergeVerdict::Contains);
    }

    #[test]
    fn an_unread_diff_is_unknown_never_missing() {
        let f = MergeFacts {
            merge_change: None,
            ..squash_facts()
        };
        assert_eq!(merge_content(&f).verdict, MergeVerdict::Unknown);
    }

    #[test]
    fn a_squash_with_an_extra_path_is_missing() {
        let f = MergeFacts {
            merge_change: Some(change(&[("a", "1"), ("b", "2")])),
            ..squash_facts()
        };
        assert_eq!(merge_content(&f).verdict, MergeVerdict::Missing);
    }

    #[test]
    fn head_at_ignores_updates_after_the_merge() {
        use super::super::review::HeadUpdate;
        let review = PrReviewState {
            head: "c".into(),
            head_updates: vec![
                HeadUpdate {
                    oid: "b".into(),
                    actor: "x".into(),
                    created_at: 10,
                    id: "1".into(),
                },
                HeadUpdate {
                    oid: "c".into(),
                    actor: "x".into(),
                    created_at: 30,
                    id: "2".into(),
                },
            ],
            requested_reviewers: Vec::new(),
            resolved_threads: Vec::new(),
            dismissed_reviews: Vec::new(),
            milestone: None,
        };
        assert_eq!(head_at(&review, "a", 5), "a");
        assert_eq!(head_at(&review, "a", 20), "b");
        assert_eq!(head_at(&review, "a", 30), "c");
    }
}
