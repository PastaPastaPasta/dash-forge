//! The stateful helper: resolves config, connects to Platform lazily, and implements the
//! `list` / `fetch` / `push` operations against `forge-core`'s [`RepoService`].
//!
//! Data flow (architecture §6):
//! - **resolve** → `dash://owner/name` is a forge-v2 `repo` by `($ownerId, name)`;
//!   `dash://<id>` a repo document id (`forge_core::resolve`).
//! - **list** → `read_refs` (proof-verified, folded by the ref rules) → `<oid> <ref>` lines
//!   + the `HEAD` symref from the repo's default branch.
//! - **fetch** → every kind-0 pack's copies → the first copy that verifies, in the
//!   `FORGE_RULES_V2` order (maintainers' copies first) → `git index-pack` into the local
//!   odb. A `--filter` partial clone re-packs the download through a scratch repo and
//!   writes the `.promisor` marker (S0.9).
//! - **push** → fast-forward check vs remote refs → `build_pack` (thin + `--fix-thin` =
//!   self-contained) → the repo's storage policy (`dash.storage` / `dash.replicas`, see
//!   [`crate::policy`]) → cost guard → replicate the pack to every target in parallel,
//!   each upload re-read and hash-verified, failing unless N confirm →
//!   `write_pack_manifest` (every confirmed URI + the SHA-256) → `write_ref_update`
//!   (prevOid recorded; non-FF refused without `+`) → post-push ref re-read for a
//!   lost-race late non-fast-forward. Refs are written ONLY after the storage policy is
//!   met and the manifest has landed.

use std::path::{Path, PathBuf};

use anyhow::{anyhow, bail, Context, Result};
use forge_core::backends::PackMeta;
use forge_core::cost::push_fees;
use forge_core::keystore::BridgeIdentity;
use forge_core::members::MemberReader;
use forge_core::network::{NetworkSettings, NetworkTarget};
use forge_core::pack::{build_pack, split, KIND_GIT_PACK};
use forge_core::platform::{LoadedIdentity, PlatformClient};
use forge_core::repo::{
    group_by_hash, HistoryCost, PackManifestInput, PlatformChunkTarget, PreparedHistory,
    RepackTarget, RepoService, StoredArtifact,
};
use forge_core::rules::RefState;
use forge_core::scope::RepoRef;
use forge_core::storage::{
    human_bytes, replicate, ExternalTarget, Observed, PackReader, Replica, Replication,
    StorageTarget, StoreOutcome,
};
use forge_core::user_error::{codes, dash, UserError, NOTE_PLATFORM_CHUNKS_JOURNALED};

use futures::stream::{self, StreamExt, TryStreamExt};

use crate::git::{names_missing_object, LocalRepo, ScratchRepo};
use crate::options::OptionState;
use crate::policy::{self, PushPolicy};
use crate::progress::{self, Charge, PlanFacts, PlatformWrites, Progress};
use crate::secret_scan;
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

/// The signing identity and its key material.
struct Signer {
    identity: LoadedIdentity,
    bridge: BridgeIdentity,
}

/// A live Platform connection plus the resolved repo handle.
struct Conn {
    client: PlatformClient,
    repo: RepoRef,
    /// A private repository's keys, read once when the helper connects and replaced by every
    /// write-time reload of any of its services.
    keyring: forge_core::repo::KeyringCache,
    /// The signing identity, loaded only when something needs it: a push, or opening a
    /// private repository. `list` and `fetch` of a public repository never load one, so
    /// anyone can clone without an identity (F-2).
    signer: Option<Signer>,
}

impl Conn {
    /// The data-plane service: signing as the loaded identity, with this invocation's
    /// keyring (a private repo's), or an anonymous reader when no identity is loaded.
    fn service(&self) -> RepoService<'_> {
        match &self.signer {
            Some(s) => RepoService::with_keyring(
                &self.client,
                &s.identity,
                &s.bridge,
                std::sync::Arc::clone(&self.keyring),
            ),
            None => RepoService::reader(&self.client),
        }
    }

    /// The signing identity. Only called on the push path, after [`Helper::ensure_signer`].
    fn identity(&self) -> &LoadedIdentity {
        &self
            .signer
            .as_ref()
            .expect("the push path loads the signer first")
            .identity
    }
}

/// The remote helper, holding parsed config and a lazily-established connection.
pub struct Helper {
    url: DashUrl,
    /// The git remote name (`origin`), when git invoked us for a named remote — selects
    /// the per-remote `remote.<name>.dash*` storage settings.
    remote: Option<String>,
    target: NetworkTarget,
    conn: Option<Conn>,
}

impl Helper {
    /// Build a helper for `url`, reading the network config from the environment and git
    /// config ([`network_target`]). No identity is read here: see [`Self::ensure_signer`].
    pub fn new(url: DashUrl, remote: Option<String>) -> Result<Self> {
        let target = network_target()?;
        Ok(Self {
            url,
            remote,
            target,
            conn: None,
        })
    }

    /// Establish (once) the Platform connection and resolve the repo. Anonymous for a public
    /// repository; a private one needs the reader's identity (its ENCRYPTION key opens the
    /// content), so that is loaded and checked here.
    async fn ensure_conn(&mut self) -> Result<&Conn> {
        if self.conn.is_none() {
            // No forge-v2 here: E702 now, not after connecting to a network with nothing on it.
            self.target.require_v2()?;
            let client = PlatformClient::connect(self.target.clone())
                .await
                .with_context(|| {
                    format!("connecting to Dash Platform ({})", self.target.network)
                })?;
            // The repository's append-only history lives with the clone
            // (`.git/dash/history`), so a fetch or push reads only what landed since the last.
            if let Ok(git_dir) = LocalRepo::git_dir() {
                client
                    .history()
                    .set_dir(git_dir.join("dash").join("history"));
            }
            let repo = match &self.url {
                DashUrl::Named { owner, repo } => {
                    forge_core::resolve::resolve_named(&client, owner, repo)
                        .await
                        .with_context(|| format!("resolving repo {owner}/{repo}"))?
                }
                DashUrl::Id { id } => forge_core::resolve::resolve_id(&client, id)
                    .await
                    .with_context(|| format!("resolving repo {id}"))?,
            };
            // Before anything is read or a key opened: is this still the repository the
            // clone was made from (a DPNS name can change hands)?
            self.check_pin(&repo)?;
            let keyring = forge_core::repo::KeyringCache::default();
            let mut signer = None;
            if repo.visibility == forge_core::rules::v2::Visibility::Private {
                let why = format!(
                    "{} is a private repository: reading it needs a member's identity (its ENCRYPTION key opens the content)",
                    repo.display()
                );
                let s = load_signer(&self.url, &client, &repo, &why).await?;
                let kr = require_private_key(&client, &s.identity, &s.bridge, &repo).await?;
                *keyring
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(kr);
                signer = Some(s);
            }
            tracing::info!(
                repo = %repo.id(),
                owner = %repo.owner_id(),
                "resolved dash:// repo"
            );
            self.conn = Some(Conn {
                client,
                repo,
                keyring,
                signer,
            });
        }
        Ok(self.conn.as_ref().expect("conn populated"))
    }

    /// Pin a named URL's resolution in the repository git runs us for, or refuse one that now
    /// resolves elsewhere (E504; [`crate::pin`]). Only when git named a repository
    /// (`GIT_DIR`): `git ls-remote` outside one has nothing to pin, and a directory git
    /// declined to use (safe.directory) is not written to.
    fn check_pin(&self, repo: &RepoRef) -> Result<()> {
        if std::env::var_os("GIT_DIR").is_none() {
            return Ok(());
        }
        let git_dir = LocalRepo::git_dir()?;
        let now = crate::pin::Pin {
            repo_id: repo.id().to_string(),
            owner_id: repo.owner_id().to_string(),
            network: self.target.network.key(),
        };
        let outcome = crate::pin::guard(
            &self.url,
            &git_dir,
            self.remote.as_deref(),
            &now,
            crate::pin::allow_repin,
        )?;
        tracing::debug!(?outcome, "dash:// pin");
        Ok(())
    }

    /// [`Self::ensure_conn`], plus the signing identity (loaded once, on first need): a push
    /// signs every document it writes.
    async fn ensure_signer(&mut self) -> Result<&Conn> {
        self.ensure_conn().await?;
        let conn = self.conn.as_ref().expect("conn populated");
        if conn.signer.is_none() {
            let why = "a push signs every document it writes";
            let s = load_signer(&self.url, &conn.client, &conn.repo, why).await?;
            self.conn.as_mut().expect("conn populated").signer = Some(s);
        }
        Ok(self.conn.as_ref().expect("conn populated"))
    }

    /// The `list` / `list for-push` response lines: `<oid> <refname>` per resolved ref and,
    /// for a fetch, an `@refs/heads/<default> HEAD` symref.
    pub async fn list(&mut self, for_push: bool) -> Result<Vec<String>> {
        let conn = self.ensure_conn().await?;
        let svc = conn.service();
        let refs = svc.read_refs(&conn.repo).await?;
        let default_branch = svc
            .read_default_branch(&conn.repo)
            .await?
            .unwrap_or_else(|| "main".to_string());
        // A fetch or clone of a public repository a maintainer marked as moved says where it
        // went (best effort, one small read); nothing is redirected.
        if !for_push {
            if let Ok(Some(id)) = svc.moved_to(&conn.repo).await {
                // A new repository that does not resolve is still a dash:// address (by id).
                let to = forge_core::resolve::resolve_id(&conn.client, &id)
                    .await
                    .map_or_else(|_| format!("dash://{id}"), |r| r.remote_url());
                eprintln!(
                    "{}",
                    moved_hint(&conn.repo.remote_url(), &to, self.remote.as_deref())
                );
            }
        }
        Ok(list_lines(&refs, &default_branch, for_push))
    }

    /// Serve a `fetch` batch: download the packs covering the wanted objects and index them
    /// into the local odb. Full clone indexes the self-contained packs directly; a
    /// `--filter` partial clone re-packs through a scratch repo and writes `.promisor`.
    pub async fn fetch(&mut self, wants: &[Want], options: &OptionState) -> Result<()> {
        // The sealed-object ledger, created empty on a clone or a fetch into a repository with
        // no refs ([`crate::ledger`]).
        crate::ledger::ensure_for_new_clone(options.cloning);
        // The local git odb is the cache — never re-download objects git already has
        // (architecture §6). For a plain (non-filter) fetch, if every wanted object is
        // already present locally there is nothing to transfer. (A promisor fetch still
        // runs, since a present commit may need its filtered blobs materialized.)
        if wants_already_local(wants, options) {
            tracing::info!(
                wants = wants.len(),
                "all wanted objects already local; skipping fetch"
            );
            return Ok(());
        }
        // The record of packs already held is advisory: if the wanted history is still
        // incomplete after an incremental fetch (a gc pruned objects of a recorded pack, or
        // the record came from another clone), or the incremental pass failed, fetch every
        // pack.
        let incremental = self.fetch_packs(wants, options, true).await;
        let want_oids: Vec<String> = wants.iter().map(|w| w.oid.clone()).collect();
        let complete = incremental_fetch_complete(incremental.is_ok(), options, &want_oids, || {
            LocalRepo::history_has_gaps(&want_oids)
        });
        if !complete {
            tracing::info!(
                error = ?incremental.err(),
                "the wanted history is incomplete after an incremental fetch; fetching every pack"
            );
            self.fetch_packs(wants, options, false).await?;
        }
        Ok(())
    }

    /// [`Self::fetch`]'s download: every stored git pack, or (`incremental`) only those not
    /// recorded as already held.
    async fn fetch_packs(
        &mut self,
        wants: &[Want],
        options: &OptionState,
        incremental: bool,
    ) -> Result<()> {
        let conn = self.ensure_conn().await?;
        let svc = conn.service();

        let manifests = svc.read_pack_manifests(&conn.repo).await?;
        let git_dir = LocalRepo::git_dir().ok();
        let have = git_dir
            .as_deref()
            .map(|d| crate::fetched::FetchedPacks::load(d, conn.repo.id()))
            .unwrap_or_default();
        let skip_held = incremental && options.filter.is_none();
        let git_packs = packs_to_fetch(manifests, skip_held.then_some(&have));
        if git_packs.is_empty() {
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
        //
        // forge-v2: each uploader may hold its own copy of a pack. A pack is read from the
        // first copy that verifies, maintainers' copies first (FORGE_RULES_V2 reader rule).
        let svc = &svc;
        let repo = &conn.repo;
        // Membership only ranks copies (and picks whose recorded gateways are trusted); if it
        // cannot be read, fall back to time order rather than failing the clone (every copy
        // is still hash-verified).
        let (contract, roles) = futures::join!(svc.repo_contract(repo), svc.copy_roles(repo));
        let contract = &contract?;
        let roles = &roles.unwrap_or_else(|e| {
            tracing::warn!(error = %e, "could not read the member list; trying pack copies in time order");
            forge_core::repo::RoleMap::new()
        });
        let reader = &svc.repo_reader(repo, &git_packs, roles).await;
        // A repository made public (private-repos.md §18.2): its packs from the private era are
        // sealed, and only the keys its owner published open them. Such a pack is checked by
        // its first bytes and skipped without downloading it when none does. Any other public
        // repository reads as before.
        let converted = match svc.conversion(repo).await {
            Ok(Some(c)) => Some((c, svc.public_keys(repo).await)),
            Ok(None) => None,
            Err(e) => {
                tracing::warn!(error = %e, "could not read the repository's settings history; every pack is downloaded and judged whole");
                None
            }
        };
        let converted = converted.as_ref();
        let packs = group_by_hash(&git_packs);
        // QW4-014: a terminal sees the packs and bytes come in, as git's own progress does.
        let meter = &fetch_meter(options, &packs);
        let fetched = stream::iter(packs.iter().map(|(h, copies)| async move {
            let got = fetch_one(svc, repo, contract, copies, roles, reader, h, converted).await;
            // Only a pack that arrived adds bytes; one set aside counts as done.
            let arrived = matches!(&got, Ok((_, Got::Bytes(_))));
            meter.advance(if arrived {
                copies.first().map_or(0, |m| m.size_bytes)
            } else {
                0
            });
            got
        }))
        .buffered(PACK_DOWNLOAD_WINDOW)
        .try_collect();
        let fetched: Result<Vec<([u8; 32], Got)>> = with_ticks(meter, fetched).await;
        // A failed download ends the line too, so the error starts on its own.
        meter.finish(fetched.is_ok());
        let fetched = fetched?;
        // Packs a fallback copy served: say which recorded copy is down, and why, while the
        // others still hold the history (the survivability drill asserts these lines). A
        // warning, so `-q` does not hide it (git keeps warnings under -q too).
        let progress = Progress {
            enabled: true,
            ..Progress::new(options.verbosity)
        };
        for line in
            forge_core::storage::read::fallback_lines(&reader.take_fallbacks(), &repo.display())
        {
            progress.note(&line);
        }
        let want_oids: Vec<String> = wants.iter().map(|w| w.oid.clone()).collect();
        let indexed: Vec<[u8; 32]> = fetched
            .iter()
            .filter(|(_, g)| matches!(g, Got::Bytes(_)))
            .map(|(h, _)| *h)
            .collect();
        let parent = parent_holding(&conn.client, svc, repo, &fetched).await;
        index_fetched(
            fetched.into_iter().map(|(_, g)| g).collect(),
            &want_oids,
            options,
            repo,
            packs.len(),
            parent.as_deref(),
        )?;
        // Record the packs indexed whole (not a partial clone's filtered subset), so the next
        // fetch downloads only what is new.
        if let (None, Some(d)) = (&options.filter, git_dir.as_deref()) {
            let mut have = have;
            for h in indexed {
                have.insert(h);
            }
            have.save(d, conn.repo.id());
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
        // `HEAD` is derived from the default branch, never stored: a push that names it
        // (`:HEAD`, `HEAD:HEAD`) writes nothing and is never charged.
        let (head, refs): (Vec<PushSpec>, Vec<PushSpec>) =
            specs.iter().cloned().partition(|s| is_head(&s.dst));
        let mut outcomes: Vec<PushOutcome> = head.into_iter().map(head_outcome).collect();
        if !refs.is_empty() {
            outcomes.extend(Box::pin(self.push_refs(&refs, options)).await?);
        }
        Ok(outcomes)
    }

    /// [`Self::push`] of real refs (no `HEAD`).
    // One push, in order: plan, store, refs, indexes, read-back; each step is its own function.
    #[allow(clippy::too_many_lines)]
    async fn push_refs(
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
                PushPolicy::load_for_push(self.remote.as_deref(), options)
                    .context("reading the storage policy (dash.storage / dash.replicas)")?,
            )
        } else {
            None
        };
        let conn = self.ensure_signer().await?;
        // How the repo is named in fixes the user may paste into `dg`: `owner/name`.
        let repo_label = conn.repo.display();
        let svc = conn.service();

        let remote_refs = svc.read_refs(&conn.repo).await?;

        // Fail fast when this identity is not a member. Consensus is the authority —
        // `refUpdate`, `chunk` and `packManifest` are all `ownerRefersTo`-gated on a
        // `maintainer`/`writer` document, so a non-member's push cannot land regardless
        // (40120). But without this check the helper builds a pack and broadcasts chunk
        // transitions that consensus rejects, surfacing a raw platform error. That error is
        // the first thing a would-be contributor sees, and it teaches them nothing; this is
        // the moment to point them at `dg collab` or a fork instead.
        //
        // `DASH_FORGE_SKIP_WRITE_PRECHECK=1` skips the check, so a caller that needs to see
        // what consensus itself does with an unauthorized push (the e2e ACL scenarios) can.
        let mut refused = Vec::new();
        let kept;
        let specs = if !dry_run && !specs.is_empty() && !skip_write_precheck() {
            (refused, kept) = precheck(conn, &svc, specs, options).await;
            if kept.is_empty() {
                return Ok(refused);
            }
            &kept[..]
        } else {
            specs
        };

        let mut planned = plan_pushes(specs, &remote_refs, options);
        // Before anything is built, signed or stored: a public push publishes for good.
        if conn.repo.visibility == forge_core::rules::v2::Visibility::Public {
            check_secrets(conn, &mut planned, &remote_refs, options).await;
        }
        let progress = Progress::new(options.verbosity);
        let balance_before = conn.identity().balance();
        let mut est_credits = push_fees::estimate_ref_updates(
            planned.iter().filter(|p| p.reject.is_none()).count() as u64,
        );

        // Build + upload one pack covering all accepted, non-delete updates.
        let want_tips: Vec<String> = planned
            .iter()
            .filter(|p| p.reject.is_none())
            .filter_map(|p| p.new_oid.clone())
            .collect();
        let mut sealed_cache = None;
        let mut pending_index = None;
        let mut history_paid = HistoryTarget::None;
        let mut stored: Option<StoredWith> = None;
        // Computed before anything is priced, so the push's estimate and cost guard include it.
        let history = if !want_tips.is_empty() && (dry_run || publishes_browse_index()) {
            prepare_push_history(&svc, &conn.repo, &planned, &git_dir, progress).await
        } else {
            None
        };
        let ctx = match (want_tips.is_empty(), push_policy.as_ref()) {
            (false, Some(push_policy)) => Some(PushContext {
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
                identity: conn.identity().id(),
                sealed: std::cell::RefCell::default(),
                history_cost: std::cell::Cell::new(history.as_ref().map(|h| h.prepared.cost())),
                history_fallback: history
                    .as_ref()
                    .and_then(|h| h.prepared.fallback())
                    .map(PreparedHistory::cost),
                history_on_fallback: std::cell::Cell::new(false),
            }),
            _ => None,
        };
        if let Some(ctx) = &ctx {
            // Storage first. Any error here — the policy's N not met, the cost guard
            // refusing, the manifest write failing — returns before a single ref update
            // is written, so no ref can point at history the policy did not store. A dry
            // run builds the pack and prints the plan, then stops.
            if let Some(up) = upload_push_pack(ctx, &want_tips, &remote_refs).await? {
                est_credits = up.est_credits;
                pending_index = up.index;
                history_paid = up.history;
            }
            sealed_cache = ctx.sealed.take();
            // Test affordance, compiled only with `--features test-hooks`: stop after the
            // manifest landed and before any ref is written — the state a push interrupted
            // between the two leaves behind. e2e/cli/storage-byo.sh uses it to exercise
            // the re-push-of-an-already-recorded-pack path.
            #[cfg(feature = "test-hooks")]
            if !dry_run && std::env::var_os("DASH_FORGE_FAIL_BEFORE_REFS").is_some() {
                if pending_index.is_some() {
                    index_skipped(ctx, &reindex_skip("the push stopped before its refs"));
                }
                bail!("simulated interruption after the manifest, before the refs (DASH_FORGE_FAIL_BEFORE_REFS)");
            }
        }

        // Apply ref updates for accepted specs, then publish the browse index.
        if !dry_run {
            let refs = write_ref_updates(&svc, &conn.repo, &mut planned, progress).await;
            if refs.is_ok() {
                forget_sealed(sealed_cache.as_deref());
            }
            stored = publish_index_after_refs(ctx.as_ref(), pending_index).await;
            refs?;
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
            read_refs_until_converged(conn, &planned).await?
        };
        if let (Some(ctx), Some(history)) = (ctx.as_ref(), history) {
            // The guard took the fallback delta over a due full index: publish what was paid for.
            let history = if ctx.history_on_fallback.get() {
                let branch = history.branch;
                history
                    .prepared
                    .into_fallback()
                    .map(|prepared| PushHistory { prepared, branch })
            } else {
                Some(history)
            };
            if let Some(history) = history {
                publish_history_after_refs(ctx, history, history_paid, stored, &final_refs).await;
            }
        }
        // The branches that moved: the PRs following them get a head update (review-parity
        // R14). Read before `finalize_outcomes` consumes the plan.
        let moved = moved_branches(&planned, &final_refs);
        let outcomes = finalize_outcomes(planned, &final_refs, dry_run);
        if !dry_run && !moved.is_empty() {
            self.sync_prs(&moved, progress).await;
        }
        let reporting = progress.enabled || progress::reporting();
        if reporting && !dry_run && outcomes.iter().any(|o| matches!(o, PushOutcome::Ok(_))) {
            self.report_done(progress, balance_before, est_credits)
                .await;
        }
        refused.extend(outcomes);
        Ok(refused)
    }

