//! Enumerate repository blobs from trusted manifests and pin them without publishing records.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;
use std::time::Duration;

use futures::{stream, StreamExt as _};
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use zeroize::Zeroizing;

use crate::backends::{cid::cid_v1_raw_leaves, IpfsBackend, Uri};
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

/// A unique CID and its writer-attested hash and size.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PinTarget {
    pub cid: String,
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
    identity == owner || matches!(roles.get(identity), Some(Role::Maintainer | Role::Writer))
}

fn cid(uri: &str) -> Option<String> {
    if uri.starts_with("ipfs://") {
        IpfsBackend::cid_of(&Uri(uri.to_string())).ok()
    } else {
        let url = reqwest::Url::parse(uri).ok()?;
        // Only a gateway's root blob is a target: /ipfs/CID/file is not the CID's bytes.
        if url.scheme() != "https" || url.query().is_some() || url.fragment().is_some() {
            return None;
        }
        let found = super::read::gateway_cid(uri)?;
        (url.path() == format!("/ipfs/{found}")).then_some(found)
    }
}

fn add_targets(
    plan: &mut PinPlan,
    seen: &mut BTreeSet<String>,
    uris: &[String],
    sha256: &str,
    size: u64,
    what: &PinWhat,
) {
    let cids: BTreeSet<_> = uris.iter().filter_map(|u| cid(u)).collect();
    if cids.is_empty() {
        plan.not_on_ipfs += 1;
    }
    for cid in cids {
        if seen.insert(cid.clone()) {
            plan.targets.push(PinTarget {
                cid,
                size,
                sha256: sha256.to_string(),
                what: what.clone(),
                copies: Vec::new(),
                uris: uris.to_vec(),
            });
        }
    }
}

