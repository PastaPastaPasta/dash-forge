//! The mirror store: one bare git repository per public repo (`<data>/mirrors/<network>/<repo
//! id>.git`), refreshed from a proof-verified [`Snapshot`], evicted least-recently-served first
//! above the disk cap.
//!
//! A refresh:
//! 1. reads the snapshot (chain tip first, then every ref, the default branch and the packs);
//! 2. refuses a repository whose packs exceed `--repo-max`;
//! 3. when the served refs differ from the snapshot's, runs `git fetch` through
//!    `git-remote-dash` into a hidden staging namespace (`refs/forge-gateway/`), checks every
//!    snapshot tip is present, and moves the served refs to exactly the snapshot's in one
//!    `update-ref` transaction (a ref Platform dropped is deleted);
//! 4. writes `forge-manifest.json` (refs first, then the manifest, so the manifest never claims
//!    more than is served), and repacks with a bitmap index when packs pile up.
//!
//! A failed refresh changes nothing: the mirror keeps serving its last snapshot, whose manifest
//! says how old it is. A refresh that finds the repository proved gone ([`Unavailable::Gone`]:
//! its `repo` document or the forge contracts absent) removes the mirror instead, and tells the
//! [`Mirrors::on_gone`] listeners, so the repository answers `404` like any unknown one.

use std::collections::{BTreeMap, HashMap};
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant, SystemTime};

use anyhow::{anyhow, bail, Context as _, Result};
use forge_core::mirror::{Manifest, MANIFEST_FILE, MANIFEST_SCHEMA};
use tokio::io::AsyncWriteExt as _;
use tokio::process::Command;
use tokio::sync::{Notify, Semaphore};

use crate::config::Config;
use crate::metrics::Metrics;
use crate::upstream::{RepoInfo, Snapshot, Upstream};

/// The hidden namespace a fetch lands in (never advertised: `uploadpack.hideRefs`).
pub const STAGING: &str = "refs/forge-gateway/";

/// How long a failed first refresh is reported before a request retries it.
const RETRY_AFTER_FAILURE: Duration = Duration::from_secs(60);

/// Repack once a mirror holds more packs than this.
const REPACK_AFTER_PACKS: usize = 8;

/// The file in a mirror recording when it was last served (Unix ms), so a restart knows which
/// mirrors are warm. Not the manifest's `fetchedAtMs`: every poll moves that, so a mirror nobody
/// asks for would count as warm forever.
pub const SERVED_FILE: &str = "forge-gateway-served";

/// How often a mirror being served rewrites [`SERVED_FILE`] (at most).
const SERVED_SAVE_EVERY: Duration = Duration::from_secs(600);

/// How long a mirror proved gone waits for the clones it is serving before its files go.
const GONE_DRAIN: Duration = Duration::from_secs(3600);

/// Why a mirror cannot be served.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Unavailable {
    /// The repository's packs exceed this gateway's per-repo cap.
    TooLarge {
        /// The packs' size.
        bytes: u64,
        /// The cap.
        cap: u64,
    },
    /// The first mirror is still being made.
    Pending,
    /// The first refresh failed (Platform or storage unreachable, say).
    Failed(String),
    /// Platform proved the repository gone (deleted, a reset chain, or no longer the public
    /// repository the mirror served): the mirror was removed.
    Gone,
}

/// A repository's mirror and its state.
pub struct Slot {
    /// The repository.
    pub repo: RepoInfo,
    /// The bare repository's path.
    pub dir: PathBuf,
    refresh: tokio::sync::Mutex<()>,
    state: Mutex<SlotState>,
    done: Notify,
}

#[derive(Debug)]
struct SlotState {
    manifest: Option<Arc<Manifest>>,
    refreshing: bool,
    last_ok: Option<Instant>,
    last_err: Option<Unavailable>,
    last_attempt: Option<Instant>,
    last_access: SystemTime,
    /// When [`SERVED_FILE`] was last written by this process.
    served_saved: Option<Instant>,
    size: u64,
    serving: usize,
    pinned: bool,
}

impl Slot {
    fn state(&self) -> MutexGuard<'_, SlotState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The manifest of the snapshot being served, if any.
    pub fn manifest(&self) -> Option<Arc<Manifest>> {
        self.state().manifest.clone()
    }

    /// Whether the mirror serves a snapshot.
    pub fn ready(&self) -> bool {
        self.state().manifest.is_some()
    }

    /// How long ago the snapshot served was read from Platform.
    pub fn snapshot_age(&self) -> Option<Duration> {
        let s = self.state();
        let m = s.manifest.as_ref()?;
        Some(Duration::from_millis(
            now_ms().saturating_sub(m.fetched_at_ms),
        ))
    }

