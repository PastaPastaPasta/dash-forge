//! The stateful helper: resolves config, connects to Platform lazily, and implements the
//! `list` / `fetch` / `push` operations against `forge-core`'s [`RepoService`].
//!
//! Data flow (architecture §6):
//! - **list** → `resolve_repo` → `read_refs` (proof-verified, folded by `FORGE_RULES_V1`) →
//!   `<oid> <ref>` lines + the `HEAD` symref from the repo's default branch.
//! - **fetch** → collect `packManifest`s (kind 0) → `get_pack` each (SHA-256-verified) →
//!   `git index-pack` into the local odb. A `--filter` partial clone re-packs the download
//!   through a scratch repo and writes the `.promisor` marker (S0.9).
//! - **push** → fast-forward check vs remote refs → `build_pack` (thin + `--fix-thin` =
//!   self-contained) → the repo's storage policy (`dash.storage` / `dash.replicas`, see
//!   [`crate::policy`]) → cost guard → replicate the pack to every target in parallel,
//!   each upload re-read and hash-verified, failing unless N confirm →
//!   `write_pack_manifest` (every confirmed URI + the SHA-256) → `write_ref_update`
//!   (prevOid recorded; non-FF refused without `+`) → post-push ref re-read for a
//!   lost-race late non-fast-forward. Refs are written ONLY after the storage policy is
//!   met and the manifest has landed.

use std::path::PathBuf;

use anyhow::{anyhow, bail, Context, Result};
use forge_core::backends::PackMeta;
use forge_core::keystore::BridgeIdentity;
use forge_core::pack::{build_pack, split, KIND_GIT_PACK};
use forge_core::platform::{LoadedIdentity, Network, PlatformClient};
use forge_core::repo::{
    PackManifestInput, PlatformChunkTarget, RepackTarget, RepoHandle, RepoService, StoredArtifact,
};
use forge_core::rules::{Holdings, RefState, TokenRecord};
use forge_core::storage::{
    human_bytes, replicate, ExternalTarget, PackReader, Replication, StorageTarget,
};
use forge_core::tokens::TokenService;

use futures::stream::{self, StreamExt, TryStreamExt};

use crate::git::{LocalRepo, ScratchRepo};
use crate::options::OptionState;
use crate::policy::{self, PushPolicy};
use crate::url::DashUrl;

/// Packs downloaded concurrently by a fetch — the same window the platform backend
/// pipelines chunk uploads with (spike S0.1).
const PACK_DOWNLOAD_WINDOW: usize = forge_core::backends::platform::PIPELINE_WINDOW;

/// A single want from a `fetch <oid> <name>` line.
#[derive(Debug, Clone)]
pub struct Want {
    /// The wanted object id (40-hex). For a lazy promisor fetch this is a bare blob/tree.
    pub oid: String,
}

/// A parsed `push [+]<src>:<dst>` refspec.
#[derive(Debug, Clone)]
pub struct PushSpec {
    /// The `+` force flag.
    pub force: bool,
    /// The local source ref/oid (empty for a deletion).
    pub src: String,
    /// The remote destination ref.
    pub dst: String,
}

/// The per-ref outcome of a push batch, emitted as `ok <dst>` / `error <dst> <reason>`.
#[derive(Debug, Clone)]
pub enum PushOutcome {
    /// The ref update landed.
    Ok(String),
    /// The ref update was refused.
    Error(String, String),
}

impl PushOutcome {
    /// The exact status line (no trailing newline).
    pub fn wire(&self) -> String {
        match self {
            PushOutcome::Ok(dst) => format!("ok {dst}"),
            PushOutcome::Error(dst, why) => format!("error {dst} {why}"),
        }
    }
}

/// A live Platform connection plus the resolved repo handle.
struct Conn {
    client: PlatformClient,
    identity: LoadedIdentity,
    bridge: BridgeIdentity,
    repo: RepoHandle,
}

/// The remote helper, holding parsed config and a lazily-established connection.
pub struct Helper {
    url: DashUrl,
    /// The git remote name (`origin`), when git invoked us for a named remote — selects
    /// the per-remote `remote.<name>.dash*` storage settings.
    remote: Option<String>,
    key_path: PathBuf,
    network: Network,
    conn: Option<Conn>,
}

impl Helper {
    /// Build a helper for `url`, reading identity + network config from the environment.
    ///
    /// `DASH_FORGE_KEY` names the bridge-format identity JSON (falling back to
    /// `~/.config/dash-forge/identities/<owner>.identity.json`); `DASH_FORGE_NETWORK`
    /// selects the network (testnet default).
    pub fn new(url: DashUrl, remote: Option<String>) -> Result<Self> {
        let key_path = resolve_key_path(&url)?;
        let network = network_from_env();
        Ok(Self {
            url,
            remote,
            key_path,
            network,
            conn: None,
        })
    }

