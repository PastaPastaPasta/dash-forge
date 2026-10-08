//! Environments: per-environment configuration and secrets kept outside git (mixed-visibility
//! design §4.5, D9, D24, D34; phase 1 "Environments lite", phase R "environments without
//! defaults").
//!
//! An environment (`dev`, `staging`, `production`, any name) holds typed entries. Each change
//! writes a **snapshot** of one whole environment: a `packManifest` of kind 8
//! ([`crate::pack::KIND_ENV_SNAPSHOT`]) whose artifact is the environment as canonical JSON,
//! a letter to its audience's people. No contract property is added: kind 8 and `supersedes` are plain
//! `packManifest` fields every live contract admits (DESIGN §1, S1 case 16).
//!
//! # The artifact (normative; `env_snapshot__v2_*`, `env_snapshot__padding`, `env_snapshot__decode_refused`)
//!
//! Version 2, what every writer makes (revision 4, D9, D34):
//!
//! ```text
//! {"audience":{"also":[ID,…],"group":"maintainers"|"writers"|"members"|null},"env":NAME,
//!  "generatedAt":MS,"id":HEX32,["markedChanged":[VAR,…],]["savedFor":ID,]"to":[ID,…],
//!  "toKeys":[KEYID,…],"v":2,"vars":{VAR:{["note":TEXT,]"type":"secret"|"variable","value":TEXT},…}}
//! ```
//!
//! - `audience`: who the environment is for. `group` resolves at write time from the member
//!   documents ([`Group`]); null is Specific people. `also` (base58, ascending, at most 64) names
//!   people added to the group, or the people of a Specific-people environment; null needs one.
//! - `id`: 16 random bytes (32 lowercase hex digits) drawn at the environment's first save and
//!   kept by every later one, so the web and access notices can name an environment without its
//!   name.
//! - `to`: the recipients in slot order, the writer first, then the people the audience resolved
//!   to (1 to [`MAX_RECIPIENTS`]); `toKeys`: the ENCRYPTION key id each slot was sealed to, so a
//!   maintainer's client sees a recipient whose key changed since (D27).
//! - `markedChanged` (left out when empty): names whose values held in old-format snapshots were
//!   changed at their source (`dg env mark-changed`), carried forward by every save.
//!
//! Version 1 (phase 1) stays readable and is never written: `{"audience":"members"|"maintainers",
//! "env","generatedAt",["to",]"v":1,"vars"}`, a Members snapshot under the members key (the old
//! format) or a Maintainers letter to at most 16 people. It reads as the group of the same name.
//!
//! Canonical JSON: keys sorted, no whitespace, strings as UTF-8 with only `"`, `\`, `\b`, `\f`,
//! `\n`, `\r`, `\t` and `\u00XX` (other controls) escaped; `note` left out when empty. Then spaces
//! (0x20) to the next multiple of 512 bytes ([`format::BUCKET`]), at most
//! [`format::MAX_SNAPSHOT`] bytes, so the public learns only its size in 512-byte steps. A reader
//! takes **only** these exact bytes: it parses, checks every field, re-encodes and compares, so
//! every stack reads the same snapshots.
//!
//! # Sealing (`env_snapshot__v2_*`; the old `env_snapshot__members`)
//!
//! Every snapshot is a DFPK 0x02 file (specific-people header, `private-repos.md` §3.7) to the
//! people its audience resolves to, each at their highest usable ENCRYPTION key, the writer first:
//! never the members key, so the exposure list is exactly `to` and a joiner reads current values,
//! never past ones. A sealed snapshot is one Platform chunk; a large environment for many people
//! that would not fit is refused before signing. The phase-1 Members form (a DFPK 0x01 file
//! under the members key) is read only.
//!
//! `supersedes` names the `packHash` of the snapshot(s) this one replaces: one, or every head of
//! a fork it resolves; none for an environment's first snapshot.
//!
//! # Reading (D24; `env_snapshot__sender_not_owner`, `env_snapshot__pack_hash_mismatch`)
//!
//! A snapshot counts only when its manifest's `$ownerId` is a **current maintainer**; consensus
//! admits a `packManifest` from any role-1 writer, so this is a client rule (security review
//! H5), applied by people and runners alike ([`chain::resolve`]). Nothing else about a manifest
//! by anyone else is used: not its values, not its links. A removed or demoted maintainer's
//! snapshots stop counting the moment their role ends, which is why `dg collab remove` saves
//! their environments again (after showing what changed) and why every snapshot names the
//! environment's recent counted chain in `supersedes`, not only its head. When an ignored
//! manifest names an environment's head from a higher block, readers say so in one line and keep
//! using the counted head. An authorized artifact is
//! fetched, checked against the owner-signed manifest's `packHash` **before** it is opened (a
//! DFPK 0x02 header alone proves only that some key holder wrote it), and a 0x02 artifact is
//! opened with the sender key taken from that manifest owner's identity only ([`codec::open`]).
//! The snapshot must agree with its envelope: an old-format Members snapshot in a 0x01 file, any
//! other in a 0x02 file whose `to` lists the owner first and has one entry per slot.
//!
//! # The chain and forks (`env_snapshot__chain_*`)
//!
//! [`chain::resolve`] groups the authorized snapshots into environments and finds each one's
//! heads, the snapshots no other snapshot of it supersedes (links count only between counted
//! snapshots and strictly back in block height). One readable head is the current
//! state; one unreadable head means the latest change is not readable here, and values are never
//! served from an older snapshot; two or more heads are a conflict, shown to people with both
//! heads and refused by `dg env run`, `get` and `export` (fail closed), never merged
//! automatically. A maintainer resolves it by writing a snapshot that supersedes every head.
//!
//! # What stays public
//!
//! That environments exist and how many; each change's author, time and padded size; the
//! recipient count of each letter. Never names, values, types, environment names or audiences.

