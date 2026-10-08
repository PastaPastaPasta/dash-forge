//! Make-public bundles: the plaintext artifact of a `packManifest` of kind 7
//! (`docs/security/private-repos.md` §17.6, §18.3). A bundle lists keys that make sealed content
//! readable to everyone:
//!
//! ```text
//! bundle = "DFRV" ‖ 0x01 ‖ count(u16) ‖ count × entry ‖ note (UTF-8, at most 1 KiB, may be empty)
//! entry  = type(u8) ‖ target(32) ‖ revision(u32) ‖ key(32)                                  (69 B)
//! ```
//!
//! Integers are big-endian. Entry types: 0x01 comment, 0x02 issue, 0x03 review, 0x04 patch (a
//! document's per-object key `K_obj` at `revision`; their reader comes with maintainer bundles,
//! DESIGN phase 2B), **0x06 an epoch key** (`target` = the repository id, `revision` = the epoch,
//! `key` = `K_e`, written by the owner of a repository made public, §18.3), and 0x40 a sealed
//! artifact (`target` = its `packHash`, `revision` 0). Readers skip entry types they do not know.

use super::keys::EpochKey;
use super::PrivateError;

/// `"DFRV"`.
pub const MAGIC: [u8; 4] = *b"DFRV";
/// The bundle layout version.
pub const VERSION: u8 = 0x01;
/// Magic, version and count.
pub const HEADER_LEN: usize = 7;
/// One entry.
pub const ENTRY_LEN: usize = 69;
/// The longest note, in bytes.
pub const MAX_NOTE: usize = 1024;
/// Entry type: an epoch key of a repository made public (§18.3).
pub const ENTRY_EPOCH_KEY: u8 = 0x06;

/// One bundle entry.
#[derive(Clone, PartialEq, Eq)]
pub struct Entry {
    /// The entry type.
    pub kind: u8,
    /// A document `$id`, a `packHash`, or (type 0x06) the repository id.
    pub target: [u8; 32],
    /// A document revision, or (type 0x06) the epoch.
    pub revision: u32,
    /// The key it publishes.
    pub key: EpochKey,
}

impl std::fmt::Debug for Entry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Entry")
            .field("kind", &self.kind)
            .field("target", &hex::encode(self.target))
            .field("revision", &self.revision)
            .finish_non_exhaustive()
    }
}

/// A parsed bundle.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Bundle {
    /// Its entries, in order.
    pub entries: Vec<Entry>,
    /// The writer's note.
    pub note: String,
}

/// Parse a bundle's bytes: magic, version, `count` entries that fit, then a UTF-8 note of at
/// most [`MAX_NOTE`] bytes. Anything else is `Malformed` (the whole bundle is ignored).
pub fn parse(bytes: &[u8]) -> Result<Bundle, PrivateError> {
    if bytes.len() < HEADER_LEN || bytes[..4] != MAGIC || bytes[4] != VERSION {
        return Err(PrivateError::Malformed);
    }
    let count = usize::from(u16::from_be_bytes([bytes[5], bytes[6]]));
    let end = HEADER_LEN + count * ENTRY_LEN;
    let body = bytes.get(HEADER_LEN..end).ok_or(PrivateError::Malformed)?;
    let note = &bytes[end..];
    if note.len() > MAX_NOTE {
        return Err(PrivateError::Malformed);
    }
    let note = std::str::from_utf8(note)
        .map_err(|_| PrivateError::Malformed)?
        .to_string();
    let entries = body
        .as_chunks::<ENTRY_LEN>()
        .0
        .iter()
        .map(|e| Entry {
            kind: e[0],
            target: e[1..33].try_into().expect("32 bytes"),
            revision: u32::from_be_bytes(e[33..37].try_into().expect("4 bytes")),
            key: EpochKey::from_bytes(e[37..69].try_into().expect("32 bytes")),
        })
        .collect();
    Ok(Bundle { entries, note })
}

/// The bytes of a bundle of `entries` with `note`. Refuses more than `u16::MAX` entries or a
/// note over [`MAX_NOTE`] bytes.
pub fn encode(entries: &[Entry], note: &str) -> Result<Vec<u8>, PrivateError> {
    let count = u16::try_from(entries.len()).map_err(|_| PrivateError::Malformed)?;
    if note.len() > MAX_NOTE {
        return Err(PrivateError::Malformed);
    }
    let mut out = Vec::with_capacity(HEADER_LEN + entries.len() * ENTRY_LEN + note.len());
    out.extend_from_slice(&MAGIC);
    out.push(VERSION);
    out.extend_from_slice(&count.to_be_bytes());
    for e in entries {
        out.push(e.kind);
        out.extend_from_slice(&e.target);
        out.extend_from_slice(&e.revision.to_be_bytes());
        out.extend_from_slice(e.key.expose());
    }
    out.extend_from_slice(note.as_bytes());
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(kind: u8, revision: u32) -> Entry {
        Entry {
            kind,
            target: [0x11; 32],
            revision,
            key: EpochKey::from_bytes([revision as u8; 32]),
        }
    }

    #[test]
    fn round_trips_and_refuses_what_does_not_fit() {
        let entries = vec![entry(ENTRY_EPOCH_KEY, 0), entry(ENTRY_EPOCH_KEY, 1)];
        let bytes = encode(&entries, "made public").unwrap();
        assert_eq!(bytes.len(), HEADER_LEN + 2 * ENTRY_LEN + 11);
        let b = parse(&bytes).unwrap();
        assert_eq!(b.entries, entries);
        assert_eq!(b.note, "made public");
        // a count past the bytes, another magic or version, a note that is not UTF-8
        let mut short = bytes.clone();
        short[6] = 3;
        short.truncate(HEADER_LEN + 2 * ENTRY_LEN);
        assert_eq!(parse(&short), Err(PrivateError::Malformed));
        let mut v2 = bytes.clone();
        v2[4] = 2;
        assert_eq!(parse(&v2), Err(PrivateError::Malformed));
        let mut bad = bytes;
        bad.push(0xff);
        assert_eq!(parse(&bad), Err(PrivateError::Malformed));
        assert_eq!(parse(b"DFRV"), Err(PrivateError::Malformed));
        assert_eq!(
            encode(&[], &"x".repeat(MAX_NOTE + 1)),
            Err(PrivateError::Malformed)
        );
    }
}