    /// Whether Platform proved the repository gone (the mirror was removed).
    pub fn gone(&self) -> bool {
        self.state().last_err == Some(Unavailable::Gone)
    }

    /// Whether the last refresh failed (Platform unreachable, say): the snapshot served may
    /// be behind Platform.
    pub fn refresh_failing(&self) -> bool {
        matches!(self.state().last_err, Some(Unavailable::Failed(_)))
    }
}

/// A served mirror: while it lives the mirror is not evicted.
pub struct ServeGuard {
    slot: Arc<Slot>,
}

impl ServeGuard {
    /// The mirror.
    pub fn slot(&self) -> &Arc<Slot> {
        &self.slot
    }
}

impl Drop for ServeGuard {
    fn drop(&mut self) {
        let mut s = self.slot.state();
        s.serving = s.serving.saturating_sub(1);
    }
}

/// Every mirror of one network.
pub struct Mirrors {
    cfg: Arc<Config>,
    upstream: Arc<dyn Upstream>,
    metrics: Arc<Metrics>,
    root: PathBuf,
    home: PathBuf,
    slots: Mutex<HashMap<String, Arc<Slot>>>,
    refreshes: Semaphore,
    trash_seq: AtomicU64,
    gone_listeners: Mutex<Vec<GoneListener>>,
}

/// Told the repository whose mirror was removed because Platform proved it gone.
type GoneListener = Box<dyn Fn(&RepoInfo) + Send + Sync>;

/// Milliseconds since the Unix epoch.
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

impl Mirrors {
    /// The store under `cfg.data_dir`, for `upstream`'s network.
    pub fn new(
        cfg: Arc<Config>,
        upstream: Arc<dyn Upstream>,
        metrics: Arc<Metrics>,
    ) -> Result<Self> {
        let network = upstream.network();
        if network.is_empty()
            || !network
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-')
        {
            bail!("unexpected network key {network:?}");
        }
        let root = cfg.data_dir.join("mirrors").join(&network);
        let home = cfg.data_dir.join("home");
        std::fs::create_dir_all(&root).with_context(|| format!("creating {}", root.display()))?;
        std::fs::create_dir_all(&home)?;
        Ok(Self {
            refreshes: Semaphore::new(cfg.refresh_max.max(1)),
            cfg,
            upstream,
            metrics,
            root,
            home,
            slots: Mutex::default(),
            trash_seq: AtomicU64::new(0),
            gone_listeners: Mutex::default(),
        })
    }

    /// Call `f` with each repository whose mirror is removed because Platform proved it gone
    /// (the server drops its cached resolutions and renders of it).
    pub fn on_gone(&self, f: impl Fn(&RepoInfo) + Send + Sync + 'static) {
        self.gone_listeners
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(Box::new(f));
    }

    /// The upstream.
    pub fn upstream(&self) -> &Arc<dyn Upstream> {
        &self.upstream
    }

    /// The `HOME` git runs with (isolated from the operator's).
    pub fn home(&self) -> &Path {
        &self.home
    }

    /// The directory holding every mirror (`git http-backend`'s project root).
    pub fn root(&self) -> &Path {
        &self.root
    }

    fn slots(&self) -> MutexGuard<'_, HashMap<String, Arc<Slot>>> {
        self.slots.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Pick up the mirrors a previous run left (each with its manifest), so a restart serves at
    /// once and refreshes in the background. A directory without a manifest is a mirror whose
    /// first refresh never finished: it is removed. A mirror is as warm as its last serve
    /// ([`SERVED_FILE`]); one never served by a build that records it starts cold (refreshed on
    /// its next request, not polled).
    pub async fn load_existing(&self) -> Result<usize> {
        let mut loaded = 0;
        let forge_core = self.upstream.forge_core();
        let mut rd = tokio::fs::read_dir(&self.root).await?;
        while let Some(e) = rd.next_entry().await? {
            let path = e.path();
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with(".trash-") {
                let _ = tokio::fs::remove_dir_all(&path).await;
                continue;
            }
            let Some(id) = name.strip_suffix(".git") else {
                continue;
            };
            let manifest = tokio::fs::read(path.join(MANIFEST_FILE))
                .await
                .ok()
                .and_then(|b| serde_json::from_slice::<Manifest>(&b).ok())
                .filter(|m| m.repo_id == id && m.schema == MANIFEST_SCHEMA);
            let Some(m) = manifest else {
                tracing::info!(repo = id, "removing an unfinished mirror");
                let _ = tokio::fs::remove_dir_all(&path).await;
                continue;
            };
            if m.forge_core != forge_core {
                // A network re-registered with new forge contracts: none of its repositories
                // are the ones mirrored.
                tracing::info!(repo = id, "removing a mirror of other forge contracts");
                let _ = tokio::fs::remove_dir_all(&path).await;
                continue;
            }
            let repo = RepoInfo {
                repo_id: m.repo_id.clone(),
                owner_id: m.owner_id.clone(),
                name: m.name.clone(),
                public: true,
            };
            let size = dir_size(path.clone()).await;
            let served_ms = tokio::fs::read_to_string(path.join(SERVED_FILE))
                .await
                .ok()
                .and_then(|t| t.trim().parse::<u64>().ok())
                .unwrap_or(0);
            let slot = self.slot(&repo);
            {
                let mut s = slot.state();
                s.last_access = SystemTime::UNIX_EPOCH + Duration::from_millis(served_ms);
                s.manifest = Some(Arc::new(m));
                s.size = size;
            }
            loaded += 1;
        }
        Ok(loaded)
    }

