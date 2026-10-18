//! Enumerate repository blobs from trusted manifests and pin them without publishing records.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;
use std::time::Duration;

use futures::{stream, StreamExt as _};
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use zeroize::Zeroizing;

use crate::backends::{
    cid::{cid_v1_raw_leaves, normalize_cid},
    IpfsBackend, Uri,
};
use crate::collab::v2::Collab;
use crate::error::{Error, Result};
use crate::keyring::Keyring;
use crate::repo::{ArtifactRead, PackManifestInfo, RepoService, RoleMap};
use crate::rules::v2::{Role, Visibility};
use crate::scope::RepoRef;
use crate::storage::PackReader;

/// What a target stores. Superseded packs remain targets.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum PinWhat {
    /// An artifact of any kind.
    Pack { kind: u64 },
    /// One release's stored file (ciphertext for a sealed release).
    ReleaseAsset { tag: String, name: String },
}

/// A candidate's provenance controls whether a network import is allowed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PinCandidate {
    pub cid: String,
    pub swarm_allowed: bool,
}

/// One accepted pack hash (or release blob), with size counted once.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PinTarget {
    pub candidates: Vec<PinCandidate>,
    pub size: u64,
    pub sha256: String,
    pub what: PinWhat,
    #[serde(skip)]
    copies: Vec<PackManifestInfo>,
    #[serde(skip)]
    uris: Vec<String>,
}

/// A plan is read-only: making one writes neither pins nor Platform documents.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PinPlan {
    pub targets: Vec<PinTarget>,
    pub not_on_ipfs: usize,
    pub members_only_skipped: usize,
    pub unreadable_skipped: usize,
    pub invalid_cids_skipped: usize,
    pub conflicting_cids_skipped: usize,
    pub stranger_copies_ignored: usize,
    pub needs_consent: bool,
}

impl PinPlan {
    pub fn bytes(&self) -> u64 {
        self.targets
            .iter()
            .fold(0u64, |n, t| n.saturating_add(t.size))
    }
}

