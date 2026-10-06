//! The daemon: discover the repos with hooks addressed to this relay, poll their documents,
//! translate, and hand events to the delivery workers (PRD 05). Cursors live in memory and
//! are re-baselined on startup ([`crate::ingest`]); only the check runs seen per watched head
//! are kept in the state dir ([`crate::checkruns`]), because a run changes in place.
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
//! **Sinks and watch mode** ([`crate::sinks`]): every event is also handed to the sinks
//! ([`EventSink`]), the relay's own `[[sink]]`s and an embedder's. Watch subscriptions
//! ([`subscriptions::watch_subscription`]) make a repo served with no `webhook` document: a
//! sink's `repos`, `[watch] repos`, the repos `[watch] identity` watches (re-read at every
//! discovery), and an embedder's watch feed ([`Embed::watch_feed`]). A private repo is never
//! served; one that appears in a watch set is refused once and skipped after that. A `[[sink]]`
//! without `repos` gets the repos chosen in the config or by the embedder, polled for its
//! events too ([`unscoped_watch`]), never a repo served only for a `webhook` document.
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
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use forge_core::layout::ForgeContract;
use forge_core::platform::{
    decode_identifier, FetchedDocument, FieldValue, LoadedContract, PlatformClient, QueryFilter,
    QueryOrder,
};
use forge_core::repo::config_doc;
use forge_core::rules::{self, v2::Visibility, ConfigDoc};
use forge_core::scope::RepoRef;

use crate::checkruns;
use crate::config::RelayConfig;
use crate::deliver::{DeliverConfig, Deliverer, Dispatcher};
use crate::error::{RelayError, Result};
use crate::ingest::{
    self, poll_stream, Baseline, Cursor, LiveStream, TargetInfo, DOC_AUTHOR_EVENT, DOC_CHECK_RUN,
    DOC_COMMENT, DOC_EVENT, DOC_ISSUE, DOC_PATCH, DOC_PROTECTED_REF_UPDATE, DOC_REF_UPDATE,
    DOC_RELEASE, DOC_REVIEW, DOC_TRANSITION,
};
use crate::payload::{CheckRunAction, RepositoryMeta, ALL_EVENTS};
use crate::queue::RetryQueue;
use crate::sinks::{EventSink, NameCache, SinkHub};
use crate::subscriptions::{self, RelayIdentity, WebhookSub};
use crate::wake::{WakeHub, WakeRepo};

/// Wall-clock budget for one repo's poll: past it, the poll stops at the next stream boundary.
const REPO_BUDGET: Duration = Duration::from_secs(20);

/// How often due retries are handed out from the durable queue.
const RETRY_TICK: Duration = Duration::from_secs(5);

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

/// The three forge-v2 contracts.
struct Contracts {
    core: LoadedContract,
    collab: LoadedContract,
    /// forge-community: `event`, `authorEvent`, `checkRun` and `webhook` (RC1 layout).
    community: LoadedContract,
}

impl Contracts {
    /// The contract that holds `doc_type` in the RC1 layout ([`forge_core::layout`]): `event`
    /// and `authorEvent` moved to forge-community.
    fn of(&self, doc_type: &str) -> &LoadedContract {
        let contract = ForgeContract::of(doc_type);
        debug_assert!(contract.is_some(), "{doc_type} is no RC1 type");
        match contract {
            Some(ForgeContract::Collab) => &self.collab,
            Some(ForgeContract::Community) => &self.community,
            Some(ForgeContract::Core) | None => &self.core,
        }
    }
}

/// What every task shares.
struct Shared {
    client: Arc<PlatformClient>,
    /// Every event goes to these too: the `[[sink]]`s and an embedder's.
    sinks: Vec<Arc<dyn EventSink>>,
    contracts: Contracts,
    dispatcher: Dispatcher,
    cfg: RelayConfig,
    /// When this relay started (ms since the epoch).
    started_ms: u64,
    /// Where the check runs seen are kept across restarts.
    check_runs: checkruns::Store,
    /// Runner wake-ups (`[wake]`), when configured.
    wake: Option<Arc<WakeHub>>,
}

/// A head oid whose `checkRun`s are read.
#[derive(Debug, Clone, Copy)]
struct Head {
    /// When it was seen (block time, ms): pruning keeps the newest.
    seen: u64,
    /// Runs created before it are not announced.
    baseline: Baseline,
}

impl Head {
    /// A head first seen at `t` (block time, ms), whose runs count from then.
    fn since(t: u64) -> Self {
        Self {
            seen: t,
            baseline: Baseline::Since(t),
        }
    }
}

/// One served repository and its stream cursors (locked by the poll task that owns it).
struct RepoState {
    meta: RepositoryMeta,
    /// Where repo-level streams start.
    baseline: Baseline,
    /// Cursor per stream key (`refUpdate`, `comment:<targetId>`, ...).
    cursors: BTreeMap<String, Cursor>,
    /// Issues and PRs by `$id` (for event/comment/review translation).
    targets: BTreeMap<String, TargetInfo>,
    /// Closed targets (a close or merge seen; a reopen removes).
    closed: BTreeSet<String>,
    /// Head oids (hex) whose `checkRun`s are read.
    heads: BTreeMap<String, Head>,
    /// Per watched head, the runs seen (persisted: [`checkruns::Store`]).
    runs: BTreeMap<String, checkruns::HeadRuns>,
    /// What was last saved of `heads`/`runs` (a save is skipped when nothing changed).
    saved_runs: Option<checkruns::Saved>,
    /// Set when the repo stops being served: nothing is saved any more.
    retired: Arc<AtomicBool>,
    /// The repo's `config` history (for protected-ref routing).
    configs: Vec<ConfigDoc>,
    /// Every tip a valid update set, by `refNameHash` (hex), for the base refs of known PRs only
    /// (a hash is present once backfilled): what a merge is checked against.
    tips: BTreeMap<String, BTreeSet<String>>,
    /// Round-robin position over the non-priority threads.
    rotation: usize,
    /// The head whose check runs were read last: the next poll starts after it.
    last_head: String,
    /// Which stage group a poll starts at (it resumes where the deadline last stopped it).
    next_stage: usize,
    /// Tags whose newest release revision seen so far was yanked (by `tagName`): a further
    /// delta-0 revision on one of these is `edited`, not a repeated `unpublished`
    /// ([`ingest::translate_release`]).
    yanked_tags: BTreeSet<String>,
}