    /// Post the head updates of the PRs following `moved` ([`crate::pr_sync`]). Never fails
    /// the push: its refs already landed.
    async fn sync_prs(&self, moved: &[crate::pr_sync::Moved], progress: Progress) {
        let conn = self.conn.as_ref().expect("connected");
        let Some(s) = &conn.signer else {
            return;
        };
        let enabled = match crate::pr_sync::auto_sync_enabled(self.remote.as_deref()) {
            Ok(e) => e,
            Err(e) => {
                progress.note(&format!("{e}; not updating pull requests"));
                return;
            }
        };
        let collab = forge_core::collab::v2::Collab::new(&conn.client, &s.identity, &s.bridge);
        // A private repository's PRs are sealed and found by keyed hashes, not the plain
        // `sourceRef` index this lookup uses: `dg pr sync` moves their heads.
        if conn.repo.visibility == forge_core::rules::v2::Visibility::Private {
            return;
        }
        let outcomes =
            crate::pr_sync::sync_after_push(&collab, &conn.repo, moved, enabled, progress).await;
        for o in &outcomes {
            if let crate::pr_sync::Outcome::Synced {
                repo,
                number,
                event,
            } = o
            {
                progress.emit(
                    &format!("dash: PR #{number} in {repo} now follows this push ({event})"),
                    &serde_json::json!({ "event": "prSync", "repo": repo, "pr": number, "eventId": event }),
                );
                progress::report(
                    &serde_json::json!({ "event": "prSync", "repo": repo, "pr": number, "eventId": event }),
                );
            }
        }
    }

    /// The summary line with actuals: the balance change is what this push cost (≈: other
    /// spends by the same identity in the same seconds would be counted too). A balance
    /// that has not moved yet (read-after-write lag) is reported as the estimate, not as a
    /// free push. Only called when progress is shown or a report file is set, so a quiet
    /// push skips the read.
    async fn report_done(&self, progress: Progress, balance_before: u64, est_credits: u64) {
        let conn = self.conn.as_ref().expect("connected");
        let after = conn.client.get_balance(&conn.identity().id()).await.ok();
        let charge = match after.map(|a| balance_before.saturating_sub(a)) {
            Some(c) if c > 0 => Charge::Measured(c),
            _ => Charge::Estimated(est_credits),
        };
        let (text, event) = progress::done_line(
            charge,
            after,
            conn.repo.owner_id(),
            conn.repo.name(),
            conn.repo.visibility,
        );
        progress.emit(&text, &event);
        progress::report(&event);
    }
}