/// The portable enumeration input, also consumed by the shared web conformance vectors.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PinInput {
    pub owner: String,
    pub roles: RoleMap,
    pub manifests: Vec<PinManifest>,
    #[serde(default)]
    pub releases: Vec<PinRelease>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PinManifest {
    pub id: String,
    pub owner: String,
    pub sha256: String,
    pub kind: u64,
    pub size: u64,
    pub uris: Vec<String>,
    #[serde(default)]
    pub created_at: u64,
    /// Resolved by the same key/decryption path as a fetch, before enumeration.
    pub readable: bool,
    /// No copy could be read to determine visibility (distinct from missing keys).
    #[serde(default)]
    pub unreadable: bool,
    #[serde(default)]
    pub sensitive: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PinRelease {
    pub owner: String,
    pub tag: String,
    pub assets: Vec<PinAsset>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PinAsset {
    pub name: String,
    pub sha256: String,
    pub size: u64,
    pub uris: Vec<String>,
    #[serde(default)]
    pub sealed_sha256: Option<String>,
    #[serde(default)]
    pub sealed_size_bytes: Option<u64>,
}

fn authorized(owner: &str, identity: &str, roles: &RoleMap) -> bool {
    identity == owner
        || matches!(
            roles.get(identity),
            Some(Role::Maintainer | Role::Writer | Role::Bot)
        )
}

fn cid(uri: &str) -> Option<String> {
    let raw = if uri.starts_with("ipfs://") {
        IpfsBackend::cid_of(&Uri(uri.to_string())).ok()?
    } else {
        let url = reqwest::Url::parse(uri).ok()?;
        if url.scheme() != "https" || url.query().is_some() || url.fragment().is_some() {
            return None;
        }
        let found = super::read::gateway_cid(uri)?;
        if url.path() != format!("/ipfs/{found}") {
            return None;
        }
        found
    };
    normalize_cid(&raw)
}

fn candidates(plan: &mut PinPlan, uris: &[String], swarm_allowed: bool) -> Vec<PinCandidate> {
    uris.iter()
        .filter_map(|uri| {
            let found = cid(uri);
            if found.is_none() && (uri.starts_with("ipfs://") || uri.contains("/ipfs/")) {
                plan.invalid_cids_skipped += 1;
            }
            found.map(|cid| PinCandidate { cid, swarm_allowed })
        })
        .collect()
}

fn order_candidates(target: &mut PinTarget) {
    target
        .candidates
        .sort_by(|a, b| (!a.swarm_allowed, &a.cid).cmp(&(!b.swarm_allowed, &b.cid)));
    let mut seen = BTreeSet::new();
    target.candidates.retain(|c| seen.insert(c.cid.clone()));
}

fn add_target(plan: &mut PinPlan, mut target: PinTarget) {
    order_candidates(&mut target);
    if target.candidates.is_empty() {
        plan.not_on_ipfs += 1;
    } else if let Some(existing) = plan
        .targets
        .iter_mut()
        .find(|t| t.sha256 == target.sha256 && t.size == target.size)
    {
        existing.candidates.extend(target.candidates);
        existing.uris.extend(target.uris);
        order_candidates(existing);
    } else {
        plan.targets.push(target);
    }
}

/// Resolve CID metadata only after collecting all authorized claims: an outsider's
/// earlier record must never displace a writer's hash or size, or fail the plan.
fn drop_conflicts(plan: &mut PinPlan) {
    let mut claims = BTreeMap::new();
    for target in &plan.targets {
        for candidate in target.candidates.iter().filter(|c| c.swarm_allowed) {
            claims
                .entry(candidate.cid.clone())
                .or_insert((target.sha256.clone(), target.size));
        }
    }
    for target in &mut plan.targets {
        target.candidates.retain(|candidate| {
            let claim = claims
                .entry(candidate.cid.clone())
                .or_insert((target.sha256.clone(), target.size));
            let keep = claim.0 == target.sha256 && claim.1 == target.size;
            if !keep {
                plan.conflicting_cids_skipped += 1;
            }
            keep
        });
    }
    plan.targets.retain(|target| {
        if target.candidates.is_empty() {
            plan.not_on_ipfs += 1;
            false
        } else {
            true
        }
    });
}

/// Pure enumeration. A stranger can add addresses for a writer's hash, never a new hash,
/// kind, size or decryption entitlement. A bot's packs count (it pushes under a maintainer's
/// grant, and a mirrored repository's packs are all a bot's); triagers and readers cannot
/// authorize storage by writing a manifest.
#[allow(clippy::too_many_lines)] // packs and releases share provenance and conflict resolution
pub fn plan_targets(input: &PinInput) -> PinPlan {
    let mut plan = PinPlan::default();
    let mut groups: BTreeMap<String, Vec<&PinManifest>> = BTreeMap::new();
    for m in &input.manifests {
        groups
            .entry(m.sha256.to_ascii_lowercase())
            .or_default()
            .push(m);
    }
    for group in groups.values_mut() {
        group.sort_by_key(|m| (m.created_at, &m.id));
        let Some(writer) = group
            .iter()
            .copied()
            .filter(|m| authorized(&input.owner, &m.owner, &input.roles))
            .min_by_key(|m| {
                (
                    m.owner != input.owner && input.roles.get(&m.owner) != Some(&Role::Maintainer),
                    m.created_at,
                    &m.id,
                )
            })
        else {
            plan.stranger_copies_ignored += group.len();
            continue;
        };
        let mut target = PinTarget {
            candidates: Vec::new(),
            size: writer.size,
            sha256: writer.sha256.to_ascii_lowercase(),
            what: PinWhat::Pack { kind: writer.kind },
            copies: Vec::new(),
            uris: Vec::new(),
        };
        for copy in group.iter().filter(|m| m.kind == writer.kind) {
            let found = candidates(
                &mut plan,
                &copy.uris,
                authorized(&input.owner, &copy.owner, &input.roles),
            );
            if copy.size != writer.size {
                plan.conflicting_cids_skipped += found.len();
                continue;
            }
            target.candidates.extend(found);
            target.uris.extend(copy.uris.iter().cloned());
        }
        // No network access or entitlement check is needed for non-IPFS packs.
        if target.candidates.is_empty() {
            plan.not_on_ipfs += 1;
            continue;
        }
        if writer.unreadable {
            plan.unreadable_skipped += 1;
            continue;
        }
        if !writer.readable {
            plan.members_only_skipped += 1;
            continue;
        }
        plan.needs_consent |= writer.sensitive;
        add_target(&mut plan, target);
    }
    for release in &input.releases {
        if !authorized(&input.owner, &release.owner, &input.roles) {
            continue;
        }
        for asset in &release.assets {
            let (hash, size) = match (&asset.sealed_sha256, asset.sealed_size_bytes) {
                (Some(hash), Some(size)) => {
                    plan.needs_consent = true;
                    (hash.as_str(), size)
                }
                (None, None) => (asset.sha256.as_str(), asset.size),
                _ => continue,
            };
            let candidates = candidates(&mut plan, &asset.uris, true);
            add_target(
                &mut plan,
                PinTarget {
                    candidates,
                    size,
                    sha256: hash.to_ascii_lowercase(),
                    what: PinWhat::ReleaseAsset {
                        tag: release.tag.clone(),
                        name: asset.name.clone(),
                    },
                    copies: Vec::new(),
                    uris: asset.uris.clone(),
                },
            );
        }
    }
    drop_conflicts(&mut plan);
    plan
}

/// The reader's keys and release reader. Shared file keys grant access to their pack alone.
pub struct PinReaderContext<'a> {
    pub reader: &'a PackReader,
    pub collab: &'a Collab<'a>,
    pub members: Option<Arc<Keyring>>,
    pub shared: BTreeMap<[u8; 32], Zeroizing<[u8; 32]>>,
}

/// Enumerate every authorized pack and release, checking sealed packs with the fetch's
/// actual open path. Plain public packs need no download during planning.
#[allow(clippy::too_many_lines)] // enumeration shares the fetch visibility and release rules
pub async fn pin_targets(
    svc: &RepoService<'_>,
    repo: &RepoRef,
    ctx: &PinReaderContext<'_>,
) -> Result<PinPlan> {
    let manifests = svc.read_pack_manifests(repo).await?;
    let roles = svc.copy_roles(repo).await?;
    let contract = svc.repo_contract(repo).await?;
    let conversion = svc.conversion(repo).await?;
    let published = if conversion.is_some() {
        svc.public_keys(repo).await
    } else {
        None
    };
    let mut rows = Vec::new();
    let mut visibility = BTreeMap::new();
    let mut writers: Vec<_> = manifests
        .iter()
        .filter(|m| authorized(repo.owner_id(), &m.owner_id, &roles))
        .collect();
    writers.sort_by_key(|m| {
        (
            m.owner_id != repo.owner_id() && roles.get(&m.owner_id) != Some(&Role::Maintainer),
            m.created_at,
            &m.document_id,
        )
    });
    let mut mirrors = BTreeMap::new();
    for m in &writers {
        if !mirrors.contains_key(&m.pack_hash) {
            let uris = svc
                .pin_mirror_uris(repo, &hex::encode(m.pack_hash), &roles)
                .await?;
            mirrors.insert(m.pack_hash, uris);
        }
    }
    for m in writers {
        if visibility.contains_key(&m.pack_hash) {
            continue;
        }
        let bounded_copies: Vec<_> = manifests
            .iter()
            .filter(|c| c.pack_hash == m.pack_hash && c.kind == m.kind)
            .map(|c| PackManifestInfo {
                size_bytes: m.size_bytes,
                ..c.clone()
            })
            .collect();
        let copies: Vec<_> = bounded_copies.iter().collect();
        let has_cid = manifests
            .iter()
            .filter(|c| {
                c.pack_hash == m.pack_hash && c.kind == m.kind && c.size_bytes == m.size_bytes
            })
            .flat_map(|c| &c.uris)
            .chain(mirrors.get(&m.pack_hash).into_iter().flatten())
            .any(|uri| cid(uri).is_some());
        if !has_cid {
            visibility.insert(m.pack_hash, (true, false, false));
            continue;
        }
        let members_kind = m.kind >= u64::from(crate::pack::KIND_SEALED_BASE);
        let maybe_sealed = repo.visibility == Visibility::Private
            || members_kind
            || m.kind == u64::from(crate::pack::KIND_RELEASE_ASSETS)
            || conversion.as_ref().is_some_and(|c| {
                copies
                    .iter()
                    .any(|m| c.may_be_sealed(m.created_at_block_height))
            });
        let mut readable = true;
        let mut sensitive = repo.visibility == Visibility::Private || members_kind;
        if members_kind && ctx.members.is_none() && !ctx.shared.contains_key(&m.pack_hash) {
            readable = false;
        } else if maybe_sealed {
            let mut fetched = None;
            let head = if let Some(head) = svc.pack_head(repo, &contract, &copies, ctx.reader).await
            {
                head
            } else if let Ok((bytes, _)) = svc
                .fetch_best_copy_or_mirror(repo, &contract, &copies, &roles, ctx.reader)
                .await
            {
                let head = bytes
                    .iter()
                    .take(crate::private::pack::HEADER_LEN)
                    .copied()
                    .collect();
                fetched = Some(bytes);
                head
            } else {
                visibility.insert(m.pack_hash, (false, sensitive, true));
                continue;
            };
            let sealed = !matches!(crate::private::sniff(&head), crate::private::Head::Plain);
            sensitive |= sealed;
            if sealed {
                let has_key = match crate::private::sniff(&head) {
                    crate::private::Head::Sealed { epoch } => {
                        let keys = if members_kind || repo.visibility == Visibility::Private {
                            ctx.members.as_deref()
                        } else {
                            published.as_deref()
                        };
                        keys.is_some_and(|k| k.epoch_keys(epoch).is_some())
                            || ctx.shared.contains_key(&m.pack_hash)
                    }
                    crate::private::Head::OtherVersion(version)
                        if members_kind && version == crate::private::branch_key::PACK_VERSION =>
                    {
                        ctx.members
                            .as_ref()
                            .and_then(|k| k.branch_ring())
                            .zip(crate::private::branch_key::sniff_kcv(&head))
                            .is_some_and(|(ring, kcv)| ring.branch_of_kcv(kcv).is_some())
                    }
                    _ => false,
                };
                readable = has_key;
                if has_key {
                    let bytes = if let Some(bytes) = fetched {
                        bytes
                    } else if let Ok((bytes, _)) = svc
                        .fetch_best_copy_or_mirror(repo, &contract, &copies, &roles, ctx.reader)
                        .await
                    {
                        bytes
                    } else {
                        visibility.insert(m.pack_hash, (false, sensitive, true));
                        continue;
                    };
                    if let Some(key) = ctx.shared.get(&m.pack_hash) {
                        readable =
                            crate::private::pack::open_with_file_key(&bytes, m.size_bytes, key)
                                .is_ok();
                    } else if members_kind {
                        let keys = ctx.members.as_ref().expect("members key checked above");
                        readable = matches!(
                            svc.open_members_pack(repo, keys, &copies, m.size_bytes, bytes)
                                .await,
                            Ok(ArtifactRead::Bytes(_))
                        );
                    } else {
                        readable = matches!(
                            svc.open_or_skip(repo, &copies, m.size_bytes, bytes).await,
                            Ok(ArtifactRead::Bytes(_))
                        );
                    }
                }
            } else if members_kind || repo.visibility == Visibility::Private {
                readable = false;
            }
        }
        visibility.insert(m.pack_hash, (readable, sensitive, false));
    }
    for m in &manifests {
        let (readable, sensitive, unreadable) = visibility
            .get(&m.pack_hash)
            .copied()
            .unwrap_or((false, false, false));
        rows.push(PinManifest {
            id: m.document_id.clone(),
            owner: m.owner_id.clone(),
            sha256: hex::encode(m.pack_hash),
            kind: m.kind,
            size: m.size_bytes,
            uris: m.uris.clone(),
            created_at: m.created_at,
            readable,
            unreadable,
            sensitive,
        });
    }
    let mut mirror_rows = Vec::new();
    let mut mirror_sources: Vec<_> = rows.iter().collect();
    mirror_sources.sort_by_key(|row| {
        (
            row.owner != repo.owner_id() && roles.get(&row.owner) != Some(&Role::Maintainer),
            row.created_at,
            &row.id,
        )
    });
    for row in mirror_sources {
        if !authorized(repo.owner_id(), &row.owner, &roles) {
            continue;
        }
        if mirror_rows
            .iter()
            .any(|m: &PinManifest| m.sha256 == row.sha256)
        {
            continue;
        }
        let hash: [u8; 32] = hex::decode(&row.sha256)
            .expect("manifest hash")
            .try_into()
            .expect("32 bytes");
        let uris = mirrors.get(&hash).cloned().unwrap_or_default();
        mirror_rows.push(PinManifest {
            id: format!("mirror:{}", row.id),
            owner: String::new(),
            uris,
            ..row.clone()
        });
    }
    rows.extend(mirror_rows.into_iter().filter(|m| !m.uris.is_empty()));
    let releases = ctx.collab.releases(repo).await?;
    let mut release_rows = Vec::new();
    let mut unreadable_releases = BTreeSet::new();
    for release in releases.current.iter().chain(&releases.previous) {
        if !authorized(repo.owner_id(), &release.publisher, &roles) {
            continue;
        }
        let assets = if let Some(sealed) = release
            .sealed
            .as_ref()
            .filter(|s| s.fields.asset_manifest.is_some())
        {
            let Some(hash) = sealed.fields.asset_manifest_hash() else {
                continue;
            };
            if visibility
                .get(&hash)
                .is_some_and(|(readable, _, _)| !readable)
            {
                continue;
            }
            let Ok(manifest) = ctx.collab.release_manifest(repo, &sealed.fields).await else {
                // An unavailable asset-list pack must not discard other packs' plans.
                unreadable_releases.insert(hash);
                continue;
            };
            manifest
                .assets
                .into_iter()
                .map(|a| PinAsset {
                    name: a.name,
                    sha256: a.sha256,
                    size: a.size_bytes,
                    uris: a.uris,
                    sealed_sha256: a.sealed_sha256,
                    sealed_size_bytes: a.sealed_size_bytes,
                })
                .collect()
        } else {
            release
                .assets
                .iter()
                .map(|a| PinAsset {
                    name: a.name.clone(),
                    sha256: a.sha256.clone(),
                    size: a.size_bytes,
                    uris: a.uris.clone(),
                    sealed_sha256: None,
                    sealed_size_bytes: None,
                })
                .collect()
        };
        release_rows.push(PinRelease {
            owner: release.publisher.clone(),
            tag: release.tag_name.clone(),
            assets,
        });
    }
    let mut plan = plan_targets(&PinInput {
        owner: repo.owner_id().to_string(),
        roles,
        manifests: rows,
        releases: release_rows,
    });
    plan.unreadable_skipped += unreadable_releases.len();
    for target in &mut plan.targets {
        if let PinWhat::Pack { kind } = &target.what {
            target.copies = manifests
                .iter()
                .filter(|m| hex::encode(m.pack_hash) == target.sha256 && m.kind == *kind)
                .map(|m| PackManifestInfo {
                    size_bytes: target.size,
                    ..m.clone()
                })
                .collect();
        }
    }
    Ok(plan)
}

/// Verified bytes and the host/source that served them.
pub struct PinBytes {
    pub bytes: Vec<u8>,
    pub from: String,
}

#[async_trait::async_trait]
pub trait PinReader: Sync {
    async fn fetch(&self, target: &PinTarget) -> Result<PinBytes>;
}

/// Uses the clone's role-ordered copies and mirror fallback for packs, the same verified
/// PackReader for release assets. Ciphertext is retained; decrypted bytes are never uploaded.
pub struct RepoPinReader<'a> {
    pub service: &'a RepoService<'a>,
    pub repo: &'a RepoRef,
    pub reader: &'a PackReader,
    pub roles: RoleMap,
}

