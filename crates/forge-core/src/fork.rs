//! Forking a forge-v2 repository: a new `repo` with `forkOf` = the parent, the parent's
//! packs recorded in the fork **without re-uploading them**, and the parent's branches and
//! tags copied (never a mirror's PR heads, `refs/mirror/pull/*`).
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
//!
//! **Syncing** a fork (GitHub's "Sync fork", `dg repo sync`, P1-4) fast-forwards one of its
//! branches to its parent's: the parent's packs the fork does not record yet are recorded the
//! same way (by reference), then one ref update moves the branch from its tip to the parent's,
//! naming the old tip as `prevOid`. Only a fast-forward is written ([`sync_decision`]): a fork
//! branch with commits of its own is never moved, and the user is offered a pull request instead.

use std::collections::{BTreeMap, BTreeSet};

use crate::create::{create_repo, CreateRepoOpts, CreateRepoResult};
use crate::error::{Error, Result};
use crate::keystore::BridgeIdentity;
use crate::platform::{self, LoadedIdentity, PlatformClient};
use crate::repo::{
    order_copies, PackManifestInfo, PackManifestInput, RepoService, RoleMap, MANIFEST_URIS_V2,
};
use crate::rules::v2::Visibility;
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
    uris.retain(|u| u.len() <= MANIFEST_URIS_V2.max_item_len);
    uris.truncate(MANIFEST_URIS_V2.max_items);
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
        uris,
        supersedes: first.supersedes.clone(),
        tips: Vec::new(),
    }))
}

/// Whether any computer can read a pack from `uri` with no setup of its own: Platform chunks,
/// IPFS, or an https address on a public host. Not a loopback or private-network address,
/// plain http, a URL with credentials, or an `s3://` bucket (read only through a storage
/// profile for it), which a manifest records but no other reader follows (QW4-062).
#[must_use]
pub fn readable_by_anyone(uri: &str) -> bool {
    use crate::storage::publish::{publish_problem, PublishProblem};
    if uri.starts_with("platform://") || uri.starts_with("ipfs://") {
        return true;
    }
    uri.starts_with("https://")
        && matches!(
            publish_problem(uri),
            None | Some(PublishProblem::DevOnly | PublishProblem::TemporaryTunnel)
        )
}

/// Where `uri` is, for a message: `host[:port]` (never a user name or password in it),
/// `s3://bucket`, or the scheme alone.
fn place_of(uri: &str) -> String {
    if let Some(rest) = uri.strip_prefix("s3://") {
        return format!("s3://{}", rest.split('/').next().unwrap_or(rest));
    }
    reqwest::Url::parse(uri)
        .ok()
        .and_then(|u| {
            u.host_str().map(|h| match u.port() {
                Some(p) => format!("{h}:{p}"),
                None => h.to_string(),
            })
        })
        .unwrap_or_else(|| {
            uri.split_once("://")
                .map_or("an unparseable address", |(scheme, _)| scheme)
                .to_string()
        })
}

