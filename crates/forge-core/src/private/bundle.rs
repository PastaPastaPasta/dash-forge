//! Make-public bundles: the plaintext artifact of a `packManifest` of kind 7
//! (`docs/security/private-repos.md` §17.6, §18.3). A bundle lists keys that make sealed content
//! readable to everyone:
//!
//! ```text
//! bundle = "DFRV" ‖ 0x01 ‖ count(u16) ‖ count × entry ‖ note (UTF-8, at most 1 KiB, may be empty)
//! entry  = type(u8) ‖ target(32) ‖ revision(u32) ‖ key(32)                                  (69 B)
//! ```
//!
//! Integers are big-endian. Entry types: **0x01 comment, 0x02 issue, 0x03 review** (a
//! document's per-object key `K_obj` at its `$revision`: a maintainer's bundle, DESIGN §4.6),
//! 0x04 patch (reserved for members-only PRs, phase 3), **0x06 an epoch key** (`target` = the
//! repository id, `revision` = the epoch, `key` = `K_e`, written by the owner of a repository
//! made public, §18.3), and 0x40 a sealed artifact (`target` = its `packHash`, `revision` 0).
//! Readers skip entry types they do not know.
//!
//! **Maintainer bundles** ([`DocEntries`], [`read_revision`]): readers honour a document entry
//! only in a public repository, only from a current maintainer (the repository's owner
//! included; anyone else's bundle is ignored, and consensus refuses it on mainnet, C3), and only
//! when its key commits to the document revision it names: `K_obj` is bound to the document's
//! AD, so it opens that revision and nothing else, and a key that does not commit is a lying
//! entry, raised as an alert and ignored.

use std::collections::{BTreeMap, BTreeSet};

use super::convert::PublishedBundle;
use super::doc::{self, DocHeader, Opened, Unreadable};
use super::keys::EpochKey;
use super::tlv::Fields;
use super::{DocKind, PrivateError};

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
/// Entry type: a comment revision's `K_obj`.
pub const ENTRY_COMMENT: u8 = 0x01;
/// Entry type: an issue revision's `K_obj`.
pub const ENTRY_ISSUE: u8 = 0x02;
/// Entry type: a review's `K_obj`.
pub const ENTRY_REVIEW: u8 = 0x03;
/// The most document entries one maintainer's bundle carries (a whole thread with its edit
/// history; about 200 fit one Platform chunk).
pub const MAX_DOC_ENTRIES: usize = 1000;

/// The entry type of a `kind` document revision, for the kinds a bundle publishes.
#[must_use]
pub fn entry_kind(kind: DocKind) -> Option<u8> {
    match kind {
        DocKind::Comment => Some(ENTRY_COMMENT),
        DocKind::Issue => Some(ENTRY_ISSUE),
        DocKind::Review => Some(ENTRY_REVIEW),
        _ => None,
    }
}

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

/// One document entry a reader honours: the maintainer who published it, the revision and its
/// key.
#[derive(Clone, PartialEq, Eq)]
pub struct DocEntry {
    /// The bundle's author (its manifest's `$ownerId`), a current maintainer.
    pub by: [u8; 32],
    /// The document revision (`$revision`) it publishes.
    pub revision: u32,
    /// `K_obj` of that revision.
    pub key: EpochKey,
}

impl std::fmt::Debug for DocEntry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DocEntry")
            .field("by", &hex::encode(self.by))
            .field("revision", &self.revision)
            .finish_non_exhaustive()
    }
}

/// The document entries of a repository's make-public bundles that readers honour (module
/// docs), by entry type and document id, in bundle and entry order.
#[derive(Debug, Clone, Default)]
pub struct DocEntries {
    by_target: BTreeMap<(u8, [u8; 32]), Vec<DocEntry>>,
}

impl DocEntries {
    /// The honoured document entries of `bundles`: none in a private repository (`public`
    /// false); else every entry of a comment, issue or review in a bundle that parses, written
    /// by one of `maintainers` (the repository's owner and its current maintainers).
    #[must_use]
    pub fn of(public: bool, maintainers: &BTreeSet<[u8; 32]>, bundles: &[PublishedBundle]) -> Self {
        let mut out = Self::default();
        if !public {
            return out;
        }
        for b in bundles.iter().filter(|b| maintainers.contains(&b.owner)) {
            let Ok(parsed) = parse(&b.bytes) else {
                continue;
            };
            for e in parsed
                .entries
                .into_iter()
                .filter(|e| matches!(e.kind, ENTRY_COMMENT | ENTRY_ISSUE | ENTRY_REVIEW))
            {
                out.by_target
                    .entry((e.kind, e.target))
                    .or_default()
                    .push(DocEntry {
                        by: b.owner,
                        revision: e.revision,
                        key: e.key,
                    });
            }
        }
        out
    }

