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

use std::collections::{BTreeMap, BTreeSet};

use crate::create::{create_repo, CreateRepoOpts, CreateRepoResult};
use crate::error::{Error, Result};
use crate::keystore::BridgeIdentity;
use crate::platform::{self, LoadedIdentity, PlatformClient};
use crate::repo::{
    order_copies, PackManifestInfo, PackManifestInput, RepoService, RoleMap, MANIFEST_URIS_V2,
};
use crate::rules::RefState;
use crate::scope::RepoRef;

/// The fork manifest for one pack of `parent`, from all of the parent's `copies` of it
/// (manifests with the same pack hash) in the order a reader should try them: the same pack
/// facts as the first, no chunks of the fork's own, and every URI a reader of the parent
/// could use. A Platform copy is recorded as its chunk locator in the parent's scope. `None`
/// when nothing a fork could name is readable (only over-long URIs, say).
pub fn fork_manifest(
    parent: &RepoRef,
    copies: &[&PackManifestInfo],
) -> Result<Option<PackManifestInput>> {
    let Some(first) = copies.first() else {
        return Ok(None);
    };
    let scope = parent.scope()?;
    let mut uris: Vec<String> = Vec::new();
    let mut push = |u: String| {
        if !uris.contains(&u) {
            uris.push(u);
        }
    };
    for m in copies.iter().filter(|m| m.storage == 0) {
        push(scope.locator(&m.owner_id, &hex::encode(m.pack_hash)));
    }
    for m in copies {
        for u in &m.uris {
            push(u.clone());
        }
    }
    // Private `s3://` locators go first when the list is too long: they only serve readers
    // holding that bucket's profile.
    if !MANIFEST_URIS_V2.fits(&uris) {
        uris.retain(|u| !u.starts_with("s3://"));
    }
    uris.retain(|u| {
        MANIFEST_URIS_V2
            .max_item_len
            .is_none_or(|max| u.len() <= max)
    });
    uris.truncate(MANIFEST_URIS_V2.max_items.unwrap_or(usize::MAX));
    if uris.is_empty() {
        return Ok(None);
    }
    Ok(Some(PackManifestInput {
        pack_hash: first.pack_hash,
        kind: first.kind,
        size_bytes: first.size_bytes,
        object_count: first.object_count,
        chunk_count: 0,
        storage: 1,
        offset_index_parts: first.offset_index_parts,
        uris,
        supersedes: first.supersedes.clone(),
        tips: Vec::new(),
    }))
}

/// The parent's git packs (kind 0) a fork records, each with all of its copies in the
/// `FORGE_RULES_V2` reader order (uploaders who are currently maintainers, then writers, then
/// anyone else; each by `($createdAt, $id)`), so the fork's manifest lists the trustworthy
/// copies first and every one of them as a fallback. Packs the fork already records are
/// skipped. Output is in the order of each pack's first upload, so the fork's pack list
/// (the `packRef` space) lines up with the parent's.
///
/// Browse artifacts (object locators, flat indexes) are not copied: a locator's `packRef`s
/// index the parent's pack list, which the fork's own list diverges from at its first push.
/// The fork's first push publishes a locator of its own (a repack consolidates one over
/// everything); until then the web app browses it by the whole-pack fallback.
pub fn plan_manifests<'m>(
    parent: &'m [PackManifestInfo],
    roles: &RoleMap,
    fork_has: &BTreeSet<[u8; 32]>,
) -> Vec<Vec<&'m PackManifestInfo>> {
    let mut by_hash: BTreeMap<[u8; 32], Vec<&PackManifestInfo>> = BTreeMap::new();
    for m in parent {
        if m.kind == u64::from(crate::pack::KIND_GIT_PACK) && !fork_has.contains(&m.pack_hash) {
            by_hash.entry(m.pack_hash).or_default().push(m);
        }
    }
    let mut out: Vec<Vec<&PackManifestInfo>> = by_hash
        .into_values()
        .map(|copies| order_copies(&copies, roles))
        .collect();
    let first = |g: &Vec<&PackManifestInfo>| {
        g.iter()
            .map(|m| (m.created_at, m.document_id.clone()))
            .min()
            .unwrap_or_default()
    };
    out.sort_by_key(first);
    out
}

