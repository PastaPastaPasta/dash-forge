//! How many copies each live pack of a repository has, against the number its storage
//! policy asks for.
//!
//! A storage policy (`dash.storage` / `dash.replicas`) applies to packs pushed **after** it
//! is set: a manifest is immutable, so a pack keeps the copies it was stored with. `dg storage
//! use` and `dg doctor` use this to say which packs have fewer copies than the policy wants.
//!
//! A "copy" is a distinct place a pack's recorded URIs point at, across every uploader's
//! manifest of that pack:
//! - Platform `chunk` documents (a manifest with `storage = 0` and chunks);
//! - one S3 object: its public URL and its `s3://bucket/key` locator are the same copy;
//! - one IPFS CID: `ipfs://<cid>` and `https://<gateway>/ipfs/<cid>` are the same copy.
//!
//! Packs a repack superseded are left out: their objects live on in the superseding pack.

use std::collections::{BTreeMap, BTreeSet};

use crate::repo::PackManifestInfo;

/// One live git pack with fewer copies than required.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThinPack {
    /// The pack's SHA-256.
    pub pack_hash: [u8; 32],
    /// Its size in bytes.
    pub size_bytes: u64,
    /// Distinct copies recorded.
    pub copies: usize,
}

/// A repository's live git packs, counted against a required number of copies.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CopyCount {
    /// Live (not superseded) git packs.
    pub live: usize,
    /// The live packs with fewer than the required copies, oldest first.
    pub thin: Vec<ThinPack>,
}

/// The distinct copies the URIs of one pack's manifests point at (see the module docs).
fn copies_of(manifests: &[&PackManifestInfo]) -> usize {
    let uris: Vec<&str> = manifests
        .iter()
        .flat_map(|m| m.uris.iter().map(String::as_str))
        .collect();
    let mut places: BTreeSet<String> = BTreeSet::new();
    if manifests
        .iter()
        .any(|m| m.storage == 0 && m.chunk_count > 0)
    {
        places.insert("platform".into());
    }
    for u in &uris {
        let place = if u.starts_with("platform://") {
            "platform".to_string()
        } else if let Some(cid) = u.strip_prefix("ipfs://") {
            format!("ipfs:{cid}")
        } else if let Some(rest) = u.strip_prefix("s3://") {
            // The same object's public URL ends in its key; count the object once.
            let key = rest.split_once('/').map_or("", |(_, k)| k);
            let public = !key.is_empty()
                && uris
                    .iter()
                    .any(|o| o.starts_with("http") && o.ends_with(&format!("/{key}")));
            if public {
                continue;
            }
            format!("s3:{rest}")
        } else if let Some((_, cid)) = u.split_once("/ipfs/") {
            format!("ipfs:{}", cid.trim_end_matches('/'))
        } else {
            (*u).to_string()
        };
        places.insert(place);
    }
    places.len()
}

/// Count the copies of every live git pack in `manifests` against `required`.
pub fn count_copies(manifests: &[PackManifestInfo], required: usize) -> CopyCount {
    let git = u64::from(crate::pack::KIND_GIT_PACK);
    let superseded: BTreeSet<[u8; 32]> = manifests
        .iter()
        .flat_map(|m| m.supersedes.iter().copied())
        .collect();
    let mut packs: BTreeMap<[u8; 32], Vec<&PackManifestInfo>> = BTreeMap::new();
    for m in manifests
        .iter()
        .filter(|m| m.kind == git && !superseded.contains(&m.pack_hash))
    {
        packs.entry(m.pack_hash).or_default().push(m);
    }
    let mut thin: Vec<(u64, ThinPack)> = packs
        .iter()
        .filter_map(|(hash, ms)| {
            let copies = copies_of(ms);
            (copies < required).then(|| {
                let first = ms.iter().map(|m| m.created_at).min().unwrap_or(0);
                (
                    first,
                    ThinPack {
                        pack_hash: *hash,
                        size_bytes: ms[0].size_bytes,
                        copies,
                    },
                )
            })
        })
        .collect();
    thin.sort_by_key(|(first, t)| (*first, t.pack_hash));
    CopyCount {
        live: packs.len(),
        thin: thin.into_iter().map(|(_, t)| t).collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m(hash: u8, at: u64, storage: u64, chunks: u64, uris: &[&str]) -> PackManifestInfo {
        PackManifestInfo {
            document_id: format!("d{hash}{at}"),
            created_at: at,
            owner_id: "o".into(),
            pack_hash: [hash; 32],
            kind: 0,
            size_bytes: 100,
            object_count: 1,
            chunk_count: chunks,
            storage,
            offset_index_parts: 0,
            uris: uris.iter().map(ToString::to_string).collect(),
            supersedes: Vec::new(),
        }
    }

    #[test]
    fn a_policy_change_leaves_older_packs_thin() {
        let k = "e2e/packs/aa.pack";
        let old = m(
            1,
            100,
            1,
            0,
            &[
                &format!("https://minio.example/forge/{k}"),
                &format!("s3://forge/{k}"),
            ],
        );
        let new = m(
            2,
            200,
            1,
            0,
            &[
                &format!("https://minio.example/forge/{k}"),
                &format!("https://garage.example/{k}"),
                &format!("s3://forge/{k}"),
            ],
        );
        let c = count_copies(&[new.clone(), old.clone()], 2);
        assert_eq!(c.live, 2);
        assert_eq!(c.thin.len(), 1);
        assert_eq!((c.thin[0].pack_hash, c.thin[0].copies), ([1; 32], 1));
        assert!(count_copies(&[new, old], 1).thin.is_empty());
    }

    #[test]
    fn copies_count_places_not_uris() {
        // A private bucket: only the s3:// locator.
        assert_eq!(copies_of(&[&m(1, 1, 1, 0, &["s3://b/p/packs/x.pack"])]), 1);
        // kubo with a public gateway: one CID, two URIs.
        assert_eq!(
            copies_of(&[&m(
                1,
                1,
                1,
                0,
                &["https://gw.example/ipfs/bafyx", "ipfs://bafyx"]
            )]),
            1
        );
        // Platform chunks plus an external copy.
        assert_eq!(copies_of(&[&m(1, 1, 0, 3, &["ipfs://bafyx"])]), 2);
        // Two uploaders' manifests of one pack add up.
        let a = m(1, 1, 1, 0, &["ipfs://bafyx"]);
        let b = m(1, 2, 1, 0, &["https://r2.example/packs/x.pack"]);
        assert_eq!(copies_of(&[&a, &b]), 2);
    }

    #[test]
    fn superseded_and_non_git_packs_are_left_out() {
        let old = m(1, 100, 1, 0, &["ipfs://a"]);
        let mut repack = m(
            2,
            200,
            1,
            0,
            &["ipfs://b", "https://r2.example/packs/b.pack"],
        );
        repack.supersedes = vec![[1; 32]];
        let mut locator = m(3, 300, 1, 0, &["ipfs://c"]);
        locator.kind = 1;
        let c = count_copies(&[old, repack, locator], 2);
        assert_eq!((c.live, c.thin.len()), (1, 0));
    }
}
