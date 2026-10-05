//! Authorization, the snapshot chain and fork detection (D24), and the removal checklist: pure
//! functions over manifests and what opened, shared with forge-web through the
//! `env_snapshot__*` vectors.
//!
//! [`resolve`] is D24 applied strictly, step by step:
//!
//! 1. Manifests in `($createdAtBlockHeight, $id)` order. Only one whose `$ownerId` is a **current
//!    maintainer** counts; every other is ignored (`notAMaintainer`: a writer's, or a removed or
//!    demoted maintainer's), and none of its links is ever read. A second current maintainer's
//!    manifest of a counted `packHash` is ignored (`duplicate`).
//! 2. A counted snapshot `t` supersedes a counted `s` when `t.supersedes` names `s` and `s` is
//!    strictly lower in block height (no self-links, no forward links, no cycles). A link between
//!    two readable snapshots of different environments does not count. Writers name every counted
//!    snapshot of the environment, newest first, up to 32, so a removed maintainer's change in the
//!    middle of a chain splits nothing.
//! 3. Snapshots linked this way form components. A component belongs to every environment
//!    one of its readable snapshots names; its unreadable snapshots go with it. A component with
//!    no readable snapshot is a hidden environment (counted, never named).
//! 4. An environment's heads are its snapshots no other of its snapshots supersedes, oldest
//!    first. One readable head: `current`. One unreadable head: `unreadable` (the latest change
//!    does not open here; nothing older is served). Two or more: `conflict`.
//! 5. An ignored manifest that names a head of an environment, from a higher block, is listed in
//!    that environment's `ignored_newer`: readers say a newer change was ignored, and never use it.

use std::collections::{BTreeMap, BTreeSet};

use super::format::Snapshot;
use super::Audience;

/// One kind-8 `packManifest`, as the chain reads it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SnapshotRef {
    /// The manifest document id (base58).
    pub id: String,
    /// `$ownerId` (base58).
    pub owner_id: String,
    /// `packHash`.
    pub pack_hash: [u8; 32],
    /// `supersedes`.
    pub supersedes: Vec<[u8; 32]>,
    /// `$createdAtBlockHeight`: what orders snapshots and links.
    pub height: u64,
}

/// Why a manifest does not count.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum IgnoredReason {
    /// Its owner is not a current maintainer (a writer's, or a removed maintainer's).
    NotAMaintainer,
    /// Another authorized manifest of the same artifact came first.
    Duplicate,
}

/// A manifest that does not count.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Ignored {
    /// Its document id.
    pub id: String,
    /// Why.
    pub reason: IgnoredReason,
}

/// The state of one environment.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum State {
    /// One readable head: the environment's values.
    Current,
    /// One head, which does not open for this reader.
    Unreadable,
    /// Two or more heads: people pick; programs refuse.
    Conflict,
}

/// One environment this reader can name.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvState {
    /// Its name.
    pub env: String,
    /// Current, unreadable or conflict.
    pub state: State,
    /// The heads' document ids, oldest first.
    pub heads: Vec<String>,
    /// Every snapshot's document id, oldest first.
    pub snapshots: Vec<String>,
    /// Ignored manifests (by people who are not maintainers now) that name a head from a higher
    /// block: never used; readers warn about them.
    pub ignored_newer: Vec<String>,
}

/// An environment none of whose snapshots open for this reader.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct HiddenEnv {
    /// Its heads' document ids, oldest first.
    pub heads: Vec<String>,
    /// Every snapshot's document id, oldest first.
    pub snapshots: Vec<String>,
}

/// [`resolve`]'s answer.
#[derive(Debug, Clone, PartialEq, Eq, Default, serde::Serialize)]
pub struct Resolution {
    /// Manifests that do not count, in `($createdAtBlockHeight, $id)` order.
    pub ignored: Vec<Ignored>,
    /// The environments by name.
    pub environments: Vec<EnvState>,
    /// Environments this reader cannot name, oldest first.
    pub hidden: Vec<HiddenEnv>,
}