pub mod chain;
pub mod codec;
pub mod format;
pub mod service;

#[cfg(test)]
pub(crate) mod conformance;

pub use chain::{
    exposure, resolve, EnvState, Exposure, HiddenEnv, Ignored, Resolution, SnapshotRef, State,
};
pub use codec::{open, owner_keys, seal_letter, OpenError, OpenKeys};
pub use format::{Snapshot, Var, VarType};

/// A role group an environment can be for (DESIGN §2.1, D2). Groups resolve at write time from
/// the member documents, and never include bots.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, serde::Serialize, serde::Deserialize,
)]
#[serde(rename_all = "camelCase")]
pub enum Group {
    /// The owner and maintainers.
    Maintainers,
    /// The owner, maintainers and role-1 writers.
    Writers,
    /// Every human member role: maintainers, writers, triage members and readers.
    Members,
}

impl Group {
    /// The artifact's spelling (`maintainers`, `writers`, `members`).
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Maintainers => "maintainers",
            Self::Writers => "writers",
            Self::Members => "members",
        }
    }

    /// The product name, as every user-facing line says it (DESIGN §10).
    #[must_use]
    pub fn label(self) -> &'static str {
        match self {
            Self::Maintainers => "Maintainers",
            Self::Writers => "Writers and maintainers",
            Self::Members => "All members",
        }
    }

    /// Parse the artifact's spelling.
    #[must_use]
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "maintainers" => Some(Self::Maintainers),
            "writers" => Some(Self::Writers),
            "members" => Some(Self::Members),
            _ => None,
        }
    }

    /// Whether a member with `role` is in this group.
    #[must_use]
    pub fn includes(self, role: crate::rules::v2::Role) -> bool {
        use crate::rules::v2::Role;
        match self {
            Self::Maintainers => role == Role::Maintainer,
            Self::Writers => matches!(role, Role::Maintainer | Role::Writer),
            Self::Members => true,
        }
    }
}

/// Who can read an environment: a group, a group plus people, or specific people (`group`
/// `None`). There is no default (owner answer 3): every environment is created with one.
#[derive(Debug, Clone, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Audience {
    /// The role group, or `None` for Specific people.
    pub group: Option<Group>,
    /// People added to the group, or the people of a Specific-people environment (base58,
    /// ascending, none twice).
    pub also: Vec<String>,
}