    /// Whether no entry is honoured.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.by_target.is_empty()
    }

    /// The honoured entries of the `kind` document `id`.
    #[must_use]
    pub fn of_doc(&self, kind: DocKind, id: &[u8; 32]) -> &[DocEntry] {
        entry_kind(kind)
            .and_then(|k| self.by_target.get(&(k, *id)))
            .map_or(&[], Vec::as_slice)
    }
}

/// What the honoured entries do to one revision of a sealed document.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BundleRead {
    /// It is public: an entry's key opened it.
    Public {
        /// The maintainer whose bundle published it.
        by: [u8; 32],
        /// Its content.
        fields: Box<Fields>,
    },
    /// No entry opens this revision, but `by` published an earlier one (`revision`): its author
    /// sealed it again after it was made public (DESIGN §4.6, "edited after it was made public").
    EditedAfter {
        /// The maintainer whose bundle published the earlier revision.
        by: [u8; 32],
        /// The newest earlier revision an entry names.
        revision: u32,
    },
    /// No entry names it.
    None,
}

/// A bundle entry whose key does not commit to the revision it names: a lying entry, ignored.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct EntryMismatch {
    /// The bundle's author.
    pub by: [u8; 32],
    /// The revision it named.
    pub revision: u32,
}

/// Open revision `revision` of the sealed document `header` (with `enc`) of repository
/// `repo_id` through its honoured `entries` ([`DocEntries::of_doc`]): the first entry naming this
/// revision whose key commits and opens it makes it [`BundleRead::Public`]; an entry whose key
/// does not commit is an [`EntryMismatch`] and is ignored, as is one whose key commits to a
/// document that does not open (it is malformed whatever the key). Members-only (`enc` v0x03) and
/// letter (`enc` v0x04) documents both open this way.
#[must_use]
pub fn read_revision(
    repo_id: &[u8; 32],
    header: &DocHeader,
    revision: u32,
    enc: &[u8],
    entries: &[DocEntry],
) -> (BundleRead, Vec<EntryMismatch>) {
    let mut mismatches = Vec::new();
    for e in entries.iter().filter(|e| e.revision == revision) {
        let opened = match enc.first() {
            Some(&doc::V3) => doc::open_members_with_key(repo_id, header, enc, e.key.expose()),
            Some(&doc::V4) => super::named::open_with_key(repo_id, header, enc, e.key.expose()),
            _ => Opened::Malformed,
        };
        match opened {
            Opened::Readable(fields) => {
                return (BundleRead::Public { by: e.by, fields }, mismatches);
            }
            Opened::Unreadable(Unreadable::CommitMismatch) => {
                mismatches.push(EntryMismatch { by: e.by, revision })
            }
            _ => {}
        }
    }
    let earlier = entries
        .iter()
        .filter(|e| e.revision < revision)
        .max_by_key(|e| e.revision);
    let read = earlier.map_or(BundleRead::None, |e| BundleRead::EditedAfter {
        by: e.by,
        revision: e.revision,
    });
    (read, mismatches)
}

/// The bytes of a maintainer's bundle publishing `entries` (`(kind, target, revision, K_obj)`),
/// with no note. Refuses an empty bundle or more than [`MAX_DOC_ENTRIES`] entries.
pub fn encode_doc_bundle(
    entries: &[(u8, [u8; 32], u32, EpochKey)],
) -> Result<Vec<u8>, PrivateError> {
    if entries.is_empty() || entries.len() > MAX_DOC_ENTRIES {
        return Err(PrivateError::Malformed);
    }
    let entries: Vec<Entry> = entries
        .iter()
        .map(|(kind, target, revision, key)| Entry {
            kind: *kind,
            target: *target,
            revision: *revision,
            key: key.clone(),
        })
        .collect();
    encode(&entries, "")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(kind: u8, revision: u32) -> Entry {
        Entry {
            kind,
            target: [0x11; 32],
            revision,
            key: EpochKey::from_bytes([u8::try_from(revision).unwrap(); 32]),
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