    /// The slot of `repo`, created (empty) on first use.
    pub fn slot(&self, repo: &RepoInfo) -> Arc<Slot> {
        let mut slots = self.slots();
        Arc::clone(slots.entry(repo.repo_id.clone()).or_insert_with(|| {
            Arc::new(Slot {
                repo: repo.clone(),
                dir: self.root.join(format!("{}.git", repo.repo_id)),
                refresh: tokio::sync::Mutex::new(()),
                state: Mutex::new(SlotState {
                    manifest: None,
                    refreshing: false,
                    last_ok: None,
                    last_err: None,
                    last_attempt: None,
                    last_access: SystemTime::now(),
                    served_saved: None,
                    size: 0,
                    serving: 0,
                    pinned: false,
                }),
                done: Notify::new(),
            })
        }))
    }

    /// Whether a slot exists for `repo_id`.
    pub fn known(&self, repo_id: &str) -> bool {
        self.slots().contains_key(repo_id)
    }

    /// Keep `repo` warm and never evict it (`--repos`).
    pub fn pin(&self, repo: &RepoInfo) -> Arc<Slot> {
        let slot = self.slot(repo);
        slot.state().pinned = true;
        slot
    }

    /// The slots named `<owner id>/<name>` (a relay wake's name): usually one, two while a
    /// repository deleted and created again under the same name still has its old mirror.
    pub fn find(&self, owner_id: &str, name: &str) -> Vec<Arc<Slot>> {
        self.slots()
            .values()
            .filter(|s| s.repo.owner_id == owner_id && s.repo.name == name)
            .cloned()
            .collect()
    }

    /// Start serving `slot`'s mirror: the guard holds it against eviction. `None` when the
    /// mirror was evicted meanwhile or serves nothing yet.
    pub fn checkout(&self, slot: &Arc<Slot>) -> Option<ServeGuard> {
        let slots = self.slots();
        let current = slots.get(&slot.repo.repo_id)?;
        if !Arc::ptr_eq(current, slot) {
            return None;
        }
        let mut s = slot.state();
        s.manifest.as_ref()?;
        s.serving += 1;
        s.last_access = SystemTime::now();
        if s.served_saved
            .is_none_or(|t| t.elapsed() >= SERVED_SAVE_EVERY)
        {
            if let Ok(rt) = tokio::runtime::Handle::try_current() {
                s.served_saved = Some(Instant::now());
                // Best effort: a failed write leaves the mirror cold after a restart, no more.
                let path = slot.dir.join(SERVED_FILE);
                rt.spawn(async move {
                    let _ = tokio::fs::write(path, now_ms().to_string()).await;
                });
            }
        }
        Some(ServeGuard {
            slot: Arc::clone(slot),
        })
    }

    /// Start a refresh of `slot` in the background unless one is running.
    pub fn trigger(self: &Arc<Self>, slot: &Arc<Slot>) {
        {
            let mut s = slot.state();
            if s.refreshing {
                return;
            }
            s.refreshing = true;
            s.last_attempt = Some(Instant::now());
        }
        let this = Arc::clone(self);
        let slot = Arc::clone(slot);
        tokio::spawn(async move {
            let outcome = {
                let _permit = this.refreshes.acquire().await;
                this.refresh(&slot).await
            };
            if outcome == Err(Unavailable::Gone) {
                // Still marked refreshing: no eviction or other refresh of this slot meanwhile.
                this.forget(&slot);
            }
            {
                let mut s = slot.state();
                s.refreshing = false;
                match &outcome {
                    Ok(()) => {
                        s.last_ok = Some(Instant::now());
                        s.last_err = None;
                    }
                    Err(e) => s.last_err = Some(e.clone()),
                }
            }
            slot.done.notify_waiters();
            this.evict().await;
        });
    }

