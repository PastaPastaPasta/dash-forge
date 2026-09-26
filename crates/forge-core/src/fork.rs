//! Forking a forge-v2 repository: a new `repo` with `forkOf` = the parent, the parent's
//! packs recorded in the fork **without re-uploading them**, and the parent's refs copied.
//!
//! A pack's bytes are content-addressed, so the fork's `packManifest` only has to say where
//! to read them (`forge-v2.md` §4 keeps chunks permanent, which is what makes this safe):
//!
//! * **External copies** (`https://`, `ipfs://`, `s3://`): the fork's manifest lists the
//!   parent's URIs as they are.
//! * **Platform chunks**: chunk documents are keyed `(repoId, $ownerId, packHash, seq)`,
//!   so the parent's live in the parent's scope, and they are readable by anyone. The fork's
//!   manifest records `storage = 1` (no chunks of its own) and the parent's chunk locator
//!   `platform://<core>/<parentRepoId>/<uploader>/<packHash>` in `uris`; readers follow it
//!   into the parent's scope and verify the bytes against the pack hash
//!   ([`crate::repo::RepoService::fetch_artifact_from`]). Nothing needs the parent's
//!   cooperation, and `chunk` / `packManifest` are non-deletable, so the reference cannot
//!   be pulled out from under the fork.
//!
//! Every document is written by the fork's owner, who is its maintainer, so the writes pass
//! the fork's own gates. The session is resumable without a journal: each step checks what
//! the fork already has (the repo by name, a manifest per pack hash, the refs' current tips)
//! before writing, so re-running an interrupted fork finishes it and pays for nothing twice.

use std::collections::BTreeSet;

use crate::backends::PLATFORM_SCHEME;
use crate::create::{create_repo, CreateRepoOpts, CreateRepoResult};
use crate::error::{Error, Result};
use crate::keystore::BridgeIdentity;
use crate::platform::{self, LoadedIdentity, PlatformClient};
use crate::repo::{PackManifestInfo, PackManifestInput, RepoService, MANIFEST_URIS_V2};
use crate::rules::RefState;
use crate::scope::RepoRef;

/// The fork manifest for `parent`'s copy `m` of a pack: the same pack facts, no chunks of
/// its own, and every URI a reader of the parent could use, the parent's chunk locator
/// first when the copy is on Platform. `None` when nothing a fork could name is readable
/// (a copy whose only URIs are too long for the manifest, say).
pub fn fork_manifest(parent: &RepoRef, m: &PackManifestInfo) -> Result<Option<PackManifestInput>> {
    let mut uris: Vec<String> = Vec::new();
    if m.storage == 0 {
        uris.push(
            parent
                .scope()?
                .locator(&m.owner_id, &hex::encode(m.pack_hash)),
        );
    }
    for u in &m.uris {
        if !uris.contains(u) {
            uris.push(u.clone());
        }
    }
    // Private `s3://` locators go first when the list is too long: they only serve readers
    // holding that bucket's profile.
    if !MANIFEST_URIS_V2.fits(&uris) {
        uris.retain(|u| !u.starts_with("s3://"));
    }
    if uris.len() > MANIFEST_URIS_V2.max_items.unwrap_or(usize::MAX) {
        uris.truncate(MANIFEST_URIS_V2.max_items.unwrap_or(usize::MAX));
    }
    uris.retain(|u| {
        MANIFEST_URIS_V2
            .max_item_len
            .is_none_or(|max| u.len() <= max)
    });
    if uris.is_empty() {
        return Ok(None);
    }
    Ok(Some(PackManifestInput {
        pack_hash: m.pack_hash,
        kind: m.kind,
        size_bytes: m.size_bytes,
        object_count: m.object_count,
        chunk_count: 0,
        storage: 1,
        offset_index_parts: m.offset_index_parts,
        uris,
        supersedes: m.supersedes.clone(),
        tips: Vec::new(),
    }))
}

/// The parent's manifests a fork records: one per pack hash (git packs and browse
/// artifacts), preferring a Platform copy (its chunks are permanent), then the oldest. Packs
/// the fork already has a manifest for are skipped.
pub fn plan_manifests<'m>(
    parent: &'m [PackManifestInfo],
    fork_has: &BTreeSet<[u8; 32]>,
) -> Vec<&'m PackManifestInfo> {
    let mut by_hash: std::collections::BTreeMap<[u8; 32], &PackManifestInfo> =
        std::collections::BTreeMap::new();
    for m in parent {
        if fork_has.contains(&m.pack_hash) {
            continue;
        }
        let better = by_hash.get(&m.pack_hash).is_none_or(|cur| {
            (u8::from(m.storage != 0), m.created_at, &m.document_id)
                < (u8::from(cur.storage != 0), cur.created_at, &cur.document_id)
        });
        if better {
            by_hash.insert(m.pack_hash, m);
        }
    }
    let mut out: Vec<&PackManifestInfo> = by_hash.into_values().collect();
    // Record in the parent's upload order, so the fork's pack list (packRef space) lines up.
    out.sort_by(|a, b| (a.created_at, &a.document_id).cmp(&(b.created_at, &b.document_id)));
    out
}

