//! The publication guard (DESIGN D21, §4.3; S4; `docs/security/private-repos.md` §19.6), as a
//! pure function over an object graph, so the git helper runs it once per push batch before
//! anything is signed, and the vectors run it without git.
//!
//! ```text
//! S := ledger ∪ { every members-only newOid the pusher can decrypt from the fold history }
//!             ∪ { the batch's new members-only tips }
//! for each public ref update (dst, T), T ≠ null:
//!   1. peel T; refuse any members-only tag object in the chain
//!   2. leak = rev-list(T' ^P) \ rev-list(T' ^P ^S); a tree or blob as the target: refuse when
//!      it is in objects(S ^P)
//!   3. dst under refs/notes/*: refuse a note naming a members-only object
//!   4. dst under refs/replace/<X>: refuse when X is members-only
//!   5. a gitlink to a members-only commit, introduced by a commit the ref adds: allowed (it
//!      publishes an id, not content: an oracle only) and noted
//!   6. opt-in (`patch_ids`): a commit the ref adds whose patch id (`git patch-id --stable`)
//!      equals a members-only commit's, re-made with a new id: allowed, and warned about
//! for each sealed ref update (dst, T), members-only or narrower (D21 rev 4, phase 3F):
//!   refuse the commits T adds that only audiences dst is not within hold, minus what an audience
//!   dst is within already held before the batch
//! refuse the whole batch on any finding (E805)
//! ```
//!
//! An audience is within another when its group is no wider (Maintainers ⊂ Writers and
//! maintainers ⊂ All members) and it lists no one the other does not ([`NarrowAudiences`]); a
//! narrower branch whose audience this push does not know is within itself only.
//!
//! Inputs decide completeness (S4 §1b): S is every members-only newOid the pusher can decrypt,
//! not only current tips (a force-pushed-away branch, a stale clone); P must be local (fetch the
//! public lane first, or a missing tip reads as members-only); and the git seam must run every
//! call with `GIT_NO_REPLACE_OBJECTS=1` and `GIT_GRAFT_FILE=/dev/null`, or a local graft hides a
//! members-only parent. Commits re-made with new ids are out of scope: the guard stops accidents,
//! not intent; an opt-in warning ([`GuardInput::patch_ids`], [`Outcome::remade`]) names public
//! commits carrying a members-only commit's changes (S4: about 1 s over 2k members-only commits).
//!
//! **Fail closed.** In a repository with members-only content, the guard cannot run
//! ([`Verdict::Unavailable`], E806) with no key at hand and no ledger, or with a ledger this client
//! cannot read (a later version may record what no key here opens). An empty ledger and no key lets
//! the push through with a note. A gitlink to a members-only commit is allowed (an oracle only)
//! and noted ([`Outcome::gitlinks`]).

use std::cell::OnceCell;
use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use super::ledger::{self, EntryAudience};
use super::plan::BatchRef;
use crate::error::Result;

/// A git object's type.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ObjectType {
    /// A commit.
    Commit,
    /// A tree.
    Tree,
    /// A blob.
    Blob,
    /// An annotated tag.
    Tag,
}

/// What a ref target peels to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Peeled {
    /// The tag objects on the way, outermost first.
    pub tags: Vec<String>,
    /// The object it peels to.
    pub target: String,
    /// That object's type.
    pub kind: ObjectType,
}