/// The packs among the fork manifests `planned` that no other computer can read: no copy is
/// [`readable_by_anyone`], and no pack that is supersedes it (a reader sets a superseded pack
/// aside when its consolidation reads). Returns how many, and the places their copies are
/// recorded at ([`place_of`], each once): a clone of the fork fails on them (E503) until the
/// parent records them at a public address (QW4-062). `(0, [])` when every pack is readable.
#[must_use]
pub fn unreadable_by_others(planned: &[PackManifestInput]) -> (usize, Vec<String>) {
    let readable = |m: &PackManifestInput| m.uris.iter().any(|u| readable_by_anyone(u));
    let covered: BTreeSet<[u8; 32]> = planned
        .iter()
        .filter(|m| readable(m))
        .flat_map(|m| m.supersedes.iter().copied())
        .collect();
    let mut n = 0;
    let mut places: Vec<String> = Vec::new();
    for m in planned
        .iter()
        .filter(|m| !readable(m) && !covered.contains(&m.pack_hash))
    {
        n += 1;
        for place in m.uris.iter().map(|u| place_of(u)) {
            if !places.contains(&place) {
                places.push(place);
            }
        }
    }
    (n, places)
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

/// Whether a fork copies a parent ref: its branches and tags, as a GitHub fork does. A
/// mirror's PR heads (`refs/mirror/pull/<n>/head`) and any other namespace stay the parent's.
pub fn forkable_ref(name: &str) -> bool {
    name.starts_with("refs/heads/") || name.starts_with("refs/tags/")
}

/// `description` without forge-import's mirror marker (`Mirror of github.com/o/r`, or a
/// trailing ` (mirror of github.com/o/r)`), which a fork would otherwise copy and then read as
/// a mirror. Only a marker the web reads as one is dropped (a `host[:port]/path` with no
/// spaces, two segments on github.com); anything else is kept as written.
pub fn without_mirror_marker(description: &str) -> String {
    let d = description.trim();
    let is_source = |src: &str| {
        let Some((host, path)) = src.split_once('/') else {
            return false;
        };
        let (name, port) = host.split_once(':').unwrap_or((host, ""));
        !name.is_empty()
            && name
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '-')
            && port.chars().all(|c| c.is_ascii_digit())
            && host.contains(':') != port.is_empty()
            && !path.is_empty()
            && !path.contains(|c: char| c.is_whitespace() || c == '(' || c == ')')
            && (name != "github.com" || path.split('/').count() == 2)
    };
    if let Some(src) = d.strip_prefix("Mirror of ") {
        if is_source(src) {
            return String::new();
        }
    }
    if let Some(at) = d.rfind("(mirror of ") {
        let inner = &d[at + "(mirror of ".len()..];
        if let Some(src) = inner.strip_suffix(')') {
            if is_source(src) {
                return d[..at].trim_end().to_string();
            }
        }
    }
    d.to_string()
}

/// The refs a fork still needs: every branch and tag of the parent ([`forkable_ref`]) that
/// resolves to a tip (a diverged ref at its provisional tip) and that the fork does not have
/// at all. A ref the fork already has is the fork owner's own from then on and is never
/// moved, so re-running an interrupted fork finishes it without undoing the owner's pushes.
/// `only_branch` (a short name, `main`): that branch alone, GitHub's "Copy the default branch
/// only" (`dg repo fork --default-branch-only`; the web's fork dialog offers the same). Parity:
/// forge-web `planRefs`, vectors `fork_refs__*`.
pub fn plan_refs(
    parent: &[(String, RefState)],
    fork: &[(String, RefState)],
    only_branch: Option<&str>,
) -> Vec<(String, String)> {
    let only = only_branch.map(|b| format!("refs/heads/{b}"));
    parent
        .iter()
        .filter(|(name, _)| forkable_ref(name))
        .filter(|(name, _)| only.as_ref().is_none_or(|o| o == name))
        .filter(|(name, _)| {
            !fork
                .iter()
                .any(|(n, s)| n == name && crate::rules::tip_of(s).is_some())
        })
        .filter_map(|(name, state)| Some((name.clone(), crate::rules::tip_of(state)?)))
        .collect()
}

/// What syncing a fork's branch with its parent's branch does (GitHub's "Sync fork").
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SyncDecision {
    /// The parent's branch has no tip (never pushed, or deleted): nothing to sync with.
    ParentEmpty,
    /// Both point at the same commit.
    UpToDate,
    /// The fork's branch is behind (its tip is an ancestor of the parent's), or it does not
    /// exist: it moves to the parent's tip. The only case that writes.
    FastForward,
    /// The fork's branch has the parent's tip and commits of its own: nothing to take.
    Ahead,
    /// Both moved (or share no history): no fast-forward. The fork's commits are never dropped;
    /// a pull request into the fork merges the parent's.
    Diverged,
}

/// [`SyncDecision`] from the two tips and their ancestry: `fork_in_parent`, the fork's tip is an
/// ancestor of the parent's (`git merge-base --is-ancestor <fork> <parent>`), `parent_in_fork`
/// the other way round. Tips compare without regard to case. Parity: forge-web `syncDecision`,
/// vectors `fork_sync__*`.
#[must_use]
pub fn sync_decision(
    fork_tip: Option<&str>,
    parent_tip: Option<&str>,
    fork_in_parent: bool,
    parent_in_fork: bool,
) -> SyncDecision {
    let Some(parent) = parent_tip.filter(|t| !t.is_empty()) else {
        return SyncDecision::ParentEmpty;
    };
    let Some(fork) = fork_tip.filter(|t| !t.is_empty()) else {
        return SyncDecision::FastForward;
    };
    if fork.eq_ignore_ascii_case(parent) {
        SyncDecision::UpToDate
    } else if fork_in_parent {
        SyncDecision::FastForward
    } else if parent_in_fork {
        SyncDecision::Ahead
    } else {
        SyncDecision::Diverged
    }
}

