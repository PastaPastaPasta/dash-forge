//! A ref's activity (epic E5, client-rules #3/#6): every update that moved one branch or tag,
//! and every config change that protected it or lifted its protection, oldest first. Readers
//! show it as the ref's activity page (`dg repo activity`, the web's Activity link on the
//! branches and tags pages).
//!
//! Only valid updates appear ([`super::valid_updates`]: a plain `refUpdate` on a ref protected
//! as of its `$createdAt` moved nothing), walked in the causal order [`super::resolve_ref`]
//! folds them in. An update's `from` is the tip the walk holds before it, never the writer's
//! own `prevOid`: a pusher cannot make a force-push read as a fast-forward by naming another
//! parent. Two pushes racing in one block therefore read as one built on the other; when they
//! do not share history the second reads as force-pushed, which errs on the side of saying so.
//! An update that leaves the tip where it was is no change and is left out.
//!
//! Whether the new tip contains the old one is commit-graph knowledge the rule does not have:
//! the caller answers it per pair (`contains(old, new)`), `None` when it cannot tell within
//! its budget. A branch move then reads `pushed` (contained), `forcePushed` (not) or `updated`
//! (unknown). A tag that names another object reads `moved` whatever the graph says: moving a
//! tag is always a rewrite.
//!
//! Protection follows the config in force (`config_as_of`): configs sharing a `$createdAt`
//! take effect together, the greatest `$id` winning, so a change that one of them made and
//! another undid in the same block never took effect and is not listed. The first config that
//! protects the ref reads `protectionAdded`, a later one that stops protecting it
//! `protectionLifted`, and one that protects it again `protectionRestored`. A config event
//! comes before the updates of the same `$createdAt`: those updates were judged by it.
//!
//! Parity: `refHistory` in `forge-web/lib/rules/refHistory.ts` (vectors `ref_history__*`).

use serde::{Deserialize, Serialize};

use super::{is_null_oid, matches_protected, valid_updates, ConfigDoc, RefUpdate};

/// What one entry of a ref's activity did.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RefEventKind {
    /// The ref was created (or created again after a deletion).
    Created,
    /// A branch moved to a commit that contains its old tip.
    Pushed,
    /// A branch moved to a commit that does not contain its old tip.
    ForcePushed,
    /// A branch moved, and whether the new tip contains the old one is not known.
    Updated,
    /// A tag was moved to another object.
    Moved,
    /// The ref was deleted.
    Deleted,
    /// The ref became protected for the first time.
    ProtectionAdded,
    /// The ref stopped being protected.
    ProtectionLifted,
    /// The ref became protected again after its protection was lifted.
    ProtectionRestored,
}

impl RefEventKind {
    /// A config change rather than an update.
    #[must_use]
    pub fn is_protection(self) -> bool {
        matches!(
            self,
            Self::ProtectionAdded | Self::ProtectionLifted | Self::ProtectionRestored
        )
    }
}

/// One entry of a ref's activity.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RefEvent {
    /// What happened.
    pub kind: RefEventKind,
    /// The update's `$id`, or the config's (the one in force after the change).
    pub id: String,
    /// Its `$createdAt` (ms).
    pub at: u64,
    /// The update's `$ownerId`; `None` for a config change (the caller knows its writer).
    pub by: Option<String>,
    /// The tip before an update; `None` when the ref did not exist, and for a config change.
    pub from: Option<String>,
    /// The tip an update set; `None` for a deletion and a config change.
    pub to: Option<String>,
}

