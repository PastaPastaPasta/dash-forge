//! The durable delivery retry queue.
//!
//! A delivery that fails every attempt of its in-window retries ([`crate::deliver`]) is
//! written here and retried later, on a backoff schedule ([`DEFAULT_SCHEDULE`]: 1 min, 5 min,
//! 30 min, 2 h, 12 h, 24 h, then every 24 h), until it succeeds or is [`EXPIRY`] old (48 h), when
//! it is dropped with one log line. The queue survives restarts.
//!
//! **On disk:** `<state dir>/deliveries/<delivery id>.json`, one file per delivery, mode 0600
//! in a 0700 directory, written by rename so a crash never leaves half a file. An entry holds
//! what a retry needs and nothing secret: repo id, hook id, GitHub event name, the source
//! document id, the JSON body (public chain data), attempt count, times and the last error
//! (already redacted: no URL beyond scheme and host). Not the secret, not the URL: a retry
//! goes through the hook's current subscription, so it is signed with the hook's **current**
//! secret, sent to its current URL through the SSRF guard (re-resolved and pinned), and never
//! sent at all if the hook was removed or disabled meanwhile.
//!
//! **Bounds:** at most [`MAX_PENDING_PER_HOOK`] pending entries per hook, [`MAX_PENDING`] in
//! total and [`MAX_PENDING_BYTES`] of bodies; past a bound the oldest pending entries are
//! dropped with a log line, so a dead receiver cannot fill the disk. Dropped entries are kept
//! (without their body) for `forge-relay deliveries` to show, at most [`MAX_DROPPED`] of them
//! and for [`DROPPED_RETENTION`].

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};

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

/// A pending delivery older than this is dropped.
pub const EXPIRY: Duration = Duration::from_hours(48);

/// Pending entries per hook.
pub const MAX_PENDING_PER_HOOK: usize = 500;

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
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
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
    /// The JSON body; `null` once dropped.
    #[serde(default)]
    pub payload: serde_json::Value,
    /// The body's serialized size.
    #[serde(default)]
    pub bytes: usize,
}

impl Entry {
    /// `(repo id, hook id)`.
    pub fn hook_key(&self) -> (&str, &str) {
        (&self.repo_id, &self.hook_id)
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
}

/// The queue: an in-memory index over the files, updated together.
pub struct RetryQueue {
    dir: PathBuf,
    schedule: Vec<Duration>,
    entries: Mutex<BTreeMap<String, Entry>>,
    /// Retries handed to a worker and not finished yet. The worker releases the claim on
    /// every outcome (delivered, failed, dropped, cancelled).
    claimed: Mutex<HashSet<String>>,
}

impl std::fmt::Debug for RetryQueue {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RetryQueue")
            .field("dir", &self.dir)
            .finish_non_exhaustive()
    }
}

/// Set a path's mode (unix; a no-op elsewhere).
fn set_mode(path: &Path, mode: u32) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
    }
    #[cfg(not(unix))]
    {
        let _ = (path, mode);
        Ok(())
    }
}

/// Read every entry file of `dir` (a missing dir is empty). Unreadable files are skipped with
/// a warning. Makes no network calls: `forge-relay deliveries` uses this.
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
        let stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or_default();
        match std::fs::read(&path)
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

impl RetryQueue {
    /// Open (creating `<state dir>/deliveries`, mode 0700) and load the queue.
    pub fn open(state_dir: &Path, schedule: Vec<Duration>) -> Result<Self> {
        let dir = queue_dir(state_dir);
        let io = |what: &str, e: std::io::Error| {
            RelayError::Io(format!(
                "{what} {} ({e}); pass a writable --state-dir for the delivery queue",
                dir.display()
            ))
        };
        if !state_dir.exists() {
            // A state dir we create is private too; an existing one is left as it is.
            std::fs::create_dir_all(state_dir).map_err(|e| io("creating", e))?;
            set_mode(state_dir, 0o700).map_err(|e| io("securing", e))?;
        }
        std::fs::create_dir_all(&dir).map_err(|e| io("creating", e))?;
        set_mode(&dir, 0o700).map_err(|e| io("securing", e))?;
        // Temp files left by a crash mid-write.
        for f in std::fs::read_dir(&dir)
            .map_err(|e| io("reading", e))?
            .flatten()
        {
            if f.file_name().to_string_lossy().ends_with(".tmp") {
                let _ = std::fs::remove_file(f.path());
            }
        }
        let entries = read_dir(&dir)?
            .into_iter()
            .map(|e| (e.id.clone(), e))
            .collect();
        let q = Self {
            dir,
            schedule: if schedule.is_empty() {
                DEFAULT_SCHEDULE.to_vec()
            } else {
                schedule
            },
            entries: Mutex::new(entries),
            claimed: Mutex::new(HashSet::new()),
        };
        Ok(q)
    }

