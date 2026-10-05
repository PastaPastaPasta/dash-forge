//! Authorization, the snapshot chain and fork detection (D24), and the removal checklist: pure
//! functions over manifests and what opened, shared with forge-web through the
//! `env_snapshot__*` vectors.
//!
//! [`resolve`], step by step:
//!
//! 1. Manifests in `($createdAt, $id)` order. One whose `$ownerId` is not a current maintainer is
//!    ignored (`notAMaintainer`); its `supersedes` is kept only as a link to follow (below). A
//!    second manifest of an authorized `packHash` is ignored (`duplicate`).
//! 2. A snapshot `t` supersedes `s` when `t.supersedes` names `s`, directly or through ignored
//!    manifests (so a removed maintainer's change in the middle of a chain does not split it; a
//!    non-maintainer's manifest can never end a chain, since nothing authorized names it). A
//!    snapshot naming itself is skipped. A link between two readable snapshots of different
//!    environments does not count.
//! 3. Snapshots linked this way form components. A component belongs to every environment
//!    one of its readable snapshots names; its unreadable snapshots go with it. A component with
//!    no readable snapshot is a hidden environment (counted, never named).
//! 4. An environment's heads are its snapshots no other of its snapshots supersedes, oldest
//!    first. One readable head: `current`. One unreadable head: `unreadable` (the latest change
//!    does not open here; nothing older is served). Two or more: `conflict`. None (a cycle):
//!    `conflict` listing every snapshot.

use std::collections::{BTreeMap, BTreeSet, VecDeque};

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
    /// `$createdAt` (ms).
    pub created_at: u64,
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
    /// Two or more heads (or a cycle): people pick; programs refuse.
    Conflict,
}

