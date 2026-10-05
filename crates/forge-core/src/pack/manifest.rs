//! `packManifest` types (data-contracts §2.3) and the repack supersedes planner.
//!
//! A `packManifest` is metadata the platform / backends layers store; `pack` only
//! *produces* it. One `kind` field distinguishes the artifacts that share the entire
//! pack storage/transport machinery:
//!
//! - `0` — a git packfile.
//! - `1` — an `objectLocator` (the browse plane's object index).
//! - `2` — a `flatIndex` (carries the indexed tip in `tips`).
//! - `3` — a history column index (`tips` = `[tip]`, or `[tip, baseTip]` for a delta over an
//!   earlier full index). The RC1 contract's `kindShape` rule refuses a kind-3 manifest
//!   whose `tips` is not 20, 32, 40 or 64 bytes.
//! - `4` — a release-asset manifest (docs/design/release-asset-manifest.md, D-4).
//! - `5` — a history index's version lists, the companion of kind 3 with the same `tips` (a
//!   reader rule: the contract checks tips on kind 3 only).
//! - `6` — a long body: the full text of an issue, PR, comment, review or release notes that
//!   its field cannot hold (`docs/contracts/forge-v2.md` §6.3, [`crate::rules::long_body`]).
//! - `8` — an environment snapshot: one whole environment, sealed for its audience, whose
//!   `supersedes` names the snapshot(s) it replaces ([`crate::env`]). Readers count one only
//!   when its `$ownerId` is a current maintainer.
//!
//! `kind` is a plain `0..=255` integer in forge-core. RC1 removed the per-pack offset index
//! (`manifestPart` documents and `packManifest.offsetIndexParts`): every artifact locates
//! itself through the `objectLocator`.
//!
//! Hashes and OIDs are held as lowercase hex strings — the form the platform layer
//! serializes (as JSON-in-string / packed byteArray; §0) — never native arrays.

use super::build::Pack;
use serde::{Deserialize, Serialize};

/// `packManifest.kind == 0`: a git packfile.
pub const KIND_GIT_PACK: u8 = 0;
/// `packManifest.kind == 1`: an objectLocator browse artifact.
pub const KIND_OBJECT_LOCATOR: u8 = 1;
/// `packManifest.kind == 2`: a flatIndex browse artifact.
pub const KIND_FLAT_INDEX: u8 = 2;
/// `packManifest.kind == 3`: a history index ([`super::historyindex`]).
pub const KIND_HISTORY_INDEX: u8 = 3;
/// `packManifest.kind == 4`: a release-asset manifest (D-4; RC1 `pack_kind_shape`).
pub const KIND_RELEASE_ASSETS: u8 = 4;
/// `packManifest.kind == 5`: a history index's per-path version lists (the whole index, format
/// 2), companion of the column index (kind 3, format 1) of the same tip. Blame and a path's
/// History read it; the file list and the counts read only kind 3.
pub const KIND_HISTORY_VERSIONS: u8 = 5;
/// `packManifest.kind == 6`: a long body, the UTF-8 text a field's `forge:body` trailer names
/// (sealed in a private repository; forge-v2.md §6.3). `objectCount` 0, no `tips`, no
/// `supersedes`.
pub const KIND_LONG_BODY: u8 = 6;
/// `packManifest.kind == 8`: an environment snapshot ([`crate::env`]): `objectCount` 0, no
/// `tips`; `supersedes` names the `packHash` of the snapshot(s) it replaces (one, every head of
/// a fork it resolves, or none for an environment's first). Unlike kinds 1-6, a newer snapshot
/// never supersedes every older one of its kind: [`plan_supersedes`] is not for it.
pub const KIND_ENV_SNAPSHOT: u8 = 8;

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
}

impl PackManifest {
    /// Manifest for a kind-0 git pack. `chunk_count` is the number of `chunk` docs the
    /// pack bytes split into (see [`super::split`]).
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
        }
    }

    /// Manifest for a kind-8 environment snapshot of `sealed` bytes replacing the snapshots
    /// whose `packHash`es are `supersedes` (lowercase hex).
    pub fn for_env_snapshot(sealed: &[u8], chunk_count: u64, supersedes: Vec<String>) -> Self {
        Self {
            pack_hash: hex::encode(sha256(sealed)),
            kind: KIND_ENV_SNAPSHOT,
            size_bytes: sealed.len() as u64,
            object_count: 0,
            chunk_count,
            storage: 0,
            uris: Vec::new(),
            tips: Vec::new(),
            supersedes,
        }
    }
}