/// The ref updates a fork needs: every resolved ref of the parent (a diverged ref at its
/// provisional tip) whose tip the fork does not already have, with the fork's current tip as
/// `prevOid`.
pub fn plan_refs(
    parent: &[(String, RefState)],
    fork: &[(String, RefState)],
) -> Vec<(String, String, Option<String>)> {
    let tip = crate::rules::tip_of;
    parent
        .iter()
        .filter_map(|(name, state)| {
            let want = tip(state)?;
            let have = fork
                .iter()
                .find(|(n, _)| n == name)
                .and_then(|(_, s)| tip(s));
            (have.as_deref() != Some(want.as_str())).then(|| (name.clone(), want, have))
        })
        .collect()
}

/// What [`fork_repo`] did.
#[derive(Debug, Clone)]
pub struct ForkResult {
    /// The fork's creation (repo, owner maintainer, config).
    pub created: CreateRepoResult,
    /// Pack manifests written into the fork (referencing the parent's copies).
    pub manifests_written: usize,
    /// Of those, how many name Platform chunks in the parent's scope.
    pub platform_referenced: usize,
    /// Packs the fork already recorded (a resumed fork).
    pub manifests_existing: usize,
    /// Parent packs with no copy a fork could reference (their objects are missing from
    /// the fork until someone pushes them).
    pub unreferenceable: Vec<[u8; 32]>,
    /// Refs written.
    pub refs_written: Vec<String>,
    /// The balance change over the whole session, in credits.
    pub cost_credits: u64,
}

