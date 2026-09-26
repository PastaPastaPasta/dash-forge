//! The daemon: discover the repos with hooks addressed to this relay, poll their documents,
//! translate, and hand events to the delivery workers (PRD 05). Stateless across restarts:
//! cursors live in memory and are re-baselined on startup ([`crate::ingest`]).
//!
//! Each cycle:
//! 1. every `refresh_cycles` cycles, re-run discovery ([`crate::subscriptions`]) and resync the
//!    per-hook delivery workers ([`crate::deliver::Dispatcher`]);
//! 2. for each repo, read its streams past their cursors and enqueue each new document's event.
//!    Enqueueing never waits for a receiver, so a slow or hostile hook cannot stall polling.
//!    Each repo also has a time budget per cycle ([`REPO_BUDGET`]): a repo whose reads run
//!    past it stops for this cycle and resumes next time from its cursors.
//!
//! **Baselines.** A repo is first read from "now": at startup with `Tail` (plus `--lookback`),
//! later with `Since(max(earliest hook $createdAt, relay start))`, so a repo that shows up
//! late (a failed first read, a maintainer restored, a hook re-enabled) never replays history
//! from before this relay started. A repo that drops out of discovery keeps a marker of where
//! it stopped (`resume_at`), and resumes from there when it comes back.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;
use std::time::{Duration, Instant};

use forge_core::platform::{
    decode_identifier, FetchedDocument, FieldValue, LoadedContract, PlatformClient, QueryFilter,
    QueryOrder,
};
use forge_core::refs::ref_update_from_doc;
use forge_core::repo::config_doc;
use forge_core::rules::{self, v2::Visibility, ConfigDoc};
use forge_core::scope::RepoRef;

use crate::config::RelayConfig;
use crate::deliver::{DeliverConfig, Deliverer, Dispatcher};
use crate::error::{RelayError, Result};
use crate::ingest::{
    self, poll_stream, Baseline, Cursor, LiveStream, TargetInfo, DOC_AUTHOR_EVENT, DOC_CHECK_RUN,
    DOC_COMMENT, DOC_EVENT, DOC_ISSUE, DOC_PATCH, DOC_PROTECTED_REF_UPDATE, DOC_REF_UPDATE,
    DOC_RELEASE, DOC_REVIEW,
};
use crate::payload::{RepositoryMeta, WebhookEvent};
use crate::subscriptions::{self, RelayIdentity, WebhookSub};

/// Wall-clock budget for one repo's reads in one cycle.
const REPO_BUDGET: Duration = Duration::from_secs(20);

/// Issues/PRs whose comment and review streams are read: those open (not closed by a seen
/// event) or active within this window. Comments on a thread quiet for longer are missed
/// until the thread shows activity again (a new event or comment reported for it).
const THREAD_ACTIVE_WINDOW_MS: u64 = 7 * 24 * 3600 * 1000;

/// At most this many per-target (comment/review) and per-head (checkRun) streams per repo per
/// cycle, most recently active first.
const MAX_THREAD_STREAMS: usize = 50;

/// At most this many head oids tracked per repo for `checkRun` streams (newest kept).
const MAX_HEADS: usize = 50;

/// The two forge-v2 contracts.
struct Contracts {
    core: LoadedContract,
    collab: LoadedContract,
}

/// One served repository and its stream cursors.
struct RepoState {
    meta: RepositoryMeta,
    /// Whether any hook wants each event kind (the costly streams are read only if so).
    wants: BTreeSet<&'static str>,
    /// Where streams that did not exist yet start.
    baseline: Baseline,
    /// Cursor per stream key (`refUpdate`, `comment:<targetId>`, `checkRun:<oid>`, ...).
    cursors: BTreeMap<String, Cursor>,
    /// Issues and PRs by `$id` (for event/comment/review translation).
    targets: BTreeMap<String, TargetInfo>,
    /// Closed targets (a close or merge seen; a reopen removes).
    closed: BTreeSet<String>,
    /// Head oids (hex) → when seen: the `checkRun` streams.
    heads: BTreeMap<String, u64>,
    /// The repo's `config` history (for protected-ref routing).
    configs: Vec<ConfigDoc>,
    /// The newest `$createdAt` read on any stream, for resuming after a gap.
    high_water: u64,
}