    /// Establish (once) the Platform connection and resolve the repo.
    async fn ensure_conn(&mut self) -> Result<&Conn> {
        if self.conn.is_none() {
            let bridge = BridgeIdentity::load_from_file(&self.key_path).with_context(|| {
                format!(
                    "loading identity from {} (set DASH_FORGE_KEY)",
                    self.key_path.display()
                )
            })?;
            let client = PlatformClient::connect(self.network)
                .await
                .context("connecting to Dash Platform")?;
            let identity = client
                .fetch_identity(&bridge.identity_id)
                .await
                .with_context(|| format!("fetching identity {}", bridge.identity_id))?;
            let repo = {
                let svc = RepoService::new(&client, &identity, &bridge);
                match &self.url {
                    DashUrl::Named { owner, repo } => svc
                        .resolve_repo(owner, repo)
                        .await
                        .with_context(|| format!("resolving repo {owner}/{repo}"))?,
                    // Contract-addressed: no registry lookup, the contract carries its owner.
                    DashUrl::Contract { contract_id } => svc
                        .resolve_repo_by_contract(contract_id)
                        .await
                        .with_context(|| format!("resolving repo contract {contract_id}"))?,
                }
            };
            tracing::info!(
                repo_contract = %repo.repo_contract_id,
                owner = %repo.owner_id,
                "resolved dash:// repo"
            );
            self.conn = Some(Conn {
                client,
                identity,
                bridge,
                repo,
            });
        }
        Ok(self.conn.as_ref().expect("conn populated"))
    }

    /// The `list` / `list for-push` response lines: `<oid> <refname>` per resolved ref and
    /// an `@refs/heads/<default> HEAD` symref.
    pub async fn list(&mut self) -> Result<Vec<String>> {
        let conn = self.ensure_conn().await?;
        let svc = RepoService::new(&conn.client, &conn.identity, &conn.bridge);
        let refs = svc.read_refs(&conn.repo).await?;
        let default_branch = svc
            .read_default_branch(&conn.repo)
            .await?
            .unwrap_or_else(|| "main".to_string());

        let mut lines = Vec::new();
        let mut names: Vec<String> = Vec::new();
        for (name, state) in &refs {
            // Emission guard (defense-in-depth with rules::is_update_valid): never advertise
            // a ref name carrying control chars/whitespace — it could inject a spoofed
            // advertisement line into git's parse of this output (S0.9 wire protocol).
            if !forge_core::rules::is_legal_ref_name(name) {
                tracing::warn!(ref_name = %name.escape_debug(), "skipping illegal ref name in list");
                continue;
            }
            if let Some(oid) = tip_oid(state) {
                lines.push(format!("{oid} {name}"));
                names.push(name.clone());
            }
        }

        // Emit the HEAD symref when the default branch exists (a fresh/empty repo has no
        // head yet — git handles the absence).
        let default_ref = format!("refs/heads/{default_branch}");
        if names.iter().any(|n| n == &default_ref) {
            lines.push(format!("@{default_ref} HEAD"));
        } else if let Some(first_head) = names.iter().find(|n| n.starts_with("refs/heads/")) {
            // No default branch present but some head is — point HEAD at it so clone can
            // check something out rather than warning about a dangling HEAD.
            lines.push(format!("@{first_head} HEAD"));
        }
        Ok(lines)
    }

    /// Serve a `fetch` batch: download the packs covering the wanted objects and index them
    /// into the local odb. Full clone indexes the self-contained packs directly; a
    /// `--filter` partial clone re-packs through a scratch repo and writes `.promisor`.
    pub async fn fetch(&mut self, wants: &[Want], options: &OptionState) -> Result<()> {
        // The local git odb is the cache — never re-download objects git already has
        // (architecture §6). For a plain (non-filter) fetch, if every wanted object is
        // already present locally there is nothing to transfer. (A promisor fetch still
        // runs, since a present commit may need its filtered blobs materialized.)
        if options.filter.is_none()
            && !wants.is_empty()
            && wants.iter().all(|w| LocalRepo::object_exists(&w.oid))
        {
            tracing::info!(
                wants = wants.len(),
                "all wanted objects already local; skipping fetch"
            );
            return Ok(());
        }

        let conn = self.ensure_conn().await?;
        let svc = RepoService::new(&conn.client, &conn.identity, &conn.bridge);

        let manifests = svc.read_pack_manifests(&conn.repo).await?;
        let git_packs: Vec<_> = manifests
            .into_iter()
            .filter(|m| m.kind == u64::from(KIND_GIT_PACK))
            .collect();

        if git_packs.is_empty() {
            // Nothing stored: an empty repo. git tolerates a fetch that delivers no objects
            // as long as the wants were not real (they cannot be, with no packs).
            tracing::warn!("no git packs stored for repo; delivering nothing");
            return Ok(());
        }

        // Download + verify every pack (M1: whole-repo packs; the want-set is served by the
        // union of stored packs, and git dedups objects it already has). Every push adds a
        // pack, so this grows with the repo's push count; downloading them one at a time
        // took ~50 s for the nightly's 56-pack test repo, per fetch — and a partial clone
        // fetches twice. `buffered` keeps a bounded window in flight and preserves order.
        // Each pack comes from the first of its recorded copies that hash-verifies —
        // external URIs raced with the configured IPFS gateways — with Platform chunks as
        // the last resort.
        let svc = &svc;
        let repo = &conn.repo;
        let contract = &svc.repo_contract(repo).await?;
        let reader = &PackReader::from_user_config();
        let fetched: Vec<Option<Vec<u8>>> = stream::iter(git_packs.iter().map(|m| async move {
            let hash = hex::encode(m.pack_hash);
            let got = svc.fetch_artifact_from(repo, contract, m, reader).await;
            let bytes = match got {
                Ok(bytes) => bytes,
                Err(e) if m.storage == 0 => {
                    return Err(anyhow::Error::from(e).context(format!("downloading pack {hash}")));
                }
                // An external-only pack whose copies are down, rate-limited or absent is
                // skipped rather than failing the fetch: git verifies after the fetch that
                // every wanted object arrived, so if this pack was actually needed the
                // fetch still fails, and if it was not (e.g. it only holds a deleted
                // branch) the clone is not held hostage by one dead mirror. Every
                // candidate is bounded (size-scaled deadline + idle timeout), so this
                // cannot hang.
                Err(e) => {
                    tracing::warn!(pack = %hash, mirrors = ?m.uris, error = %e, "external pack unobtainable; skipping it");
                    return Ok(None);
                }
            };
            // Integrity: re-checked here, at the boundary that hands bytes to git.
            let got = PackMeta::for_bytes(&bytes).pack_hash;
            if !got.eq_ignore_ascii_case(&hash) {
                bail!("pack integrity check failed: expected {hash}, got {got}");
            }
            Ok(Some(bytes))
        }))
        .buffered(PACK_DOWNLOAD_WINDOW)
        .try_collect()
        .await?;
        let downloaded: Vec<Vec<u8>> = fetched.into_iter().flatten().collect();

        if let Some(filter) = options.filter.as_deref() {
            // Partial clone: re-pack the downloaded objects through a scratch repo applying
            // the filter, then index the filtered pack and mark it promisor.
            let scratch = ScratchRepo::init()?;
            for bytes in &downloaded {
                scratch.index_pack(bytes)?;
            }
            let want_oids: Vec<String> = wants.iter().map(|w| w.oid.clone()).collect();
            if want_oids.is_empty() {
                return Ok(());
            }
            let filtered = scratch.pack_filtered(&want_oids, Some(filter))?;
            let sha = LocalRepo::index_pack(&filtered)?;
            LocalRepo::write_promisor_marker(&sha)?;
            tracing::info!(filter, pack = %sha, "indexed filtered promisor pack");
        } else {
            for bytes in &downloaded {
                let sha = LocalRepo::index_pack(bytes)?;
                tracing::info!(pack = %sha, "indexed pack into local odb");
            }
        }
        Ok(())
    }

