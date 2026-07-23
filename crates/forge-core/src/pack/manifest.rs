//! `packManifest` types (data-contracts §2.3) and the repack supersedes planner.
//!
//! A `packManifest` is metadata the platform / backends layers store; `pack` only
//! *produces* it. One `kind` field distinguishes the three artifacts that share the
//! entire pack storage/transport machinery:
//!
//! - `0` — a git packfile (kind-0 packs mandate `offset_index_parts >= 1`).
//! - `1` — an `objectLocator` (locates itself; `offset_index_parts == 0`).
//! - `2` — a `flatIndex` (locates itself; carries the indexed tip in `tips`).
//!
//! Hashes and OIDs are held as lowercase hex strings — the form the platform layer
//! serializes (as JSON-in-string / packed byteArray; §0) — never native arrays.

use super::build::Pack;
use super::parse::OID_LEN;
use serde::{Deserialize, Serialize};

/// `packManifest.kind == 0`: a git packfile.
pub const KIND_GIT_PACK: u8 = 0;
/// `packManifest.kind == 1`: an objectLocator browse artifact.
pub const KIND_OBJECT_LOCATOR: u8 = 1;
/// `packManifest.kind == 2`: a flatIndex browse artifact.
pub const KIND_FLAT_INDEX: u8 = 2;

/// Bytes of one packed `manifestPart` offset-index payload (`d0..d2`, 3 × 4900 B).
const OFFSET_PART_CAPACITY: usize = 4900 * 3;
/// Packed offset-index row width: `oid(20) || offset(5) || length(4)`.
const OFFSET_ROW_BYTES: usize = OID_LEN + 5 + 4;

/// The `packManifest` document fields (data-contracts §2.3). List fields serialize as
/// JSON-in-string / packed byteArray at the platform layer, not native arrays.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PackManifest {
    /// SHA-256 of the artifact bytes, lowercase hex (`hash32`).
    pub pack_hash: String,
    /// `0` git pack, `1` objectLocator, `2` flatIndex.
    pub kind: u8,
    /// Artifact size in bytes.
    pub size_bytes: u64,
    /// Object count (kind 0) / row count (kinds 1–2).
    pub object_count: u64,
    /// Number of `chunk` documents the artifact splits into on Platform.
    pub chunk_count: u64,
    /// `0` platform (chunk docs) / `1` external (uris).
    pub storage: u8,
    /// External backend URIs (empty for platform storage).
    pub uris: Vec<String>,
    /// Tip commit OIDs the artifact indexes (kind 2), lowercase hex.
    pub tips: Vec<String>,
    /// Prior artifact `packHash`es this one makes redundant, lowercase hex.
    pub supersedes: Vec<String>,
    /// `manifestPart` offset-index document count; `>= 1` for kind 0, `0` otherwise.
    pub offset_index_parts: u32,
}

impl PackManifest {
    /// Manifest for a kind-0 git pack. `chunk_count` is the number of `chunk` docs the
    /// pack bytes split into (see [`super::split`]); the mandatory per-pack offset
    /// index size is derived from the object count.
    pub fn for_pack(pack: &Pack, chunk_count: u64) -> Self {
        let object_count = pack.parsed.object_count() as u64;
        Self {
            pack_hash: hex::encode(pack.parsed.pack_hash),
            kind: KIND_GIT_PACK,
            size_bytes: pack.bytes.len() as u64,
            object_count,
            chunk_count,
            storage: 0,
            uris: Vec::new(),
            tips: Vec::new(),
            supersedes: Vec::new(),
            offset_index_parts: offset_index_parts(pack.parsed.object_count()),
        }
    }

    /// Manifest for a kind-1 objectLocator artifact.
    pub fn for_locator(artifact_bytes: &[u8], row_count: u64, chunk_count: u64) -> Self {
        Self {
            pack_hash: hex::encode(sha256(artifact_bytes)),
            kind: KIND_OBJECT_LOCATOR,
            size_bytes: artifact_bytes.len() as u64,
            object_count: row_count,
            chunk_count,
            storage: 0,
            uris: Vec::new(),
            tips: Vec::new(),
            supersedes: Vec::new(),
            offset_index_parts: 0,
        }
    }

