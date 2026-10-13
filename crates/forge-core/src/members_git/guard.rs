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
//! for each members-only ref update (dst, T): refuse commits recorded with a narrower audience
//!   (D21 rev 4; nothing narrower exists before phase 3F)
//! refuse the whole batch on any finding (E805)
//! ```
//!
//! Inputs decide completeness (S4 §1b): S is every members-only newOid the pusher can decrypt,
//! not only current tips (a force-pushed-away branch, a stale clone); P must be local (fetch the
//! public lane first, or a missing tip reads as members-only); and the git seam must run every
//! call with `GIT_NO_REPLACE_OBJECTS=1` and `GIT_GRAFT_FILE=/dev/null`, or a local graft hides a
//! members-only parent. Commits re-made with new ids are out of scope (an opt-in `patch-id`
//! warning, S4).
//!
//! **Fail closed.** In a repository with members-only content, the guard cannot run
//! ([`Verdict::Unavailable`], E806) with no key at hand and no ledger, or with a ledger this client
//! cannot read (a later version may record what no key here opens). An empty ledger and no key lets
//! the push through with a note. A gitlink to a members-only commit is allowed (an oracle only)
//! and left to the helper's notes.

use std::cell::OnceCell;
use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use super::ledger::{self, EntryAudience};
use super::plan::BatchRef;
use super::Audience;
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
    // what is already members-only (recorded or decryptable), before the batch adds its tips:
    // a narrower branch's commits that are also members-only are not narrower
    let established: Vec<String> = s
        .iter()
        .filter(|(_, a)| **a == EntryAudience::Members)
        .map(|(o, _)| o.clone())
        .collect();
    for u in input
        .batch
        .iter()
        .filter(|u| u.audience == Audience::Members)
    {
        if let Some(t) = &u.new {
            s.entry(t.clone()).or_insert(EntryAudience::Members);
        }
    }
    let all: Vec<String> = s.keys().cloned().collect();
    let narrow: Vec<String> = s
        .iter()
        .filter(|(_, a)| **a != EntryAudience::Members)
        .map(|(o, _)| o.clone())
        .collect();
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
        if u.audience == Audience::Members {
            if !narrow.is_empty() {
                let adds = g.commits(&[t.to_owned()], p)?;
                let mut narrower = g.commits(&narrow, p)?;
                if !established.is_empty() {
                    let members = g.commits(&established, p)?;
                    narrower.retain(|c| !members.contains(c));
                }
                finding(
                    FindingKind::Commits,
                    adds.intersection(&narrower).cloned().collect(),
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
    Ok(Outcome {
        verdict: if findings.is_empty() {
            Verdict::Pass
        } else {
            Verdict::Refuse
        },
        findings,
        notes,
        published,
    })
}