    /// Serve a `push` batch: fast-forward-check each refspec against the current remote
    /// state, upload one self-contained pack covering the accepted updates, write the
    /// `packManifest`, then a `refUpdate` per ref, and finally re-read refs to surface a
    /// lost concurrent race as a late non-fast-forward.
    pub async fn push(
        &mut self,
        specs: &[PushSpec],
        options: &OptionState,
    ) -> Result<Vec<PushOutcome>> {
        let git_dir = LocalRepo::git_dir()?;
        let dry_run = options.dry_run;
        // Resolve the storage policy before touching the network: a typo in dash.storage or
        // a missing profile must fail the push before anything is built or paid for.
        let push_policy = PushPolicy::load(self.remote.as_deref())
            .context("reading the storage policy (dash.storage / dash.replicas)")?;
        let conn = self.ensure_conn().await?;
        let svc = RepoService::new(&conn.client, &conn.identity, &conn.bridge);

        let remote_refs = svc.read_refs(&conn.repo).await?;

        // Fail fast when this identity holds no spendable token on the repo. The ACL itself
        // is enforced at consensus — `refUpdate`, `chunk` and `packManifest` all carry a
        // WRITE token cost, so an unauthorized push cannot land regardless. But without this
        // check the helper builds a pack and broadcasts chunk state transitions that
        // consensus rejects one at a time, burning processing fees and surfacing a raw
        // platform error. That error is the first thing a would-be contributor sees, and it
        // teaches them nothing; this is the moment to point them at the PR flow instead.
        //
        // `DASH_FORGE_SKIP_WRITE_PRECHECK=1` skips the check, so a caller that needs to see
        // what consensus itself does with an unauthorized push (the e2e ACL scenarios) can.
        if !dry_run && specs.iter().any(|s| !s.src.is_empty()) && !skip_write_precheck() {
            if let Some(reason) = write_access_denied(conn).await {
                return Ok(specs
                    .iter()
                    .map(|s| PushOutcome::Error(s.dst.clone(), reason.clone()))
                    .collect());
            }
        }

        let planned = plan_pushes(specs, &remote_refs);

        // Build + upload one pack covering all accepted, non-delete updates.
        let want_tips: Vec<String> = planned
            .iter()
            .filter(|p| p.reject.is_none())
            .filter_map(|p| p.new_oid.clone())
            .collect();
        if !want_tips.is_empty() && !dry_run {
            let ref_count = planned.iter().filter(|p| p.reject.is_none()).count();
            let ctx = PushContext {
                svc: &svc,
                repo: &conn.repo,
                git_dir: &git_dir,
                policy: &push_policy,
                ref_count,
                verbose: options.verbosity >= 1,
            };
            // Storage first. Any error here — the policy's N not met, the cost guard
            // refusing, the manifest write failing — returns before a single ref update
            // is written, so no ref can point at history the policy did not store.
            upload_push_pack(&ctx, &want_tips, &remote_refs).await?;
        }

        // Apply ref updates for accepted specs.
        if !dry_run {
            for p in planned.iter().filter(|p| p.reject.is_none()) {
                let new_bytes = match &p.new_oid {
                    Some(oid) => oid_to_bytes(oid)?,
                    None => vec![0u8; 20], // delete = zero oid
                };
                let prev_bytes = match &p.prev_oid {
                    Some(oid) => Some(oid_to_bytes(oid)?),
                    None => None,
                };
                svc.write_ref_update(
                    &conn.repo,
                    &p.spec.dst,
                    &new_bytes,
                    prev_bytes.as_deref(),
                    p.spec.force,
                )
                .await
                .with_context(|| format!("writing ref update for {}", p.spec.dst))?;
            }
        }

        // Post-push re-read: a same-prevOid race lost to a concurrent pusher surfaces here
        // as a divergence → report a late non-fast-forward rather than a silent orphan.
        // Platform reads are eventually consistent, so a re-read *immediately* after the
        // write can lag (not yet reflect our update). Poll until every accepted ref shows
        // its pushed tip (convergence) or the retries are exhausted — the write itself has
        // already landed idempotently; this only decides what status we report to git.
        let final_refs = if dry_run {
            remote_refs
        } else {
            self.read_refs_until_converged(&planned).await?
        };
        Ok(finalize_outcomes(planned, &final_refs, dry_run))
    }