impl Resolution {
    /// The environment named `env`.
    #[must_use]
    pub fn env(&self, env: &str) -> Option<&EnvState> {
        self.environments.iter().find(|e| e.env == env)
    }
}

/// Resolve `manifests` (kind 8 only) against the current `maintainers` (base58) and
/// `env_of(packHash)`: the environment a counted snapshot opened to, `None` when it did not open
/// for this reader. See the module docs for the steps.
#[must_use]
#[allow(clippy::too_many_lines)] // one pass, step by step as the module docs number them
pub fn resolve<'a>(
    maintainers: &BTreeSet<String>,
    manifests: &[SnapshotRef],
    env_of: impl Fn(&[u8; 32]) -> Option<&'a str>,
) -> Resolution {
    let mut order: Vec<&SnapshotRef> = manifests.iter().collect();
    order.sort_by(|a, b| (a.height, &a.id).cmp(&(b.height, &b.id)));
    let mut nodes: BTreeMap<[u8; 32], &SnapshotRef> = BTreeMap::new();
    let mut others: Vec<&SnapshotRef> = Vec::new();
    let mut ignored = Vec::new();
    for m in order {
        let reason = if !maintainers.contains(&m.owner_id) {
            others.push(m);
            IgnoredReason::NotAMaintainer
        } else if let std::collections::btree_map::Entry::Vacant(slot) = nodes.entry(m.pack_hash) {
            slot.insert(m);
            continue;
        } else {
            IgnoredReason::Duplicate
        };
        ignored.push(Ignored {
            id: m.id.clone(),
            reason,
        });
    }

    let mut edges: BTreeSet<([u8; 32], [u8; 32])> = BTreeSet::new();
    for (h, t) in &nodes {
        for s in &t.supersedes {
            let Some(target) = nodes.get(s) else { continue };
            if target.height >= t.height {
                continue;
            }
            if let (Some(a), Some(b)) = (env_of(h), env_of(s)) {
                if a != b {
                    continue;
                }
            }
            edges.insert((*h, *s));
        }
    }
    let comps = components(nodes.keys().copied(), &edges);

    let key = |h: &[u8; 32]| (nodes[h].height, nodes[h].id.clone());
    let ids = |hs: &mut Vec<[u8; 32]>| -> Vec<String> {
        hs.sort_by_key(|h| key(h));
        hs.iter().map(|h| nodes[h].id.clone()).collect()
    };
    let heads_of = |group: &BTreeSet<[u8; 32]>| -> Vec<[u8; 32]> {
        group
            .iter()
            .filter(|n| !group.iter().any(|t| edges.contains(&(*t, **n))))
            .copied()
            .collect()
    };
    let newer = |heads: &[[u8; 32]]| -> Vec<String> {
        let mut out: Vec<String> = others
            .iter()
            .filter(|m| {
                heads.iter().any(|h| {
                    m.supersedes.contains(h) && m.height > nodes[h].height && m.pack_hash != *h
                })
            })
            .map(|m| m.id.clone())
            .collect();
        out.sort();
        out
    };

    let mut envs: BTreeMap<String, BTreeSet<[u8; 32]>> = BTreeMap::new();
    let mut hidden: Vec<Vec<[u8; 32]>> = Vec::new();
    for members in &comps {
        let names: BTreeSet<&str> = members.iter().filter_map(&env_of).collect();
        if names.is_empty() {
            hidden.push(members.clone());
        }
        for name in names {
            envs.entry(name.to_owned()).or_default().extend(
                members
                    .iter()
                    .filter(|h| env_of(h).is_none_or(|e| e == name))
                    .copied(),
            );
        }
    }
    let environments = envs
        .into_iter()
        .map(|(env, group)| {
            let mut heads = heads_of(&group);
            let state = match heads.as_slice() {
                [one] if env_of(one).is_some() => State::Current,
                [_] => State::Unreadable,
                _ => State::Conflict,
            };
            let ignored_newer = newer(&heads);
            let mut all: Vec<[u8; 32]> = group.into_iter().collect();
            EnvState {
                env,
                state,
                heads: ids(&mut heads),
                snapshots: ids(&mut all),
                ignored_newer,
            }
        })
        .collect();
    hidden.sort_by_key(|g| g.iter().map(&key).min());
    let hidden = hidden
        .into_iter()
        .map(|g| {
            let set: BTreeSet<[u8; 32]> = g.iter().copied().collect();
            let mut heads = heads_of(&set);
            let mut all = g;
            HiddenEnv {
                heads: ids(&mut heads),
                snapshots: ids(&mut all),
            }
        })
        .collect();
    Resolution {
        ignored,
        environments,
        hidden,
    }
}