/// The object graph the guard asks. The git helper backs it with `git rev-list`, `cat-file` and
/// `ls-tree`, every call under `GIT_NO_REPLACE_OBJECTS=1` and `GIT_GRAFT_FILE=/dev/null`.
pub trait ObjectGraph {
    /// Commits reachable from `include` and from none of `exclude` (`rev-list include ^exclude`).
    fn commits(&self, include: &[String], exclude: &[String]) -> Result<BTreeSet<String>>;
    /// Objects of every type, likewise (`rev-list --objects`).
    fn objects(&self, include: &[String], exclude: &[String]) -> Result<BTreeSet<String>>;
    /// `oid`'s tag chain and what it peels to.
    fn peel(&self, oid: &str) -> Result<Peeled>;
    /// The objects the notes commit `oid` annotates (its note paths, fan-out stripped).
    fn note_targets(&self, oid: &str) -> Result<Vec<String>>;
    /// The gitlinks (submodule entries, which no walk enters) the commits of `include ^exclude`
    /// introduce: an entry of a commit's tree that differs from at least one parent's at its path,
    /// every entry of a root commit (`git log --raw -m`).
    fn gitlinks(&self, include: &[String], exclude: &[String]) -> Result<Vec<Gitlink>>;
    /// The patch id (`git patch-id --stable`) of each of `commits` that has one: merges and
    /// commits that change nothing have none.
    fn patch_ids(&self, commits: &[String]) -> Result<BTreeMap<String, String>>;
}

/// A gitlink a commit introduces.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Gitlink {
    /// The commit whose tree holds it.
    pub commit: String,
    /// Its path.
    pub path: String,
    /// The commit it names.
    pub target: String,
}

/// A public commit a ref update adds that carries the same changes as a members-only commit
/// (equal patch ids): re-made with a new id, so the guard does not see it; warned about when the
/// pusher opted in.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Remade {
    /// The destination ref.
    pub dst: String,
    /// The public commit.
    pub commit: String,
    /// The members-only commit with the same changes (the lowest id when several).
    pub like: String,
}

/// A gitlink naming a members-only commit that a public ref update adds: allowed, and noted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitlinkNote {
    /// The destination ref.
    pub dst: String,
    /// The commit introducing it.
    pub commit: String,
    /// Its path.
    pub path: String,
    /// The members-only commit it names.
    pub target: String,
}

/// What the guard is given.
#[derive(Debug, Clone, Copy)]
pub struct GuardInput<'a> {
    /// The repository has members-only content (a members key exists).
    pub members_key: bool,
    /// The clone's ledger.
    pub ledger: &'a ledger::State,
    /// Every members-only `newOid` the pusher can decrypt from the ref fold's history; `None`
    /// when the key is not at hand.
    pub decryptable: Option<&'a [String]>,
    /// P: the public tips the pusher holds (fetched first).
    pub public_tips: &'a [String],
    /// The push.
    pub batch: &'a [BatchRef],
    /// `-o publish-private=<oid>`: the one tip allowed to publish members-only objects.
    pub publish_private: Option<&'a str>,
    /// Compare the patch ids of the public commits the batch adds with the members-only commits'
    /// (opt-in: `git config dash.patchIdCheck true`).
    pub patch_ids: bool,
    /// Who each narrower branch the pusher holds a key for is for, by ledger token.
    pub audiences: &'a NarrowAudiences,
    /// Every narrower branch's `newOid` the pusher can decrypt, with its branch's ledger token.
    pub decryptable_narrower: &'a [(String, String)],
}

/// A narrower branch's audience as the guard compares it: a group (or none) and people.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NarrowAudience {
    /// The role group, or `None` for people only.
    pub group: Option<crate::env::Group>,
    /// The people added (identity ids, any one spelling per run).
    #[serde(default)]
    pub people: BTreeSet<String>,
}

/// Narrower audiences by ledger token.
pub type NarrowAudiences = BTreeMap<String, NarrowAudience>;

fn group_rank(g: Option<crate::env::Group>) -> u8 {
    use crate::env::Group;
    match g {
        None => 0,
        Some(Group::Maintainers) => 1,
        Some(Group::Writers) => 2,
        Some(Group::Members) => 3,
    }
}