/// Re-read refs, retrying briefly until every accepted non-delete spec resolves to its pushed
/// tip (tolerating read-after-write lag), or the retry budget is spent.
async fn read_refs_until_converged(
    conn: &Conn,
    planned: &[Planned],
) -> Result<Vec<(String, RefState)>> {
    const MAX_ATTEMPTS: usize = 6;
    let svc = conn.service();
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

/// The accepted, non-delete updates of `planned` that `final_refs` shows landed.
fn moved_branches(
    planned: &[Planned],
    final_refs: &[(String, RefState)],
) -> Vec<crate::pr_sync::Moved> {
    planned
        .iter()
        .filter(|p| p.reject.is_none())
        .filter_map(|p| {
            let oid = p.new_oid.clone()?;
            let landed = final_refs.iter().any(|(n, st)| {
                n == &p.spec.dst && matches!(st, RefState::Resolved { oid: got, .. } if *got == oid)
            });
            landed.then(|| crate::pr_sync::Moved {
                ref_name: p.spec.dst.clone(),
                oid,
            })
        })
        .collect()
}

/// One pack of a fetch ([`Helper::fetch_packs`]): the bytes of the first of its `copies` that
/// verifies (opened, when sealed), or why it was set aside. `converted`: the facts of a
/// repository made public and the keys this reader holds for it, which can skip a sealed pack
/// before it is downloaded.
#[allow(clippy::too_many_arguments)]
async fn fetch_one(
    svc: &RepoService<'_>,
    repo: &RepoRef,
    contract: &forge_core::platform::LoadedContract,
    copies: &[&forge_core::repo::PackManifestInfo],
    roles: &forge_core::repo::RoleMap,
    reader: &forge_core::storage::read::PackReader,
    h: &[u8; 32],
    converted: Option<&(
        forge_core::private::convert::Conversion,
        Option<std::sync::Arc<forge_core::keyring::Keyring>>,
    )>,
) -> Result<([u8; 32], Got)> {
    let hash = hex::encode(h);
    if let Some((conversion, keys)) = converted {
        if let Some(s) = svc
            .skip_before_download(repo, contract, copies, reader, conversion, keys.as_deref())
            .await
        {
            tracing::info!(pack = %hash, why = ?s.why, "a sealed pack this reader holds no key for; not downloaded");
            return Ok((*h, Got::Skipped(s)));
        }
    }
    let got = match svc
        .fetch_best_copy_or_mirror(repo, contract, copies, roles, reader)
        .await
    {
        // A private repository's copy verified by its (ciphertext) hash; open it.
        // A key error is not a dead mirror: the bytes are here and verified, and no
        // other copy of the same hash would open differently. It fails the fetch with
        // its own code (E307/E309/E509). Only content hidden by the late-content rule
        // (E510, a removed member's upload) is skipped like an unreachable pack.
        Ok((sealed, m)) => {
            let got = PackMeta::for_bytes(&sealed).pack_hash;
            if !got.eq_ignore_ascii_case(&hash) {
                bail!(
                    "pack integrity check failed: expected {}…, got {}…",
                    progress::abbrev(&hash, 16),
                    progress::abbrev(&got, 16)
                );
            }
            match svc.open_or_skip(repo, copies, m.size_bytes, sealed).await {
                Ok(forge_core::repo::ArtifactRead::Bytes(b)) => Ok((b, m)),
                // sealed under a key this reader does not hold (a repository made public), or a
                // header this client does not open: set aside, never fatal by itself
                Ok(forge_core::repo::ArtifactRead::Skipped(s)) => {
                    tracing::info!(pack = %hash, why = ?s.why, "a sealed pack this reader cannot open; continuing without it");
                    return Ok((*h, Got::Skipped(s)));
                }
                Err(forge_core::Error::User(u)) if u.code == codes::LATE_CONTENT => {
                    tracing::info!(pack = %hash, "{u}; continuing without it");
                    return Ok((*h, Got::Hidden(*u)));
                }
                Err(e) => {
                    return Err(anyhow::Error::from(e)
                        .context(format!("opening pack {}…", progress::abbrev(&hash, 12))));
                }
            }
        }
        Err(e) => Err(e),
    };
    // A pack is required when a CURRENT MEMBER recorded it on Platform: on forge-v2
    // anyone who was a writer can post a manifest, so a stranger's chunkless
    // `storage = 0` copy must not turn an unreadable pack into a failed clone (it is
    // set aside below, and fails the fetch with E503 only if the history needs it).
    let on_chain = copies
        .iter()
        .any(|m| m.storage == 0 && roles.contains_key(&m.owner_id));
    let bytes = match got {
        Ok((bytes, _)) => bytes,
        Err(e) if on_chain => {
            return Err(anyhow::Error::from(e)
                .context(format!("downloading pack {}…", progress::abbrev(&hash, 12))));
        }
        // An external-only pack whose copies are down, rate-limited or absent is set
        // aside rather than failing the fetch at once: it may not be needed (it only
        // holds a deleted branch, or a repack superseded it and the consolidated
        // pack arrived, forge-v2 §4). Once the rest is indexed the wanted history is
        // checked, and a gap fails the fetch with E503 naming these packs
        // ([`packs_unreadable`]) instead of git's "did not send all necessary
        // objects". Every candidate is bounded (size-scaled deadline + idle
        // timeout), so this cannot hang.
        Err(e) => {
            tracing::info!(pack = %hash, copies = copies.len(), error = %e, "external pack unobtainable; continuing without it");
            return Ok((
                *h,
                Got::Unreadable(Unreadable {
                    hash,
                    error: e.to_string(),
                }),
            ));
        }
    };
    Ok((*h, Got::Bytes(bytes)))
}

/// `work`, redrawing `meter` every [`progress::FETCH_REDRAW`] while it runs (a single large
/// pack read from Platform finishes no pack for minutes).
async fn with_ticks<T>(
    meter: &progress::FetchMeter,
    work: impl std::future::Future<Output = T>,
) -> T {
    if !meter.enabled() {
        return work.await;
    }
    let ticks = async {
        loop {
            tokio::time::sleep(progress::FETCH_REDRAW).await;
            meter.tick();
        }
    };
    tokio::select! {
        out = work => out,
        () = ticks => unreachable!("the ticker never ends"),
    }
}

/// The fetch's progress meter ([`progress::FetchMeter`]) over `packs`: drawn when git asked for
/// progress (a terminal), not under `-q` or in JSON mode.
fn fetch_meter(
    options: &OptionState,
    packs: &[([u8; 32], Vec<&forge_core::repo::PackManifestInfo>)],
) -> progress::FetchMeter {
    let shown = Progress::new(options.verbosity);
    progress::FetchMeter::new(
        options.progress && shown.enabled && !shown.json,
        packs.len(),
        packs
            .iter()
            .map(|(_, c)| c.first().map_or(0, |m| m.size_bytes))
            .sum(),
    )
}

/// When some of `fetched` were unreadable, `repo` is a fork, and every unreadable pack is one of
/// its parent's too: the parent, as `owner/name` (its maintainers are the ones who can restore
/// them, QW4-062). `None` otherwise, or on any read failure: the plain E503 advice stands.
async fn parent_holding(
    client: &PlatformClient,
    svc: &RepoService<'_>,
    repo: &RepoRef,
    fetched: &[([u8; 32], Got)],
) -> Option<String> {
    let hashes: Vec<[u8; 32]> = fetched
        .iter()
        .filter(|(_, g)| matches!(g, Got::Unreadable(_)))
        .map(|(h, _)| *h)
        .collect();
    if hashes.is_empty() {
        return None;
    }
    let parent_id = forge_core::resolve::fork_parent(client, repo)
        .await
        .ok()??;
    let parent = forge_core::resolve::resolve_id(client, &parent_id)
        .await
        .ok()?;
    let theirs: std::collections::BTreeSet<[u8; 32]> = svc
        .read_pack_manifests(&parent)
        .await
        .ok()?
        .iter()
        .map(|m| m.pack_hash)
        .collect();
    hashes
        .iter()
        .all(|h| theirs.contains(h))
        .then(|| parent.display())
}

/// One pack's outcome in a fetch.
enum Got {
    /// Downloaded, verified and (for a private repo) opened.
    Bytes(Vec<u8>),
    /// No copy could be read.
    Unreadable(Unreadable),
    /// Hidden by the late-content rule (E510), with the reason. Normally no ref needs it; if
    /// one does, the fetch fails with [`hidden_packs_needed`].
    Hidden(UserError),
    /// Sealed under a key this reader does not hold, or in a format it does not open
    /// (`private-repos.md` §3.2, §18.2). Normally no ref needs it; if one does, the fetch fails
    /// with that pack's E307.
    Skipped(forge_core::repo::Skipped),
}

/// A pack none of whose external copies could be read.
struct Unreadable {
    hash: String,
    error: String,
}

/// Index a fetch's downloaded packs into the local odb (for a `--filter` partial clone:
/// through a scratch repo that applies the filter, then as a promisor pack). When packs were
/// set aside and the wanted history is incomplete without them, fail before git's own
/// connectivity check says only "did not send all necessary objects": E503
/// ([`packs_unreadable`]) when any was unreadable, else E510 ([`hidden_packs_needed`]) when
/// only packs the late-content rule hides are missing.
fn index_fetched(
    fetched: Vec<Got>,
    want_oids: &[String],
    options: &OptionState,
    repo_ref: &RepoRef,
    total: usize,
    parent: Option<&str>,
) -> Result<()> {
    let display = repo_ref.display();
    let repo = display.as_str();
    let mut downloaded = Vec::new();
    let mut unreadable = Vec::new();
    let mut hidden = Vec::new();
    let mut skipped = Vec::new();
    for got in fetched {
        match got {
            Got::Bytes(b) => downloaded.push(b),
            Got::Unreadable(u) => unreadable.push(u),
            Got::Hidden(u) => hidden.push(u),
            Got::Skipped(s) => skipped.push(s),
        }
    }
    let set_aside = !unreadable.is_empty() || !hidden.is_empty() || !skipped.is_empty();
    // A gap with unreadable packs is E503 (restoring a copy may fix it); with only hidden
    // ones it is E510: the history needs content the late-content rule withholds; with only
    // skipped ones, E307: it needs a key this reader does not hold.
    let incomplete = || -> anyhow::Error {
        if unreadable.is_empty() && hidden.is_empty() {
            return skipped_packs_needed(repo_ref, options.cloning, &skipped).into();
        }
        if unreadable.is_empty() {
            return hidden_packs_needed(repo, options.cloning, &hidden).into();
        }
        let e503 = packs_unreadable(repo, options.cloning, &unreadable, total, parent);
        match hidden.len() {
            0 => e503.into(),
            n => e503
                .note(format!(
                    "{n} more {} hidden by the late-content rule (E510); restoring copies will not bring those back",
                    if n == 1 { "pack is" } else { "packs are" }
                ))
                .into(),
        }
    };
    // `.gitmodules` blobs a pack's trees name but a later pack holds: checked once all are in.
    let mut unchecked = Vec::new();
    if let Some(filter) = options.filter.as_deref() {
        let scratch = ScratchRepo::init()?;
        for bytes in &downloaded {
            unchecked.extend(scratch.index_pack(bytes)?.unchecked);
        }
        scratch.check_blobs(&unchecked)?;
        if want_oids.is_empty() {
            return Ok(());
        }
        let filtered = match scratch.pack_filtered(want_oids, Some(filter)) {
            Ok(f) => f,
            Err(e) if blames_set_aside_packs(set_aside, &e) => {
                tracing::debug!(error = %e, "filtered repack failed");
                return Err(incomplete());
            }
            Err(e) => return Err(e),
        };
        let sha = LocalRepo::index_pack(&filtered)?.sha;
        LocalRepo::write_promisor_marker(&sha)?;
        tracing::info!(filter, pack = %sha, "indexed filtered promisor pack");
        return Ok(());
    }
    for bytes in &downloaded {
        let indexed = LocalRepo::index_pack(bytes)?;
        tracing::info!(pack = %indexed.sha, "indexed pack into local odb");
        unchecked.extend(indexed.unchecked);
    }
    LocalRepo::check_blobs(&unchecked)?;
    if set_aside && !want_oids.is_empty() && LocalRepo::history_has_gaps(want_oids) {
        return Err(incomplete());
    }
    Ok(())
}

/// Whether a failed filtered repack is explained by the packs this fetch set aside: only when
/// some were (`set_aside`) and git says the walk hit a missing object. Any other failure
/// keeps its own error rather than being reported as E503/E510.
fn blames_set_aside_packs(set_aside: bool, e: &anyhow::Error) -> bool {
    set_aside && names_missing_object(&format!("{e:#}"))
}

/// E510: the wanted history needs objects only packs hidden by the late-content rule hold
/// (a removed member's upload under an old key, or a pack sealed under an earlier use of an
/// epoch number). No copy would help: the rule withholds them from every reader.
fn hidden_packs_needed(repo: &str, cloning: bool, hidden: &[UserError]) -> UserError {
    let what = if cloning { "clone" } else { "fetch" };
    let n = hidden.len();
    // `message: cause`, as UserError displays itself.
    let first = hidden.first().map_or_else(String::new, ToString::to_string);
    let cause = match n {
        0 | 1 => first,
        2 => format!("{first}; and 1 more such pack"),
        n => format!("{first}; and {} more such packs", n - 1),
    };
    // Two kinds (private-repos.md §8.2, §8.1 step 7). A removed member's late upload opens
    // again as soon as its uploader is a current member (the member exception). A pack
    // sealed under an earlier use of an epoch number opens for nobody: its key is gone.
    let earlier_use = hidden
        .iter()
        .all(|u| u.message.contains("earlier use of key epoch"));
    let err = UserError::new(
        codes::LATE_CONTENT,
        format!(
            "{what} incomplete: {n} {} hidden by the late-content rule",
            if n == 1 { "pack" } else { "packs" }
        ),
    )
    .cause(cause);
    let err = if earlier_use {
        err.fix("a member whose clone has these commits can push the branch again: it is stored under the current key")
    } else {
        err.fix(format!(
            "a maintainer can re-add the uploader (`dg collab add {repo} <identity id> --role writer`): a current member's uploads are readable again"
        ))
        .fix("a member whose clone has these commits can push the branch again")
    };
    err.fix(format!(
        "a maintainer can move the ref back to history every member can read; `dg repo keys status {repo}` shows the epochs"
    ))
    .note("the content is hidden from every reader, not deleted; no other copy would open it")
}

/// E307: the wanted history needs objects only `skipped` packs hold, sealed under keys this
/// reader does not hold (a repository made public, `private-repos.md` §18.2) or in a format it
/// does not open.
fn skipped_packs_needed(
    repo: &RepoRef,
    cloning: bool,
    skipped: &[forge_core::repo::Skipped],
) -> UserError {
    let what = if cloning { "clone" } else { "fetch" };
    let Some(first) = skipped.first().map(|s| s.error(repo)) else {
        return UserError::new(codes::NOT_A_KEY_HOLDER, format!("{what} incomplete"));
    };
    let n = skipped.len();
    UserError::new(
        codes::NOT_A_KEY_HOLDER,
        format!("{what} incomplete: the history you asked for needs packs your keys don't open"),
    )
    .cause(first.to_string())
    .fix(first.fix.first().cloned().unwrap_or_default())
    .note(format!(
        "{n} {} left out; every other pack was read",
        if n == 1 { "pack was" } else { "packs were" }
    ))
}

/// E503: the wanted history needs objects from `unreadable` packs (of `total`), which a clone
/// or fetch could not read from any copy.
///
/// `parent`: the repository is a fork and these are its parent's packs (`owner/name`): its
/// maintainers restore them, from a clone of the parent, rather than "the pusher" of the fork
/// (QW4-062).
fn packs_unreadable(
    repo: &str,
    cloning: bool,
    unreadable: &[Unreadable],
    total: usize,
    parent: Option<&str>,
) -> UserError {
    const SHOWN: usize = 3;
    let what = if cloning { "clone" } else { "fetch" };
    let mut cause: Vec<String> = unreadable
        .iter()
        .take(SHOWN)
        .map(|u| {
            format!(
                "pack {}…: {}",
                progress::abbrev(&u.hash, 12),
                brief(&u.error)
            )
        })
        .collect();
    if unreadable.len() > SHOWN {
        cause.push(format!("and {} more", unreadable.len() - SHOWN));
    }
    // The catalogue's wording (docs/design/ux-dx-spec.md §7.3 example 6): "clone
    // incomplete: 2 packs unreadable". The pack total goes in the cause.
    let n = unreadable.len();
    let err = UserError::new(
        codes::PACKS_UNREADABLE,
        format!(
            "{what} incomplete: {n} {} unreadable",
            if n == 1 { "pack" } else { "packs" }
        ),
    );
    // Every copy the pusher recorded is one no reader follows (plain http, this machine, a
    // private network, a bucket without a profile here): no gateway or retry helps, the copy
    // has to be put somewhere readable (QW2-078). The places are said once for all the packs.
    if let Some(places) = unfollowed_places(unreadable) {
        let recorded = if places.is_empty() {
            "their manifests record no address".to_string()
        } else {
            format!("they are recorded only at {}", places.join("; "))
        };
        // `dg reseed --from-local` re-uploads only to addresses already recorded, so it cannot
        // help here: a repack records a new copy (docs/errors.md#e503).
        let fix = match parent {
            Some(p) => {
                let fork_name = repo.rsplit('/').next().unwrap_or(repo);
                format!(
                    "{repo} is a fork, and these packs came from its parent {p}, whose pusher recorded them only at an address other computers do not read from. A fork keeps the copies its parent had when it was made: ask {p}'s maintainers to record them at a public https address (`dg repack {p} --profile <profile>`), then clone {p}, or fork it again (`dg repo fork {p} --name <new name>`; `--name {fork_name}` again records a repack's new pack in this fork)"
                )
            }
            None => format!(
                "the pusher recorded their packs only at an address other computers do not read from: a member whose computer reads them can record them again at a public https address, `dg repack {repo} --profile <profile>` (`dg storage add <name> … --public-url https://…` adds one)"
            ),
        };
        return err
            .cause(format!(
                "{n} of the repository's {total} packs: {}: {recorded}",
                forge_core::storage::read::NO_FOLLOWED_COPY
            ))
            .fix(fix)
            .fix("if that host or bucket is your own storage, add a storage profile for it (`dg storage add`, with its public_url) and run it again");
    }
    err.cause(format!(
        "{n} of the repository's {total} packs: {}",
        cause.join("; ")
    ))
    .fix(format!(
        "ask a member who has the objects to run `dg reseed {repo} --from-local` inside their clone"
    ))
    .fix("if you know another IPFS gateway with the pack, add it to `[read] ipfs_gateways` in storage.toml and retry")
    .fix(format!("`dg storage status {repo}` shows which recorded copies answer"))
}

/// When no pack had a copy this computer follows, the places their manifests record (each
/// once, in order); `None` when any pack failed some other way.
fn unfollowed_places(unreadable: &[Unreadable]) -> Option<Vec<String>> {
    const ONLY: &str = "its manifest records only ";
    let mut places: Vec<String> = Vec::new();
    for u in unreadable {
        if !u
            .error
            .contains(forge_core::storage::read::NO_FOLLOWED_COPY)
        {
            return None;
        }
        let listed = u.error.split_once(ONLY).map_or("", |(_, rest)| rest);
        for place in listed.split("; ").filter(|p| !p.is_empty()) {
            if !places.iter().any(|p| p == place) {
                places.push(place.to_string());
            }
        }
    }
    (!unreadable.is_empty()).then_some(places)
}

/// The reader's "no external copy verified" text, short enough for one cause line: each
/// copy's URL cut to its host (the full URLs are in `dg storage status`), without the
/// generic `io error:` / `GET request failed:` layers or the gateway hint (a fix line says
/// it).
fn brief(error: &str) -> String {
    let text = error.split(" — ").next().unwrap_or(error);
    let text = text
        .replace("io error: ", "")
        .replace("GET request failed: ", "");
    text.split(' ')
        .map(|word| match word.split_once("://") {
            // `https://host/path…:` → `host:`
            Some((_, rest)) => {
                let colon = if word.ends_with(':') { ":" } else { "" };
                let host = rest.split(['/', '?', '#']).next().unwrap_or(rest);
                format!("{}{colon}", host.trim_end_matches(':'))
            }
            None => word.to_string(),
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Whether an incremental fetch left the local odb holding the whole wanted history. Checking
/// only that the wanted TIPS exist is not enough: a gc may have pruned objects of a pack the
/// record says is held, and a newer pack deltas against them (review M-4). So a plain fetch
/// with wants runs git's connectivity walk (`has_gaps`); a failed pass is never complete.
fn incremental_fetch_complete(
    ok: bool,
    options: &OptionState,
    want_oids: &[String],
    has_gaps: impl FnOnce() -> bool,
) -> bool {
    ok && (options.filter.is_some() || want_oids.is_empty() || !has_gaps())
}

/// Whether a plain (unfiltered) fetch has nothing to do: every wanted object is already in
/// the local odb. A promisor fetch always runs (a present commit may need its filtered blobs).
fn wants_already_local(wants: &[Want], options: &OptionState) -> bool {
    options.filter.is_none()
        && !wants.is_empty()
        && wants.iter().all(|w| LocalRepo::object_exists(&w.oid))
}

/// The git packs a fetch downloads: every stored kind-0 pack, less those `held` records.
///
/// Incremental fetch: a pack this clone already indexed whole (an earlier full fetch) or
/// pushed itself is not downloaded again; its objects are in the local odb. Every push stores
/// a new pack, so this turns "download every pack" into "download the new ones". A partial
/// clone (`--filter`) indexes a filtered subset, never a whole pack, so it passes no `held`.
fn packs_to_fetch(
    manifests: Vec<forge_core::repo::PackManifestInfo>,
    held: Option<&crate::fetched::FetchedPacks>,
) -> Vec<forge_core::repo::PackManifestInfo> {
    let git_packs: Vec<_> = manifests
        .into_iter()
        .filter(|m| m.kind == u64::from(KIND_GIT_PACK))
        .collect();
    if git_packs.is_empty() {
        // Nothing stored: an empty repo. git tolerates a fetch that delivers no objects as
        // long as the wants were not real (they cannot be, with no packs).
        tracing::warn!("no git packs stored for repo; delivering nothing");
        return git_packs;
    }
    let total = group_by_hash(&git_packs).len();
    let wanted: Vec<_> = git_packs
        .into_iter()
        .filter(|m| held.is_none_or(|h| !h.contains(&m.pack_hash)))
        .collect();
    tracing::info!(
        new = group_by_hash(&wanted).len(),
        total,
        "downloading the packs not already local"
    );
    wanted
}

/// Write the `refUpdate` of every accepted spec. Each one is reported (`dash: updated …` / a
/// `refUpdate` event) the moment it lands, even when another fails: a failure (a ref's
/// write, the read-back) must not hide what is already on chain (D-601). When some refs
/// landed and others did not, the ones that did not are rejected in `planned`, so the push
/// goes on to its read-back, reports each ref to git and syncs the PRs of the refs that
/// moved; when none landed, the first failure is the push's error.
///
/// A new ref that only fits because this push deletes a ref it collides with (`feature`
/// deleted, `feature/x` created) is written after that deletion landed, and refused when it
/// did not: written together, a failed deletion would leave both refs live. So when a push
/// has such a ref, its deletions are written first, on their own.
async fn write_ref_updates(
    svc: &RepoService<'_>,
    repo: &RepoRef,
    planned: &mut [Planned],
    progress: Progress,
) -> Result<()> {
    let accepted: Vec<usize> = (0..planned.len())
        .filter(|&i| planned[i].reject.is_none())
        .collect();
    let gated = gated_creations(planned, &accepted);
    if gated.is_empty() {
        return write_batch(svc, repo, planned, &accepted, progress, false).await;
    }
    let (deletions, rest): (Vec<usize>, Vec<usize>) = accepted
        .iter()
        .partition(|&&i| planned[i].new_oid.is_none());
    // Deletions that all failed reject the new refs that waited on them; the push's other
    // refs are still written, and it fails as a whole only when none of them lands either.
    let mut failed = None;
    if let Err(e) = write_batch(svc, repo, planned, &deletions, progress, false).await {
        for &d in &deletions {
            planned[d].reject = Some(format!("ref update failed: {e:#}"));
        }
        failed = Some(e);
    }
    for (i, needs) in gated {
        if let Some(&d) = needs.iter().find(|&&d| planned[d].reject.is_some()) {
            planned[i].reject = Some(format!(
                "not written: deleting {} failed, and git cannot hold both names",
                planned[d].spec.dst
            ));
        }
    }
    let rest: Vec<usize> = rest
        .into_iter()
        .filter(|&i| planned[i].reject.is_none())
        .collect();
    match (rest.is_empty(), failed) {
        (true, None) => Ok(()),
        (true, Some(e)) => Err(e),
        (false, failed) => write_batch(svc, repo, planned, &rest, progress, failed.is_none()).await,
    }
}

/// Each accepted new ref (`planned[i]`) that collides with refs this push deletes, with those
/// deletions: it may be written only once they all landed.
fn gated_creations(planned: &[Planned], accepted: &[usize]) -> Vec<(usize, Vec<usize>)> {
    use forge_core::rules::ref_collision::ref_collision;
    let deletions: Vec<usize> = accepted
        .iter()
        .copied()
        .filter(|&d| planned[d].new_oid.is_none())
        .collect();
    accepted
        .iter()
        .copied()
        .filter(|&i| planned[i].new_oid.is_some() && planned[i].prev_oid.is_none())
        .filter_map(|i| {
            let dst = planned[i].spec.dst.as_str();
            let needs: Vec<usize> = deletions
                .iter()
                .copied()
                .filter(|&d| ref_collision([planned[d].spec.dst.as_str()], dst).is_some())
                .collect();
            (!needs.is_empty()).then_some((i, needs))
        })
        .collect()
}

/// Write `planned[accepted[..]]` in one batch and settle it ([`settle_ref_writes`]).
async fn write_batch(
    svc: &RepoService<'_>,
    repo: &RepoRef,
    planned: &mut [Planned],
    accepted: &[usize],
    progress: Progress,
    landed_before: bool,
) -> Result<()> {
    let writes = accepted
        .iter()
        .map(|&i| {
            let p = &planned[i];
            Ok(forge_core::repo::RefWrite {
                ref_name: p.spec.dst.clone(),
                new_oid: match &p.new_oid {
                    Some(oid) => oid_to_bytes(oid)?,
                    None => vec![0u8; 20], // delete = zero oid
                },
                prev_oid: p.prev_oid.as_deref().map(oid_to_bytes).transpose()?,
                force: p.spec.force,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    // Test affordance, compiled only with `--features test-hooks`: fail after `n` ref updates of
    // a batch landed, the state a push that dies part-way leaves behind (e2e scenario 32).
    #[cfg(feature = "test-hooks")]
    let fail_after = std::env::var("DASH_FORGE_FAIL_AFTER_REFS")
        .ok()
        .and_then(|n| n.parse::<usize>().ok())
        .filter(|n| *n < writes.len());
    #[cfg(feature = "test-hooks")]
    let batch = &writes[..fail_after.unwrap_or(writes.len())];
    #[cfg(not(feature = "test-hooks"))]
    let batch = &writes[..];
    // One config read for the whole push; a public repository's updates go in parallel
    // (P-6). Each is reported as it lands.
    let results = {
        let planned = &*planned;
        svc.write_ref_updates(repo, batch, |i| {
            let p = &planned[accepted[i]];
            let (text, event) = progress::ref_update_line(&p.spec.dst, p.new_oid.as_deref());
            progress.emit(&text, &event);
        })
        .await
    };
    // After an earlier batch landed, a batch that fails before writing (a config read) must not
    // hide what is on chain: its refs are rejected and the push goes on to its read-back.
    let results = match results {
        Ok(results) => results,
        Err(e) if landed_before => {
            for &i in accepted {
                planned[i].reject = Some(format!("ref update failed: {e}"));
            }
            return Ok(());
        }
        Err(e) => return Err(e.into()),
    };
    #[cfg(feature = "test-hooks")]
    if let Some(written) = fail_after {
        bail!("simulated failure after {written} ref update(s) (DASH_FORGE_FAIL_AFTER_REFS)");
    }
    settle_ref_writes(planned, accepted, results, landed_before)
}

/// Fold a batch's per-ref `results` (for `planned[accepted[i]]`, in order; shorter when a
/// sequential write stopped at its failure) into the plan. Nothing landed, in this batch or an
/// earlier one of the push (`landed_before`): the first failure is the error (a whole-push
/// failure, classified for the user as before). Some landed: each ref that failed, or was not
/// attempted after a failure, is rejected with its reason, and the push goes on for the rest.
fn settle_ref_writes(
    planned: &mut [Planned],
    accepted: &[usize],
    results: Vec<forge_core::Result<String>>,
    landed_before: bool,
) -> Result<()> {
    if !landed_before && !results.iter().any(Result::is_ok) {
        let failed = accepted
            .iter()
            .zip(results)
            .find_map(|(&i, r)| r.err().map(|e| (i, e)));
        return match failed {
            Some((i, e)) => Err(anyhow::Error::new(e)
                .context(format!("writing ref update for {}", planned[i].spec.dst))),
            None => Ok(()),
        };
    }
    let mut results = results.into_iter();
    for &i in accepted {
        match results.next() {
            Some(Ok(_)) => {}
            Some(Err(e)) => planned[i].reject = Some(format!("ref update failed: {e}")),
            None => {
                planned[i].reject =
                    Some("not written: an earlier ref update of this push failed".into());
            }
        }
    }
    Ok(())
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

/// The `list` answer for `refs`: `<oid> <refname>` per resolved ref, then (for a fetch
/// only) the `HEAD` symref at the default branch.
///
/// `HEAD` is not a ref of the repository: the helper derives it from the default branch
/// on every read, and no `refUpdate` can move it. So a `list for-push` does not advertise
/// it. Otherwise `git push --mirror`, finding a remote `HEAD` with no local ref of that
/// name, asks to delete it on every run, and each of those deletes was a paid write that
/// changed nothing.
fn list_lines(refs: &[(String, RefState)], default_branch: &str, for_push: bool) -> Vec<String> {
    let mut lines = Vec::new();
    let mut names: Vec<&str> = Vec::new();
    for (name, state) in refs {
        // Emission guard (defense-in-depth with rules::is_update_valid): never advertise
        // a ref name carrying control chars/whitespace — it could inject a spoofed
        // advertisement line into git's parse of this output (S0.9 wire protocol). The git
        // grammar is used, not just the contract's: a name git cannot hold (a `.lock`
        // component the contract lets through) would otherwise be pruned by every
        // `--prune` / `--mirror` push.
        if !forge_core::rules::is_git_ref_name(name) {
            tracing::warn!(ref_name = %name.escape_debug(), "skipping illegal ref name in list");
            continue;
        }
        if let Some(oid) = tip_oid(state) {
            lines.push(format!("{oid} {name}"));
            names.push(name);
        }
    }
    if for_push {
        return lines;
    }
    // Emit the HEAD symref when the default branch exists (a fresh/empty repo has no head
    // yet — git handles the absence).
    let default_ref = format!("refs/heads/{default_branch}");
    if names.contains(&default_ref.as_str()) {
        lines.push(format!("@{default_ref} HEAD"));
    } else if let Some(first_head) = names.iter().find(|n| n.starts_with("refs/heads/")) {
        // No default branch present but some head is — point HEAD at it so clone can
        // check something out rather than warning about a dangling HEAD.
        lines.push(format!("@{first_head} HEAD"));
    }
    lines
}

/// Whether `dst` is the symbolic `HEAD`, which a push never writes (see [`list_lines`]).
fn is_head(dst: &str) -> bool {
    dst == "HEAD"
}

/// The answer to a push to `HEAD`, which writes nothing: a delete (what `git push --mirror`
/// would send, were `HEAD` advertised to it; [`list_lines`] no longer does) is `ok`, since
/// `HEAD` is not a stored ref; any update is refused, since only the repository's default
/// branch moves it.
fn head_outcome(spec: PushSpec) -> PushOutcome {
    if spec.src.is_empty() {
        PushOutcome::Ok(spec.dst)
    } else {
        PushOutcome::Error(
            spec.dst,
            "HEAD follows the default branch and is not pushed".to_string(),
        )
    }
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
/// rejected as `non-fast-forward` (§2.3 / PRD 02). A `--force-with-lease` expectation
/// ([`OptionState::lease`]) accepts any update while the ref still points where the lease
/// says, and rejects it as `stale info` (git's words) otherwise. A new ref that git clients could
/// not hold next to an existing one (`feature` and `feature/x`, or `Foo` and `foo`) is refused
/// (`forge_core::rules::ref_collision`).
fn plan_pushes(
    specs: &[PushSpec],
    remote_refs: &[(String, RefState)],
    options: &OptionState,
) -> Vec<Planned> {
    let mut planned = Vec::with_capacity(specs.len());
    for spec in specs {
        let prev = remote_tip(remote_refs, &spec.dst);
        let lease = options.lease(&spec.dst);
        // A lease that holds is written as a plain update naming the leased tip as its
        // `prevOid`, which supersedes that tip without `force` (`resolve_ref`). Platform has no
        // compare-and-swap, so an update that lands from elsewhere before this one is not
        // overwritten: the ref reads as diverged and the read-back reports the push as lost. A
        // ref that is already diverged takes a forced write, the only one that settles it.
        let diverged = remote_refs
            .iter()
            .any(|(n, s)| n == &spec.dst && matches!(s, RefState::Diverged { .. }));
        let spec = PushSpec {
            force: if lease.is_some() {
                diverged
            } else {
                spec.force
            },
            ..spec.clone()
        };
        if let Some(reject) = lease.and_then(|want| lease_reject(want, prev.as_deref())) {
            planned.push(Planned {
                spec,
                new_oid: None,
                prev_oid: prev,
                reject: Some(reject),
            });
            continue;
        }
        if spec.src.is_empty() {
            // Deletion.
            planned.push(Planned {
                spec,
                new_oid: None,
                prev_oid: prev,
                reject: None,
            });
            continue;
        }
        let Some(new_oid) = LocalRepo::rev_parse(&spec.src) else {
            let reject = Some(format!("cannot resolve local source {:?}", spec.src));
            planned.push(Planned {
                spec,
                new_oid: None,
                prev_oid: prev,
                reject,
            });
            continue;
        };
        let reject = prev.as_ref().and_then(|tip| {
            let fast_forward = spec.force
                || lease.is_some()
                || tip == &new_oid
                || LocalRepo::is_ancestor(tip, &new_oid);
            (!fast_forward).then(|| "non-fast-forward".to_string())
        });
        planned.push(Planned {
            spec,
            new_oid: Some(new_oid),
            prev_oid: prev,
            reject,
        });
    }
    reject_collisions(&mut planned, remote_refs);
    planned
}

/// The secret scan of a public push ([`secret_scan`]): prints its warnings, and refuses (E807)
/// each ref whose new commits add a likely secret nothing allows. When the full scan cannot run
/// (git failed), the name-only check still refuses a new `.env`; when that fails too, the push
/// goes ahead with a warning: the scan is a safety net, and a broken one must not block every
/// push.
async fn check_secrets(
    conn: &Conn,
    planned: &mut [Planned],
    remote_refs: &[(String, RefState)],
    options: &OptionState,
) {
    let tips: Vec<secret_scan::Tip> = planned
        .iter()
        .enumerate()
        .filter(|(_, p)| p.reject.is_none())
        .filter_map(|(index, p)| {
            p.new_oid.clone().map(|oid| secret_scan::Tip {
                index,
                oid,
                name: p.spec.dst.clone(),
            })
        })
        .collect();
    if tips.is_empty() {
        return;
    }
    // Already public: only the remote's tips as Forge lists them. A remote-tracking ref is
    // what this clone once fetched, not proof that it is still public.
    let known: Vec<String> = remote_refs.iter().filter_map(|(_, s)| tip_oid(s)).collect();
    let created_at_ms = forge_core::resolve::repo_created_at(&conn.client, &conn.repo)
        .await
        .unwrap_or_else(|e| {
            tracing::warn!(error = %e, "could not read when the repo was created; every new commit counts as new");
            None
        });
    let request = secret_scan::Request {
        repo: None,
        tips,
        known,
        created_at_ms,
        mirror: secret_scan::spawned_by_import(),
        allow: secret_scan::allow_from_options(options),
    };
    let progress = Progress {
        enabled: true,
        ..Progress::new(options.verbosity)
    };
    let scan = match secret_scan::scan(&request) {
        Ok(scan) => scan,
        Err(e) => {
            let names_only = secret_scan::scan_names_only(&request);
            let (text, outcome) = match &names_only {
                Ok(_) => (
                    "couldn't check this push's file contents for secrets; checked its .env files by name only",
                    "names-only",
                ),
                Err(_) => (
                    "couldn't check this push for secrets, pushing anyway",
                    "skipped",
                ),
            };
            progress.emit(
                &format!("dash: warning: {text}: {e:#}"),
                &serde_json::json!({
                    "event": "secretScanFailed",
                    "outcome": outcome,
                    "message": forge_core::user_error::redact(&format!("{e:#}")),
                }),
            );
            match names_only {
                Ok(scan) => scan,
                Err(_) => return,
            }
        }
    };
    scan.print_warnings(progress.json);
    let refs: Vec<String> = scan
        .refused
        .iter()
        .map(|&i| planned[i].spec.dst.clone())
        .collect();
    let Some(error) = scan.refusal(&refs) else {
        return;
    };
    if !progress.json {
        scan.print_refusals();
    }
    error.eprint("dash: ");
    let mut event = error.to_json();
    event["event"] = serde_json::json!("error");
    progress::report(&event);
    for &i in &scan.refused {
        planned[i].reject = Some(secret_scan::WIRE.to_string());
    }
}

/// A `--force-with-lease` that no longer holds: the ref is not where the lease expects (`want`,
/// `""` for "must not exist"). git reports it as `stale info`.
fn lease_reject(want: &str, prev: Option<&str>) -> Option<String> {
    let holds = match prev {
        None => want.is_empty(),
        Some(p) => want.eq_ignore_ascii_case(p),
    };
    (!holds).then(|| "stale info".to_string())
}

/// Refuse each accepted new ref that git clients could not hold next to the refs there will be
/// (`forge_core::rules::ref_collision`): the remote's live refs, less the ones this push deletes
/// (an accepted deletion), plus the new refs accepted before it in this push.
fn reject_collisions(planned: &mut [Planned], remote_refs: &[(String, RefState)]) {
    use forge_core::rules::ref_collision::{collision_reason, ref_collision};
    let deleted: std::collections::HashSet<&str> = planned
        .iter()
        .filter(|p| p.reject.is_none() && p.new_oid.is_none() && p.spec.src.is_empty())
        .map(|p| p.spec.dst.as_str())
        .collect();
    let mut live: Vec<String> = remote_refs
        .iter()
        .filter(|(name, state)| tip_oid(state).is_some() && !deleted.contains(name.as_str()))
        .map(|(name, _)| name.clone())
        .collect();
    for p in planned.iter_mut() {
        let creates = p.reject.is_none() && p.new_oid.is_some() && p.prev_oid.is_none();
        if !creates {
            continue;
        }
        let dst = p.spec.dst.clone();
        match ref_collision(live.iter().map(String::as_str), &dst) {
            Some(existing) => p.reject = Some(collision_reason(&dst, &existing)),
            None => live.push(dst),
        }
    }
}

/// What [`upload_push_pack`] needs from the push.
struct PushContext<'a> {
    svc: &'a RepoService<'a>,
    repo: &'a RepoRef,
    /// The repo as the user addressed it (`owner/name`), for the plan line.
    repo_label: String,
    /// Short names of the refs this push updates.
    refs: Vec<String>,
    git_dir: &'a std::path::Path,
    policy: &'a PushPolicy,
    progress: Progress,
    /// `--dry-run`: build the pack and print the plan, store nothing.
    dry_run: bool,
    /// The pushing identity (base58).
    identity: String,
    /// The sealed-pack cache path this push used ([`sealed_cache_path`]); dropped once the
    /// push's refs land ([`forget_sealed`]).
    sealed: std::cell::RefCell<Option<std::path::PathBuf>>,
    /// What the history index this push publishes costs, if any (both of its artifacts, each
    /// priced as its own manifest): priced with the push. Becomes the fallback delta's when the
    /// cost guard declines a due full index.
    history_cost: std::cell::Cell<Option<HistoryCost>>,
    /// The cost of the delta a due full index carries as its fallback
    /// ([`PreparedHistory::fallback`]), if any.
    history_fallback: Option<HistoryCost>,
    /// The cost guard declined the full index and the fallback delta is priced instead: the
    /// push publishes the delta.
    history_on_fallback: std::cell::Cell<bool>,
}

/// After the cost guard declined a push priced with a due full history index: price the
/// cheaper delta it carries instead (still readable, at most half the full index), so the
/// web does not fall behind until someone pays for the full one. False when there is none.
fn take_history_fallback(ctx: &PushContext<'_>) -> bool {
    let Some(delta) = ctx.history_fallback else {
        return false;
    };
    if ctx.history_on_fallback.replace(true) {
        return false;
    }
    ctx.history_cost.set(Some(delta));
    ctx.progress.note(&format!(
        "a full history index is due (its deltas have cost as much as one); publishing the \
         {}-byte delta instead. `dg repo reindex {}` publishes the full one",
        delta.plain_len(),
        ctx.repo_label
    ));
    true
}

/// The on-chain price of the history index a push publishes (`ctx.history_cost`: each of its
/// artifacts), stored where its pack goes: 0 when it publishes none.
fn history_credits(ctx: &PushContext<'_>, platform_bytes: bool) -> u64 {
    history_price(
        ctx,
        ctx.policy.resolved.external.len() as u64,
        platform_bytes,
    )
}

/// [`HistoryCost::credits`] of the history this push publishes, 0 when none.
fn history_price(ctx: &PushContext<'_>, external: u64, platform: bool) -> u64 {
    let sealed = ctx.repo.visibility == forge_core::rules::v2::Visibility::Private;
    ctx.history_cost
        .get()
        .map_or(0, |c| c.credits(sealed, external, platform))
}

impl PushContext<'_> {
    /// A status line for the user (git shows the helper's stderr, `dash: `-prefixed).
    fn say(&self, line: &str) {
        self.progress.note(line);
    }
}

/// Build one self-contained pack for `want_tips` (excluding remote tips already local as
/// thin-pack bases), store it according to the repo's storage policy, and record the
/// `packManifest`. Returns only once the policy's N copies are confirmed and the manifest
/// has landed; every failure before that is an error, and the caller writes no refs.
/// `Some(credits)`: the on-chain estimate for what this push stored (the summary line's
/// fallback when the balance has not moved yet).
// Build, price, guard, store and record, in that order; the steps are their own functions.
#[allow(clippy::too_many_lines)]
async fn upload_push_pack(
    ctx: &PushContext<'_>,
    want_tips: &[String],
    remote_refs: &[(String, RefState)],
) -> Result<Option<Uploaded>> {
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
        // A fast-forward to a commit already stored still moves the default branch: its history
        // index goes where the policy stores (priced on top of the refs).
        if ctx.dry_run || ctx.history_cost.get().is_none() {
            return Ok(None);
        }
        let refs_only = push_fees::estimate_ref_updates(ctx.refs.len() as u64);
        let (est_credits, history) = history_alone(ctx, refs_only, policy_replication(ctx))?;
        return Ok(Some(Uploaded {
            est_credits,
            index: None,
            history,
        }));
    }

    // A private repository stores the pack sealed under the current write epoch, resolved
    // now (§5.3: anchors re-read before every write). Every artifact is sealed (§3); the
    // browse index still indexes the plaintext pack (its offsets are plaintext offsets).
    let stored = seal_for_push(ctx, &pack.bytes).await?;
    let job = PackJob::for_push(ctx, &stored, &pack).await?;
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
    let platform_writes = |est: &push_fees::PushEstimate, stores_pack: bool| {
        progress::platform_line(&PlatformWrites {
            chunks: if stores_pack { job.chunk_count } else { 0 },
            manifests: 2 + ctx.history_cost.get().map_or(0, |c| c.manifests()),
            ref_updates: ctx.refs.len(),
            est_credits: est.total(),
            history_bytes: ctx.history_cost.get().map_or(0, |c| c.plain_len()),
        })
    };
    if ctx.dry_run {
        let full = platform_writes(&estimate, resolved.platform);
        let (text, event) = dry_run_writes(ctx, &job, &pack.bytes, progress, full).await;
        progress.emit(&format!("{text} (dry run: nothing stored)"), &event);
        return Ok(None);
    }
    // Resolve every secret BEFORE asking the user to pay: a missing env var must fail
    // here, not after a "y" at the cost prompt.
    let externals = external_targets(ctx)?;
    if let Some(refs_only) = reuse_recorded(ctx, &job).await? {
        let replication = recorded_replication(ctx, &job).await;
        let (est_credits, history) = history_alone(ctx, refs_only, replication)?;
        return Ok(Some(Uploaded {
            est_credits,
            index: missing_index(ctx, &job, pack.parsed, externals).await,
            history,
        }));
    }
    // A declined due full history index: ask again with its cheaper delta (review L8).
    let note = policy::NOTE_NOTHING_STORED;
    if let Err(e) = policy::enforce(estimate.total(), ctx.policy, resolved.platform, note) {
        if !take_history_fallback(ctx) {
            return Err(e.into());
        }
        let delta = job.estimate(ctx, resolved.platform);
        policy::enforce(delta.total(), ctx.policy, resolved.platform, note)?;
    }

    let jpath = crate::journal::journal_path(
        ctx.git_dir,
        ctx.repo.id(),
        &ctx.identity,
        &job.meta.pack_hash,
    );
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
    // This clone holds the pack's objects: a later fetch need not download it.
    crate::fetched::FetchedPacks::record(ctx.git_dir, ctx.repo.id(), job.pack_hash);

    retire_journal(ctx, &jpath, &replication);
    Ok(Some(Uploaded {
        est_credits: actual_estimate.total(),
        index: Some(PendingIndex {
            pack_hash: job.pack_hash,
            parsed: pack.parsed,
            replication,
            externals,
        }),
        history: HistoryTarget::WithPack,
    }))
}

/// Push fully landed (copies + manifest). The chunk journal is the only record of chunks an
/// interrupted Platform upload wrote; retire it only when this manifest references those
/// chunks. Otherwise keep it and say so — those chunks are paid for, referenced by nothing,
/// and reclaimable only while the journal names them. The kept sealed bytes stay until the
/// refs land ([`forget_sealed`]): a push that fails at its refs is retried with the same
/// sealed pack, found recorded, and not paid twice.
fn retire_journal(ctx: &PushContext<'_>, jpath: &std::path::Path, replication: &Replication) {
    if replication.has_platform() {
        let _ = std::fs::remove_file(jpath);
    } else if jpath.exists() {
        ctx.say(&format!(
            "note: an earlier interrupted push left Platform chunks for this pack that \
             this push did not use (journal kept at {}); Platform chunks are permanent, so \
             re-push with dash.storage including platform to put them to use",
            jpath.display()
        ));
    }
}

/// The browse index still owed for a pack an earlier push recorded: that push may have died
/// between its manifest and its index (D-920). This clone holds the same pack, so it is
/// published now if no fragment covers it, to where the recorded copies are.
async fn missing_index(
    ctx: &PushContext<'_>,
    job: &PackJob<'_>,
    parsed: forge_core::pack::ParsedPack,
    externals: Vec<ExternalTarget>,
) -> Option<PendingIndex> {
    match ctx.svc.is_pack_indexed(ctx.repo, job.pack_hash).await {
        Ok(true) => None,
        Ok(false) => {
            let replication = recorded_replication(ctx, job).await;
            if replication.replicas.is_empty() {
                // The pack's copy is on storage this clone's policy does not name: nowhere to
                // put its index that readers would find with it.
                index_skipped(
                    ctx,
                    &reindex_skip(
                        "the recorded pack is stored where this clone's storage policy does \
                         not point",
                    ),
                );
                return None;
            }
            // The index is a write this push adds: the cost guard weighs it before any ref is
            // written, as it weighs a new pack's index.
            let index_cost = push_fees::estimate_push(&push_fees::PushShape {
                index_objects: job.object_count,
                external_targets: ctx.policy.resolved.external.len() as u64,
                platform_bytes: replication.has_platform(),
                sealed: ctx.repo.visibility == forge_core::rules::v2::Visibility::Private,
                ..push_fees::PushShape::default()
            });
            // One manifest (the index's), not the push's two; no pack bytes.
            let credits = index_cost.chunk_credits + index_cost.metadata_credits / 2;
            if let Err(e) = policy::enforce(
                credits + push_fees::estimate_ref_updates(ctx.refs.len() as u64),
                ctx.policy,
                replication.has_platform(),
                policy::NOTE_NOTHING_STORED,
            ) {
                index_skipped(
                    ctx,
                    &reindex_skip(format!("the cost guard declined it: {e}")),
                );
                return None;
            }
            Some(PendingIndex {
                pack_hash: job.pack_hash,
                parsed,
                replication,
                externals,
            })
        }
        // Unknown whether it is indexed: say so with the fix (`dg repo reindex` checks again and
        // publishes only what is missing) rather than let the retry pass in silence.
        Err(e) => {
            index_skipped(
                ctx,
                &reindex_skip(format!("could not check the recorded pack's index: {e:#}")),
            );
            None
        }
    }
}

/// Where this identity's recorded copy of the pack lives, as a [`Replication`]: Platform when
/// its manifest is chunk-stored, else the external targets it names (the index goes to the same
/// places as the pack). Empty on a read failure: the index then goes to Platform only if the
/// policy includes it.
async fn recorded_replication(ctx: &PushContext<'_>, job: &PackJob<'_>) -> Replication {
    let mine = ctx
        .svc
        .read_pack_copies(ctx.repo, job.pack_hash)
        .await
        .unwrap_or_default()
        .into_iter()
        .find(|m| m.owner_id == ctx.identity);
    let on_platform = mine
        .as_ref()
        .map_or(ctx.policy.resolved.platform, |m| m.storage == 0);
    let mut replicas: Vec<forge_core::storage::Replica> = ctx
        .policy
        .resolved
        .external
        .iter()
        .map(|(name, _)| forge_core::storage::Replica {
            target: name.clone(),
            uris: Vec::new(),
            platform: false,
        })
        .collect();
    if on_platform {
        replicas.push(forge_core::storage::Replica {
            target: forge_core::storage::PLATFORM_PROFILE.into(),
            uris: Vec::new(),
            platform: true,
        });
    }
    Replication {
        replicas,
        failures: Vec::new(),
    }
}

/// What [`upload_push_pack`] stored.
struct Uploaded {
    /// The on-chain estimate for it (the summary line's fallback).
    est_credits: u64,
    /// The browse index to publish once the refs have landed (none when the pack was already
    /// recorded by an earlier push).
    index: Option<PendingIndex>,
    /// The push paid (its estimate and guard included) for the history index.
    history: HistoryTarget,
}

/// Where a push's history index goes, when the push priced it in.
enum HistoryTarget {
    /// Not published (none computed, or the cost guard declined it).
    None,
    /// With the pack this push stored.
    WithPack,
    /// The push stored no pack (a recorded one reused, or no new objects): to these copies'
    /// places, as priced.
    Alone(Replication),
}

/// A stored pack whose browse index is still to be published ([`publish_browse_index`]).
struct PendingIndex {
    parsed: forge_core::pack::ParsedPack,
    pack_hash: [u8; 32],
    replication: Replication,
    externals: Vec<ExternalTarget>,
}

/// The bytes a push stores for `plain`: itself in a public repository; in a private one the
/// pack sealed under the write epoch resolved now.
///
/// Sealing draws a fresh file id, so the same pack sealed twice has two hashes, and an
/// interrupted push could never resume its journaled chunks or find its recorded manifest.
/// So the sealed bytes (ciphertext only) are kept at `.git/dash/sealed/<repo>-<sha256 of the
/// plaintext>.pack` and reused only while they open under the current write key and hash back
/// to the plaintext.
async fn seal_for_push(ctx: &PushContext<'_>, plain: &[u8]) -> Result<Vec<u8>> {
    // A dry run stores nothing, so it seals nothing (and needs no write epoch): it prices the
    // plaintext pack, which differs from the sealed one by 36 + 16 bytes per 16 KiB.
    if ctx.dry_run {
        return Ok(plain.to_vec());
    }
    let codec = ctx
        .svc
        .pack_codec(ctx.repo)
        .await
        .context("resolving the repository's key")?;
    let forge_core::repo::PackCodec::Private(private) = &codec else {
        return Ok(plain.to_vec());
    };
    let path = sealed_cache_path(ctx, plain);
    *ctx.sealed.borrow_mut() = Some(path.clone());
    if let Ok(cached) = std::fs::read(&path) {
        if cached_seal_is_current(private, &cached, plain) {
            return Ok(cached);
        }
        tracing::info!("the kept sealed pack is not under the current key; sealing afresh");
    }
    let sealed = codec.seal(plain.to_vec())?;
    let tmp = path.with_extension("pack.tmp");
    if std::fs::create_dir_all(path.parent().unwrap_or(ctx.git_dir))
        .and_then(|()| std::fs::write(&tmp, &sealed))
        .and_then(|()| std::fs::rename(&tmp, &path))
        .is_err()
    {
        tracing::warn!("could not keep the sealed pack; an interrupted push would re-seal it");
    }
    Ok(sealed)
}

/// Whether kept sealed bytes can be stored for `plain` now: they must open, tags and all,
/// under the CURRENT write epoch's key (a number alone is not enough: the key behind an epoch
/// number changes if its anchor's author stops being a maintainer) and hash back to `plain`
/// (a bit-flipped file would otherwise be stored under a self-consistent hash, unreadable
/// for good).
fn cached_seal_is_current(
    private: &forge_core::private::Private,
    cached: &[u8],
    plain: &[u8],
) -> bool {
    let header_epoch = forge_core::private::PackHeader::parse(
        cached
            .get(..forge_core::private::pack::HEADER_LEN)
            .unwrap_or_default(),
        cached.len() as u64,
    )
    .map(|h| h.epoch());
    header_epoch == Ok(private.write_epoch())
        && private
            .open_pack(cached, cached.len() as u64)
            .is_ok_and(|opened| opened == plain)
}

/// Where [`seal_for_push`] keeps the sealed bytes of `plain` for this repository.
fn sealed_cache_path(ctx: &PushContext<'_>, plain: &[u8]) -> std::path::PathBuf {
    ctx.git_dir.join("dash").join("sealed").join(format!(
        "{}-{}.pack",
        ctx.repo.id(),
        hex::encode(forge_core::private::keys::sha256(plain))
    ))
}

/// Drop the sealed pack this push kept ([`sealed_cache_path`]) once its refs landed: a retry
/// no longer needs it. Kept until then, so a push that stored its pack and failed at the refs
/// is retried with the same sealed bytes (the same hash: found recorded, not stored and paid
/// for again, D-601). Only this push's own file: another pack's pending retry keeps its own.
fn forget_sealed(path: Option<&std::path::Path>) {
    if let Some(p) = path {
        let _ = std::fs::remove_file(p);
    }
}

/// The pack being pushed, with the facts every storage step needs.
struct PackJob<'a> {
    bytes: &'a [u8],
    meta: PackMeta,
    pack_hash: [u8; 32],
    object_count: u64,
    chunk_count: u32,
    /// The plaintext pack's size (`bytes` is sealed in a private repository; a dry run seals
    /// nothing): what the estimate seals itself, so a dry run and a push price the same.
    plain_bytes: u64,
    /// Objects the browse index this push publishes covers ([`folded_index_objects`]).
    index_objects: u64,
}

impl<'a> PackJob<'a> {
    /// The job for `pack`, stored as `stored` (sealed in a private repository).
    async fn for_push(
        ctx: &PushContext<'_>,
        stored: &'a [u8],
        pack: &forge_core::pack::Pack,
    ) -> Result<Self> {
        let objects = pack.parsed.object_count() as u64;
        let index_objects = folded_index_objects(ctx, objects).await;
        Self::new(stored, pack.bytes.len() as u64, objects, index_objects)
    }

    fn new(
        bytes: &'a [u8],
        plain_bytes: u64,
        object_count: u64,
        index_objects: u64,
    ) -> Result<Self> {
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
            plain_bytes,
            index_objects,
        })
    }

    /// The on-chain cost of this push with (or without) Platform storing the bytes.
    fn estimate(&self, ctx: &PushContext<'_>, platform_bytes: bool) -> push_fees::PushEstimate {
        let mut est = push_fees::estimate_push(&push_fees::PushShape {
            pack_bytes: self.plain_bytes,
            objects: self.object_count,
            index_objects: self.index_objects,
            refs: ctx.refs.len() as u64,
            external_targets: ctx.policy.resolved.external.len() as u64,
            platform_bytes,
            sealed: ctx.repo.visibility == forge_core::rules::v2::Visibility::Private,
        });
        // The history index this push publishes with the pack (its manifest and chunks).
        est.metadata_credits += history_credits(ctx, platform_bytes);
        est
    }
}

/// The objects the browse index this push publishes will cover: the pack's own, or, when
/// the push folds the live fragments into one index (every 16th push,
/// `RepoService::publish_push_locator`), theirs too, which a Platform-stored index pays
/// for in chunks. A policy that stores nothing on Platform (and cannot fall back to it)
/// pays nothing for the index's size, so it is not read. When the manifests or the members
/// cannot be read, the pack's own objects (a fold then goes unpriced; the push's own manifest
/// read, which follows, fails it in that case).
async fn folded_index_objects(ctx: &PushContext<'_>, objects: u64) -> u64 {
    let resolved = &ctx.policy.resolved;
    if !(resolved.platform || resolved.platform_fallback) {
        return objects;
    }
    let (manifests, roles) = futures::join!(
        ctx.svc.read_pack_manifests(ctx.repo),
        ctx.svc.copy_roles(ctx.repo)
    );
    let (Ok(manifests), Ok(roles)) = (manifests, roles) else {
        return objects;
    };
    forge_core::repo::push_index_objects(&manifests, &roles, objects)
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
    // upload's own typed error (NotAMember, InsufficientCredits, …) under
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
                uris: stored.uris,
                // An incremental push supersedes nothing and carries no flatIndex tips.
                supersedes: Vec::new(),
                tips: Vec::new(),
            },
        )
        .await
        .context("writing pack manifest")?;
    // Paid for and recorded: say so now (a `stored` event), so a push that then fails at its
    // refs still reports it (D-601).
    let (text, event) = progress::stored_line(
        &job.meta.pack_hash,
        job.bytes.len() as u64,
        job.object_count,
    );
    ctx.progress.emit(&text, &event);
    let confirmed: Vec<&str> = replication
        .replicas
        .iter()
        .map(|r| r.target.as_str())
        .collect();
    ctx.say(&format!(
        "pack {} ({}) stored on {} ({} verified)",
        progress::abbrev(&job.meta.pack_hash, 12),
        human_bytes(job.bytes.len() as u64),
        confirmed.join(", "),
        confirmed.len()
    ));
    Ok(())
}

/// A dry run's price when this identity already recorded the pack (a retry of a push that
/// stored it, then failed at its refs): the real push never stores it again (its own manifest
/// is accepted, or the push refuses, E507), so only the refs are priced, and a retry is
/// neither charged for the pack again nor refused by a spend cap for it (D-601). Says so
/// (`recorded`) and returns the `platform` line.
/// Otherwise `full`, the pack's price.
async fn dry_run_writes(
    ctx: &PushContext<'_>,
    job: &PackJob<'_>,
    plain: &[u8],
    progress: Progress,
    full: (String, serde_json::Value),
) -> (String, serde_json::Value) {
    if !recorded_by_me(ctx, job, plain).await {
        return full;
    }
    let (text, event) = progress::recorded_line(&job.meta.pack_hash);
    progress.emit(&text, &event);
    // A recorded pack: the refs, and the history index a real push would add to them.
    let history = history_credits(ctx, ctx.policy.resolved.platform);
    progress::platform_line(&PlatformWrites {
        chunks: 0,
        manifests: ctx.history_cost.get().map_or(0, |c| c.manifests()),
        ref_updates: ctx.refs.len(),
        est_credits: push_fees::estimate_ref_updates(ctx.refs.len() as u64) + history,
        history_bytes: ctx.history_cost.get().map_or(0, |c| c.plain_len()),
    })
}

/// An earlier push may already have recorded this exact pack (a retry after a push that
/// stored it, then failed at its refs). Decided BEFORE the cost guard, so the guard weighs what
/// this push actually pays, the refs only: a retry capped below the pack's price is not refused
/// for it (D-601). `Some(price of the refs)` when the pack is reused.
async fn reuse_recorded(ctx: &PushContext<'_>, job: &PackJob<'_>) -> Result<Option<u64>> {
    if !already_recorded(ctx, job).await? {
        return Ok(None);
    }
    // The caller guards the refs (with the history index, one question) and publishes the
    // pack's browse index when no fragment covers it yet (a push that recorded the pack and died
    // before its index). The kept sealed bytes stay until the refs land ([`forget_sealed`]): this
    // push may still fail at its refs.
    Ok(Some(push_fees::estimate_ref_updates(ctx.refs.len() as u64)))
}

/// Whether this identity already wrote a `packManifest` for this pack (one indexed read, no
/// download). Unreadable counts as no: the dry run then prices the pack in full.
///
/// A dry run prices the plaintext pack (it seals nothing), while a private repository records
/// the SEALED pack's hash. The sealed bytes an earlier push kept for this plaintext
/// ([`sealed_cache_path`]) are what a real push would store again, so their hash is the one
/// looked up when they are there.
async fn recorded_by_me(ctx: &PushContext<'_>, job: &PackJob<'_>, plain: &[u8]) -> bool {
    let sealed = std::fs::read(sealed_cache_path(ctx, plain))
        .ok()
        .and_then(|b| PackMeta::for_bytes(&b).pack_hash_bytes().ok());
    let hash = sealed.unwrap_or(job.pack_hash);
    ctx.svc
        .read_pack_copies(ctx.repo, hash)
        .await
        .is_ok_and(|copies| copies.iter().any(|m| m.owner_id == ctx.identity))
}

/// Whether this pack is already recorded and readable, so the push stores nothing. `false`
/// when no manifest names it, or when none is readable and none is this identity's: forge-v2
/// gives every uploader its own manifest slot (the pack indexes include `$ownerId`) so that
/// nobody's dead or hostile copy can block an honest upload, and this push stores its own.
/// This identity's own unreadable copy cannot be replaced (its slot is taken), so that case
/// refuses, pointing at `dg reseed --from-local`.
async fn already_recorded(ctx: &PushContext<'_>, job: &PackJob<'_>) -> Result<bool> {
    let copies = ctx
        .svc
        .read_pack_copies(ctx.repo, job.pack_hash)
        .await
        .context("checking for an existing manifest of this pack")?;
    if copies.is_empty() {
        return Ok(false);
    }
    match confirm_existing_manifest(ctx, job, &copies).await {
        Ok(()) => Ok(true),
        Err(e) if !copies.iter().any(|m| m.owner_id == ctx.identity) => {
            ctx.say(&format!(
                "no recorded copy of pack {} is readable ({e:#}); storing this push's own copy",
                progress::abbrev(&job.meta.pack_hash, 12)
            ));
            Ok(false)
        }
        Err(e) => Err(e),
    }
}

/// This pack already has a manifest (an earlier push recorded it). Accept it only if at
/// least one recorded copy is readable and hash-matches; otherwise refuse — before this
/// push pays for anything — naming the dead copies and the way back.
///
/// A Platform-tier (`storage = 0`) manifest written by THIS identity for a pack of the
/// same size is accepted without a download: its chunks were confirmed at consensus when
/// it was written, and a plain Platform re-push (the common "interrupted after the
/// manifest" resume) must not re-download the whole pack to find that out. On forge-v2 a
/// manifest from someone else is never taken on trust: it is read and verified, since a
/// hostile member could post a manifest with the right hash and no bytes behind it.
async fn confirm_existing_manifest(
    ctx: &PushContext<'_>,
    job: &PackJob<'_>,
    copies: &[forge_core::repo::PackManifestInfo],
) -> Result<()> {
    let short = progress::abbrev(&job.meta.pack_hash, 12);
    let mine_on_chain = copies.iter().any(|m| {
        m.storage == 0
            && m.owner_id == ctx.identity
            && m.chunk_count == u64::from(job.chunk_count)
            && m.size_bytes == job.bytes.len() as u64
    });
    if mine_on_chain {
        ctx.say(&format!(
            "pack {short} is already stored on Platform by an earlier push; not storing it again"
        ));
        return Ok(());
    }
    let reader = PackReader::from_user_config();
    let contract = ctx.svc.repo_contract(ctx.repo).await?;
    let roles = ctx.svc.copy_roles(ctx.repo).await?;
    let refs: Vec<&forge_core::repo::PackManifestInfo> = copies.iter().collect();
    match ctx
        .svc
        .fetch_best_copy(ctx.repo, &contract, &refs, &roles, &reader)
        .await
    {
        Ok((bytes, _)) if PackMeta::for_bytes(&bytes).pack_hash == job.meta.pack_hash => {
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
            let recorded = copies
                .iter()
                .map(|m| {
                    if m.uris.is_empty() {
                        format!("Platform chunks of {}", m.owner_id)
                    } else {
                        m.uris.join(", ")
                    }
                })
                .collect::<Vec<_>>()
                .join("; ");
            Err(UserError::new(
                codes::RECORDED_COPY_LOST,
                format!("push refused: pack {short} is already recorded, and no recorded copy is readable"),
            )
            .cause(format!("pack {short}… already recorded at {recorded}: {why}"))
            .fix(format!(
                "re-upload it from this clone: `dg reseed {} --from-local` (run inside this repository; a private repo's sealed copy is only kept by the clone that pushed it), then push again",
                ctx.repo_label
            ))
            .fix("restore that storage, then push again")
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
async fn publish_browse_index(ctx: &PushContext<'_>, index: PendingIndex) -> StoredWith {
    let PendingIndex {
        parsed,
        pack_hash,
        replication,
        externals,
    } = index;
    let stored = StoredWith {
        replication,
        externals,
    };
    if !publishes_browse_index() {
        tracing::info!("DASH_FORGE_NO_BROWSE_INDEX set; not publishing a browse-index fragment");
        return stored;
    }
    let chain = stored.platform_target(ctx);
    let targets = stored.targets(chain.as_ref());
    let required = ctx.policy.resolved.replicas.min(targets.len()).max(1);
    let target = RepackTarget::Replicated {
        targets: &targets,
        required,
    };
    match ctx
        .svc
        .publish_push_locator(ctx.repo, &parsed, pack_hash, target)
        .await
    {
        Ok(forge_core::repo::PushIndexOutcome::Fragment { pack_ref, .. }) => {
            tracing::info!(pack_ref, "published browse-index fragment");
        }
        Ok(forge_core::repo::PushIndexOutcome::Consolidated { folded, .. }) => {
            tracing::info!(folded, "folded browse-index fragments into one locator");
        }
        Ok(forge_core::repo::PushIndexOutcome::Skipped(skip)) => index_skipped(ctx, &skip),
        // The pack is stored and fine: only its index is missing.
        Err(e) => index_skipped(ctx, &reindex_skip(format!("{e:#}"))),
    }
    stored
}

/// The browse index goes last: waiting for a lagging node to list the pack's manifest (D-920)
/// must never hold the refs back, and a push is complete without its index. It is published
/// even when the refs failed: the pack is stored, and a retry finds it recorded and stores
/// (and indexes) nothing again.
async fn publish_index_after_refs(
    ctx: Option<&PushContext<'_>>,
    index: Option<PendingIndex>,
) -> Option<StoredWith> {
    match (ctx, index) {
        (Some(ctx), Some(index)) => Some(publish_browse_index(ctx, index).await),
        _ => None,
    }
}

/// Where a push's pack went: its browse artifacts go to the same places.
struct StoredWith {
    replication: Replication,
    externals: Vec<ExternalTarget>,
}

impl StoredWith {
    /// The Platform chunk target, when the pack is on Platform.
    fn platform_target<'c>(&self, ctx: &'c PushContext<'c>) -> Option<PlatformChunkTarget<'c>> {
        self.replication.has_platform().then(|| {
            PlatformChunkTarget::new(ctx.svc, ctx.repo, forge_core::storage::PLATFORM_PROFILE)
        })
    }

    /// The external targets that confirmed the pack, plus `chain` (the Platform target).
    fn targets<'t>(
        &'t self,
        chain: Option<&'t PlatformChunkTarget<'_>>,
    ) -> Vec<&'t dyn StorageTarget> {
        let mut targets: Vec<&dyn StorageTarget> = self
            .externals
            .iter()
            .filter(|t| {
                self.replication
                    .replicas
                    .iter()
                    .any(|r| r.target == StorageTarget::name(*t))
            })
            .map(|t| t as &dyn StorageTarget)
            .collect();
        if let Some(c) = chain {
            targets.push(c);
        }
        targets
    }
}

/// Whether this push publishes browse artifacts. `DASH_FORGE_NO_BROWSE_INDEX=1` skips them on
/// purpose, for a test repo that must stay unindexed so the web app's in-browser fallback clone
/// (and its history walk) is what gets exercised.
fn publishes_browse_index() -> bool {
    !matches!(
        std::env::var("DASH_FORGE_NO_BROWSE_INDEX").as_deref(),
        Ok("1" | "true")
    )
}

/// Compute the history index of the default branch's new tip, when this push moves the default
/// branch (`None` otherwise, or when it cannot be computed: the push never fails for it). Local
/// work plus the manifest list the push reads anyway.
async fn prepare_push_history(
    svc: &RepoService<'_>,
    repo: &RepoRef,
    planned: &[Planned],
    git_dir: &Path,
    progress: Progress,
) -> Option<PushHistory> {
    // The repository's config names the default branch. A config that cannot be read skips the
    // index (a guess could index the wrong branch). A repository with no default branch in its
    // config (a lagging node that does not list a just-created repo's config yet) uses the one
    // forge-import names when it spawned this push, else `main`.
    let default = match svc.read_default_branch(repo).await {
        Ok(Some(b)) => b,
        Ok(None) => {
            default_branch_hint().unwrap_or_else(|| forge_core::repo::DEFAULT_BRANCH.to_string())
        }
        Err(e) => {
            progress.note(&format!(
                "the default branch could not be read ({e}); no history index this push"
            ));
            return None;
        }
    };
    let want = format!("refs/heads/{default}");
    let tip_hex = planned
        .iter()
        .filter(|p| p.reject.is_none() && p.spec.dst == want)
        .find_map(|p| p.new_oid.clone())?;
    let tip = forge_core::pack::historyindex::parse_hex_oid(tip_hex.as_bytes()).ok()?;
    let prepared = async {
        let plan = svc.plan_history_publish(repo, tip).await?;
        let dir = git_dir.to_path_buf();
        tokio::task::spawn_blocking(move || {
            forge_core::repo::prepare_history_index(&dir, tip, &plan)
        })
        .await
        .map_err(|e| forge_core::error::Error::Io(e.to_string()))?
    }
    .await;
    match prepared {
        Ok(p) => p.map(|prepared| PushHistory {
            prepared,
            branch: want,
        }),
        Err(e) => {
            progress.note(&format!(
                "the history index was not computed ({e}); the web walks history for this tip"
            ));
            None
        }
    }
}

/// The history index a push computed, with the ref (`refs/heads/<default>`) it describes.
struct PushHistory {
    prepared: PreparedHistory,
    branch: String,
}

/// Say, on every push's output and in the report file, that the history index was not published
/// and how to publish it (the `historySkipped` event; forge-import turns it into a warning).
fn history_skipped(ctx: &PushContext<'_>, why: &str) {
    let fix = format!("dg repo reindex {}", ctx.repo_label);
    let message = format!(
        "the history index was not published ({why}); the web walks history for this tip until \
         `{fix}` publishes it"
    );
    let event = serde_json::json!({
        "event": "historySkipped",
        "message": forge_core::user_error::redact(&message),
        "fix": fix,
    });
    Progress {
        enabled: true,
        ..ctx.progress
    }
    .emit(&format!("dash: warning: {message}"), &event);
    progress::report(&event);
}

/// The default branch forge-import names for a repository it created a moment ago
/// (`DASH_FORGE_DEFAULT_BRANCH`), honoured only in a push forge-import spawned
/// (`DASH_FORGE_SPAWNED_BY=forge-import`): a stray variable in a user's shell never picks the
/// branch an index describes.
fn default_branch_hint() -> Option<String> {
    let spawned = secret_scan::spawned_by_import();
    spawned
        .then(|| std::env::var("DASH_FORGE_DEFAULT_BRANCH").ok())
        .flatten()
        .filter(|b| !b.is_empty())
}

/// A push that stores no pack of its own pays for its refs; the history index is one more write
/// on top of them, to `replication`'s places and priced for them. One question weighs both
/// (under `dash.confirm=always`, one prompt, not one per write). A guard that declines them
/// together is asked again for the refs alone: then the index is skipped with a
/// `historySkipped` event and left to `dg repo reindex`, and the refs still land. A guard that
/// declines the refs alone refuses the push, as before. Returns the push's price and where the
/// index goes.
fn history_alone(
    ctx: &PushContext<'_>,
    refs_only: u64,
    replication: Replication,
) -> Result<(u64, HistoryTarget)> {
    if ctx.history_cost.get().is_none() {
        policy::enforce(refs_only, ctx.policy, false, policy::NOTE_NOTHING_STORED)?;
        return Ok((refs_only, HistoryTarget::None));
    }
    let platform = replication.has_platform();
    let external = replication.replicas.iter().filter(|r| !r.platform).count() as u64;
    let with_history = || refs_only + history_price(ctx, external, platform);
    let note = policy::NOTE_NOTHING_STORED;
    // A declined due full history index: ask again with its cheaper delta (review L8).
    let mut outcome = policy::enforce(with_history(), ctx.policy, platform, note);
    if outcome.is_err() && take_history_fallback(ctx) {
        outcome = policy::enforce(with_history(), ctx.policy, platform, note);
    }
    match outcome {
        Ok(()) => Ok((with_history(), HistoryTarget::Alone(replication))),
        Err(e) => {
            policy::enforce(refs_only, ctx.policy, false, policy::NOTE_NOTHING_STORED)?;
            history_skipped(ctx, &format!("the cost guard declined it: {}", e.message));
            Ok((refs_only, HistoryTarget::None))
        }
    }
}

/// Where the policy stores a new artifact: its external targets, and Platform when it
/// includes Platform.
fn policy_replication(ctx: &PushContext<'_>) -> Replication {
    let resolved = &ctx.policy.resolved;
    let replicas = resolved
        .external
        .iter()
        .map(|(name, _)| forge_core::storage::Replica {
            target: name.clone(),
            uris: Vec::new(),
            platform: false,
        })
        .chain(resolved.platform.then(|| forge_core::storage::Replica {
            target: forge_core::storage::PLATFORM_PROFILE.into(),
            uris: Vec::new(),
            platform: true,
        }))
        .collect();
    Replication {
        replicas,
        failures: Vec::new(),
    }
}

/// The history index names the tip the default branch has now: published once the refs
/// converged and only when the default branch reads at the tip it was computed for (a rejected
/// or raced default ref gets none), to where the push's pack went (or its recorded copies).
async fn publish_history_after_refs(
    ctx: &PushContext<'_>,
    history: PushHistory,
    target: HistoryTarget,
    stored: Option<StoredWith>,
    final_refs: &[(String, RefState)],
) {
    if matches!(target, HistoryTarget::None) {
        return;
    }
    if !history_tip_landed(&history, final_refs) {
        history_skipped(ctx, "the default branch did not land at the pushed tip");
        return;
    }
    match (target, stored) {
        (HistoryTarget::WithPack, Some(stored)) => {
            publish_history(ctx, history.prepared, stored).await;
        }
        (HistoryTarget::Alone(replication), _) => {
            publish_history_alone(ctx, history.prepared, replication).await;
        }
        // Priced with a pack whose browse index was not handed back: nowhere known to put it.
        (HistoryTarget::WithPack | HistoryTarget::None, _) => {
            history_skipped(ctx, "the pack's storage targets were not available");
        }
    }
}

/// Whether the refs read after the push show the index's branch at the index's tip.
fn history_tip_landed(history: &PushHistory, final_refs: &[(String, RefState)]) -> bool {
    let want = hex::encode(history.prepared.index().tip);
    final_refs.iter().any(|(name, state)| {
        *name == history.branch && matches!(state, RefState::Resolved { oid, .. } if *oid == want)
    })
}

/// Publish the history index of a push that stored no pack of its own, to `replication`'s
/// places (the ones it was priced for).
async fn publish_history_alone(
    ctx: &PushContext<'_>,
    history: PreparedHistory,
    replication: Replication,
) {
    let externals = match external_targets(ctx) {
        Ok(t) => t,
        Err(e) => {
            history_skipped(ctx, &format!("{e:#}"));
            return;
        }
    };
    publish_history(
        ctx,
        history,
        StoredWith {
            replication,
            externals,
        },
    )
    .await;
}

/// Publish the history index this push computed, to where its pack went. Best-effort and
/// reported, never fatal: the refs have landed.
async fn publish_history(ctx: &PushContext<'_>, history: PreparedHistory, stored: StoredWith) {
    let chain = stored.platform_target(ctx);
    let targets = stored.targets(chain.as_ref());
    let required = ctx.policy.resolved.replicas.min(targets.len()).max(1);
    let target = RepackTarget::Replicated {
        targets: &targets,
        required,
    };
    match ctx.svc.store_history_index(ctx.repo, history, target).await {
        Ok(p) => {
            let kind = if p.delta { "delta" } else { "full" };
            tracing::info!(rows = p.rows, kind, "published the history index");
            ctx.progress.emit(
                &format!(
                    "dash: history index published ({kind}, {} paths, {} commits)",
                    p.rows, p.commit_count
                ),
                &serde_json::json!({
                    "event": "historyIndex",
                    "delta": p.delta,
                    "paths": p.rows,
                    "commits": p.commit_count,
                }),
            );
        }
        Err(e) => history_skipped(ctx, &format!("{e:#}")),
    }
}

/// A skip whose repair is `dg repo reindex` (the pack is stored; only its index is missing).
fn reindex_skip(reason: impl Into<String>) -> forge_core::repo::IndexSkip {
    forge_core::repo::IndexSkip {
        reason: reason.into(),
        remedy: forge_core::repo::IndexRemedy::Reindex,
    }
}

/// Say that the push left its browse index unpublished (D-920), on the push's output in every
/// mode (a `-q` push too) and in the report file: the dashpay/dash import only ever logged it,
/// so an 18,452-chunk repository landed unbrowsable and nobody knew. forge-import turns the
/// event into a summary warning; `dg init` prints it.
fn index_skipped(ctx: &PushContext<'_>, skip: &forge_core::repo::IndexSkip) {
    let fix = skip.fix(&ctx.repo_label);
    let (text, event) = progress::index_skipped_line(&skip.reason, fix.as_deref());
    Progress {
        enabled: true,
        ..ctx.progress
    }
    .emit(&text, &event);
    progress::report(&event);
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

/// Resolve the network and its forge-v2 contracts. Precedence, field by field: the
/// environment (`DASH_FORGE_NETWORK`, `DASH_FORGE_DEVNET_NAME`, `DASH_FORGE_DAPI_ADDRESSES`,
/// `DASH_FORGE_QUORUM_URL` — what `dg` and forge-import set per invocation) > git config
/// (`dash.network`, `dash.devnetName`, `dash.dapiAddresses`, `dash.quorumUrl`) > the network
/// `dg auth new` / `dg auth login` saved in `config.toml` > the embedded deployment > testnet
/// (`NetworkSettings::for_git_helper`).
pub(crate) fn network_target() -> Result<NetworkTarget> {
    resolve_network(NetworkSettings::for_git_helper(crate::git::config_get)?)
}

fn resolve_network(settings: NetworkSettings) -> Result<NetworkTarget> {
    settings.resolve().context(
        "resolving the network (DASH_FORGE_NETWORK / git config dash.network / dg's config.toml)",
    )
}

/// Whether `DASH_FORGE_SKIP_WRITE_PRECHECK` asks to bypass [`write_access_denied`].
fn skip_write_precheck() -> bool {
    matches!(
        std::env::var("DASH_FORGE_SKIP_WRITE_PRECHECK").as_deref(),
        Ok("1" | "true")
    )
}

/// The advisory write pre-check (see [`write_access_denied`]): the refused refs' outcomes
/// and the specs still to push. A non-member is refused everything; so is every push to an
/// archived repo unless pushed with `-o allow-archived`; a writer is refused
/// the protected refs.
async fn precheck(
    conn: &Conn,
    svc: &RepoService<'_>,
    specs: &[PushSpec],
    options: &OptionState,
) -> (Vec<PushOutcome>, Vec<PushSpec>) {
    let access = write_access_denied(conn, svc, specs).await;
    let everything = access.as_ref().is_some_and(|d| d.refs.is_empty());
    let archived = if everything || options.has_push_option(ALLOW_ARCHIVED_PUSH_OPTION) {
        None
    } else {
        archived_denied(conn, svc).await
    };
    let Some(denied) = archived.or(access) else {
        return (Vec::new(), specs.to_vec());
    };
    // The block says why and what to do; git's own `! [remote rejected]` lines (from the
    // per-ref reason) make the push fail.
    denied.error.eprint("dash: ");
    let mut event = denied.error.to_json();
    event["event"] = serde_json::json!("error");
    progress::report(&event);
    let (refused, allowed): (Vec<PushSpec>, Vec<PushSpec>) = specs
        .iter()
        .cloned()
        .partition(|s| denied.refs.is_empty() || denied.refs.contains(&s.dst));
    let refused = refused
        .into_iter()
        .map(|s| PushOutcome::Error(s.dst, denied.wire.to_string()))
        .collect();
    (refused, allowed)
}

/// The note on a push the helper refused before doing anything.
const NOTE_PRECHECK: &str = "checked before building or paying for anything: nothing was stored";

/// The push option that overrides the archived refusal ([`archived_denied`]).
pub const ALLOW_ARCHIVED_PUSH_OPTION: &str = "allow-archived";

/// `Some(refusal)` when the repo's current config is `archived`. Archiving is a client rule
/// (consensus still admits a member's writes, `forge-v2.md` §5), so the helper enforces it;
/// an unreadable config proceeds, like the membership check.
async fn archived_denied(conn: &Conn, svc: &RepoService<'_>) -> Option<Denied> {
    let config = svc.current_config(&conn.repo).await.ok()?;
    config
        .archived
        .then(|| archived_refusal(&conn.repo.display()))
}

/// The push refusal for an archived repo (E606).
fn archived_refusal(repo: &str) -> Denied {
    Denied {
        error: UserError::new(
            codes::ARCHIVED,
            format!("push rejected: {repo} is archived"),
        )
        .cause("a maintainer marked the repository archived (read-only by agreement)")
        .fix(format!(
            "ask a maintainer to run `dg repo unarchive {repo}`"
        ))
        .fix(format!(
            "push anyway: `git push -o {ALLOW_ARCHIVED_PUSH_OPTION} …` (Forge apps enforce archiving, not Platform)"
        ))
        .note(NOTE_PRECHECK),
        wire: "repository archived",
        refs: Vec::new(),
    }
}

/// A private repository needs the identity file's `ENCRYPTION` key (E306) and an accepted
/// wrap to it (E307/E308/E309): checked when the helper connects, so a clone by a non-member
/// fails with the reason and the fix rather than an empty repository.
async fn require_private_key(
    client: &PlatformClient,
    identity: &LoadedIdentity,
    bridge: &BridgeIdentity,
    repo: &RepoRef,
) -> Result<std::sync::Arc<forge_core::keyring::Keyring>> {
    let signer = forge_core::keyring::PrivateSigner {
        client,
        identity,
        bridge,
    };
    let enc = signer.encryption_keys(repo);
    if enc.is_empty() {
        return Err(forge_core::keyring::no_encryption_key_held(&format!(
            "private repo {}",
            repo.display()
        ))
        .into());
    }
    let kr = signer.keyring(repo).await?;
    kr.require_key(repo)?;
    // The repair check (§5.6) on every visit by a maintainer: git cannot prompt to spend, so
    // the helper says what is wrong and the command that fixes it.
    let maintainer = kr.reader_role() == Some(forge_core::rules::v2::Role::Maintainer);
    if let (true, Some(r)) = (maintainer, kr.resolution().repair.as_ref()) {
        if r.rotate || !r.missing_wraps.is_empty() {
            eprintln!(
                "dash: the key of {} needs a repair ({}); run `dg repo keys repair {}`",
                repo.display(),
                if r.rotate {
                    "a non-member still holds the current key"
                } else {
                    "a member has no wrap for the current key"
                },
                repo.display()
            );
        }
    }
    Ok(std::sync::Arc::new(kr))
}

/// E301 — no identity file to sign with.
fn no_identity(why: impl Into<String>) -> anyhow::Error {
    UserError::new(codes::NO_IDENTITY, "no identity configured")
        .cause(why)
        .fix("`dg auth login <file>` (or `dg auth new`) records a default key that git uses too")
        .fix("export DASH_FORGE_KEY=<identity file | keychain:… | dfk1:…> in the shell you run git in")
        .into()
}

/// The helper's own refusal of a push it can prove would be rejected: the block printed to
/// stderr, and the short per-ref reason git shows in `! [remote rejected] … (<reason>)`.
struct Denied {
    error: UserError,
    wire: &'static str,
    /// The refs refused; empty means the whole push.
    refs: Vec<String>,
}

/// `Some(refusal)` when the connected identity provably is not a member (no `writer` or
/// `maintainer` document) of the repo, and so cannot land any push.
///
/// Returns `None` — i.e. proceed — when membership cannot be determined. The read is
/// advisory: consensus (`ownerRefersTo`, 40120) is the authority, and a transient read
/// failure must not block a push a member is entitled to make.
async fn write_access_denied(
    conn: &Conn,
    svc: &RepoService<'_>,
    specs: &[PushSpec],
) -> Option<Denied> {
    let me = conn.identity().id();
    let role = MemberReader::new(&conn.client)
        .best_role(&conn.repo, &me)
        .await
        .ok()?;
    match role {
        None => return Some(write_denied(&conn.repo.display(), &me)),
        // RC2 member roles: a triage member or reader cannot push (every push document claims
        // `r` 1, and their writer document's role is 2 or 3).
        Some(role) if !role.is_approver() => return Some(role_denied(&conn.repo, &me, role)),
        // A maintainer may update any ref.
        Some(forge_core::rules::v2::Role::Maintainer) => return None,
        // A writer (not a maintainer) cannot update a protected ref: its
        // `protectedRefUpdate` is maintainer-only at consensus. Refuse before the pack is
        // stored and paid for.
        Some(_) => {}
    }
    let patterns = svc.protected_patterns(&conn.repo).await.ok()?;
    // Deletes too: a delete of a protected ref is a `protectedRefUpdate`.
    let protected: Vec<&str> = specs
        .iter()
        .map(|s| s.dst.as_str())
        .filter(|d| forge_core::rules::matches_protected(d, &patterns))
        .collect();
    if protected.is_empty() {
        return None;
    }
    Some(protected_denied(&conn.repo.display(), &me, &protected))
}

/// The push refusal for a writer updating a protected ref.
fn protected_denied(repo: &str, me: &str, refs: &[&str]) -> Denied {
    Denied {
        error: UserError::new(
            codes::NOT_A_WRITER,
            format!(
                "push rejected: only maintainers of {repo} can update {}",
                refs.join(", ")
            ),
        )
        .cause("the ref matches the repo's protected patterns, and you are a writer")
        .fix(format!(
            "ask the owner to run `dg collab add {repo} {me} --role maintainer`"
        ))
        .fix("push to a branch that is not protected")
        .note(NOTE_PRECHECK),
        wire: "protected ref: maintainers only",
        refs: refs.iter().map(|r| (*r).to_string()).collect(),
    }
}

/// The push refusal for a triage member or reader: what their role allows.
fn role_denied(
    repo: &forge_core::scope::RepoRef,
    me: &str,
    role: forge_core::rules::v2::Role,
) -> Denied {
    let display = repo.display();
    let who = role.noun();
    Denied {
        error: UserError::new(
            codes::NOT_A_WRITER,
            format!("push rejected: you are {who} of {display}, not a writer"),
        )
        .cause(forge_core::members::role_limits(role, repo).unwrap_or_default())
        .fix(format!(
            "ask the owner to run `dg collab add {display} {me} --role writer`"
        ))
        .fix("push to a repo of your own (`dg repo create <name>`) and open a pull request")
        .note(NOTE_PRECHECK),
        wire: if role == forge_core::rules::v2::Role::Triage {
            "triage members cannot push"
        } else {
            "readers cannot push"
        },
        refs: Vec::new(),
    }
}

/// The push refusal for an identity that is not a member.
///
/// Worded unlike the consensus error (`40120`, "consensus refused"), so a caller (the e2e
/// suite) can tell this local refusal from a network verdict.
fn write_denied(repo: &str, me: &str) -> Denied {
    Denied {
        error: UserError::new(
            codes::NOT_A_WRITER,
            format!("push rejected: you are not a writer of {repo}"),
        )
        .cause("your identity has no writer or maintainer document for this repo")
        .fix(forge_core::user_error::join_fix(repo, me, "writer"))
        .fix("push to a repo of your own: `dg repo create <name>`, then `git push dash://<you>/<name> <branch>`")
        .note(NOTE_PRECHECK),
        wire: "not a writer of this repo",
        refs: Vec::new(),
    }
}

/// The key `dg` handed over ([`forge_core::key_handoff`]), read once at startup.
static HANDED_KEY: std::sync::OnceLock<forge_core::keystore::Secret> = std::sync::OnceLock::new();

/// Record the key [`forge_core::key_handoff::take`] read (`main` does, before anything else).
pub fn set_handed_key(key: forge_core::keystore::Secret) {
    let _ = HANDED_KEY.set(key);
}

/// The identity `dg` handed over, else the one at the key source `resolve` names (called
/// only when nothing was handed over).
fn handed_or_load(resolve: impl FnOnce() -> Result<PathBuf>) -> Result<BridgeIdentity> {
    match HANDED_KEY.get() {
        Some(key) => BridgeIdentity::from_source_text(key.expose())
            .context("loading the identity dg handed over"),
        None => load_identity(&resolve()?),
    }
}

/// Load the identity at `key_path`. A sealed key file with no way to get its passphrase (no
/// terminal, no DASH_FORGE_PASSPHRASE) is refused with the ways out, instead of the generic
/// "this command does not prompt".
pub fn load_identity(key_path: &Path) -> Result<BridgeIdentity> {
    let shown = forge_core::keystore::describe_key_source(key_path);
    // Only when no passphrase could be had does the file's kind matter.
    if !forge_core::sealed::passphrase_available() && forge_core::keystore::is_sealed_file(key_path)
    {
        return Err(sealed_key_needs_passphrase(&shown).into());
    }
    BridgeIdentity::load_from_file(key_path)
        .with_context(|| format!("loading identity from {shown}"))
}

/// E303: a sealed key file, and no terminal to ask for its passphrase on.
fn sealed_key_needs_passphrase(shown: &str) -> UserError {
    UserError::new(
        codes::IDENTITY_UNREADABLE,
        "your key is sealed with a passphrase, and there is no terminal to ask for it on",
    )
    .cause(format!(
        "{shown} is passphrase-sealed; git-remote-dash asks for the passphrase on the terminal \
         (/dev/tty), and this git has none (or GIT_TERMINAL_PROMPT=0)"
    ))
    .fix("run the same git command in a terminal: it asks for the passphrase once")
    .fix("keep the key in the OS keychain, which needs no passphrase: `dg auth login` where a keychain is available (without DASH_FORGE_NO_KEYCHAIN)")
    .fix("push through dg, which asks once and hands the key to git: `dg init` pushes the current branch to this repository's remote (an existing repository is not paid for again)")
    .fix("scripts and CI: set DASH_FORGE_PASSPHRASE, or DASH_FORGE_KEY to a `dg auth export --format dfk1` key")
    .note("nothing was written")
}

/// `git-remote-dash --check-key`: load the signing key the way a push would (the handed key,
/// else `DASH_FORGE_KEY`, else the recorded default) and print `{"identityId": …}`. `dg` runs
/// it before it pays for a repository, so a push that could not sign is refused first.
pub fn check_key() -> Result<()> {
    // Without a handoff this has no repository, so no owner: it skips the per-owner
    // `identities/<owner>.identity.json` that `resolve_key_path` would try for a named URL.
    // `dg` always hands the key over, so its pre-flight never reaches this fallback.
    let bridge = handed_or_load(|| {
        std::env::var_os("DASH_FORGE_KEY")
            .map(PathBuf::from)
            .or(forge_core::keystore::configured_default_source()?.map(PathBuf::from))
            .ok_or_else(|| no_identity("neither DASH_FORGE_KEY nor a default identity is set"))
    })?;
    bridge.doc_op_key()?;
    println!(
        "{}",
        serde_json::json!({ "identityId": bridge.identity_id })
    );
    Ok(())
}

/// Load the signing identity for `repo` (the key `dg` handed over, else [`resolve_key_path`])
/// and fetch it: E301 naming `why` an identity is needed when no key source is configured.
async fn load_signer(
    url: &DashUrl,
    client: &PlatformClient,
    repo: &RepoRef,
    why: &str,
) -> Result<Signer> {
    let bridge = handed_or_load(|| {
        let key_path =
            resolve_key_path(url, repo.owner_id()).map_err(|e| e.context(why.to_string()))?;
        if std::env::var_os("DASH_FORGE_KEY").is_none()
            && forge_core::keystore::is_file_source(&key_path)
            && !key_path.exists()
        {
            // A recorded default whose file is gone is named. The per-owner file this falls
            // back to without one is not: it is named after the repository's owner, and reads
            // as if the owner's key were wanted (QW-040).
            let recorded = forge_core::keystore::configured_default_source()
                .ok()
                .flatten()
                .is_some_and(|d| std::path::Path::new(&d) == key_path);
            let why = if recorded {
                format!(
                    "{why}; DASH_FORGE_KEY is not set and the default identity file dg recorded, {}, does not exist",
                    key_path.display()
                )
            } else {
                tracing::debug!(path = %key_path.display(), "no per-owner identity file");
                format!("{why}; DASH_FORGE_KEY is not set and no default identity is recorded")
            };
            if repo.visibility == forge_core::rules::v2::Visibility::Private {
                // Only a key source with the encryption key opens it (`dg auth login`).
                return Err(UserError::new(codes::NO_IDENTITY, "no identity configured")
                    .cause(why)
                    .fix(format!(
                        "sign in with a key source that holds your ENCRYPTION key: {}",
                        forge_core::user_error::FIX_FULL_KEY_LOGIN
                    ))
                    .fix("export DASH_FORGE_KEY=<identity file> in the shell you run git in")
                    .into());
            }
            return Err(no_identity(why));
        }
        Ok(key_path)
    })?;
    let identity = client
        .fetch_signer(&bridge)
        .await
        .with_context(|| format!("fetching identity {}", bridge.identity_id))?;
    Ok(Signer { identity, bridge })
}

/// Resolve the identity key source: `DASH_FORGE_KEY` if set, else (for `dash://<owner>/…`)
/// `~/.config/dash-forge/identities/<owner id>.identity.json` when it exists, else the
/// default `dg` recorded in `~/.config/dash-forge/config.toml`. `owner_id` is the resolved
/// owner, so a DPNS-named owner finds its per-owner file too.
fn resolve_key_path(url: &DashUrl, owner_id: &str) -> Result<PathBuf> {
    if let Some(p) = std::env::var_os("DASH_FORGE_KEY") {
        return Ok(PathBuf::from(p));
    }
    // Then a per-owner file (below) when one exists, else the identity `dg auth new` /
    // `dg auth login` recorded as the default (a keychain entry or a key file), so a plain
    // `git push` signs as `dg` does.
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| no_identity("neither DASH_FORGE_KEY nor HOME is set"))?;
    // The per-owner default only makes sense for the named form. A repo-id URL is reached
    // from `dg` (a pull request's head), not typed by hand, so it uses the recorded default.
    // A config.toml that does not parse fails here (E204 naming its line), as it does in `dg`.
    if let DashUrl::Id { .. } = url {
        return forge_core::keystore::configured_default_source()?
            .map(PathBuf::from)
            .ok_or_else(|| {
                no_identity("an id-addressed dash:// URL has no owner to pick a default key for")
            });
    }
    let per_owner = forge_core::keystore::forge_config_dir()
        .unwrap_or_else(|| home.join(".config/dash-forge"))
        .join("identities")
        .join(format!("{owner_id}.identity.json"));
    if per_owner.exists() {
        return Ok(per_owner);
    }
    Ok(forge_core::keystore::configured_default_source()?.map_or(per_owner, PathBuf::from))
}

/// The `hint:` a fetch of a repository marked as moved prints: where it went, and, for a named
/// remote (not a URL fetched directly), the `git remote set-url` that follows it.
fn moved_hint(from: &str, to: &str, remote: Option<&str>) -> String {
    match remote.filter(|r| !r.is_empty() && !r.contains("://")) {
        Some(r) => format!(
            "hint: {from} has moved to {to}; to follow it, run `git remote set-url {r} {to}`"
        ),
        None => format!("hint: {from} has moved to {to}"),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        archived_refusal, blames_set_aside_packs, forget_sealed, head_outcome, hidden_packs_needed,
        is_head, list_lines, oid_to_bytes, packs_unreadable, protected_denied, resolve_network,
        settle_ref_writes, skipped_packs_needed, write_denied, Planned, PushOutcome, PushSpec,
        Unreadable,
    };
    use super::{default_branch_hint, history_tip_landed, role_denied, PushHistory};

    #[test]
    fn a_moved_hint_names_the_remote_to_update() {
        assert_eq!(
            super::moved_hint("dash://a/x", "dash://b/y", Some("upstream")),
            "hint: dash://a/x has moved to dash://b/y; to follow it, run `git remote set-url upstream dash://b/y`"
        );
        assert_eq!(
            super::moved_hint("dash://a/x", "dash://b/y", Some("dash://a/x")),
            "hint: dash://a/x has moved to dash://b/y"
        );
    }

    #[test]
    fn a_lease_holds_only_where_the_ref_still_points() {
        use super::lease_reject;
        let a = "a".repeat(40);
        let b = "b".repeat(40);
        assert_eq!(lease_reject(&a, Some(&a)), None);
        assert_eq!(lease_reject(&a, Some(&b)).as_deref(), Some("stale info"));
        assert_eq!(lease_reject(&a, None).as_deref(), Some("stale info"));
        assert_eq!(lease_reject("", None), None);
        assert_eq!(lease_reject("", Some(&a)).as_deref(), Some("stale info"));
    }

    #[test]
    fn a_new_ref_that_collides_is_refused_unless_this_push_deletes_the_other() {
        use super::reject_collisions;
        use forge_core::rules::RefState;
        let live = RefState::Resolved {
            oid: "a".repeat(40),
            author: String::new(),
            created_at: 0,
        };
        let refs = vec![("refs/heads/feature".to_string(), live)];
        let delete = |dst: &str| Planned {
            spec: PushSpec {
                force: false,
                src: String::new(),
                dst: dst.into(),
            },
            new_oid: None,
            prev_oid: Some("a".repeat(40)),
            reject: None,
        };
        let rejects = |mut p: Vec<Planned>| {
            reject_collisions(&mut p, &refs);
            p.into_iter().map(|p| p.reject).collect::<Vec<_>>()
        };
        assert_eq!(
            rejects(vec![planned("refs/heads/feature/x")]),
            vec![Some(
                "refs/heads/feature exists, so refs/heads/feature/x cannot be created under it"
                    .to_string()
            )]
        );
        assert_eq!(
            rejects(vec![
                delete("refs/heads/feature"),
                planned("refs/heads/feature/x")
            ]),
            vec![None, None]
        );
        // A deletion the plan refused (a stale lease) does not clear the way.
        let mut stale = delete("refs/heads/feature");
        stale.reject = Some("stale info".into());
        assert!(rejects(vec![stale, planned("refs/heads/feature/x")])[1].is_some());
        // Two new refs of the same push collide with each other: the second is refused.
        let r = rejects(vec![planned("refs/heads/a"), planned("refs/heads/A/b")]);
        assert_eq!(r[0], None);
        assert!(
            r[1].as_deref()
                .is_some_and(|w| w.contains("refs/heads/a exists")),
            "{r:?}"
        );
    }

    fn planned(dst: &str) -> Planned {
        Planned {
            spec: PushSpec {
                force: false,
                src: "refs/heads/x".into(),
                dst: dst.into(),
            },
            new_oid: Some("1".repeat(40)),
            prev_oid: None,
            reject: None,
        }
    }

    /// CodeRabbit (PR #127): a batch where some refs landed and one failed rejects only the
    /// failed ref (and any not attempted after a sequential failure), so the push still reads
    /// back, reports and syncs the refs that landed; a batch where nothing landed is the
    /// push's error, as before (D-601).
    #[test]
    fn a_partly_landed_batch_rejects_only_the_refs_that_did_not_land() {
        let fail = || Err(forge_core::Error::Platform("refused".into()));
        let three = || {
            vec![
                planned("refs/heads/a"),
                planned("refs/heads/b"),
                planned("refs/heads/c"),
            ]
        };
        let rejects = |p: &[Planned]| p.iter().map(|p| p.reject.clone()).collect::<Vec<_>>();

        // Parallel (public): b failed, a and c landed.
        let mut p = three();
        settle_ref_writes(
            &mut p,
            &[0, 1, 2],
            vec![Ok("1".into()), fail(), Ok("3".into())],
            false,
        )
        .unwrap();
        let r = rejects(&p);
        assert!(r[0].is_none() && r[2].is_none(), "{r:?}");
        assert!(
            r[1].as_deref().is_some_and(|w| w.contains("refused")),
            "{r:?}"
        );

        // Sequential (private): a landed, b failed, c never attempted.
        let mut p = three();
        settle_ref_writes(&mut p, &[0, 1, 2], vec![Ok("1".into()), fail()], false).unwrap();
        let r = rejects(&p);
        assert!(r[0].is_none(), "{r:?}");
        assert!(r[1].as_deref().is_some_and(|w| w.contains("refused")));
        assert!(r[2]
            .as_deref()
            .is_some_and(|w| w.contains("earlier ref update")));

        // Nothing landed: the first failure is the push's error, naming its ref.
        let mut p = three();
        let err = settle_ref_writes(&mut p, &[0, 1, 2], vec![fail()], false).unwrap_err();
        assert!(
            format!("{err:#}").contains("writing ref update for refs/heads/a"),
            "{err:#}"
        );

        // Nothing landed in a batch written after one that did: each ref is rejected instead.
        let mut p = three();
        settle_ref_writes(&mut p, &[1, 2], vec![fail()], true).unwrap();
        let r = rejects(&p);
        assert!(r[0].is_none(), "{r:?}");
        assert!(r[1].as_deref().is_some_and(|w| w.contains("refused")));
        assert!(r[2]
            .as_deref()
            .is_some_and(|w| w.contains("earlier ref update")));

        // An already-rejected spec is not in `accepted` and keeps its own reason.
        let mut p = three();
        p[0].reject = Some("non-fast-forward".into());
        settle_ref_writes(&mut p, &[1, 2], vec![Ok("2".into()), fail()], false).unwrap();
        assert_eq!(p[0].reject.as_deref(), Some("non-fast-forward"));
        assert!(p[1].reject.is_none() && p[2].reject.is_some());

        // Everything landed: nothing rejected.
        let mut p = three();
        settle_ref_writes(
            &mut p,
            &[0, 1, 2],
            vec![Ok("1".into()), Ok("2".into()), Ok("3".into())],
            false,
        )
        .unwrap();
        assert!(rejects(&p).iter().all(Option::is_none));
    }

    /// CodeRabbit (PR #377): a new ref that only fits because the push deletes a ref it
    /// collides with waits for that deletion; other refs, and a new ref with no such
    /// collision, do not.
    #[test]
    fn a_new_ref_waits_for_the_deletion_that_makes_room_for_it() {
        use super::gated_creations;
        let deletion = |dst: &str| Planned {
            spec: PushSpec {
                force: false,
                src: String::new(),
                dst: dst.into(),
            },
            new_oid: None,
            prev_oid: Some("2".repeat(40)),
            reject: None,
        };
        let p = vec![
            deletion("refs/heads/feature"),
            planned("refs/heads/feature/x"),
            planned("refs/heads/other"),
            deletion("refs/heads/old"),
            planned("refs/heads/FEATURE"),
        ];
        assert_eq!(
            gated_creations(&p, &[0, 1, 2, 3, 4]),
            vec![(1, vec![0]), (4, vec![0])]
        );
        // A deletion the plan refused is not accepted, so nothing waits on it.
        assert!(gated_creations(&p, &[1, 2, 3, 4]).is_empty());
    }
    use forge_core::network::NetworkSettings;
    use forge_core::user_error::{codes, UserError};

    /// Review M-4: an incremental fetch whose wanted tips exist but whose history has a gap (a
    /// pruned object of a pack the record says is held) is NOT complete; the helper then
    /// fetches every pack. The connectivity walk runs for a plain fetch with wants.
    #[test]
    fn an_incremental_fetch_with_a_history_gap_refetches_everything() {
        use super::incremental_fetch_complete;
        let plain = crate::options::OptionState::default();
        let wants = vec!["a".repeat(40)];
        assert!(
            !incremental_fetch_complete(true, &plain, &wants, || true),
            "a gap"
        );
        assert!(incremental_fetch_complete(true, &plain, &wants, || false));
        assert!(
            !incremental_fetch_complete(false, &plain, &wants, || false),
            "a failed pass"
        );
        // No wants, or a filtered fetch (gaps are by design): no walk, complete.
        let walked = std::cell::Cell::new(false);
        assert!(incremental_fetch_complete(true, &plain, &[], || {
            walked.set(true);
            true
        }));
        assert!(!walked.get());
        let filtered = crate::options::OptionState {
            filter: Some("blob:none".into()),
            ..Default::default()
        };
        assert!(incremental_fetch_complete(true, &filtered, &wants, || true));
    }

    #[test]
    fn packs_recorded_only_where_no_reader_follows_get_the_move_them_fix() {
        // QW2-078: reseed from the members, IPFS gateways and storage status cannot help a
        // pack recorded only at a loopback address.
        let private = |h: &str| Unreadable {
            hash: h.repeat(64),
            error: format!(
                "io error: {}: its manifest records only 127.0.0.1:9000 (this machine or a \
                 private network: never followed from a manifest); S3 bucket byo (read only \
                 through a storage profile of yours for it)",
                forge_core::storage::read::NO_FOLLOWED_COPY
            ),
        };
        let u = packs_unreadable("OWNER/repo", true, &[private("a"), private("b")], 3, None);
        assert_eq!(u.code, "E503");
        assert_eq!(u.message, "clone incomplete: 2 packs unreadable");
        let cause = u.cause.clone().unwrap();
        // Each place once, for all the packs.
        assert_eq!(
            cause,
            format!(
                "2 of the repository's 3 packs: {}: they are recorded only at 127.0.0.1:9000 \
                 (this machine or a private network: never followed from a manifest); S3 bucket \
                 byo (read only through a storage profile of yours for it)",
                forge_core::storage::read::NO_FOLLOWED_COPY
            )
        );
        assert!(
            u.fix[0].contains("dg repack OWNER/repo --profile"),
            "{:?}",
            u.fix
        );
        assert!(u.fix[1].contains("your own storage"), "{:?}", u.fix);
        assert!(
            !u.fix.iter().any(|f| f.contains("ipfs_gateways")),
            "{:?}",
            u.fix
        );
        // QW4-062: a fork's parent's packs: the parent's maintainers reseed the parent.
        let u = packs_unreadable("FORKER/repo", true, &[private("a")], 2, Some("OWNER/repo"));
        assert!(
            u.fix[0]
                .contains("FORKER/repo is a fork, and these packs came from its parent OWNER/repo"),
            "{:?}",
            u.fix
        );
        assert!(
            u.fix[0].contains("`dg repack OWNER/repo --profile <profile>`"),
            "{:?}",
            u.fix
        );
        assert!(
            u.fix[0].contains("`dg repo fork OWNER/repo --name <new name>`"),
            "{:?}",
            u.fix
        );
        assert!(!u.fix[0].contains("FORKER/repo --"), "{:?}", u.fix);
    }

    #[test]
    fn unreadable_packs_the_history_needs_are_e503_with_the_reseed_fix() {
        // D-403: git's "remote did not send all necessary objects" was all a user saw.
        let gone = |h: &str| Unreadable {
            hash: h.repeat(64),
            error:
                "io error: no external copy verified (1 candidate(s)): https://m.example/p.pack: \
                    could not connect: Connection refused — every candidate was an IPFS gateway: …"
                    .into(),
        };
        let u = packs_unreadable("OWNER/repo", true, &[gone("a"), gone("b")], 6, None);
        assert_eq!(u.code, "E503");
        assert_eq!(u.exit_code(), 5);
        // The catalogue's wording (ux-dx-spec §7.3 example 6).
        assert_eq!(u.message, "clone incomplete: 2 packs unreadable");
        let cause = u.cause.clone().unwrap();
        assert!(
            cause.starts_with(
                "2 of the repository's 6 packs: pack aaaaaaaaaaaa…: no external copy verified"
            ),
            "{cause}"
        );
        assert!(
            cause.contains("m.example: could not connect: Connection refused"),
            "{cause}"
        );
        assert!(
            !cause.contains("/p.pack") && !cause.contains("io error"),
            "{cause}"
        );
        assert!(
            !cause.contains("every candidate"),
            "hint moved to the fix: {cause}"
        );
        assert!(
            u.fix[0].contains("dg reseed OWNER/repo --from-local"),
            "{:?}",
            u.fix
        );
        assert!(u.fix[1].contains("[read] ipfs_gateways"), "{:?}", u.fix);
        let many: Vec<_> = ["a", "b", "c", "d", "e"].iter().map(|h| gone(h)).collect();
        let u = packs_unreadable("OWNER/repo", false, &many, 5, None);
        assert_eq!(u.message, "fetch incomplete: 5 packs unreadable");
        assert!(u.cause.unwrap().ends_with("; and 2 more"));
        let u = packs_unreadable("OWNER/repo", true, &many[..1], 5, None);
        assert_eq!(u.message, "clone incomplete: 1 pack unreadable");
    }

    #[test]
    fn a_filtered_repack_failure_is_blamed_on_set_aside_packs_only_when_an_object_is_missing() {
        let missing = anyhow::anyhow!(
            "git pack-objects failed: fatal: bad tree object 08585692ce06452da6f82ae66b90d98b55536fca"
        );
        let other = anyhow::anyhow!(
            "git pack-objects failed: fatal: unable to create temporary file: No space left on device"
        );
        assert!(blames_set_aside_packs(true, &missing));
        // L4: an unrelated git failure keeps its own error, even with packs set aside.
        assert!(!blames_set_aside_packs(true, &other));
        // Nothing set aside: never blamed on packs.
        assert!(!blames_set_aside_packs(false, &missing));
    }

    /// A repository made public (private-repos.md §18.2): a pack its keys do not open is left
    /// out, and only a history that needs it fails, with E307 naming the pack.
    #[test]
    fn a_needed_pack_this_reader_cannot_open_is_e307() {
        use forge_core::repo::{SkipReason, Skipped};
        let repo = forge_core::scope::RepoRef {
            forge: forge_core::network::ForgeIds::test_forge(),
            repo_id: "R".into(),
            owner_id: "owner".into(),
            name: "repo".into(),
            visibility: forge_core::rules::v2::Visibility::Public,
        };
        let skipped = [
            Skipped {
                pack: [0xab; 32],
                why: SkipReason::NoKey { epoch: 0 },
            },
            Skipped {
                pack: [0xcd; 32],
                why: SkipReason::OtherFormat { version: 3 },
            },
        ];
        let u = skipped_packs_needed(&repo, true, &skipped);
        assert_eq!(u.code, "E307");
        assert_eq!(
            u.message,
            "clone incomplete: the history you asked for needs packs your keys don't open"
        );
        let cause = u.cause.clone().unwrap();
        assert!(
            cause.contains("pack abababababab of owner/repo is members-only"),
            "{cause}"
        );
        assert_eq!(
            u.note.as_deref(),
            Some("2 packs were left out; every other pack was read")
        );
        let later = skipped[1].error(&repo);
        assert!(
            later
                .message
                .contains("can't be opened by this version of Forge"),
            "{later}"
        );
    }

    #[test]
    fn a_needed_pack_hidden_by_the_late_content_rule_is_e510_with_a_fix() {
        let late = UserError::new(
            codes::LATE_CONTENT,
            "pack 0123456789ab was uploaded under an old key after the key was rotated",
        )
        .cause("its sealed header names epoch 1 and its uploader Xyz is no longer a member");
        let u = hidden_packs_needed("OWNER/repo", true, &[late.clone(), late]);
        assert_eq!(u.code, "E510");
        assert_eq!(u.exit_code(), 5);
        assert_eq!(
            u.message,
            "clone incomplete: 2 packs hidden by the late-content rule"
        );
        let cause = u.cause.clone().unwrap();
        assert!(cause.contains("uploaded under an old key"), "{cause}");
        assert!(cause.contains("no longer a member"), "{cause}");
        assert!(cause.ends_with("; and 1 more such pack"), "{cause}");
        // A removed uploader's pack opens again once they are a member (§8.2).
        assert!(u.fix[0].contains("dg collab add OWNER/repo"), "{:?}", u.fix);
        assert!(
            u.fix
                .last()
                .unwrap()
                .contains("dg repo keys status OWNER/repo"),
            "{:?}",
            u.fix
        );

        // Sealed under an earlier use of an epoch number: nobody can open it again.
        let earlier = UserError::new(
            codes::LATE_CONTENT,
            "pack 0123456789ab was sealed under an earlier use of key epoch 2",
        );
        let u = hidden_packs_needed("OWNER/repo", false, &[earlier]);
        assert_eq!(
            u.message,
            "fetch incomplete: 1 pack hidden by the late-content rule"
        );
        assert!(
            !u.fix.iter().any(|f| f.contains("collab add")),
            "{:?}",
            u.fix
        );
        assert!(u.fix[0].contains("push the branch again"), "{:?}", u.fix);
    }
    use forge_core::rules::RefState;

    fn resolved(oid: &str) -> RefState {
        RefState::Resolved {
            oid: oid.to_string(),
            author: "A".into(),
            created_at: 0,
        }
    }

    /// F-11: `git push --mirror` saw the `HEAD` symref in `list for-push`, had no local
    /// ref of that name, and deleted it on every run, a paid write that changed nothing.
    /// A push listing leaves `HEAD` out; a fetch listing still has it (clone checks it out).
    #[test]
    fn head_is_advertised_to_fetches_only() {
        let refs = vec![
            ("refs/heads/main".to_string(), resolved(&"a".repeat(40))),
            ("refs/tags/v1".to_string(), resolved(&"b".repeat(40))),
        ];
        let fetch = list_lines(&refs, "main", false);
        assert_eq!(fetch.last().unwrap(), "@refs/heads/main HEAD");
        let push = list_lines(&refs, "main", true);
        assert_eq!(push.len(), 2);
        assert!(push.iter().all(|l| !l.ends_with(" HEAD")), "{push:?}");
    }

    /// RC1 accepts `refs/heads/x.lock/y` (the contract's regex cannot refuse a middle `.lock`
    /// component), but git cannot hold it: it is not advertised, so a `--prune` / `--mirror`
    /// push never asks to delete it.
    #[test]
    fn a_ref_git_cannot_hold_is_not_advertised() {
        let refs = vec![
            ("refs/heads/main".to_string(), resolved(&"a".repeat(40))),
            ("refs/heads/x.lock/y".to_string(), resolved(&"b".repeat(40))),
        ];
        for for_push in [false, true] {
            let lines = list_lines(&refs, "main", for_push);
            assert!(lines.iter().all(|l| !l.contains("x.lock")), "{lines:?}");
        }
    }

    /// A push that names `HEAD` anyway (an explicit `:HEAD` or `HEAD:HEAD`) is answered
    /// without a write: a delete is a no-op `ok`, an update is refused.
    #[test]
    fn a_push_to_head_writes_nothing() {
        assert!(is_head("HEAD") && !is_head("refs/heads/HEAD"));
        let spec = |src: &str| PushSpec {
            force: false,
            src: src.into(),
            dst: "HEAD".into(),
        };
        assert_eq!(head_outcome(spec("")).wire(), "ok HEAD");
        assert!(head_outcome(spec("refs/heads/main"))
            .wire()
            .starts_with("error HEAD "));
    }

    /// A real one-commit history index of `main` in a scratch repository, and its tip (hex).
    fn scratch_history() -> (tempfile::TempDir, PushHistory, String) {
        let d = tempfile::TempDir::new().unwrap();
        let git = |args: &[&str]| {
            let out = std::process::Command::new("git")
                .arg("-C")
                .arg(d.path())
                .args(args)
                .env("GIT_AUTHOR_NAME", "t")
                .env("GIT_AUTHOR_EMAIL", "t@e.x")
                .env("GIT_COMMITTER_NAME", "t")
                .env("GIT_COMMITTER_EMAIL", "t@e.x")
                .env("GIT_CONFIG_GLOBAL", "/dev/null")
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "{}",
                String::from_utf8_lossy(&out.stderr)
            );
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        };
        git(&["init", "-q", "-b", "main"]);
        std::fs::write(d.path().join("a"), "1").unwrap();
        git(&["add", "-A"]);
        git(&["commit", "-q", "-m", "one"]);
        let tip = git(&["rev-parse", "HEAD"]);
        let oid = forge_core::pack::historyindex::parse_hex_oid(tip.as_bytes()).unwrap();
        let plan = forge_core::repo::HistoryPlan::fresh();
        let prepared = forge_core::repo::prepare_history_index(d.path(), oid, &plan)
            .unwrap()
            .unwrap();
        let history = PushHistory {
            prepared,
            branch: "refs/heads/main".into(),
        };
        (d, history, tip)
    }

    /// The cost guard prices a push's history as the artifacts it publishes, each its own
    /// manifest (the column index and the version lists): exactly what forge-core quotes for
    /// them, and more than one artifact of their combined size would cost.
    #[test]
    fn the_guard_prices_each_history_artifact() {
        let (_d, history, _tip) = scratch_history();
        let cost = history.prepared.cost();
        assert_eq!(
            cost.manifests(),
            2,
            "the column index and the version lists"
        );
        // Off Platform an artifact costs its manifest alone: two manifests, each a repository's
        // first of its kind, each carrying the targets' URIs.
        for external in [0, 1, 3] {
            let manifest =
                forge_core::cost::push_fees::history_index(0, false, external, false, true);
            assert_eq!(cost.credits(false, external, false), 2 * manifest);
        }
        for (sealed, external, platform) in [(false, 0, true), (true, 2, true), (false, 1, false)] {
            let as_one = forge_core::cost::push_fees::history_index(
                cost.plain_len(),
                sealed,
                external,
                platform,
                true,
            );
            assert!(cost.credits(sealed, external, platform) > as_one);
        }
        let fallback_free = forge_core::repo::HistoryCost::default();
        assert_eq!(
            (
                fallback_free.manifests(),
                fallback_free.credits(false, 1, true)
            ),
            (0, 0)
        );
    }

    /// Review H1: the history index is published only when the refs read after the push show
    /// the default branch at the tip it was computed for. A multi-ref push whose `main` update
    /// was rejected (non-fast-forward, a lost race) leaves `main` elsewhere: no index, even
    /// though the push's other refs landed.
    #[test]
    fn the_history_index_needs_the_default_branch_at_its_tip() {
        let (_d, history, tip) = scratch_history();
        let other = "c".repeat(40);
        // main landed at the tip (and a feature branch with it): publish.
        let landed = vec![
            ("refs/heads/main".to_string(), resolved(&tip)),
            ("refs/heads/feature".to_string(), resolved(&other)),
        ];
        assert!(history_tip_landed(&history, &landed));
        // main was rejected and still reads at its old tip; the feature branch landed.
        let rejected = vec![
            ("refs/heads/main".to_string(), resolved(&other)),
            ("refs/heads/feature".to_string(), resolved(&tip)),
        ];
        assert!(!history_tip_landed(&history, &rejected));
        // main diverged (a concurrent pusher) or is gone: no index either.
        let diverged = vec![("refs/heads/main".to_string(), RefState::Unborn)];
        assert!(!history_tip_landed(&history, &diverged));
        assert!(!history_tip_landed(&history, &[]));
    }

    /// Review H2: the default branch forge-import names is honoured only in a push it spawned.
    #[test]
    fn the_default_branch_hint_needs_forge_import() {
        let _env = ENV_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let saved: Vec<_> = ["DASH_FORGE_DEFAULT_BRANCH", "DASH_FORGE_SPAWNED_BY"]
            .iter()
            .map(|k| (*k, std::env::var_os(k)))
            .collect();
        // ENV_LOCK serializes every test in this binary that touches these variables.
        std::env::set_var("DASH_FORGE_DEFAULT_BRANCH", "develop");
        std::env::remove_var("DASH_FORGE_SPAWNED_BY");
        assert_eq!(default_branch_hint(), None);
        std::env::set_var("DASH_FORGE_SPAWNED_BY", "forge-import");
        assert_eq!(default_branch_hint().as_deref(), Some("develop"));
        for (k, v) in saved {
            match v {
                Some(v) => std::env::set_var(k, v),
                None => std::env::remove_var(k),
            }
        }
    }

    /// Serializes tests that change process environment variables.
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// F-2: building the helper (what `git clone dash://…` does first) reads no identity, so
    /// `list` and `fetch` of a public repo work with no key source at all. It used to resolve
    /// the key path up front (E301 with no HOME) and then load the identity file before
    /// connecting (E301 with no file). No other test in this binary reads these variables;
    /// ENV_LOCK serializes any that ever does.
    #[test]
    fn the_helper_starts_without_any_identity() {
        let url = crate::url::DashUrl::parse(
            "dash://9cBMULwtQUMtxhBkgaTKb4tJtoczd8TEQ8gmiroDWf4F/sqa-anon",
        )
        .unwrap();
        let _env = ENV_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let saved: Vec<_> = ["DASH_FORGE_KEY", "HOME", "XDG_CONFIG_HOME"]
            .iter()
            .map(|k| (*k, std::env::var_os(k)))
            .collect();
        for (k, _) in &saved {
            std::env::remove_var(k);
        }
        let built = super::Helper::new(url, None);
        for (k, v) in saved {
            if let Some(v) = v {
                std::env::set_var(k, v);
            }
        }
        let helper = built.expect("no identity is needed to start a read");
        assert!(helper.conn.is_none(), "nothing is loaded before a command");
    }

    #[test]
    fn an_archived_repo_refuses_the_push_and_names_the_override() {
        let d = archived_refusal("owner/repo");
        assert_eq!((d.error.code, d.error.exit_code()), ("E606", 6));
        assert!(d.refs.is_empty(), "an archived repo refuses every ref");
        let text = d.error.to_json().to_string();
        assert!(text.contains("dg repo unarchive owner/repo"), "{text}");
        assert!(text.contains("-o allow-archived"), "{text}");
        assert!(text.contains("checked before building"), "{text}");
    }

    #[test]
    fn a_writer_on_a_protected_ref_is_told_it_needs_maintainer() {
        let d = protected_denied("owner/repo", "me", &["refs/heads/main"]);
        let text = d.error.render("dash: ", false);
        assert!(
            text.contains("only maintainers of owner/repo can update refs/heads/main"),
            "{text}"
        );
        assert!(text.contains("--role maintainer"), "{text}");
        // Local refusal, not a consensus verdict.
        assert!(text.contains("checked before building or paying"), "{text}");
    }

    #[test]
    fn a_non_member_is_pointed_at_collab_add() {
        let d = write_denied("owner/repo", "me");
        assert_eq!((d.error.code, d.error.exit_code()), ("E601", 6));
        let text = d.error.render("dash: ", false);
        assert!(
            text.starts_with("dash: error: push rejected: you are not a writer of owner/repo"),
            "{text}"
        );
        assert!(
            text.contains("dg collab add owner/repo me --role writer"),
            "{text}"
        );
        // Must not read as the consensus error, or e2e scenario 04 could not tell a local
        // refusal from a network verdict.
        assert!(
            !text.contains("40120") && !text.contains("consensus refused"),
            "{text}"
        );
        assert!(text.lines().all(|l| l.starts_with("dash: ")), "{text}");
    }

    #[test]
    fn a_triage_member_or_reader_is_told_what_the_role_allows() {
        use forge_core::rules::v2::{Role, Visibility};
        let repo = forge_core::scope::RepoRef {
            forge: forge_core::network::ForgeIds::test_forge(),
            repo_id: "R".into(),
            owner_id: "owner".into(),
            name: "repo".into(),
            visibility: Visibility::Private,
        };
        let tri = role_denied(&repo, "me", Role::Triage);
        assert_eq!(tri.wire, "triage members cannot push");
        let text = tri.error.render("dash: ", false);
        assert!(
            text.contains("push rejected: you are a triage member of owner/repo, not a writer"),
            "{text}"
        );
        assert!(
            text.contains("triage can close, reopen and lock") && text.contains("cannot push"),
            "{text}"
        );
        assert!(
            text.contains("dg collab add owner/repo me --role writer"),
            "{text}"
        );
        let rdr = role_denied(&repo, "me", Role::Reader);
        assert_eq!(rdr.wire, "readers cannot push");
        let text = rdr.error.render("dash: ", false);
        assert!(text.contains("you are a reader of owner/repo"), "{text}");
    }

    fn git_devnet() -> NetworkSettings {
        NetworkSettings::from_git_config(|k| match k {
            "dash.network" => Some("devnet".into()),
            "dash.devnetName" => Some("moutai".into()),
            "dash.dapiAddresses" => Some("10.0.0.1,10.0.0.2".into()),
            _ => None,
        })
    }

    /// The helper's layers with `dg`'s saved default `dg`, resolved.
    fn network_key(env: NetworkSettings, git: NetworkSettings, dg: NetworkSettings) -> String {
        let s = NetworkSettings::git_helper_layers(env, git, || Ok(dg)).unwrap();
        resolve_network(s).unwrap().network.key()
    }

    fn dg_saved(network: &str) -> NetworkSettings {
        NetworkSettings {
            network: Some(network.into()),
            ..Default::default()
        }
    }

    #[test]
    fn git_config_selects_a_devnet_when_the_env_is_silent() {
        let none = NetworkSettings::default;
        assert_eq!(network_key(none(), git_devnet(), none()), "devnet-moutai");
        // ... and over the network dg saved.
        assert_eq!(
            network_key(none(), git_devnet(), dg_saved("mainnet")),
            "devnet-moutai"
        );
    }

    #[test]
    fn the_env_beats_git_config() {
        let t = network_key(
            dg_saved("testnet"),
            git_devnet(),
            NetworkSettings::default(),
        );
        assert_eq!(t, "testnet");
    }

    #[test]
    fn the_network_dg_saved_applies_when_env_and_git_config_are_silent() {
        // L-03: after `dg auth new --devnet-name moutai`, `git push` resolved testnet.
        let none = NetworkSettings::default;
        let moutai = NetworkSettings {
            network: Some("devnet".into()),
            devnet_name: Some("moutai".into()),
            ..Default::default()
        };
        assert_eq!(network_key(none(), none(), moutai), "devnet-moutai");
    }

    #[test]
    fn nothing_configured_is_testnet() {
        let none = NetworkSettings::default;
        assert_eq!(network_key(none(), none(), none()), "testnet");
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

    /// D-601: the sealed pack a private push kept outlives the push until its refs land, and
    /// only that pack's is dropped then (another pack's pending retry keeps its own).
    #[test]
    fn landed_refs_drop_only_the_pushed_packs_sealed_bytes() {
        let tmp = tempfile::tempdir().unwrap();
        let (ours, other) = (tmp.path().join("R1-aa.pack"), tmp.path().join("R1-bb.pack"));
        std::fs::write(&ours, b"x").unwrap();
        std::fs::write(&other, b"y").unwrap();
        forget_sealed(Some(&ours));
        assert!(!ours.exists() && other.exists());
        // A public push kept none; a missing file is not an error.
        forget_sealed(None);
        forget_sealed(Some(&ours));
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

    /// A push asks whether a pack is already stored, and whether its index is, from the copies
    /// the repository's manifests record, never a pack mirror (source check): a mirror anyone
    /// may record and delete must not let a push skip storing its pack or its index.
    /// `is_pack_indexed` reading recorded copies only is pinned in forge-core
    /// (`only_the_read_path_reaches_pack_mirrors`).
    #[test]
    fn a_push_never_takes_a_pack_mirror_as_stored() {
        let src = include_str!("helper.rs");
        let body = |from: &str| {
            let at = src.find(from).unwrap_or_else(|| panic!("{from}"));
            &src[at..at + src[at..].find("\n}\n").expect("its end")]
        };
        let stored = body("async fn confirm_existing_manifest");
        assert!(stored.contains(".fetch_best_copy(ctx.repo"), "{stored}");
        let indexed = body("async fn missing_index(");
        assert!(indexed.contains(".is_pack_indexed(ctx.repo"), "{indexed}");
        for b in [stored, indexed] {
            assert!(!b.contains("mirror("), "{b}");
        }
    }
}
