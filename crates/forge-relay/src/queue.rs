//! The durable delivery retry queue.
//!
//! A delivery that fails every attempt of its in-window retries ([`crate::deliver`]) is
//! written here and retried later, on a backoff schedule ([`DEFAULT_SCHEDULE`]: 1 min, 5 min,
//! 30 min, 2 h, 12 h, 24 h, then every 24 h), until it succeeds or is [`EXPIRY`] old (48 h), when
//! it is dropped with one log line. The queue survives restarts. Failed deliveries are
//! written, and on a graceful stop so are the events still waiting in a hook's in-memory
//! queue or in flight; a crash loses those. A failure retrying cannot fix (a body over the
//! cap, a 4xx other than 408/429, a URL the SSRF guard refuses) is not queued at all.
//!
//! **On disk:** `<state dir>/deliveries/<delivery id>.json`, one file per delivery, mode 0600
//! in a 0700 directory the relay user owns (checked at startup and tightened to 0700 if looser;
//! a symlink or another owner is refused), written
//! by a background thread through a fresh temp file and a rename, so a crash never leaves half
//! a file and no fsync runs on the async threads. An entry holds what a retry needs and nothing
//! secret: repo id, hook id, GitHub event name, the source document id, the JSON body (public
//! chain data), attempt count, times and the last error (already redacted: no URL beyond
//! scheme and host). Not the secret, not the URL: a retry goes through the hook's current
//! subscription, so it is signed with the hook's **current** secret, sent to its current URL
//! through the SSRF guard (re-resolved and pinned), and never sent at all if the hook was
//! removed or disabled meanwhile. An exclusive lock on `deliveries/.lock`, held while the
//! relay runs, keeps a second relay off the same queue.
//!
//! **In memory:** the index, and each pending body as its serialized JSON text, so the byte
//! bound is what the bodies really take. When the state dir cannot be used the relay runs on
//! an in-memory queue ([`RetryQueue::in_memory`]): the same retries, lost on restart.
//!
//! **Bounds:** at most [`MAX_PENDING_PER_HOOK`] pending entries per hook,
//! [`MAX_PENDING_PER_REPO`] per repo, [`MAX_PENDING`] in total and [`MAX_PENDING_BYTES`] of
//! bodies. Past a hook's or repo's bound its own oldest entry is dropped; past a global bound,
//! the oldest entry of the repo holding the most, so one repo cannot evict the others. Every
//! drop logs a line. Dropped entries are kept (without their body) for `forge-relay
//! deliveries` to show, at most [`MAX_DROPPED`] of them and for [`DROPPED_RETENTION`].

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;

use crate::error::{RelayError, Result};

/// The retry delays after the 1st, 2nd, ... failed delivery; the last repeats.
pub const DEFAULT_SCHEDULE: [Duration; 6] = [
    Duration::from_mins(1),
    Duration::from_mins(5),
    Duration::from_mins(30),
    Duration::from_hours(2),
    Duration::from_hours(12),
    Duration::from_hours(24),
];

/// A pending delivery older than this is dropped (also the longest configurable delay).
pub const EXPIRY: Duration = Duration::from_hours(48);

/// Pending entries per hook.
pub const MAX_PENDING_PER_HOOK: usize = 500;

/// Pending entries per repo (all its hooks together).
pub const MAX_PENDING_PER_REPO: usize = 1000;

/// Pending entries in total.
pub const MAX_PENDING: usize = 5000;

/// Bytes of pending bodies in total.
pub const MAX_PENDING_BYTES: usize = 256 * 1024 * 1024;

/// Dropped entries kept for inspection.
pub const MAX_DROPPED: usize = 1000;

/// How long a dropped entry is kept for inspection.
pub const DROPPED_RETENTION: Duration = Duration::from_hours(7 * 24);

/// Longest last-error text kept.
const MAX_ERROR_LEN: usize = 300;

/// The directory the queue lives in, under a state dir.
pub fn queue_dir(state_dir: &Path) -> PathBuf {
    state_dir.join("deliveries")
}

/// The default state dir: `$FORGE_RELAY_STATE_DIR`, else `$XDG_STATE_HOME/dash-forge/relay`,
/// else `~/.local/state/dash-forge/relay`.
pub fn default_state_dir() -> Result<PathBuf> {
    let var = |k: &str| std::env::var_os(k).filter(|v| !v.is_empty());
    if let Some(dir) = var("FORGE_RELAY_STATE_DIR") {
        return Ok(PathBuf::from(dir));
    }
    if let Some(state) = var("XDG_STATE_HOME") {
        return Ok(PathBuf::from(state).join("dash-forge/relay"));
    }
    let home = var("HOME").ok_or_else(|| {
        RelayError::Config("HOME is not set; pass --state-dir for the delivery queue".into())
    })?;
    Ok(PathBuf::from(home).join(".local/state/dash-forge/relay"))
}

/// Whether a queued delivery is still being retried.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    /// Waiting for its next attempt.
    Pending,
    /// Given up (expired, hook removed, queue full); kept for inspection without its body.
    Dropped,
}

/// One queued delivery, as stored.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    /// The delivery id (`X-GitHub-Delivery`), also the file name.
    pub id: String,
    /// The repo id.
    pub repo_id: String,
    /// The hook id.
    pub hook_id: String,
    /// The GitHub event name.
    pub event: String,
    /// The source document id.
    pub source_doc_id: String,
    /// When the first delivery attempt failed (ms since the epoch).
    pub created_ms: u64,
    /// Delivery sequences tried (each is up to 5 in-window attempts).
    pub tries: u32,
    /// When the next retry is due (ms).
    pub next_ms: u64,
    /// The last error (redacted).
    pub last_error: String,
    /// Pending or dropped.
    pub status: Status,
    /// Why it was dropped.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub drop_reason: Option<String>,
    /// When it was dropped (ms).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dropped_ms: Option<u64>,
    /// The JSON body, as its serialized text; none once dropped.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payload: Option<Box<RawValue>>,
    /// The body's serialized size.
    #[serde(default)]
    pub bytes: usize,
}