/// Whether everyone `dst` is for may already read what `src` is for (`members` or a narrower
/// branch's token): equal tokens, or both known with `dst`'s group no wider and its people a
/// subset.
fn within(dst: &str, src: &str, audiences: &NarrowAudiences) -> bool {
    if dst == src {
        return true;
    }
    let members = NarrowAudience {
        group: Some(crate::env::Group::Members),
        people: BTreeSet::new(),
    };
    let of = |t: &str| {
        if t == "members" {
            Some(&members)
        } else {
            audiences.get(t)
        }
    };
    match (of(dst), of(src)) {
        (Some(d), Some(s)) => {
            group_rank(d.group) <= group_rank(s.group) && d.people.is_subset(&s.people)
        }
        _ => false,
    }
}

/// The guard's verdict on a batch.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Verdict {
    /// Nothing members-only would be published.
    Pass,
    /// Something would be (E805): refuse the whole batch.
    Refuse,
    /// The guard cannot run (E806).
    Unavailable,
}

/// What a finding is about.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FindingKind {
    /// Members-only commits the ref would add.
    Commits,
    /// A members-only tag object in the target's chain.
    Tag,
    /// A members-only tree or blob as the target.
    Object,
    /// A note naming a members-only object.
    Note,
    /// `refs/replace/<X>` with X members-only.
    Replace,
}

/// One ref's finding: the objects it would publish (sorted).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Finding {
    /// The destination ref.
    pub dst: String,
    /// What it is.
    pub kind: FindingKind,
    /// The objects (hex, sorted).
    pub oids: Vec<String>,
}

/// A note for the pusher.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Note {
    /// No key and an empty ledger: the clone never held members-only objects, so the push
    /// passes; said in one line.
    NoKeyEmptyLedger,
}

/// The guard's result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Outcome {
    /// The verdict.
    pub verdict: Verdict,
    /// What refuses the batch.
    pub findings: Vec<Finding>,
    /// Notes for the pusher.
    pub notes: Vec<Note>,
    /// What `-o publish-private` lets through: a publication, which the helper lists.
    pub published: Vec<Finding>,
    /// Gitlinks naming members-only commits that public updates add (allowed, noted).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub gitlinks: Vec<GitlinkNote>,
    /// Public commits re-made from members-only ones ([`GuardInput::patch_ids`]; a warning).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub remade: Vec<Remade>,
}

