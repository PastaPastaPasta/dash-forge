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
use forge_core::network::{NetworkSettings, NetworkTarget};
use forge_core::pack::{build_pack, split, KIND_GIT_PACK};
use forge_core::platform::{LoadedIdentity, PlatformClient};
use forge_core::repo::{
    PackManifestInput, PlatformChunkTarget, RepackTarget, RepoHandle, RepoService, StoredArtifact,
};
use forge_core::rules::{Holdings, RefState, TokenRecord};
use forge_core::storage::{
    human_bytes, replicate, ExternalTarget, Observed, PackReader, Replica, Replication,
    StorageTarget, StoreOutcome,
};
use forge_core::tokens::TokenService;
use forge_core::user_error::{codes, dash, UserError, NOTE_PLATFORM_CHUNKS_JOURNALED};

use futures::stream::{self, StreamExt, TryStreamExt};

use crate::git::{LocalRepo, ScratchRepo};
use crate::options::OptionState;
use crate::policy::{self, PushPolicy};
use crate::progress::{self, Charge, PlanFacts, PlatformWrites, Progress};
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
    target: NetworkTarget,
    conn: Option<Conn>,
}

impl Helper {
    /// Build a helper for `url`, reading identity + network config from the environment
    /// and git config.
    ///
    /// `DASH_FORGE_KEY` names the bridge-format identity JSON (falling back to
    /// `~/.config/dash-forge/identities/<owner>.identity.json`). The network comes from
    /// [`network_target`].
    pub fn new(url: DashUrl, remote: Option<String>) -> Result<Self> {
        let key_path = resolve_key_path(&url)?;
        let target = network_target()?;
        Ok(Self {
            url,
            remote,
            key_path,
            target,
            conn: None,
        })
    }