/// Everything the loop holds between cycles.
struct Relay {
    client: Arc<PlatformClient>,
    contracts: Contracts,
    identity: Option<RelayIdentity>,
    dispatcher: Dispatcher,
    /// `--repos`, resolved to repo ids (empty = every repo with a hook).
    repo_filter: BTreeSet<String>,
    /// Static webhooks with their repo resolved.
    statics: Vec<WebhookSub>,
    repos: BTreeMap<String, RepoState>,
    /// Hooks per repo from the last discovery.
    subs: Vec<WebhookSub>,
    /// Repos that were served and dropped out: where to resume if they come back.
    resume_at: BTreeMap<String, u64>,
    /// When this relay started (ms since the epoch).
    started_ms: u64,
    cfg: RelayConfig,
}

/// Milliseconds since the epoch.
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

/// Run the relay daemon until the process is stopped.
pub async fn run(cfg: RelayConfig) -> Result<()> {
    let forge = cfg.target.v2.clone().ok_or_else(|| {
        RelayError::Config(format!(
            "forge-v2 is not deployed on {}; the relay serves forge-v2 repositories only \
             (v1 repositories are read-only and have no webhooks)",
            cfg.target.network
        ))
    })?;
    let client = Arc::new(PlatformClient::connect(cfg.target.clone()).await?);
    let contracts = Contracts {
        core: client.fetch_contract(&forge.core).await?,
        collab: client.fetch_contract(&forge.collab).await?,
    };

    let identity = match &cfg.identity_path {
        Some(path) if cfg.use_platform_webhooks => {
            let id = RelayIdentity::load(&client, path, &forge.collab).await?;
            tracing::info!(relay_identity = %id.id, encryption_keys = ?id.key_ids(), "loaded relay identity");
            Some(id)
        }
        _ => {
            tracing::warn!("no relay identity (or use-platform-webhooks = false): serving static webhooks only");
            None
        }
    };

    let mut repo_filter = BTreeSet::new();
    for r in &cfg.repos {
        repo_filter.insert(resolve_repo(&client, r).await?.id().to_string());
    }
    let mut statics = Vec::new();
    for w in &cfg.static_webhooks {
        let repo = resolve_repo(&client, &w.repo).await?;
        statics.push(subscriptions::static_subscription(repo.id(), w));
    }
    if identity.is_none() && statics.is_empty() {
        return Err(RelayError::Config(
            "nothing to serve: pass --identity <relay key file> (webhooks come from Platform) \
             or add [[webhook]] blocks to the config"
                .into(),
        ));
    }

    if let Some(addr) = cfg.listen.clone() {
        tokio::spawn(async move {
            if let Err(e) = crate::health::serve(&addr).await {
                tracing::error!(error = %e, "health listener stopped");
            }
        });
    }

    let mut relay = Relay {
        client,
        contracts,
        identity,
        dispatcher: Dispatcher::new(Deliverer::new(DeliverConfig {
            allow_private: cfg.allow_private,
            ..Default::default()
        })),
        repo_filter,
        statics,
        repos: BTreeMap::new(),
        subs: Vec::new(),
        resume_at: BTreeMap::new(),
        started_ms: now_ms(),
        cfg,
    };
    tracing::info!(
        network = %relay.cfg.target.network,
        poll_interval_s = relay.cfg.poll_interval.as_secs(),
        refresh_cycles = relay.cfg.refresh_cycles,
        allow_private = relay.cfg.allow_private,
        "relay started"
    );

    let mut ticker = tokio::time::interval(relay.cfg.poll_interval);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut cycle: u64 = 0;
    loop {
        ticker.tick().await;
        if cycle.is_multiple_of(relay.cfg.refresh_cycles) {
            if let Err(e) = relay.refresh(cycle == 0).await {
                tracing::warn!(error = %e, "webhook discovery failed; keeping the current set");
            }
        }
        cycle = cycle.wrapping_add(1);
        let ids: Vec<String> = relay.repos.keys().cloned().collect();
        for id in ids {
            let deadline = Instant::now() + REPO_BUDGET;
            if tokio::time::timeout(REPO_BUDGET, relay.poll_repo(&id, deadline))
                .await
                .is_err()
            {
                tracing::warn!(repo = %id, budget_s = REPO_BUDGET.as_secs(), "repo ran past its time budget; resuming next cycle");
            }
        }
    }
}