    /// The delay before the retry after `tries` failed deliveries (`tries >= 1`).
    pub fn delay_after(&self, tries: u32) -> Duration {
        let i = (tries.max(1) as usize - 1).min(self.schedule.len() - 1);
        self.schedule[i]
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, BTreeMap<String, Entry>> {
        self.entries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn lock_claimed(&self) -> std::sync::MutexGuard<'_, HashSet<String>> {
        self.claimed
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Write `e` durably: a temp file (mode 0600) synced to disk, renamed over the entry, then
    /// the directory synced, so a crash leaves the old or the new entry, never a torn one.
    fn persist(&self, e: &Entry) {
        let path = self.dir.join(format!("{}.json", e.id));
        let tmp = self.dir.join(format!(".{}.tmp", e.id));
        let write = || -> std::io::Result<()> {
            let bytes = serde_json::to_vec(e).map_err(std::io::Error::other)?;
            let mut opts = std::fs::OpenOptions::new();
            opts.write(true).create(true).truncate(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                opts.mode(0o600);
            }
            let mut f = opts.open(&tmp)?;
            std::io::Write::write_all(&mut f, &bytes)?;
            f.sync_all()?;
            std::fs::rename(&tmp, &path)?;
            std::fs::File::open(&self.dir)?.sync_all()
        };
        if let Err(err) = write() {
            tracing::error!(id = %e.id, error = %err, "could not write a queued delivery to disk; it lives in memory until the relay stops");
        }
    }

    fn remove_file(&self, id: &str) {
        let _ = std::fs::remove_file(self.dir.join(format!("{id}.json")));
    }

    /// Mark `e` dropped (log it, free its body, keep the record).
    fn mark_dropped(&self, e: &mut Entry, reason: &str, now: u64) {
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
        e.payload = serde_json::Value::Null;
        e.bytes = 0;
        self.persist(e);
    }

    /// Record a failed delivery: a new entry (1 try) or one more try of a queued one, due again
    /// after the backoff, or at `defer_until` if given (an open circuit; no try is counted then
    /// if `count` is false). Enforces the bounds.
    pub fn fail(&self, f: &Failure<'_>, now: u64, count: bool, defer_until: Option<u64>) {
        self.release(f.id);
        let mut entries = self.lock();
        let e = entries.entry(f.id.to_string()).or_insert_with(|| Entry {
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
            bytes: serde_json::to_vec(f.payload).map_or(0, |b| b.len()),
            payload: f.payload.clone(),
        });
        if e.status == Status::Dropped {
            return; // given up already
        }
        if count {
            e.tries += 1;
        }
        e.last_error = f.error.chars().take(MAX_ERROR_LEN).collect();
        let backoff =
            now + u64::try_from(self.delay_after(e.tries).as_millis()).unwrap_or(u64::MAX);
        e.next_ms = defer_until.map_or(backoff, |t| t.max(now));
        let e = e.clone();
        self.persist(&e);
        self.enforce_bounds(&mut entries, &e.repo_id, &e.hook_id, now);
    }

    /// Put a due entry back without counting a try (its hook is not being served yet, or its
    /// circuit is open).
    pub fn defer(&self, id: &str, until: u64) {
        let mut entries = self.lock();
        if let Some(e) = entries
            .get_mut(id)
            .filter(|e| e.status == Status::Pending && e.next_ms != until)
        {
            e.next_ms = until;
            let e = e.clone();
            self.persist(&e);
        }
    }

    /// A delivery with this id succeeded: forget it.
    pub fn succeeded(&self, id: &str) {
        self.release(id);
        if self.lock().remove(id).is_some() {
            self.remove_file(id);
        }
    }

    /// Drop a pending entry (hook removed, ...).
    pub fn drop_entry(&self, id: &str, reason: &str, now: u64) {
        self.release(id);
        let mut entries = self.lock();
        if let Some(e) = entries.get_mut(id).filter(|e| e.status == Status::Pending) {
            self.mark_dropped(e, reason, now);
        }
    }

    /// Drop every pending entry whose `(repo id, hook id)` matches (a hook removed or disabled:
    /// its retries must never reach it, even if it comes back under the same id).
    pub fn drop_where(&self, matches: impl Fn(&str, &str) -> bool, reason: &str, now: u64) {
        let mut entries = self.lock();
        for e in entries.values_mut() {
            if e.status == Status::Pending && matches(&e.repo_id, &e.hook_id) {
                self.mark_dropped(e, reason, now);
            }
        }
    }

    /// The repos with pending entries.
    pub fn pending_repos(&self) -> HashSet<String> {
        self.lock()
            .values()
            .filter(|e| e.status == Status::Pending)
            .map(|e| e.repo_id.clone())
            .collect()
    }

    /// Whether `id` is still pending (a retry handed out may have been dropped since).
    pub fn is_pending(&self, id: &str) -> bool {
        self.lock()
            .get(id)
            .is_some_and(|e| e.status == Status::Pending)
    }

    /// Housekeeping, then the pending entries due at `now` that are not already handed out:
    /// expire entries older than [`EXPIRY`] (one log line each) and prune old dropped records.
    pub fn due(&self, now: u64) -> Vec<Entry> {
        let expiry = u64::try_from(EXPIRY.as_millis()).unwrap_or(u64::MAX);
        let mut entries = self.lock();
        for e in entries.values_mut() {
            if e.status == Status::Pending && now.saturating_sub(e.created_ms) >= expiry {
                self.mark_dropped(e, "expired: undelivered for 48 h", now);
            }
        }
        self.prune_dropped(&mut entries, now);
        let claimed = self.lock_claimed();
        entries
            .values()
            .filter(|e| e.status == Status::Pending && e.next_ms <= now)
            .filter(|e| !claimed.contains(&e.id))
            .cloned()
            .collect()
    }

    /// Mark a due entry handed to its hook's worker (not handed out again until released).
    pub fn claim(&self, id: &str) {
        self.lock_claimed().insert(id.to_string());
    }

    /// Release a claim (the worker finished with it, or never got it).
    pub fn release(&self, id: &str) {
        self.lock_claimed().remove(id);
    }

    /// The pending entries of one hook, oldest first; and all pending, oldest first.
    fn enforce_bounds(
        &self,
        entries: &mut BTreeMap<String, Entry>,
        repo: &str,
        hook: &str,
        now: u64,
    ) {
        let oldest = |entries: &BTreeMap<String, Entry>, of_hook: bool| -> Vec<String> {
            let mut v: Vec<(u64, String)> = entries
                .values()
                .filter(|e| e.status == Status::Pending)
                .filter(|e| !of_hook || e.hook_key() == (repo, hook))
                .map(|e| (e.created_ms, e.id.clone()))
                .collect();
            v.sort();
            v.into_iter().map(|(_, id)| id).collect()
        };
        let per_hook = oldest(entries, true);
        for id in per_hook
            .iter()
            .take(per_hook.len().saturating_sub(MAX_PENDING_PER_HOOK))
        {
            if let Some(e) = entries.get_mut(id) {
                self.mark_dropped(e, "queue full for this hook (oldest dropped)", now);
            }
        }
        let all = oldest(entries, false);
        let mut count = all.len();
        let mut bytes: usize = entries
            .values()
            .filter(|e| e.status == Status::Pending)
            .map(|e| e.bytes)
            .sum();
        for id in all {
            if count <= MAX_PENDING && bytes <= MAX_PENDING_BYTES {
                break;
            }
            if let Some(e) = entries.get_mut(&id) {
                bytes = bytes.saturating_sub(e.bytes);
                count -= 1;
                self.mark_dropped(e, "queue full (oldest dropped)", now);
            }
        }
    }

    /// Delete dropped records beyond [`MAX_DROPPED`] or older than [`DROPPED_RETENTION`].
    fn prune_dropped(&self, entries: &mut BTreeMap<String, Entry>, now: u64) {
        let keep = u64::try_from(DROPPED_RETENTION.as_millis()).unwrap_or(u64::MAX);
        let mut dropped: Vec<(u64, String)> = entries
            .values()
            .filter(|e| e.status == Status::Dropped)
            .map(|e| (e.dropped_ms.unwrap_or(0), e.id.clone()))
            .collect();
        dropped.sort();
        let excess = dropped.len().saturating_sub(MAX_DROPPED);
        for (i, (t, id)) in dropped.iter().enumerate() {
            if i < excess || now.saturating_sub(*t) >= keep {
                entries.remove(id);
                self.remove_file(id);
            }
        }
    }

    /// Every entry (for tests and diagnostics).
    #[cfg(test)]
    pub fn snapshot(&self) -> Vec<Entry> {
        self.lock().values().cloned().collect()
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
        }
    }

    #[test]
    fn the_backoff_schedule() {
        let d = dir("schedule");
        let q = RetryQueue::open(&d, Vec::new()).unwrap();
        let mins: Vec<u64> = (1..=8).map(|t| q.delay_after(t).as_secs() / 60).collect();
        assert_eq!(mins, [1, 5, 30, 120, 720, 1440, 1440, 1440]);
        // Each failure pushes the next attempt out by the next delay.
        let p = serde_json::json!({ "x": 1 });
        q.fail(&failure("a", "h", &p), 0, true, None);
        assert_eq!(q.snapshot()[0].next_ms, 60_000);
        q.fail(&failure("a", "h", &p), 60_000, true, None);
        assert_eq!(q.snapshot()[0].next_ms, 60_000 + 5 * 60_000);
        assert_eq!(q.snapshot()[0].tries, 2);
        // A deferral (open circuit) does not count a try.
        q.fail(&failure("a", "h", &p), 100, false, Some(9_999));
        assert_eq!((q.snapshot()[0].tries, q.snapshot()[0].next_ms), (2, 9_999));
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    #[allow(clippy::many_single_char_names)]
    fn it_survives_a_restart_without_secrets_and_with_tight_modes() {
        let d = dir("persist");
        let p = serde_json::json!({ "ref": "refs/heads/main" });
        {
            let q = RetryQueue::open(&d, Vec::new()).unwrap();
            q.fail(&failure(ID1, "h", &p), 1000, true, None);
        }
        let q = RetryQueue::open(&d, Vec::new()).unwrap();
        let e = &q.snapshot()[0];
        assert_eq!((e.id.as_str(), e.tries, e.next_ms), (ID1, 1, 61_000));
        assert_eq!(e.payload, p);
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
        assert!(read_dir(&queue_dir(&d)).unwrap().is_empty());

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
    fn due_entries_expire_after_48h_and_claimed_ones_are_not_handed_out_twice() {
        let d = dir("expiry");
        let q = RetryQueue::open(&d, Vec::new()).unwrap();
        let p = serde_json::json!({});
        q.fail(&failure("old", "h", &p), 0, true, None);
        q.fail(&failure("new", "h", &p), 47 * H, true, None);
        let due: Vec<String> = q.due(48 * H).into_iter().map(|e| e.id).collect();
        assert_eq!(due, ["new"], "the 48 h old one expired");
        let old = q.snapshot().into_iter().find(|e| e.id == "old").unwrap();
        assert_eq!(old.status, Status::Dropped);
        assert!(old.drop_reason.unwrap().contains("expired"));
        assert_eq!(old.payload, serde_json::Value::Null, "the body is freed");
        q.claim("new");
        assert!(q.due(48 * H + 1).is_empty(), "handed out already");
        assert!(
            q.due(60 * H).is_empty(),
            "no lease expiry: only a release frees it"
        );
        q.release("new");
        // Dropped records are pruned after their retention.
        q.due(48 * H + 8 * 24 * H);
        assert!(q.snapshot().iter().all(|e| e.id != "old"));
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn bounds_drop_the_oldest() {
        let d = dir("bounds");
        let q = RetryQueue::open(&d, Vec::new()).unwrap();
        let p = serde_json::json!({});
        let ids: Vec<String> = (0..MAX_PENDING_PER_HOOK + 3)
            .map(|i| format!("e{i:04}"))
            .collect();
        for (i, id) in ids.iter().enumerate() {
            q.fail(&failure(id, "h", &p), i as u64, true, None);
        }
        let snap = q.snapshot();
        let pending: Vec<&Entry> = snap
            .iter()
            .filter(|e| e.status == Status::Pending)
            .collect();
        assert_eq!(pending.len(), MAX_PENDING_PER_HOOK);
        for old in &ids[..3] {
            let e = snap.iter().find(|e| &e.id == old).unwrap();
            assert_eq!(e.status, Status::Dropped, "{old}");
        }
        // Another hook has its own budget.
        q.fail(&failure("other", "h2", &p), 10_000, true, None);
        assert!(q.is_pending("other"));
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn a_dropped_entry_is_not_revived_and_drops_are_recorded() {
        let d = dir("drop");
        let q = RetryQueue::open(&d, Vec::new()).unwrap();
        let p = serde_json::json!({});
        q.fail(&failure(ID1, "h", &p), 0, true, None);
        q.drop_entry(ID1, "hook removed or disabled", 5);
        assert!(!q.is_pending(ID1));
        q.fail(&failure(ID1, "h", &p), 10, true, None);
        assert!(!q.is_pending(ID1), "a later failure does not revive it");
        let on_disk = read_dir(&queue_dir(&d)).unwrap();
        assert_eq!(
            on_disk[0].drop_reason.as_deref(),
            Some("hook removed or disabled")
        );
        std::fs::remove_dir_all(&d).ok();
    }
}