/// The git packs a fork records already, whoever recorded them (a sync may be run by any of its
/// maintainers and writers, and a pack is recorded once).
#[must_use]
pub fn recorded_packs(fork: &[PackManifestInfo]) -> BTreeSet<[u8; 32]> {
    fork.iter()
        .filter(|m| m.kind == u64::from(crate::pack::KIND_GIT_PACK))
        .map(|m| m.pack_hash)
        .collect()
}

/// The manifests a sync writes into the fork: one per parent git pack the fork does not record
/// yet ([`plan_manifests`], [`fork_manifest`]), and the packs no fork could name. When there are
/// any of those, the branch is not moved: it could name commits the fork cannot serve.
#[derive(Debug, Clone, Default)]
pub struct SyncManifests {
    /// What to write, in the parent's upload order.
    pub manifests: Vec<PackManifestInput>,
    /// Packs with no copy a fork could reference.
    pub unreferenceable: Vec<[u8; 32]>,
}

/// Plan [`SyncManifests`] from the parent's manifests (with its uploaders' `roles`, reader
/// order) and the fork's.
pub fn plan_sync_manifests(
    parent: &RepoRef,
    parent_manifests: &[PackManifestInfo],
    roles: &RoleMap,
    fork_manifests: &[PackManifestInfo],
) -> Result<SyncManifests> {
    let mut out = SyncManifests::default();
    for copies in plan_manifests(parent_manifests, roles, &recorded_packs(fork_manifests)) {
        match fork_manifest(parent, &copies)? {
            Some(m) => out.manifests.push(m),
            None => out.unreferenceable.push(copies[0].pack_hash),
        }
    }
    Ok(out)
}

/// What [`sync_fork`] wrote.
#[derive(Debug, Clone)]
pub struct SyncResult {
    /// Manifests written (the parent's new packs, by reference).
    pub manifests_written: usize,
    /// The ref update's document id.
    pub ref_update: String,
}