    /// Re-read refs, retrying briefly until every accepted non-delete spec resolves to its
    /// pushed tip (tolerating read-after-write lag), or the retry budget is spent.
    async fn read_refs_until_converged(
        &self,
        planned: &[Planned],
    ) -> Result<Vec<(String, RefState)>> {
        const MAX_ATTEMPTS: usize = 6;
        let conn = self.conn.as_ref().expect("connected before finalize");
        let svc = RepoService::new(&conn.client, &conn.identity, &conn.bridge);
        let expected: Vec<(&str, &str)> = planned
            .iter()
            .filter(|p| p.reject.is_none())
            .filter_map(|p| p.new_oid.as_deref().map(|oid| (p.spec.dst.as_str(), oid)))
            .collect();

        let mut last = svc.read_refs(&conn.repo).await?;
        for attempt in 1..=MAX_ATTEMPTS {
            let converged = expected.iter().all(|(dst, oid)| {
                matches!(last.iter().find(|(n, _)| n == dst),
                    Some((_, RefState::Resolved { oid: got, .. })) if got == oid)
            });
            if converged || expected.is_empty() {
                break;
            }
            if attempt < MAX_ATTEMPTS {
                tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
                last = svc.read_refs(&conn.repo).await?;
            }
        }
        Ok(last)
    }
}

/// The provisional tip oid of a resolved (or diverged, newest-head) ref; `None` for an
/// unborn ref. The single mapping every ref-state read goes through.
fn tip_oid(state: &RefState) -> Option<String> {
    match state {
        RefState::Resolved { oid, .. } => Some(oid.clone()),
        RefState::Diverged { heads } => heads.first().map(|h| h.oid.clone()),
        RefState::Unborn => None,
    }
}

/// The current remote tip of `name` within a resolved ref list.
fn remote_tip(refs: &[(String, RefState)], name: &str) -> Option<String> {
    refs.iter()
        .find(|(n, _)| n == name)
        .and_then(|(_, s)| tip_oid(s))
}

/// A push refspec resolved to its intended write, with any pre-write rejection.
struct Planned {
    spec: PushSpec,
    /// New tip oid (`None` = delete).
    new_oid: Option<String>,
    /// Recorded previous tip (`None` = ref did not exist remotely).
    prev_oid: Option<String>,
    /// Set when the spec is rejected before any write (e.g. non-fast-forward).
    reject: Option<String>,
}

/// Decide accept/reject for every refspec up front (no writes): deletions and new refs are
/// accepted; an update is accepted iff forced, a no-op, or a fast-forward — otherwise
/// rejected as `non-fast-forward` (§2.3 / PRD 02).
fn plan_pushes(specs: &[PushSpec], remote_refs: &[(String, RefState)]) -> Vec<Planned> {
    let mut planned = Vec::with_capacity(specs.len());
    for spec in specs {
        let prev = remote_tip(remote_refs, &spec.dst);
        if spec.src.is_empty() {
            // Deletion.
            planned.push(Planned {
                spec: spec.clone(),
                new_oid: None,
                prev_oid: prev,
                reject: None,
            });
            continue;
        }
        let Some(new_oid) = LocalRepo::rev_parse(&spec.src) else {
            planned.push(Planned {
                spec: spec.clone(),
                new_oid: None,
                prev_oid: prev,
                reject: Some(format!("cannot resolve local source {:?}", spec.src)),
            });
            continue;
        };
        let reject = match &prev {
            None => None, // new ref
            Some(tip) => {
                let fast_forward =
                    spec.force || tip == &new_oid || LocalRepo::is_ancestor(tip, &new_oid);
                if fast_forward {
                    None
                } else {
                    Some("non-fast-forward".to_string())
                }
            }
        };
        planned.push(Planned {
            spec: spec.clone(),
            new_oid: Some(new_oid),
            prev_oid: prev,
            reject,
        });
    }
    planned
}

/// What [`upload_push_pack`] needs from the push.
struct PushContext<'a> {
    svc: &'a RepoService<'a>,
    repo: &'a RepoHandle,
    git_dir: &'a std::path::Path,
    policy: &'a PushPolicy,
    ref_count: usize,
    verbose: bool,
}

impl PushContext<'_> {
    /// A status line for the user (git shows the helper's stderr).
    fn say(&self, line: &str) {
        if self.verbose {
            eprintln!("{line}");
        }
    }
}

/// Rough JSON length of the manifest `uris` each external target adds (public URL + locator).
const URIS_JSON_PER_TARGET: u64 = 180;

