//! The daemon: discover the repos with hooks addressed to this relay, poll their documents,
//! translate, and hand events to the delivery workers (PRD 05). Stateless across restarts:
//! cursors live in memory and are re-baselined on startup ([`crate::ingest`]).
//!
//! Two loops run side by side:
//!
//! * **Discovery** (its own task, every `refresh_cycles` poll intervals): re-read the hooks
//!   addressed to this relay ([`crate::subscriptions`], bounded by [`DISCOVERY_TIMEOUT`]),
//!   set up new repos (each within [`INIT_TIMEOUT`]), stop serving repos with no hook left,
//!   resync the per-hook delivery workers ([`crate::deliver::Dispatcher`]), and only then
//!   publish the new repos to the poller, so no poll runs before its repo's hooks exist.
//! * **Polling** (every poll interval): each served repo is polled in its own task, at most
//!   [`MAX_CONCURRENT_REPOS`] at once; a repo whose previous poll is still running is skipped.
//!   A poll reads the repo's streams past their cursors and enqueues each new document's event.
//!   Enqueueing never waits for a receiver. A poll checks its deadline ([`REPO_BUDGET`]) between
//!   streams and stops there; the next poll resumes at the stage it stopped in (repo streams,
//!   threads, check runs), so a slow node cannot starve the later stages. Nothing cancels a
//!   poll midway, and a stream's cursor is saved only after its documents were enqueued, so no
//!   event is lost to a timeout. The event feed is read only in a cycle whose pushes and config
//!   were read, so merges are judged against current base-ref tips.
//!
//! **Merge tips** are tracked only for refs that are the base of a known PR: backfilled from
//! that ref's history (by `refNameHash`) when the PR is first seen, then fed by the ref streams.
//!
//! **Baselines.** A repo is first read from "now": at startup with `Tail` (plus `--lookback`);
//! later with `Since(max(earliest hook $createdAt, relay start))`; after dropping out and coming
//! back with `Since(max(where it stopped, earliest hook, relay start))`, so a hook that was
//! disabled for a while does not replay what happened meanwhile. A stream that only some
//! events need (comments, reviews, check runs) starts, on its first read, no earlier than the
//! earliest hook that wants that event.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use forge_core::platform::{
    decode_identifier, FetchedDocument, FieldValue, LoadedContract, PlatformClient, QueryFilter,
    QueryOrder,
};
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
use crate::payload::RepositoryMeta;
use crate::subscriptions::{self, RelayIdentity, WebhookSub};

/// Wall-clock budget for one repo's poll: past it, the poll stops at the next stream boundary.
const REPO_BUDGET: Duration = Duration::from_secs(20);

/// Repos polled at once.
const MAX_CONCURRENT_REPOS: usize = 8;

/// Budget for reading the hooks addressed to this relay.
const DISCOVERY_TIMEOUT: Duration = Duration::from_secs(120);

/// Budget for setting up one newly served repo (metadata, config, issue/PR index, ref tips).
const INIT_TIMEOUT: Duration = Duration::from_secs(60);

/// Threads (issues/PRs) are read with priority when open or active within this window.
const THREAD_ACTIVE_WINDOW_MS: u64 = 7 * 24 * 3600 * 1000;

/// Per repo and cycle: at most this many prioritized threads (open or recently active, most
/// recent first)...
const MAX_PRIORITY_THREADS: usize = 40;

/// ...plus this many of the others, taken round-robin, so every thread's comments and reviews
/// are read eventually (a thread with N others behind it is read every N / this cycles).
const ROTATING_THREADS: usize = 10;

/// At most this many head oids tracked per repo for `checkRun` streams (newest kept).
const MAX_HEADS: usize = 50;

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

/// The two forge-v2 contracts.
struct Contracts {
    core: LoadedContract,
    collab: LoadedContract,
}

/// What every task shares.
struct Shared {
    client: PlatformClient,
    contracts: Contracts,
    dispatcher: Dispatcher,
    cfg: RelayConfig,
    /// When this relay started (ms since the epoch).
    started_ms: u64,
}

/// A head oid whose `checkRun` stream is read.
#[derive(Debug, Clone, Copy)]
struct Head {
    /// When it was seen (block time, ms): pruning keeps the newest.
    seen: u64,
    /// Where its stream starts.
    baseline: Baseline,
}

/// One served repository and its stream cursors (locked by the poll task that owns it).
struct RepoState {
    meta: RepositoryMeta,
    /// Where repo-level streams start.
    baseline: Baseline,
    /// Cursor per stream key (`refUpdate`, `comment:<targetId>`, `checkRun:<oid>`, ...).
    cursors: BTreeMap<String, Cursor>,
    /// Issues and PRs by `$id` (for event/comment/review translation).
    targets: BTreeMap<String, TargetInfo>,
    /// Closed targets (a close or merge seen; a reopen removes).
    closed: BTreeSet<String>,
    /// Head oids (hex) whose `checkRun` streams are read.
    heads: BTreeMap<String, Head>,
    /// The repo's `config` history (for protected-ref routing).
    configs: Vec<ConfigDoc>,
    /// Every tip a valid update set, by `refNameHash` (hex), for the base refs of known PRs only
    /// (a hash is present once backfilled): what a merge is checked against.
    tips: BTreeMap<String, BTreeSet<String>>,
    /// Round-robin position over the non-priority threads.
    rotation: usize,
    /// Which stage group a poll starts at (it resumes where the deadline last stopped it).
    next_stage: usize,
}