/// The activity of the ref `ref_name` (whose key is `ref_name_hash`, hex), oldest first, from
/// its updates of both types and the repository's config timeline. `contains(old, new)`: whether
/// commit `new` contains commit `old`, `None` when unknown.
#[must_use]
pub fn ref_history(
    ref_name: &str,
    ref_name_hash: &str,
    updates: &[RefUpdate],
    configs: &[ConfigDoc],
    contains: impl Fn(&str, &str) -> Option<bool>,
) -> Vec<RefEvent> {
    let is_tag = ref_name.starts_with("refs/tags/");
    let mut moves = Vec::new();
    let mut tip: Option<String> = None;
    for u in valid_updates(updates, configs, ref_name_hash) {
        let to = (!is_null_oid(&u.new_oid)).then(|| u.new_oid.clone());
        if to == tip {
            continue;
        }
        let kind = match (&tip, &to) {
            (None, _) => RefEventKind::Created,
            (Some(_), None) => RefEventKind::Deleted,
            (Some(_), Some(_)) if is_tag => RefEventKind::Moved,
            (Some(old), Some(new)) => match contains(old, new) {
                Some(true) => RefEventKind::Pushed,
                Some(false) => RefEventKind::ForcePushed,
                None => RefEventKind::Updated,
            },
        };
        moves.push(RefEvent {
            kind,
            id: u.id.clone(),
            at: u.created_at,
            by: Some(u.author.clone()),
            from: tip.clone(),
            to: to.clone(),
        });
        tip = to;
    }

    // The config in force after each block of configs: the block's greatest `$id`.
    let mut sorted: Vec<&ConfigDoc> = configs.iter().collect();
    sorted.sort_by(|a, b| (a.created_at, &a.id).cmp(&(b.created_at, &b.id)));
    let mut protection = Vec::new();
    let (mut now, mut ever) = (false, false);
    for (i, c) in sorted.iter().enumerate() {
        if sorted.get(i + 1).is_some_and(|n| n.created_at == c.created_at) {
            continue;
        }
        let protects = matches_protected(ref_name, &c.protected_patterns);
        if protects == now {
            continue;
        }
        let kind = match (protects, ever) {
            (false, _) => RefEventKind::ProtectionLifted,
            (true, false) => RefEventKind::ProtectionAdded,
            (true, true) => RefEventKind::ProtectionRestored,
        };
        protection.push(RefEvent {
            kind,
            id: c.id.clone(),
            at: c.created_at,
            by: None,
            from: None,
            to: None,
        });
        now = protects;
        ever |= protects;
    }

    // Merge by time; a config change goes before the updates of its block.
    let mut out = Vec::with_capacity(moves.len() + protection.len());
    let (mut m, mut p) = (moves.into_iter().peekable(), protection.into_iter().peekable());
    loop {
        let take_protection = match (m.peek(), p.peek()) {
            (Some(u), Some(c)) => c.at <= u.at,
            (None, Some(_)) => true,
            (_, None) => false,
        };
        match if take_protection { p.next() } else { m.next() } {
            Some(e) => out.push(e),
            None => break,
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn upd(id: &str, prev: &str, new: &str, at: u64, protected: bool) -> RefUpdate {
        RefUpdate {
            id: id.into(),
            ref_name_hash: "H".into(),
            ref_name: "refs/heads/main".into(),
            prev_oid: prev.into(),
            new_oid: new.into(),
            force: false,
            protected,
            author: format!("by-{id}"),
            created_at: at,
        }
    }

    fn cfg(id: &str, at: u64, patterns: &[&str]) -> ConfigDoc {
        ConfigDoc {
            id: id.into(),
            created_at: at,
            protected_patterns: patterns.iter().map(|p| (*p).to_string()).collect(),
        }
    }

    fn kinds(events: &[RefEvent]) -> Vec<RefEventKind> {
        events.iter().map(|e| e.kind).collect()
    }

    #[test]
    fn force_push_is_judged_from_the_walked_tip_not_the_writers_prev_oid() {
        // u2 claims to build on X, an ancestor of C, to pass as a fast-forward.
        let updates = [upd("u1", "0", "A", 10, false), upd("u2", "X", "C", 20, false)];
        let contains = |old: &str, new: &str| Some(old == "X" && new == "C");
        let got = ref_history("refs/heads/main", "H", &updates, &[], contains);
        assert_eq!(
            kinds(&got),
            [RefEventKind::Created, RefEventKind::ForcePushed]
        );
        assert_eq!(got[1].from.as_deref(), Some("A"));
    }

    #[test]
    fn unknown_ancestry_reads_updated() {
        let updates = [upd("u1", "0", "A", 10, false), upd("u2", "A", "B", 20, false)];
        let got = ref_history("refs/heads/main", "H", &updates, &[], |_, _| None);
        assert_eq!(kinds(&got), [RefEventKind::Created, RefEventKind::Updated]);
    }

    #[test]
    fn protection_lifted_and_restored_around_an_update() {
        let configs = [
            cfg("c1", 5, &["refs/heads/main"]),
            cfg("c2", 15, &[]),
            cfg("c3", 30, &["refs/heads/*"]),
        ];
        // u2 is plain: valid only because c2 lifted protection before it.
        let updates = [upd("u1", "0", "A", 10, true), upd("u2", "A", "B", 20, false)];
        let got = ref_history("refs/heads/main", "H", &updates, &configs, |_, _| {
            Some(false)
        });
        assert_eq!(
            kinds(&got),
            [
                RefEventKind::ProtectionAdded,
                RefEventKind::Created,
                RefEventKind::ProtectionLifted,
                RefEventKind::ForcePushed,
                RefEventKind::ProtectionRestored,
            ]
        );
    }
}