impl Entry {
    /// A copy without the body (what [`RetryQueue::due`] hands out; [`RetryQueue::claim`]
    /// returns the body).
    fn head(&self) -> Self {
        Self {
            id: self.id.clone(),
            repo_id: self.repo_id.clone(),
            hook_id: self.hook_id.clone(),
            event: self.event.clone(),
            source_doc_id: self.source_doc_id.clone(),
            created_ms: self.created_ms,
            tries: self.tries,
            next_ms: self.next_ms,
            last_error: self.last_error.clone(),
            status: self.status,
            drop_reason: self.drop_reason.clone(),
            dropped_ms: self.dropped_ms,
            payload: None,
            bytes: self.bytes,
        }
    }
}

/// What failed, for [`RetryQueue::fail`].
pub struct Failure<'a> {
    /// The delivery id.
    pub id: &'a str,
    /// The repo id.
    pub repo_id: &'a str,
    /// The hook id.
    pub hook_id: &'a str,
    /// The GitHub event name.
    pub event: &'a str,
    /// The source document id.
    pub source_doc_id: &'a str,
    /// The body.
    pub payload: &'a serde_json::Value,
    /// The (redacted) error.
    pub error: &'a str,
    /// The caller holds this id's claim (a retry handed out by [`RetryQueue::claim`]): release
    /// it once the entry is updated. Anyone else leaves the claim alone.
    pub claimed: bool,
}

/// The bounds (constants; tests shrink them).
#[derive(Debug, Clone, Copy)]
struct Limits {
    per_hook: usize,
    per_repo: usize,
    total: usize,
    bytes: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            per_hook: MAX_PENDING_PER_HOOK,
            per_repo: MAX_PENDING_PER_REPO,
            total: MAX_PENDING,
            bytes: MAX_PENDING_BYTES,
        }
    }
}

/// `(created ms, id)`: pending entries in age order.
type Aged = BTreeSet<(u64, String)>;

/// One repo's pending entries.
#[derive(Debug, Default)]
struct Tally {
    aged: Aged,
    bytes: usize,
}

/// The entries and the indexes the bounds use, kept in step (under one lock).
#[derive(Debug, Default)]
struct State {
    entries: BTreeMap<String, Entry>,
    /// Retries handed to a worker and not finished yet.
    claimed: HashSet<String>,
    /// Every pending entry.
    aged: Aged,
    /// Pending entries per repo.
    repos: HashMap<String, Tally>,
    /// Pending entries per `(repo, hook)`.
    hooks: HashMap<(String, String), Aged>,
    /// Bytes of pending bodies.
    bytes: usize,
    /// `(dropped ms, id)` of the dropped records.
    dropped: Aged,
}

impl State {
    fn index(&mut self, e: &Entry) {
        match e.status {
            Status::Pending => {
                let key = (e.created_ms, e.id.clone());
                self.aged.insert(key.clone());
                let repo = self.repos.entry(e.repo_id.clone()).or_default();
                repo.aged.insert(key.clone());
                repo.bytes += e.bytes;
                self.hooks
                    .entry((e.repo_id.clone(), e.hook_id.clone()))
                    .or_default()
                    .insert(key);
                self.bytes += e.bytes;
            }
            Status::Dropped => {
                self.dropped
                    .insert((e.dropped_ms.unwrap_or(0), e.id.clone()));
            }
        }
    }

    fn unindex(&mut self, e: &Entry) {
        match e.status {
            Status::Pending => {
                let key = (e.created_ms, e.id.clone());
                self.aged.remove(&key);
                if let Some(repo) = self.repos.get_mut(&e.repo_id) {
                    repo.aged.remove(&key);
                    repo.bytes = repo.bytes.saturating_sub(e.bytes);
                    if repo.aged.is_empty() {
                        self.repos.remove(&e.repo_id);
                    }
                }
                let hook = (e.repo_id.clone(), e.hook_id.clone());
                if let Some(aged) = self.hooks.get_mut(&hook) {
                    aged.remove(&key);
                    if aged.is_empty() {
                        self.hooks.remove(&hook);
                    }
                }
                self.bytes = self.bytes.saturating_sub(e.bytes);
            }
            Status::Dropped => {
                self.dropped
                    .remove(&(e.dropped_ms.unwrap_or(0), e.id.clone()));
            }
        }
    }

    fn is_pending(&self, id: &str) -> bool {
        self.entries
            .get(id)
            .is_some_and(|e| e.status == Status::Pending)
    }

    /// Remove every pending-index key of `id` (an index out of step with `entries`; should
    /// not happen, but a housekeeping loop must not spin on it).
    fn purge_pending_keys(&mut self, id: &str) {
        let hit = |k: &(u64, String)| k.1 != id;
        self.aged.retain(hit);
        for t in self.repos.values_mut() {
            t.aged.retain(hit);
        }
        self.repos.retain(|_, t| !t.aged.is_empty());
        for a in self.hooks.values_mut() {
            a.retain(hit);
        }
        self.hooks.retain(|_, a| !a.is_empty());
    }
}

/// What the writer thread still has to do: the latest content of each changed entry (`None`
/// = delete its file), so repeated updates of one entry cost one write.
#[derive(Debug, Default)]
struct Pending {
    ops: BTreeMap<String, Option<Vec<u8>>>,
    busy: bool,
    stop: bool,
}

#[derive(Debug, Default)]
struct WriterShared {
    pending: Mutex<Pending>,
    cv: Condvar,
}

impl WriterShared {
    fn lock(&self) -> MutexGuard<'_, Pending> {
        self.pending.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// The on-disk side: the directory, its lock, and the thread that writes it.
#[derive(Debug)]
struct Disk {
    dir: PathBuf,
    shared: Arc<WriterShared>,
    thread: Option<std::thread::JoinHandle<()>>,
    /// Held (locked) for the queue's lifetime; released when the file closes.
    _lock: std::fs::File,
}

impl Disk {
    fn send(&self, id: &str, op: Option<Vec<u8>>) {
        self.shared.lock().ops.insert(id.to_string(), op);
        self.shared.cv.notify_all();
    }