/// A served repo: its state, and what its hooks want (set by discovery, read by polls).
struct RepoSlot {
    state: tokio::sync::Mutex<RepoState>,
    /// Event → the earliest time a hook wanting it applies from (ms, floored at relay start).
    wants: Mutex<BTreeMap<&'static str, u64>>,
    /// The newest `$createdAt` read (block time), for resuming after a gap.
    high_water: AtomicU64,
    /// No longer served: a poll still running must not save its check runs (shared with the
    /// state, [`RepoState::retired`]).
    retired: Arc<AtomicBool>,
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

/// What an embedder (forge-notify) adds to the relay: its own sink, and a watch set it
/// updates while the relay runs.
#[derive(Default)]
pub struct Embed {
    /// Sinks that get every event, beside the `[[sink]]`s of the config.
    pub sinks: Vec<Arc<dyn EventSink>>,
    /// Repo ids to serve with no `webhook` document, read at every discovery. A repo added
    /// later is read from when it was added; a private repo is refused.
    pub watch_feed: Option<tokio::sync::watch::Receiver<BTreeSet<String>>>,
    /// The events the watch feed's repos are polled for (empty = all).
    pub watch_events: Vec<String>,
}

/// Run the relay daemon until the process is stopped.
pub async fn run(cfg: RelayConfig) -> Result<()> {
    run_with(cfg, Embed::default()).await
}

/// Run the relay daemon with an embedder's sinks and watch feed, until the process is stopped
/// (SIGTERM or ctrl-c).
pub async fn run_with(cfg: RelayConfig, embed: Embed) -> Result<()> {
    let forge = cfg.target.v2.clone().ok_or_else(|| {
        RelayError::Config(format!(
            "forge-v2 is not deployed on {}; the relay serves forge-v2 repositories only",
            cfg.target.network
        ))
    })?;
    let client = Arc::new(PlatformClient::connect(cfg.target.clone()).await?);
    let contracts = Contracts {
        core: client.fetch_contract(&forge.core).await?,
        collab: client.fetch_contract(&forge.collab).await?,
        community: client.fetch_contract(&forge.community).await?,
    };

    let identity = load_identity(&client, &cfg, &forge.community).await?;

    let mut repo_filter = BTreeSet::new();
    for r in &cfg.repos {
        repo_filter.insert(resolve_repo(&client, r).await?.id().to_string());
    }
    let mut statics = Vec::new();
    for w in &cfg.static_webhooks {
        let repo = resolve_repo(&client, &w.repo).await?;
        statics.push(subscriptions::static_subscription(repo.id(), w));
    }
    let wake = match &cfg.wake {
        Some(w) => Some(wake_hub(&client, w, &mut statics).await?),
        None => None,
    };
    let watch_identity = static_watch(&client, &cfg, &mut statics).await?;
    let dynamic_watch = watch_identity.is_some() || embed.watch_feed.is_some();
    let (sinks, unscoped) =
        all_sinks(&client, &cfg, embed.sinks, &mut statics, dynamic_watch).await?;
    if identity.is_none()
        && statics.is_empty()
        && watch_identity.is_none()
        && embed.watch_feed.is_none()
    {
        return Err(RelayError::Config(
            "nothing to serve: pass --identity <relay key file> (webhooks come from Platform), \
             or add [[webhook]] blocks, [wake] repos, or [[sink]]s with [watch] to the config"
                .into(),
        ));
    }

    // Without a relay identity or a static webhook nothing is ever queued for a retry: a
    // watch-only relay (or an embedder) without a state dir needs no warning about one.
    let hooks_possible = identity.is_some() || !cfg.static_webhooks.is_empty();
    let queue = Arc::new(open_queue(&cfg, hooks_possible)?);
    // Only in a state dir this relay holds (the queue's lock): two relays must not share it.
    let check_runs = if queue.is_durable() {
        checkruns::Store::open(cfg.state_dir.as_deref())
    } else {
        checkruns::Store::default()
    };
    spawn_listener(&cfg, queue.is_durable(), wake.clone());

    let shared = Arc::new(Shared {
        client,
        sinks,
        contracts,
        dispatcher: Dispatcher::with_queue(
            Deliverer::new(DeliverConfig {
                allow_private: cfg.allow_private,
                ..Default::default()
            }),
            Some(queue),
        ),
        started_ms: now_ms(),
        check_runs,
        wake,
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
    spawn_discovery(Discovery {
        shared: Arc::clone(&shared),
        repos: Arc::clone(&repos),
        identity,
        repo_filter,
        statics,
        subs: Vec::new(),
        resume_at: BTreeMap::new(),
        watch: DynamicWatch::new(
            watch_identity,
            &shared.cfg,
            embed.watch_feed,
            embed.watch_events,
        ),
        refused: BTreeSet::new(),
        unscoped,
    });

    tokio::select! {
        () = poll_loop(&shared, &repos) => {}
        () = shutdown_signal() => {}
    }
    tracing::info!("stopping: writing undelivered events to the retry queue");
    shared.dispatcher.shutdown(SHUTDOWN_GRACE).await;
    tracing::info!("stopped");
    Ok(())
}

/// The optional listener (`listen`): liveness and runner wake-ups.
fn spawn_listener(cfg: &RelayConfig, durable: bool, wake: Option<Arc<WakeHub>>) {
    if let Some(addr) = cfg.listen.clone() {
        tokio::spawn(async move {
            if let Err(e) = crate::health::serve(&addr, durable, wake).await {
                tracing::error!(error = %e, "listener stopped");
            }
        });
    }
}

/// The relay identity (`--identity`), when Platform webhooks are on.
async fn load_identity(
    client: &PlatformClient,
    cfg: &RelayConfig,
    community: &str,
) -> Result<Option<RelayIdentity>> {
    match &cfg.identity_path {
        Some(path) if cfg.use_platform_webhooks => {
            let id = RelayIdentity::load(client, path, community).await?;
            tracing::info!(relay_identity = %id.id, encryption_keys = ?id.key_ids(), "loaded relay identity");
            Ok(Some(id))
        }
        _ if cfg.sinks.is_empty() && cfg.watch.is_none() && cfg.wake.is_none() => {
            tracing::warn!("no relay identity (or use-platform-webhooks = false): serving static webhooks only");
            Ok(None)
        }
        _ => {
            tracing::info!("no relay identity: serving the config's static webhooks, wake-ups, sinks and watch only");
            Ok(None)
        }
    }
}

/// `[watch] repos`, resolved and added to `statics`; and `[watch] identity`, resolved.
async fn static_watch(
    client: &PlatformClient,
    cfg: &RelayConfig,
    statics: &mut Vec<WebhookSub>,
) -> Result<Option<String>> {
    let Some(watch) = &cfg.watch else {
        return Ok(None);
    };
    for r in &watch.repos {
        let id = resolve_repo(client, r).await?.id().to_string();
        statics.push(subscriptions::watch_subscription(&id, &watch.events, 0));
    }
    match watch.identity.as_deref() {
        Some(who) => Ok(Some(resolve_identity(client, who).await?)),
        None => Ok(None),
    }
}

/// The events `[watch]` polls for (empty = all).
fn watch_events(cfg: &RelayConfig) -> Vec<String> {
    cfg.watch
        .as_ref()
        .map(|w| w.events.clone())
        .unwrap_or_default()
}

/// The `[[sink]]`s, started: each sink's `repos` resolved, and watched for it. Also the union
/// of the events of the sinks without `repos`, if any: the chosen repos are polled for them
/// ([`unscoped_watch`]).
async fn sink_hub(
    client: &Arc<PlatformClient>,
    cfg: &RelayConfig,
    statics: &mut Vec<WebhookSub>,
) -> Result<(Arc<SinkHub>, Option<Vec<String>>)> {
    let mut specs = Vec::new();
    let mut unscoped: Option<Vec<String>> = None;
    for spec in &cfg.sinks {
        let mut ids = BTreeSet::new();
        for r in &spec.repos {
            let id = resolve_repo(client, r).await?.id().to_string();
            statics.push(subscriptions::watch_subscription(&id, &spec.events, 0));
            ids.insert(id);
        }
        if spec.repos.is_empty() {
            unscoped = Some(match unscoped {
                Some(events) => union_events(&events, &spec.events),
                None => spec.events.clone(),
            });
        }
        specs.push((spec.clone(), ids));
    }
    tracing::info!(sinks = specs.len(), "sinks configured");
    let hub = SinkHub::start(specs, Some(&Arc::new(NameCache::new(Arc::clone(client)))))?;
    Ok((Arc::new(hub), unscoped))
}

/// The embedder's sinks and the `[[sink]]`s ([`sink_hub`]), and the sinks without `repos`.
/// Warns when those get nothing: the config chooses no repo (`statics` holds the static
/// webhooks, `[wake]`, `[watch] repos` and the sinks' repos) and nothing is watched dynamically.
async fn all_sinks(
    client: &Arc<PlatformClient>,
    cfg: &RelayConfig,
    mut sinks: Vec<Arc<dyn EventSink>>,
    statics: &mut Vec<WebhookSub>,
    dynamic_watch: bool,
) -> Result<(Vec<Arc<dyn EventSink>>, Option<Unscoped>)> {
    if cfg.sinks.is_empty() {
        return Ok((sinks, None));
    }
    let (hub, events) = sink_hub(client, cfg, statics).await?;
    sinks.push(Arc::clone(&hub) as Arc<dyn EventSink>);
    let unscoped = events.map(|events| Unscoped { hub, events });
    if unscoped.is_some() && statics.is_empty() && !dynamic_watch {
        tracing::warn!(
            "a [[sink]] without repos gets only the repos chosen in the config ([watch], [wake], \
             [[webhook]], the sinks' repos), never those of webhook documents, and none is \
             chosen: it gets nothing. Give it repos or add [watch]"
        );
    }
    Ok((sinks, unscoped))
}

/// The sinks without `repos`: the hub to tell which repos they get, and the union of their
/// events.
struct Unscoped {
    hub: Arc<SinkHub>,
    events: Vec<String>,
}

/// The repos the sinks without `repos` get ([`subscriptions::chosen_repos`]), and a watch
/// subscription for each, so it is polled for those sinks' `events` (from when it was chosen).
fn unscoped_watch(subs: &[WebhookSub], events: &[String]) -> (BTreeSet<String>, Vec<WebhookSub>) {
    let chosen = subscriptions::chosen_repos(subs);
    let watch = chosen
        .iter()
        .map(|(repo, since)| subscriptions::watch_subscription(repo, events, *since))
        .collect();
    (chosen.into_keys().collect(), watch)
}

/// An identity id, or a DPNS name (`alice`, `alice.dash`) resolved to one.
async fn resolve_identity(client: &PlatformClient, who: &str) -> Result<String> {
    if decode_identifier(who).is_ok() {
        return Ok(who.to_string());
    }
    client.resolve_dpns_name(who).await?.ok_or_else(|| {
        RelayError::Config(format!(
            "[watch] identity: no DPNS name {who:?} is registered"
        ))
    })
}

/// The most watched repos read for `[watch] identity`; past this a warning says so.
const MAX_WATCHED_REPOS: usize = 1000;

/// The repos `identity` watches: its public forge-community `watch` documents (the `byOwner`
/// index, every page up to [`MAX_WATCHED_REPOS`]), bounded by [`DISCOVERY_TIMEOUT`].
async fn watched_repos(shared: &Shared, identity: &str) -> Result<BTreeSet<String>> {
    let filter = [QueryFilter::eq(
        "$ownerId",
        FieldValue::identifier(decode_identifier(identity)?),
    )];
    let read = shared.client.query_documents_up_to(
        &shared.contracts.community,
        forge_core::collab::v2::DOC_WATCH,
        &filter,
        &[],
        MAX_WATCHED_REPOS,
    );
    let docs = tokio::time::timeout(DISCOVERY_TIMEOUT, read)
        .await
        .map_err(|_| RelayError::Config("reading the watched repos timed out".into()))??;
    if docs.len() > MAX_WATCHED_REPOS {
        tracing::warn!(
            identity,
            max = MAX_WATCHED_REPOS,
            "[watch] identity watches more repos than the relay follows; the rest are skipped"
        );
    }
    Ok(docs
        .iter()
        .take(MAX_WATCHED_REPOS)
        .filter_map(|d| d.field_bytes32("repoId"))
        .map(forge_core::platform::encode_identifier)
        .collect())
}

/// Runner wake-ups (`[wake]`): resolve each repo and serve it like a static hook that is never
/// delivered ([`subscriptions::wake_subscription`]), so it is polled for pushes and PRs.
async fn wake_hub(
    client: &PlatformClient,
    w: &crate::config::WakeConfig,
    statics: &mut Vec<WebhookSub>,
) -> Result<Arc<WakeHub>> {
    let mut repos = BTreeMap::new();
    for label in &w.repos {
        let repo = resolve_repo(client, label).await?;
        statics.push(subscriptions::wake_subscription(repo.id()));
        repos.insert(
            repo.id().to_string(),
            WakeRepo {
                name: format!("{}/{}", repo.owner_id(), repo.name()),
                label: label.clone(),
            },
        );
    }
    tracing::info!(repos = repos.len(), "runner wake-ups on the listener");
    Ok(Arc::new(WakeHub::new(w.secret.clone(), repos)))
}

/// Run discovery in its own task, every `refresh_cycles` poll intervals.
fn spawn_discovery(mut discovery: Discovery) {
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
}

/// How long a graceful stop waits for the hook workers (within `docker stop`'s default 10 s).
const SHUTDOWN_GRACE: Duration = Duration::from_secs(5);

/// SIGTERM (`docker stop`, systemd) or ctrl-c.
async fn shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        match signal(SignalKind::terminate()) {
            Ok(mut term) => {
                tokio::select! {
                    _ = term.recv() => {}
                    _ = tokio::signal::ctrl_c() => {}
                }
                return;
            }
            Err(e) => {
                tracing::warn!(error = %e, "cannot watch for SIGTERM; only ctrl-c stops gracefully");
            }
        }
    }
    let _ = tokio::signal::ctrl_c().await;
}

/// Every poll interval, poll each served repo in its own task, at most
/// [`MAX_CONCURRENT_REPOS`] at once; a repo whose previous poll is still running is skipped.
async fn poll_loop(shared: &Arc<Shared>, repos: &Repos) -> ! {
    // Due retries from the durable queue, handed to their hooks' workers every few seconds.
    let retries = Arc::clone(shared);
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(RETRY_TICK);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tick.tick().await;
            retries.dispatcher.dispatch_retries();
        }
    });
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