/// Build one self-contained pack for `want_tips` (excluding remote tips already local as
/// thin-pack bases), store it according to the repo's storage policy, and record the
/// `packManifest`. Returns only once the policy's N copies are confirmed and the manifest
/// has landed; every failure before that is an error, and the caller writes no refs.
async fn upload_push_pack(
    ctx: &PushContext<'_>,
    want_tips: &[String],
    remote_refs: &[(String, RefState)],
) -> Result<()> {
    let have_bases: Vec<String> = remote_refs
        .iter()
        .filter_map(|(_, s)| tip_oid(s))
        .filter(|oid| LocalRepo::object_exists(oid))
        .collect();

    let want_refs: Vec<&str> = want_tips.iter().map(String::as_str).collect();
    let base_refs: Vec<&str> = have_bases.iter().map(String::as_str).collect();
    let pack = build_pack(ctx.git_dir, &want_refs, &base_refs)
        .context("building self-contained push pack")?;

    // `have_bases` is every remote tip we already hold, so pushing a ref at an
    // already-stored commit — a new branch or tag at the current tip — packs zero objects.
    // Storing that pack would charge for 32 bytes of nothing AND permanently occupy a
    // packRef no index row can ever reference: browse coverage is proved from rows, so the
    // repo would read as index-behind until someone paid for a repack. The `refUpdate` the
    // caller actually wanted still lands; only the empty pack is skipped.
    if pack.parsed.object_count() == 0 {
        tracing::info!("push adds no new objects; skipping pack upload and browse index");
        return Ok(());
    }

    let job = PackJob::new(&pack.bytes, pack.parsed.object_count() as u64)?;
    let resolved = &ctx.policy.resolved;
    tracing::info!(
        pack_hash = %job.meta.pack_hash,
        bytes = job.bytes.len(),
        objects = job.object_count,
        targets = ?resolved.target_names(),
        replicas = resolved.replicas,
        "storing push pack"
    );

    // What goes where, and what it costs, BEFORE anything is paid for.
    let estimate = job.estimate(ctx, resolved.platform);
    ctx.say(&policy::plan_line(
        resolved,
        job.bytes.len() as u64,
        &estimate,
    ));
    policy::enforce(estimate.total(), ctx.policy).map_err(|why| anyhow!(why))?;

    let externals = external_targets(ctx)?;
    let jpath = crate::journal::journal_path(ctx.git_dir, &job.meta.pack_hash);
    let replication = store_pack(ctx, &job, &externals, &jpath).await?;
    record_pack(ctx, &job, &replication).await?;

    // Push fully landed (copies + manifest): retire the journal.
    let _ = std::fs::remove_file(&jpath);
    publish_browse_index(ctx, &pack.parsed, job.pack_hash, &replication, &externals).await;
    Ok(())
}

/// The pack being pushed, with the facts every storage step needs.
struct PackJob<'a> {
    bytes: &'a [u8],
    meta: PackMeta,
    pack_hash: [u8; 32],
    object_count: u64,
    chunk_count: u32,
}

impl<'a> PackJob<'a> {
    fn new(bytes: &'a [u8], object_count: u64) -> Result<Self> {
        let meta = PackMeta::for_bytes(bytes);
        let pack_hash = meta.pack_hash_bytes()?;
        let chunks = split(bytes).len();
        let chunk_count = u32::try_from(chunks)
            .map_err(|_| anyhow!("pack has too many chunks ({chunks}) for a u32 journal"))?;
        Ok(Self {
            bytes,
            meta,
            pack_hash,
            object_count,
            chunk_count,
        })
    }

    /// The on-chain cost of this push with (or without) Platform storing the bytes.
    fn estimate(&self, ctx: &PushContext<'_>, platform_bytes: bool) -> policy::PushEstimate {
        policy::estimate_push(
            self.bytes.len() as u64,
            self.object_count,
            ctx.ref_count,
            URIS_JSON_PER_TARGET * ctx.policy.resolved.external.len() as u64,
            platform_bytes,
        )
    }
}

/// The policy's external targets, built from the user's profiles (secrets resolved here,
/// never logged).
fn external_targets(ctx: &PushContext<'_>) -> Result<Vec<ExternalTarget>> {
    let http = forge_core::storage::http_client();
    ctx.policy
        .resolved
        .external
        .iter()
        .map(|(name, profile)| {
            ExternalTarget::from_profile(name, profile, &http)
                .with_context(|| format!("storage profile {name:?}"))
        })
        .collect()
}