    /// Wait until everything sent so far is on disk.
    fn flush(&self) {
        let mut p = self.shared.lock();
        while !p.ops.is_empty() || p.busy {
            p = self
                .shared
                .cv
                .wait(p)
                .unwrap_or_else(PoisonError::into_inner);
        }
    }
}

impl Drop for Disk {
    fn drop(&mut self) {
        self.shared.lock().stop = true;
        self.shared.cv.notify_all();
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

/// The writer thread: apply the pending ops in batches, one directory sync per batch; exits
/// once stopped and drained.
fn writer_loop(dir: &Path, shared: &WriterShared) {
    loop {
        let batch = {
            let mut p = shared.lock();
            while p.ops.is_empty() && !p.stop {
                p = shared.cv.wait(p).unwrap_or_else(PoisonError::into_inner);
            }
            if p.ops.is_empty() {
                return;
            }
            p.busy = true;
            std::mem::take(&mut p.ops)
        };
        for (id, op) in batch {
            let result = match op {
                Some(bytes) => write_entry(dir, &id, &bytes),
                None => match std::fs::remove_file(dir.join(format!("{id}.json"))) {
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                    other => other,
                },
            };
            if let Err(err) = result {
                tracing::error!(id = %id, error = %err, "could not update a queued delivery on disk; it lives in memory until the relay stops");
            }
        }
        if let Err(err) = std::fs::File::open(dir).and_then(|d| d.sync_all()) {
            tracing::warn!(dir = %dir.display(), error = %err, "could not sync the delivery queue directory");
        }
        shared.lock().busy = false;
        shared.cv.notify_all();
    }
}

/// `O_NOFOLLOW` for [`std::os::unix::fs::OpenOptionsExt::custom_flags`].
#[cfg(unix)]
fn nofollow() -> i32 {
    rustix::fs::OFlags::NOFOLLOW.bits().cast_signed()
}

/// Options for a private (0600) file that is never reached through a symlink.
fn private_file() -> std::fs::OpenOptions {
    let mut o = std::fs::OpenOptions::new();
    o.write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.mode(0o600).custom_flags(nofollow());
    }
    o
}

/// A directory builder creating 0700 directories (atomically, not chmod afterwards).
fn private_dir() -> std::fs::DirBuilder {
    let mut b = std::fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        b.mode(0o700);
    }
    b
}

/// Create `dir` (mode 0700) if missing, then require it to be a real directory this user owns
/// ([`check_private_dir`]). Its parent must exist.
pub(crate) fn ensure_private_dir(dir: &Path) -> std::io::Result<()> {
    match private_dir().create(dir) {
        Err(e) if e.kind() != std::io::ErrorKind::AlreadyExists => return Err(e),
        _ => {}
    }
    check_private_dir(dir)
}

/// Write one entry durably: a stale temp file is unlinked, a fresh one created exclusively
/// (never through a symlink), synced, then renamed over the entry.
pub(crate) fn write_entry(dir: &Path, id: &str, bytes: &[u8]) -> std::io::Result<()> {
    let path = dir.join(format!("{id}.json"));
    let tmp = dir.join(format!(".{id}.tmp"));
    match std::fs::remove_file(&tmp) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e),
        _ => {}
    }
    let mut f = private_file().create_new(true).open(&tmp)?;
    std::io::Write::write_all(&mut f, bytes)?;
    f.sync_all()?;
    std::fs::rename(&tmp, &path)
}

/// `dir` must be a real directory (not a symlink) owned by this user; its mode is tightened
/// to 0700 if it is looser (the directory is ours, so that is safe; a symlink or a directory
/// someone else owns is refused). The checks and the chmod act on one handle opened without
/// following symlinks, so a swap of the path in between cannot redirect them.
#[cfg(unix)]
fn check_private_dir(dir: &Path) -> std::io::Result<()> {
    use rustix::fs::{Mode, OFlags};
    let fd = rustix::fs::open(
        dir,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map_err(|e| {
        std::io::Error::other(format!(
            "it is not a directory, or it is a symlink (refused): {e}"
        ))
    })?;
    let st = rustix::fs::fstat(&fd)?;
    let uid = rustix::process::geteuid().as_raw();
    if st.st_uid != uid {
        return Err(std::io::Error::other(format!(
            "it is owned by uid {}, not by this user (uid {uid})",
            st.st_uid
        )));
    }
    let mode = rustix::fs::Mode::from_raw_mode(st.st_mode).bits() & 0o777;
    if mode != 0o700 {
        tracing::warn!(dir = %dir.display(), mode = format!("{mode:o}"), "tightening the delivery queue directory to mode 700");
        rustix::fs::fchmod(&fd, Mode::RWXU)?;
    }
    Ok(())
}

/// Elsewhere: a real directory.
#[cfg(not(unix))]
fn check_private_dir(dir: &Path) -> std::io::Result<()> {
    if std::fs::symlink_metadata(dir)?.file_type().is_dir() {
        Ok(())
    } else {
        Err(std::io::Error::other(
            "it is not a directory (a symlink is refused)",
        ))
    }
}

/// Read every entry file of `dir` (a missing dir is empty). Only regular `<id>.json` files
/// are read (not symlinks); unreadable ones are skipped with a warning. Takes no lock and
/// makes no network calls: `forge-relay deliveries` uses this while the relay runs.
pub fn read_dir(dir: &Path) -> Result<Vec<Entry>> {
    let rd = match std::fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(RelayError::Io(format!("reading {}: {e}", dir.display()))),
    };
    let mut out = Vec::new();
    for f in rd.flatten() {
        let path = f.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        if !f.file_type().is_ok_and(|t| t.is_file()) {
            tracing::warn!(file = %path.display(), "skipping a queue file that is not a regular file");
            continue;
        }
        let stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or_default();
        let read = || -> std::io::Result<Vec<u8>> {
            let mut o = std::fs::OpenOptions::new();
            o.read(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                o.custom_flags(nofollow());
            }
            let mut buf = Vec::new();
            std::io::Read::read_to_end(&mut o.open(&path)?, &mut buf)?;
            Ok(buf)
        };
        match read()
            .map_err(|e| e.to_string())
            .and_then(|b| serde_json::from_slice::<Entry>(&b).map_err(|e| e.to_string()))
            .and_then(|e| {
                // The id names the file it is written to: it must be the file's own name, and
                // the shape delivery ids have (no path separators or dots).
                let shaped =
                    e.id.len() == 36 && e.id.chars().all(|c| c.is_ascii_hexdigit() || c == '-');
                if shaped && e.id == stem {
                    Ok(e)
                } else {
                    Err("its id does not match its file name".to_string())
                }
            }) {
            Ok(e) => out.push(e),
            Err(e) => {
                tracing::warn!(file = %path.display(), error = %e, "skipping an unreadable queue file");
            }
        }
    }
    Ok(out)
}