#[async_trait::async_trait]
impl PinReader for RepoPinReader<'_> {
    async fn fetch(&self, target: &PinTarget) -> Result<PinBytes> {
        if target.copies.is_empty() {
            let served = self
                .reader
                .race(&target.uris, &target.sha256, Some(target.size), None)
                .await
                .map_err(Error::from)?;
            return Ok(PinBytes {
                bytes: served.bytes,
                from: served.by,
            });
        }
        let contract = self.service.repo_contract(self.repo).await?;
        let copies: Vec<_> = target.copies.iter().collect();
        let (bytes, from, _) = self
            .service
            .fetch_pin_copy_or_mirror(self.repo, &contract, &copies, &self.roles, self.reader)
            .await?;
        Ok(PinBytes { bytes, from })
    }
}

#[derive(Debug, Clone)]
pub struct PinOptions {
    pub byte_budget: u64,
    pub max_parallel: usize,
    pub swarm_timeout: Duration,
    pub remote_name: String,
}

impl Default for PinOptions {
    fn default() -> Self {
        Self {
            byte_budget: 512 * 1024 * 1024,
            max_parallel: 4,
            swarm_timeout: Duration::from_secs(600),
            remote_name: "forge".into(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum PinOutcome {
    Pinned { from: String },
    Already,
    Failed { why: String },
}

#[derive(Debug, Clone)]
pub enum PinEvent {
    Start {
        i: usize,
        n: usize,
        target: PinTarget,
    },
    Done {
        i: usize,
        outcome: PinOutcome,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PinFailure {
    pub cid: String,
    pub why: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PinReport {
    pub pinned: usize,
    pub already: usize,
    pub failed: Vec<PinFailure>,
    pub bytes: u64,
}

#[allow(clippy::too_many_lines)] // candidate trust gates resume, verified uploads and swarm fallback
async fn pin_one(
    target: &PinTarget,
    backend: &IpfsBackend,
    reader: &(impl PinReader + ?Sized),
    opts: &PinOptions,
) -> Result<PinOutcome> {
    let candidates: Vec<_> = target
        .candidates
        .iter()
        .filter_map(|candidate| {
            normalize_cid(&candidate.cid).map(|cid| PinCandidate {
                cid,
                swarm_allowed: candidate.swarm_allowed,
            })
        })
        .collect();
    let remote = backend.config().pinning.is_some();
    let name = format!(
        "{}:{}",
        opts.remote_name,
        target.sha256.chars().take(12).collect::<String>()
    );
    let mut last_error =
        Error::Io("no candidate matches verified bytes or permits a swarm pin".into());
    // Only writer-attested CIDs can be trusted without fetching the writer's bytes.
    if remote {
        for candidate in candidates.iter().filter(|c| c.swarm_allowed) {
            if let Err(error) = backend.remote_pin(&candidate.cid, &name).await {
                last_error = error;
            } else {
                return Ok(PinOutcome::Pinned {
                    from: "pinning service".into(),
                });
            }
        }
    } else {
        for candidate in candidates.iter().filter(|c| c.swarm_allowed) {
            match backend.is_pinned(&candidate.cid).await {
                Ok(true) => return Ok(PinOutcome::Already),
                Ok(false) => {}
                Err(error) => last_error = error,
            }
        }
    }
    match reader.fetch(target).await {
        Ok(fetched) => {
            if fetched.bytes.len() as u64 != target.size
                || hex::encode(Sha256::digest(&fetched.bytes)) != target.sha256
            {
                return Err(Error::Io(
                    "fetched blob does not match the writer's hash and size".into(),
                ));
            }
            let derived = cid_v1_raw_leaves(&fetched.bytes);
            if candidates.iter().any(|candidate| candidate.cid == derived) {
                // Stranger and mirror CIDs enter here only after verification and derivation.
                if remote {
                    backend.remote_pin(&derived, &name).await?;
                    return Ok(PinOutcome::Pinned {
                        from: "pinning service".into(),
                    });
                }
                if backend.is_pinned(&derived).await? {
                    return Ok(PinOutcome::Already);
                }
                let added = backend.add(&fetched.bytes).await?;
                if normalize_cid(&added).as_deref() != Some(derived.as_str()) {
                    let _ = backend.unpin(&added).await;
                    return Err(Error::Io(
                        "kubo returned a different CID for verified bytes".into(),
                    ));
                }
                if !backend.is_pinned(&derived).await? {
                    return Err(Error::Io("kubo did not confirm the uploaded pin".into()));
                }
                return Ok(PinOutcome::Pinned { from: fetched.from });
            }
        }
        Err(error) => last_error = error,
    }
    if !remote {
        let limit = target
            .size
            .saturating_add(target.size / 10)
            .saturating_add(1024 * 1024);
        for candidate in candidates.iter().filter(|c| c.swarm_allowed) {
            if let Err(error) = backend
                .pin_add_bounded(&candidate.cid, limit, opts.swarm_timeout)
                .await
            {
                last_error = error;
            } else {
                return Ok(PinOutcome::Pinned {
                    from: "IPFS swarm".into(),
                });
            }
        }
    }
    Err(last_error)
}

/// Resume from pin/ls, bounding both concurrent requests and their advertised byte sizes.
/// A target larger than the byte budget runs exclusively so large CLI blobs can progress.
pub async fn pin_repo(
    plan: &PinPlan,
    backend: &IpfsBackend,
    reader: &(impl PinReader + ?Sized),
    opts: &PinOptions,
    progress: impl Fn(PinEvent) + Sync,
) -> PinReport {
    let budget = opts.byte_budget.clamp(1, u64::from(u32::MAX));
    let permits = Arc::new(tokio::sync::Semaphore::new(
        usize::try_from(budget).unwrap_or(usize::MAX),
    ));
    let results = stream::iter(plan.targets.iter().enumerate().map(|(index, target)| {
        let permits = Arc::clone(&permits);
        let progress = &progress;
        async move {
            let charge = u32::try_from(target.size.max(1).min(budget)).expect("budget fits u32");
            let _permit = permits
                .acquire_many(charge)
                .await
                .expect("semaphore stays open");
            let i = index + 1;
            progress(PinEvent::Start {
                i,
                n: plan.targets.len(),
                target: target.clone(),
            });
            let outcome = pin_one(target, backend, reader, opts)
                .await
                .unwrap_or_else(|e| PinOutcome::Failed {
                    why: crate::user_error::one_line(&e.to_string()),
                });
            progress(PinEvent::Done {
                i,
                outcome: outcome.clone(),
            });
            (target, outcome)
        }
    }))
    .buffer_unordered(opts.max_parallel.max(1));
    futures::pin_mut!(results);
    let mut report = PinReport::default();
    while let Some((target, outcome)) = results.next().await {
        match outcome {
            PinOutcome::Pinned { .. } => {
                report.pinned += 1;
                report.bytes = report.bytes.saturating_add(target.size);
            }
            PinOutcome::Already => {
                report.already += 1;
                report.bytes = report.bytes.saturating_add(target.size);
            }
            PinOutcome::Failed { why } => report.failed.push(PinFailure {
                cid: target
                    .candidates
                    .first()
                    .map(|c| c.cid.clone())
                    .unwrap_or_default(),
                why,
            }),
        }
    }
    report
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backends::ipfs::IpfsConfig;
    use crate::test_http::{serve, Reply};
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct Bytes(Vec<u8>);
    #[async_trait::async_trait]
    impl PinReader for Bytes {
        async fn fetch(&self, _: &PinTarget) -> Result<PinBytes> {
            Ok(PinBytes {
                bytes: self.0.clone(),
                from: "test host".into(),
            })
        }
    }

    fn target(bytes: &[u8]) -> PinTarget {
        PinTarget {
            candidates: vec![PinCandidate {
                cid: cid_v1_raw_leaves(bytes),
                swarm_allowed: true,
            }],
            size: bytes.len() as u64,
            sha256: hex::encode(Sha256::digest(bytes)),
            what: PinWhat::Pack { kind: 0 },
            copies: Vec::new(),
            uris: Vec::new(),
        }
    }

    struct Unreachable;
    #[async_trait::async_trait]
    impl PinReader for Unreachable {
        async fn fetch(&self, _: &PinTarget) -> Result<PinBytes> {
            Err(Error::Io("no copy reachable".into()))
        }
    }

    #[tokio::test]
    async fn untrusted_cids_never_reach_the_swarm_or_resume_without_verified_bytes() {
        let mut t = target(b"writer bytes");
        t.candidates[0].swarm_allowed = false;
        t.candidates[0].cid = cid_v1_raw_leaves(b"stranger data");
        let (url, log) = serve(|_| Reply::new(200, "{}"));
        let backend = IpfsBackend::new(IpfsConfig::local(&url, &url));
        let plan = PinPlan {
            targets: vec![t],
            ..PinPlan::default()
        };
        for reader in [
            &Bytes(b"writer bytes".to_vec()) as &dyn PinReader,
            &Unreachable,
        ] {
            let report = pin_repo(&plan, &backend, reader, &PinOptions::default(), |_| {}).await;
            assert_eq!(report.failed.len(), 1);
        }
        assert!(log.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn matching_stranger_cid_uses_verified_bytes_once() {
        let bytes = b"verified stranger copy";
        let mut t = target(bytes);
        t.candidates[0].swarm_allowed = false;
        let cid = t.candidates[0].cid.clone();
        let added = Arc::new(AtomicUsize::new(0));
        let adds = Arc::clone(&added);
        let (url, log) = serve(move |r| {
            if r.path.starts_with("/api/v0/add?") {
                adds.fetch_add(1, Ordering::SeqCst);
                Reply::new(200, serde_json::json!({"Hash":cid}).to_string())
            } else if adds.load(Ordering::SeqCst) > 0 {
                Reply::new(
                    200,
                    serde_json::json!({"Keys":{&cid:{"Type":"recursive"}}}).to_string(),
                )
            } else {
                Reply::new(500, "not pinned")
            }
        });
        let backend = IpfsBackend::new(IpfsConfig::local(&url, &url));
        let report = pin_repo(
            &PinPlan {
                targets: vec![t],
                ..PinPlan::default()
            },
            &backend,
            &Bytes(bytes.to_vec()),
            &PinOptions::default(),
            |_| {},
        )
        .await;
        assert_eq!(report.pinned, 1);
        assert_eq!(report.bytes, bytes.len() as u64);
        assert_eq!(added.load(Ordering::SeqCst), 1);
        assert!(!log
            .lock()
            .unwrap()
            .iter()
            .any(|r| r.path.starts_with("/api/v0/pin/add?")));
    }

    #[tokio::test]
    async fn failed_authorized_candidate_tries_next_candidate_and_counts_pack_once() {
        let mut t = target(b"first import");
        let second = cid_v1_raw_leaves(b"second import");
        t.candidates.push(PinCandidate {
            cid: second.clone(),
            swarm_allowed: true,
        });
        let returned = second.clone();
        let (url, log) = serve(move |r| {
            if r.path.starts_with("/api/v0/pin/add?") && r.path.contains(&returned) {
                Reply::new(200, serde_json::json!({"Pins":[returned]}).to_string())
            } else {
                Reply::new(500, "not pinned")
            }
        });
        let backend = IpfsBackend::new(IpfsConfig::local(&url, &url));
        let plan = PinPlan {
            targets: vec![t],
            ..PinPlan::default()
        };
        let report = pin_repo(
            &plan,
            &backend,
            &Unreachable,
            &PinOptions::default(),
            |_| {},
        )
        .await;
        assert_eq!(report.pinned, 1);
        assert!(report.failed.is_empty());
        assert_eq!(report.bytes, plan.bytes());
        assert_eq!(
            log.lock()
                .unwrap()
                .iter()
                .filter(|r| r.path.starts_with("/api/v0/pin/add?"))
                .count(),
            2
        );
    }

    #[tokio::test]
    async fn pinning_service_cannot_fetch_a_stranger_only_cid() {
        let mut t = target(b"writer bytes");
        t.candidates[0] = PinCandidate {
            cid: cid_v1_raw_leaves(b"stranger data"),
            swarm_allowed: false,
        };
        let (url, log) = serve(|_| Reply::new(200, "{}"));
        let backend = IpfsBackend::new(IpfsConfig {
            api: None,
            api_auth: None,
            gateway: String::new(),
            pinning: Some(crate::backends::ipfs::PinningServiceConfig {
                endpoint: url,
                token: crate::keystore::Secret::new("test"),
                timeout: Duration::from_secs(1),
                poll_interval: Duration::from_millis(1),
            }),
        });
        let report = pin_repo(
            &PinPlan {
                targets: vec![t],
                ..PinPlan::default()
            },
            &backend,
            &Bytes(b"writer bytes".to_vec()),
            &PinOptions::default(),
            |_| {},
        )
        .await;
        assert_eq!(report.failed.len(), 1);
        assert!(log.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn already_pinned_does_not_fetch_or_upload() {
        let t = target(b"stored");
        let cid = t.candidates[0].cid.clone();
        let (url, log) = serve(move |_| {
            Reply::new(
                200,
                serde_json::json!({"Keys": { &cid: {"Type": "recursive"} }}).to_string(),
            )
        });
        let backend = IpfsBackend::new(IpfsConfig::local(&url, &url));
        let report = pin_repo(
            &PinPlan {
                targets: vec![t],
                ..PinPlan::default()
            },
            &backend,
            &Bytes(Vec::new()),
            &PinOptions::default(),
            |_| {},
        )
        .await;
        assert_eq!(report.already, 1);
        assert_eq!(log.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn bytes_path_checks_cid_before_upload_and_confirms_pin() {
        let bytes = b"verified bytes";
        let t = target(bytes);
        let cid = t.candidates[0].cid.clone();
        let added = Arc::new(AtomicUsize::new(0));
        let adds = Arc::clone(&added);
        let (url, _) = serve(move |request| {
            if request.path.starts_with("/api/v0/add?") {
                adds.fetch_add(1, Ordering::SeqCst);
                Reply::new(200, serde_json::json!({"Hash": cid}).to_string())
            } else if adds.load(Ordering::SeqCst) > 0 {
                Reply::new(
                    200,
                    serde_json::json!({"Keys": { &cid: {"Type": "recursive"} }}).to_string(),
                )
            } else {
                Reply::new(500, "not pinned")
            }
        });
        let backend = IpfsBackend::new(IpfsConfig::local(&url, &url));
        let report = pin_repo(
            &PinPlan {
                targets: vec![t],
                ..PinPlan::default()
            },
            &backend,
            &Bytes(bytes.to_vec()),
            &PinOptions::default(),
            |_| {},
        )
        .await;
        assert_eq!(report.pinned, 1);
        assert_eq!(added.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn different_import_goes_to_swarm_without_upload() {
        let mut t = target(b"verified bytes");
        t.candidates[0].cid = "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku".into();
        let (url, log) = serve(|request| {
            if request.path.starts_with("/api/v0/pin/add?") {
                Reply::new(200, "{\"Progress\":1}\n{\"Pins\":[\"bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku\"]}\n")
            } else {
                Reply::new(500, "not pinned")
            }
        });
        let backend = IpfsBackend::new(IpfsConfig::local(&url, &url));
        let report = pin_repo(
            &PinPlan {
                targets: vec![t],
                ..PinPlan::default()
            },
            &backend,
            &Bytes(b"verified bytes".to_vec()),
            &PinOptions::default(),
            |_| {},
        )
        .await;
        assert_eq!(report.pinned, 1);
        assert!(!log
            .lock()
            .unwrap()
            .iter()
            .any(|r| r.path.starts_with("/api/v0/add?")));
    }

    #[tokio::test]
    async fn swarm_size_abort_unpins_and_forbidden_has_refresh_hint() {
        for (status, body, why) in [
            (200, "{\"Progress\":2}\n", "size limit"),
            (200, "{\"Progress\":0,\"Bytes\":1048577}\n", "size limit"),
            (
                403,
                "denied",
                "this node's token does not allow pin/add — run `dg ipfs up` to refresh it",
            ),
        ] {
            let (url, log) = serve(move |r| {
                if r.path.starts_with("/api/v0/pin/add?") {
                    Reply::new(status, body)
                } else {
                    Reply::new(200, "{}")
                }
            });
            let backend = IpfsBackend::new(IpfsConfig::local(&url, &url));
            let error = backend
                .pin_add_bounded(
                    "bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq",
                    1024 * 1024,
                    Duration::from_secs(1),
                )
                .await
                .unwrap_err();
            assert!(error.to_string().contains(why), "{error}");
            assert!(log
                .lock()
                .unwrap()
                .iter()
                .any(|r| r.path.starts_with("/api/v0/pin/rm?")));
        }
    }

    #[tokio::test]
    async fn wrong_bytes_never_upload_and_wrong_kubo_cid_is_removed() {
        let t = target(b"right");
        let (url, log) = serve(|r| {
            if r.path.starts_with("/api/v0/add?") {
                Reply::new(
                    200,
                    "{\"Hash\":\"bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku\"}",
                )
            } else if r.path.starts_with("/api/v0/pin/rm?") {
                Reply::new(200, "{}")
            } else {
                Reply::new(500, "not pinned")
            }
        });
        let backend = IpfsBackend::new(IpfsConfig::local(&url, &url));
        let plan = PinPlan {
            targets: vec![t],
            ..PinPlan::default()
        };
        let bad = pin_repo(
            &plan,
            &backend,
            &Bytes(b"wrong".to_vec()),
            &PinOptions::default(),
            |_| {},
        )
        .await;
        assert_eq!(bad.failed.len(), 1);
        assert!(!log
            .lock()
            .unwrap()
            .iter()
            .any(|r| r.path.starts_with("/api/v0/add?")));
        let bad = pin_repo(
            &plan,
            &backend,
            &Bytes(b"right".to_vec()),
            &PinOptions::default(),
            |_| {},
        )
        .await;
        assert_eq!(bad.failed.len(), 1);
        assert!(log.lock().unwrap().iter().any(|r| r.path
            == "/api/v0/pin/rm?arg=bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku"));
    }

    struct Meter {
        active: AtomicUsize,
        peak: AtomicUsize,
    }
    #[async_trait::async_trait]
    impl PinReader for Meter {
        async fn fetch(&self, _: &PinTarget) -> Result<PinBytes> {
            let active = self.active.fetch_add(1, Ordering::SeqCst) + 1;
            self.peak.fetch_max(active, Ordering::SeqCst);
            tokio::time::sleep(Duration::from_millis(10)).await;
            self.active.fetch_sub(1, Ordering::SeqCst);
            Ok(PinBytes {
                bytes: b"data".to_vec(),
                from: "test".into(),
            })
        }
    }

    #[tokio::test]
    async fn byte_budget_and_request_count_both_bound_concurrency() {
        let t = target(b"data");
        let cid = t.candidates[0].cid.clone();
        let (url, _) = serve(move |r| {
            if r.path.starts_with("/api/v0/add?") {
                Reply::new(200, serde_json::json!({"Hash": cid}).to_string())
            } else {
                Reply::new(500, "not pinned")
            }
        });
        let backend = IpfsBackend::new(IpfsConfig::local(&url, &url));
        let plan = PinPlan {
            targets: vec![t; 6],
            ..PinPlan::default()
        };
        for (budget, parallel, expected) in [(4, 4, 1), (8, 4, 2), (100, 1, 1), (2, 4, 1)] {
            let meter = Meter {
                active: AtomicUsize::new(0),
                peak: AtomicUsize::new(0),
            };
            pin_repo(
                &plan,
                &backend,
                &meter,
                &PinOptions {
                    byte_budget: budget,
                    max_parallel: parallel,
                    ..PinOptions::default()
                },
                |_| {},
            )
            .await;
            assert_eq!(meter.peak.load(Ordering::SeqCst), expected);
        }
    }

    #[test]
    fn gateway_paths_must_name_the_blob_itself() {
        assert_eq!(
            cid("https://gateway.example/ipfs/bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq"),
            Some("bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq".into())
        );
        for uri in [
            "https://gateway.example/ipfs/bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq/file",
            "https://gateway.example/?x=/ipfs/bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq",
            "http://gateway.example/ipfs/bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq",
        ] {
            assert_eq!(cid(uri), None);
        }
    }

    #[tokio::test]
    async fn swarm_timeout_unpins_before_returning() {
        let (url, log) = serve(|request| {
            if request.path.starts_with("/api/v0/pin/add?") {
                std::thread::sleep(Duration::from_millis(100));
                Reply::new(200, "{\"Pins\":[\"bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq\"]}\n")
            } else {
                Reply::new(200, "{}")
            }
        });
        let backend = IpfsBackend::new(IpfsConfig::local(&url, &url));
        let error = backend
            .pin_add_bounded(
                "bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq",
                1024,
                Duration::from_millis(10),
            )
            .await
            .unwrap_err();
        assert!(error.to_string().contains("timed out"));
        assert!(log
            .lock()
            .unwrap()
            .iter()
            .any(|r| r.path.starts_with("/api/v0/pin/rm?")));
    }

    #[tokio::test]
    async fn pinning_service_uses_only_its_cid_api_and_a_stable_name() {
        let t = target(b"remote");
        let (url, log) = serve(|request| {
            if request.method == "GET" {
                Reply::new(200, "{\"results\":[]}")
            } else {
                Reply::new(200, "{\"requestid\":\"remote1\",\"status\":\"pinned\"}")
            }
        });
        let backend = IpfsBackend::new(IpfsConfig {
            api: None,
            api_auth: None,
            gateway: String::new(),
            pinning: Some(crate::backends::ipfs::PinningServiceConfig {
                endpoint: url,
                token: crate::keystore::Secret::new("local-test-token"),
                timeout: Duration::from_secs(1),
                poll_interval: Duration::from_millis(1),
            }),
        });
        let report = pin_repo(
            &PinPlan {
                targets: vec![t],
                ..PinPlan::default()
            },
            &backend,
            &Bytes(Vec::new()),
            &PinOptions {
                remote_name: "forge:owner/repo".into(),
                ..PinOptions::default()
            },
            |_| {},
        )
        .await;
        assert_eq!(report.pinned, 1);
        let requests = log.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert!(requests.iter().all(|r| r.path.starts_with("/pins")));
        let body: serde_json::Value = serde_json::from_slice(&requests[1].body).unwrap();
        assert!(body["name"]
            .as_str()
            .unwrap()
            .starts_with("forge:owner/repo:"));
    }
}