/// The connected components of `nodes` under `edges` (union-find, the smaller hash as the root).
fn components(
    nodes: impl Iterator<Item = [u8; 32]>,
    edges: &BTreeSet<([u8; 32], [u8; 32])>,
) -> Vec<Vec<[u8; 32]>> {
    fn find(parent: &mut BTreeMap<[u8; 32], [u8; 32]>, mut x: [u8; 32]) -> [u8; 32] {
        while parent[&x] != x {
            let up = parent[&parent[&x]];
            parent.insert(x, up);
            x = up;
        }
        x
    }
    let mut parent: BTreeMap<[u8; 32], [u8; 32]> = nodes.map(|h| (h, h)).collect();
    for (a, b) in edges {
        let (ra, rb) = (find(&mut parent, *a), find(&mut parent, *b));
        if ra != rb {
            parent.insert(ra.max(rb), ra.min(rb));
        }
    }
    let keys: Vec<[u8; 32]> = parent.keys().copied().collect();
    let mut comps: BTreeMap<[u8; 32], Vec<[u8; 32]>> = BTreeMap::new();
    for h in keys {
        let r = find(&mut parent, h);
        comps.entry(r).or_default().push(h);
    }
    comps.into_values().collect()
}

/// The most `packHash`es one `supersedes` holds (the contract's 1,024 bytes).
pub const MAX_SUPERSEDES: usize = 32;

/// What a new snapshot names in `supersedes` (`env_snapshot__window`): the environment's heads,
/// then the newest snapshot of each other author, then the rest, newest first, at most
/// [`MAX_SUPERSEDES`]. `snapshots` are the environment's counted snapshots, `heads` their ids.
/// Naming each author's newest keeps the chain whole when a maintainer with a long run of
/// changes is removed (readers follow links only between counted snapshots).
#[must_use]
pub fn window(snapshots: &[&SnapshotRef], heads: &[String]) -> Vec<[u8; 32]> {
    let newest_first =
        |a: &&&SnapshotRef, b: &&&SnapshotRef| (b.height, &b.id).cmp(&(a.height, &a.id));
    let mut out: Vec<&SnapshotRef> = snapshots
        .iter()
        .filter(|s| heads.contains(&s.id))
        .copied()
        .collect();
    out.sort_by(|a, b| (b.height, &b.id).cmp(&(a.height, &a.id)));
    let mut rest: Vec<&&SnapshotRef> = snapshots
        .iter()
        .filter(|s| !heads.contains(&s.id))
        .collect();
    rest.sort_by(newest_first);
    let mut authors: BTreeSet<&str> = out.iter().map(|s| s.owner_id.as_str()).collect();
    let mut taken: BTreeSet<&str> = out.iter().map(|s| s.id.as_str()).collect();
    for s in &rest {
        if authors.insert(s.owner_id.as_str()) {
            taken.insert(s.id.as_str());
            out.push(s);
        }
    }
    for s in rest {
        if taken.insert(s.id.as_str()) {
            out.push(s);
        }
    }
    out.iter()
        .take(MAX_SUPERSEDES)
        .map(|s| s.pack_hash)
        .collect()
}