    /// Refresh `slot` (or join the refresh under way) and wait for it to end: `None` when it
    /// succeeded, else why it failed.
    pub async fn refresh_wait(self: &Arc<Self>, slot: &Arc<Slot>) -> Option<Unavailable> {
        self.trigger(slot);
        loop {
            let notified = slot.done.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            {
                let s = slot.state();
                if !s.refreshing {
                    return s.last_err.clone();
                }
            }
            notified.await;
        }
    }

    /// Whether `slot` is due a refresh (never refreshed by this process, or longer ago than
    /// the poll interval).
    pub fn stale(&self, slot: &Slot) -> bool {
        let s = slot.state();
        s.last_ok
            .is_none_or(|t| t.elapsed() >= Duration::from_secs(self.cfg.poll_secs))
    }

    /// Serve `slot` once it is ready: at once when it serves a snapshot (a stale one is
    /// refreshed in the background), else after its first refresh, waiting at most `wait`.
    pub async fn ready(
        self: &Arc<Self>,
        slot: &Arc<Slot>,
        wait: Duration,
    ) -> Result<(), Unavailable> {
        if slot.ready() {
            if self.stale(slot) {
                self.trigger(slot);
            }
            return Ok(());
        }
        {
            // A first refresh that failed a moment ago is not retried for every request.
            let s = slot.state();
            if let (false, Some(e), Some(t)) = (s.refreshing, &s.last_err, s.last_attempt) {
                if t.elapsed() < RETRY_AFTER_FAILURE {
                    return Err(e.clone());
                }
            }
        }
        self.trigger(slot);
        let deadline = tokio::time::Instant::now() + wait;
        loop {
            let notified = slot.done.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            {
                let s = slot.state();
                if s.manifest.is_some() {
                    return Ok(());
                }
                if !s.refreshing {
                    return Err(s
                        .last_err
                        .clone()
                        .unwrap_or_else(|| Unavailable::Failed("no snapshot".into())));
                }
            }
            if tokio::time::timeout_at(deadline, notified).await.is_err() {
                return Err(Unavailable::Pending);
            }
        }
    }

    /// The mirrors the poller keeps fresh: pinned ones, and ones served within the warm window.
    pub fn warm(&self) -> Vec<Arc<Slot>> {
        let window = Duration::from_secs(self.cfg.warm_hours * 3600);
        let now = SystemTime::now();
        self.slots()
            .values()
            .filter(|slot| {
                let s = slot.state();
                s.pinned
                    || (s.manifest.is_some()
                        && now.duration_since(s.last_access).is_ok_and(|d| d <= window))
            })
            .cloned()
            .collect()
    }

    /// `(mirrors, ready, bytes)` for the metrics.
    pub fn stats(&self) -> (u64, u64, u64) {
        let slots = self.slots();
        let mut ready = 0;
        let mut bytes = 0;
        for s in slots.values() {
            let s = s.state();
            ready += u64::from(s.manifest.is_some());
            bytes += s.size;
        }
        (slots.len() as u64, ready, bytes)
    }

    /// Check every mirror a previous run left against Platform once (a proved read of its
    /// `repo` document each, at most `--refresh-max` at a time) and remove the ones proved
    /// gone. After a network reset nothing else would: a mirror nobody asks for is never
    /// refreshed, and the repository created again under its name has a new owner and id.
    pub async fn sweep_gone(&self) {
        use futures::StreamExt as _;
        let slots: Vec<Arc<Slot>> = self.slots().values().cloned().collect();
        futures::stream::iter(slots)
            .for_each_concurrent(self.cfg.refresh_max.max(1), |slot| async move {
                let present = {
                    let _permit = self.refreshes.acquire().await;
                    // Not alongside a refresh of the same mirror.
                    let _lock = slot.refresh.lock().await;
                    self.upstream.exists(&slot.repo).await
                };
                match present {
                    Ok(true) => {}
                    Ok(false) => self.forget(&slot),
                    Err(e) => {
                        tracing::warn!(repo = %slot.repo.repo_id, error = %format!("{e:#}"), "checking a mirror at start failed; kept");
                    }
                }
            })
            .await;
    }