/// `owner/name` or a repo id → the forge-v2 repo.
async fn resolve_repo(client: &PlatformClient, r: &str) -> Result<RepoRef> {
    let repo = match r.split_once('/') {
        Some((owner, name)) => forge_core::resolve::resolve_named(client, owner, name).await?,
        None => forge_core::resolve::resolve_id(client, r).await?,
    };
    if repo.is_v1() {
        return Err(RelayError::Config(format!(
            "{r} is a forge-v1 repository; the relay serves forge-v2 repositories only"
        )));
    }
    Ok(repo)
}

/// `repoId == repo_id`, the pinned prefix of every repo-scoped stream.
fn repo_filter(repo_id: &str) -> Result<QueryFilter> {
    Ok(QueryFilter::eq(
        "repoId",
        FieldValue::identifier(decode_identifier(repo_id)?),
    ))
}

/// The baseline of a repo that starts being served now. See the module docs.
fn baseline_for(
    startup: bool,
    lookback: u32,
    earliest_hook: u64,
    relay_start: u64,
    resume: Option<u64>,
) -> Baseline {
    match resume {
        Some(t) => Baseline::Since(t),
        None if startup => Baseline::Tail { lookback },
        None => Baseline::Since(earliest_hook.max(relay_start)),
    }
}

impl Relay {
    /// Re-run discovery, reconcile the served repos with it, and resync the delivery workers.
    async fn refresh(&mut self, startup: bool) -> Result<()> {
        let mut subs = self.statics.clone();
        let mut failed = BTreeSet::new();
        if let Some(identity) = &self.identity {
            let found = subscriptions::platform_subscriptions(
                &self.client,
                identity,
                &self.contracts.collab.id(),
                &self.repo_filter,
            )
            .await?;
            subs.extend(found.subs);
            failed = found.failed;
        }
        // A repo whose hooks could not be read this pass keeps its previous Platform hooks.
        subs.extend(
            self.subs
                .iter()
                .filter(|s| failed.contains(&s.repo_id) && s.document_id.is_some())
                .cloned(),
        );
        let wanted = subscriptions::repos_of(&subs);
        let before: BTreeSet<String> = self.repos.keys().cloned().collect();

        for (id, state) in &self.repos {
            if !wanted.contains_key(id) {
                self.resume_at.insert(id.clone(), state.high_water);
            }
        }
        self.repos.retain(|id, _| wanted.contains_key(id));
        for (repo_id, earliest) in &wanted {
            if !self.repos.contains_key(repo_id) {
                let baseline = baseline_for(
                    startup,
                    self.cfg.lookback,
                    *earliest,
                    self.started_ms,
                    self.resume_at.get(repo_id).copied(),
                );
                match self.init_repo(repo_id, baseline).await {
                    Ok(state) => {
                        self.resume_at.remove(repo_id);
                        self.repos.insert(repo_id.clone(), state);
                    }
                    Err(e) => {
                        tracing::warn!(repo = %repo_id, error = %e, "cannot serve repo this cycle");
                    }
                }
            }
            if let Some(state) = self.repos.get_mut(repo_id) {
                state.wants = ALL_EVENTS
                    .iter()
                    .copied()
                    .filter(|e| subs.iter().any(|s| &s.repo_id == repo_id && s.wants(e)))
                    .collect();
            }
        }
        subs.retain(|s| self.repos.contains_key(&s.repo_id));
        self.dispatcher.sync(&subs);
        self.subs = subs;

        let after: BTreeSet<String> = self.repos.keys().cloned().collect();
        if before != after || startup {
            tracing::info!(
                repos = after.len(),
                hooks = self.subs.len(),
                added = ?after.difference(&before).collect::<Vec<_>>(),
                removed = ?before.difference(&after).collect::<Vec<_>>(),
                "webhook subscriptions refreshed"
            );
        }
        Ok(())
    }

