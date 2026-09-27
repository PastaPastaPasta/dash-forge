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
//! Only a manifest recorded by a current maintainer or writer supersedes anything (the
//! reader's representative rule, `rules::v2::v2_pack_list`): a stranger's manifest naming
//! every pack must not hide them.

use std::collections::{BTreeMap, BTreeSet};

use crate::repo::{PackManifestInfo, RoleMap};

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
    let mut uris: Vec<&str> = manifests
        .iter()
        .flat_map(|m| m.uris.iter().map(String::as_str))
        .collect();
    uris.sort_unstable();
    uris.dedup();
    let mut places: BTreeSet<String> = BTreeSet::new();
    if manifests
        .iter()
        .any(|m| m.storage == 0 && m.chunk_count > 0)
    {
        places.insert("platform".into());
    }
    // Each S3 object is one copy: its `s3://bucket/key` locator, plus at most one public URL
    // ending in the key as a push writes it (percent-encoded once). A matched public URL is
    // consumed, so two buckets holding the same key still count twice.
    let mut consumed: BTreeSet<&str> = BTreeSet::new();
    for rest in uris.iter().filter_map(|u| u.strip_prefix("s3://")) {
        let key = rest.split_once('/').map_or("", |(_, k)| k);
        let suffix = format!("/{}", crate::backends::sigv4::uri_encode(key, true));
        let public = uris.iter().copied().find(|o| {
            o.starts_with("http")
                && !consumed.contains(o)
                && !key.is_empty()
                && o.ends_with(&suffix)
        });
        if let Some(p) = public {
            consumed.insert(p);
        }
        places.insert(format!("s3:{rest}"));
    }
    for u in uris
        .iter()
        .filter(|u| !u.starts_with("s3://") && !consumed.contains(*u))
    {
        let place = if u.starts_with("platform://") {
            "platform".to_string()
        } else if let Some(cid) = u.strip_prefix("ipfs://") {
            format!("ipfs:{cid}")
        } else if let Some((_, cid)) = u.split_once("/ipfs/") {
            format!("ipfs:{}", cid.trim_end_matches('/'))
        } else {
            (*u).to_string()
        };
        places.insert(place);
    }
    places.len()
}

/// How many distinct copies a push under `policy` can record: its `replicas`, capped by
/// the distinct places its targets write to. Every IPFS target records the same
/// `ipfs://<cid>` (the CID is derived from the bytes), so any number of IPFS targets is one
/// place; each S3 profile and Platform is one place each.
pub fn policy_copies(policy: &super::ResolvedPolicy) -> usize {
    use super::Profile;
    let ipfs = policy
        .external
        .iter()
        .any(|(_, p)| matches!(p, Profile::IpfsKubo(_) | Profile::IpfsPinningService(_)));
    // Two profiles naming the same bucket and prefix (on one endpoint) write one object.
    let s3: BTreeSet<(String, &str, &str)> = policy
        .external
        .iter()
        .filter_map(|(_, p)| match p {
            Profile::S3(s) => Some((
                s.endpoint.trim_end_matches('/').to_ascii_lowercase(),
                s.bucket.as_str(),
                s.prefix.trim_matches('/'),
            )),
            _ => None,
        })
        .collect();
    let s3 = s3.len();
    policy
        .replicas
        .min(s3 + usize::from(ipfs) + usize::from(policy.platform))
}