    /// Remove `slot`, whose repository Platform proved gone: no longer served or polled, its
    /// files deleted once the clones it is serving end, and the [`Self::on_gone`] listeners
    /// told. A slot that is no longer the current one for its repository (evicted meanwhile)
    /// owns no directory: only the listeners are told.
    fn forget(&self, slot: &Arc<Slot>) {
        let removed = {
            let mut slots = self.slots();
            let current = slots
                .get(&slot.repo.repo_id)
                .is_some_and(|c| Arc::ptr_eq(c, slot));
            let pinned = {
                let mut s = slot.state();
                s.manifest = None;
                s.size = 0;
                s.last_err = Some(Unavailable::Gone);
                s.pinned
            };
            if pinned {
                tracing::error!(repo = %slot.repo.repo_id, name = %slot.repo.name, "a repository in GATEWAY_REPOS is gone from Platform; it is no longer mirrored (restart the gateway once it exists again)");
            }
            if current {
                slots.remove(&slot.repo.repo_id);
            }
            // Moved aside under the lock, as eviction does: a new mirror of the same id never
            // finds these files. A clone being served keeps reading them (git works inside the
            // directory it opened).
            current.then(|| {
                let n = self.trash_seq.fetch_add(1, Ordering::Relaxed);
                let trash = self.root.join(format!(".trash-{}-{n}", slot.repo.repo_id));
                std::fs::rename(&slot.dir, &trash).is_ok().then_some(trash)
            })
        };
        if removed.is_some() {
            Metrics::inc(&self.metrics.mirrors_gone);
            tracing::info!(repo = %slot.repo.repo_id, "Platform proved the repository gone; mirror removed");
        }
        for f in self
            .gone_listeners
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .iter()
        {
            f(&slot.repo);
        }
        if let Some(trash) = removed.flatten() {
            let slot = Arc::clone(slot);
            tokio::spawn(async move {
                let deadline = Instant::now() + GONE_DRAIN;
                while slot.state().serving > 0 && Instant::now() < deadline {
                    tokio::time::sleep(Duration::from_secs(1)).await;
                }
                let _ = tokio::fs::remove_dir_all(&trash).await;
            });
        }
    }

    /// Refresh `slot` now (serialised per mirror).
    async fn refresh(&self, slot: &Slot) -> Result<(), Unavailable> {
        let _lock = slot.refresh.lock().await;
        let started = Instant::now();
        let outcome = self.refresh_locked(slot).await;
        match &outcome {
            Ok(changed) => {
                Metrics::inc(&self.metrics.refresh_ok);
                if *changed {
                    Metrics::inc(&self.metrics.refresh_changed);
                }
                tracing::info!(
                    repo = %slot.repo.repo_id,
                    changed,
                    ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
                    "mirror refreshed"
                );
            }
            Err(Unavailable::Gone) => {}
            Err(e) => {
                Metrics::inc(&self.metrics.refresh_failed);
                tracing::warn!(repo = %slot.repo.repo_id, error = ?e, "mirror refresh failed; serving the last snapshot");
            }
        }
        outcome.map(|_| ())
    }

    async fn refresh_locked(&self, slot: &Slot) -> Result<bool, Unavailable> {
        // A slot evicted or removed meanwhile owns no directory: a refresh would make one
        // nothing tracks.
        if !self
            .slots()
            .get(&slot.repo.repo_id)
            .is_some_and(|c| std::ptr::eq(Arc::as_ptr(c), slot))
        {
            return Err(Unavailable::Failed(
                "the mirror was dropped meanwhile".into(),
            ));
        }
        let snap = match self.upstream.snapshot(&slot.repo).await {
            Ok(Some(s)) => {
                self.metrics.upstream(true);
                s
            }
            Ok(None) => {
                self.metrics.upstream(true);
                return Err(Unavailable::Gone);
            }
            Err(e) => {
                self.metrics.upstream(false);
                return Err(Unavailable::Failed(format!("reading Platform: {e:#}")));
            }
        };
        let bytes = snap.pack_bytes();
        if bytes > self.cfg.repo_max_bytes {
            return Err(Unavailable::TooLarge {
                bytes,
                cap: self.cfg.repo_max_bytes,
            });
        }
        let fail = |e: anyhow::Error| Unavailable::Failed(format!("{e:#}"));
        let created = self.ensure_repo(&slot.dir).await.map_err(fail)?;
        if created {
            Metrics::inc(&self.metrics.mirrors_created);
        }
        let wanted: BTreeMap<String, String> = snap
            .tips()
            .into_iter()
            .filter(|(name, _)| servable_ref(name))
            .collect();
        let served = self.served_refs(&slot.dir).await.map_err(fail)?;
        let changed = wanted != served;
        if changed {
            let missing = self
                .missing(&slot.dir, wanted.values())
                .await
                .map_err(fail)?;
            if !missing.is_empty() {
                self.fetch(slot).await.map_err(fail)?;
                let still = self
                    .missing(&slot.dir, wanted.values())
                    .await
                    .map_err(fail)?;
                if !still.is_empty() {
                    return Err(Unavailable::Failed(format!(
                        "the fetch did not bring {} of the proved tips (first: {})",
                        still.len(),
                        still[0]
                    )));
                }
            }
            self.move_refs(&slot.dir, &served, &wanted)
                .await
                .map_err(fail)?;
            self.maybe_repack(&slot.dir).await;
        }
        self.set_head(&slot.dir, snap.default_branch.as_deref(), &wanted)
            .await
            .map_err(fail)?;
        let manifest = self.manifest(slot, &snap, &wanted);
        write_manifest(&slot.dir, &manifest).await.map_err(fail)?;
        let size = dir_size(slot.dir.clone()).await;
        let mut s = slot.state();
        s.manifest = Some(Arc::new(manifest));
        s.size = size;
        Ok(changed)
    }