    /// Resolve a repo's metadata, config history, issue/PR index and open PR heads.
    async fn init_repo(&self, repo_id: &str, baseline: Baseline) -> Result<RepoState> {
        let repo = forge_core::resolve::resolve_id(&self.client, repo_id).await?;
        let RepoRef::V2 {
            owner_id,
            name,
            visibility,
            ..
        } = &repo
        else {
            return Err(RelayError::Config(format!(
                "{repo_id} is not a forge-v2 repo"
            )));
        };
        if *visibility == Visibility::Private {
            // A private repo's content is encrypted to its members; the relay is not one.
            return Err(RelayError::Config(format!(
                "{repo_id} is a private repository; the relay does not serve private repositories"
            )));
        }
        let rf = repo_filter(repo_id)?;
        let all = |contract: &LoadedContract, doc_type: &'static str| {
            let rf = rf.clone();
            let contract = contract.clone();
            let client = Arc::clone(&self.client);
            async move {
                client
                    .query_all_documents(
                        &contract,
                        doc_type,
                        &[rf],
                        &[QueryOrder::asc("$createdAt")],
                    )
                    .await
            }
        };
        let config_docs = all(&self.contracts.core, "config").await?;
        let configs: Vec<ConfigDoc> = config_docs.iter().map(config_doc).collect();
        let repo_doc = self
            .client
            .fetch_document(&self.contracts.core, "repo", repo_id)
            .await?;
        // The newest config's default branch, else the repo document's.
        let default_branch = config_docs
            .iter()
            .rev()
            .chain(repo_doc.as_ref())
            .find_map(|d| d.field_str("defaultBranch"))
            .map_or_else(
                || "main".to_string(),
                |b| b.trim_start_matches("refs/heads/").to_string(),
            );

