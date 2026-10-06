//! A ref's activity (epic E5, client-rules #3/#6): every update that moved one branch or tag,
//! and every config change that protected it or lifted its protection, oldest first. Readers
//! show it as the ref's activity page (`dg repo activity`, the web's Activity link on the
//! branches and tags pages).
//!
//! Only valid updates appear ([`super::valid_updates`]: a plain `refUpdate` on a ref protected
//! as of its `$createdAt` moved nothing), walked in the causal order [`super::resolve_ref`]
//! folds them in, tracking the live heads as [`super::live_heads`] does: a later update
//! supersedes a head when it is a deletion, is forced, builds on it (`prevOid` names it) or
//! contains it. An update's `from` is the head it supersedes (the newest, when several), never
//! the writer's own `prevOid` unchecked.
//!
//! Whether a tip contains another is commit-graph knowledge the rule does not have: the caller
//! answers it per pair (`contains(old, new)`), `None` when it cannot tell within its budget. A
//! branch move then reads `pushed` when every head it supersedes is contained, `forcePushed`
//! when it supersedes (forced, or building on it) a head it does not contain, and `updated`
//! when that is unknown. An update that supersedes no head (a race the fold leaves as two tips)
//! reads `diverged`, as `resolve_ref` reads the ref then. A tag that names another object reads
//! `moved` whatever the graph says: moving a tag is always a rewrite. An update that sets a
//! tip the ref already holds alone is no change and is left out.
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
    /// A push superseded no live head: the ref now has two tips racing (`resolve_ref` reads it
    /// diverged until a later push settles it).
    Diverged,
    /// The ref became protected for the first time.
    ProtectionAdded,
    /// The ref stopped being protected.
    ProtectionLifted,
    /// The ref became protected again after its protection was lifted.
    ProtectionRestored,
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

/// The updates of [`ref_history`], each judged against the live heads it supersedes.
fn ref_moves(
    ref_name: &str,
    ref_name_hash: &str,
    updates: &[RefUpdate],
    configs: &[ConfigDoc],
    contains: impl Fn(&str, &str) -> Option<bool>,
) -> Vec<RefEvent> {
    let is_tag = ref_name.starts_with("refs/tags/");
    let mut moves = Vec::new();
    // The live heads, oldest first: (tip, the update that set it).
    let mut heads: Vec<&RefUpdate> = Vec::new();
    for v in valid_updates(updates, configs, ref_name_hash) {
        let event = |kind, from: Option<&str>, to: Option<&str>| RefEvent {
            kind,
            id: v.id.clone(),
            at: v.created_at,
            by: Some(v.author.clone()),
            from: from.map(str::to_string),
            to: to.map(str::to_string),
        };
        if is_null_oid(&v.new_oid) {
            if let Some(last) = heads.last() {
                moves.push(event(RefEventKind::Deleted, Some(&last.new_oid), None));
            }
            heads.clear();
            continue;
        }
        let Some(newest) = heads.last().map(|h| h.new_oid.clone()) else {
            moves.push(event(RefEventKind::Created, None, Some(&v.new_oid)));
            heads.push(v);
            continue;
        };
        // The same tip again: that head is v's now; any other head it also supersedes goes.
        let same = heads.iter().any(|h| h.new_oid == v.new_oid);
        let mut superseded = Vec::new();
        let mut kept = Vec::new();
        for h in heads.drain(..) {
            if h.new_oid == v.new_oid {
                continue;
            }
            let has = contains(&h.new_oid, &v.new_oid);
            let rewrite = v.force || super::builds_on(v, h);
            if rewrite || has == Some(true) {
                superseded.push((h, has));
            } else {
                kept.push(h);
            }
        }
        heads = kept;
        heads.push(v);
        if superseded.is_empty() {
            if !same {
                moves.push(event(
                    RefEventKind::Diverged,
                    Some(&newest),
                    Some(&v.new_oid),
                ));
            }
            continue;
        }
        let from = superseded.last().map(|(h, _)| h.new_oid.clone());
        let kind = if is_tag {
            RefEventKind::Moved
        } else if superseded.iter().any(|(_, has)| *has == Some(false)) {
            RefEventKind::ForcePushed
        } else if superseded.iter().all(|(_, has)| *has == Some(true)) {
            RefEventKind::Pushed
        } else {
            RefEventKind::Updated
        };
        moves.push(event(kind, from.as_deref(), Some(&v.new_oid)));
    }
    moves
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
    let moves = ref_moves(ref_name, ref_name_hash, updates, configs, contains);

    // The config in force after each block of configs: the block's greatest `$id`.
    let mut sorted: Vec<&ConfigDoc> = configs.iter().collect();
    sorted.sort_by(|a, b| (a.created_at, &a.id).cmp(&(b.created_at, &b.id)));
    let mut protection = Vec::new();
    let (mut now, mut ever) = (false, false);
    for (i, c) in sorted.iter().enumerate() {
        if sorted
            .get(i + 1)
            .is_some_and(|n| n.created_at == c.created_at)
        {
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
    let (mut m, mut p) = (
        moves.into_iter().peekable(),
        protection.into_iter().peekable(),
    );
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
    fn a_push_naming_another_parent_supersedes_nothing() {
        // u2 claims to build on X, an ancestor of C, to pass as a fast-forward: it neither
        // builds on nor contains A, so it races with A, as the fold reads it.
        let updates = [
            upd("u1", "0", "A", 10, false),
            upd("u2", "X", "C", 20, false),
        ];
        let contains = |old: &str, new: &str| Some(old == "X" && new == "C");
        let got = ref_history("refs/heads/main", "H", &updates, &[], contains);
        assert_eq!(kinds(&got), [RefEventKind::Created, RefEventKind::Diverged]);
        assert_eq!(got[1].from.as_deref(), Some("A"));
        // Forced, it supersedes A, which it does not contain: a force-push.
        let forced = [
            upd("u1", "0", "A", 10, false),
            RefUpdate {
                force: true,
                ..upd("u2", "X", "C", 20, false)
            },
        ];
        let got = ref_history("refs/heads/main", "H", &forced, &[], contains);
        assert_eq!(
            kinds(&got),
            [RefEventKind::Created, RefEventKind::ForcePushed]
        );
    }

    #[test]
    fn unknown_ancestry_reads_updated() {
        let updates = [
            upd("u1", "0", "A", 10, false),
            upd("u2", "A", "B", 20, false),
        ];
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
        let updates = [
            upd("u1", "0", "A", 10, true),
            upd("u2", "A", "B", 20, false),
        ];
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