    fn manifest(
        &self,
        slot: &Slot,
        snap: &Snapshot,
        served: &BTreeMap<String, String>,
    ) -> Manifest {
        Manifest {
            schema: MANIFEST_SCHEMA.into(),
            network: self.upstream.network(),
            forge_core: self.upstream.forge_core(),
            repo_id: slot.repo.repo_id.clone(),
            owner_id: slot.repo.owner_id.clone(),
            name: slot.repo.name.clone(),
            default_branch: snap.default_branch.clone(),
            platform_height: snap.tip.height,
            platform_time_ms: snap.tip.time_ms,
            fetched_at_ms: now_ms(),
            refs: snap
                .records
                .iter()
                .filter_map(|r| r.tip.clone())
                .filter(|t| served.get(&t.name) == Some(&t.oid))
                .collect(),
            packs: snap.packs.clone(),
        }
    }

    /// A `git` command run in `dir` with the gateway's isolated environment.
    pub fn git(&self, dir: &Path) -> Command {
        let mut c = Command::new(&self.cfg.git);
        c.current_dir(dir)
            .env("HOME", &self.home)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env_remove("GIT_DIR")
            .stdin(Stdio::null())
            .kill_on_drop(true);
        c
    }

    async fn run(&self, mut c: Command, timeout: Duration) -> Result<Vec<u8>> {
        let out = tokio::time::timeout(timeout, c.output())
            .await
            .map_err(|_| anyhow!("git timed out after {}s", timeout.as_secs()))??;
        if !out.status.success() {
            bail!(
                "git failed ({}): {}",
                out.status,
                String::from_utf8_lossy(&out.stderr).trim()
            );
        }
        Ok(out.stdout)
    }

    /// Create the bare repository on first use. `true` when it was created.
    async fn ensure_repo(&self, dir: &Path) -> Result<bool> {
        if dir.join("HEAD").exists() {
            return Ok(false);
        }
        let tmp = dir.with_extension(format!("init-{}", std::process::id()));
        let _ = tokio::fs::remove_dir_all(&tmp).await;
        let mut c = self.git(&self.root);
        c.args(["init", "--bare", "--quiet"]).arg(&tmp);
        self.run(c, Duration::from_secs(30)).await?;
        for (k, v) in [
            // Smart HTTP only, read only: no dumb file serving, no push.
            ("http.getanyfile", "false"),
            ("http.receivepack", "false"),
            ("http.uploadpack", "true"),
            ("uploadpack.hideRefs", STAGING.trim_end_matches('/')),
            ("uploadpack.allowFilter", "true"),
            ("gc.auto", "0"),
            ("maintenance.auto", "false"),
            ("core.logAllRefUpdates", "false"),
            ("repack.writeBitmaps", "true"),
            ("pack.writeBitmapHashCache", "true"),
            ("fetch.writeFetchHEAD", "false"),
        ] {
            let mut c = self.git(&tmp);
            c.args(["config", k, v]);
            self.run(c, Duration::from_secs(10)).await?;
        }
        tokio::fs::rename(&tmp, dir).await?;
        Ok(true)
    }

    /// The refs the mirror serves now (the staging namespace excluded).
    async fn served_refs(&self, dir: &Path) -> Result<BTreeMap<String, String>> {
        let mut c = self.git(dir);
        c.args(["for-each-ref", "--format=%(objectname) %(refname)"]);
        let out = self.run(c, Duration::from_secs(60)).await?;
        Ok(String::from_utf8_lossy(&out)
            .lines()
            .filter_map(|l| l.split_once(' '))
            .filter(|(_, name)| !name.starts_with(STAGING))
            .map(|(oid, name)| (name.to_string(), oid.to_string()))
            .collect())
    }