    /// Manifest for a kind-2 flatIndex artifact indexing `tip`.
    pub fn for_flat_index(
        artifact_bytes: &[u8],
        row_count: u64,
        chunk_count: u64,
        tip_oid_hex: &str,
    ) -> Self {
        Self {
            pack_hash: hex::encode(sha256(artifact_bytes)),
            kind: KIND_FLAT_INDEX,
            size_bytes: artifact_bytes.len() as u64,
            object_count: row_count,
            chunk_count,
            storage: 0,
            uris: Vec::new(),
            tips: vec![tip_oid_hex.to_string()],
            supersedes: Vec::new(),
            offset_index_parts: 0,
        }
    }
}

/// Plan which prior manifests a freshly published artifact makes redundant.
///
/// A repack (`new` is a consolidated kind-0 pack) subsumes every prior kind-0 pack;
/// a republished browse artifact (kind 1/2) supersedes the prior artifacts of the
/// same kind. Returns the `packHash`es to delete for storage refund (data-contracts
/// §5.6). The new artifact never supersedes itself.
pub fn plan_supersedes(existing: &[PackManifest], new: &PackManifest) -> Vec<String> {
    existing
        .iter()
        .filter(|m| m.kind == new.kind && m.pack_hash != new.pack_hash)
        .map(|m| m.pack_hash.clone())
        .collect()
}

/// Number of `manifestPart` docs needed to hold a pack's offset index. `>= 1` for any
/// kind-0 pack (the per-pack offset index is mandatory — data-contracts §2.3).
fn offset_index_parts(object_count: usize) -> u32 {
    let total = object_count * OFFSET_ROW_BYTES;
    let parts = total.div_ceil(OFFSET_PART_CAPACITY).max(1);
    u32::try_from(parts).unwrap_or(u32::MAX)
}

fn sha256(bytes: &[u8]) -> [u8; 32] {
    use sha2::{Digest as _, Sha256};
    let mut h = Sha256::new();
    h.update(bytes);
    h.finalize().into()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest(kind: u8, hash: &str) -> PackManifest {
        PackManifest {
            pack_hash: hash.to_string(),
            kind,
            size_bytes: 0,
            object_count: 0,
            chunk_count: 0,
            storage: 0,
            uris: vec![],
            tips: vec![],
            supersedes: vec![],
            offset_index_parts: 0,
        }
    }

    #[test]
    fn supersedes_prior_same_kind_only() {
        let existing = vec![
            manifest(KIND_GIT_PACK, "aa"),
            manifest(KIND_GIT_PACK, "bb"),
            manifest(KIND_OBJECT_LOCATOR, "cc"),
        ];
        let new = manifest(KIND_GIT_PACK, "zz");
        let mut got = plan_supersedes(&existing, &new);
        got.sort();
        assert_eq!(got, vec!["aa".to_string(), "bb".to_string()]);
    }

    #[test]
    fn does_not_supersede_itself() {
        let existing = vec![manifest(KIND_FLAT_INDEX, "aa")];
        let new = manifest(KIND_FLAT_INDEX, "aa");
        assert!(plan_supersedes(&existing, &new).is_empty());
    }

    #[test]
    fn offset_parts_at_least_one_for_kind0() {
        assert_eq!(offset_index_parts(0), 1);
        assert_eq!(offset_index_parts(1), 1);
        // 507 rows * 29 B = 14703 B > 14700 → 2 parts.
        assert_eq!(offset_index_parts(507), 2);
    }

    #[test]
    fn manifest_roundtrips_json() {
        let m = manifest(KIND_GIT_PACK, "deadbeef");
        let s = serde_json::to_string(&m).unwrap();
        let back: PackManifest = serde_json::from_str(&s).unwrap();
        assert_eq!(m, back);
    }
}