/// Replicate the pack to the policy's targets (plus the Platform fallback when armed and
/// needed). Platform chunks upload resumably through the push journal at `jpath`, so an
/// interrupted push resumes without re-paying (PRD 02 §A).
async fn store_pack(
    ctx: &PushContext<'_>,
    job: &PackJob<'_>,
    externals: &[ExternalTarget],
    jpath: &std::path::Path,
) -> Result<Replication> {
    let resolved = &ctx.policy.resolved;
    let journal_store = crate::journal::FileJournalStore::new(jpath.to_path_buf());
    let platform_target = || {
        let journal = crate::journal::load_or_new(jpath, &job.meta.pack_hash, job.chunk_count);
        if !journal.uploaded.is_empty() {
            tracing::info!(
                resumed_chunks = journal.uploaded.len(),
                total = job.chunk_count,
                "resuming interrupted push from journal"
            );
        }
        PlatformChunkTarget::resumable(
            ctx.svc,
            ctx.repo,
            forge_core::storage::PLATFORM_PROFILE,
            journal,
            &journal_store,
        )
    };
    let chain = resolved.platform.then(platform_target);
    let mut targets: Vec<&dyn StorageTarget> =
        externals.iter().map(|t| t as &dyn StorageTarget).collect();
    if let Some(c) = &chain {
        targets.push(c);
    }

    let err = match replicate(&targets, job.bytes, &job.meta, resolved.replicas).await {
        Ok(rep) => return Ok(rep),
        Err(err) => err,
    };
    if !resolved.platform_fallback {
        bail!(
            "{err}. No packManifest and no ref was written. Fix the failing target(s) and push \
             again (uploads are content-addressed, so confirmed copies are not re-uploaded), \
             lower dash.replicas, or set dash.platformFallback=true"
        );
    }

    // The external copies could not meet N: keep what did confirm, and add the on-chain
    // copy the user opted into as the fallback (costed and guarded like any paid write).
    ctx.say(&format!("dash: {err}"));
    let fallback_cost = job.estimate(ctx, true);
    ctx.say(&format!(
        "dash: dash.platformFallback: storing the pack on Platform instead, est. {} DASH",
        policy::dash(fallback_cost.total())
    ));
    policy::enforce(fallback_cost.total(), ctx.policy).map_err(|why| anyhow!(why))?;
    let fallback = platform_target();
    let chain_rep = replicate(&[&fallback as &dyn StorageTarget], job.bytes, &job.meta, 1)
        .await
        .map_err(|e| {
            anyhow!(
                "{err}; Platform fallback failed too: {e}. No ref was updated; push again to \
                 resume (confirmed chunks are journaled)"
            )
        })?;
    let mut replicas = err.confirmed;
    replicas.extend(chain_rep.replicas);
    Ok(Replication {
        replicas,
        failures: err.failures,
    })
}

/// Write the pack's `packManifest` recording every confirmed copy.
async fn record_pack(
    ctx: &PushContext<'_>,
    job: &PackJob<'_>,
    replication: &Replication,
) -> Result<()> {
    for f in &replication.failures {
        ctx.say(&format!(
            "dash: warning: {} did not confirm: {}",
            f.target, f.reason
        ));
    }
    let stored = StoredArtifact::from_replication(replication, job.bytes)
        .context("recording the confirmed copies")?;
    ctx.svc
        .write_pack_manifest(
            ctx.repo,
            &PackManifestInput {
                pack_hash: job.pack_hash,
                kind: u64::from(KIND_GIT_PACK),
                size_bytes: job.bytes.len() as u64,
                object_count: job.object_count,
                chunk_count: stored.chunk_count,
                storage: stored.storage,
                offset_index_parts: 0,
                uris: stored.uris,
                // An incremental push supersedes nothing and carries no flatIndex tips.
                supersedes: Vec::new(),
                tips: Vec::new(),
            },
        )
        .await
        .context("writing pack manifest")?;
    let confirmed: Vec<&str> = replication
        .replicas
        .iter()
        .map(|r| r.target.as_str())
        .collect();
    ctx.say(&format!(
        "dash: pack {} ({}) stored on {} ({} verified)",
        &job.meta.pack_hash[..12],
        human_bytes(job.bytes.len() as u64),
        confirmed.join(", "),
        confirmed.len()
    ));
    Ok(())
}

/// Publish the browse-index fragment over the pack just stored, to the same targets that
/// confirmed the pack, so the repo is browsable without waiting for a repack.
///
/// Best-effort and reported, never fatal: the push is already stored and paid for by this
/// point, and a repo whose index is behind still clones, fetches and pushes — it just falls
/// back to the whole-pack path until the next push or repack refreshes the index.
async fn publish_browse_index(
    ctx: &PushContext<'_>,
    parsed: &forge_core::pack::ParsedPack,
    pack_hash: [u8; 32],
    replication: &Replication,
    externals: &[ExternalTarget],
) {
    let chain = replication.has_platform().then(|| {
        PlatformChunkTarget::new(ctx.svc, ctx.repo, forge_core::storage::PLATFORM_PROFILE)
    });
    let mut targets: Vec<&dyn StorageTarget> = externals
        .iter()
        .filter(|t| {
            replication
                .replicas
                .iter()
                .any(|r| r.target == StorageTarget::name(*t))
        })
        .map(|t| t as &dyn StorageTarget)
        .collect();
    if let Some(c) = &chain {
        targets.push(c);
    }
    let required = ctx.policy.resolved.replicas.min(targets.len()).max(1);
    let target = RepackTarget::Replicated {
        targets: &targets,
        required,
    };
    match ctx
        .svc
        .publish_push_locator(ctx.repo, parsed, pack_hash, target)
        .await
    {
        Ok(forge_core::repo::PushIndexOutcome::Fragment { pack_ref, .. }) => {
            tracing::info!(pack_ref, "published browse-index fragment");
        }
        Ok(forge_core::repo::PushIndexOutcome::Consolidated { folded, .. }) => {
            tracing::info!(folded, "folded browse-index fragments into one locator");
        }
        Ok(forge_core::repo::PushIndexOutcome::Skipped(why)) => {
            tracing::warn!(reason = %why, "browse index not updated by this push");
        }
        Err(e) => {
            ctx.say(&format!(
                "dash: warning: the push landed but its browse-index fragment could not be \
                 published ({e}); browsing uses the fallback path until the next push or repack"
            ));
        }
    }
}