/// Pure enumeration. A stranger can add addresses for a writer's hash, never a new hash,
/// kind, size or decryption entitlement. Bots (which need a push grant), triagers and readers
/// cannot independently authorize storage by writing a manifest.
pub fn plan_targets(input: &PinInput) -> PinPlan {
    let mut plan = PinPlan::default();
    let mut seen = BTreeSet::new();
    let mut groups: BTreeMap<&str, Vec<&PinManifest>> = BTreeMap::new();
    for m in &input.manifests {
        groups.entry(&m.sha256).or_default().push(m);
    }
    for group in groups.values_mut() {
        group.sort_by_key(|m| (m.created_at, &m.id));
        let Some(writer) = group
            .iter()
            .copied()
            .filter(|m| authorized(&input.owner, &m.owner, &input.roles))
            .min_by_key(|m| {
                (
                    if m.owner == input.owner
                        || input.roles.get(&m.owner) == Some(&Role::Maintainer)
                    {
                        0
                    } else {
                        1
                    },
                    m.created_at,
                    &m.id,
                )
            })
        else {
            plan.stranger_copies_ignored += group.len();
            continue;
        };
        if !writer.readable {
            plan.members_only_skipped += 1;
            continue;
        }
        plan.needs_consent |= writer.sensitive;
        let uris = group
            .iter()
            .filter(|m| m.kind == writer.kind)
            .flat_map(|m| m.uris.iter().cloned())
            .collect::<Vec<_>>();
        add_targets(
            &mut plan,
            &mut seen,
            &uris,
            &writer.sha256,
            writer.size,
            &PinWhat::Pack { kind: writer.kind },
        );
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
            add_targets(
                &mut plan,
                &mut seen,
                &asset.uris,
                hash,
                size,
                &PinWhat::ReleaseAsset {
                    tag: release.tag.clone(),
                    name: asset.name.clone(),
                },
            );
        }
    }
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
            if m.owner_id == repo.owner_id() || roles.get(&m.owner_id) == Some(&Role::Maintainer) {
                0
            } else {
                1
            },
            m.created_at,
            &m.document_id,
        )
    });
    for m in writers {
        if visibility.contains_key(&m.pack_hash) {
            continue;
        }
        let copies: Vec<_> = manifests
            .iter()
            .filter(|c| c.pack_hash == m.pack_hash && c.kind == m.kind)
            .collect();
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
            let head = svc
                .pack_head(repo, &contract, &copies, ctx.reader)
                .await
                .ok_or_else(|| {
                    Error::Io(
                        "cannot determine whether a repository pack is sealed; try again".into(),
                    )
                })?;
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
                    _ => false,
                };
                readable = has_key;
                if has_key {
                    let (bytes, served) = svc
                        .fetch_best_copy_or_mirror(repo, &contract, &copies, &roles, ctx.reader)
                        .await?;
                    if let Some(key) = ctx.shared.get(&m.pack_hash) {
                        readable = crate::private::pack::open_with_file_key(
                            &bytes,
                            served.size_bytes,
                            key,
                        )
                        .is_ok();
                    } else if members_kind {
                        let keys = ctx.members.as_ref().expect("members key checked above");
                        readable = matches!(
                            svc.open_members_pack(repo, keys, &copies, served.size_bytes, bytes)
                                .await?,
                            ArtifactRead::Bytes(_)
                        );
                    } else {
                        readable = matches!(
                            svc.open_or_skip(repo, &copies, served.size_bytes, bytes)
                                .await?,
                            ArtifactRead::Bytes(_)
                        );
                    }
                }
            } else if members_kind || repo.visibility == Visibility::Private {
                readable = false;
            }
        }
        visibility.insert(m.pack_hash, (readable, sensitive));
    }
    for m in &manifests {
        let (readable, sensitive) = visibility
            .get(&m.pack_hash)
            .copied()
            .unwrap_or((false, false));
        rows.push(PinManifest {
            id: m.document_id.clone(),
            owner: m.owner_id.clone(),
            sha256: hex::encode(m.pack_hash),
            kind: m.kind,
            size: m.size_bytes,
            uris: m.uris.clone(),
            created_at: m.created_at,
            readable,
            sensitive,
        });
    }
    let releases = ctx.collab.releases(repo).await?;
    let mut release_rows = Vec::new();
    for release in releases.current.iter().chain(&releases.previous) {
        if !authorized(repo.owner_id(), &release.publisher, &roles) {
            continue;
        }
        let assets = if let Some(sealed) = &release.sealed {
            ctx.collab
                .release_manifest(repo, &sealed.fields)
                .await?
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
    for target in &mut plan.targets {
        if let PinWhat::Pack { kind } = &target.what {
            target.copies = manifests
                .iter()
                .filter(|m| hex::encode(m.pack_hash) == target.sha256 && m.kind == *kind)
                .cloned()
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
        let (bytes, served) = self
            .service
            .fetch_best_copy_or_mirror(self.repo, &contract, &copies, &self.roles, self.reader)
            .await?;
        let from = served
            .uris
            .iter()
            .find_map(|u| {
                reqwest::Url::parse(u)
                    .ok()
                    .and_then(|u| u.host_str().map(str::to_owned))
            })
            .unwrap_or_else(|| "recorded copy".into());
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

async fn pin_one(
    target: &PinTarget,
    backend: &IpfsBackend,
    reader: &impl PinReader,
    opts: &PinOptions,
) -> Result<PinOutcome> {
    if backend.config().pinning.is_some() {
        let name = format!(
            "{}:{}",
            opts.remote_name,
            target.sha256.chars().take(12).collect::<String>()
        );
        backend.remote_pin(&target.cid, &name).await?;
        return Ok(PinOutcome::Pinned {
            from: "pinning service".into(),
        });
    }
    if backend.is_pinned(&target.cid).await? {
        return Ok(PinOutcome::Already);
    }
    if let Ok(fetched) = reader.fetch(target).await {
        if fetched.bytes.len() as u64 != target.size
            || hex::encode(Sha256::digest(&fetched.bytes)) != target.sha256
        {
            return Err(Error::Io(
                "fetched blob does not match the writer's hash and size".into(),
            ));
        }
        // Never upload a differently imported CID: doing so would leave a junk pin.
        if cid_v1_raw_leaves(&fetched.bytes) == target.cid {
            let added = backend.add(&fetched.bytes).await?;
            if added != target.cid {
                let _ = backend.unpin(&added).await;
                return Err(Error::Io(
                    "kubo returned a different CID for verified bytes".into(),
                ));
            }
            if !backend.is_pinned(&target.cid).await? {
                return Err(Error::Io("kubo did not confirm the uploaded pin".into()));
            }
            return Ok(PinOutcome::Pinned { from: fetched.from });
        }
    }
    let limit = target
        .size
        .saturating_add(target.size / 10)
        .saturating_add(1024 * 1024);
    backend
        .pin_add_bounded(&target.cid, limit, opts.swarm_timeout)
        .await?;
    Ok(PinOutcome::Pinned {
        from: "IPFS swarm".into(),
    })
}

/// Resume from pin/ls, bounding both concurrent requests and their advertised byte sizes.
/// A target larger than the byte budget runs exclusively so large CLI blobs can progress.
pub async fn pin_repo(
    plan: &PinPlan,
    backend: &IpfsBackend,
    reader: &impl PinReader,
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
                cid: target.cid.clone(),
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
            cid: cid_v1_raw_leaves(bytes),
            size: bytes.len() as u64,
            sha256: hex::encode(Sha256::digest(bytes)),
            what: PinWhat::Pack { kind: 0 },
            copies: Vec::new(),
            uris: Vec::new(),
        }
    }

    #[tokio::test]
    async fn already_pinned_does_not_fetch_or_upload() {
        let t = target(b"stored");
        let cid = t.cid.clone();
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
        let cid = t.cid.clone();
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
        t.cid = "bafyOtherImport".into();
        let (url, log) = serve(|request| {
            if request.path.starts_with("/api/v0/pin/add?") {
                Reply::new(200, "{\"Progress\":1}\n{\"Pins\":[\"bafyOtherImport\"]}\n")
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
            (200, "{\"Progress\":100}\n", "size limit"),
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
                .pin_add_bounded("bafyTest", 1024 * 1024, Duration::from_secs(1))
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
                Reply::new(200, "{\"Hash\":\"bafyWrong\"}")
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
        assert!(log
            .lock()
            .unwrap()
            .iter()
            .any(|r| r.path == "/api/v0/pin/rm?arg=bafyWrong"));
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
        let cid = t.cid.clone();
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
            cid("https://gateway.example/ipfs/bafyTest"),
            Some("bafyTest".into())
        );
        for uri in [
            "https://gateway.example/ipfs/bafyTest/file",
            "https://gateway.example/?x=/ipfs/bafyTest",
            "http://gateway.example/ipfs/bafyTest",
        ] {
            assert_eq!(cid(uri), None);
        }
    }
}