/// Fork `parent` as `opts.name` (with `opts.fork_of` set to the parent) under the signer.
pub async fn fork_repo(
    client: &PlatformClient,
    identity: &LoadedIdentity,
    bridge: &BridgeIdentity,
    parent: &RepoRef,
    opts: &CreateRepoOpts,
    journal_dir: &std::path::Path,
) -> Result<ForkResult> {
    parent.require_v2()?;
    parent.require_readable()?;
    let mut opts = opts.clone();
    opts.fork_of = Some(platform::decode_identifier(parent.id())?);
    let owner = identity.id();
    let before = client.get_balance(&owner).await?;

    let created = create_repo(client, identity, bridge, &opts, journal_dir).await?;
    let fork = created.repo.clone();
    if fork.id() == parent.id() {
        return Err(Error::Config(
            "a repository cannot be forked onto itself".into(),
        ));
    }
    let svc = RepoService::new(client, identity, bridge);

    let parent_manifests = svc.read_pack_manifests(parent).await?;
    let fork_has: BTreeSet<[u8; 32]> = svc
        .read_pack_manifests(&fork)
        .await?
        .iter()
        .filter(|m| m.owner_id == owner)
        .map(|m| m.pack_hash)
        .collect();
    let plan = plan_manifests(&parent_manifests, &fork_has);
    let mut written = 0;
    let mut platform_referenced = 0;
    let mut unreferenceable = Vec::new();
    for m in plan {
        let Some(input) = fork_manifest(parent, m)? else {
            unreferenceable.push(m.pack_hash);
            continue;
        };
        if input
            .uris
            .first()
            .is_some_and(|u| u.starts_with(&format!("{PLATFORM_SCHEME}://")))
        {
            platform_referenced += 1;
        }
        svc.write_pack_manifest(&fork, &input).await?;
        written += 1;
    }

    let parent_refs = svc.read_refs(parent).await?;
    let fork_refs = svc.read_refs(&fork).await?;
    let mut refs_written = Vec::new();
    for (name, want, have) in plan_refs(&parent_refs, &fork_refs) {
        let new = hex::decode(&want).map_err(|e| Error::Config(format!("ref tip: {e}")))?;
        let prev = have
            .as_deref()
            .map(hex::decode)
            .transpose()
            .map_err(|e| Error::Config(format!("ref tip: {e}")))?;
        svc.write_ref_update(&fork, &name, &new, prev.as_deref(), have.is_some())
            .await?;
        refs_written.push(name);
    }

    let after = client.get_balance(&owner).await.unwrap_or(before);
    Ok(ForkResult {
        created,
        manifests_written: written,
        platform_referenced,
        manifests_existing: fork_has.len(),
        unreferenceable,
        refs_written,
        cost_credits: before.saturating_sub(after),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::network::ForgeIds;
    use crate::rules::v2::Visibility;

    const PARENT: &str = "GdZYaEntYPiW9dvUGCHyeqN7H7qEocbSkuj81n341i3L";
    const UPLOADER: &str = "9r27eDsuXEqoMNymW1A2MKFrpBhzSkepVKwXrGzq9dUD";

    fn parent() -> RepoRef {
        RepoRef::V2 {
            forge: ForgeIds {
                core: "CORE".into(),
                collab: "COLLAB".into(),
                group: "G".into(),
            },
            repo_id: PARENT.into(),
            owner_id: UPLOADER.into(),
            name: "proj".into(),
            visibility: Visibility::Public,
        }
    }

    fn manifest(id: &str, hash: u8, storage: u64, at: u64, uris: &[&str]) -> PackManifestInfo {
        PackManifestInfo {
            document_id: id.into(),
            created_at: at,
            owner_id: UPLOADER.into(),
            pack_hash: [hash; 32],
            kind: 0,
            size_bytes: 10,
            object_count: 3,
            chunk_count: u64::from(storage == 0),
            storage,
            offset_index_parts: 0,
            uris: uris.iter().map(|u| (*u).to_string()).collect(),
            supersedes: Vec::new(),
        }
    }

    #[test]
    fn a_platform_pack_is_referenced_by_the_parents_chunk_locator_not_re_uploaded() {
        let m = manifest("a", 1, 0, 1, &[]);
        let f = fork_manifest(&parent(), &m).unwrap().unwrap();
        assert_eq!(
            (f.storage, f.chunk_count),
            (1, 0),
            "no chunks of the fork's own"
        );
        assert_eq!(
            f.uris,
            vec![format!(
                "platform://CORE/{PARENT}/{UPLOADER}/{}",
                "01".repeat(32)
            )]
        );
        assert_eq!(f.pack_hash, [1; 32]);
    }

    #[test]
    fn an_external_pack_keeps_the_parents_uris() {
        let m = manifest(
            "a",
            2,
            1,
            1,
            &["https://x/p.pack", "ipfs://bafy", "s3://b/p.pack"],
        );
        let f = fork_manifest(&parent(), &m).unwrap().unwrap();
        assert_eq!(f.storage, 1);
        assert_eq!(f.uris, ["https://x/p.pack", "ipfs://bafy", "s3://b/p.pack"]);
        // Nothing usable: no manifest.
        let empty = manifest("b", 3, 1, 1, &[]);
        assert!(fork_manifest(&parent(), &empty).unwrap().is_none());
    }

    #[test]
    fn one_manifest_per_pack_preferring_platform_and_skipping_what_the_fork_has() {
        let all = [
            manifest("ext-old", 1, 1, 1, &["https://x"]),
            manifest("plat", 1, 0, 5, &[]),
            manifest("other", 2, 1, 2, &["https://y"]),
            manifest("had", 3, 0, 3, &[]),
        ];
        let has: BTreeSet<[u8; 32]> = [[3; 32]].into();
        let plan: Vec<&str> = plan_manifests(&all, &has)
            .iter()
            .map(|m| m.document_id.as_str())
            .collect();
        // Upload order: "other" (t=2) before "plat" (t=5).
        assert_eq!(plan, ["other", "plat"]);
    }

    #[test]
    fn refs_are_copied_once_and_moved_forward_on_a_resumed_fork() {
        let r = |oid: &str| RefState::Resolved {
            oid: oid.into(),
            author: "a".into(),
            created_at: 1,
        };
        let parent = vec![
            ("refs/heads/main".to_string(), r("aa")),
            ("refs/heads/dev".to_string(), r("bb")),
            ("refs/heads/gone".to_string(), RefState::Unborn),
        ];
        let fork = vec![
            ("refs/heads/main".to_string(), r("aa")),
            ("refs/heads/dev".to_string(), r("00bb")),
        ];
        let plan = plan_refs(&parent, &fork);
        assert_eq!(
            plan,
            vec![(
                "refs/heads/dev".to_string(),
                "bb".to_string(),
                Some("00bb".to_string())
            )]
        );
        assert_eq!(plan_refs(&parent, &[]).len(), 2);
    }
}