/// A served repo: its state, and what its hooks want (set by discovery, read by polls).
struct RepoSlot {
    state: tokio::sync::Mutex<RepoState>,
    /// Event → the earliest time a hook wanting it applies from (ms, floored at relay start).
    wants: Mutex<BTreeMap<&'static str, u64>>,
    /// The newest `$createdAt` read (block time), for resuming after a gap.
    high_water: AtomicU64,
}

/// The served repos.
type Repos = Arc<Mutex<BTreeMap<String, Arc<RepoSlot>>>>;

/// Lock a std mutex, ignoring poisoning (the data is plain state).
fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
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
    let client = PlatformClient::connect(cfg.target.clone()).await?;
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

    let shared = Arc::new(Shared {
        client,
        contracts,
        dispatcher: Dispatcher::new(Deliverer::new(DeliverConfig {
            allow_private: cfg.allow_private,
            ..Default::default()
        })),
        started_ms: now_ms(),
        cfg,
    });
    tracing::info!(
        network = %shared.cfg.target.network,
        poll_interval_s = shared.cfg.poll_interval.as_secs(),
        refresh_cycles = shared.cfg.refresh_cycles,
        allow_private = shared.cfg.allow_private,
        "relay started"
    );

    let repos: Repos = Arc::new(Mutex::new(BTreeMap::new()));
    let mut discovery = Discovery {
        shared: Arc::clone(&shared),
        repos: Arc::clone(&repos),
        identity,
        repo_filter,
        statics,
        subs: Vec::new(),
        resume_at: BTreeMap::new(),
    };
    tokio::spawn(async move {
        let every = shared_refresh_interval(&discovery.shared.cfg);
        let mut ticker = tokio::time::interval(every);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut startup = true;
        loop {
            ticker.tick().await;
            if let Err(e) = discovery.refresh(startup).await {
                tracing::warn!(error = %e, "webhook discovery failed; keeping the current set");
            } else {
                startup = false;
            }
        }
    });

    poll_loop(&shared, &repos).await
}

/// Every poll interval, poll each served repo in its own task, at most
/// [`MAX_CONCURRENT_REPOS`] at once; a repo whose previous poll is still running is skipped.
async fn poll_loop(shared: &Arc<Shared>, repos: &Repos) -> ! {
    let permits = Arc::new(tokio::sync::Semaphore::new(MAX_CONCURRENT_REPOS));
    let mut ticker = tokio::time::interval(shared.cfg.poll_interval);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        ticker.tick().await;
        let slots: Vec<(String, Arc<RepoSlot>)> = lock(repos)
            .iter()
            .map(|(k, v)| (k.clone(), Arc::clone(v)))
            .collect();
        for (repo_id, slot) in slots {
            let shared = Arc::clone(shared);
            let permits = Arc::clone(&permits);
            tokio::spawn(async move {
                let Ok(mut state) = slot.state.try_lock() else {
                    return;
                };
                let Ok(_permit) = permits.acquire().await else {
                    return;
                };
                let wants = lock(&slot.wants).clone();
                let deadline = Instant::now() + REPO_BUDGET;
                let high = poll_repo(&shared, &repo_id, &mut state, &wants, deadline).await;
                slot.high_water.fetch_max(high, Ordering::Relaxed);
            });
        }
    }
}

/// How often discovery runs.
fn shared_refresh_interval(cfg: &RelayConfig) -> Duration {
    cfg.poll_interval
        .saturating_mul(u32::try_from(cfg.refresh_cycles).unwrap_or(u32::MAX))
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
        Some(t) => Baseline::Since(t.max(earliest_hook).max(relay_start)),
        None if startup => Baseline::Tail { lookback },
        None => Baseline::Since(earliest_hook.max(relay_start)),
    }
}

/// A per-thread or per-head stream's first-read baseline: no earlier than `since` (the earliest
/// hook that wants its event, floored at the relay's start). A startup `Tail` becomes
/// `Since(since)` too: such a stream may first be read cycles later (thread rotation), and
/// "the tail at that moment" would skip what was written in between. (So `--lookback` applies
/// to the repo-level streams only.)
fn no_earlier_than(base: Baseline, since: u64) -> Baseline {
    match base {
        Baseline::Since(t) => Baseline::Since(t.max(since)),
        Baseline::Tail { .. } | Baseline::Beginning => Baseline::Since(since),
    }
}

/// For each event, the earliest time a hook of `repo_id` that wants it applies from.
fn wants_of(subs: &[WebhookSub], repo_id: &str, relay_start: u64) -> BTreeMap<&'static str, u64> {
    ALL_EVENTS
        .iter()
        .filter_map(|e| {
            subs.iter()
                .filter(|s| s.repo_id == repo_id && s.wants(e))
                .map(|s| s.created_at)
                .min()
                .map(|t| (*e, t.max(relay_start)))
        })
        .collect()
}

/// The discovery task's state.
struct Discovery {
    shared: Arc<Shared>,
    repos: Repos,
    identity: Option<RelayIdentity>,
    /// `--repos`, resolved to repo ids (empty = every repo with a hook).
    repo_filter: BTreeSet<String>,
    /// Static webhooks with their repo resolved.
    statics: Vec<WebhookSub>,
    /// Hooks from the last discovery.
    subs: Vec<WebhookSub>,
    /// Repos that were served and dropped out: where to resume if they come back.
    resume_at: BTreeMap<String, u64>,
}