/// Milliseconds of a duration (saturating).
fn ms(d: Duration) -> u64 {
    u64::try_from(d.as_millis()).unwrap_or(u64::MAX)
}

/// The queue: an in-memory index, written through to the files by a background thread.
pub struct RetryQueue {
    /// `None`: in memory only.
    disk: Option<Disk>,
    schedule: Vec<Duration>,
    limits: Limits,
    state: Mutex<State>,
}

impl std::fmt::Debug for RetryQueue {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RetryQueue")
            .field("dir", &self.disk.as_ref().map(|d| &d.dir))
            .finish_non_exhaustive()
    }
}

impl RetryQueue {
    /// Open (creating `<state dir>/deliveries`, mode 0700) and load the queue. Fails with
    /// [`RelayError::StateLocked`] when another relay holds the queue, and with
    /// [`RelayError::Io`] when the directory cannot be created, is not a private directory of
    /// this user, or cannot be read.
    pub fn open(state_dir: &Path, schedule: Vec<Duration>) -> Result<Self> {
        let dir = queue_dir(state_dir);
        let io = |what: &str, e: std::io::Error| {
            RelayError::Io(format!("{what} {}: {e}", dir.display()))
        };
        if !state_dir.exists() {
            // A state dir we create is private too; an existing one is left as it is.
            private_dir()
                .recursive(true)
                .create(state_dir)
                .map_err(|e| io("creating", e))?;
        }
        ensure_private_dir(&dir).map_err(|e| io("refusing to use", e))?;
        let lock_path = dir.join(".lock");
        let lock = private_file()
            .create(true)
            .truncate(false)
            .open(&lock_path)
            .map_err(|e| io("opening the lock in", e))?;
        match lock.try_lock() {
            Ok(()) => {}
            Err(std::fs::TryLockError::WouldBlock) => {
                return Err(RelayError::StateLocked(format!(
                    "another forge-relay is using the delivery queue in {}; give each relay its \
                     own --state-dir",
                    dir.display()
                )));
            }
            Err(std::fs::TryLockError::Error(e)) => return Err(io("locking", e)),
        }
        // Temp files left by a crash mid-write (unlinking never follows a symlink).
        for f in std::fs::read_dir(&dir)
            .map_err(|e| io("reading", e))?
            .flatten()
        {
            let name = f.file_name();
            let name = name.to_string_lossy();
            if name.starts_with('.') && name.ends_with(".tmp") {
                let _ = std::fs::remove_file(f.path());
            }
        }
        let mut state = State::default();
        let mut bodiless = Vec::new();
        for mut e in read_dir(&dir)? {
            e.bytes = e.payload.as_ref().map_or(0, |p| p.get().len());
            if e.status == Status::Pending && e.payload.is_none() {
                bodiless.push(e.id.clone());
            }
            state.index(&e);
            state.entries.insert(e.id.clone(), e);
        }
        let shared = Arc::new(WriterShared::default());
        let thread = {
            let (dir, shared) = (dir.clone(), Arc::clone(&shared));
            std::thread::Builder::new()
                .name("relay-queue-writer".into())
                .spawn(move || writer_loop(&dir, &shared))
                .map_err(|e| io("starting the writer for", e))?
        };
        let q = Self {
            disk: Some(Disk {
                dir,
                shared,
                thread: Some(thread),
                _lock: lock,
            }),
            ..Self::in_memory(schedule)
        }
        .with_state(state);
        {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, ms);
            let mut st = q.lock();
            for id in bodiless {
                q.mark_dropped(&mut st, &id, "no body stored (unreadable entry)", now);
            }
            q.enforce_all(&mut st, now);
        }
        Ok(q)
    }

    /// A queue kept in memory only (the state dir is unusable): retries work the same, but
    /// are lost when the relay stops.
    pub fn in_memory(schedule: Vec<Duration>) -> Self {
        Self {
            disk: None,
            schedule: if schedule.is_empty() {
                DEFAULT_SCHEDULE.to_vec()
            } else {
                schedule
            },
            limits: Limits::default(),
            state: Mutex::new(State::default()),
        }
    }

    fn with_state(self, state: State) -> Self {
        *self.lock() = state;
        self
    }

    /// Whether entries reach the disk.
    pub fn is_durable(&self) -> bool {
        self.disk.is_some()
    }

    /// The delay before the retry after `tries` failed deliveries (`tries >= 1`).
    pub fn delay_after(&self, tries: u32) -> Duration {
        let i = (tries.max(1) as usize - 1).min(self.schedule.len() - 1);
        self.schedule[i]
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Hand `e`'s current content to the writer.
    fn persist(&self, e: &Entry) {
        if let Some(disk) = &self.disk {
            match serde_json::to_vec(e) {
                Ok(bytes) => disk.send(&e.id, Some(bytes)),
                Err(err) => {
                    tracing::error!(id = %e.id, error = %err, "could not serialize a queued delivery");
                }
            }
        }
    }

    fn unlink(&self, id: &str) {
        if let Some(disk) = &self.disk {
            disk.send(id, None);
        }
    }

    /// Wait until every change so far is on disk (at shutdown; dropping the queue also drains
    /// the writer).
    pub fn flush(&self) {
        if let Some(disk) = &self.disk {
            disk.flush();
        }
    }

    /// Mark the pending entry `id` dropped (log it, free its body, keep the record), then
    /// trim the dropped records to [`MAX_DROPPED`].
    fn mark_dropped(&self, st: &mut State, id: &str, reason: &str, now: u64) {
        let Some(mut e) = st.entries.remove(id) else {
            st.purge_pending_keys(id);
            return;
        };
        if e.status == Status::Pending {
            st.unindex(&e);
            tracing::warn!(
                id = %e.id,
                repo = %e.repo_id,
                hook = %e.hook_id,
                event = %e.event,
                source = %e.source_doc_id,
                tries = e.tries,
                reason,
                "DEAD-LETTER: dropped a queued delivery"
            );
            e.status = Status::Dropped;
            e.drop_reason = Some(reason.to_string());
            e.dropped_ms = Some(now);
            e.payload = None;
            e.bytes = 0;
            st.index(&e);
            self.persist(&e);
        } else {
            st.purge_pending_keys(id);
        }
        st.entries.insert(e.id.clone(), e);
        while st.dropped.len() > MAX_DROPPED {
            if let Some((_, old)) = st.dropped.pop_first() {
                st.entries.remove(&old);
                self.unlink(&old);
            }
        }
    }

    /// Record a failed delivery: a new entry (1 try) or one more try of a queued one, due again
    /// after the backoff, or at `defer_until` if given (an open circuit; no try is counted then
    /// if `count` is false). Enforces the bounds. Releases the claim if the caller holds it
    /// ([`Failure::claimed`]), only after the entry is updated, so it is never handed out
    /// again before its new due time.
    ///
    /// Returns whether the delivery is queued; `false` when it was dropped already (or the
    /// bounds dropped it at once).
    pub fn fail(&self, f: &Failure<'_>, now: u64, count: bool, defer_until: Option<u64>) -> bool {
        let mut st = self.lock();
        let queued = self.fail_locked(&mut st, f, now, count, defer_until);
        if f.claimed {
            st.claimed.remove(f.id);
        }
        queued
    }

    fn fail_locked(
        &self,
        st: &mut State,
        f: &Failure<'_>,
        now: u64,
        count: bool,
        defer_until: Option<u64>,
    ) -> bool {
        if !st.entries.contains_key(f.id) {
            let payload = serde_json::to_string(f.payload)
                .ok()
                .and_then(|s| RawValue::from_string(s).ok());
            let e = Entry {
                id: f.id.to_string(),
                repo_id: f.repo_id.to_string(),
                hook_id: f.hook_id.to_string(),
                event: f.event.to_string(),
                source_doc_id: f.source_doc_id.to_string(),
                created_ms: now,
                tries: 0,
                next_ms: now,
                last_error: String::new(),
                status: Status::Pending,
                drop_reason: None,
                dropped_ms: None,
                bytes: payload.as_ref().map_or(0, |p| p.get().len()),
                payload,
            };
            st.index(&e);
            st.entries.insert(e.id.clone(), e);
        }
        let backoff = |tries| now.saturating_add(ms(self.delay_after(tries)));
        let Some(e) = st
            .entries
            .get_mut(f.id)
            .filter(|e| e.status == Status::Pending)
        else {
            return false; // given up already
        };
        if count {
            e.tries = e.tries.saturating_add(1);
        }
        e.last_error = f.error.chars().take(MAX_ERROR_LEN).collect();
        e.next_ms = defer_until.map_or_else(|| backoff(e.tries), |t| t.max(now));
        let (repo, hook) = (e.repo_id.clone(), e.hook_id.clone());
        self.persist(e);
        self.enforce_bounds(st, &repo, &hook, now);
        st.is_pending(f.id)
    }

    /// Put a due entry back without counting a try (its hook is not being served yet, or its
    /// circuit is open).
    pub fn defer(&self, id: &str, until: u64) {
        let mut st = self.lock();
        if let Some(e) = st
            .entries
            .get_mut(id)
            .filter(|e| e.status == Status::Pending && e.next_ms != until)
        {
            e.next_ms = until;
            self.persist(e);
        }
    }

    /// A delivery with this id succeeded: forget it (and its claim).
    pub fn succeeded(&self, id: &str) {
        let mut st = self.lock();
        if let Some(e) = st.entries.remove(id) {
            st.unindex(&e);
            self.unlink(id);
        }
        st.claimed.remove(id);
    }

    /// Drop a pending entry (hook removed, a permanent failure, ...), and its claim.
    pub fn drop_entry(&self, id: &str, reason: &str, now: u64) {
        let mut st = self.lock();
        if st.is_pending(id) {
            self.mark_dropped(&mut st, id, reason, now);
        }
        st.claimed.remove(id);
    }

    /// Drop every pending entry whose `(repo id, hook id)` matches (a hook removed or disabled:
    /// its retries must never reach it, even if it comes back under the same id).
    pub fn drop_where(&self, matches: impl Fn(&str, &str) -> bool, reason: &str, now: u64) {
        let mut st = self.lock();
        let ids: Vec<String> = st
            .hooks
            .iter()
            .filter(|((repo, hook), _)| matches(repo, hook))
            .flat_map(|(_, aged)| aged.iter().map(|(_, id)| id.clone()))
            .collect();
        for id in ids {
            self.mark_dropped(&mut st, &id, reason, now);
        }
    }

    /// The repos with pending entries.
    pub fn pending_repos(&self) -> HashSet<String> {
        self.lock().repos.keys().cloned().collect()
    }

    /// Whether `id` is still pending (a retry handed out may have been dropped since).
    pub fn is_pending(&self, id: &str) -> bool {
        self.lock().is_pending(id)
    }

    /// Housekeeping, then the pending entries due at `now` that are not already handed out,
    /// without their bodies: expire entries older than [`EXPIRY`] (one log line each) and
    /// prune dropped records past [`DROPPED_RETENTION`]. No disk I/O on the caller's thread.
    pub fn due(&self, now: u64) -> Vec<Entry> {
        let expiry = ms(EXPIRY);
        let keep = ms(DROPPED_RETENTION);
        let mut st = self.lock();
        while let Some((created, id)) = st.aged.first().cloned() {
            if now.saturating_sub(created) < expiry {
                break;
            }
            self.mark_dropped(&mut st, &id, "expired: undelivered for 48 h", now);
        }
        while let Some((dropped, id)) = st.dropped.first().cloned() {
            if now.saturating_sub(dropped) < keep {
                break;
            }
            st.dropped.pop_first();
            st.entries.remove(&id);
            self.unlink(&id);
        }
        st.entries
            .values()
            .filter(|e| e.status == Status::Pending && e.next_ms <= now)
            .filter(|e| !st.claimed.contains(&e.id))
            .map(Entry::head)
            .collect()
    }

    /// Claim a due entry for its hook's worker (not handed out again until released) and
    /// return its body; `None` if it is no longer pending or is claimed already.
    pub fn claim(&self, id: &str) -> Option<Box<RawValue>> {
        let mut st = self.lock();
        let payload = st
            .entries
            .get(id)
            .filter(|e| e.status == Status::Pending)?
            .payload
            .clone()?;
        st.claimed.insert(id.to_string()).then_some(payload)
    }

    /// Release a claim (the worker finished with it, or never got it).
    pub fn release(&self, id: &str) {
        self.lock().claimed.remove(id);
    }

    /// Drop the oldest pending entries past the bounds: `hook`'s own past its bound, `repo`'s
    /// own past its bound, then, past a global bound, the oldest of the repo holding the most
    /// (entries past the count bound, bytes past the byte bound). Incremental: no full scan.
    fn enforce_bounds(&self, st: &mut State, repo: &str, hook: &str, now: u64) {
        self.enforce_hook_bound(st, repo, hook, now);
        self.enforce_repo_bound(st, repo, now);
        self.enforce_global_bounds(st, now);
    }

    fn enforce_hook_bound(&self, st: &mut State, repo: &str, hook: &str, now: u64) {
        let key = (repo.to_string(), hook.to_string());
        while let Some(id) = st
            .hooks
            .get(&key)
            .filter(|a| a.len() > self.limits.per_hook)
            .and_then(|a| a.first().map(|(_, id)| id.clone()))
        {
            self.mark_dropped(st, &id, "queue full for this hook (oldest dropped)", now);
        }
    }

    fn enforce_repo_bound(&self, st: &mut State, repo: &str, now: u64) {
        while let Some(id) = st
            .repos
            .get(repo)
            .filter(|t| t.aged.len() > self.limits.per_repo)
            .and_then(|t| t.aged.first().map(|(_, id)| id.clone()))
        {
            self.mark_dropped(st, &id, "queue full for this repo (oldest dropped)", now);
        }
    }

    fn enforce_global_bounds(&self, st: &mut State, now: u64) {
        loop {
            let by_count = st.aged.len() > self.limits.total;
            if !by_count && st.bytes <= self.limits.bytes {
                break;
            }
            let Some(id) = st
                .repos
                .values()
                .max_by_key(|t| if by_count { t.aged.len() } else { t.bytes })
                .and_then(|t| t.aged.first().map(|(_, id)| id.clone()))
            else {
                break;
            };
            self.mark_dropped(
                st,
                &id,
                "queue full (oldest of the repo with the most queued dropped)",
                now,
            );
        }
    }

    /// Enforce every bound (a queue loaded from disk, possibly written under other limits).
    /// Every hook's bound first, then every repo's, then the global ones, so a global
    /// eviction never takes an entry a narrower bound would have spared.
    fn enforce_all(&self, st: &mut State, now: u64) {
        let hooks: Vec<(String, String)> = st.hooks.keys().cloned().collect();
        for (repo, hook) in hooks {
            self.enforce_hook_bound(st, &repo, &hook, now);
        }
        let repos: Vec<String> = st.repos.keys().cloned().collect();
        for repo in repos {
            self.enforce_repo_bound(st, &repo, now);
        }
        self.enforce_global_bounds(st, now);
        while st.dropped.len() > MAX_DROPPED {
            if let Some((_, old)) = st.dropped.pop_first() {
                st.entries.remove(&old);
                self.unlink(&old);
            }
        }
    }

    /// Every entry (for tests and diagnostics).
    #[cfg(test)]
    pub fn snapshot(&self) -> Vec<Entry> {
        self.lock().entries.values().cloned().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const H: u64 = 3600 * 1000;
    const ID1: &str = "b50f124f-72a9-90b7-c943-e486822a82f0";

    fn dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("relay-queue-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    fn failure<'a>(id: &'a str, hook: &'a str, payload: &'a serde_json::Value) -> Failure<'a> {
        Failure {
            id,
            repo_id: "R",
            hook_id: hook,
            event: "push",
            source_doc_id: "doc",
            payload,
            error: "HTTP 503 Service Unavailable",
            claimed: false,
        }
    }

    fn get(q: &RetryQueue, id: &str) -> Entry {
        q.snapshot().into_iter().find(|e| e.id == id).unwrap()
    }

    #[test]
    fn the_backoff_schedule() {
        let q = RetryQueue::in_memory(Vec::new());
        let mins: Vec<u64> = (1..=8).map(|t| q.delay_after(t).as_secs() / 60).collect();
        assert_eq!(mins, [1, 5, 30, 120, 720, 1440, 1440, 1440]);
        // Each failure pushes the next attempt out by the next delay.
        let p = serde_json::json!({ "x": 1 });
        assert!(q.fail(&failure("a", "h", &p), 0, true, None));
        assert_eq!(q.snapshot()[0].next_ms, 60_000);
        q.fail(&failure("a", "h", &p), 60_000, true, None);
        assert_eq!(q.snapshot()[0].next_ms, 60_000 + 5 * 60_000);
        assert_eq!(q.snapshot()[0].tries, 2);
        // A deferral (open circuit) does not count a try.
        q.fail(&failure("a", "h", &p), 100, false, Some(9_999));
        assert_eq!((q.snapshot()[0].tries, q.snapshot()[0].next_ms), (2, 9_999));
        // A due time past the end of time saturates instead of wrapping to "due now".
        q.fail(&failure("a", "h", &p), u64::MAX - 5, true, None);
        assert_eq!(q.snapshot()[0].next_ms, u64::MAX);
    }

    #[test]
    #[allow(clippy::many_single_char_names)]
    fn it_survives_a_restart_without_secrets_and_with_tight_modes() {
        let d = dir("persist");
        let p = serde_json::json!({ "ref": "refs/heads/main" });
        {
            let q = RetryQueue::open(&d, Vec::new()).unwrap();
            assert!(q.is_durable());
            q.fail(&failure(ID1, "h", &p), 1000, true, None);
        }
        let q = RetryQueue::open(&d, Vec::new()).unwrap();
        let e = &q.snapshot()[0];
        assert_eq!((e.id.as_str(), e.tries, e.next_ms), (ID1, 1, 61_000));
        assert_eq!(e.payload.as_ref().unwrap().get(), p.to_string());
        let raw = std::fs::read_to_string(queue_dir(&d).join(format!("{ID1}.json"))).unwrap();
        let fields: serde_json::Map<String, serde_json::Value> =
            serde_json::from_str(&raw).unwrap();
        for key in fields.keys() {
            let k = key.to_lowercase();
            assert!(
                !k.contains("secret") && !k.contains("url"),
                "{key} stored: {raw}"
            );
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode(&queue_dir(&d).join(format!("{ID1}.json"))), 0o600);
            assert_eq!(mode(&queue_dir(&d)), 0o700);
            assert_eq!(mode(&d), 0o700);
        }
        // Success forgets it, on disk too.
        q.succeeded(ID1);
        q.flush();
        assert!(read_dir(&queue_dir(&d)).unwrap().is_empty());
        drop(q);

        // A file whose id is not its own name (or not a delivery id) is not loaded; a crash's
        // temp file is cleaned up on open.
        let mut forged: serde_json::Value = serde_json::from_str(&raw).unwrap();
        forged["id"] = serde_json::Value::from("../../escape");
        std::fs::write(
            queue_dir(&d).join(format!("{ID1}.json")),
            forged.to_string(),
        )
        .unwrap();
        std::fs::write(queue_dir(&d).join(".x.tmp"), "half").unwrap();
        let q = RetryQueue::open(&d, Vec::new()).unwrap();
        assert!(q.snapshot().is_empty());
        assert!(!queue_dir(&d).join(".x.tmp").exists());
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn a_second_relay_cannot_open_a_queue_in_use_but_deliveries_can_read_it() {
        let d = dir("lock");
        let q = RetryQueue::open(&d, Vec::new()).unwrap();
        let p = serde_json::json!({});
        q.fail(&failure(ID1, "h", &p), 0, true, None);
        q.flush();
        let err = RetryQueue::open(&d, Vec::new()).unwrap_err();
        assert!(matches!(err, RelayError::StateLocked(_)), "{err}");
        // `forge-relay deliveries` reads without the lock.
        assert_eq!(read_dir(&queue_dir(&d)).unwrap().len(), 1);
        // Released when the holder stops.
        drop(q);
        assert_eq!(
            RetryQueue::open(&d, Vec::new()).unwrap().snapshot().len(),
            1
        );
        std::fs::remove_dir_all(&d).ok();
    }

    #[cfg(unix)]
    #[test]
    fn an_unsafe_state_dir_is_refused_and_symlinks_are_not_followed() {
        use std::os::unix::fs::PermissionsExt;
        // `deliveries` as a symlink to somewhere else.
        let d = dir("symlink");
        let elsewhere = dir("symlink-target");
        std::fs::create_dir_all(&d).unwrap();
        private_dir().create(&elsewhere).unwrap();
        std::os::unix::fs::symlink(&elsewhere, queue_dir(&d)).unwrap();
        let err = RetryQueue::open(&d, Vec::new()).unwrap_err();
        assert!(err.to_string().contains("symlink"), "{err}");
        std::fs::remove_dir_all(&d).ok();
        std::fs::remove_dir_all(&elsewhere).ok();

        // A group- or world-readable queue dir of ours is tightened, not refused.
        let d = dir("loose");
        std::fs::create_dir_all(queue_dir(&d)).unwrap();
        std::fs::set_permissions(queue_dir(&d), std::fs::Permissions::from_mode(0o755)).unwrap();
        drop(RetryQueue::open(&d, Vec::new()).unwrap());
        let mode = std::fs::metadata(queue_dir(&d))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o700);

        // A symlinked entry is not read, and a planted temp-file symlink is not written
        // through.
        let victim = d.join("victim");
        std::fs::write(&victim, "untouched").unwrap();
        let good = serde_json::json!({
            "id": ID1, "repoId": "R", "hookId": "h", "event": "push", "sourceDocId": "doc",
            "createdMs": 0, "tries": 1, "nextMs": 0, "lastError": "", "status": "pending",
        });
        std::fs::write(&victim, good.to_string()).unwrap();
        std::os::unix::fs::symlink(&victim, queue_dir(&d).join(format!("{ID1}.json"))).unwrap();
        assert!(read_dir(&queue_dir(&d)).unwrap().is_empty());
        std::fs::remove_file(queue_dir(&d).join(format!("{ID1}.json"))).unwrap();
        std::os::unix::fs::symlink(&victim, queue_dir(&d).join(format!(".{ID1}.tmp"))).unwrap();
        write_entry(&queue_dir(&d), ID1, b"{}").unwrap();
        assert_eq!(
            std::fs::read_to_string(&victim).unwrap(),
            good.to_string(),
            "the symlink target is untouched"
        );
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn due_entries_expire_after_48h_and_claimed_ones_are_not_handed_out_twice() {
        let q = RetryQueue::in_memory(Vec::new());
        let p = serde_json::json!({});
        q.fail(&failure("old", "h", &p), 0, true, None);
        q.fail(&failure("new", "h", &p), 47 * H, true, None);
        let due: Vec<String> = q.due(48 * H).into_iter().map(|e| e.id).collect();
        assert_eq!(due, ["new"], "the 48 h old one expired");
        let old = get(&q, "old");
        assert_eq!(old.status, Status::Dropped);
        assert!(old.drop_reason.unwrap().contains("expired"));
        assert!(old.payload.is_none(), "the body is freed");
        assert!(q.claim("new").is_some());
        assert!(q.claim("new").is_none(), "claimed once");
        assert!(q.due(48 * H + 1).is_empty(), "handed out already");
        assert!(
            q.due(60 * H).is_empty(),
            "no lease expiry: only a release frees it"
        );
        q.release("new");
        // Dropped records are pruned after their retention.
        q.due(48 * H + 8 * 24 * H);
        assert!(q.snapshot().iter().all(|e| e.id != "old"));
    }

    #[test]
    fn a_failing_retry_keeps_its_claim_until_its_new_due_time_is_set() {
        let q = RetryQueue::in_memory(Vec::new());
        let p = serde_json::json!({});
        q.fail(&failure("a", "h", &p), 0, true, None);
        assert_eq!(q.due(60_000).len(), 1);
        assert!(q.claim("a").is_some());
        // Someone else's failure of the same delivery (the enqueue overflow path) updates the
        // entry but leaves the worker's claim alone.
        q.fail(&failure("a", "h", &p), 60_000, false, Some(60_000));
        assert!(q.due(60_000).is_empty(), "still claimed by the worker");
        // The worker's own failure moves the due time first, then releases: it is not due
        // again until the backoff has passed.
        q.fail(
            &Failure {
                claimed: true,
                ..failure("a", "h", &p)
            },
            60_000,
            true,
            None,
        );
        assert!(q.due(60_000).is_empty(), "not due before the backoff");
        assert_eq!(
            q.due(60_000 + 5 * 60_000).len(),
            1,
            "released and due later"
        );
    }

    #[test]
    fn bounds_drop_the_oldest_of_the_hook_and_the_repo() {
        let mut q = RetryQueue::in_memory(Vec::new());
        q.limits = Limits {
            per_hook: 5,
            per_repo: 8,
            ..Limits::default()
        };
        let p = serde_json::json!({});
        let ids: Vec<String> = (0..8).map(|i| format!("e{i:04}")).collect();
        for (i, id) in ids.iter().enumerate() {
            q.fail(&failure(id, "h", &p), i as u64, true, None);
        }
        let pending = |q: &RetryQueue| {
            q.snapshot()
                .into_iter()
                .filter(|e| e.status == Status::Pending)
                .count()
        };
        assert_eq!(pending(&q), 5);
        for old in &ids[..3] {
            assert_eq!(get(&q, old).status, Status::Dropped, "{old}");
        }
        // Another hook of the repo has its own budget, within the repo's.
        for i in 0..4 {
            q.fail(&failure(&format!("h2-{i}"), "h2", &p), 100 + i, true, None);
        }
        assert_eq!(pending(&q), 8, "the repo's bound");
        assert_eq!(
            get(&q, "e0003").status,
            Status::Dropped,
            "the repo's oldest"
        );
    }

    #[test]
    fn a_flooding_repo_evicts_its_own_entries_not_other_repos() {
        let mut q = RetryQueue::in_memory(Vec::new());
        q.limits = Limits {
            per_hook: 100,
            per_repo: 100,
            total: 10,
            bytes: MAX_PENDING_BYTES,
        };
        let p = serde_json::json!({});
        // A quiet repo's two old retries.
        for i in 0..2 {
            q.fail(
                &Failure {
                    repo_id: "quiet",
                    ..failure(&format!("q{i}"), "h", &p)
                },
                i,
                true,
                None,
            );
        }
        // A hostile repo floods through many hooks.
        for i in 0..50 {
            let (id, hook) = (format!("f{i:03}"), format!("hook{}", i % 25));
            q.fail(
                &Failure {
                    repo_id: "flood",
                    ..failure(&id, &hook, &p)
                },
                10 + i,
                true,
                None,
            );
        }
        assert!(
            q.is_pending("q0") && q.is_pending("q1"),
            "the quiet repo keeps its retries"
        );
        let flood = q
            .snapshot()
            .into_iter()
            .filter(|e| e.status == Status::Pending && e.repo_id == "flood")
            .count();
        assert_eq!(flood, 8, "the flooding repo pays for the global bound");
        assert!(q.is_pending("f049"), "its newest are kept");
    }

    #[test]
    fn loading_drops_bodiless_entries_and_enforces_the_bounds() {
        let d = dir("load");
        private_dir().recursive(true).create(queue_dir(&d)).unwrap();
        let entry = |i: usize, body: bool| {
            let id = format!("{i:08x}-0000-0000-0000-000000000000");
            let mut v = serde_json::json!({
                "id": id, "repoId": "R", "hookId": "h", "event": "push", "sourceDocId": "doc",
                "createdMs": i, "tries": 1, "nextMs": 0, "lastError": "", "status": "pending",
            });
            if body {
                v["payload"] = serde_json::json!({ "i": i });
            }
            std::fs::write(queue_dir(&d).join(format!("{id}.json")), v.to_string()).unwrap();
            id
        };
        let bodiless = entry(0, false);
        for i in 1..=MAX_PENDING_PER_HOOK + 2 {
            entry(i, true);
        }
        let q = RetryQueue::open(&d, Vec::new()).unwrap();
        assert!(!q.is_pending(&bodiless), "no body: dropped");
        let pending = q
            .snapshot()
            .into_iter()
            .filter(|e| e.status == Status::Pending)
            .count();
        assert_eq!(
            pending, MAX_PENDING_PER_HOOK,
            "the hook's bound holds after a load"
        );
        assert!(!q.is_pending(&format!("{:08x}-0000-0000-0000-000000000000", 1)));
        drop(q);
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn an_index_out_of_step_does_not_hang_housekeeping() {
        let q = RetryQueue::in_memory(Vec::new());
        let p = serde_json::json!({});
        q.fail(&failure("a", "h", &p), 0, true, None);
        // The entry vanishes but its index keys stay (a bug elsewhere): expiry must still end.
        q.lock().entries.remove("a");
        assert!(q.due(100 * H).is_empty());
        assert!(q.lock().aged.is_empty() && q.lock().hooks.is_empty());
    }

    #[test]
    fn a_dropped_entry_is_not_revived_and_drops_are_recorded() {
        let d = dir("drop");
        let q = RetryQueue::open(&d, Vec::new()).unwrap();
        let p = serde_json::json!({});
        q.fail(&failure(ID1, "h", &p), 0, true, None);
        q.drop_entry(ID1, "hook removed or disabled", 5);
        assert!(!q.is_pending(ID1));
        assert!(
            !q.fail(&failure(ID1, "h", &p), 10, true, None),
            "a later failure does not revive it, and says so"
        );
        assert!(!q.is_pending(ID1));
        q.flush();
        let on_disk = read_dir(&queue_dir(&d)).unwrap();
        assert_eq!(
            on_disk[0].drop_reason.as_deref(),
            Some("hook removed or disabled")
        );
        drop(q);
        std::fs::remove_dir_all(&d).ok();
    }
}