/// Run the guard over `g` (see the module documentation).
#[allow(clippy::too_many_lines)] // one pass over the batch, in the module documentation's order
pub fn guard(g: &impl ObjectGraph, input: &GuardInput<'_>) -> Result<Outcome> {
    let ledger = match input.ledger {
        ledger::State::Present(l) => Some(l),
        ledger::State::Absent | ledger::State::Unknown => None,
    };
    // a ledger this reader cannot read may record what no key here opens (a later client's
    // narrower branches, or another dash remote's members-only commits: the ledger is the
    // clone's): fail closed even with the key at hand, in any repository
    let unknown = *input.ledger == ledger::State::Unknown;
    if unknown || (input.members_key && input.decryptable.is_none() && ledger.is_none()) {
        return Ok(Outcome {
            verdict: Verdict::Unavailable,
            findings: Vec::new(),
            notes: Vec::new(),
            published: Vec::new(),
            gitlinks: Vec::new(),
            remade: Vec::new(),
        });
    }
    let mut notes = Vec::new();
    if input.decryptable.is_none() && ledger.is_some_and(ledger::Ledger::is_empty) {
        notes.push(Note::NoKeyEmptyLedger);
    }
    // S, each commit with its narrowest recorded audience
    let mut s: BTreeMap<String, EntryAudience> = BTreeMap::new();
    for (oid, a) in ledger.map(|l| &l.commits).into_iter().flatten() {
        s.insert(oid.clone(), a.clone());
    }
    for oid in input.decryptable.into_iter().flatten() {
        s.entry(oid.clone()).or_insert(EntryAudience::Members);
    }
    for (oid, token) in input.decryptable_narrower {
        let narrow = EntryAudience::Narrower(token.clone());
        let a = s
            .remove(oid)
            .map_or(narrow.clone(), |a| a.narrowest(narrow));
        s.insert(oid.clone(), a);
    }
    // what each audience already holds (recorded or decryptable), before the batch adds its tips
    let before = s.clone();
    // a tip the batch pushes for two audiences counts with the narrower one, whatever the order
    let mut batch_tips: BTreeMap<String, EntryAudience> = BTreeMap::new();
    for u in input.batch {
        if let (Some(t), Some(a)) = (&u.new, u.audience.entry()) {
            let merged = match batch_tips.remove(t) {
                Some(prev) => prev.narrowest(a),
                None => a,
            };
            batch_tips.insert(t.clone(), merged);
        }
    }
    for (t, a) in batch_tips {
        s.entry(t).or_insert(a);
    }
    let all: Vec<String> = s.keys().cloned().collect();
    if all.is_empty() {
        // nothing members-only is known: no ref can publish any (and no git call is needed)
        return Ok(Outcome {
            verdict: Verdict::Pass,
            findings: Vec::new(),
            notes,
            published: Vec::new(),
            gitlinks: Vec::new(),
            remade: Vec::new(),
        });
    }
    let token = |a: &EntryAudience| a.token().unwrap_or("members").to_owned();
    let mut by_audience: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for (oid, a) in &s {
        by_audience.entry(token(a)).or_default().push(oid.clone());
    }
    let mut held_before: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for (oid, a) in &before {
        held_before.entry(token(a)).or_default().push(oid.clone());
    }
    let p = input.public_tips;
    let sealed_objects: OnceCell<BTreeSet<String>> = OnceCell::new();
    let sealed = |oid: &str| -> Result<bool> {
        if all.is_empty() {
            return Ok(false);
        }
        if sealed_objects.get().is_none() {
            let objs = g.objects(&all, p)?;
            let _ = sealed_objects.set(objs);
        }
        Ok(sealed_objects.get().is_some_and(|o| o.contains(oid)))
    };
    // each public update of a commit: its destination, target, the commits it adds and those of
    // them no members-only commit reaches (for the gitlink notes and the patch-id warning)
    let mut public_commits: Vec<(String, String, BTreeSet<String>, BTreeSet<String>)> = Vec::new();
    let mut p_and_s: Vec<String> = p.to_vec();
    p_and_s.extend(all.iter().cloned());
    let mut findings = Vec::new();
    let mut published = Vec::new();
    for u in input.batch {
        let Some(t) = u.new.as_deref() else {
            continue;
        };
        let mut found = Vec::new();
        let mut finding = |kind, oids: Vec<String>| {
            if !oids.is_empty() {
                found.push(Finding {
                    dst: u.dst.clone(),
                    kind,
                    oids,
                });
            }
        };
        if u.audience.is_sealed() {
            let dst = u.audience.as_str();
            let wider: Vec<String> = by_audience
                .iter()
                .filter(|(a, _)| !within(dst, a, input.audiences))
                .flat_map(|(_, xs)| xs.iter().cloned())
                .collect();
            if !wider.is_empty() {
                let adds = g.commits(&[t.to_owned()], p)?;
                let mut only_wider = g.commits(&wider, p)?;
                let covered: Vec<String> = held_before
                    .iter()
                    .filter(|(a, _)| within(dst, a, input.audiences))
                    .flat_map(|(_, xs)| xs.iter().cloned())
                    .collect();
                if !covered.is_empty() {
                    let held = g.commits(&covered, p)?;
                    only_wider.retain(|c| !held.contains(c));
                }
                finding(
                    FindingKind::Commits,
                    adds.intersection(&only_wider).cloned().collect(),
                );
            }
        } else {
            let peeled = g.peel(t)?;
            for tag in &peeled.tags {
                if sealed(tag)? {
                    finding(FindingKind::Tag, vec![tag.clone()]);
                }
            }
            if peeled.kind == ObjectType::Commit {
                if !all.is_empty() {
                    let target = [peeled.target.clone()];
                    let adds = g.commits(&target, p)?;
                    let public_only = g.commits(&target, &p_and_s)?;
                    finding(
                        FindingKind::Commits,
                        adds.difference(&public_only).cloned().collect(),
                    );
                    // the notes are computed once over the whole batch, below
                    public_commits.push((u.dst.clone(), peeled.target.clone(), adds, public_only));
                }
            } else if sealed(&peeled.target)? {
                finding(FindingKind::Object, vec![peeled.target.clone()]);
            }
            if u.dst.starts_with("refs/notes/") && peeled.kind == ObjectType::Commit {
                let mut named = Vec::new();
                for x in g.note_targets(&peeled.target)? {
                    if sealed(&x)? {
                        named.push(x);
                    }
                }
                named.sort();
                named.dedup();
                finding(FindingKind::Note, named);
            }
            if let Some(x) = u.dst.strip_prefix("refs/replace/") {
                if sealed(x)? {
                    finding(FindingKind::Replace, vec![x.to_owned()]);
                }
            }
        }
        if !found.is_empty() && input.publish_private == Some(t) {
            published.extend(found);
        } else {
            findings.extend(found);
        }
    }
    let (gitlinks, remade) = notes_over(g, &all, p, &public_commits, input.patch_ids)?;
    Ok(Outcome {
        verdict: if findings.is_empty() {
            Verdict::Pass
        } else {
            Verdict::Refuse
        },
        findings,
        notes,
        published,
        gitlinks,
        remade,
    })
}