/// Turn the plan + post-push ref state into per-ref outcomes. A rejected spec keeps its
/// pre-write reason; an accepted one is confirmed only if the ref converged to the pushed
/// tip (or vanished, for a delete) — a lingering divergence is a late non-fast-forward.
fn finalize_outcomes(
    planned: Vec<Planned>,
    final_refs: &[(String, RefState)],
    dry_run: bool,
) -> Vec<PushOutcome> {
    let mut outcomes = Vec::with_capacity(planned.len());
    for p in planned {
        if let Some(why) = p.reject {
            outcomes.push(PushOutcome::Error(p.spec.dst, why));
            continue;
        }
        if dry_run {
            outcomes.push(PushOutcome::Ok(p.spec.dst));
            continue;
        }
        let state = final_refs
            .iter()
            .find(|(n, _)| *n == p.spec.dst)
            .map(|(_, s)| s);
        let outcome = match &p.new_oid {
            None => match state {
                None | Some(RefState::Unborn) => PushOutcome::Ok(p.spec.dst),
                _ => PushOutcome::Error(p.spec.dst, "delete did not take effect".to_string()),
            },
            Some(expected) => match state {
                Some(RefState::Resolved { oid, .. }) if oid == expected => {
                    PushOutcome::Ok(p.spec.dst)
                }
                Some(RefState::Diverged { .. }) => PushOutcome::Error(
                    p.spec.dst,
                    "non-fast-forward (lost concurrent race)".to_string(),
                ),
                _ => {
                    PushOutcome::Error(p.spec.dst, "ref did not converge to pushed tip".to_string())
                }
            },
        };
        outcomes.push(outcome);
    }
    outcomes
}

/// Decode a 40-hex git oid to its 20 raw bytes.
fn oid_to_bytes(oid: &str) -> Result<Vec<u8>> {
    let raw = hex::decode(oid).map_err(|e| anyhow!("oid {oid:?} is not hex: {e}"))?;
    if raw.len() != 20 {
        bail!("oid {oid:?} is not 20 bytes (sha1)");
    }
    Ok(raw)
}

/// Select the network from `DASH_FORGE_NETWORK` (testnet default).
pub(crate) fn network_from_env() -> Network {
    match std::env::var("DASH_FORGE_NETWORK").as_deref() {
        Ok("mainnet") => Network::Mainnet,
        Ok("devnet") => Network::Devnet,
        _ => Network::Testnet,
    }
}

/// Whether `DASH_FORGE_SKIP_WRITE_PRECHECK` asks to bypass [`write_access_denied`].
fn skip_write_precheck() -> bool {
    matches!(
        std::env::var("DASH_FORGE_SKIP_WRITE_PRECHECK").as_deref(),
        Ok("1" | "true")
    )
}

/// `Some(reason)` when the connected identity provably holds no spendable WRITE or MAINTAIN
/// token on the repo, and so cannot land any push.
///
/// Returns `None` — i.e. proceed — when the holding cannot be determined. The token history
/// read is advisory: consensus is the authority, and a transient read failure must not block
/// a push a holder is entitled to make.
async fn write_access_denied(conn: &Conn) -> Option<String> {
    let tokens = TokenService::new(&conn.client, &conn.identity, &conn.bridge);
    let records = tokens
        .token_history(&conn.repo.repo_contract_id)
        .await
        .ok()?;
    let now = u64::try_from(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .ok()?
            .as_millis(),
    )
    .ok()?;
    let me = conn.identity.id();
    let holdings = forge_core::rules::holdings_as_of(&records, &me, now);
    if holdings.any() {
        return None;
    }
    Some(write_denied_reason(
        frozen_grants(&records, &me, now),
        &conn.repo.owner_id,
        &conn.repo.name,
    ))
}

/// Which of `identity`'s WRITE / MAINTAIN grants are still held but frozen at `now` (a
/// suspended collaborator), as opposed to never held. Frozen tokens are not spendable, so
/// [`forge_core::rules::holdings_as_of`] reports both cases the same way; replaying the
/// history with the freezes left out tells them apart without a second copy of the token
/// state machine. Only meaningful when the real holdings are empty.
fn frozen_grants(records: &[TokenRecord], identity: &str, now: u64) -> Holdings {
    use forge_core::rules::TokenOp;
    let unfrozen: Vec<TokenRecord> = records
        .iter()
        .filter(|r| !matches!(r.op, TokenOp::Freeze | TokenOp::Unfreeze))
        .cloned()
        .collect();
    forge_core::rules::holdings_as_of(&unfrozen, identity, now)
}

/// The push refusal for an identity with no spendable token. A suspended collaborator is
/// told which token is frozen: "no WRITE token" is false for them, and forking is not the
/// fix.
fn write_denied_reason(frozen: Holdings, owner_id: &str, name: &str) -> String {
    // Worded unlike the consensus error ("token frozen: this identity's write access has
    // been suspended"), so a caller can tell this local refusal from a network verdict.
    let which = match (frozen.write, frozen.maintain) {
        (true, true) => Some("WRITE and MAINTAIN tokens on this repo are"),
        (true, false) => Some("WRITE token on this repo is"),
        (false, true) => Some("MAINTAIN token on this repo is"),
        (false, false) => None,
    };
    if let Some(which) = which {
        return format!(
            "your {which} frozen: a maintainer suspended your push access, so consensus \
             would reject this push. Ask a maintainer to unfreeze it."
        );
    }
    // `dg pr create` takes the target repo POSITIONALLY as `owner/name`, which is what the
    // pusher typed into their remote URL — not the contract id, which is not an address
    // `dg` accepts here.
    format!(
        "no WRITE token on this repo — you cannot push to it. Fork it and open a pull \
         request instead: `dg repo create <name>`, push your branch there, then \
         `dg pr create {owner_id}/{name} --title <t> --source-contract <your contract id> \
         --head-oid <oid>`"
    )
}