        // Every existing issue and PR, so events on old threads translate. Their comment and
        // review streams start where the repo's streams do; open PR heads seed `heads`.
        let mut targets = BTreeMap::new();
        let mut heads = BTreeMap::new();
        for (doc_type, is_pr) in [(DOC_ISSUE, false), (DOC_PATCH, true)] {
            for d in all(&self.contracts.collab, doc_type).await? {
                let t = if is_pr {
                    TargetInfo::from_patch(&d, baseline)
                } else {
                    TargetInfo::from_issue(&d, baseline)
                };
                if is_pr && !t.head_oid.is_empty() {
                    heads.insert(t.head_oid.clone(), t.last_activity);
                }
                targets.insert(d.id.clone(), t);
            }
        }
        tracing::info!(repo = %repo_id, name = %name, owner = %owner_id, targets = targets.len(), ?baseline, "serving repo");
        let mut state = RepoState {
            meta: RepositoryMeta {
                repo_id: repo_id.to_string(),
                owner_id: owner_id.clone(),
                name: name.clone(),
                default_branch,
                web_base_url: self.cfg.web_base_url.clone(),
            },
            wants: BTreeSet::new(),
            baseline,
            cursors: BTreeMap::new(),
            targets,
            closed: BTreeSet::new(),
            heads,
            configs,
            high_water: match baseline {
                Baseline::Since(t) => t,
                _ => now_ms(),
            },
        };
        prune_heads(&mut state.heads);
        Ok(state)
    }

    /// Read one stream of `repo_id` past its cursor, committing the cursor only on success.
    async fn stream(
        &mut self,
        repo_id: &str,
        key: String,
        doc_type: &str,
        collab: bool,
        prefix: Vec<QueryFilter>,
        baseline: Baseline,
    ) -> Vec<FetchedDocument> {
        let contract = if collab {
            &self.contracts.collab
        } else {
            &self.contracts.core
        };
        let Some(state) = self.repos.get_mut(repo_id) else {
            return Vec::new();
        };
        let mut cursor = state
            .cursors
            .get(&key)
            .cloned()
            .unwrap_or_else(|| Cursor::new(baseline));
        let source = LiveStream {
            client: &self.client,
            contract,
            doc_type,
            prefix: &prefix,
        };
        match poll_stream(&source, &mut cursor).await {
            Ok(docs) => {
                state.cursors.insert(key, cursor);
                if let Some(t) = docs.iter().filter_map(|d| d.created_at).max() {
                    state.high_water = state.high_water.max(t);
                }
                docs
            }
            Err(e) => {
                tracing::warn!(repo = %repo_id, stream = %key, error = %e, "stream read failed; retrying next cycle");
                Vec::new()
            }
        }
    }

    /// A repo-scoped stream (`repoId == R` on an index ending in `$createdAt`), keyed by type.
    async fn repo_stream(
        &mut self,
        repo_id: &str,
        doc_type: &str,
        collab: bool,
    ) -> Vec<FetchedDocument> {
        let (Ok(rf), Some(base)) = (
            repo_filter(repo_id),
            self.repos.get(repo_id).map(|s| s.baseline),
        ) else {
            return Vec::new();
        };
        self.stream(repo_id, doc_type.into(), doc_type, collab, vec![rf], base)
            .await
    }

    /// One cycle for one repo. Stops early (resuming next cycle) past `deadline`.
    async fn poll_repo(&mut self, repo_id: &str, deadline: Instant) {
        let Ok(rf) = repo_filter(repo_id) else { return };

        // Config first, so a push is judged by the patterns in force when it landed.
        for d in self.repo_stream(repo_id, "config", false).await {
            if let Some(s) = self.repos.get_mut(repo_id) {
                s.configs.push(config_doc(&d));
            }
        }

        // Pushes (both ref-update types), valid by forge's routing rule only.
        for (doc_type, protected) in [(DOC_REF_UPDATE, false), (DOC_PROTECTED_REF_UPDATE, true)] {
            for d in &self.repo_stream(repo_id, doc_type, false).await {
                let Some(s) = self.repos.get_mut(repo_id) else {
                    return;
                };
                if !ingest::ref_update_is_valid(d, protected, &s.configs) {
                    tracing::debug!(repo = %repo_id, source = %d.id, "ref update is inert by the protected-ref rule; not reported");
                    continue;
                }
                if !ingest::is_ref_deletion(d) {
                    if let Some(oid) = d.field_hex("newOid") {
                        s.heads.insert(oid, d.created_at.unwrap_or(0));
                        prune_heads(&mut s.heads);
                    }
                }
                emit(
                    &self.dispatcher,
                    repo_id,
                    ingest::translate_ref_update(&s.meta, d),
                );
            }
        }
        for d in &self.repo_stream(repo_id, DOC_RELEASE, false).await {
            let event = self
                .repos
                .get(repo_id)
                .and_then(|s| ingest::translate_release(&s.meta, d));
            emit(&self.dispatcher, repo_id, event);
        }

        // New issues and PRs: their comment/review streams start at the beginning.
        for (doc_type, is_pr) in [(DOC_ISSUE, false), (DOC_PATCH, true)] {
            for d in &self.repo_stream(repo_id, doc_type, true).await {
                let Some(s) = self.repos.get_mut(repo_id) else {
                    return;
                };
                let (t, event) = if is_pr {
                    (
                        TargetInfo::from_patch(d, Baseline::Beginning),
                        ingest::translate_patch(&s.meta, d),
                    )
                } else {
                    (
                        TargetInfo::from_issue(d, Baseline::Beginning),
                        ingest::translate_issue(&s.meta, d),
                    )
                };
                if is_pr && !t.head_oid.is_empty() {
                    s.heads.insert(t.head_oid.clone(), t.last_activity);
                    prune_heads(&mut s.heads);
                }
                s.targets.insert(d.id.clone(), t);
                emit(&self.dispatcher, repo_id, event);
            }
        }

        // State changes by members and by authors (the repo feed of both types).
        for doc_type in [DOC_EVENT, DOC_AUTHOR_EVENT] {
            for d in &self.repo_stream(repo_id, doc_type, true).await {
                let verified = self.merge_verified(repo_id, d).await;
                let Some(s) = self.repos.get_mut(repo_id) else {
                    return;
                };
                note_activity(s, d);
                let event = ingest::translate_event(&s.meta, d, &s.targets, verified);
                emit(&self.dispatcher, repo_id, event);
            }
        }

        if Instant::now() < deadline {
            self.poll_threads(repo_id, deadline).await;
        }
        if Instant::now() < deadline {
            self.poll_check_runs(repo_id, &rf, deadline).await;
        }
    }

    /// Whether a merge event's `oid` was the tip of a valid update of the PR's base ref (see
    /// [`ingest::translate_event`]). `true` for other kinds (nothing to verify).
    async fn merge_verified(&self, repo_id: &str, d: &FetchedDocument) -> bool {
        if d.field_u64("kind") != Some(3) {
            return true;
        }
        let (Some(state), Some(target), Some(oid)) = (
            self.repos.get(repo_id),
            d.field_bytes32("targetId")
                .map(forge_core::platform::encode_identifier),
            d.field_hex("oid"),
        ) else {
            return false;
        };
        let Some(base_hash) = state
            .targets
            .get(&target)
            .and_then(|t| hex::decode(&t.base_ref_hash).ok())
            .and_then(|b| <[u8; 32]>::try_from(b).ok())
        else {
            return false;
        };
        let hash_hex = hex::encode(base_hash);
        let mut valid_tips = Vec::new();
        for (doc_type, protected) in [(DOC_REF_UPDATE, false), (DOC_PROTECTED_REF_UPDATE, true)] {
            let filters = [
                QueryFilter::eq(
                    "repoId",
                    FieldValue::identifier(match decode_identifier(repo_id) {
                        Ok(b) => b,
                        Err(_) => return false,
                    }),
                ),
                QueryFilter::eq("refNameHash", FieldValue::bytes32(base_hash)),
            ];
            match self
                .client
                .query_all_documents(
                    &self.contracts.core,
                    doc_type,
                    &filters,
                    &[QueryOrder::asc("$createdAt")],
                )
                .await
            {
                Ok(docs) => valid_tips.extend(
                    docs.iter()
                        .map(|u| ref_update_from_doc(u, &hash_hex, protected))
                        .filter(|u| rules::is_update_valid(u, &state.configs))
                        .map(|u| u.new_oid),
                ),
                Err(e) => {
                    tracing::warn!(repo = %repo_id, error = %e, "cannot read the base ref to verify a merge; reporting it unverified");
                    return false;
                }
            }
        }
        valid_tips.iter().any(|t| t == &oid)
    }

    /// Comments (per issue/PR) and reviews (per PR), for open or recently active threads only,
    /// most recently active first, at most [`MAX_THREAD_STREAMS`].
    async fn poll_threads(&mut self, repo_id: &str, deadline: Instant) {
        let Some(s) = self.repos.get(repo_id) else {
            return;
        };
        let comments = s.wants.contains("issue_comment");
        let reviews = s.wants.contains("pull_request_review");
        if !comments && !reviews {
            return;
        }
        let cutoff = now_ms().saturating_sub(THREAD_ACTIVE_WINDOW_MS);
        let mut live: Vec<(String, bool, Baseline, u64)> = s
            .targets
            .iter()
            .filter(|(id, t)| !s.closed.contains(*id) || t.last_activity >= cutoff)
            .map(|(id, t)| (id.clone(), t.is_pr, t.baseline, t.last_activity))
            .collect();
        live.sort_by_key(|t| std::cmp::Reverse(t.3));
        live.truncate(MAX_THREAD_STREAMS);
        for (tid, is_pr, tbase, _) in live {
            if Instant::now() >= deadline {
                return;
            }
            let Ok(bytes) = decode_identifier(&tid) else {
                continue;
            };
            let mut docs = Vec::new();
            if comments {
                let filter = vec![QueryFilter::eq("targetId", FieldValue::identifier(bytes))];
                docs.extend(
                    self.stream(
                        repo_id,
                        format!("{DOC_COMMENT}:{tid}"),
                        DOC_COMMENT,
                        true,
                        filter,
                        tbase,
                    )
                    .await
                    .into_iter()
                    .map(|d| (d, false)),
                );
            }
            if is_pr && reviews {
                let filter = vec![QueryFilter::eq("patchId", FieldValue::identifier(bytes))];
                docs.extend(
                    self.stream(
                        repo_id,
                        format!("{DOC_REVIEW}:{tid}"),
                        DOC_REVIEW,
                        true,
                        filter,
                        tbase,
                    )
                    .await
                    .into_iter()
                    .map(|d| (d, true)),
                );
            }
            let Some(s) = self.repos.get_mut(repo_id) else {
                return;
            };
            for (d, is_review) in docs {
                if let Some(t) = s.targets.get_mut(&tid) {
                    t.last_activity = t.last_activity.max(d.created_at.unwrap_or(0));
                }
                let event = if is_review {
                    ingest::translate_review(&s.meta, &d, &s.targets)
                } else {
                    ingest::translate_comment(&s.meta, &d, &s.targets)
                };
                emit(&self.dispatcher, repo_id, event);
            }
        }
    }

    /// Check runs, per head oid seen on a push or PR (the newest [`MAX_HEADS`]). New
    /// `checkRun` documents only: a run updated in place (status progression) is not
    /// observed, because the index is keyed on `$createdAt`.
    async fn poll_check_runs(&mut self, repo_id: &str, rf: &QueryFilter, deadline: Instant) {
        let Some(s) = self.repos.get(repo_id) else {
            return;
        };
        if !s.wants.contains("check_run") {
            return;
        }
        let heads: Vec<String> = s.heads.keys().cloned().collect();
        for oid in heads {
            if Instant::now() >= deadline {
                return;
            }
            let Ok(bytes) = hex::decode(&oid) else {
                continue;
            };
            let filter = vec![
                rf.clone(),
                QueryFilter::eq("headOid", FieldValue::bytes(bytes)),
            ];
            // A head's runs are all new once the head itself was seen.
            for d in &self
                .stream(
                    repo_id,
                    format!("{DOC_CHECK_RUN}:{oid}"),
                    DOC_CHECK_RUN,
                    true,
                    filter,
                    Baseline::Beginning,
                )
                .await
            {
                let event = self
                    .repos
                    .get(repo_id)
                    .and_then(|s| ingest::translate_check_run(&s.meta, d));
                emit(&self.dispatcher, repo_id, event);
            }
        }
    }
}