/// The batch's gitlink notes and (when `patch_ids`) re-made commits, over the public updates of a
/// commit (`(dst, target, adds, public_only)` in batch order), with one walk for the whole batch:
/// a gitlink belongs to the commit that introduces it, so a note goes to every update adding
/// that commit; a patch id is the commit's alone.
fn notes_over(
    g: &impl ObjectGraph,
    all: &[String],
    p: &[String],
    public_commits: &[(String, String, BTreeSet<String>, BTreeSet<String>)],
    patch_ids: bool,
) -> Result<(Vec<GitlinkNote>, Vec<Remade>)> {
    let (mut gitlinks, mut remade) = (Vec::new(), Vec::new());
    if public_commits.is_empty() || all.is_empty() {
        return Ok((gitlinks, remade));
    }
    let members_only = g.commits(all, p)?;
    if members_only.is_empty() {
        return Ok((gitlinks, remade));
    }
    let targets: Vec<String> = public_commits.iter().map(|(_, t, ..)| t.clone()).collect();
    let mut links = g.gitlinks(&targets, p)?;
    links.retain(|l| members_only.contains(&l.target));
    links.sort();
    for (dst, _, adds, _) in public_commits {
        gitlinks.extend(
            links
                .iter()
                .filter(|l| adds.contains(&l.commit))
                .map(|l| GitlinkNote {
                    dst: dst.clone(),
                    commit: l.commit.clone(),
                    path: l.path.clone(),
                    target: l.target.clone(),
                }),
        );
    }
    if patch_ids {
        let fresh: BTreeSet<String> = public_commits
            .iter()
            .flat_map(|(.., public_only)| public_only.iter().cloned())
            .collect();
        if !fresh.is_empty() {
            let ids: Vec<String> = members_only.iter().cloned().collect();
            let mut by_patch = BTreeMap::new();
            // lowest id first, so `like` is the lowest when several match
            for (c, pid) in g.patch_ids(&ids)? {
                by_patch.entry(pid).or_insert(c);
            }
            let fresh: Vec<String> = fresh.into_iter().collect();
            let theirs = g.patch_ids(&fresh)?;
            for (dst, _, _, public_only) in public_commits {
                for c in public_only {
                    if let Some(like) = theirs.get(c).and_then(|pid| by_patch.get(pid)) {
                        remade.push(Remade {
                            dst: dst.clone(),
                            commit: c.clone(),
                            like: like.clone(),
                        });
                    }
                }
            }
        }
    }
    Ok((gitlinks, remade))
}