/// How environments differ between two resolutions of the same manifests (a membership change's
/// dry run): by name, those whose heads or state change, those only `before` names, and those
/// only `after` names.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Changed {
    /// In both, with other heads or another state.
    pub changed: Vec<String>,
    /// Only before (it would disappear).
    pub vanished: Vec<String>,
    /// Only after (it would appear).
    pub appeared: Vec<String>,
}

impl Changed {
    /// Whether nothing changes.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.changed.is_empty() && self.vanished.is_empty() && self.appeared.is_empty()
    }
}

/// [`Changed`] from `before` to `after`.
#[must_use]
pub fn changed(before: &Resolution, after: &Resolution) -> Changed {
    let mut out = Changed::default();
    for b in &before.environments {
        match after.env(&b.env) {
            Some(a) if a.state == b.state && a.heads == b.heads => {}
            Some(_) => out.changed.push(b.env.clone()),
            None => out.vanished.push(b.env.clone()),
        }
    }
    out.appeared = after
        .environments
        .iter()
        .filter(|a| before.env(&a.env).is_none())
        .map(|a| a.env.clone())
        .collect();
    out
}

/// One environment's opened snapshots, as the removal checklist reads them.
#[derive(Debug, Clone, Copy)]
pub struct EnvHistory<'a> {
    /// The environment's name.
    pub env: &'a str,
    /// Its readable heads.
    pub heads: &'a [&'a Snapshot],
    /// Every readable snapshot of it.
    pub snapshots: &'a [&'a Snapshot],
}

/// What a removed person could read in one environment.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Exposure {
    /// The environment.
    pub env: String,
    /// Its audience (the newest head's).
    pub audience: Audience,
    /// The names of current values they could read, sorted.
    pub names: Vec<String>,
}