    /// Establish (once) the Platform connection and resolve the repo.
    async fn ensure_conn(&mut self) -> Result<&Conn> {
        if self.conn.is_none() {
            if std::env::var_os("DASH_FORGE_KEY").is_none() && !self.key_path.exists() {
                return Err(no_identity(format!(
                    "DASH_FORGE_KEY is not set and {} does not exist",
                    self.key_path.display()
                )));
            }
            let bridge = BridgeIdentity::load_from_file(&self.key_path).with_context(|| {
                format!(
                    "loading identity from {} (set DASH_FORGE_KEY)",
                    self.key_path.display()
                )
            })?;
            let client = PlatformClient::connect(self.target.clone())
                .await
                .with_context(|| {
                    format!("connecting to Dash Platform ({})", self.target.network)
                })?;
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
        // Resolve the storage policy before touching the network when this push stores
        // objects: a typo in dash.storage or a missing profile must fail the push before
        // anything is built or paid for. A delete-only push stores nothing, so a broken
        // storage.toml must not block it.
        let push_policy = if specs.iter().any(|s| !s.src.is_empty()) {
            Some(
                PushPolicy::load(self.remote.as_deref())
                    .context("reading the storage policy (dash.storage / dash.replicas)")?,
            )
        } else {
            None
        };
        let contract_url = match &self.url {
            DashUrl::Contract { contract_id } => Some(contract_id.clone()),
            DashUrl::Named { .. } => None,
        };
        let conn = self.ensure_conn().await?;
        // How the repo is named in fixes the user may paste into `dg`: `owner/name` when
        // the registry knows it, else the contract id (which `dg` also accepts).
        let repo_label = contract_url
            .unwrap_or_else(|| format!("{}/{}", conn.repo.owner_id, conn.repo.normalized_name));
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
            if let Some(denied) = write_access_denied(conn).await {
                // The block says why and what to do; git's own `! [remote rejected]` lines
                // (from the per-ref reason) make the push fail.
                denied.error.eprint("dash: ");
                return Ok(specs
                    .iter()
                    .map(|s| PushOutcome::Error(s.dst.clone(), denied.wire.to_string()))
                    .collect());
            }
        }

        let planned = plan_pushes(specs, &remote_refs);
        let progress = Progress::new(options.verbosity);
        let balance_before = conn.identity.balance();
        let mut est_credits =
            policy::estimate_ref_updates(planned.iter().filter(|p| p.reject.is_none()).count());

        // Build + upload one pack covering all accepted, non-delete updates.
        let want_tips: Vec<String> = planned
            .iter()
            .filter(|p| p.reject.is_none())
            .filter_map(|p| p.new_oid.clone())
            .collect();
        if let (false, Some(push_policy)) = (want_tips.is_empty(), push_policy.as_ref()) {
            let ctx = PushContext {
                svc: &svc,
                repo: &conn.repo,
                repo_label,
                refs: planned
                    .iter()
                    .filter(|p| p.reject.is_none())
                    .map(|p| progress::short_ref(&p.spec.dst))
                    .collect(),
                git_dir: &git_dir,
                policy: push_policy,
                progress,
                dry_run,
            };
            // Storage first. Any error here — the policy's N not met, the cost guard
            // refusing, the manifest write failing — returns before a single ref update
            // is written, so no ref can point at history the policy did not store. A dry
            // run builds the pack and prints the plan, then stops.
            if let Some(est) = upload_push_pack(&ctx, &want_tips, &remote_refs).await? {
                est_credits = est;
            }
            // Test affordance, compiled only with `--features test-hooks`: stop after the
            // manifest landed and before any ref is written — the state a push interrupted
            // between the two leaves behind. e2e/cli/storage-byo.sh uses it to exercise
            // the re-push-of-an-already-recorded-pack path.
            #[cfg(feature = "test-hooks")]
            if !dry_run && std::env::var_os("DASH_FORGE_FAIL_BEFORE_REFS").is_some() {
                bail!("simulated interruption after the manifest, before the refs (DASH_FORGE_FAIL_BEFORE_REFS)");
            }
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
        let outcomes = finalize_outcomes(planned, &final_refs, dry_run);
        if progress.enabled && !dry_run && outcomes.iter().any(|o| matches!(o, PushOutcome::Ok(_)))
        {
            self.report_done(progress, balance_before, est_credits)
                .await;
        }
        Ok(outcomes)
    }

    /// The summary line with actuals: the balance change is what this push cost (≈: other
    /// spends by the same identity in the same seconds would be counted too). A balance
    /// that has not moved yet (read-after-write lag) is reported as the estimate, not as a
    /// free push. Only called when progress is shown, so a quiet push skips the read.
    async fn report_done(&self, progress: Progress, balance_before: u64, est_credits: u64) {
        let conn = self.conn.as_ref().expect("connected");
        let after = conn.client.get_balance(&conn.identity.id()).await.ok();
        let charge = match after.map(|a| balance_before.saturating_sub(a)) {
            Some(c) if c > 0 => Charge::Measured(c),
            _ => Charge::Estimated(est_credits),
        };
        let (text, event) = progress::done_line(
            charge,
            after,
            &conn.repo.owner_id,
            &conn.repo.normalized_name,
        );
        progress.emit(&text, &event);
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
        // `None` = a delete, converged once the ref reads as gone. Deletes wait too: a node
        // that has not applied the delete yet would otherwise make a landed delete read as
        // "did not take effect" (the nightly's 03 scenario hit exactly that).
        let expected: Vec<(&str, Option<&str>)> = planned
            .iter()
            .filter(|p| p.reject.is_none())
            .map(|p| (p.spec.dst.as_str(), p.new_oid.as_deref()))
            .collect();

        let mut last = svc.read_refs(&conn.repo).await?;
        for attempt in 1..=MAX_ATTEMPTS {
            let converged = expected.iter().all(|(dst, want)| {
                let state = last.iter().find(|(n, _)| n == dst).map(|(_, s)| s);
                match want {
                    Some(oid) => {
                        matches!(state, Some(RefState::Resolved { oid: got, .. }) if got == oid)
                    }
                    None => matches!(state, None | Some(RefState::Unborn)),
                }
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
    /// The repo as the user addressed it (`owner/name`), for the plan line.
    repo_label: String,
    /// Short names of the refs this push updates.
    refs: Vec<String>,
    git_dir: &'a std::path::Path,
    policy: &'a PushPolicy,
    progress: Progress,
    /// `--dry-run`: build the pack and print the plan, store nothing.
    dry_run: bool,
}

impl PushContext<'_> {
    /// A status line for the user (git shows the helper's stderr, `dash: `-prefixed).
    fn say(&self, line: &str) {
        self.progress.note(line);
    }
}

/// Rough JSON length of the manifest `uris` each external target adds (public URL + locator).
const URIS_JSON_PER_TARGET: u64 = 180;

/// Build one self-contained pack for `want_tips` (excluding remote tips already local as
/// thin-pack bases), store it according to the repo's storage policy, and record the
/// `packManifest`. Returns only once the policy's N copies are confirmed and the manifest
/// has landed; every failure before that is an error, and the caller writes no refs.
/// `Some(credits)`: the on-chain estimate for what this push stored (the summary line's
/// fallback when the balance has not moved yet).
async fn upload_push_pack(
    ctx: &PushContext<'_>,
    want_tips: &[String],
    remote_refs: &[(String, RefState)],
) -> Result<Option<u64>> {
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
    // Plan: what is pushed. A dry run always shows it (seeing it is the point of asking).
    let progress = Progress {
        enabled: ctx.progress.enabled || ctx.dry_run,
        ..ctx.progress
    };
    let (text, event) = progress::plan_line(&PlanFacts {
        repo: &ctx.repo_label,
        refs: &ctx.refs,
        tip: want_tips.first().map_or("", String::as_str),
        objects: pack.parsed.object_count() as u64,
        bytes: pack.bytes.len() as u64,
    });
    progress.emit(&text, &event);

    if pack.parsed.object_count() == 0 {
        tracing::info!("push adds no new objects; skipping pack upload and browse index");
        return Ok(None);
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
    let (text, event) = progress::targets_line(resolved, estimate.total());
    progress.emit(&text, &event);
    let platform_writes = |est: &policy::PushEstimate, stores_pack: bool| {
        progress::platform_line(&PlatformWrites {
            chunks: if stores_pack { job.chunk_count } else { 0 },
            manifests: 2,
            ref_updates: ctx.refs.len(),
            est_credits: est.total(),
        })
    };
    if ctx.dry_run {
        let (text, event) = platform_writes(&estimate, resolved.platform);
        progress.emit(&format!("{text} (dry run: nothing stored)"), &event);
        return Ok(None);
    }
    // Resolve every secret BEFORE asking the user to pay: a missing env var must fail
    // here, not after a "y" at the cost prompt.
    let externals = external_targets(ctx)?;
    policy::enforce(
        estimate.total(),
        ctx.policy,
        resolved.platform,
        policy::NOTE_NOTHING_STORED,
    )?;

    // An earlier push may already have recorded this exact pack (unique packHash; a
    // duplicate manifest create is treated as "already stored"). Decide BEFORE paying:
    // still readable → nothing to store; unreadable → refuse now, not after new copies.
    if let Some(existing) = ctx
        .svc
        .read_pack_manifest(ctx.repo, job.pack_hash)
        .await
        .context("checking for an existing manifest of this pack")?
    {
        // The browse index is left alone: the earlier push published (or tried to) the
        // fragment for this pack, and a missing one is rebuilt by the next repack.
        confirm_existing_manifest(ctx, &job, &existing).await?;
        return Ok(Some(policy::estimate_ref_updates(ctx.refs.len())));
    }

    let jpath = crate::journal::journal_path(ctx.git_dir, &job.meta.pack_hash);
    let replication = store_pack(ctx, &job, &externals, &jpath).await?;
    let stored_on_platform = replication.has_platform();
    let actual_estimate = job.estimate(ctx, stored_on_platform);
    let (text, event) = platform_writes(&actual_estimate, stored_on_platform);
    progress.emit(&text, &event);
    // Keep this clone's copy of an externally stored pack (.git/dash/packs/<sha256>.pack)
    // BEFORE the manifest names it: if every external copy is later lost — or this push
    // dies between the manifest and the refs — `dg reseed --from-local` can restore the
    // exact bytes. A Platform copy needs no local backup (chunks are on-chain).
    if !replication.has_platform() {
        if let Err(e) = forge_core::storage::local::keep_pushed_pack(
            ctx.git_dir,
            &job.meta.pack_hash,
            job.bytes,
        ) {
            tracing::warn!(error = %e, "could not keep a local copy of the pushed pack");
        }
    }
    record_pack(ctx, &job, &replication).await?;

    // Push fully landed (copies + manifest). The chunk journal is the only record of
    // chunks an interrupted Platform upload wrote; retire it only when this manifest
    // references those chunks. Otherwise keep it and say so — those chunks are paid for,
    // referenced by nothing, and reclaimable only while the journal names them.
    if replication.has_platform() {
        let _ = std::fs::remove_file(&jpath);
    } else if jpath.exists() {
        ctx.say(&format!(
            "note: an earlier interrupted push left Platform chunks for this pack that \
             this push did not use (journal kept at {}); they hold a refundable deposit until \
             deleted (dg repo delete / admin teardown), or re-push with dash.storage including \
             platform to put them to use",
            jpath.display()
        ));
    }
    publish_browse_index(ctx, &pack.parsed, job.pack_hash, &replication, &externals).await;
    Ok(Some(actual_estimate.total()))
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
            ctx.refs.len(),
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
    // One progress line per target, printed the moment it is stored and verified.
    let progress = ctx.progress;
    let bytes_len = job.bytes.len() as u64;
    let report = move |o: &StoreOutcome<'_>| {
        let (text, event) = progress::target_line(o, bytes_len);
        progress.emit(&text, &event);
    };
    let observed: Vec<Observed<'_>> = externals
        .iter()
        .map(|t| t as &dyn StorageTarget)
        .chain(chain.iter().map(|c| c as &dyn StorageTarget))
        .map(|t| Observed::new(t, &report))
        .collect();
    let targets: Vec<&dyn StorageTarget> =
        observed.iter().map(|t| t as &dyn StorageTarget).collect();

    // No policy (Platform only): keep the pre-policy behaviour exactly — the chunk
    // upload's own typed error (TokenFrozen, Unauthorized, InsufficientCredits, …) under
    // the familiar context, with no policy/fallback advice that cannot apply.
    if let (true, 1, Some(chain)) = (resolved.external.is_empty(), resolved.total(), &chain) {
        let uris = Observed::new(chain, &report)
            .store(job.bytes, &job.meta)
            .await
            .context("uploading pack chunks")?;
        return Ok(Replication {
            replicas: vec![Replica {
                target: forge_core::storage::PLATFORM_PROFILE.into(),
                uris,
                platform: true,
            }],
            failures: Vec::new(),
        });
    }

    let err = match replicate(&targets, job.bytes, &job.meta, resolved.replicas).await {
        Ok(rep) => return Ok(rep),
        Err(err) => err,
    };
    if !resolved.platform_fallback {
        return Err(UserError::storage_policy_not_met(&err, "push failed", false).into());
    }

    // The external copies could not meet N: keep what did confirm, and add the on-chain
    // copy the user opted into as the fallback (costed and guarded like any paid write).
    ctx.say(&err.to_string());
    let fallback_cost = job.estimate(ctx, true);
    ctx.say(&format!(
        "dash.platformFallback: storing the pack on Platform instead, est. {} DASH",
        dash(fallback_cost.total())
    ));
    policy::enforce(
        fallback_cost.total(),
        ctx.policy,
        true,
        policy::NOTE_NOTHING_PAID_ON_PLATFORM,
    )?;
    let fallback = platform_target();
    let fallback = Observed::new(&fallback, &report);
    let chain_rep = replicate(&[&fallback as &dyn StorageTarget], job.bytes, &job.meta, 1)
        .await
        .map_err(|e| {
            let mut u = UserError::storage_policy_not_met(&err, "push failed", true)
                .note(NOTE_PLATFORM_CHUNKS_JOURNALED);
            u.cause = Some(format!(
                "{}; platform (dash.platformFallback): {}",
                u.cause.unwrap_or_default(),
                e.failures
                    .iter()
                    .map(|f| f.reason.as_str())
                    .collect::<Vec<_>>()
                    .join("; ")
            ));
            anyhow::Error::from(u)
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
            "warning: {} did not confirm: {}",
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
        "pack {} ({}) stored on {} ({} verified)",
        &job.meta.pack_hash[..12],
        human_bytes(job.bytes.len() as u64),
        confirmed.join(", "),
        confirmed.len()
    ));
    Ok(())
}

/// This pack already has a manifest (an earlier push recorded it). Accept it only if at
/// least one copy it records is readable and hash-matches; otherwise refuse — before this
/// push pays for anything — naming the dead copies and the way back.
///
/// A Platform-tier (`storage = 0`) manifest written by this identity for a pack of the
/// same size is accepted without a download: its chunks were confirmed at consensus when
/// it was written, and a plain Platform re-push (the common "interrupted after the
/// manifest" resume) must not re-download the whole pack to find that out.
async fn confirm_existing_manifest(
    ctx: &PushContext<'_>,
    job: &PackJob<'_>,
    existing: &forge_core::repo::PackManifestInfo,
) -> Result<()> {
    let short = &job.meta.pack_hash[..12];
    let on_chain = existing.storage == 0
        && existing.chunk_count == u64::from(job.chunk_count)
        && existing.size_bytes == job.bytes.len() as u64;
    if on_chain {
        ctx.say(&format!(
            "pack {short} is already stored on Platform by an earlier push; not storing it again"
        ));
        return Ok(());
    }
    let reader = PackReader::from_user_config();
    match ctx.svc.fetch_artifact(ctx.repo, existing, &reader).await {
        Ok(bytes) if PackMeta::for_bytes(&bytes).pack_hash == job.meta.pack_hash => {
            ctx.say(&format!(
                "pack {short} was already recorded by an earlier push and is still \
                 readable; not storing it again"
            ));
            Ok(())
        }
        other => {
            let why = match other {
                Ok(_) => "bytes did not match".to_string(),
                Err(e) => e.to_string(),
            };
            let recorded = if existing.uris.is_empty() {
                "Platform chunks".to_string()
            } else {
                existing.uris.join(", ")
            };
            Err(UserError::new(
                codes::RECORDED_COPY_LOST,
                format!("push refused: pack {short} is already recorded, and no recorded copy is readable"),
            )
            .cause(format!("pack {} already recorded at {recorded}: {why}", job.meta.pack_hash))
            .fix(format!(
                "re-upload it from this clone: `dg reseed {} --from-local` (run inside this repository), then push again",
                ctx.repo_label
            ))
            .fix("or restore that storage, then push again")
            .note("nothing was stored and no ref was updated")
            .into())
        }
    }
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
    // `DASH_FORGE_NO_BROWSE_INDEX=1` skips it on purpose: the nightly's read fixture
    // (e2e/cli/seed-read-fixture.sh) must stay unindexed so the web app's fallback clone is
    // what the browser specs exercise.
    if matches!(
        std::env::var("DASH_FORGE_NO_BROWSE_INDEX").as_deref(),
        Ok("1" | "true")
    ) {
        tracing::info!("DASH_FORGE_NO_BROWSE_INDEX set; not publishing a browse-index fragment");
        return;
    }
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
                "warning: the push landed but its browse-index fragment could not be \
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

/// Resolve the network and registry. Precedence, field by field: the environment
/// (`DASH_FORGE_NETWORK`, `DASH_FORGE_DEVNET_NAME`, `DASH_FORGE_DAPI_ADDRESSES`,
/// `DASH_FORGE_QUORUM_URL`, `FORGE_REGISTRY_CONTRACT_ID` — what `dg` and forge-import set
/// per invocation) > git config (`dash.network`, `dash.devnetName`, `dash.dapiAddresses`,
/// `dash.quorumUrl`, `dash.registryContractId`) > the embedded deployment > testnet.
pub(crate) fn network_target() -> Result<NetworkTarget> {
    resolve_network(
        NetworkSettings::from_env(),
        NetworkSettings::from_git_config(crate::git::config_get),
    )
}

fn resolve_network(env: NetworkSettings, git: NetworkSettings) -> Result<NetworkTarget> {
    env.overlay(git)
        .resolve()
        .context("resolving the network (DASH_FORGE_NETWORK / git config dash.network)")
}

/// Whether `DASH_FORGE_SKIP_WRITE_PRECHECK` asks to bypass [`write_access_denied`].
fn skip_write_precheck() -> bool {
    matches!(
        std::env::var("DASH_FORGE_SKIP_WRITE_PRECHECK").as_deref(),
        Ok("1" | "true")
    )
}

/// The note on a push the helper refused before doing anything.
const NOTE_PRECHECK: &str = "checked before building or paying for anything: nothing was stored";

/// E301 — no identity file to sign with.
fn no_identity(why: impl Into<String>) -> anyhow::Error {
    UserError::new(codes::NO_IDENTITY, "no identity configured")
        .cause(why)
        .fix("export DASH_FORGE_KEY=<identity file> (the bridge identity export) in the shell you run git in")
        .into()
}

/// The helper's own refusal of a push it can prove would be rejected: the block printed to
/// stderr, and the short per-ref reason git shows in `! [remote rejected] … (<reason>)`.
struct Denied {
    error: UserError,
    wire: &'static str,
}

/// `Some(refusal)` when the connected identity provably holds no spendable WRITE or MAINTAIN
/// token on the repo, and so cannot land any push.
///
/// Returns `None` — i.e. proceed — when the holding cannot be determined. The token history
/// read is advisory: consensus is the authority, and a transient read failure must not block
/// a push a holder is entitled to make.
async fn write_access_denied(conn: &Conn) -> Option<Denied> {
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
    Some(write_denied(
        frozen_grants(&records, &me, now),
        &format!("{}/{}", conn.repo.owner_id, conn.repo.name),
        &me,
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
///
/// Worded unlike the consensus errors ("token frozen: …", "unauthorized: …"), so a caller
/// (the e2e suite) can tell this local refusal from a network verdict.
fn write_denied(frozen: Holdings, repo: &str, me: &str) -> Denied {
    let which = match (frozen.write, frozen.maintain) {
        (true, true) => Some("WRITE and MAINTAIN tokens on this repo are"),
        (true, false) => Some("WRITE token on this repo is"),
        (false, true) => Some("MAINTAIN token on this repo is"),
        (false, false) => None,
    };
    if let Some(which) = which {
        return Denied {
            error: UserError::new(
                codes::SUSPENDED,
                format!("push rejected: your {which} frozen"),
            )
            .cause("a maintainer suspended your push access, so consensus would reject this push")
            .fix(format!(
                "ask a maintainer to run `dg collab unsuspend {repo} {me}`"
            ))
            .note(NOTE_PRECHECK),
            wire: "your token on this repo is frozen",
        };
    }
    // `dg pr create` takes the target repo POSITIONALLY as `owner/name`, which is what the
    // pusher typed into their remote URL — not the contract id.
    Denied {
        error: UserError::new(
            codes::NOT_A_WRITER,
            format!("push rejected: you are not a writer of {repo}"),
        )
        .cause("no WRITE token on this repo for your identity")
        .fix(format!(
            "ask the owner to run `dg collab add {repo} {me} --role write`"
        ))
        .fix(format!(
            "or fork it and open a pull request: `dg repo create <name>`, push your branch there, then `dg pr create {repo} --title <t> --source-contract <your contract id> --head-oid <oid>`"
        ))
        .note(NOTE_PRECHECK),
        wire: "no WRITE token on this repo",
    }
}

/// Resolve the identity key file: `DASH_FORGE_KEY` if set, else
/// `~/.config/dash-forge/identities/<owner>.identity.json`.
fn resolve_key_path(url: &DashUrl) -> Result<PathBuf> {
    if let Some(p) = std::env::var_os("DASH_FORGE_KEY") {
        return Ok(PathBuf::from(p));
    }
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| no_identity("neither DASH_FORGE_KEY nor HOME is set"))?;
    // The per-owner default only makes sense for the named form. A contract-addressed URL
    // names no owner (that is the point), so it requires an explicit DASH_FORGE_KEY —
    // which is fine, because it is reached from `dg`, not typed by hand.
    let owner = match url {
        DashUrl::Named { owner, .. } => owner.clone(),
        DashUrl::Contract { .. } => {
            return Err(no_identity(
                "a contract-addressed dash:// URL has no owner to pick a default key for",
            ))
        }
    };
    Ok(home
        .join(".config/dash-forge/identities")
        .join(format!("{owner}.identity.json")))
}

#[cfg(test)]
mod tests {
    use super::{frozen_grants, oid_to_bytes, resolve_network, write_denied, PushOutcome};
    use forge_core::network::NetworkSettings;
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
        let d = write_denied(write, "owner/repo", "me");
        let text = d.error.render("dash: ", false);
        assert_eq!(d.error.code, "E602");
        assert!(
            text.contains("WRITE token on this repo is frozen"),
            "{text}"
        );
        assert!(text.contains("dg collab unsuspend owner/repo me"), "{text}");
        assert!(!text.contains("dg pr create"), "{text}");
        // Must not read as the consensus error, or e2e scenario 04 could not tell a local
        // refusal from a network verdict.
        assert!(!text.contains("token frozen"), "{text}");
        assert!(!d.wire.contains("token frozen"));

        let maintain = Holdings {
            write: false,
            maintain: true,
        };
        let text = write_denied(maintain, "owner/repo", "me")
            .error
            .render("", false);
        assert!(
            text.contains("MAINTAIN token on this repo is frozen"),
            "{text}"
        );

        let none = write_denied(Holdings::default(), "owner/repo", "me");
        assert_eq!((none.error.code, none.error.exit_code()), ("E601", 6));
        assert_eq!(none.wire, "no WRITE token on this repo");
        let text = none.error.render("dash: ", false);
        assert!(
            text.starts_with("dash: error: push rejected: you are not a writer of owner/repo"),
            "{text}"
        );
        assert!(
            text.contains("dg collab add owner/repo me --role write"),
            "{text}"
        );
        assert!(text.contains("dg pr create owner/repo"), "{text}");
        assert!(text.lines().all(|l| l.starts_with("dash: ")), "{text}");
    }

    fn git_devnet() -> NetworkSettings {
        NetworkSettings::from_git_config(|k| match k {
            "dash.network" => Some("devnet".into()),
            "dash.devnetName" => Some("moutai".into()),
            "dash.dapiAddresses" => Some("10.0.0.1,10.0.0.2".into()),
            _ => None,
        })
    }

    #[test]
    fn git_config_selects_a_devnet_when_the_env_is_silent() {
        let t = resolve_network(NetworkSettings::default(), git_devnet()).unwrap();
        assert_eq!(t.network.key(), "devnet-moutai");
    }

    #[test]
    fn the_env_beats_git_config() {
        let env = NetworkSettings {
            network: Some("testnet".into()),
            ..Default::default()
        };
        let t = resolve_network(env, git_devnet()).unwrap();
        assert_eq!(t.network.key(), "testnet");
    }

    #[test]
    fn nothing_configured_is_testnet() {
        let t = resolve_network(NetworkSettings::default(), NetworkSettings::default()).unwrap();
        assert_eq!(t.network.key(), "testnet");
        assert!(t.registry.is_some());
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
