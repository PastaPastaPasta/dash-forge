//! Environments: per-environment configuration and secrets kept outside git (mixed-visibility
//! design §4.5, D9, D23, D24; phase 1 "Environments lite").
//!
//! An environment (`dev`, `staging`, `production`, any name) holds typed entries. Each change
//! writes a **snapshot** of one whole environment: a `packManifest` of kind 8
//! ([`crate::pack::KIND_ENV_SNAPSHOT`]) whose artifact is the environment as canonical JSON,
//! sealed for its audience. No contract property is added: kind 8 and `supersedes` are plain
//! `packManifest` fields every live contract admits (DESIGN §1, S1 case 16).
//!
//! # The artifact (normative; `env_snapshot__padding`, `env_snapshot__decode_refused`)
//!
//! ```text
//! {"audience":"members"|"maintainers","env":NAME,"generatedAt":MS,["to":[ID,…],]"v":1,
//!  "vars":{VAR:{["note":TEXT,]"type":"secret"|"variable","value":TEXT},…}}
//! ```
//!
//! Canonical JSON: keys sorted, no whitespace, strings as UTF-8 with only `"`, `\`, `\b`, `\f`,
//! `\n`, `\r`, `\t` and `\u00XX` (other controls) escaped; `note` left out when empty; `to` (the
//! recipients in slot order, base58, the writer first) present exactly when the audience is
//! Maintainers. Then spaces (0x20) to the next multiple of 512 bytes ([`format::BUCKET`]), at
//! most [`format::MAX_SNAPSHOT`] bytes, so a snapshot is always one Platform chunk and the public
//! learns only its size in 512-byte steps. A reader takes **only** these exact bytes: it parses,
//! checks every field, re-encodes and compares, so every stack reads the same snapshots.
//!
//! # Sealing (`env_snapshot__members`, `env_snapshot__maintainers_named`)
//!
//! - **Members**: a DFPK 0x01 file under the repository's members key chain (lane 0) at the write
//!   epoch, `K_pack,e,fileId` (`docs/security/private-repos.md` §3).
//! - **Maintainers**: a DFPK 0x02 file (specific-people header, `private-repos.md` §3.7) to the
//!   current maintainers' highest usable ENCRYPTION keys, the writer first.
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
//! The snapshot must agree with its envelope: Members content in a 0x01 file, Maintainers content
//! in a 0x02 file whose `to` lists the owner first and has one entry per slot.
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
//! That environments exist and how many; each change's author, time and padded size; for a
//! Maintainers environment, the recipient count. Never names, values, types or environment names.

pub mod chain;
pub mod codec;
pub mod format;
pub mod service;

#[cfg(test)]
pub(crate) mod conformance;

pub use chain::{
    exposure, resolve, EnvState, Exposure, HiddenEnv, Ignored, Resolution, SnapshotRef,
};
pub use codec::{open, owner_keys, seal_maintainers, seal_members, OpenError, OpenKeys};
pub use format::{Snapshot, Var, VarType};

/// Who can read an environment.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, serde::Serialize, serde::Deserialize,
)]
#[serde(rename_all = "camelCase")]
pub enum Audience {
    /// Every current member holding the repository's members key, and every future one: they
    /// read every value stored here, past values included.
    Members,
    /// The maintainers current when each change was written (a specific-people snapshot).
    Maintainers,
}

impl Audience {
    /// The artifact's spelling (`members`, `maintainers`).
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Members => "members",
            Self::Maintainers => "maintainers",
        }
    }

    /// The product name (`Members`, `Maintainers`), as every user-facing line says it.
    #[must_use]
    pub fn label(self) -> &'static str {
        match self {
            Self::Members => "Members",
            Self::Maintainers => "Maintainers",
        }
    }

    /// Parse the artifact's spelling.
    #[must_use]
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "members" => Some(Self::Members),
            "maintainers" => Some(Self::Maintainers),
            _ => None,
        }
    }
}

/// The one rule for an environment's default audience (owner question 3, security review M2,
/// product review H7): these names, case-insensitively, default to Maintainers; every other
/// name to Members. A trailing `*` matches any rest. Kept in one place so the decision is cheap to
/// change (`env_snapshot__default_audience`).
pub const MAINTAINERS_BY_DEFAULT: &[&str] = &["production", "prod*", "staging", "release*"];

/// The default audience of an environment named `name` ([`MAINTAINERS_BY_DEFAULT`]).
#[must_use]
pub fn default_audience(name: &str) -> Audience {
    let n = name.to_ascii_lowercase();
    let hit = MAINTAINERS_BY_DEFAULT
        .iter()
        .any(|p| match p.strip_suffix('*') {
            Some(prefix) => n.starts_with(prefix),
            None => n == *p,
        });
    if hit {
        Audience::Maintainers
    } else {
        Audience::Members
    }
}

/// The sentence every Members environment carries (DESIGN §10, security review M2).
pub const MEMBERS_SENTENCE: &str = "Readers, CI runners made members, and future members can read every value stored here, including past values.";

/// The sentence every environment carries (DESIGN §4.5, §10).
pub const ACCESS_SENTENCE: &str = "Access is granted, not logged.";

/// At most this many people receive a Maintainers snapshot, the writer included (the
/// specific-people header's limit, [`crate::private::named::MAX_RECIPIENTS`]).
pub const MAX_RECIPIENTS: usize = crate::private::named::MAX_RECIPIENTS;

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
    fn default_audience_follows_the_one_rule() {
        for n in [
            "production",
            "PRODUCTION",
            "prod",
            "prod-eu",
            "staging",
            "release-1.2",
        ] {
            assert_eq!(default_audience(n), Audience::Maintainers, "{n}");
        }
        for n in ["dev", "staging-2", "my-production", "qa", "test"] {
            assert_eq!(default_audience(n), Audience::Members, "{n}");
        }
    }

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
        for s in [MEMBERS_SENTENCE, ACCESS_SENTENCE] {
            for banned in ["sealed", "lane", "named", "restricted", "reveal"] {
                assert!(!s.to_lowercase().contains(banned), "{s}");
            }
        }
    }
}