/// The durable retry queue in the state dir.
///
/// * A state dir chosen explicitly (`--state-dir`, `state-dir`) that cannot be used is fatal:
///   the operator asked for durability.
/// * The default one (a read-only root, a volume the relay user cannot write) falls back to an
///   in-memory queue, with a warning on every start and `"durable": false` on the health
///   endpoint: webhooks are delivered and retried, but pending retries are lost on restart.
/// * Another relay holding the queue is always fatal (two relays would deliver the same
///   retries).
fn open_queue(cfg: &RelayConfig, hooks_possible: bool) -> Result<RetryQueue> {
    // Nothing is ever queued for a retry without a hook: a watch-only relay (or an embedder)
    // must not take, and lock, the default state dir another relay of this user may own.
    if !hooks_possible && !cfg.state_dir_explicit {
        return Ok(RetryQueue::in_memory(cfg.retry_schedule.clone()));
    }
    let not_durable = "the delivery queue is NOT durable: the default state dir cannot be used, \
                       so failed deliveries are retried from memory only and lost when the \
                       relay restarts. Give the relay a writable state dir it owns: \
                       --state-dir, FORGE_RELAY_STATE_DIR, or a volume at /state in the \
                       container images";
    let Some(state_dir) = &cfg.state_dir else {
        tracing::warn!(
            error = "no FORGE_RELAY_STATE_DIR, XDG_STATE_HOME or HOME to derive it from",
            "{not_durable}"
        );
        return Ok(RetryQueue::in_memory(cfg.retry_schedule.clone()));
    };
    match RetryQueue::open(state_dir, cfg.retry_schedule.clone()) {
        Ok(q) => Ok(q),
        Err(e @ RelayError::StateLocked(_)) => Err(e),
        Err(e) if cfg.state_dir_explicit => Err(RelayError::Config(format!(
            "the delivery queue's state dir cannot be used: {e}. Fix it (a directory this user \
             owns and can write), or leave --state-dir / state-dir unset to run with a \
             non-durable queue"
        ))),
        Err(e) => {
            tracing::warn!(state_dir = %state_dir.display(), error = %e, "{not_durable}");
            Ok(RetryQueue::in_memory(cfg.retry_schedule.clone()))
        }
    }
}

/// `owner/name` or a repo id → the forge-v2 repo.
async fn resolve_repo(client: &PlatformClient, r: &str) -> Result<RepoRef> {
    Ok(match r.split_once('/') {
        Some((owner, name)) => forge_core::resolve::resolve_named(client, owner, name).await?,
        None => forge_core::resolve::resolve_id(client, r).await?,
    })
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
    /// The watch sets that change while running.
    watch: DynamicWatch,
    /// Repos refused for good (private): never set up again.
    refused: BTreeSet<String>,
    /// The sinks without `repos`, if any.
    unscoped: Option<Unscoped>,
}

/// The union of two event filters, where empty (or `*`) means every event.
fn union_events(a: &[String], b: &[String]) -> Vec<String> {
    let all = |e: &[String]| e.is_empty() || e.iter().any(|x| x == "*");
    if all(a) || all(b) {
        return Vec::new();
    }
    let mut out: Vec<String> = a.iter().chain(b).cloned().collect();
    out.sort();
    out.dedup();
    out
}

/// The watch sets read at every discovery: `[watch] identity`'s watched repos and an
/// embedder's feed.
struct DynamicWatch {
    /// `[watch] identity`, resolved.
    identity: Option<String>,
    /// The events its repos are polled for.
    identity_events: Vec<String>,
    /// Its repos as last read (kept when a read fails).
    identity_repos: BTreeSet<String>,
    /// The embedder's feed.
    feed: Option<tokio::sync::watch::Receiver<BTreeSet<String>>>,
    /// The events the feed's repos are polled for.
    feed_events: Vec<String>,
    /// When each watched repo joined the set (0: at startup).
    since: BTreeMap<String, u64>,
}

impl DynamicWatch {
    fn new(
        identity: Option<String>,
        cfg: &RelayConfig,
        feed: Option<tokio::sync::watch::Receiver<BTreeSet<String>>>,
        feed_events: Vec<String>,
    ) -> Self {
        Self {
            identity,
            identity_events: watch_events(cfg),
            identity_repos: BTreeSet::new(),
            feed,
            feed_events,
            since: BTreeMap::new(),
        }
    }