/// Queue a translated event for the repo's hooks (never waits on a receiver).
fn emit(dispatcher: &Dispatcher, repo_id: &str, event: Option<WebhookEvent>) {
    if let Some(event) = event {
        dispatcher.enqueue(repo_id, event);
    }
}

/// Every GitHub event the relay produces.
const ALL_EVENTS: [&str; 7] = [
    "push",
    "release",
    "issues",
    "pull_request",
    "issue_comment",
    "pull_request_review",
    "check_run",
];

/// Record an event's effect on its target: activity time, and open/closed.
fn note_activity(s: &mut RepoState, d: &FetchedDocument) {
    let Some(tid) = d
        .field_bytes32("targetId")
        .map(forge_core::platform::encode_identifier)
    else {
        return;
    };
    if let Some(t) = s.targets.get_mut(&tid) {
        t.last_activity = t.last_activity.max(d.created_at.unwrap_or(0));
    }
    match d.field_u64("kind") {
        Some(1 | 3) => {
            s.closed.insert(tid);
        }
        Some(2) => {
            s.closed.remove(&tid);
        }
        _ => {}
    }
}

/// Keep the newest [`MAX_HEADS`] head oids.
fn prune_heads(heads: &mut BTreeMap<String, u64>) {
    if heads.len() <= MAX_HEADS {
        return;
    }
    let mut by_time: Vec<(u64, String)> = heads.iter().map(|(k, v)| (*v, k.clone())).collect();
    by_time.sort();
    for (_, k) in by_time.iter().take(heads.len() - MAX_HEADS) {
        heads.remove(k);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_repo_that_appears_late_never_replays_history_before_the_relay_started() {
        let start = 1_000_000;
        // Startup: from the tail.
        assert_eq!(
            baseline_for(true, 3, 10, start, None),
            Baseline::Tail { lookback: 3 }
        );
        // A hook written long ago, repo first served after startup: from the relay's start.
        assert_eq!(
            baseline_for(false, 0, 10, start, None),
            Baseline::Since(start)
        );
        // A hook written after the relay started: from the hook.
        assert_eq!(
            baseline_for(false, 0, start + 5, start, None),
            Baseline::Since(start + 5)
        );
        // A repo that dropped out and came back: from where it stopped, even at startup.
        assert_eq!(
            baseline_for(false, 0, 10, start, Some(start + 9)),
            Baseline::Since(start + 9)
        );
    }

    #[test]
    fn heads_are_bounded_newest_first() {
        let mut heads: BTreeMap<String, u64> = (0..(MAX_HEADS as u64 + 10))
            .map(|i| (format!("{i:040x}"), i))
            .collect();
        prune_heads(&mut heads);
        assert_eq!(heads.len(), MAX_HEADS);
        assert!(!heads.contains_key(&format!("{:040x}", 0)));
        assert!(heads.contains_key(&format!("{:040x}", MAX_HEADS as u64 + 9)));
    }
}