/// Fast-forward `ref_name` in `fork` from `fork_tip` (None: the branch does not exist) to
/// `parent_tip`: record `plan`'s manifests, then one ref update naming the old tip. The caller
/// has decided [`SyncDecision::FastForward`] and checked the signer may push the branch.
/// Refused before any write when some pack has no copy a fork could name. Re-running after an
/// interruption re-plans from what the fork then records, so nothing is paid for twice.
pub async fn sync_fork(
    svc: &RepoService<'_>,
    fork: &RepoRef,
    ref_name: &str,
    fork_tip: Option<&str>,
    parent_tip: &str,
    plan: &SyncManifests,
) -> Result<SyncResult> {
    fork.require_public("syncing a fork")?;
    if !plan.unreferenceable.is_empty() {
        return Err(Error::Config(format!(
            "{} of the parent's packs have no copy a fork can reference; push the branch from a full clone instead",
            plan.unreferenceable.len()
        )));
    }
    let new = hex::decode(parent_tip).map_err(|e| Error::Config(format!("parent tip: {e}")))?;
    let prev = fork_tip
        .map(hex::decode)
        .transpose()
        .map_err(|e| Error::Config(format!("fork tip: {e}")))?;
    for m in &plan.manifests {
        svc.write_pack_manifest(fork, m).await?;
    }
    let ref_update = svc
        .write_ref_update(fork, ref_name, &new, prev.as_deref(), false)
        .await?;
    Ok(SyncResult {
        manifests_written: plan.manifests.len(),
        ref_update,
    })
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
/// `default_branch_only`: copy `opts.default_branch` alone, not every branch and tag
/// ([`plan_refs`]).
pub async fn fork_repo(
    client: &PlatformClient,
    identity: &LoadedIdentity,
    bridge: &BridgeIdentity,
    parent: &RepoRef,
    opts: &CreateRepoOpts,
    journal_dir: &std::path::Path,
    default_branch_only: bool,
) -> Result<ForkResult> {
    // RC1 `repo_shape`: a fork is public (`forkIsPublic`) and so is its parent (the `forkOf`
    // reference requires the same visibility). Both are refused here, before anything is signed.
    parent.require_public("forking")?;
    if opts.visibility != Visibility::Public {
        return Err(Error::Config(
            "a fork is always public: forking into a private repository is not supported".into(),
        ));
    }
    let forge = parent.forge();
    let mut opts = opts.clone();
    opts.name = crate::resolve::repo_slug(&opts.name)?;
    opts.fork_of = Some(platform::decode_identifier(parent.id())?);
    let owner = identity.id();

    // A repo of the signer's with this name already exists: continue only if it is a fork
    // of this parent (an interrupted fork). Anything else would have the parent's manifests
    // and refs written into an unrelated repository, permanently.
    if let Some(existing) = crate::resolve::find_named(
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
        plan_refs(
            &svc.read_refs(parent).await?,
            &svc.read_refs(&fork).await?,
            default_branch_only.then_some(opts.default_branch.as_str()),
        )
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

    const PARENT: &str = "A2KL77ngVM1ft1t1em2XKt1rWCBZANdAJMyfWrDGCcd1";
    const UPLOADER: &str = "HwhCv9N5BHsbGNLzDR4tnZnqJ6VxtwJSLsM4aUWn2Tnr";

    fn parent() -> RepoRef {
        RepoRef {
            forge: ForgeIds::test_forge(),
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
            uris: uris.iter().map(|u| (*u).to_string()).collect(),
            supersedes: Vec::new(),
            tips: Vec::new(),
            created_at_block_height: 0,
        }
    }

    /// QW4-062: a pack recorded only at a loopback / private address, plain http or an s3
    /// bucket is one no other computer reads, so a fork of it can't be cloned.
    #[test]
    fn a_pack_only_this_machine_reads_is_named_before_forking() {
        for readable in [
            "platform://CORE/R/O/ab",
            "ipfs://bafyabc",
            "https://packs.example.org/ab",
        ] {
            assert!(readable_by_anyone(readable), "{readable}");
        }
        for unreadable in [
            "https://127.0.0.1:9000/qa/ab",
            "http://packs.example.org/ab",
            "s3://qa4-cli-dx/packs/ab",
            "https://user:pw@packs.example.org/ab",
        ] {
            assert!(!readable_by_anyone(unreadable), "{unreadable}");
        }
        let input = |hash: u8, uris: &[&str], supersedes: &[u8]| PackManifestInput {
            pack_hash: [hash; 32],
            kind: 0,
            size_bytes: 1,
            object_count: 1,
            chunk_count: 0,
            storage: 1,
            uris: uris.iter().map(|u| (*u).to_string()).collect(),
            supersedes: supersedes.iter().map(|h| [*h; 32]).collect(),
            tips: Vec::new(),
        };
        let local = input(
            1,
            &[
                "https://127.0.0.1:9000/qa4-cli-dx/ab",
                "s3://qa4-cli-dx/ab",
                "https://user:secret@packs.example.org/ab",
            ],
            &[],
        );
        let public = input(
            2,
            &[
                "https://127.0.0.1:9000/qa4-cli-dx/cd",
                "https://packs.example.org/cd",
            ],
            &[],
        );
        let (n, places) = unreadable_by_others(&[local.clone(), public.clone()]);
        assert_eq!(n, 1);
        // Never the credentials in the URL.
        assert_eq!(
            places,
            ["127.0.0.1:9000", "s3://qa4-cli-dx", "packs.example.org"]
        );
        assert_eq!(unreadable_by_others(&[public]), (0, Vec::new()));
        // A readable consolidation that supersedes it: a clone sets it aside, so no warning.
        let consolidated = input(3, &["https://packs.example.org/ef"], &[1]);
        assert_eq!(
            unreadable_by_others(&[local, consolidated]),
            (0, Vec::new())
        );
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
        let stranger = "7Ej2YTftCL23mVwvhviak8ZJMmpqcsVj7CU5KPxzyy4h";
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
            plan_refs(&parent, &fork, None),
            vec![("refs/heads/new".to_string(), "cc".to_string())]
        );
        assert_eq!(plan_refs(&parent, &[], None).len(), 3);
    }

    #[test]
    fn a_fork_of_a_mirror_drops_the_mirror_marker_from_its_description() {
        assert_eq!(
            without_mirror_marker("Dash Improvement Proposals (mirror of github.com/dashpay/dips)"),
            "Dash Improvement Proposals"
        );
        assert_eq!(
            without_mirror_marker("Mirror of github.com/dashpay/dash"),
            ""
        );
        assert_eq!(
            without_mirror_marker("Mirror of gitlab.example.com:8443/g/sub/p"),
            ""
        );
        // Not a marker the web reads: kept as written.
        assert_eq!(
            without_mirror_marker("Tools (mirror of github.com/a/b/c)"),
            "Tools (mirror of github.com/a/b/c)"
        );
        assert_eq!(
            without_mirror_marker("Tools (mirror of github.com/a/b"),
            "Tools (mirror of github.com/a/b"
        );
        assert_eq!(without_mirror_marker("  Plain  "), "Plain");
    }

    #[test]
    fn a_fork_copies_branches_and_tags_but_not_a_mirrors_pr_heads() {
        let r = |oid: &str| RefState::Resolved {
            oid: oid.into(),
            author: "a".into(),
            created_at: 1,
        };
        let parent = vec![
            ("refs/heads/master".to_string(), r("aa")),
            ("refs/tags/v1".to_string(), r("bb")),
            ("refs/mirror/pull/12/head".to_string(), r("cc")),
            ("refs/notes/commits".to_string(), r("dd")),
        ];
        let names: Vec<String> = plan_refs(&parent, &[], None)
            .into_iter()
            .map(|(n, _)| n)
            .collect();
        assert_eq!(names, vec!["refs/heads/master", "refs/tags/v1"]);
        // GitHub's "Copy the default branch only": that branch, never its tags.
        assert_eq!(
            plan_refs(&parent, &[], Some("master")),
            vec![("refs/heads/master".to_string(), "aa".to_string())]
        );
        assert!(plan_refs(&parent, &[], Some("main")).is_empty());
    }

    #[test]
    fn a_sync_fast_forwards_only() {
        use SyncDecision::{Ahead, Diverged, FastForward, ParentEmpty, UpToDate};
        assert_eq!(sync_decision(Some("aa"), None, false, false), ParentEmpty);
        assert_eq!(sync_decision(None, Some("bb"), false, false), FastForward);
        assert_eq!(
            sync_decision(Some("AA"), Some("aa"), false, false),
            UpToDate
        );
        assert_eq!(
            sync_decision(Some("aa"), Some("bb"), true, false),
            FastForward
        );
        assert_eq!(sync_decision(Some("aa"), Some("bb"), false, true), Ahead);
        assert_eq!(
            sync_decision(Some("aa"), Some("bb"), false, false),
            Diverged
        );
    }

    #[test]
    fn a_sync_records_only_the_parents_new_packs() {
        let parent_packs = [
            manifest("old", 1, 0, 1, &[]),
            manifest("new", 2, 0, 5, &[]),
            manifest("ext", 3, 1, 6, &[]),
        ];
        // The fork records pack 1 (copied at fork time by someone else than the syncer).
        let fork_packs = [PackManifestInfo {
            owner_id: "7Ej2YTftCL23mVwvhviak8ZJMmpqcsVj7CU5KPxzyy4h".into(),
            ..manifest("f1", 1, 1, 2, &["platform://x"])
        }];
        let plan =
            plan_sync_manifests(&parent(), &parent_packs, &RoleMap::new(), &fork_packs).unwrap();
        assert_eq!(
            plan.manifests
                .iter()
                .map(|m| m.pack_hash)
                .collect::<Vec<_>>(),
            vec![[2; 32]]
        );
        // Pack 3 has no copy a fork could name.
        assert_eq!(plan.unreferenceable, vec![[3; 32]]);
    }
}