    /// Which of `oids` the mirror lacks.
    async fn missing<'a>(
        &self,
        dir: &Path,
        oids: impl Iterator<Item = &'a String>,
    ) -> Result<Vec<String>> {
        let mut input = String::new();
        for o in oids {
            input.push_str(o);
            input.push('\n');
        }
        if input.is_empty() {
            return Ok(Vec::new());
        }
        let mut c = self.git(dir);
        c.args(["cat-file", "--batch-check=%(objectname)"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = c.spawn()?;
        let mut stdin = child.stdin.take().expect("piped");
        let writer = tokio::spawn(async move {
            let r = stdin.write_all(input.as_bytes()).await;
            drop(stdin);
            r
        });
        let out = tokio::time::timeout(Duration::from_secs(60), child.wait_with_output())
            .await
            .map_err(|_| anyhow!("git cat-file timed out"))??;
        writer.await??;
        Ok(String::from_utf8_lossy(&out.stdout)
            .lines()
            .filter_map(|l| l.strip_suffix(" missing"))
            .map(str::to_string)
            .collect())
    }

    /// Fetch every ref's objects through `git-remote-dash` into the staging namespace.
    async fn fetch(&self, slot: &Slot) -> Result<()> {
        let src = self.upstream.fetch_source(&slot.repo);
        let mut c = self.git(&slot.dir);
        for k in &src.env_remove {
            c.env_remove(k);
        }
        c.envs(src.env.iter().map(|(k, v)| (k.as_str(), v.as_str())));
        c.args([
            "fetch",
            "--quiet",
            "--no-tags",
            "--prune",
            "--no-write-fetch-head",
        ])
        .arg(&src.url)
        .arg(format!("+refs/*:{STAGING}r/*"));
        self.run(c, Duration::from_secs(self.cfg.fetch_timeout_secs))
            .await
            .context("git fetch")?;
        Ok(())
    }

    /// Move the served refs from `served` to exactly `wanted`, in one transaction.
    async fn move_refs(
        &self,
        dir: &Path,
        served: &BTreeMap<String, String>,
        wanted: &BTreeMap<String, String>,
    ) -> Result<()> {
        let mut input = String::new();
        for (name, oid) in wanted {
            if served.get(name) != Some(oid) {
                let _ = writeln!(input, "update {name} {oid}");
            }
        }
        for name in served.keys().filter(|n| !wanted.contains_key(*n)) {
            let _ = writeln!(input, "delete {name}");
        }
        if input.is_empty() {
            return Ok(());
        }
        let mut c = self.git(dir);
        c.args(["update-ref", "--stdin"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = c.spawn()?;
        let mut stdin = child.stdin.take().expect("piped");
        stdin.write_all(input.as_bytes()).await?;
        drop(stdin);
        let out = tokio::time::timeout(Duration::from_secs(120), child.wait_with_output())
            .await
            .map_err(|_| anyhow!("git update-ref timed out"))??;
        if !out.status.success() {
            bail!(
                "git update-ref failed: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            );
        }
        Ok(())
    }

    /// Point `HEAD` at the default branch (or `main`, or the first branch) when it is served.
    async fn set_head(
        &self,
        dir: &Path,
        default_branch: Option<&str>,
        wanted: &BTreeMap<String, String>,
    ) -> Result<()> {
        let candidates = [
            default_branch.map(|b| format!("refs/heads/{b}")),
            Some("refs/heads/main".to_string()),
            wanted
                .keys()
                .find(|n| n.starts_with("refs/heads/"))
                .cloned(),
        ];
        let Some(head) = candidates
            .into_iter()
            .flatten()
            .find(|r| wanted.contains_key(r))
        else {
            return Ok(());
        };
        let mut c = self.git(dir);
        c.args(["symbolic-ref", "HEAD", &head]);
        self.run(c, Duration::from_secs(10)).await?;
        Ok(())
    }

    /// Repack into one pack with a bitmap index when packs pile up (or none has a bitmap).
    /// Best effort: a failure leaves the mirror as it was.
    async fn maybe_repack(&self, dir: &Path) {
        let pack_dir = dir.join("objects").join("pack");
        let (mut packs, mut bitmaps) = (0usize, 0usize);
        if let Ok(mut rd) = tokio::fs::read_dir(&pack_dir).await {
            while let Ok(Some(e)) = rd.next_entry().await {
                let n = e.file_name();
                let n = n.to_string_lossy();
                packs += usize::from(n.ends_with(".pack"));
                bitmaps += usize::from(n.ends_with(".bitmap"));
            }
        }
        if packs <= REPACK_AFTER_PACKS && bitmaps > 0 {
            return;
        }
        let mut c = self.git(dir);
        c.args(["repack", "-a", "-d", "-b", "-q"]);
        if let Err(e) = self
            .run(c, Duration::from_secs(self.cfg.fetch_timeout_secs))
            .await
        {
            tracing::warn!(error = %e, "repack failed; serving the packs as they are");
        }
    }

    /// Evict the least recently served mirrors (never a pinned, refreshing or serving one)
    /// while the total exceeds the cap.
    pub async fn evict(&self) {
        let doomed: Vec<(Arc<Slot>, Option<PathBuf>)> = {
            let mut slots = self.slots();
            let mut total: u64 = slots.values().map(|s| s.state().size).sum();
            if total <= self.cfg.cache_max_bytes {
                return;
            }
            let mut order: Vec<(SystemTime, String, u64)> = slots
                .iter()
                .filter_map(|(id, s)| {
                    let s = s.state();
                    (!s.pinned && !s.refreshing && s.serving == 0)
                        .then(|| (s.last_access, id.clone(), s.size))
                })
                .collect();
            order.sort();
            let mut out = Vec::new();
            for (_, id, size) in order {
                if total <= self.cfg.cache_max_bytes {
                    break;
                }
                if let Some(slot) = slots.remove(&id) {
                    total = total.saturating_sub(size);
                    // Moved aside under the lock (a cheap rename), so a new slot for the same
                    // repo can never find the old directory; deleted after the lock is released.
                    let n = self.trash_seq.fetch_add(1, Ordering::Relaxed);
                    let trash = self.root.join(format!(".trash-{}-{n}", slot.repo.repo_id));
                    let moved = std::fs::rename(&slot.dir, &trash).is_ok();
                    out.push((slot, moved.then_some(trash)));
                }
            }
            out
        };
        for (slot, trash) in doomed {
            Metrics::inc(&self.metrics.mirrors_evicted);
            tracing::info!(repo = %slot.repo.repo_id, "evicting mirror (disk cap)");
            if let Some(trash) = trash {
                let _ = tokio::fs::remove_dir_all(&trash).await;
            }
        }
    }
}

/// Whether the mirror may serve a ref Platform has: a well-formed name outside the staging
/// namespace (Platform's rules already refuse illegal names; this is belt and braces before a
/// name reaches `git update-ref`).
pub fn servable_ref(name: &str) -> bool {
    name.starts_with("refs/")
        && !name.starts_with(STAGING)
        && !name.ends_with('/')
        && !name.to_ascii_lowercase().ends_with(".lock")
        && !name.ends_with('.')
        && !name.contains("..")
        && !name.contains("//")
        && !name.contains("@{")
        && !name.split('/').any(|c| c.is_empty() || c.starts_with('.'))
        && name
            .bytes()
            .all(|b| b > 0x20 && b != 0x7f && !b"~^:?*[\\".contains(&b))
}

async fn write_manifest(dir: &Path, m: &Manifest) -> Result<()> {
    let body = serde_json::to_vec_pretty(m)?;
    let tmp = dir.join(format!("{MANIFEST_FILE}.tmp"));
    tokio::fs::write(&tmp, &body).await?;
    tokio::fs::rename(&tmp, dir.join(MANIFEST_FILE)).await?;
    Ok(())
}

/// The bytes under `dir`.
pub async fn dir_size(dir: PathBuf) -> u64 {
    tokio::task::spawn_blocking(move || {
        let mut total = 0u64;
        let mut todo = vec![dir];
        while let Some(d) = todo.pop() {
            let Ok(rd) = std::fs::read_dir(&d) else {
                continue;
            };
            for e in rd.flatten() {
                match e.metadata() {
                    Ok(m) if m.is_dir() => todo.push(e.path()),
                    Ok(m) => total += m.len(),
                    Err(_) => {}
                }
            }
        }
        total
    })
    .await
    .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_well_formed_refs_are_served() {
        assert!(servable_ref("refs/heads/main"));
        assert!(servable_ref("refs/tags/v1.0.0"));
        assert!(servable_ref("refs/heads/feature/x-y_z"));
        for bad in [
            "HEAD",
            "refs/heads/",
            "refs/heads/a..b",
            "refs/heads/.hidden",
            "refs/heads/x.lock",
            "refs/heads/a b",
            "refs/heads/a~1",
            "refs/heads/a@{1}",
            "refs/heads//x",
            "refs/forge-gateway/r/refs/heads/main",
        ] {
            assert!(!servable_ref(bad), "{bad}");
        }
    }
}