impl Audience {
    /// A group with nobody added.
    #[must_use]
    pub fn group(group: Group) -> Self {
        Self {
            group: Some(group),
            also: Vec::new(),
        }
    }

    /// `group` (or Specific people) plus `also`, sorted and without repeats.
    #[must_use]
    pub fn new(group: Option<Group>, also: impl IntoIterator<Item = String>) -> Self {
        let also: std::collections::BTreeSet<String> = also.into_iter().collect();
        Self {
            group,
            also: also.into_iter().collect(),
        }
    }

    /// How a person is told: "Maintainers", "Writers and maintainers + 1 more",
    /// "Specific people (3)".
    #[must_use]
    pub fn label(&self) -> String {
        match (self.group, self.also.len()) {
            (Some(g), 0) => g.label().to_owned(),
            (Some(g), n) => format!("{} + {n} more", g.label()),
            (None, n) => format!("Specific people ({n})"),
        }
    }
}

/// What every snapshot of an old-format Members environment carries (DESIGN §10): its values
/// are readable by anyone who joins later.
pub const OLD_FORMAT_SENTENCE: &str = "Saved in the old format: anyone who joins later can read the values saved this way. Save it again, then change those values where they're used.";

/// The same, once the latest version is saved again but earlier ones are still in the old
/// format and their values are not all marked changed.
pub const OLD_FORMAT_HISTORY_SENTENCE: &str = "Earlier versions were saved in the old format: anyone who joins later can read the values saved that way. Change them where they're used, then mark them changed.";

/// The sentence every environment carries (DESIGN §4.5, §10).
pub const ACCESS_SENTENCE: &str = "Access is granted, not logged.";

/// At most this many people receive a snapshot, the writer included (the artifact letter's
/// limit, [`crate::private::named::MAX_ARTIFACT_RECIPIENTS`]).
pub const MAX_RECIPIENTS: usize = crate::private::named::MAX_ARTIFACT_RECIPIENTS;

/// A version-1 Maintainers snapshot went to at most this many people (the letter limit of
/// phase 1).
pub const MAX_RECIPIENTS_V1: usize = crate::private::named::MAX_RECIPIENTS;

/// Whether `name` is a valid environment name: 1 to 64 of `A-Z a-z 0-9 . _ -`, starting with a
/// letter or digit.
#[must_use]
pub fn valid_env_name(name: &str) -> bool {
    let b = name.as_bytes();
    (1..=64).contains(&b.len())
        && b[0].is_ascii_alphanumeric()
        && b.iter()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-'))
}

/// Whether `name` is a valid variable name: 1 to 128 of `A-Z a-z 0-9 _`, not starting with a
/// digit (what a shell and a `.env` file take).
#[must_use]
pub fn valid_var_name(name: &str) -> bool {
    let b = name.as_bytes();
    (1..=128).contains(&b.len())
        && (b[0].is_ascii_alphabetic() || b[0] == b'_')
        && b.iter().all(|c| c.is_ascii_alphanumeric() || *c == b'_')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names() {
        assert!(valid_env_name("prod-eu.1_a"));
        assert!(!valid_env_name("-dev"));
        assert!(!valid_env_name(""));
        assert!(!valid_env_name(&"a".repeat(65)));
        assert!(!valid_env_name("dév"));
        assert!(valid_var_name("_A1"));
        assert!(!valid_var_name("1A"));
        assert!(!valid_var_name("A-B"));
        assert!(!valid_var_name(&"A".repeat(129)));
    }

    #[test]
    fn copy_uses_the_glossary() {
        for s in [OLD_FORMAT_SENTENCE, OLD_FORMAT_HISTORY_SENTENCE, ACCESS_SENTENCE] {
            for banned in ["sealed", "lane", "named", "restricted", "reveal"] {
                assert!(!s.to_lowercase().contains(banned), "{s}");
            }
        }
    }
}