    /// The watch subscriptions now. A repo that joined after startup is read from then.
    async fn subscriptions(&mut self, shared: &Shared, startup: bool) -> Vec<WebhookSub> {
        let mut wanted: BTreeMap<String, Vec<String>> = BTreeMap::new();
        if let Some(who) = &self.identity {
            match watched_repos(shared, who).await {
                Ok(repos) => self.identity_repos = repos,
                Err(e) => {
                    tracing::warn!(error = %e, "reading the watched repos failed; keeping the previous set");
                }
            }
            for r in &self.identity_repos {
                wanted.insert(r.clone(), self.identity_events.clone());
            }
        }
        if let Some(feed) = &self.feed {
            for r in feed.borrow().iter() {
                match wanted.get_mut(r) {
                    Some(events) => *events = union_events(events, &self.feed_events),
                    None => {
                        wanted.insert(r.clone(), self.feed_events.clone());
                    }
                }
            }
        }
        let now = now_ms();
        self.since.retain(|r, _| wanted.contains_key(r));
        wanted
            .into_iter()
            .map(|(repo, events)| {
                let since =
                    *self
                        .since
                        .entry(repo.clone())
                        .or_insert(if startup { 0 } else { now });
                subscriptions::watch_subscription(&repo, &events, since)
            })
            .collect()
    }
}