/// Resolve the identity key file: `DASH_FORGE_KEY` if set, else
/// `~/.config/dash-forge/identities/<owner>.identity.json`.
fn resolve_key_path(url: &DashUrl) -> Result<PathBuf> {
    if let Some(p) = std::env::var_os("DASH_FORGE_KEY") {
        return Ok(PathBuf::from(p));
    }
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| anyhow!("neither DASH_FORGE_KEY nor HOME is set; cannot locate identity"))?;
    // The per-owner default only makes sense for the named form. A contract-addressed URL
    // names no owner (that is the point), so it requires an explicit DASH_FORGE_KEY —
    // which is fine, because it is reached from `dg`, not typed by hand.
    let owner = match url {
        DashUrl::Named { owner, .. } => owner.clone(),
        DashUrl::Contract { .. } => {
            bail!(
                "a contract-addressed dash:// URL has no owner to pick a default key for; \
                 set DASH_FORGE_KEY to the identity JSON to use"
            )
        }
    };
    Ok(home
        .join(".config/dash-forge/identities")
        .join(format!("{owner}.identity.json")))
}

#[cfg(test)]
mod tests {
    use super::{frozen_grants, oid_to_bytes, write_denied_reason, PushOutcome};
    use forge_core::rules::{Holdings, TokenKind, TokenOp, TokenRecord};

    fn rec(identity: &str, token: TokenKind, op: TokenOp, created_at: u64) -> TokenRecord {
        TokenRecord {
            id: format!("r{created_at}"),
            identity: identity.to_string(),
            token,
            op,
            created_at,
        }
    }

    #[test]
    fn frozen_grants_are_told_apart_from_no_grant() {
        use TokenKind::{Maintain, Write};
        let frozen = [
            rec("me", Write, TokenOp::Mint, 1),
            rec("me", Write, TokenOp::Freeze, 2),
        ];
        assert_eq!(
            frozen_grants(&frozen, "me", 10),
            Holdings {
                write: true,
                maintain: false
            }
        );
        // Never granted, or granted to someone else: nothing frozen.
        assert!(!frozen_grants(&[], "me", 10).any());
        assert!(!frozen_grants(&frozen, "someone-else", 10).any());
        // Revoked (destroyed) after the freeze: nothing is held any more.
        let revoked = [
            rec("me", Write, TokenOp::Mint, 1),
            rec("me", Write, TokenOp::Freeze, 2),
            rec("me", Write, TokenOp::Destroy, 3),
        ];
        assert!(!frozen_grants(&revoked, "me", 10).any());
        // A suspended maintainer who never held WRITE.
        let maint = [
            rec("me", Maintain, TokenOp::Mint, 1),
            rec("me", Maintain, TokenOp::Freeze, 2),
        ];
        assert_eq!(
            frozen_grants(&maint, "me", 10),
            Holdings {
                write: false,
                maintain: true
            }
        );
    }

    #[test]
    fn a_frozen_pusher_is_not_told_to_fork() {
        let write = Holdings {
            write: true,
            maintain: false,
        };
        let frozen = write_denied_reason(write, "owner", "repo");
        assert!(
            frozen.contains("WRITE token on this repo is frozen"),
            "{frozen}"
        );
        assert!(!frozen.contains("dg pr create"), "{frozen}");
        // Must not read as the consensus error, or e2e scenario 04 could not tell a local
        // refusal from a network verdict.
        assert!(!frozen.contains("token frozen"), "{frozen}");

        let maintain = Holdings {
            write: false,
            maintain: true,
        };
        let frozen = write_denied_reason(maintain, "owner", "repo");
        assert!(
            frozen.contains("MAINTAIN token on this repo is frozen"),
            "{frozen}"
        );

        let none = write_denied_reason(Holdings::default(), "owner", "repo");
        assert!(none.starts_with("no WRITE token"), "{none}");
        assert!(none.contains("dg pr create owner/repo"), "{none}");
    }

    #[test]
    fn oid_round_trips_to_20_bytes() {
        let oid = "0123456789abcdef0123456789abcdef01234567";
        let bytes = oid_to_bytes(oid).unwrap();
        assert_eq!(bytes.len(), 20);
        assert_eq!(hex::encode(bytes), oid);
    }

    #[test]
    fn oid_rejects_bad_input() {
        assert!(oid_to_bytes("nothex").is_err());
        assert!(oid_to_bytes("abcd").is_err()); // too short
    }

    #[test]
    fn push_outcome_wire_format() {
        assert_eq!(
            PushOutcome::Ok("refs/heads/main".into()).wire(),
            "ok refs/heads/main"
        );
        assert_eq!(
            PushOutcome::Error("refs/heads/main".into(), "non-fast-forward".into()).wire(),
            "error refs/heads/main non-fast-forward"
        );
    }
}