/// One environment this reader can name.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct EnvState {
    /// Its name.
    pub env: String,
    /// Current, unreadable or conflict.
    pub state: State,
    /// The heads' document ids, oldest first.
    pub heads: Vec<String>,
    /// Every snapshot's document id, oldest first.
    pub snapshots: Vec<String>,
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
    /// Manifests that do not count, in `($createdAt, $id)` order.
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
/// `env_of(packHash)`: the environment an authorized snapshot opened to, `None` when it did not
/// open for this reader. See the module docs for the steps.
#[must_use]
pub fn resolve<'a>(
    maintainers: &BTreeSet<String>,
    manifests: &[SnapshotRef],
    env_of: impl Fn(&[u8; 32]) -> Option<&'a str>,
) -> Resolution {
    let mut order: Vec<&SnapshotRef> = manifests.iter().collect();
    order.sort_by(|a, b| (a.created_at, &a.id).cmp(&(b.created_at, &b.id)));
    let mut nodes: BTreeMap<[u8; 32], &SnapshotRef> = BTreeMap::new();
    let mut passthrough: BTreeMap<[u8; 32], Vec<[u8; 32]>> = BTreeMap::new();
    let mut ignored = Vec::new();
    for m in order {
        let reason = if !maintainers.contains(&m.owner_id) {
            passthrough
                .entry(m.pack_hash)
                .or_default()
                .extend(m.supersedes.iter().copied());
            IgnoredReason::NotAMaintainer
        } else if nodes.contains_key(&m.pack_hash) {
            IgnoredReason::Duplicate
        } else {
            nodes.insert(m.pack_hash, m);
            continue;
        };
        ignored.push(Ignored {
            id: m.id.clone(),
            reason,
        });
    }

    let targets = |t: &SnapshotRef| -> Vec<[u8; 32]> {
        let mut out = Vec::new();
        let mut seen = BTreeSet::from([t.pack_hash]);
        let mut todo: VecDeque<[u8; 32]> = t.supersedes.iter().copied().collect();
        while let Some(h) = todo.pop_front() {
            if !seen.insert(h) {
                continue;
            }
            if nodes.contains_key(&h) {
                out.push(h);
            } else if let Some(next) = passthrough.get(&h) {
                todo.extend(next.iter().copied());
            }
        }
        out
    };
    let mut edges: BTreeSet<([u8; 32], [u8; 32])> = BTreeSet::new();
    for (h, t) in &nodes {
        for s in targets(t) {
            if let (Some(a), Some(b)) = (env_of(h), env_of(&s)) {
                if a != b {
                    continue;
                }
            }
            edges.insert((*h, s));
        }
    }

    // components (union-find, the smaller hash as the root)
    let mut parent: BTreeMap<[u8; 32], [u8; 32]> = nodes.keys().map(|h| (*h, *h)).collect();
    fn find(parent: &mut BTreeMap<[u8; 32], [u8; 32]>, mut x: [u8; 32]) -> [u8; 32] {
        while parent[&x] != x {
            let up = parent[&parent[&x]];
            parent.insert(x, up);
            x = up;
        }
        x
    }
    for (a, b) in &edges {
        let (ra, rb) = (find(&mut parent, *a), find(&mut parent, *b));
        if ra != rb {
            parent.insert(ra.max(rb), ra.min(rb));
        }
    }
    let mut comps: BTreeMap<[u8; 32], Vec<[u8; 32]>> = BTreeMap::new();
    for h in nodes.keys() {
        let r = find(&mut parent, *h);
        comps.entry(r).or_default().push(*h);
    }

    let key = |h: &[u8; 32]| (nodes[h].created_at, nodes[h].id.clone());
    let sorted = |set: &mut Vec<[u8; 32]>| set.sort_by_key(|h| key(h));
    let ids = |hs: &[[u8; 32]]| -> Vec<String> { hs.iter().map(|h| nodes[h].id.clone()).collect() };
    // the heads of `group`, and whether it has any (else every snapshot, a cycle)
    let heads_of = |group: &BTreeSet<[u8; 32]>| -> (Vec<[u8; 32]>, bool) {
        let mut heads: Vec<[u8; 32]> = group
            .iter()
            .filter(|n| !group.iter().any(|t| edges.contains(&(*t, **n))))
            .copied()
            .collect();
        let any = !heads.is_empty();
        if !any {
            heads = group.iter().copied().collect();
        }
        sorted(&mut heads);
        (heads, any)
    };

    let mut envs: BTreeMap<String, BTreeSet<[u8; 32]>> = BTreeMap::new();
    let mut hidden: Vec<Vec<[u8; 32]>> = Vec::new();
    for members in comps.values() {
        let names: BTreeSet<&str> = members.iter().filter_map(|h| env_of(h)).collect();
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
            let (heads, any) = heads_of(&group);
            let state = match heads.as_slice() {
                [one] if any => {
                    if env_of(one).is_some() {
                        State::Current
                    } else {
                        State::Unreadable
                    }
                }
                _ => State::Conflict,
            };
            let mut all: Vec<[u8; 32]> = group.into_iter().collect();
            sorted(&mut all);
            EnvState {
                env,
                state,
                heads: ids(&heads),
                snapshots: ids(&all),
            }
        })
        .collect();
    hidden.sort_by_key(|g| g.iter().map(|h| key(h)).min());
    let hidden = hidden
        .into_iter()
        .map(|g| {
            let set: BTreeSet<[u8; 32]> = g.iter().copied().collect();
            let (heads, _) = heads_of(&set);
            let mut all = g;
            sorted(&mut all);
            HiddenEnv {
                heads: ids(&heads),
                snapshots: ids(&all),
            }
        })
        .collect();
    Resolution {
        ignored,
        environments,
        hidden,
    }
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
            created_at: at,
        }
    }

    fn run(maint: &[&str], ms: &[SnapshotRef], opened: &[(&str, Option<&'static str>)]) -> Resolution {
        let map: BTreeMap<[u8; 32], Option<&'static str>> =
            opened.iter().map(|(l, e)| (h(l), *e)).collect();
        resolve(
            &maint.iter().map(|s| (*s).to_owned()).collect(),
            ms,
            |p| map.get(p).copied().flatten(),
        )
    }

    #[test]
    fn a_fork_is_a_conflict_naming_both_heads() {
        let r = run(
            &["A", "B"],
            &[m("s1", "A", 1, &[]), m("s2", "A", 2, &["s1"]), m("s3", "B", 3, &["s1"])],
            &[("s1", Some("prod")), ("s2", Some("prod")), ("s3", Some("prod"))],
        );
        let e = r.env("prod").unwrap();
        assert_eq!(e.state, State::Conflict);
        assert_eq!(e.heads, vec!["s2", "s3"]);
    }

    #[test]
    fn a_writer_can_neither_fork_nor_extend() {
        let r = run(
            &["A"],
            &[m("s1", "A", 1, &[]), m("w1", "W", 2, &["s1"])],
            &[("s1", Some("prod")), ("w1", Some("prod"))],
        );
        assert_eq!(r.env("prod").unwrap().heads, vec!["s1"]);
        assert_eq!(r.ignored[0].reason, IgnoredReason::NotAMaintainer);
    }

    #[test]
    fn an_unreadable_head_is_never_skipped() {
        let r = run(
            &["A"],
            &[m("s1", "A", 1, &[]), m("s2", "A", 2, &["s1"])],
            &[("s1", Some("prod"))],
        );
        let e = r.env("prod").unwrap();
        assert_eq!((e.state, e.heads.clone()), (State::Unreadable, vec!["s2".into()]));
    }
}