/// Plan which prior manifests a freshly published artifact makes redundant.
///
/// A **full repack** (`new` is a consolidated kind-0 pack covering all objects)
/// subsumes every prior kind-0 pack; a republished browse artifact (kind 1/2) always
/// supersedes the prior artifacts of the same kind. Returns the `packHash`es to delete
/// for storage refund (data-contracts §5.6). The new artifact never supersedes itself.
///
/// `is_full_repack` is the load-bearing intent flag: only a caller holding a pack
/// produced by [`repack_all`](super::repack_all) (which covers the whole object graph)
/// may truthfully pass `true`. For a kind-0 pack from the **incremental push** path it
/// must be `false` — an ordinary push subsumes nothing, and superseding prior packs
/// would delete objects still uniquely held there and break the object graph. When
/// `new` is a kind-0 pack and `is_full_repack` is `false`, this returns an empty plan.
pub fn plan_supersedes(
    existing: &[PackManifest],
    new: &PackManifest,
    is_full_repack: bool,
) -> Vec<String> {
    // An incremental (non-repack) git pack makes nothing redundant; an environment snapshot
    // names what it replaces itself (an older snapshot of another environment stays live).
    if (new.kind == KIND_GIT_PACK && !is_full_repack) || new.kind == KIND_ENV_SNAPSHOT {
        return Vec::new();
    }
    existing
        .iter()
        .filter(|m| m.kind == new.kind && m.pack_hash != new.pack_hash)
        .map(|m| m.pack_hash.clone())
        .collect()
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
        }
    }

    #[test]
    fn full_repack_supersedes_prior_packs() {
        let existing = vec![
            manifest(KIND_GIT_PACK, "aa"),
            manifest(KIND_GIT_PACK, "bb"),
            manifest(KIND_OBJECT_LOCATOR, "cc"),
        ];
        let new = manifest(KIND_GIT_PACK, "zz");
        let mut got = plan_supersedes(&existing, &new, true);
        got.sort();
        assert_eq!(got, vec!["aa".to_string(), "bb".to_string()]);
    }

    #[test]
    fn incremental_push_supersedes_nothing() {
        // The dangerous case: a kind-0 pack that is NOT a full repack must never
        // supersede prior packs (that would delete objects only they hold).
        let existing = vec![manifest(KIND_GIT_PACK, "aa"), manifest(KIND_GIT_PACK, "bb")];
        let new = manifest(KIND_GIT_PACK, "zz");
        assert!(plan_supersedes(&existing, &new, false).is_empty());
    }

    #[test]
    fn republished_browse_artifact_supersedes_regardless_of_repack_flag() {
        let existing = vec![manifest(KIND_OBJECT_LOCATOR, "aa")];
        let new = manifest(KIND_OBJECT_LOCATOR, "zz");
        // Browse-artifact republish is superseding even without a repack.
        assert_eq!(
            plan_supersedes(&existing, &new, false),
            vec!["aa".to_string()]
        );
    }

    #[test]
    fn an_env_snapshot_plans_nothing() {
        let existing = vec![manifest(KIND_ENV_SNAPSHOT, "aa")];
        let new = PackManifest::for_env_snapshot(b"x", 1, vec!["aa".into()]);
        assert!(plan_supersedes(&existing, &new, true).is_empty());
        assert_eq!(new.supersedes, vec!["aa".to_string()]);
        assert_eq!((new.kind, new.object_count), (KIND_ENV_SNAPSHOT, 0));
    }

    #[test]
    fn does_not_supersede_itself() {
        let existing = vec![manifest(KIND_FLAT_INDEX, "aa")];
        let new = manifest(KIND_FLAT_INDEX, "aa");
        assert!(plan_supersedes(&existing, &new, true).is_empty());
    }

    #[test]
    fn manifest_roundtrips_json() {
        let m = manifest(KIND_GIT_PACK, "deadbeef");
        let s = serde_json::to_string(&m).unwrap();
        let back: PackManifest = serde_json::from_str(&s).unwrap();
        assert_eq!(m, back);
    }
}