impl Discovery {
    /// Re-run discovery, reconcile the served repos with it, and resync the delivery workers.
    async fn refresh(&mut self, startup: bool) -> Result<()> {
        let shared = Arc::clone(&self.shared);
        let mut subs = self.statics.clone();
        subs.extend(self.watch.subscriptions(&shared, startup).await);
        let mut failed = BTreeSet::new();
        if let Some(identity) = &self.identity {
            let found = tokio::time::timeout(
                DISCOVERY_TIMEOUT,
                subscriptions::platform_subscriptions(
                    &shared.client,
                    identity,
                    &shared.contracts.community.id(),
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
        // A private repo is refused for good, whichever subscription named it.
        subs.retain(|s| !self.refused.contains(&s.repo_id));
        // Sinks without `repos` get the chosen repos, never those of webhook documents only.
        if let Some(u) = &self.unscoped {
            let (covered, watch) = unscoped_watch(&subs, &u.events);
            u.hub.set_covered(covered);
            subs.extend(watch);
        }
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
                    // Its check runs seen are dropped: a hook added later starts from its
                    // own time, not from completions of runs seen before it existed. Retired
                    // first, so a poll still running saves nothing more; removed under the
                    // state lock, after that poll (and any save it was in) finished.
                    slot.retired.store(true, Ordering::SeqCst);
                    let (slot, shared, id) = (Arc::clone(slot), Arc::clone(&shared), id.clone());
                    tokio::spawn(async move {
                        let _state = slot.state.lock().await;
                        shared.check_runs.remove(&id);
                    });
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
        // Where this pass knows the hooks for sure: the relay index was read (else this returned
        // an error above), the repo's own hooks were read, and it is served, or has no hook at
        // all. A repo that failed to read or to set up is not judged (its retries wait).
        let queued_repos = shared.dispatcher.queued_repos();
        let authoritative: std::collections::HashSet<String> = served
            .iter()
            .chain(queued_repos.iter())
            .filter(|r| !failed.contains(*r))
            .filter(|r| served.contains(*r) || !wanted.contains_key(*r))
            .filter(|r| self.repo_filter.is_empty() || self.repo_filter.contains(*r))
            .cloned()
            .collect();
        // Wake-up and watch subscriptions only make a repo served; they are never delivered.
        let hooks: Vec<WebhookSub> = subs.iter().filter(|s| !s.is_internal()).cloned().collect();
        shared.dispatcher.sync(&hooks, &authoritative);
        let hooked: BTreeSet<&str> = hooks.iter().map(|h| h.repo_id.as_str()).collect();
        shared.dispatcher.set_hookless(
            subs.iter()
                .filter(|s| !hooked.contains(s.repo_id.as_str()))
                .map(|s| s.repo_id.clone())
                .collect(),
        );
        for (repo_id, slot) in repos.iter().chain(ready.iter().map(|(k, v)| (k, v))) {
            *lock(&slot.wants) = wants_of(&subs, repo_id, shared.started_ms);
        }
        repos.extend(ready);
        self.subs = subs;

        let after: BTreeSet<String> = repos.keys().cloned().collect();
        if before != after || startup {
            tracing::info!(
                repos = after.len(),
                hooks = self.subs.iter().filter(|s| !s.is_internal()).count(),
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
                            retired: Arc::clone(&state.retired),
                            state: tokio::sync::Mutex::new(state),
                            wants: Mutex::new(BTreeMap::new()),
                            high_water: AtomicU64::new(high),
                        }),
                    ));
                }
                Ok(Err(RelayError::PrivateRepo(_))) => {
                    tracing::info!(repo = %repo_id, "a private repository: the relay does not serve it (not retried)");
                    self.refused.insert(repo_id);
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

/// PRs follow their branch through `headUpdate` events (review-parity spec §4.6): fold the
/// repo's event feeds, oldest first, so each PR's head is its newest update, and watch recently
/// active PRs' current heads for check runs.
async fn fold_head_updates(
    shared: &Shared,
    repo_id: &str,
    baseline: Baseline,
    recent: u64,
    targets: &mut BTreeMap<String, TargetInfo>,
    heads: &mut BTreeMap<String, Head>,
) -> Result<()> {
    for (doc_type, author_path) in [(DOC_EVENT, false), (DOC_AUTHOR_EVENT, true)] {
        let contract = shared.contracts.of(doc_type);
        for d in read_all(shared, contract, doc_type, repo_id).await? {
            let Some(t) = d
                .field_bytes32("targetId")
                .map(forge_core::platform::encode_identifier)
                .and_then(|tid| targets.get_mut(&tid))
            else {
                continue;
            };
            if t.apply_head_update(&d, author_path).is_some() {
                t.last_activity = t.last_activity.max(d.created_at.unwrap_or(0));
            }
            if !author_path {
                t.apply_retarget(&d);
            }
        }
    }
    // Watch the current head (not every intermediate one) of each recently active PR.
    for t in targets
        .values()
        .filter(|t| t.is_pr && t.head_set_by.is_some() && !t.members_only)
    {
        if t.last_activity >= recent {
            heads.insert(
                t.head_oid.clone(),
                Head {
                    seen: t.last_activity,
                    baseline,
                },
            );
        }
    }
    Ok(())
}

/// Resolve a repo's metadata, config history, issue/PR index, valid ref tips, and recently
/// opened PR heads.
async fn init_repo(shared: &Shared, repo_id: &str, baseline: Baseline) -> Result<RepoState> {
    let (core, collab) = (&shared.contracts.core, &shared.contracts.collab);
    let Some(repo_doc) = shared
        .client
        .fetch_document(core, forge_core::resolve::DOC_REPO, repo_id)
        .await?
    else {
        return Err(RelayError::Config(format!(
            "{repo_id}: no such forge-v2 repository"
        )));
    };
    let owner_id = &repo_doc.owner_id;
    let name = repo_doc
        .field_str("name")
        .ok_or_else(|| RelayError::Config(format!("repo {repo_id} has no name")))?;
    if forge_core::scope::visibility_of(&repo_doc) == Visibility::Private {
        // A private repo's content is encrypted to its members; the relay is not one.
        return Err(RelayError::PrivateRepo(repo_id.to_string()));
    }
    let config_docs = read_all(shared, core, "config", repo_id).await?;
    let configs: Vec<ConfigDoc> = config_docs.iter().map(config_doc).collect();
    // The newest config's default branch, else the repo document's.
    let default_branch = config_docs
        .iter()
        .rev()
        .chain(std::iter::once(&repo_doc))
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
            // A members-only PR's head is a blind (DESIGN D4): no check run is reported on it.
            if is_pr && !t.head_oid.is_empty() && !t.members_only && t.last_activity >= recent {
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
    fold_head_updates(shared, repo_id, baseline, recent, &mut targets, &mut heads).await?;
    // The heads and runs the relay watched before a restart: a run seen then is not
    // re-sent, and one that completed meanwhile is sent now (`completed`). Runs created
    // while the relay was down are not replayed, like every other stream: a stream never
    // starts before the relay does (`wants_of`). Heads first seen before the active window
    // are not restored, as they would not be watched from scratch either.
    // Only at startup (a `Tail` baseline): a repo set up later is one that was not served
    // (or dropped out), whose runs seen belong to hooks that are gone.
    let saved = match baseline {
        Baseline::Tail { .. } => shared.check_runs.load(repo_id),
        Baseline::Since(_) | Baseline::Beginning => checkruns::Saved::default(),
    };
    let mut runs = BTreeMap::new();
    for (oid, saved) in saved.heads {
        if saved.seen < recent && !heads.contains_key(&oid) {
            continue;
        }
        heads.entry(oid.clone()).or_insert(Head::since(saved.seen));
        runs.insert(oid, saved.runs);
    }
    prune_heads(&mut heads, &mut runs);
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
        closed: seed_states(shared, &mut targets).await,
        targets,
        heads,
        runs,
        saved_runs: None,
        retired: Arc::default(),
        configs,
        tips: BTreeMap::new(),
        rotation: 0,
        last_head: String::new(),
        next_stage: 0,
        yanked_tags: BTreeSet::new(),
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
            .flat_map(TargetInfo::base_hashes)
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

    /// Save the watched heads and their runs, if they changed since the last save.
    async fn save_check_runs(&mut self, shared: &Shared) {
        let now = checkruns::Saved {
            heads: self
                .heads
                .iter()
                .map(|(oid, h)| {
                    (
                        oid.clone(),
                        checkruns::SavedHead {
                            seen: h.seen,
                            runs: self.runs.get(oid).cloned().unwrap_or_default(),
                        },
                    )
                })
                .collect(),
        };
        // Recorded only once written, so a failed write is retried next cycle.
        if !self.retired.load(Ordering::SeqCst)
            && self.saved_runs.as_ref() != Some(&now)
            && shared.check_runs.save(&self.meta.repo_id, &now).await
        {
            self.saved_runs = Some(now);
        }
    }

    /// Wake the repo's runners, if any long-poll the relay ([`crate::wake`]).
    fn wake(&self, shared: &Shared) {
        if let Some(hub) = &shared.wake {
            hub.notify(&self.meta.repo_id);
        }
    }

    /// Enqueue `event` for the repo's hooks, and wake the repo's runners on a push or a pull
    /// request's activity.
    fn emit(&self, shared: &Shared, event: Option<crate::payload::WebhookEvent>) {
        if let Some(event) = event {
            if subscriptions::WAKE_EVENTS.contains(&event.event) {
                self.wake(shared);
            }
            for sink in &shared.sinks {
                sink.accept(&self.meta.repo_id, &event);
            }
            shared.dispatcher.enqueue(&self.meta.repo_id, event);
        }
    }

    /// Whether a merge transition's `oid` was set on the PR's base ref by a valid update (see
    /// [`ingest::translate_transition`]). `true` for other kinds (nothing to check). The base
    /// ref's hash must be `sha256(baseRefName)`, or the merge commit is "not found on the base".
    ///
    /// A second close, or a close after a merge, needs no filter here: consensus refuses both
    /// (the target's state code allows one close per open, and a merge is terminal), so each
    /// stored transition is one GitHub action (D-602).
    fn merge_on_base(&self, d: &FetchedDocument) -> bool {
        if d.field_u64("kind") != Some(u64::from(forge_core::rules::transition::PR_MERGE)) {
            return true;
        }
        let target = d
            .field_bytes32("targetId")
            .map(forge_core::platform::encode_identifier)
            .and_then(|id| self.targets.get(&id));
        match (target, d.field_hex("oid")) {
            (Some(t), Some(oid)) => {
                // The base as of the merge: a retarget written after it does not count.
                let (base_ref, base_ref_hash) = t.merge_base_at(d.created_at.unwrap_or(u64::MAX));
                rules::ref_name_hash_matches(&base_ref, &base_ref_hash)
                    && self
                        .tips
                        .get(&base_ref_hash.to_ascii_lowercase())
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
                    st.heads.entry(oid).or_insert(Head::since(t));
                    prune_heads(&mut st.heads, &mut st.runs);
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
    let base = st.baseline;
    let mut high = 0;

    // The event feeds before the transitions: a retarget read in the same cycle as the merge
    // after it is known when the merge is judged (against the base as of the merge,
    // `TargetInfo::merge_base_at`), and its new base's tips are read first.
    let streams = [
        DOC_RELEASE,
        DOC_ISSUE,
        DOC_PATCH,
        DOC_EVENT,
        DOC_AUTHOR_EVENT,
        DOC_TRANSITION,
    ];
    for doc_type in streams {
        let contract = shared.contracts.of(doc_type);
        if Instant::now() >= deadline {
            return (high, false);
        }
        if matches!(doc_type, DOC_TRANSITION | DOC_EVENT | DOC_AUTHOR_EVENT) {
            if !pushes_read {
                // Merges would be checked against tips missing this cycle's pushes.
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
                DOC_RELEASE => {
                    let was_yanked = note_release_yanked(st, d);
                    ingest::translate_release(&st.meta, d, was_yanked)
                }
                DOC_ISSUE | DOC_PATCH => {
                    // A thread first seen live: everything on it is new (bounded below by the
                    // hooks that want its comments; see `no_earlier_than`).
                    let t = if doc_type == DOC_PATCH {
                        TargetInfo::from_patch(d, Baseline::Beginning)
                    } else {
                        TargetInfo::from_issue(d, Baseline::Beginning)
                    };
                    if doc_type == DOC_PATCH && !t.head_oid.is_empty() && !t.members_only {
                        let seen = t.last_activity;
                        st.heads
                            .entry(t.head_oid.clone())
                            .or_insert(Head::since(seen));
                        prune_heads(&mut st.heads, &mut st.runs);
                    }
                    st.targets.insert(d.id.clone(), t);
                    if doc_type == DOC_PATCH {
                        ingest::translate_patch(&st.meta, d)
                    } else {
                        ingest::translate_issue(&st.meta, d)
                    }
                }
                DOC_TRANSITION => {
                    let on_base = st.merge_on_base(d);
                    note_transition(st, d);
                    ingest::translate_transition(&st.meta, d, &st.targets, on_base, &st.closed)
                }
                _ if is_rerun_request(doc_type, d) => {
                    // A CI re-run request (event kind 26) has no GitHub webhook of its own: it
                    // wakes the repository's runners, which read it themselves (`dg ci
                    // reruns`), and is delivered to no hook.
                    st.wake(shared);
                    None
                }
                _ => {
                    note_activity(st, d);
                    // A head update that did not move the head (older, stranger's, malformed)
                    // is not a `synchronize`.
                    let moved = follow_head(st, d, doc_type == DOC_AUTHOR_EVENT);
                    let retargeted_from = if doc_type == DOC_EVENT {
                        follow_base(st, d)
                    } else {
                        None
                    };
                    if d.field_u64("kind") == Some(16) && !moved {
                        None
                    } else {
                        ingest::translate_event(doc_type, &st.meta, d, &st.targets, &st.closed).map(
                            |mut e| {
                                // GitHub's `edited` names the base the PR left.
                                if let Some(from) = retargeted_from {
                                    e.payload["changes"] =
                                        serde_json::json!({ "base": { "ref": { "from": from } } });
                                }
                                e
                            },
                        )
                    }
                }
            };
            st.emit(shared, event);
        }
        high = high.max(st.commit(r));
    }
    (high, true)
}

/// Whether `d`, read from the `doc_type` stream, is a CI re-run request: a member `event` of
/// kind 26 (`forge_core::rules::ci_rerun`). Its runners judge it; the relay only wakes them.
fn is_rerun_request(doc_type: &str, d: &FetchedDocument) -> bool {
    doc_type == DOC_EVENT && d.field_u64("kind") == Some(forge_core::rules::ci_rerun::CI_RERUN_KIND)
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
                // A stranger's members-only comment is not activity anyone is shown (D14).
                if let Some(t) = st
                    .targets
                    .get_mut(&tid)
                    .filter(|_| ingest::reportable(doc_type, d))
                {
                    t.last_activity = t.last_activity.max(d.created_at.unwrap_or(0));
                }
                let event = if doc_type == DOC_REVIEW {
                    ingest::translate_review(&st.meta, d, &st.targets, &st.closed)
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

/// Check runs, per watched head oid (the newest [`MAX_HEADS`]): each head's runs from
/// [`checkruns::read_from`] on (the `head (repoId, headOid, $createdAt)` index, paged to the
/// end), compared by `$revision` with what was seen, so a run replaced in place is observed
/// ([`checkruns::diff`]: `created`, then `completed`). The runs seen are saved when they
/// change, after their events were enqueued. While no hook wants `check_run`, they are
/// dropped: a hook added later starts from its own time, not from stale completions.
async fn poll_check_runs(
    shared: &Shared,
    st: &mut RepoState,
    rf: &QueryFilter,
    wants: &BTreeMap<&'static str, u64>,
    deadline: Instant,
) -> (u64, bool) {
    let Some(since) = wants.get("check_run").copied() else {
        if !st.runs.is_empty() {
            st.runs.clear();
            st.save_check_runs(shared).await;
        }
        return (0, true);
    };
    let mut high = 0;
    let mut finished = true;
    for (oid, head) in heads_after(&st.heads, &st.last_head) {
        if Instant::now() >= deadline {
            finished = false;
            break;
        }
        st.last_head.clone_from(&oid);
        let Ok(bytes) = hex::decode(&oid) else {
            continue;
        };
        let prefix = [
            rf.clone(),
            QueryFilter::eq("headOid", FieldValue::bytes(bytes)),
        ];
        let source = LiveStream {
            client: &shared.client,
            contract: &shared.contracts.community,
            doc_type: DOC_CHECK_RUN,
            prefix: &prefix,
        };
        let Baseline::Since(floor) = no_earlier_than(head.baseline, since) else {
            unreachable!("no_earlier_than returns a Since")
        };
        let prev = st.runs.remove(&oid).unwrap_or_default();
        let from = checkruns::read_from(&prev, floor);
        let docs = match checkruns::read_runs(&source, from, || Instant::now() >= deadline).await {
            Ok(docs) => docs,
            Err(e) => {
                tracing::warn!(repo = %st.meta.repo_id, head = %oid, error = %e, "check-run read failed; retrying next cycle");
                st.runs.insert(oid, prev);
                continue;
            }
        };
        let (events, next) = checkruns::diff(&prev, &docs, floor, from);
        for (action, d) in events {
            if action == CheckRunAction::Created {
                high = high.max(d.created_at.unwrap_or(0));
            }
            st.emit(shared, ingest::translate_check_run(&st.meta, d, action));
        }
        st.runs.insert(oid, next);
    }
    st.save_check_runs(shared).await;
    (high, finished)
}

/// The targets' state now, from their proved state codes (one grouped sum of
/// `transition.delta` per 100 targets): each PR's draft flag is set, and the targets that are
/// closed or merged are returned (which threads a poll reads first). A read that fails starts
/// every thread open and ready (it only orders reads and fills payloads) and says so.
async fn seed_states(
    shared: &Shared,
    targets: &mut BTreeMap<String, TargetInfo>,
) -> BTreeSet<String> {
    let mut codes = BTreeMap::new();
    let ids: Vec<[u8; 32]> = targets
        .keys()
        .filter_map(|id| decode_identifier(id).ok())
        .collect();
    for chunk in ids.chunks(100) {
        let filter = QueryFilter::in_list(
            "targetId",
            chunk.iter().map(|id| FieldValue::identifier(*id)).collect(),
        );
        match shared
            .client
            .sum_documents_grouped(
                &shared.contracts.collab,
                DOC_TRANSITION,
                &[filter],
                "targetId",
                "delta",
            )
            .await
        {
            Ok(sums) => codes.extend(sums),
            Err(e) => {
                tracing::warn!(error = %e, "target states unavailable; every thread starts as open");
                return BTreeSet::new();
            }
        }
    }
    apply_codes(&codes, targets)
}

/// Apply a grouped sum's state codes: set each PR's draft and merged flags, and return the
/// targets that are not open (closed, or merged).
fn apply_codes(
    codes: &BTreeMap<Vec<u8>, i64>,
    targets: &mut BTreeMap<String, TargetInfo>,
) -> BTreeSet<String> {
    let mut closed = BTreeSet::new();
    for (k, &code) in codes {
        let Some(id) = forge_core::platform::decode_identifier_key(k) else {
            continue;
        };
        let status = rules::v2::status_of_code(code);
        if let Some(t) = targets.get_mut(&id) {
            t.draft = t.is_pr && status.draft;
            t.merged = t.is_pr && status.merged;
        }
        if !status.open {
            closed.insert(id);
        }
    }
    closed
}

/// Record an event's effect on its target: its activity time.
fn note_activity(s: &mut RepoState, d: &FetchedDocument) -> Option<String> {
    let tid = d
        .field_bytes32("targetId")
        .map(forge_core::platform::encode_identifier)?;
    if let Some(t) = s.targets.get_mut(&tid) {
        t.last_activity = t.last_activity.max(d.created_at.unwrap_or(0));
    }
    Some(tid)
}

/// Record a transition's effect on its target: activity time, and open / closed (which
/// threads are read first, [`threads_this_cycle`]).
fn note_transition(s: &mut RepoState, d: &FetchedDocument) {
    let Some(tid) = note_activity(s, d) else {
        return;
    };
    // A lock or unlock is no state move: it leaves the draft flag and open / closed alone.
    let Some(kind) = d.field_u64("kind") else {
        return;
    };
    let Some((_, open, merged)) = ingest::transition_action(kind) else {
        return;
    };
    if let Some(t) = s.targets.get_mut(&tid) {
        t.draft = t.is_pr && ingest::draft_after(kind);
        // Consensus refuses every state move out of merged (it is terminal, lock/unlock
        // aside), so `merged` should never legitimately go back to `false` here; `||` is
        // defensive, not load-bearing.
        t.merged = t.merged || merged;
        if merged {
            t.settle_merge(d.created_at.unwrap_or(u64::MAX));
        }
    }
    if open {
        s.closed.remove(&tid);
    } else {
        s.closed.insert(tid);
    }
}

/// Record a release revision's tag against [`RepoState::yanked_tags`], returning whether the
/// tag's *previous* revision was already yanked (before this update) -- the `was_yanked` a
/// delta-0 revision needs to tell a fresh yank from a further edit of one already yanked
/// ([`ingest::translate_release`]).
fn note_release_yanked(s: &mut RepoState, d: &FetchedDocument) -> bool {
    // A members-only revision's `tagName` is keyed, and may equal a public tag: it is not
    // reported and must not move the public tag's yanked state.
    if ingest::is_sealed(d) {
        return false;
    }
    let tag = d.field_str("tagName").unwrap_or_default();
    let was_yanked = s.yanked_tags.contains(&tag);
    if d.field_bool("yanked") {
        s.yanked_tags.insert(tag);
    } else {
        s.yanked_tags.remove(&tag);
    }
    was_yanked
}

/// A live `headUpdate`: move the PR's head, and watch the new head for check runs from now.
/// Whether the head moved.
fn follow_head(s: &mut RepoState, d: &FetchedDocument, author_path: bool) -> bool {
    let Some(tid) = d
        .field_bytes32("targetId")
        .map(forge_core::platform::encode_identifier)
    else {
        return false;
    };
    let Some(t) = s.targets.get_mut(&tid) else {
        return false;
    };
    let Some(head) = t.apply_head_update(d, author_path) else {
        return false;
    };
    if t.members_only {
        return true;
    }
    let seen = d.created_at.unwrap_or(t.last_activity);
    s.heads.entry(head).or_insert(Head::since(seen));
    prune_heads(&mut s.heads, &mut s.runs);
    true
}

/// Apply a retarget (event kind 8) to its PR, unless the PR's merge was already seen; returns
/// the base it left. The new base's tips are read before the next merge is judged
/// (`backfill_tips`, called before the transitions).
fn follow_base(s: &mut RepoState, d: &FetchedDocument) -> Option<String> {
    let tid = d
        .field_bytes32("targetId")
        .map(forge_core::platform::encode_identifier)?;
    let t = s.targets.get_mut(&tid).filter(|t| !t.merged)?;
    t.apply_retarget(d)
}

/// Every head, starting after `last` (the one read last) and wrapping around, so a poll the
/// deadline cuts short resumes with the heads it did not reach.
fn heads_after(heads: &BTreeMap<String, Head>, last: &String) -> Vec<(String, Head)> {
    use std::ops::Bound::{Excluded, Unbounded};
    heads
        .range::<String, _>((Excluded(last), Unbounded))
        .chain(heads.range::<String, _>(..=last))
        .map(|(k, v)| (k.clone(), *v))
        .collect()
}

/// Keep the newest [`MAX_HEADS`] head oids (and only their runs).
fn prune_heads(
    heads: &mut BTreeMap<String, Head>,
    runs: &mut BTreeMap<String, checkruns::HeadRuns>,
) {
    if heads.len() > MAX_HEADS {
        let mut by_time: Vec<(u64, String)> =
            heads.iter().map(|(k, v)| (v.seen, k.clone())).collect();
        by_time.sort();
        for (_, k) in &by_time[..heads.len() - MAX_HEADS] {
            heads.remove(k);
        }
    }
    runs.retain(|k, _| heads.contains_key(k));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unscoped_sinks_watch_the_chosen_repos_only() {
        let v = |e: &[&str]| e.iter().map(ToString::to_string).collect::<Vec<_>>();
        let mut hook = subscriptions::watch_subscription("HOOKED", &[], 5);
        hook.document_id = Some("doc".into());
        hook.url = "https://ci.example/h".into();
        let subs = vec![
            hook,
            subscriptions::watch_subscription("WATCHED", &v(&["push"]), 40),
            subscriptions::wake_subscription("WAKE"),
        ];
        let (covered, watch) = unscoped_watch(&subs, &v(&["issues"]));
        assert_eq!(
            covered,
            BTreeSet::from(["WAKE".to_string(), "WATCHED".to_string()])
        );
        let got: Vec<_> = watch
            .iter()
            .map(|w| {
                (
                    w.repo_id.as_str(),
                    w.created_at,
                    w.events.clone(),
                    w.is_internal(),
                )
            })
            .collect();
        assert_eq!(
            got,
            vec![
                ("WAKE", 0, v(&["issues"]), true),
                ("WATCHED", 40, v(&["issues"]), true),
            ]
        );
    }

    #[test]
    fn watch_event_filters_union_with_empty_meaning_all() {
        let v = |e: &[&str]| e.iter().map(ToString::to_string).collect::<Vec<_>>();
        assert!(union_events(&v(&["push"]), &[]).is_empty());
        assert!(union_events(&v(&["*"]), &v(&["push"])).is_empty());
        assert_eq!(
            union_events(&v(&["push", "issues"]), &v(&["release", "push"])),
            v(&["issues", "push", "release"])
        );
    }

    #[test]
    fn an_unusable_default_state_dir_falls_back_to_memory_but_not_an_explicit_one() {
        let base = std::env::temp_dir().join(format!("relay-openq-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let cfg_for = |dir: std::path::PathBuf| {
            RelayConfig::load(
                None,
                &crate::config::CliOverrides {
                    state_dir: Some(dir),
                    ..Default::default()
                },
            )
            .unwrap()
        };
        // Not a directory at all (as a read-only root or a foreign-owned volume would fail):
        // fatal when chosen explicitly, a fallback to memory when it is the default.
        let file = base.join("not-a-dir");
        std::fs::write(&file, "x").unwrap();
        let mut cfg = cfg_for(file);
        assert!(matches!(open_queue(&cfg, true), Err(RelayError::Config(_))));
        cfg.state_dir_explicit = false;
        let q = open_queue(&cfg, true).unwrap();
        assert!(!q.is_durable(), "runs, in memory");
        // A usable dir is durable; a second relay on it does not start.
        let cfg = cfg_for(base.join("state"));
        let held = open_queue(&cfg, true).unwrap();
        assert!(held.is_durable());
        assert!(matches!(
            open_queue(&cfg, true),
            Err(RelayError::StateLocked(_))
        ));
        drop(held);
        std::fs::remove_dir_all(&base).ok();
    }

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
                        head_set_by: None,
                        retargets: Vec::new(),
                        opened_base: None,
                        base_ref_hash: String::new(),
                        baseline: Baseline::Beginning,
                        last_activity: 0,
                        draft: false,
                        merged: false,
                        members_only: false,
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
            runs: BTreeMap::new(),
            saved_runs: None,
            retired: Arc::default(),
            configs: Vec::new(),
            tips: BTreeMap::new(),
            rotation: 0,
            last_head: String::new(),
            next_stage: 0,
            yanked_tags: BTreeSet::new(),
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
            head_set_by: None,
            retargets: Vec::new(),
            opened_base: None,
            base_ref_hash: base_ref_hash.into(),
            baseline: Baseline::Beginning,
            last_activity: 0,
            draft: false,
            merged: false,
            members_only: false,
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
            created_at_block_height: None,
            updated_at_block_height: None,
            updated_at: None,
            revision: None,
            fields: BTreeMap::from([
                ("targetId".into(), FieldValue::identifier([4; 32])),
                ("kind".into(), FieldValue::integer(13)),
                ("oid".into(), FieldValue::bytes(hex::decode(oid).unwrap())),
            ]),
        };
        st.targets.insert(target.clone(), pr(base, &hash));
        assert!(st.merge_on_base(&merge(&"ab".repeat(20))));
        assert!(!st.merge_on_base(&merge(&"cd".repeat(20))), "not a tip");
        // A baseRefName that does not hash to baseRefNameHash: not found on the base.
        st.targets.insert(target, pr("refs/heads/other", &hash));
        assert!(!st.merge_on_base(&merge(&"ab".repeat(20))));
    }

    /// A retarget (event kind 8) moves the base a merge is judged against (forge-core
    /// `pr_merge_base`): the newest legal one counts, and none once the merge was seen.
    #[test]
    fn a_retarget_moves_the_base_a_merge_is_judged_against() {
        use sha2::Digest;
        let mut st = state_with_threads(0);
        let hash = |r: &str| hex::encode(sha2::Sha256::digest(r.as_bytes()));
        let target = forge_core::platform::encode_identifier([4; 32]);
        let pr = TargetInfo {
            is_pr: true,
            number: 1,
            author: String::new(),
            title: String::new(),
            base_ref: "refs/heads/main".into(),
            head_oid: String::new(),
            head_set_by: None,
            retargets: Vec::new(),
            opened_base: None,
            base_ref_hash: hash("refs/heads/main"),
            baseline: Baseline::Beginning,
            last_activity: 0,
            draft: false,
            merged: false,
            members_only: false,
        };
        st.targets.insert(target.clone(), pr);
        st.tips
            .entry(hash("refs/heads/main"))
            .or_default()
            .insert("aa".repeat(20));
        st.tips
            .entry(hash("refs/heads/dev"))
            .or_default()
            .insert("bb".repeat(20));
        let doc = |id: &str, at: u64, fields: Vec<(&str, FieldValue)>| FetchedDocument {
            id: id.into(),
            owner_id: "M".into(),
            created_at: Some(at),
            created_at_block_height: None,
            updated_at_block_height: None,
            updated_at: None,
            revision: None,
            fields: fields
                .into_iter()
                .map(|(k, v)| (k.to_string(), v))
                .chain([("targetId".to_string(), FieldValue::identifier([4; 32]))])
                .collect(),
        };
        let retarget = |id: &str, at: u64, value: &str| {
            doc(
                id,
                at,
                vec![
                    ("kind", FieldValue::integer(8)),
                    ("value", FieldValue::text(value)),
                ],
            )
        };
        let merge = |oid: &str| {
            doc(
                "m",
                9,
                vec![
                    ("kind", FieldValue::integer(13)),
                    ("oid", FieldValue::bytes(hex::decode(oid).unwrap())),
                ],
            )
        };
        assert_eq!(
            follow_base(&mut st, &retarget("r1", 2, "refs/heads/dev")),
            Some("refs/heads/main".into())
        );
        // An older retarget and an illegal one do not move it back.
        assert_eq!(
            follow_base(&mut st, &retarget("r0", 1, "refs/heads/main")),
            None
        );
        assert_eq!(follow_base(&mut st, &retarget("r2", 3, "-x")), None);
        assert!(st.merge_on_base(&merge(&"bb".repeat(20))), "a tip of dev");
        assert!(!st.merge_on_base(&merge(&"aa".repeat(20))), "main's");
        // A retarget written after the merge (at 9) but read before it, in the same poll: the
        // merge is still judged against the base as of the merge, and the PR stays there.
        assert_eq!(
            follow_base(&mut st, &retarget("r3", 10, "refs/heads/main")),
            Some("refs/heads/dev".into())
        );
        assert!(
            st.merge_on_base(&merge(&"bb".repeat(20))),
            "still dev's tip"
        );
        st.targets.get_mut(&target).unwrap().merged = true;
        st.targets.get_mut(&target).unwrap().settle_merge(9);
        assert_eq!(st.targets[&target].base_ref, "refs/heads/dev");
        // Once merged, a later retarget leaves the base alone.
        assert_eq!(
            follow_base(&mut st, &retarget("r4", 11, "refs/heads/main")),
            None
        );
        assert_eq!(st.targets[&target].base_ref, "refs/heads/dev");
    }

    /// Only a member `event` of kind 26 is a CI re-run request the runners are woken for.
    #[test]
    fn a_ci_rerun_request_wakes_runners_and_nothing_else_does_by_itself() {
        let ev = |kind: u64| FetchedDocument {
            id: format!("e{kind}"),
            owner_id: "M".into(),
            created_at: Some(1),
            created_at_block_height: None,
            updated_at_block_height: None,
            updated_at: None,
            revision: None,
            fields: BTreeMap::from([("kind".into(), FieldValue::integer(kind))]),
        };
        assert!(is_rerun_request(DOC_EVENT, &ev(26)));
        assert!(!is_rerun_request(DOC_EVENT, &ev(4)));
        assert!(
            !is_rerun_request(DOC_AUTHOR_EVENT, &ev(26)),
            "an author kind never is"
        );
        assert!(!is_rerun_request(DOC_TRANSITION, &ev(26)));
    }

    /// Open / closed follows the transitions (which threads are read first): a close, a merge
    /// or a draft close closes the target; a reopen (either axis) opens it; a draft or ready
    /// leaves it open.
    #[test]
    fn transitions_open_and_close_their_target() {
        let mut st = state_with_threads(0);
        let tid = forge_core::platform::encode_identifier([4; 32]);
        let tr = |kind: u64| FetchedDocument {
            id: format!("t{kind}"),
            owner_id: "M".into(),
            created_at: Some(1),
            created_at_block_height: None,
            updated_at_block_height: None,
            updated_at: None,
            revision: None,
            fields: BTreeMap::from([
                ("targetId".into(), FieldValue::identifier([4; 32])),
                ("kind".into(), FieldValue::integer(kind)),
            ]),
        };
        for (kind, closed) in [
            (11, true),
            (12, false),
            (14, false),
            (16, true),
            (17, false),
            (15, false),
            (13, true),
        ] {
            note_transition(&mut st, &tr(kind));
            assert_eq!(st.closed.contains(&tid), closed, "after kind {kind}");
        }
        // An event does not change it.
        st.closed.clear();
        note_activity(&mut st, &tr(4));
        assert!(!st.closed.contains(&tid));
    }

    /// A poll the deadline cuts short resumes after the last head it read, so later heads are
    /// not starved by the ones before them.
    #[test]
    fn check_run_heads_rotate() {
        let heads: BTreeMap<String, Head> = ["a", "b", "c", "d"]
            .iter()
            .map(|k| (k.to_string(), Head::since(0)))
            .collect();
        let order = |last: &str| -> Vec<String> {
            heads_after(&heads, &last.to_string())
                .into_iter()
                .map(|(k, _)| k)
                .collect()
        };
        assert_eq!(order(""), ["a", "b", "c", "d"]);
        assert_eq!(order("b"), ["c", "d", "a", "b"]);
        assert_eq!(order("d"), ["a", "b", "c", "d"]);
        assert_eq!(order("bb"), ["c", "d", "a", "b"], "a pruned head");
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
        let mut runs: BTreeMap<String, checkruns::HeadRuns> = heads
            .keys()
            .map(|k| (k.clone(), checkruns::HeadRuns::new()))
            .collect();
        prune_heads(&mut heads, &mut runs);
        assert_eq!(runs.len(), MAX_HEADS, "pruned heads lose their runs");
        assert_eq!(heads.len(), MAX_HEADS);
        assert!(!heads.contains_key(&format!("{:040x}", 0)));
        assert!(heads.contains_key(&format!("{:040x}", MAX_HEADS as u64 + 9)));
    }

    /// The startup seed: closed, merged and closed-draft targets are closed; open, draft and
    /// never-moved (absent) ones are not; a PR at a draft code is a draft.
    #[test]
    fn the_state_is_seeded_from_state_codes() {
        let id = |b: u8| forge_core::platform::encode_identifier([b; 32]);
        let pr = |b: u8| {
            let mut t = TargetInfo::from_patch(
                &FetchedDocument {
                    id: id(b),
                    owner_id: "A".into(),
                    created_at: Some(1),
                    created_at_block_height: None,
                    updated_at_block_height: None,
                    updated_at: None,
                    revision: None,
                    fields: BTreeMap::new(),
                },
                Baseline::Beginning,
            );
            t.draft = b == 1;
            (id(b), t)
        };
        let mut targets: BTreeMap<String, TargetInfo> = (1..=7).map(pr).collect();
        let codes = BTreeMap::from([
            (vec![1; 32], 0),
            (vec![2; 32], 1),
            (vec![3; 32], 2),
            (vec![4; 32], 8),
            (vec![5; 32], 9),
            // Locked and merged (2 + 16): the realistic "lock on a merged PR, seen only after a
            // restart" case -- merged must fold out of the sum the same as an unlocked 2 does.
            (vec![7; 32], 18),
        ]);
        assert_eq!(
            apply_codes(&codes, &mut targets),
            [id(2), id(3), id(5), id(7)].into_iter().collect()
        );
        let drafts: Vec<bool> = (1..=7).map(|b| targets[&id(b)].draft).collect();
        assert_eq!(drafts, [false, false, false, true, true, false, false]);
        // Code 2 (merged) seeds `merged`; so does a locked 18; nothing else does.
        let merges: Vec<bool> = (1..=7).map(|b| targets[&id(b)].merged).collect();
        assert_eq!(merges, [false, false, true, false, false, false, true]);
        // A transition seen live moves the flag.
        let mut st = state_with_threads(0);
        st.targets = targets;
        let tr = |target: u8, kind: u64| FetchedDocument {
            id: format!("t{kind}"),
            owner_id: "M".into(),
            created_at: Some(2),
            created_at_block_height: None,
            updated_at_block_height: None,
            updated_at: None,
            revision: None,
            fields: BTreeMap::from([
                ("targetId".into(), FieldValue::identifier([target; 32])),
                ("kind".into(), FieldValue::integer(kind)),
            ]),
        };
        note_transition(&mut st, &tr(4, 15));
        assert!(!st.targets[&id(4)].draft);
        note_transition(&mut st, &tr(4, 14));
        assert!(st.targets[&id(4)].draft);
        // A merge transition, seen live, sets `merged` and never clears it again (D-4: a
        // lock/unlock on the now-merged PR must keep reporting `merged: true`).
        assert!(!st.targets[&id(6)].merged);
        note_transition(&mut st, &tr(6, 13));
        assert!(st.targets[&id(6)].merged);
        note_transition(&mut st, &tr(6, 18));
        assert!(st.targets[&id(6)].merged, "a lock does not touch merged");
    }

    /// `note_release_yanked` returns the *previous* revision's yanked state (`was_yanked`),
    /// updating `RepoState::yanked_tags` only after reading it -- the ordering
    /// `ingest::translate_release` relies on to tell a fresh yank from an edit of one already
    /// yanked. A full publish/yank/edit/edit/un-yank/yank sequence, combined with
    /// `translate_release`'s own `release_action`, must read back `published, unpublished,
    /// edited, edited, edited, unpublished`.
    #[test]
    fn note_release_yanked_tracks_the_previous_revision_before_updating() {
        let mut st = state_with_threads(0);
        let rel = |seq: u64, delta: i64, yanked: bool| FetchedDocument {
            id: format!("rel{seq}"),
            owner_id: "M".into(),
            created_at: Some(seq),
            created_at_block_height: None,
            updated_at_block_height: None,
            updated_at: None,
            revision: None,
            fields: BTreeMap::from([
                ("tagName".into(), FieldValue::text("v1")),
                ("delta".into(), FieldValue::signed(delta)),
                ("yanked".into(), FieldValue::boolean(yanked)),
            ]),
        };
        let step = |st: &mut RepoState, d: &FetchedDocument| -> String {
            let was_yanked = note_release_yanked(st, d);
            ingest::translate_release(&st.meta, d, was_yanked)
                .unwrap()
                .payload["action"]
                .as_str()
                .unwrap()
                .to_owned()
        };
        assert_eq!(step(&mut st, &rel(1, 1, false)), "published");
        assert_eq!(step(&mut st, &rel(2, 0, true)), "unpublished");
        assert_eq!(step(&mut st, &rel(3, 0, true)), "edited");
        assert_eq!(step(&mut st, &rel(4, 0, true)), "edited");
        assert_eq!(step(&mut st, &rel(5, 0, false)), "edited");
        assert_eq!(step(&mut st, &rel(6, 0, true)), "unpublished");

        // A members-only revision may carry the public tag's name (its `tagName` is keyed and
        // consensus admits any): it is not reported and leaves the public tag's state alone.
        let mut sealed = rel(7, 0, false);
        sealed
            .fields
            .insert("enc".into(), FieldValue::bytes(vec![3; 61]));
        assert!(!note_release_yanked(&mut st, &sealed));
        assert!(ingest::translate_release(&st.meta, &sealed, false).is_none());
        assert!(st.yanked_tags.contains("v1"));
        assert_eq!(step(&mut st, &rel(8, 0, true)), "edited");
    }
}