/// Count the copies of every live git pack in `manifests` against `required` (see
/// [`policy_copies`] for a policy's number). `roles` are the repository's current members:
/// only their manifests supersede.
pub fn count_copies(manifests: &[PackManifestInfo], roles: &RoleMap, required: usize) -> CopyCount {
    let git = u64::from(crate::pack::KIND_GIT_PACK);
    let superseded: BTreeSet<[u8; 32]> = manifests
        .iter()
        .filter(|m| roles.contains_key(&m.owner_id))
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
            let first = ms.iter().map(|m| m.created_at).min().unwrap_or(0);
            (copies < required).then(|| {
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

    fn roles(ids: &[&str]) -> RoleMap {
        ids.iter()
            .map(|i| ((*i).to_string(), crate::rules::v2::Role::Writer))
            .collect()
    }

    fn m(hash: u8, at: u64, storage: u64, chunks: u64, uris: &[&str]) -> PackManifestInfo {
        PackManifestInfo {
            document_id: format!("d{hash}{at}"),
            created_at: at,
            created_at_block_height: 0,
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
        let c = count_copies(&[new.clone(), old.clone()], &roles(&["o"]), 2);
        assert_eq!(c.live, 2);
        assert_eq!(c.thin.len(), 1);
        assert_eq!((c.thin[0].pack_hash, c.thin[0].copies), ([1; 32], 1));
        assert!(count_copies(&[new, old], &roles(&["o"]), 1).thin.is_empty());
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
        let c = count_copies(&[old, repack, locator], &roles(&["o"]), 2);
        assert_eq!((c.live, c.thin.len()), (1, 0));
    }

    fn policy(targets: &str) -> crate::storage::ResolvedPolicy {
        let profiles = crate::storage::StorageProfiles::parse(
            "[profiles.k1]\nkind = \"ipfs-kubo\"\napi = \"http://127.0.0.1:5001\"\n\
             [profiles.k2]\nkind = \"ipfs-kubo\"\napi = \"http://127.0.0.1:5002\"\n\
             [profiles.r2]\nkind = \"s3\"\nendpoint = \"https://a.r2.cloudflarestorage.com\"\nbucket = \"b\"\n",
        )
        .unwrap();
        crate::storage::StoragePolicy::from_git_values(Some(targets), None, None)
            .unwrap()
            .resolve(&profiles)
            .unwrap()
    }

    /// Two kubo targets record one `ipfs://cid`: a pack pushed under that N=2 policy has
    /// every copy the policy can make, so it is not reported thin.
    #[test]
    fn two_ipfs_targets_are_one_place() {
        let p = policy("k1,k2");
        assert_eq!(p.replicas, 2);
        assert_eq!(policy_copies(&p), 1);
        let pushed = m(1, 1, 1, 0, &["ipfs://bafyx"]);
        assert!(count_copies(&[pushed], &roles(&["o"]), policy_copies(&p))
            .thin
            .is_empty());
        assert_eq!(policy_copies(&policy("k1,r2,platform")), 3);
        assert_eq!(policy_copies(&policy("k1,k2,r2")), 2);
    }

    /// A stranger's manifest naming every pack in `supersedes` hides none of them; a
    /// member's does.
    #[test]
    fn only_members_supersede() {
        let old = m(1, 100, 1, 0, &["ipfs://old"]);
        let mut claim = m(
            2,
            200,
            1,
            0,
            &["ipfs://c", "https://r2.example/packs/c.pack"],
        );
        claim.owner_id = "mallory".into();
        claim.supersedes = vec![[1; 32]];
        let both = [old, claim];
        assert_eq!(count_copies(&both, &roles(&["o"]), 2).thin.len(), 1);
        assert_eq!(
            count_copies(&both, &roles(&["o", "mallory"]), 2).thin.len(),
            0
        );
    }

    /// Two profiles of one bucket and prefix write one object.
    #[test]
    fn one_bucket_under_two_names_is_one_place() {
        let profiles = crate::storage::StorageProfiles::parse(
            "[profiles.a]\nkind = \"s3\"\nendpoint = \"https://s3.example\"\nbucket = \"b\"\nprefix = \"p\"\n\
             [profiles.a2]\nkind = \"s3\"\nendpoint = \"https://S3.example/\"\nbucket = \"b\"\nprefix = \"p/\"\n\
             [profiles.c]\nkind = \"s3\"\nendpoint = \"https://s3.example\"\nbucket = \"c\"\n",
        )
        .unwrap();
        let p = |t: &str| {
            crate::storage::StoragePolicy::from_git_values(Some(t), None, None)
                .unwrap()
                .resolve(&profiles)
                .unwrap()
        };
        assert_eq!(policy_copies(&p("a,a2")), 1);
        assert_eq!(policy_copies(&p("a,c")), 2);
    }

    /// H-A: a later reseed of an unrelated consolidated pack must not hide older thin packs
    /// that no manifest supersedes.
    #[test]
    fn a_later_reseed_hides_no_older_thin_pack() {
        let old = m(1, 100, 1, 0, &["ipfs://old"]);
        let mut repack = m(
            2,
            50,
            1,
            0,
            &["ipfs://r", "https://r2.example/packs/r.pack"],
        );
        repack.supersedes = vec![[9; 32]];
        // Someone reseeds the consolidation long after `old` was pushed.
        let mut reseed = repack.clone();
        reseed.created_at = 900;
        reseed.owner_id = "carol".into();
        let c = count_copies(&[old, repack, reseed], &roles(&["o", "carol"]), 2);
        assert_eq!(c.thin.len(), 1, "{c:?}");
    }

    /// A percent-encoded public URL and its raw `s3://` locator are one copy; two buckets
    /// with the same key and one public URL are two.
    #[test]
    fn s3_locators_match_their_encoded_public_url_once() {
        let uris = [
            "https://cdn.example/my%20dir/packs/a.pack",
            "s3://b/my dir/packs/a.pack",
        ];
        assert_eq!(
            count_copies(&[m(1, 1, 1, 0, &uris)], &roles(&["o"]), 2).thin[0].copies,
            1
        );
        let uris = [
            "https://cdn.example/p/packs/a.pack",
            "s3://b1/p/packs/a.pack",
            "s3://b2/p/packs/a.pack",
        ];
        assert_eq!(
            count_copies(&[m(1, 1, 1, 0, &uris)], &roles(&["o"]), 3).thin[0].copies,
            2
        );
    }
}