impl Discovery {
    /// Re-run discovery, reconcile the served repos with it, and resync the delivery workers.
    async fn refresh(&mut self, startup: bool) -> Result<()> {
        let shared = Arc::clone(&self.shared);
        let mut subs = self.statics.clone();
        let mut failed = BTreeSet::new();
        if let Some(identity) = &self.identity {
            let found = tokio::time::timeout(
                DISCOVERY_TIMEOUT,
                subscriptions::platform_subscriptions(
                    &shared.client,
                    identity,
                    &shared.contracts.collab.id(),
                    &self.repo_filter,
                ),
            )
            .await
            .map_err(|_| RelayError::Config("webhook discovery timed out".into()))??;
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

        // Stop serving repos with no hook left, remembering where they stopped.
        let (before, new): (BTreeSet<String>, Vec<(String, u64)>) = {
            let mut repos = lock(&self.repos);
            let before: BTreeSet<String> = repos.keys().cloned().collect();
            repos.retain(|id, slot| {
                let keep = wanted.contains_key(id);
                if !keep {
                    self.resume_at
                        .insert(id.clone(), slot.high_water.load(Ordering::Relaxed));
                }
                keep
            });
            let new = wanted
                .iter()
                .filter(|(id, _)| !repos.contains_key(*id))
                .map(|(id, t)| (id.clone(), *t))
                .collect();
            (before, new)
        };

        let ready = self.setup_new(new, startup).await;

        // Under one lock: hooks to the dispatcher, `wants` set, then the new repos published.
        let mut repos = lock(&self.repos);
        let served: BTreeSet<String> = repos
            .keys()
            .chain(ready.iter().map(|(id, _)| id))
            .cloned()
            .collect();
        subs.retain(|s| served.contains(&s.repo_id));
        shared.dispatcher.sync(&subs);
        for (repo_id, slot) in repos.iter().chain(ready.iter().map(|(k, v)| (k, v))) {
            *lock(&slot.wants) = wants_of(&subs, repo_id, shared.started_ms);
        }
        repos.extend(ready);
        self.subs = subs;

        let after: BTreeSet<String> = repos.keys().cloned().collect();
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

    /// Set up new repos (each within [`INIT_TIMEOUT`]) **without publishing them**: a poll must
    /// not see a repo before the dispatcher knows its hooks, or its first events would find no
    /// hook and be dropped. The caller publishes them after syncing the dispatcher.
    async fn setup_new(
        &mut self,
        new: Vec<(String, u64)>,
        startup: bool,
    ) -> Vec<(String, Arc<RepoSlot>)> {
        let shared = Arc::clone(&self.shared);
        let mut ready = Vec::new();
        for (repo_id, earliest) in new {
            let baseline = baseline_for(
                startup,
                shared.cfg.lookback,
                earliest,
                shared.started_ms,
                self.resume_at.get(&repo_id).copied(),
            );
            match tokio::time::timeout(INIT_TIMEOUT, init_repo(&shared, &repo_id, baseline)).await {
                Ok(Ok(state)) => {
                    self.resume_at.remove(&repo_id);
                    let high = match baseline {
                        Baseline::Since(t) => t,
                        _ => 0,
                    };
                    ready.push((
                        repo_id,
                        Arc::new(RepoSlot {
                            state: tokio::sync::Mutex::new(state),
                            wants: Mutex::new(BTreeMap::new()),
                            high_water: AtomicU64::new(high),
                        }),
                    ));
                }
                Ok(Err(e)) => {
                    tracing::warn!(repo = %repo_id, error = %e, "cannot serve repo; retrying at the next discovery");
                }
                Err(_) => {
                    tracing::warn!(repo = %repo_id, "setting up the repo timed out; retrying at the next discovery");
                }
            }
        }
        ready
    }
}

/// Every document of `doc_type` of the repo, complete, oldest first.
async fn read_all(
    shared: &Shared,
    contract: &LoadedContract,
    doc_type: &str,
    repo_id: &str,
) -> Result<Vec<FetchedDocument>> {
    Ok(shared
        .client
        .query_all_documents(
            contract,
            doc_type,
            &[repo_filter(repo_id)?],
            &[QueryOrder::asc("$createdAt")],
        )
        .await?)
}

/// Record the tip of a valid ref update, if its ref is tracked (a base ref of a known PR).
fn add_tip(tips: &mut BTreeMap<String, BTreeSet<String>>, d: &FetchedDocument) {
    if let (Some(hash), Some(oid)) = (d.field_hex("refNameHash"), d.field_hex("newOid")) {
        if let Some(set) = tips.get_mut(&hash) {
            set.insert(oid);
        }
    }
}

/// With a `Tail` baseline, prime `key`'s cursor from the complete read that built the repo's
/// state, so nothing written between setting up and the first poll is skipped. (A `Since`
/// baseline re-reads from its time; what it re-reads is already in the state, and the state is
/// keyed, so it merges.)
fn prime(
    cursors: &mut BTreeMap<String, Cursor>,
    baseline: Baseline,
    key: &str,
    oldest_first: &[FetchedDocument],
) {
    if let Baseline::Tail { lookback } = baseline {
        let newest_first: Vec<FetchedDocument> = oldest_first.iter().rev().cloned().collect();
        cursors.insert(key.to_string(), Cursor::primed(&newest_first, lookback));
    }
}

/// With a `Tail` baseline, prime the ref streams' cursors at setup time from their newest page
/// (their history is not read in full; see `RepoState::backfill_tips`).
async fn prime_ref_streams(
    shared: &Shared,
    cursors: &mut BTreeMap<String, Cursor>,
    baseline: Baseline,
    repo_id: &str,
) -> Result<()> {
    let Baseline::Tail { lookback } = baseline else {
        return Ok(());
    };
    for doc_type in [DOC_REF_UPDATE, DOC_PROTECTED_REF_UPDATE] {
        let newest = shared
            .client
            .query_documents(
                &shared.contracts.core,
                doc_type,
                &[repo_filter(repo_id)?],
                &[QueryOrder::desc("$createdAt")],
                100,
                None,
            )
            .await?;
        cursors.insert(doc_type.to_string(), Cursor::primed(&newest, lookback));
    }
    Ok(())
}

/// Resolve a repo's metadata, config history, issue/PR index, valid ref tips, and recently
/// opened PR heads.
async fn init_repo(shared: &Shared, repo_id: &str, baseline: Baseline) -> Result<RepoState> {
    let repo = forge_core::resolve::resolve_id(&shared.client, repo_id).await?;
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
    let (core, collab) = (&shared.contracts.core, &shared.contracts.collab);
    let config_docs = read_all(shared, core, "config", repo_id).await?;
    let configs: Vec<ConfigDoc> = config_docs.iter().map(config_doc).collect();
    let repo_doc = shared.client.fetch_document(core, "repo", repo_id).await?;
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

    let mut cursors = BTreeMap::new();
    prime(&mut cursors, baseline, "config", &config_docs);
    prime_ref_streams(shared, &mut cursors, baseline, repo_id).await?;

    // Every existing issue and PR, so events on old threads translate. Their comment and
    // review streams start where the repo's streams do. Recently opened PRs' heads are
    // watched for check runs from the same baseline (never replaying older runs).
    let recent = now_ms().saturating_sub(THREAD_ACTIVE_WINDOW_MS);
    let mut targets = BTreeMap::new();
    let mut heads = BTreeMap::new();
    for (doc_type, is_pr) in [(DOC_ISSUE, false), (DOC_PATCH, true)] {
        let docs = read_all(shared, collab, doc_type, repo_id).await?;
        prime(&mut cursors, baseline, doc_type, &docs);
        for d in docs {
            let t = if is_pr {
                TargetInfo::from_patch(&d, baseline)
            } else {
                TargetInfo::from_issue(&d, baseline)
            };
            if is_pr && !t.head_oid.is_empty() && t.last_activity >= recent {
                heads.insert(
                    t.head_oid.clone(),
                    Head {
                        seen: t.last_activity,
                        baseline,
                    },
                );
            }
            targets.insert(d.id.clone(), t);
        }
    }
    prune_heads(&mut heads, &mut cursors);
    tracing::info!(repo = %repo_id, name = %name, owner = %owner_id, targets = targets.len(), ?baseline, "serving repo");
    let mut state = RepoState {
        meta: RepositoryMeta {
            repo_id: repo_id.to_string(),
            owner_id: owner_id.clone(),
            name: name.clone(),
            default_branch,
            web_base_url: shared.cfg.web_base_url.clone(),
        },
        baseline,
        cursors,
        targets,
        closed: BTreeSet::new(),
        heads,
        configs,
        tips: BTreeMap::new(),
        rotation: 0,
        next_stage: 0,
    };
    // Valid tips of the PRs' base refs only (what merges are checked against).
    state.backfill_tips(shared).await?;
    Ok(state)
}

/// One stream read: its new documents and the advanced cursor, **not yet saved**. The caller
/// enqueues the documents' events, then saves the cursor with [`RepoState::commit`].
struct Read {
    key: String,
    docs: Vec<FetchedDocument>,
    cursor: Cursor,
}

impl RepoState {
    /// Read one stream past its cursor (a new cursor starts at `baseline`). `None` on a failed
    /// read (logged; retried next cycle from the same cursor).
    async fn read(
        &self,
        shared: &Shared,
        key: String,
        doc_type: &str,
        contract: &LoadedContract,
        prefix: &[QueryFilter],
        baseline: Baseline,
    ) -> Option<Read> {
        let mut cursor = self
            .cursors
            .get(&key)
            .cloned()
            .unwrap_or_else(|| Cursor::new(baseline));
        let source = LiveStream {
            client: &shared.client,
            contract,
            doc_type,
            prefix,
        };
        match poll_stream(&source, &mut cursor).await {
            Ok(docs) => Some(Read { key, docs, cursor }),
            Err(e) => {
                tracing::warn!(repo = %self.meta.repo_id, stream = %key, error = %e, "stream read failed; retrying next cycle");
                None
            }
        }
    }

    /// Start tracking valid tips for every PR base ref not tracked yet: read that ref's history
    /// once (by `refNameHash`), keep the tips of valid updates; later ones come from the ref
    /// streams (`add_tip`). Only base refs are tracked, so memory and setup time scale with the
    /// PRs' base branches, not with the repo's whole ref history.
    async fn backfill_tips(&mut self, shared: &Shared) -> Result<()> {
        let wanted: BTreeSet<String> = self
            .targets
            .values()
            .filter(|t| t.is_pr && rules::ref_name_hash_matches(&t.base_ref, &t.base_ref_hash))
            .map(|t| t.base_ref_hash.to_ascii_lowercase())
            .filter(|h| !self.tips.contains_key(h))
            .collect();
        let repo = decode_identifier(&self.meta.repo_id)?;
        for hash in wanted {
            let Ok(bytes) = <[u8; 32]>::try_from(hex::decode(&hash).unwrap_or_default()) else {
                continue;
            };
            let mut set = BTreeSet::new();
            for (doc_type, protected) in [(DOC_REF_UPDATE, false), (DOC_PROTECTED_REF_UPDATE, true)]
            {
                for d in shared
                    .client
                    .query_all_documents(
                        &shared.contracts.core,
                        doc_type,
                        &[
                            QueryFilter::eq("repoId", FieldValue::identifier(repo)),
                            QueryFilter::eq("refNameHash", FieldValue::bytes32(bytes)),
                        ],
                        &[QueryOrder::asc("$createdAt")],
                    )
                    .await?
                {
                    if ingest::ref_update_is_valid(&d, protected, &self.configs) {
                        if let Some(oid) = d.field_hex("newOid") {
                            set.insert(oid);
                        }
                    }
                }
            }
            self.tips.insert(hash, set);
        }
        Ok(())
    }

    /// Save a read's cursor (after its events were enqueued); returns its newest `$createdAt`.
    fn commit(&mut self, read: Read) -> u64 {
        self.cursors.insert(read.key, read.cursor);
        read.docs
            .iter()
            .filter_map(|d| d.created_at)
            .max()
            .unwrap_or(0)
    }

    /// Enqueue `event` for the repo's hooks.
    fn emit(&self, shared: &Shared, event: Option<crate::payload::WebhookEvent>) {
        if let Some(event) = event {
            shared.dispatcher.enqueue(&self.meta.repo_id, event);
        }
    }

    /// Whether a merge event's `oid` was set on the PR's base ref by a valid update (see
    /// [`ingest::translate_event`]). `true` for other kinds (nothing to verify). The base ref's
    /// hash must be `sha256(baseRefName)`, or the merge is unverified.
    fn merge_verified(&self, d: &FetchedDocument) -> bool {
        if d.field_u64("kind") != Some(3) {
            return true;
        }
        let target = d
            .field_bytes32("targetId")
            .map(forge_core::platform::encode_identifier)
            .and_then(|id| self.targets.get(&id));
        match (target, d.field_hex("oid")) {
            (Some(t), Some(oid)) => {
                rules::ref_name_hash_matches(&t.base_ref, &t.base_ref_hash)
                    && self
                        .tips
                        .get(&t.base_ref_hash.to_ascii_lowercase())
                        .is_some_and(|tips| tips.contains(&oid))
            }
            _ => false,
        }
    }
}

/// The groups a poll works through, in order: repo-level streams (pushes, then releases,
/// issues, PRs and the event feed), thread streams, check runs.
const STAGES: usize = 3;

/// One poll of one repo; returns the newest `$createdAt` read. Stops at a stream boundary once
/// `deadline` has passed; the next poll starts at the stage it stopped in, so a slow node
/// cannot keep the later stages (threads, check runs) from ever being read.
async fn poll_repo(
    shared: &Shared,
    repo_id: &str,
    st: &mut RepoState,
    wants: &BTreeMap<&'static str, u64>,
    deadline: Instant,
) -> u64 {
    let Ok(rf) = repo_filter(repo_id) else {
        return 0;
    };
    let mut high = 0;
    let start = st.next_stage % STAGES;
    for i in 0..STAGES {
        let stage = (start + i) % STAGES;
        if Instant::now() >= deadline {
            st.next_stage = stage;
            return high;
        }
        let (h, finished) = match stage {
            0 => poll_repo_streams(shared, st, &rf, deadline).await,
            1 => poll_threads(shared, st, wants, deadline).await,
            _ => poll_check_runs(shared, st, &rf, wants, deadline).await,
        };
        high = high.max(h);
        if !finished {
            st.next_stage = stage;
            return high;
        }
    }
    st.next_stage = 0;
    high
}

/// Pushes, then releases, new issues and PRs, and the state-change feed. The feed is read only
/// if the pushes were (so a merge is never judged against tips missing this cycle's pushes).
/// Returns `(newest $createdAt, finished before the deadline)`.
async fn poll_repo_streams(
    shared: &Shared,
    st: &mut RepoState,
    rf: &QueryFilter,
    deadline: Instant,
) -> (u64, bool) {
    let (high, pushes_read) = poll_pushes(shared, st, std::slice::from_ref(rf)).await;
    let (h, finished) = poll_repo_rest(shared, st, rf, pushes_read, deadline).await;
    (high.max(h), finished)
}

/// Pushes. Read the ref streams, then config, so every config that applied to an update read
/// here is known when it is judged. If config or either ref stream cannot be read, judge
/// nothing: the cursors stay where they were. Returns `(newest $createdAt, all three read)`.
async fn poll_pushes(shared: &Shared, st: &mut RepoState, prefix: &[QueryFilter]) -> (u64, bool) {
    let core = &shared.contracts.core;
    let base = st.baseline;
    let repo_id = st.meta.repo_id.clone();
    let mut high = 0;
    let mut refs: Vec<(Read, bool)> = Vec::new();
    for (doc_type, protected) in [(DOC_REF_UPDATE, false), (DOC_PROTECTED_REF_UPDATE, true)] {
        match st
            .read(shared, doc_type.into(), doc_type, core, prefix, base)
            .await
        {
            Some(r) => refs.push((r, protected)),
            None => return (0, false),
        }
    }
    let Some(cfg_read) = st
        .read(shared, "config".into(), "config", core, prefix, base)
        .await
    else {
        return (0, false);
    };
    for d in &cfg_read.docs {
        // The first read after init returns configs init already loaded.
        if !st.configs.iter().any(|c| c.id == d.id) {
            st.configs.push(config_doc(d));
        }
    }
    high = high.max(st.commit(cfg_read));
    for (r, protected) in refs {
        for d in &r.docs {
            if !ingest::ref_update_is_valid(d, protected, &st.configs) {
                tracing::debug!(repo = %repo_id, source = %d.id, "ref update is inert by the protected-ref rule; not reported");
                continue;
            }
            add_tip(&mut st.tips, d);
            if !ingest::is_ref_deletion(d) {
                if let Some(oid) = d.field_hex("newOid") {
                    // Runs on this commit from the push on; an oid already watched keeps its
                    // baseline (older runs are never replayed).
                    let t = d.created_at.unwrap_or(0);
                    st.heads.entry(oid).or_insert(Head {
                        seen: t,
                        baseline: Baseline::Since(t),
                    });
                    prune_heads(&mut st.heads, &mut st.cursors);
                }
            }
            st.emit(shared, ingest::translate_ref_update(&st.meta, d));
        }
        high = high.max(st.commit(r));
    }
    (high, true)
}

/// Releases, new issues and PRs, then the state-change feed, which is skipped when this
/// cycle's pushes were not read (`pushes_read`). Returns `(newest $createdAt, finished)`.
async fn poll_repo_rest(
    shared: &Shared,
    st: &mut RepoState,
    rf: &QueryFilter,
    pushes_read: bool,
    deadline: Instant,
) -> (u64, bool) {
    let prefix = [rf.clone()];
    let (core, collab) = (&shared.contracts.core, &shared.contracts.collab);
    let base = st.baseline;
    let mut high = 0;

    let streams: [(&str, &LoadedContract); 5] = [
        (DOC_RELEASE, core),
        (DOC_ISSUE, collab),
        (DOC_PATCH, collab),
        (DOC_EVENT, collab),
        (DOC_AUTHOR_EVENT, collab),
    ];
    for (doc_type, contract) in streams {
        if Instant::now() >= deadline {
            return (high, false);
        }
        if matches!(doc_type, DOC_EVENT | DOC_AUTHOR_EVENT) {
            if !pushes_read {
                // Merges would be judged against tips missing this cycle's pushes.
                continue;
            }
            // Tips of new PRs' base refs, before their merges are judged.
            if let Err(e) = st.backfill_tips(shared).await {
                tracing::warn!(repo = %st.meta.repo_id, error = %e, "base-ref tips unavailable; reading the event feed next cycle");
                continue;
            }
        }
        let Some(r) = st
            .read(shared, doc_type.into(), doc_type, contract, &prefix, base)
            .await
        else {
            continue;
        };
        for d in &r.docs {
            let event = match doc_type {
                DOC_RELEASE => ingest::translate_release(&st.meta, d),
                DOC_ISSUE | DOC_PATCH => {
                    // A thread first seen live: everything on it is new (bounded below by the
                    // hooks that want its comments; see `no_earlier_than`).
                    let t = if doc_type == DOC_PATCH {
                        TargetInfo::from_patch(d, Baseline::Beginning)
                    } else {
                        TargetInfo::from_issue(d, Baseline::Beginning)
                    };
                    if doc_type == DOC_PATCH && !t.head_oid.is_empty() {
                        let seen = t.last_activity;
                        st.heads.entry(t.head_oid.clone()).or_insert(Head {
                            seen,
                            baseline: Baseline::Since(seen),
                        });
                        prune_heads(&mut st.heads, &mut st.cursors);
                    }
                    st.targets.insert(d.id.clone(), t);
                    if doc_type == DOC_PATCH {
                        ingest::translate_patch(&st.meta, d)
                    } else {
                        ingest::translate_issue(&st.meta, d)
                    }
                }
                _ => {
                    let verified = st.merge_verified(d);
                    note_activity(st, d);
                    ingest::translate_event(&st.meta, d, &st.targets, verified)
                }
            };
            st.emit(shared, event);
        }
        high = high.max(st.commit(r));
    }
    (high, true)
}

/// The threads whose comment/review streams are read this cycle: the prioritized ones (open or
/// active within [`THREAD_ACTIVE_WINDOW_MS`], most recent first, at most
/// [`MAX_PRIORITY_THREADS`]) plus [`ROTATING_THREADS`] of the rest in round-robin order, so a
/// quiet closed thread's comments are still read eventually. Each entry says whether it is a
/// rotating one: the rotation advances by the rotating threads actually read.
fn threads_this_cycle(st: &RepoState, now: u64) -> Vec<(String, bool, Baseline, bool)> {
    let cutoff = now.saturating_sub(THREAD_ACTIVE_WINDOW_MS);
    let (mut hot, cold): (Vec<_>, Vec<_>) = st
        .targets
        .iter()
        .map(|(id, t)| (id.clone(), t.is_pr, t.baseline, t.last_activity))
        .partition(|(id, _, _, last)| !st.closed.contains(id) || *last >= cutoff);
    hot.sort_by_key(|t| std::cmp::Reverse(t.3));
    let mut rest: Vec<_> = hot.split_off(hot.len().min(MAX_PRIORITY_THREADS));
    rest.extend(cold);
    rest.sort_by(|a, b| a.0.cmp(&b.0));
    let mut out: Vec<_> = hot
        .into_iter()
        .map(|(id, pr, b, _)| (id, pr, b, false))
        .collect();
    if !rest.is_empty() {
        let n = rest.len();
        let start = st.rotation % n;
        out.extend(
            (0..ROTATING_THREADS.min(n))
                .map(|i| &rest[(start + i) % n])
                .map(|(id, pr, b, _)| (id.clone(), *pr, *b, true)),
        );
    }
    out
}

/// Comments (per issue/PR) and reviews (per PR) of this cycle's threads. Returns
/// `(newest $createdAt, finished before the deadline)`.
async fn poll_threads(
    shared: &Shared,
    st: &mut RepoState,
    wants: &BTreeMap<&'static str, u64>,
    deadline: Instant,
) -> (u64, bool) {
    let comments = wants.get("issue_comment").copied();
    let reviews = wants.get("pull_request_review").copied();
    if comments.is_none() && reviews.is_none() {
        return (0, true);
    }
    let collab = &shared.contracts.collab;
    let mut high = 0;
    let mut rotated = 0;
    let mut finished = true;
    'threads: for (tid, is_pr, tbase, rotating) in threads_this_cycle(st, now_ms()) {
        let Ok(bytes) = decode_identifier(&tid) else {
            continue;
        };
        let kinds = [
            (DOC_COMMENT, "targetId", comments),
            (DOC_REVIEW, "patchId", if is_pr { reviews } else { None }),
        ];
        for (doc_type, field, since) in kinds {
            let Some(since) = since else { continue };
            if Instant::now() >= deadline {
                finished = false;
                break 'threads;
            }
            let prefix = [QueryFilter::eq(field, FieldValue::identifier(bytes))];
            let Some(r) = st
                .read(
                    shared,
                    format!("{doc_type}:{tid}"),
                    doc_type,
                    collab,
                    &prefix,
                    no_earlier_than(tbase, since),
                )
                .await
            else {
                continue;
            };
            for d in &r.docs {
                if let Some(t) = st.targets.get_mut(&tid) {
                    t.last_activity = t.last_activity.max(d.created_at.unwrap_or(0));
                }
                let event = if doc_type == DOC_REVIEW {
                    ingest::translate_review(&st.meta, d, &st.targets)
                } else {
                    ingest::translate_comment(&st.meta, d, &st.targets)
                };
                st.emit(shared, event);
            }
            high = high.max(st.commit(r));
        }
        rotated += usize::from(rotating);
    }
    st.rotation = st.rotation.wrapping_add(rotated);
    (high, finished)
}

/// Check runs, per watched head oid (the newest [`MAX_HEADS`]). New `checkRun` documents only:
/// a run updated in place (status progression) is not observed, because the index is keyed
/// on `$createdAt`.
async fn poll_check_runs(
    shared: &Shared,
    st: &mut RepoState,
    rf: &QueryFilter,
    wants: &BTreeMap<&'static str, u64>,
    deadline: Instant,
) -> (u64, bool) {
    let Some(since) = wants.get("check_run").copied() else {
        return (0, true);
    };
    let mut high = 0;
    let heads: Vec<(String, Head)> = st.heads.iter().map(|(k, v)| (k.clone(), *v)).collect();
    for (oid, head) in heads {
        if Instant::now() >= deadline {
            return (high, false);
        }
        let Ok(bytes) = hex::decode(&oid) else {
            continue;
        };
        let prefix = [
            rf.clone(),
            QueryFilter::eq("headOid", FieldValue::bytes(bytes)),
        ];
        let Some(r) = st
            .read(
                shared,
                format!("{DOC_CHECK_RUN}:{oid}"),
                DOC_CHECK_RUN,
                &shared.contracts.collab,
                &prefix,
                no_earlier_than(head.baseline, since),
            )
            .await
        else {
            continue;
        };
        for d in &r.docs {
            st.emit(shared, ingest::translate_check_run(&st.meta, d));
        }
        high = high.max(st.commit(r));
    }
    (high, true)
}

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
fn prune_heads(heads: &mut BTreeMap<String, Head>, cursors: &mut BTreeMap<String, Cursor>) {
    if heads.len() <= MAX_HEADS {
        return;
    }
    let mut by_time: Vec<(u64, String)> = heads.iter().map(|(k, v)| (v.seen, k.clone())).collect();
    by_time.sort();
    for (_, k) in by_time.iter().take(heads.len() - MAX_HEADS) {
        heads.remove(k);
        cursors.remove(&format!("{DOC_CHECK_RUN}:{k}"));
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
        // Back after dropping out: from where it stopped...
        assert_eq!(
            baseline_for(false, 0, 10, start, Some(start + 9)),
            Baseline::Since(start + 9)
        );
        // ...unless the hook came back later than that (re-enabled): nothing from while it
        // was disabled.
        assert_eq!(
            baseline_for(true, 0, start + 50, start, Some(start + 9)),
            Baseline::Since(start + 50)
        );
    }

    #[test]
    fn a_stream_starts_no_earlier_than_the_hooks_that_want_it() {
        assert_eq!(no_earlier_than(Baseline::Beginning, 7), Baseline::Since(7));
        assert_eq!(no_earlier_than(Baseline::Since(9), 7), Baseline::Since(9));
        assert_eq!(no_earlier_than(Baseline::Since(5), 7), Baseline::Since(7));
        assert_eq!(
            no_earlier_than(Baseline::Tail { lookback: 3 }, 7),
            Baseline::Since(7)
        );

        let sub = |repo: &str, events: &[&str], at: u64| WebhookSub {
            repo_id: repo.into(),
            hook_id: format!("{repo}{at}"),
            url: "https://x".into(),
            events: events.iter().map(ToString::to_string).collect(),
            secret: forge_core::envelope::SecretBytes::new(vec![b'k'; 32]),
            created_at: at,
            document_id: None,
        };
        let subs = [
            sub("R", &["push"], 100),
            sub("R", &["issue_comment"], 500),
            sub("R", &[], 300),
            sub("S", &["check_run"], 1),
        ];
        let w = wants_of(&subs, "R", 200);
        assert_eq!(w["push"], 200, "floored at the relay's start");
        assert_eq!(w["issue_comment"], 300, "the all-events hook is older");
        assert_eq!(w["check_run"], 300);
        assert!(!wants_of(&subs, "S", 0).contains_key("push"));
    }

    fn state_with_threads(n: usize) -> RepoState {
        let targets = (0..n)
            .map(|i| {
                (
                    format!("t{i:03}"),
                    TargetInfo {
                        is_pr: false,
                        number: i as u64,
                        author: String::new(),
                        title: String::new(),
                        base_ref: String::new(),
                        head_oid: String::new(),
                        base_ref_hash: String::new(),
                        baseline: Baseline::Beginning,
                        last_activity: 0,
                    },
                )
            })
            .collect::<BTreeMap<_, _>>();
        RepoState {
            meta: RepositoryMeta {
                repo_id: "R".into(),
                owner_id: "O".into(),
                name: "n".into(),
                default_branch: "main".into(),
                web_base_url: String::new(),
            },
            baseline: Baseline::Beginning,
            cursors: BTreeMap::new(),
            closed: targets.keys().cloned().collect(),
            targets,
            heads: BTreeMap::new(),
            configs: Vec::new(),
            tips: BTreeMap::new(),
            rotation: 0,
            next_stage: 0,
        }
    }

    #[test]
    fn quiet_closed_threads_are_still_read_in_rotation() {
        let mut st = state_with_threads(25);
        let now = 10 * THREAD_ACTIVE_WINDOW_MS;
        let mut seen = BTreeSet::new();
        for _ in 0..3 {
            let batch = threads_this_cycle(&st, now);
            assert_eq!(batch.len(), ROTATING_THREADS);
            assert!(batch.iter().all(|t| t.3), "all rotating");
            // As `poll_threads` does when it reads the whole batch.
            st.rotation += batch.len();
            seen.extend(batch.into_iter().map(|t| t.0));
        }
        assert_eq!(
            seen.len(),
            25,
            "every thread read within ceil(25 / 10) cycles"
        );
        // A batch cut short by the deadline: the rotation only moves by what was read, so the
        // unread ones come first next cycle.
        let batch = threads_this_cycle(&st, now);
        st.rotation += 4;
        assert_eq!(threads_this_cycle(&st, now)[0].0, batch[4].0);
        // An open thread is always read, and does not move the rotation.
        st.closed.remove("t007");
        for _ in 0..3 {
            let batch = threads_this_cycle(&st, now);
            assert!(batch.iter().any(|t| t.0 == "t007" && !t.3));
        }
    }

    #[test]
    fn merges_are_verified_against_valid_tips_of_a_matching_base_ref() {
        use sha2::Digest;
        let mut st = state_with_threads(0);
        let base = "refs/heads/main";
        let hash = hex::encode(sha2::Sha256::digest(base.as_bytes()));
        let pr = |base_ref: &str, base_ref_hash: &str| TargetInfo {
            is_pr: true,
            number: 1,
            author: String::new(),
            title: String::new(),
            base_ref: base_ref.into(),
            head_oid: String::new(),
            base_ref_hash: base_ref_hash.into(),
            baseline: Baseline::Beginning,
            last_activity: 0,
        };
        st.tips
            .entry(hash.clone())
            .or_default()
            .insert("ab".repeat(20));
        let target = forge_core::platform::encode_identifier([4; 32]);
        let merge = |oid: &str| FetchedDocument {
            id: "m".into(),
            owner_id: "M".into(),
            created_at: Some(1),
            fields: BTreeMap::from([
                ("targetId".into(), FieldValue::identifier([4; 32])),
                ("kind".into(), FieldValue::integer(3)),
                ("oid".into(), FieldValue::bytes(hex::decode(oid).unwrap())),
            ]),
        };
        st.targets.insert(target.clone(), pr(base, &hash));
        assert!(st.merge_verified(&merge(&"ab".repeat(20))));
        assert!(!st.merge_verified(&merge(&"cd".repeat(20))), "not a tip");
        // A baseRefName that does not hash to baseRefNameHash: unverified.
        st.targets.insert(target, pr("refs/heads/other", &hash));
        assert!(!st.merge_verified(&merge(&"ab".repeat(20))));
    }

    #[test]
    fn heads_are_bounded_newest_first() {
        let mut heads: BTreeMap<String, Head> = (0..(MAX_HEADS as u64 + 10))
            .map(|i| {
                (
                    format!("{i:040x}"),
                    Head {
                        seen: i,
                        baseline: Baseline::Since(i),
                    },
                )
            })
            .collect();
        let mut cursors: BTreeMap<String, Cursor> = heads
            .keys()
            .map(|k| {
                (
                    format!("{DOC_CHECK_RUN}:{k}"),
                    Cursor::new(Baseline::Beginning),
                )
            })
            .collect();
        prune_heads(&mut heads, &mut cursors);
        assert_eq!(cursors.len(), MAX_HEADS, "pruned heads lose their cursors");
        assert_eq!(heads.len(), MAX_HEADS);
        assert!(!heads.contains_key(&format!("{:040x}", 0)));
        assert!(heads.contains_key(&format!("{:040x}", MAX_HEADS as u64 + 9)));
    }
}
