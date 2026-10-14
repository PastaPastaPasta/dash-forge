//! The members-only object locator (`packManifest.kind == 65`, mixed-visibility DESIGN §4.3
//! "Packs (D22)", `docs/security/private-repos.md` §19.5): the browse index of ONE members-only
//! git pack (kind 64), so a member's browser range-reads that pack's objects instead of fetching
//! and indexing it whole.
//!
//! A sealed kind carries no `tips` (a members-only index's tips would be the real commits its
//! blinds hide), and one members-only branch's pack is never another's (D22), so the artifact
//! names the pack it indexes inside its sealed plaintext:
//!
//! ```text
//! plaintext = "DFML" ‖ version 0x01 ‖ packHash(32, the kind-64 pack's) ‖ objectLocator
//! ```
//!
//! The `objectLocator` is the kind-1 layout ([`super::locator`]) with every row at `packRef` 0,
//! the pack named in the header. It is sealed as DFPK `0x01` under the members key's write epoch,
//! like its pack. Readers trust it only from the pack's own uploader and only when it indexes
//! every object of the pack; otherwise they index the pack themselves. Only kind 65 is written:
//! the flat and history indexes (kinds 66, 67, 69) are read for a repository's default branch,
//! which is always public, and members-only release assets (68) wait for members-only releases.

use super::locator::ObjectLocator;
use crate::error::{Error, Result};

/// `"DFML"`.
pub const MAGIC: [u8; 4] = *b"DFML";
/// The layout version this client writes and reads.
pub const VERSION: u8 = 0x01;
/// Magic, version and the pack hash.
pub const HEADER_LEN: usize = 4 + 1 + 32;

/// A members-only object locator: the pack it indexes and the locator, every row at `packRef` 0.
#[derive(Debug)]
pub struct MembersIndex {
    /// The `packHash` of the kind-64 pack it indexes.
    pub pack_hash: [u8; 32],
    /// Its rows, all at `packRef` 0.
    pub locator: ObjectLocator,
}

/// The plaintext of the members-only index of pack `pack_hash` (`locator` built at `packRef` 0).
/// Refuses a locator with a row at another `packRef`.
pub fn encode(pack_hash: [u8; 32], locator: &ObjectLocator) -> Result<Vec<u8>> {
    if locator.max_pack_ref().is_some_and(|r| r != 0) {
        return Err(Error::Config(
            "a members-only index covers one pack: every row is at packRef 0".into(),
        ));
    }
    let mut out = Vec::with_capacity(HEADER_LEN + locator.as_bytes().len());
    out.extend_from_slice(&MAGIC);
    out.push(VERSION);
    out.extend_from_slice(&pack_hash);
    out.extend_from_slice(locator.as_bytes());
    Ok(out)
}

/// Parse a members-only index's plaintext. `Ok(None)` for a later layout version (skipped, as a
/// later envelope is, never fatal); an error for anything malformed: another magic, a short
/// header, a locator that does not parse, or a row at a `packRef` other than 0.
pub fn parse(bytes: &[u8]) -> Result<Option<MembersIndex>> {
    let bad = |what: &str| Error::Config(format!("members-only index: {what}"));
    if bytes.len() < HEADER_LEN || bytes[..4] != MAGIC {
        return Err(bad("not a members-only index"));
    }
    if bytes[4] != VERSION {
        return Ok(None);
    }
    let pack_hash: [u8; 32] = bytes[5..HEADER_LEN].try_into().expect("32 bytes");
    let locator = ObjectLocator::parse(&bytes[HEADER_LEN..])?;
    if locator.max_pack_ref().is_some_and(|r| r != 0) {
        return Err(bad("a row is not at packRef 0"));
    }
    Ok(Some(MembersIndex { pack_hash, locator }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_what_it_cannot_read_and_skips_a_later_version() {
        let empty = ObjectLocator::merge(&[]);
        let bytes = encode([7; 32], &empty).unwrap();
        assert_eq!(bytes.len(), HEADER_LEN + crate::pack::FANOUT_LEN);
        let back = parse(&bytes).unwrap().unwrap();
        assert_eq!((back.pack_hash, back.locator.object_count()), ([7; 32], 0));
        let mut later = bytes.clone();
        later[4] = 2;
        assert!(parse(&later).unwrap().is_none());
        assert!(parse(&bytes[..HEADER_LEN - 1]).is_err());
        let mut other = bytes;
        other[0] = b'X';
        assert!(parse(&other).is_err());
    }
}