/// The removal checklist (DESIGN §4.5 "Audit and exposure"): for `removed` (base58), who held the
/// members key when `held_members_key`, the current value names they could read: a name of a
/// readable head whose current value appears in some snapshot of the environment they could open
/// (any Members snapshot when they held the members key, which hands over past values too; a
/// Maintainers snapshot that lists them). Only environments with at least one name, by name.
#[must_use]
pub fn exposure(envs: &[EnvHistory<'_>], removed: &str, held_members_key: bool) -> Vec<Exposure> {
    let mut out: Vec<Exposure> = Vec::new();
    for e in envs {
        let mut names = BTreeSet::new();
        for head in e.heads {
            for (name, v) in &head.vars {
                let seen = e.snapshots.iter().any(|s| {
                    s.vars.get(name).is_some_and(|o| o.value == v.value)
                        && match s.audience {
                            Audience::Members => held_members_key,
                            Audience::Maintainers => s.to.iter().any(|t| t == removed),
                        }
                });
                if seen {
                    names.insert(name.clone());
                }
            }
        }
        if let (false, Some(last)) = (names.is_empty(), e.heads.last()) {
            out.push(Exposure {
                env: e.env.to_owned(),
                audience: last.audience,
                names: names.into_iter().collect(),
            });
        }
    }
    out.sort_by(|a, b| a.env.cmp(&b.env));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn h(label: &str) -> [u8; 32] {
        crate::private::keys::sha256(label.as_bytes())
    }

    fn m(label: &str, owner: &str, at: u64, sup: &[&str]) -> SnapshotRef {
        SnapshotRef {
            id: label.into(),
            owner_id: owner.into(),
            pack_hash: h(label),
            supersedes: sup.iter().map(|s| h(s)).collect(),
            height: at,
        }
    }

    fn run(
        maint: &[&str],
        ms: &[SnapshotRef],
        opened: &[(&str, Option<&'static str>)],
    ) -> Resolution {
        let map: BTreeMap<[u8; 32], Option<&'static str>> =
            opened.iter().map(|(l, e)| (h(l), *e)).collect();
        resolve(&maint.iter().map(|s| (*s).to_owned()).collect(), ms, |p| {
            map.get(p).copied().flatten()
        })
    }

    #[test]
    fn a_fork_is_a_conflict_naming_both_heads() {
        let r = run(
            &["A", "B"],
            &[
                m("s1", "A", 1, &[]),
                m("s2", "A", 2, &["s1"]),
                m("s3", "B", 3, &["s1"]),
            ],
            &[
                ("s1", Some("prod")),
                ("s2", Some("prod")),
                ("s3", Some("prod")),
            ],
        );
        let e = r.env("prod").unwrap();
        assert_eq!(e.state, State::Conflict);
        assert_eq!(e.heads, vec!["s2", "s3"]);
    }

    #[test]
    fn a_writer_can_neither_fork_nor_extend_but_is_reported() {
        let r = run(
            &["A"],
            &[m("s1", "A", 1, &[]), m("w1", "W", 2, &["s1"])],
            &[("s1", Some("prod")), ("w1", Some("prod"))],
        );
        assert_eq!(r.env("prod").unwrap().heads, vec!["s1"]);
        assert_eq!(r.env("prod").unwrap().ignored_newer, vec!["w1"]);
        assert_eq!(r.ignored[0].reason, IgnoredReason::NotAMaintainer);
    }

    #[test]
    fn links_point_strictly_back_in_block_height() {
        let r = run(
            &["A"],
            &[m("s1", "A", 1, &["s2"]), m("s2", "A", 2, &["s1", "s2"])],
            &[("s1", Some("prod")), ("s2", Some("prod"))],
        );
        assert_eq!(r.env("prod").unwrap().heads, vec!["s2"]);
        let r = run(
            &["A"],
            &[m("t1", "A", 5, &["t2"]), m("t2", "A", 5, &["t1"])],
            &[("t1", Some("prod")), ("t2", Some("prod"))],
        );
        assert_eq!(r.env("prod").unwrap().state, State::Conflict);
    }

    #[test]
    fn a_promotion_dry_run_sees_a_dormant_snapshot_take_over() {
        let ms = [m("a0", "A", 1, &[]), m("w0", "W", 2, &["a0"])];
        let opened = [("a0", Some("prod")), ("w0", Some("prod"))];
        let before = run(&["A"], &ms, &opened);
        let after = run(&["A", "W"], &ms, &opened);
        assert_eq!(changed(&before, &after).changed, vec!["prod"]);
        assert!(changed(&before, &before).is_empty());
    }

    #[test]
    fn the_window_names_each_authors_newest_before_filling() {
        let mut snaps: Vec<SnapshotRef> = (0..40)
            .map(|i| m(&format!("c{i}"), "C", 10 + i, &[]))
            .collect();
        snaps.push(m("a0", "A", 1, &[]));
        snaps.push(m("a1", "A", 100, &[]));
        let refs: Vec<&SnapshotRef> = snaps.iter().collect();
        let w = window(&refs, &["a1".into()]);
        assert_eq!(w.len(), MAX_SUPERSEDES);
        assert_eq!(w[0], h("a1"));
        assert_eq!(w[1], h("c39"), "the newest other author next");
        assert!(!w.contains(&h("a0")), "a0's author is already named by a1");
    }

    #[test]
    fn an_unreadable_head_is_never_skipped() {
        let r = run(
            &["A"],
            &[m("s1", "A", 1, &[]), m("s2", "A", 2, &["s1"])],
            &[("s1", Some("prod"))],
        );
        let e = r.env("prod").unwrap();
        assert_eq!(
            (e.state, e.heads.clone()),
            (State::Unreadable, vec!["s2".into()])
        );
    }
}