/// The refs a fork still needs: every ref of the parent that resolves to a tip (a diverged
/// ref at its provisional tip) and that the fork does not have at all. A ref the fork already
/// has is the fork owner's own from then on and is never moved, so re-running an
/// interrupted fork finishes it without undoing the owner's pushes.
pub fn plan_refs(
    parent: &[(String, RefState)],
    fork: &[(String, RefState)],
) -> Vec<(String, String)> {
    parent
        .iter()
        .filter(|(name, _)| {
            !fork
                .iter()
                .any(|(n, s)| n == name && crate::rules::tip_of(s).is_some())
        })
        .filter_map(|(name, state)| Some((name.clone(), crate::rules::tip_of(state)?)))
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
    /// Parent packs with no copy a fork could reference. When there are any, no ref is
    /// copied (it could point at objects the fork cannot serve): push the branches instead.
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
    let forge = parent.require_v2()?;
    let mut opts = opts.clone();
    opts.name = crate::resolve::repo_slug(&opts.name)?;
    opts.fork_of = Some(platform::decode_identifier(parent.id())?);
    let owner = identity.id();

    // A repo of the signer's with this name already exists: continue only if it is a fork
    // of this parent (an interrupted fork). Anything else would have the parent's manifests
    // and refs written into an unrelated repository, permanently.
    if let Some(existing) = crate::resolve::find_v2(
        client,
        forge,
        platform::decode_identifier(&owner)?,
        &opts.name,
    )
    .await?
    {
        let of = crate::resolve::fork_parent(client, &existing).await?;
        if of.as_deref() != Some(parent.id()) {
            return Err(Error::Config(format!(
                "you already have a repository named {} and it is not a fork of {}; pass \
                 --name <another name>",
                opts.name,
                parent.display()
            )));
        }
    }
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
    let roles = svc.copy_roles(parent).await.unwrap_or_default();
    let fork_has: BTreeSet<[u8; 32]> = svc
        .read_pack_manifests(&fork)
        .await?
        .iter()
        .filter(|m| m.owner_id == owner)
        .map(|m| m.pack_hash)
        .collect();
    let plan = plan_manifests(&parent_manifests, &roles, &fork_has);
    let mut written = 0;
    let mut platform_referenced = 0;
    let mut unreferenceable = Vec::new();
    for copies in plan {
        let Some(input) = fork_manifest(parent, &copies)? else {
            unreferenceable.push(copies[0].pack_hash);
            continue;
        };
        // A Platform copy is recorded as the parent's chunk locator.
        if copies.iter().any(|m| m.storage == 0) {
            platform_referenced += 1;
        }
        svc.write_pack_manifest(&fork, &input).await?;
        written += 1;
    }

    let mut refs_written = Vec::new();
    let refs_plan = if unreferenceable.is_empty() {
        plan_refs(&svc.read_refs(parent).await?, &svc.read_refs(&fork).await?)
    } else {
        Vec::new()
    };
    for (name, want) in refs_plan {
        let new = hex::decode(&want).map_err(|e| Error::Config(format!("ref tip: {e}")))?;
        svc.write_ref_update(&fork, &name, &new, None, false)
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

    const PARENT: &str = "GM7ozWV1MNuAxyMnrf4JngAyGSDickvLznGi72WMp8EL";
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
        let f = fork_manifest(&parent(), &[&m]).unwrap().unwrap();
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
        let f = fork_manifest(&parent(), &[&m]).unwrap().unwrap();
        assert_eq!(f.storage, 1);
        assert_eq!(f.uris, ["https://x/p.pack", "ipfs://bafy", "s3://b/p.pack"]);
        // Nothing usable: no manifest.
        let empty = manifest("b", 3, 1, 1, &[]);
        assert!(fork_manifest(&parent(), &[&empty]).unwrap().is_none());
    }

    #[test]
    fn one_manifest_per_pack_with_every_copy_members_first() {
        let stranger = "Dd1m1JJM3M5DjBaXaCbC5hXBsU6248KHpGcBAtaHsqc7";
        let all = [
            // A former member's early, chunkless copy of pack 1 ...
            PackManifestInfo {
                owner_id: stranger.into(),
                ..manifest("hostile", 1, 0, 1, &[])
            },
            // ... and the maintainer's later one.
            manifest("plat", 1, 0, 5, &["https://x/p1"]),
            manifest("other", 2, 1, 2, &["https://y"]),
            manifest("had", 3, 0, 3, &[]),
            PackManifestInfo {
                kind: 1,
                ..manifest("locator", 4, 0, 1, &[])
            },
        ];
        let roles: RoleMap = [(UPLOADER.to_string(), crate::rules::v2::Role::Maintainer)].into();
        let has: BTreeSet<[u8; 32]> = [[3; 32]].into();
        let plan = plan_manifests(&all, &roles, &has);
        let ids: Vec<Vec<&str>> = plan
            .iter()
            .map(|g| g.iter().map(|m| m.document_id.as_str()).collect())
            .collect();
        // Pack 1 first (first upload t=1), the maintainer's copy ahead of the stranger's; the
        // browse locator and the pack the fork has are not copied.
        assert_eq!(ids, vec![vec!["plat", "hostile"], vec!["other"]]);
        let f = fork_manifest(&parent(), &plan[0]).unwrap().unwrap();
        let h = "01".repeat(32);
        assert_eq!(
            f.uris,
            [
                format!("platform://CORE/{PARENT}/{UPLOADER}/{h}"),
                format!("platform://CORE/{PARENT}/{stranger}/{h}"),
                "https://x/p1".to_string(),
            ],
            "every copy, the maintainer's first"
        );
    }

    #[test]
    fn refs_are_copied_once_and_the_forks_own_are_left_alone() {
        let r = |oid: &str| RefState::Resolved {
            oid: oid.into(),
            author: "a".into(),
            created_at: 1,
        };
        let parent = vec![
            ("refs/heads/main".to_string(), r("aa")),
            ("refs/heads/dev".to_string(), r("bb")),
            ("refs/heads/new".to_string(), r("cc")),
            ("refs/heads/gone".to_string(), RefState::Unborn),
        ];
        // A resumed fork: main copied, dev since moved by the fork's owner.
        let fork = vec![
            ("refs/heads/main".to_string(), r("aa")),
            ("refs/heads/dev".to_string(), r("dd")),
        ];
        assert_eq!(
            plan_refs(&parent, &fork),
            vec![("refs/heads/new".to_string(), "cc".to_string())]
        );
        assert_eq!(plan_refs(&parent, &[]).len(), 3);
    }
}
