//! Signed webhook delivery, decoupled from polling (PRD 05 §Deliver).
//!
//! The poll loop never waits on a receiver. It hands each event to [`Dispatcher::enqueue`],
//! which puts it on the queue of every hook that wants it and returns at once. Each hook has
//! its own worker task and a bounded in-memory queue ([`QUEUE_PER_HOOK`]); an event that does
//! not fit goes to the durable retry queue. So a hook pointed at a tar pit (anyone can write a
//! hook in their own repo and address it to a public relay) holds up only itself:
//!
//! * a delivery is bounded by [`DeliverConfig::overall_timeout`] (DNS, every attempt and
//!   backoff);
//! * after [`BREAKER_THRESHOLD`] deliveries in a row fail, the hook's **circuit opens** for a
//!   cool-down that doubles each time (from [`BREAKER_BASE`] to [`BREAKER_MAX`]); one success
//!   closes it. Meanwhile the hook's events and due retries wait in the retry queue until it
//!   closes, without a connection and without spending a try. A delivery that only waited for
//!   a busy destination ([`RelayError::DestinationBusy`]) does not count;
//! * each **attempt** takes a slot of its (address, host) pool ([`MAX_IN_FLIGHT_PER_DEST`])
//!   and of its address's pool ([`MAX_IN_FLIGHT_PER_IP`]), and releases both when it ends, so
//!   nothing is held during backoff and tenants sharing an address cannot starve each other;
//! * a hook removed or disabled by discovery is **cancelled**: its queued events are dropped,
//!   and its entries in the retry queue are dropped when they come due.
//!
//! A delivery gets up to `max_attempts` attempts within `overall_timeout` (30 s by default).
//! If they all fail it is **retried durably**: it goes to the retry queue ([`crate::queue`]),
//! which retries it on a backoff schedule across restarts, signed with the hook's current
//! secret and sent to its current URL through the SSRF guard, until it succeeds or expires
//! after 48 h. Events not yet attempted when the relay stops (waiting in a hook's in-memory
//! queue, or in flight) are lost: this is not at-least-once. A failure retrying cannot fix
//! ([`RelayError::Permanent`]: a body over the cap, a 4xx other than 408/429) is dead-lettered
//! at once and not queued. Every delivery carries a stable `X-GitHub-Delivery` id (hook id + source
//! document id), so a consumer that sees a document twice (a retry, another relay) can dedupe
//! on it. The body is signed as
//! `X-Hub-Signature-256: sha256=<hex>`, exactly as GitHub does. Logs never contain secrets,
//! bodies, or more of a URL than its scheme and host.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio::sync::{mpsc, watch, Semaphore};

use forge_core::webhooks::sign_body;

use crate::error::{RelayError, Result};
use crate::payload::WebhookEvent;
use crate::queue::{Failure, RetryQueue};
use crate::ssrf;
use crate::subscriptions::WebhookSub;

/// The largest body the relay will POST (GitHub's own cap is 25 MB; ours are small).
pub const MAX_BODY_BYTES: usize = 1024 * 1024;

/// Attempts in flight at once to one (address, host), across every hook and repo.
pub const MAX_IN_FLIGHT_PER_DEST: usize = 2;

/// Attempts in flight at once to one address, whatever host names it (a CDN or anycast
/// address serves many tenants, each bounded by [`MAX_IN_FLIGHT_PER_DEST`]).
///
/// Known limit: receivers behind one shared CDN address share these 8 slots. A tenant
/// cannot take more than its own 2, but four slow tenants on one address can keep a fifth
/// waiting; its attempts then retry within the delivery budget and, if no slot ever frees,
/// dead-letter as `DestinationBusy` without tripping its breaker.
pub const MAX_IN_FLIGHT_PER_IP: usize = 8;

/// How long an attempt waits for a slot; after that the attempt counts as failed and the next
/// one is tried (within the overall budget). A delivery whose every attempt only waited ends
/// as [`RelayError::DestinationBusy`], which does not trip the circuit breaker.
pub const SLOT_WAIT: Duration = Duration::from_secs(5);

/// Events waiting per hook; beyond this they are dropped (dead-lettered).
pub const QUEUE_PER_HOOK: usize = 256;

/// Consecutive failed deliveries that open a hook's circuit.
pub const BREAKER_THRESHOLD: u32 = 3;

/// The first cool-down of an open circuit; it doubles on every re-open, up to [`BREAKER_MAX`].
pub const BREAKER_BASE: Duration = Duration::from_secs(60);

/// The longest cool-down.
pub const BREAKER_MAX: Duration = Duration::from_secs(3600);

/// Destination pools kept at once; past this, idle pools are dropped.
const MAX_DEST_POOLS: usize = 4096;

/// A deterministic delivery id (GitHub sends a GUID in `X-GitHub-Delivery`): the same hook
/// and document always give the same id, on any relay, so consumers can dedupe.
pub fn delivery_id(hook_id: &str, source_doc_id: &str) -> String {
    let digest = <sha2::Sha256 as sha2::Digest>::digest(format!("{hook_id}:{source_doc_id}"));
    let h = hex::encode(&digest[..16]);
    format!(
        "{}-{}-{}-{}-{}",
        &h[..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..]
    )
}

/// Delivery tuning knobs.
#[derive(Debug, Clone)]
pub struct DeliverConfig {
    /// Max attempts before dead-lettering.
    pub max_attempts: u32,
    /// Base backoff; attempt `n` waits `base * 2^(n-2)`.
    pub base_backoff: Duration,
    /// Per-request timeout.
    pub timeout: Duration,
    /// Wall-clock budget for one delivery (slot wait, DNS, every attempt and backoff).
    pub overall_timeout: Duration,
    /// Timeout for the SSRF pre-flight DNS resolution.
    pub dns_timeout: Duration,
    /// Whether private/loopback targets are permitted (local testing).
    pub allow_private: bool,
}

impl Default for DeliverConfig {
    fn default() -> Self {
        Self {
            max_attempts: 5,
            base_backoff: Duration::from_millis(500),
            timeout: Duration::from_secs(10),
            overall_timeout: Duration::from_secs(30),
            dns_timeout: Duration::from_secs(5),
            allow_private: false,
        }
    }
}

/// The result of a successful delivery.
#[derive(Debug, Clone)]
pub struct DeliveryReceipt {
    /// The delivery id sent (`X-GitHub-Delivery`).
    pub delivery_id: String,
    /// HTTP status of the successful attempt.
    pub status: u16,
    /// Number of attempts made (≥1).
    pub attempts: u32,
}

/// A hook's circuit breaker: consecutive failures and, when open, until when.
#[derive(Debug, Default, Clone)]
pub struct Breaker {
    failures: u32,
    opens: u32,
    open_until: Option<Instant>,
}

impl Breaker {
    /// Whether the circuit is open at `now` (deliveries are skipped).
    pub fn is_open(&self, now: Instant) -> bool {
        self.open_until.is_some_and(|t| now < t)
    }

    /// Record a delivery outcome at `now`; returns the cool-down when this opens the circuit.
    pub fn record(&mut self, ok: bool, now: Instant) -> Option<Duration> {
        if ok {
            *self = Self::default();
            return None;
        }
        self.failures += 1;
        if self.failures < BREAKER_THRESHOLD {
            return None;
        }
        let cool = BREAKER_BASE
            .saturating_mul(1 << self.opens.min(10))
            .min(BREAKER_MAX);
        self.opens += 1;
        self.failures = 0;
        self.open_until = Some(now + cool);
        Some(cool)
    }
}

/// Signs and POSTs one delivery (the per-attempt part), with per-destination bounds and a
/// client cache.
pub struct Deliverer {
    config: DeliverConfig,
    /// Permit pools keyed by destination IP.
    dests: Mutex<HashMap<String, Arc<Semaphore>>>,
    /// HTTP clients keyed by (host, pinned addresses).
    clients: Mutex<HashMap<String, reqwest::Client>>,
}

impl Deliverer {
    /// A deliverer with `config`.
    pub fn new(config: DeliverConfig) -> Self {
        Self {
            config,
            dests: Mutex::new(HashMap::new()),
            clients: Mutex::new(HashMap::new()),
        }
    }

    /// The permit pool for `key` with `size` permits. The map is bounded: when full, pools
    /// nobody holds a permit of are dropped.
    fn pool(&self, key: &str, size: usize) -> Arc<Semaphore> {
        let mut map = self
            .dests
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if map.len() >= MAX_DEST_POOLS && !map.contains_key(key) {
            map.retain(|_, s| Arc::strong_count(s) > 1);
        }
        Arc::clone(
            map.entry(key.to_string())
                .or_insert_with(|| Arc::new(Semaphore::new(size))),
        )
    }

    /// Slots for one attempt to `target`: one of the (address, host) pool, then one of the
    /// address's larger pool. Tenants sharing an address (a CDN, anycast) each get their own
    /// small pool, so one cannot hold every slot of the address. Waits at most
    /// [`SLOT_WAIT`]; a timeout is [`RelayError::DestinationBusy`].
    async fn slots(
        &self,
        target: &ssrf::ValidatedTarget,
    ) -> Result<(
        tokio::sync::OwnedSemaphorePermit,
        tokio::sync::OwnedSemaphorePermit,
    )> {
        let ip = target.ip_key();
        let host = target.url().host_str().unwrap_or_default();
        let tenant = self.pool(&format!("{ip}|{host}"), MAX_IN_FLIGHT_PER_DEST);
        let address = self.pool(&format!("{ip}|*"), MAX_IN_FLIGHT_PER_IP);
        let busy =
            || RelayError::DestinationBusy(format!("{} busy", ssrf::redact(target.url().as_str())));
        tokio::time::timeout(SLOT_WAIT, async {
            let a = tenant.acquire_owned().await;
            let b = address.acquire_owned().await;
            a.and_then(|a| b.map(|b| (a, b)))
        })
        .await
        .map_err(|_| busy())?
        .map_err(|_| busy())
    }

    /// An HTTP client for one validated target, cached by host and pinned addresses. For a
    /// hostname it is **pinned** (`resolve_to_addrs`) to exactly the addresses
    /// [`ssrf::resolve_and_validate`] validated, so no second DNS resolution happens.
    /// Redirects are off (a 30x to an internal host would bypass the check), and so are
    /// proxies from the environment (a proxy would resolve the host itself).
    fn client_for(&self, target: &ssrf::ValidatedTarget) -> Result<reqwest::Client> {
        let key = format!("{}|{:?}", target.host(), target.pinned_addrs());
        let mut cache = self
            .clients
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(c) = cache.get(&key) {
            return Ok(c.clone());
        }
        let mut builder = reqwest::Client::builder()
            .timeout(self.config.timeout)
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy();
        if let Some(addrs) = target.pinned_addrs() {
            builder = builder.resolve_to_addrs(target.host(), addrs);
        }
        let client = builder
            .build()
            .map_err(|e| RelayError::Config(format!("building HTTP client: {e}")))?;
        if cache.len() >= MAX_DEST_POOLS {
            cache.clear();
        }
        cache.insert(key, client.clone());
        Ok(client)
    }

    /// Deliver `event` to `url`, signed with `secret`, identified by `hook_id`, within
    /// `overall_timeout`.
    pub async fn deliver(
        &self,
        url: &str,
        secret: &[u8],
        hook_id: &str,
        event: &WebhookEvent,
    ) -> Result<DeliveryReceipt> {
        match tokio::time::timeout(
            self.config.overall_timeout,
            self.deliver_inner(url, secret, hook_id, event),
        )
        .await
        {
            Ok(result) => result,
            Err(_) => Err(RelayError::DeliveryExhausted {
                attempts: self.config.max_attempts,
                reason: format!(
                    "the {:?} delivery budget ran out (receiver slow, or its address busy)",
                    self.config.overall_timeout
                ),
            }),
        }
    }

    async fn deliver_inner(
        &self,
        url: &str,
        secret: &[u8],
        hook_id: &str,
        event: &WebhookEvent,
    ) -> Result<DeliveryReceipt> {
        let body = serde_json::to_vec(&event.payload)
            .map_err(|e| RelayError::Config(format!("serializing payload: {e}")))?;
        if body.len() > MAX_BODY_BYTES {
            return Err(RelayError::Permanent(format!(
                "payload of {} bytes exceeds the {MAX_BODY_BYTES}-byte cap",
                body.len()
            )));
        }
        // A refused target stays refused until the hook's URL changes: not worth retrying.
        let target =
            ssrf::resolve_and_validate(url, self.config.allow_private, self.config.dns_timeout)
                .await
                .map_err(|e| match e {
                    RelayError::Ssrf(m) => RelayError::Permanent(format!("ssrf guard: {m}")),
                    other => other,
                })?;
        let http = self.client_for(&target)?;
        let signature = sign_body(secret, &body);
        let delivery = delivery_id(hook_id, &event.source_doc_id);
        let shown = ssrf::redact(url);

        let mut last_reason = String::new();
        let mut attempts = 0;
        // Whether any attempt reached the receiver (else every one waited on a busy slot).
        let mut sent = false;
        for attempt in 1..=self.config.max_attempts {
            attempts = attempt;
            if attempt > 1 {
                // No slot is held while backing off.
                tokio::time::sleep(self.config.base_backoff * 2u32.pow(attempt - 2)).await;
            }
            // A slot per attempt, released when the attempt ends. A slot that stays busy is
            // this attempt lost, not the delivery: try again within the overall budget.
            let _slots = match self.slots(&target).await {
                Ok(s) => s,
                Err(e) => {
                    last_reason = e.to_string();
                    tracing::warn!(url = %shown, attempt, "no delivery slot free for the destination; retrying");
                    continue;
                }
            };
            sent = true;
            match http
                .post(target.url().clone())
                .header("Content-Type", "application/json")
                .header("User-Agent", "dash-forge-relay")
                .header("X-GitHub-Event", event.event)
                .header("X-GitHub-Delivery", &delivery)
                .header("X-GitHub-Hook-ID", hook_id)
                .header("X-Hub-Signature-256", &signature)
                .body(body.clone())
                .send()
                .await
            {
                Ok(resp) => {
                    let status = resp.status();
                    if status.is_success() {
                        return Ok(DeliveryReceipt {
                            delivery_id: delivery,
                            status: status.as_u16(),
                            attempts: attempt,
                        });
                    }
                    last_reason = format!("HTTP {status}");
                    // A client error other than throttling will not recover.
                    if status.is_client_error() && status.as_u16() != 408 && status.as_u16() != 429
                    {
                        return Err(RelayError::Permanent(format!(
                            "the receiver answered {last_reason}"
                        )));
                    }
                }
                // reqwest's own message can include the full URL; keep only the kind.
                Err(e) => last_reason = describe(&e),
            }
            tracing::warn!(url = %shown, attempt, reason = %last_reason, "webhook delivery attempt failed");
        }
        if !sent {
            // Never got a slot: the destination was busy with others, not this receiver's fault.
            return Err(RelayError::DestinationBusy(last_reason));
        }
        Err(RelayError::DeliveryExhausted {
            attempts,
            reason: last_reason,
        })
    }
}

/// A reqwest error without its URL.
fn describe(e: &reqwest::Error) -> String {
    let kind = if e.is_timeout() {
        "timed out"
    } else if e.is_connect() {
        "connection failed"
    } else if e.is_body() {
        "body error"
    } else if e.is_request() {
        "request failed"
    } else {
        "transport error"
    };
    match std::error::Error::source(e) {
        Some(s) => format!("{kind}: {s}"),
        None => kind.to_string(),
    }
}

/// A delivery handed to a hook's worker: a new event, or a retry from the durable queue.
#[derive(Debug, Clone)]
struct Job {
    event: Arc<WebhookEvent>,
    /// A retry from the durable queue (claimed there; the worker releases the claim).
    retry: bool,
}

/// Where a due retry would go: its hook's channel, when the hook's circuit is open until (ms),
/// and whether the hook still wants the event.
type RetryTarget = (mpsc::Sender<Job>, u64, bool);

/// The event name as the `'static` constant the relay produces, for a retry read from disk.
fn static_event_name(name: &str) -> Option<&'static str> {
    crate::payload::ALL_EVENTS.into_iter().find(|e| *e == name)
}

/// One hook's worker: its queue and the subscription it currently delivers to (replaced when
/// discovery re-reads the hook, so a rotated secret or URL takes effect for queued events).
struct HookWorker {
    tx: mpsc::Sender<Job>,
    sub: Arc<Mutex<WebhookSub>>,
    /// Set when the hook is removed or disabled: the worker drops what is still queued.
    cancelled: Arc<std::sync::atomic::AtomicBool>,
    /// When the hook's circuit is open until (ms since the epoch; 0 = closed): retries of this
    /// hook are deferred until then rather than tried.
    open_until_ms: Arc<std::sync::atomic::AtomicU64>,
    /// The worker task (taken by [`Dispatcher::shutdown`] to wait for it).
    task: Option<tokio::task::JoinHandle<()>>,
}

impl Drop for HookWorker {
    fn drop(&mut self) {
        self.cancelled
            .store(true, std::sync::atomic::Ordering::Relaxed);
    }
}

/// The delivery front end: a worker task and bounded queue per hook.
/// Shared by the poller tasks (`&self` everywhere).
pub struct Dispatcher {
    deliverer: Arc<Deliverer>,
    hooks: Mutex<HashMap<String, HookWorker>>,
    /// Repos already warned about having no hook (the warning is logged once per repo).
    warned_no_hooks: Mutex<std::collections::HashSet<String>>,
    /// Repos served for runner wake-ups, sinks or watch mode only: no hook is expected there.
    hookless: Mutex<std::collections::HashSet<String>>,
    /// The durable retry queue (`None` in tests that do not need one).
    queue: Option<Arc<RetryQueue>>,
    /// Repos whose hooks the last discovery read authoritatively (and are served): only there
    /// does a missing hook mean "removed or disabled". A queued retry of any other repo is
    /// deferred, not dropped (a transient read error must not destroy the queue).
    authoritative: Mutex<std::collections::HashSet<String>>,
    /// Set by [`Dispatcher::shutdown`]: workers stop and write their backlog to the queue.
    stop: watch::Sender<bool>,
}

/// Milliseconds since the epoch.
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

/// Lock the warned-repos set.
fn lock_set(
    m: &Mutex<std::collections::HashSet<String>>,
) -> std::sync::MutexGuard<'_, std::collections::HashSet<String>> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

impl Dispatcher {
    /// A dispatcher over `deliverer`, with no durable queue (a failed delivery is only logged).
    #[cfg(test)]
    pub fn new(deliverer: Deliverer) -> Self {
        Self::with_queue(deliverer, None)
    }

    /// [`Self::sync`] with repo `R` (the tests' repo) read authoritatively.
    #[cfg(test)]
    fn sync_all(&self, subs: &[WebhookSub]) {
        self.sync(subs, &std::iter::once("R".to_string()).collect());
    }

    /// A dispatcher whose failed deliveries go to `queue` and are retried from it.
    pub fn with_queue(deliverer: Deliverer, queue: Option<Arc<RetryQueue>>) -> Self {
        Self {
            deliverer: Arc::new(deliverer),
            hooks: Mutex::new(HashMap::new()),
            warned_no_hooks: Mutex::new(std::collections::HashSet::new()),
            hookless: Mutex::new(std::collections::HashSet::new()),
            queue,
            authoritative: Mutex::new(std::collections::HashSet::new()),
            stop: watch::Sender::new(false),
        }
    }

    /// Whether [`Self::shutdown`] has begun.
    fn stopping(&self) -> bool {
        *self.stop.borrow()
    }

    /// Stop delivering, for a graceful exit (SIGTERM, ctrl-c): no more retries are handed
    /// out; each worker abandons its in-flight attempt and writes it, and every event still
    /// in its in-memory queue, to the durable queue (due at once, no try counted); then the
    /// queue is flushed to disk. Waits at most `grace` for the workers.
    pub async fn shutdown(&self, grace: Duration) {
        self.stop.send_replace(true);
        let tasks: Vec<tokio::task::JoinHandle<()>> = self
            .hooks
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .values_mut()
            .filter_map(|w| w.task.take())
            .collect();
        let deadline = tokio::time::Instant::now() + grace;
        for task in tasks {
            if tokio::time::timeout_at(deadline, task).await.is_err() {
                tracing::warn!("a hook worker did not stop in time; its backlog may be lost");
                break;
            }
        }
        // Events enqueued after this (a poll still finishing) go straight to the queue as
        // well; they reach disk when the queue is dropped at exit, which drains the writer.
        if let Some(q) = &self.queue {
            let q = Arc::clone(q);
            let _ = tokio::task::spawn_blocking(move || q.flush()).await;
        }
    }

    /// Hand the durable queue's due retries to their hooks' workers.
    ///
    /// * A retry whose hook is gone from a repo read authoritatively, or whose hook no longer
    ///   wants its event, is dropped with a log line and never delivered.
    /// * One whose repo was not read authoritatively (a transient discovery or setup failure,
    ///   or the first discovery not having run yet) waits; the 48 h expiry still bounds it.
    /// * One whose hook's circuit is open is deferred to when it closes.
    /// * One whose hook's in-memory queue is full stays due for a later tick (not rewritten).
    pub fn dispatch_retries(&self) {
        let Some(queue) = &self.queue else { return };
        if self.stopping() {
            return;
        }
        let now = now_ms();
        let due = queue.due(now);
        if due.is_empty() {
            return;
        }
        // Only a lookup per entry under the hooks lock (with the authoritative set `sync`
        // writes under it, so the two agree); the queue is touched after it.
        let (authoritative, targets) = {
            let hooks = self
                .hooks
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let authoritative = lock_set(&self.authoritative).clone();
            let targets: Vec<Option<RetryTarget>> = due
                .iter()
                .map(|e| {
                    hooks.get(&format!("{}:{}", e.repo_id, e.hook_id)).map(|w| {
                        let wanted = w
                            .sub
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner)
                            .wants(&e.event);
                        (
                            w.tx.clone(),
                            w.open_until_ms.load(std::sync::atomic::Ordering::Relaxed),
                            wanted,
                        )
                    })
                })
                .collect();
            (authoritative, targets)
        };
        for (e, target) in due.into_iter().zip(targets) {
            let Some((tx, open_until, wanted)) = target else {
                if authoritative.contains(&e.repo_id) {
                    queue.drop_entry(&e.id, "hook removed or disabled", now);
                }
                continue;
            };
            if open_until > now {
                queue.defer(&e.id, open_until);
                continue;
            }
            let Some(event_name) = static_event_name(&e.event).filter(|_| wanted) else {
                queue.drop_entry(&e.id, "the hook no longer subscribes to this event", now);
                continue;
            };
            if tx.capacity() == 0 {
                continue; // busy: still due next tick, nothing rewritten
            }
            let Some(raw) = queue.claim(&e.id) else {
                continue; // dropped or handed out meanwhile
            };
            let payload = match serde_json::from_str(raw.get()) {
                Ok(p) => p,
                Err(err) => {
                    queue.drop_entry(&e.id, &format!("unreadable body: {err}"), now);
                    continue;
                }
            };
            let job = Job {
                event: Arc::new(WebhookEvent {
                    event: event_name,
                    action: None,
                    payload,
                    source_doc_id: e.source_doc_id,
                }),
                retry: true,
            };
            if tx.try_send(job).is_err() {
                queue.release(&e.id);
            }
        }
    }

    /// The repos with pending entries in the durable queue.
    pub fn queued_repos(&self) -> std::collections::HashSet<String> {
        self.queue
            .as_ref()
            .map(|q| q.pending_repos())
            .unwrap_or_default()
    }

    /// The worker key of a subscription (a hook id is per repo; the same id can recur).
    fn key(sub: &WebhookSub) -> String {
        format!("{}:{}", sub.repo_id, sub.hook_id)
    }

    /// The served repos that have no hook by design (wake-ups, sinks, watch mode): their
    /// events reach no webhook, and that is not worth a warning.
    pub fn set_hookless(&self, repos: std::collections::HashSet<String>) {
        *lock_set(&self.hookless) = repos;
    }

    /// Make the running workers exactly `subs`: start new hooks, update changed ones, cancel
    /// hooks that are gone (their in-memory events are dropped).
    ///
    /// `authoritative`: the repos whose hooks were read successfully and are served. A hook of
    /// such a repo that is gone was removed or disabled: its durable-queue entries are dropped
    /// at once (so a hook re-enabled later under the same id never gets them). Hooks of other
    /// repos keep their entries until their repo is read again.
    pub fn sync(&self, subs: &[WebhookSub], authoritative: &std::collections::HashSet<String>) {
        let wanted: HashMap<String, &WebhookSub> = subs.iter().map(|s| (Self::key(s), s)).collect();
        let mut hooks = self
            .hooks
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        hooks.retain(|k, _| wanted.contains_key(k));
        lock_set(&self.authoritative).clone_from(authoritative);
        for (key, sub) in wanted {
            if let Some(w) = hooks.get(&key) {
                *w.sub
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner) = sub.clone();
                continue;
            }
            let (tx, rx) = mpsc::channel(QUEUE_PER_HOOK);
            let shared = Arc::new(Mutex::new(sub.clone()));
            let cancelled = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let open_until_ms = Arc::new(std::sync::atomic::AtomicU64::new(0));
            let task = tokio::spawn(run_hook(HookTask {
                deliverer: Arc::clone(&self.deliverer),
                queue: self.queue.clone(),
                sub: Arc::clone(&shared),
                cancelled: Arc::clone(&cancelled),
                open_until_ms: Arc::clone(&open_until_ms),
                stop: self.stop.subscribe(),
                rx,
            }));
            hooks.insert(
                key,
                HookWorker {
                    tx,
                    sub: shared,
                    cancelled,
                    open_until_ms,
                    task: Some(task),
                },
            );
        }
        drop(hooks);
        // Outside the hooks lock. A gone hook has no worker now, so nothing hands its entries
        // out meanwhile.
        if let Some(q) = &self.queue {
            let live: std::collections::HashSet<(&str, &str)> = subs
                .iter()
                .map(|s| (s.repo_id.as_str(), s.hook_id.as_str()))
                .collect();
            q.drop_where(
                |repo, hook| authoritative.contains(repo) && !live.contains(&(repo, hook)),
                "hook removed or disabled",
                now_ms(),
            );
        }
    }

    /// Queue `event` for every hook of `repo_id` that wants it. Never waits.
    pub fn enqueue(&self, repo_id: &str, event: WebhookEvent) {
        let event = Arc::new(event);
        let hooks = self
            .hooks
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut repo_has_hooks = false;
        // Hooks whose in-memory queue was full: handed to the durable queue after the lock.
        let mut overflow = Vec::new();
        let stopping = self.stopping();
        for w in hooks.values() {
            let (of_repo, wants) = {
                let sub = w
                    .sub
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                (sub.repo_id == repo_id, sub.wants(event.event))
            };
            repo_has_hooks |= of_repo;
            if !(of_repo && wants) {
                continue;
            }
            let job = Job {
                event: Arc::clone(&event),
                retry: false,
            };
            if stopping || w.tx.try_send(job).is_err() {
                overflow.push(
                    w.sub
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .clone(),
                );
            }
        }
        drop(hooks);
        for sub in overflow {
            let id = delivery_id(&sub.hook_id, &event.source_doc_id);
            let queued = self.queue.as_ref().is_some_and(|q| {
                let now = now_ms();
                q.fail(
                    &Failure {
                        id: &id,
                        ..failure_of(
                            &sub,
                            &event,
                            if stopping {
                                "the relay was stopping"
                            } else {
                                "the hook's in-memory queue was full"
                            },
                        )
                    },
                    now,
                    false,
                    Some(now),
                )
            });
            if !queued {
                tracing::error!(repo = %sub.repo_id, hook = %sub.hook_id, event = event.event, source = %event.source_doc_id, "DEAD-LETTER: the hook's queue is full; event dropped");
            }
        }
        if !repo_has_hooks
            && !lock_set(&self.hookless).contains(repo_id)
            && lock_set(&self.warned_no_hooks).insert(repo_id.to_string())
        {
            // Should not happen (a repo is served only once its hooks are synced); say so once.
            tracing::warn!(repo = %repo_id, event = event.event, source = %event.source_doc_id, "an event of a served repo found no hook; dropped (logged once per repo)");
        }
    }
}

/// What a durable-queue entry records of a failed delivery (no secret, no URL).
fn failure_of<'a>(sub: &'a WebhookSub, event: &'a WebhookEvent, error: &'a str) -> Failure<'a> {
    Failure {
        id: "",
        repo_id: &sub.repo_id,
        hook_id: &sub.hook_id,
        event: event.event,
        source_doc_id: &event.source_doc_id,
        payload: &event.payload,
        error,
        claimed: false,
    }
}

/// Everything a hook's worker task owns.
struct HookTask {
    deliverer: Arc<Deliverer>,
    queue: Option<Arc<RetryQueue>>,
    sub: Arc<Mutex<WebhookSub>>,
    cancelled: Arc<std::sync::atomic::AtomicBool>,
    open_until_ms: Arc<std::sync::atomic::AtomicU64>,
    stop: watch::Receiver<bool>,
    rx: mpsc::Receiver<Job>,
}

/// Close the worker's channel and take `first` plus everything still in it.
fn take_backlog(t: &mut HookTask, first: Option<Job>) -> Vec<Job> {
    t.rx.close();
    let mut jobs: Vec<Job> = first.into_iter().collect();
    while let Ok(j) = t.rx.try_recv() {
        jobs.push(j);
    }
    jobs
}

/// A removed or disabled hook's worker stops (`sync` already dropped its durable entries):
/// release `first` and every other claimed retry still in the channel, and deliver nothing.
fn drain_cancelled(t: &mut HookTask, first: Option<Job>, hook_id: &str) {
    let jobs = take_backlog(t, first);
    if let Some(q) = &t.queue {
        for j in jobs.iter().filter(|j| j.retry) {
            q.release(&delivery_id(hook_id, &j.event.source_doc_id));
        }
    }
}

/// The relay is stopping: write `first` (an abandoned in-flight delivery) and the rest of the
/// hook's in-memory queue to the durable queue, due at once and without counting a try, so a
/// graceful stop loses none of them. A retry from the queue is already on disk with its own
/// schedule and last error: its claim is only released.
fn persist_backlog(t: &mut HookTask, first: Option<Job>) {
    let sub = t
        .sub
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone();
    if t.cancelled.load(std::sync::atomic::Ordering::Relaxed) {
        drain_cancelled(t, first, &sub.hook_id);
        return;
    }
    let jobs = take_backlog(t, first);
    let now = now_ms();
    let mut kept = 0usize;
    for j in &jobs {
        let id = delivery_id(&sub.hook_id, &j.event.source_doc_id);
        if j.retry {
            if let Some(q) = &t.queue {
                q.release(&id);
            }
            continue;
        }
        let queued = t.queue.as_ref().is_some_and(|q| {
            q.fail(
                &Failure {
                    id: &id,
                    claimed: j.retry,
                    ..failure_of(&sub, &j.event, "the relay stopped before delivering it")
                },
                now,
                false,
                Some(now),
            )
        });
        if queued {
            kept += 1;
        } else {
            tracing::error!(repo = %sub.repo_id, hook = %sub.hook_id, event = j.event.event, source = %j.event.source_doc_id, "DEAD-LETTER: the relay stopped before delivering this event");
        }
    }
    if kept > 0 {
        tracing::info!(repo = %sub.repo_id, hook = %sub.hook_id, kept, "stopping: the hook's undelivered events are in the retry queue");
    }
}

/// Log a delivery's outcome and update the durable queue: forget a delivered one, drop a
/// permanent failure (dead-lettered, never retried), queue any other failure for a retry
/// (and say whether it really was queued).
fn record_outcome(
    t: &HookTask,
    job: &Job,
    sub: &WebhookSub,
    id: &str,
    url: &str,
    result: &Result<DeliveryReceipt>,
) {
    let event = &job.event;
    match &result {
        Ok(receipt) => {
            tracing::info!(
                repo = %sub.repo_id,
                hook = %sub.hook_id,
                url = %url,
                event = event.event,
                action = event.action.unwrap_or("-"),
                delivery_id = %receipt.delivery_id,
                status = receipt.status,
                attempts = receipt.attempts,
                retry = job.retry,
                source = %event.source_doc_id,
                "delivered webhook"
            );
            if let Some(q) = &t.queue {
                q.succeeded(id);
            }
        }
        Err(e @ RelayError::Permanent(_)) => {
            tracing::error!(repo = %sub.repo_id, hook = %sub.hook_id, url = %url, event = event.event, source = %event.source_doc_id, error = %e, "DEAD-LETTER: webhook delivery failed permanently; not retried");
            if let Some(q) = &t.queue {
                q.drop_entry(id, &e.to_string(), now_ms());
            }
        }
        Err(e) if t.cancelled.load(std::sync::atomic::Ordering::Relaxed) => {
            tracing::error!(repo = %sub.repo_id, hook = %sub.hook_id, url = %url, event = event.event, source = %event.source_doc_id, error = %e, "DEAD-LETTER: webhook delivery failed and its hook was removed or disabled meanwhile; not retried");
            if let Some(q) = &t.queue {
                q.drop_entry(id, "hook removed or disabled", now_ms());
            }
        }
        Err(e) => {
            let error = e.to_string();
            let queued = t.queue.as_ref().is_some_and(|q| {
                q.fail(
                    &Failure {
                        id,
                        claimed: job.retry,
                        ..failure_of(sub, event, &error)
                    },
                    now_ms(),
                    !matches!(e, RelayError::DestinationBusy(_)),
                    None,
                )
            });
            if queued {
                tracing::warn!(repo = %sub.repo_id, hook = %sub.hook_id, url = %url, event = event.event, source = %event.source_doc_id, error = %error, "webhook delivery failed; queued for a later retry");
            } else {
                tracing::error!(repo = %sub.repo_id, hook = %sub.hook_id, url = %url, event = event.event, source = %event.source_doc_id, error = %error, "DEAD-LETTER: webhook delivery failed");
            }
        }
    }
}

/// A hook's worker loop: deliver jobs one at a time, behind the circuit breaker. A delivery
/// that fails all its in-window attempts goes to the durable queue (or, without one, is only
/// logged); a job arriving while the circuit is open is queued for when it closes.
async fn run_hook(mut t: HookTask) {
    let mut breaker = Breaker::default();
    loop {
        let next = tokio::select! {
            biased;
            _ = t.stop.wait_for(|s| *s) => None,
            j = t.rx.recv() => Some(j),
        };
        let job = match next {
            None => {
                persist_backlog(&mut t, None);
                return;
            }
            Some(None) => return,
            Some(Some(job)) => job,
        };
        let event = &job.event;
        let sub = t
            .sub
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        let id = delivery_id(&sub.hook_id, &event.source_doc_id);
        let url = ssrf::redact(&sub.url);
        let now = now_ms();
        if t.cancelled.load(std::sync::atomic::Ordering::Relaxed) {
            drain_cancelled(&mut t, Some(job), &sub.hook_id);
            return;
        }
        if job.retry && !t.queue.as_ref().is_some_and(|q| q.is_pending(&id)) {
            if let Some(q) = &t.queue {
                q.release(&id);
            }
            continue; // dropped or delivered since it was handed out
        }
        if breaker.is_open(Instant::now()) {
            let until = t.open_until_ms.load(std::sync::atomic::Ordering::Relaxed);
            let queued = t.queue.as_ref().is_some_and(|q| {
                q.fail(
                    &Failure {
                        id: &id,
                        claimed: job.retry,
                        ..failure_of(&sub, event, "circuit open for this hook")
                    },
                    now,
                    false,
                    Some(until),
                )
            });
            if !queued {
                tracing::error!(repo = %sub.repo_id, hook = %sub.hook_id, %url, event = event.event, source = %event.source_doc_id, "DEAD-LETTER: circuit open for this hook; not delivered");
            }
            continue;
        }
        let delivered = tokio::select! {
            r = t.deliverer.deliver(&sub.url, sub.secret.expose(), &sub.hook_id, event) => Some(r),
            _ = t.stop.wait_for(|s| *s) => None,
        };
        let Some(result) = delivered else {
            // Stopping: the attempt is abandoned (the receiver may still have got it; the
            // retry carries the same delivery id) and kept for the next start.
            persist_backlog(&mut t, Some(job));
            return;
        };
        record_outcome(&t, &job, &sub, &id, &url, &result);
        // Neither a busy destination (not the receiver's failure) nor a permanent failure (a
        // body over the cap; or a 4xx, which retrying does not change) moves the breaker.
        if matches!(
            result,
            Err(RelayError::DestinationBusy(_) | RelayError::Permanent(_))
        ) {
            continue;
        }
        if let Some(cool) = breaker.record(result.is_ok(), Instant::now()) {
            let until =
                now_ms().saturating_add(u64::try_from(cool.as_millis()).unwrap_or(u64::MAX));
            t.open_until_ms
                .store(until, std::sync::atomic::Ordering::Relaxed);
            tracing::warn!(repo = %sub.repo_id, hook = %sub.hook_id, %url, cool_down_s = cool.as_secs(), "circuit opened after repeated failures; its retries wait until it closes");
        } else if result.is_ok() {
            t.open_until_ms
                .store(0, std::sync::atomic::Ordering::Relaxed);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn delivery_id_is_deterministic_and_uuid_shaped() {
        let a = delivery_id("hook1", "docA");
        assert_eq!(a, delivery_id("hook1", "docA"), "same inputs, same id");
        assert_ne!(delivery_id("hook1", "docB"), a);
        assert_ne!(delivery_id("hook2", "docA"), a);
        let parts: Vec<usize> = a.split('-').map(str::len).collect();
        assert_eq!(parts, vec![8, 4, 4, 4, 12]);
    }

    #[test]
    fn the_breaker_opens_after_repeated_failures_and_backs_off() {
        let t0 = Instant::now();
        let mut b = Breaker::default();
        assert_eq!(b.record(false, t0), None);
        assert_eq!(b.record(false, t0), None);
        assert_eq!(b.record(false, t0), Some(BREAKER_BASE));
        assert!(b.is_open(t0));
        assert!(!b.is_open(t0 + BREAKER_BASE));
        // Still failing after the cool-down: the next opening lasts twice as long.
        for _ in 0..2 {
            b.record(false, t0 + BREAKER_BASE);
        }
        assert_eq!(b.record(false, t0 + BREAKER_BASE), Some(BREAKER_BASE * 2));
        // One success closes it and resets the backoff.
        b.record(true, t0);
        assert!(!b.is_open(t0));
        for _ in 0..2 {
            b.record(false, t0);
        }
        assert_eq!(b.record(false, t0), Some(BREAKER_BASE));
        // Capped.
        let mut b = Breaker {
            opens: 30,
            ..Breaker::default()
        };
        for _ in 0..2 {
            b.record(false, t0);
        }
        assert_eq!(b.record(false, t0), Some(BREAKER_MAX));
    }

    #[tokio::test]
    async fn an_oversized_payload_is_refused_before_any_network() {
        let d = Deliverer::new(DeliverConfig::default());
        let event = WebhookEvent {
            event: "push",
            action: None,
            payload: serde_json::json!({ "x": "a".repeat(MAX_BODY_BYTES) }),
            source_doc_id: "doc".into(),
        };
        let err = d
            .deliver("https://1.1.1.1/hook", b"s", "h", &event)
            .await
            .unwrap_err();
        assert!(err.to_string().contains("cap"), "{err}");
    }

    /// The request goes to the URL the guard validated, parsed once: for a URL a hand-rolled
    /// parser would split differently, the guard and the connection agree on the host.
    #[tokio::test]
    async fn the_request_goes_to_the_url_that_was_validated() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let srv = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = srv.local_addr().unwrap().port();
        let head = Arc::new(Mutex::new(String::new()));
        let seen = Arc::clone(&head);
        tokio::spawn(async move {
            loop {
                let (mut s, _) = srv.accept().await.unwrap();
                let mut buf = vec![0u8; 65536];
                let n = s.read(&mut buf).await.unwrap_or(0);
                *seen.lock().unwrap() = String::from_utf8_lossy(&buf[..n]).into_owned();
                let reply = "HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
                let _ = s.write_all(reply.as_bytes()).await;
            }
        });
        // The WHATWG host is 127.0.0.1 (a backslash ends the authority); the `@` suffix is path.
        let url = format!("http://127.0.0.1:{port}\\@unresolvable.invalid/hook");

        let refused = Deliverer::new(DeliverConfig::default())
            .deliver(&url, b"s", "h", &push(1))
            .await
            .unwrap_err();
        assert!(refused.to_string().contains("ssrf guard"), "{refused}");
        assert!(head.lock().unwrap().is_empty(), "nothing was sent");

        let receipt = Deliverer::new(quick())
            .deliver(&url, b"s", "h", &push(1))
            .await
            .unwrap();
        assert_eq!(receipt.status, 200);
        let head = head.lock().unwrap().to_ascii_lowercase();
        assert!(
            head.starts_with("post /@unresolvable.invalid/hook http/1.1\r\n"),
            "{head}"
        );
        assert!(
            head.contains(&format!("\r\nhost: 127.0.0.1:{port}\r\n")),
            "{head}"
        );
    }

    #[tokio::test]
    async fn tenants_sharing_an_address_each_get_their_own_slots() {
        let d = Deliverer::new(DeliverConfig {
            allow_private: true,
            ..DeliverConfig::default()
        });
        let target = |url: &str| {
            ssrf::ValidatedTarget::pinned_for_test(url, vec!["192.0.2.1:443".parse().unwrap()])
        };
        let (a, b) = (target("https://a.example/h"), target("https://b.example/h"));
        // Tenant a takes all of its slots...
        let _a1 = d.slots(&a).await.unwrap();
        let _a2 = d.slots(&a).await.unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(50), d.slots(&a))
                .await
                .is_err(),
            "a third attempt for tenant a waits"
        );
        // ...and tenant b, on the same address, still gets its own.
        let b1 = d.slots(&b).await.unwrap();
        drop(b1);
        // The address cap bounds all tenants together.
        let mut held = Vec::new();
        for i in 0..3 {
            let t = target(&format!("https://t{i}.example/h"));
            held.push(d.slots(&t).await.unwrap());
            held.push(d.slots(&t).await.unwrap());
        }
        assert!(
            tokio::time::timeout(Duration::from_millis(50), d.slots(&b))
                .await
                .is_err(),
            "the address's {MAX_IN_FLIGHT_PER_IP} slots are all taken"
        );
    }

    #[tokio::test]
    async fn a_cancelled_hook_drops_its_queue() {
        // A receiver that counts requests.
        let srv = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = srv.local_addr().unwrap();
        let hits = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let h = Arc::clone(&hits);
        tokio::spawn(async move {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            loop {
                let (mut s, _) = srv.accept().await.unwrap();
                tokio::time::sleep(Duration::from_millis(200)).await;
                let mut buf = vec![0u8; 65536];
                let _ = s.read(&mut buf).await;
                h.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let _ = s
                    .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                    .await;
            }
        });
        let d = Dispatcher::new(Deliverer::new(DeliverConfig {
            allow_private: true,
            ..DeliverConfig::default()
        }));
        d.sync_all(&[sub(&format!("http://{addr}/h"), &[])]);
        for i in 0..5 {
            d.enqueue(
                "R",
                WebhookEvent {
                    event: "push",
                    action: None,
                    payload: serde_json::json!({ "i": i }),
                    source_doc_id: format!("doc{i}"),
                },
            );
        }
        // The hook disappears while the first delivery is in flight.
        tokio::time::sleep(Duration::from_millis(50)).await;
        d.sync_all(&[]);
        tokio::time::sleep(Duration::from_millis(1500)).await;
        assert!(
            hits.load(std::sync::atomic::Ordering::SeqCst) <= 1,
            "queued events of a removed hook are not delivered"
        );
    }

    /// A receiver that answers every request with `status` and counts them.
    async fn receiver(status: u16) -> (std::net::SocketAddr, Arc<std::sync::atomic::AtomicUsize>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let srv = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = srv.local_addr().unwrap();
        let hits = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let h = Arc::clone(&hits);
        tokio::spawn(async move {
            loop {
                let (mut s, _) = srv.accept().await.unwrap();
                let mut buf = vec![0u8; 65536];
                let _ = s.read(&mut buf).await;
                h.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let reply = format!(
                    "HTTP/1.1 {status} X\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                );
                let _ = s.write_all(reply.as_bytes()).await;
            }
        });
        (addr, hits)
    }

    fn quick() -> DeliverConfig {
        DeliverConfig {
            allow_private: true,
            max_attempts: 1,
            ..DeliverConfig::default()
        }
    }

    fn push(i: u32) -> WebhookEvent {
        WebhookEvent {
            event: "push",
            action: None,
            payload: serde_json::json!({ "i": i }),
            source_doc_id: format!("doc{i}"),
        }
    }

    async fn wait_until(mut f: impl FnMut() -> bool) {
        for _ in 0..100 {
            if f() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("condition not reached");
    }

    #[tokio::test]
    async fn a_failed_delivery_is_queued_then_retried_with_the_current_subscription() {
        let dir = std::env::temp_dir().join(format!("relay-dq-retry-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let q = Arc::new(RetryQueue::open(&dir, vec![Duration::from_secs(1)]).unwrap());
        let (down, down_hits) = receiver(503).await;
        let d = Dispatcher::with_queue(Deliverer::new(quick()), Some(Arc::clone(&q)));
        d.sync_all(&[sub(&format!("http://{down}/h"), &[])]);
        d.enqueue("R", push(1));
        wait_until(|| q.is_pending(&delivery_id("h", "doc1"))).await;
        assert_eq!(down_hits.load(std::sync::atomic::Ordering::SeqCst), 1);

        // The hook is re-pointed (as discovery would, after a new document): the retry goes to
        // the current URL.
        let (up, up_hits) = receiver(200).await;
        d.sync_all(&[sub(&format!("http://{up}/h"), &[])]);
        tokio::time::sleep(Duration::from_millis(1100)).await;
        d.dispatch_retries();
        wait_until(|| up_hits.load(std::sync::atomic::Ordering::SeqCst) == 1).await;
        wait_until(|| !q.is_pending(&delivery_id("h", "doc1"))).await;
        assert!(q.snapshot().is_empty(), "delivered: forgotten");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn a_graceful_stop_keeps_the_in_flight_and_queued_events() {
        use tokio::io::AsyncReadExt;
        // A receiver that reads and never answers: the first delivery stays in flight.
        let srv = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = srv.local_addr().unwrap();
        tokio::spawn(async move {
            let mut held = Vec::new();
            loop {
                let (mut s, _) = srv.accept().await.unwrap();
                let mut buf = vec![0u8; 65536];
                let _ = s.read(&mut buf).await;
                held.push(s);
            }
        });
        let q = Arc::new(RetryQueue::in_memory(Vec::new()));
        let d = Dispatcher::with_queue(
            Deliverer::new(DeliverConfig {
                allow_private: true,
                timeout: Duration::from_secs(30),
                overall_timeout: Duration::from_secs(60),
                ..DeliverConfig::default()
            }),
            Some(Arc::clone(&q)),
        );
        d.sync_all(&[sub(&format!("http://{addr}/h"), &[])]);
        for i in 0..3 {
            d.enqueue("R", push(20 + i));
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(q.snapshot().is_empty(), "nothing failed yet");
        d.shutdown(Duration::from_secs(5)).await;
        let snap = q.snapshot();
        assert_eq!(
            snap.len(),
            3,
            "the in-flight event and the two queued ones are kept"
        );
        assert!(snap.iter().all(|e| e.tries == 0), "no try counted");
        // After the stop, new events go straight to the queue.
        d.enqueue("R", push(30));
        assert!(q.is_pending(&delivery_id("h", "doc30")));
    }

    #[tokio::test]
    async fn a_permanent_failure_is_dead_lettered_not_queued() {
        let q = Arc::new(RetryQueue::in_memory(vec![Duration::from_secs(1)]));
        let (gone, gone_hits) = receiver(404).await;
        let d = Dispatcher::with_queue(
            Deliverer::new(DeliverConfig {
                max_attempts: 3,
                ..quick()
            }),
            Some(Arc::clone(&q)),
        );
        d.sync_all(&[sub(&format!("http://{gone}/h"), &[])]);
        d.enqueue("R", push(4));
        wait_until(|| gone_hits.load(std::sync::atomic::Ordering::SeqCst) == 1).await;
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(
            gone_hits.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "a 404 is not retried in the window"
        );
        assert!(q.snapshot().is_empty(), "nor queued");

        // A queued retry whose receiver now answers 4xx is dropped, not retried for 48 h.
        let (down, _) = receiver(503).await;
        d.sync_all(&[sub(&format!("http://{down}/h"), &[])]);
        d.enqueue("R", push(5));
        let id = delivery_id("h", "doc5");
        wait_until(|| q.is_pending(&id)).await;
        d.sync_all(&[sub(&format!("http://{gone}/h"), &[])]);
        tokio::time::sleep(Duration::from_millis(1100)).await;
        d.dispatch_retries();
        wait_until(|| !q.is_pending(&id)).await;
        let e = q.snapshot().into_iter().find(|e| e.id == id).unwrap();
        assert!(
            e.drop_reason.as_deref().unwrap().contains("404"),
            "{:?}",
            e.drop_reason
        );
        // And an over-cap body is permanent too.
        let err = Deliverer::new(DeliverConfig::default())
            .deliver(
                "https://1.1.1.1/hook",
                b"s",
                "h",
                &WebhookEvent {
                    event: "push",
                    action: None,
                    payload: serde_json::json!({ "x": "a".repeat(MAX_BODY_BYTES) }),
                    source_doc_id: "doc".into(),
                },
            )
            .await
            .unwrap_err();
        assert!(matches!(err, RelayError::Permanent(_)), "{err}");
    }

    #[tokio::test]
    async fn a_retry_for_a_removed_hook_is_dropped_never_delivered() {
        let dir = std::env::temp_dir().join(format!("relay-dq-removed-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let q = Arc::new(RetryQueue::open(&dir, vec![Duration::from_secs(1)]).unwrap());
        let (addr, hits) = receiver(503).await;
        let d = Dispatcher::with_queue(Deliverer::new(quick()), Some(Arc::clone(&q)));
        d.sync_all(&[sub(&format!("http://{addr}/h"), &[])]);
        d.enqueue("R", push(2));
        let id = delivery_id("h", "doc2");
        wait_until(|| q.is_pending(&id)).await;
        d.sync_all(&[]); // removed or disabled
        tokio::time::sleep(Duration::from_millis(1100)).await;
        d.dispatch_retries();
        let e = q.snapshot().into_iter().find(|e| e.id == id).unwrap();
        assert_eq!(e.status, crate::queue::Status::Dropped);
        assert_eq!(e.drop_reason.as_deref(), Some("hook removed or disabled"));
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(
            hits.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "not retried"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn a_repo_not_read_authoritatively_keeps_its_retries() {
        let dir = std::env::temp_dir().join(format!("relay-dq-transient-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let q = Arc::new(RetryQueue::open(&dir, vec![Duration::from_secs(1)]).unwrap());
        let (addr, _hits) = receiver(503).await;
        let d = Dispatcher::with_queue(Deliverer::new(quick()), Some(Arc::clone(&q)));
        d.sync_all(&[sub(&format!("http://{addr}/h"), &[])]);
        d.enqueue("R", push(3));
        let id = delivery_id("h", "doc3");
        wait_until(|| q.is_pending(&id)).await;
        // A discovery pass that could not read repo R (or set it up): its hook is absent, but
        // R is not authoritative, so the entry waits instead of being dropped.
        d.sync(&[], &std::collections::HashSet::new());
        tokio::time::sleep(Duration::from_millis(1100)).await;
        d.dispatch_retries();
        assert!(q.is_pending(&id));
        // The next pass reads R and the hook is really gone: dropped at once.
        d.sync_all(&[]);
        assert!(!q.is_pending(&id));
        // Re-enabled later under the same id: the dropped entry never reaches it.
        d.sync_all(&[sub(&format!("http://{addr}/h"), &[])]);
        tokio::time::sleep(Duration::from_millis(1100)).await;
        d.dispatch_retries();
        assert!(!q.is_pending(&id));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn an_open_circuit_defers_retries_instead_of_spending_them() {
        let dir = std::env::temp_dir().join(format!("relay-dq-open-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let q = Arc::new(RetryQueue::open(&dir, vec![Duration::from_secs(1)]).unwrap());
        let (addr, hits) = receiver(503).await;
        let d = Dispatcher::with_queue(Deliverer::new(quick()), Some(Arc::clone(&q)));
        d.sync_all(&[sub(&format!("http://{addr}/h"), &[])]);
        for i in 0..4 {
            d.enqueue("R", push(10 + i));
        }
        // Three failures open the circuit; the fourth is queued for when it closes.
        wait_until(|| q.snapshot().len() == 4).await;
        assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 3);
        let fourth = q
            .snapshot()
            .into_iter()
            .find(|e| e.source_doc_id == "doc13")
            .unwrap();
        assert_eq!(fourth.tries, 0, "not counted as a try");
        assert!(
            fourth.next_ms >= now_ms() + 50_000,
            "due when the circuit closes"
        );
        // Due retries of this hook are deferred, not sent, while the circuit is open.
        tokio::time::sleep(Duration::from_millis(1100)).await;
        d.dispatch_retries();
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 3);
        std::fs::remove_dir_all(&dir).ok();
    }

    fn sub(url: &str, events: &[&str]) -> WebhookSub {
        WebhookSub {
            repo_id: "R".into(),
            hook_id: "h".into(),
            url: url.into(),
            events: events.iter().map(ToString::to_string).collect(),
            secret: forge_core::envelope::SecretBytes::new(vec![b'k'; 32]),
            created_at: 0,
            document_id: None,
        }
    }

    /// A hook whose receiver never answers must not hold up enqueueing, nor another hook.
    #[tokio::test]
    async fn a_tar_pit_hook_does_not_block_the_caller_or_other_hooks() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        // Tar pit: accepts and never replies.
        let pit = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let pit_addr = pit.local_addr().unwrap();
        tokio::spawn(async move {
            let mut held = Vec::new();
            loop {
                if let Ok((s, _)) = pit.accept().await {
                    held.push(s);
                }
            }
        });
        // A good receiver: answers 200 and reports each request.
        let good = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let good_addr = good.local_addr().unwrap();
        let (seen_tx, mut seen_rx) = mpsc::channel(8);
        tokio::spawn(async move {
            loop {
                let (mut s, _) = good.accept().await.unwrap();
                let mut buf = vec![0u8; 65536];
                let _ = s.read(&mut buf).await;
                let _ = s
                    .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                    .await;
                let _ = seen_tx.send(()).await;
            }
        });

        let d = Dispatcher::new(Deliverer::new(DeliverConfig {
            allow_private: true,
            timeout: Duration::from_secs(30),
            overall_timeout: Duration::from_secs(60),
            ..DeliverConfig::default()
        }));
        let mut bad = sub(&format!("http://{pit_addr}/h"), &[]);
        bad.hook_id = "pit".into();
        let mut ok = sub(&format!("http://{good_addr}/h"), &["push"]);
        ok.hook_id = "good".into();
        d.sync_all(&[bad, ok]);

        let start = Instant::now();
        for i in 0..3 {
            d.enqueue(
                "R",
                WebhookEvent {
                    event: "push",
                    action: None,
                    payload: serde_json::json!({ "i": i }),
                    source_doc_id: format!("doc{i}"),
                },
            );
        }
        assert!(
            start.elapsed() < Duration::from_millis(100),
            "enqueue must not wait"
        );
        for _ in 0..3 {
            tokio::time::timeout(Duration::from_secs(10), seen_rx.recv())
                .await
                .expect("the good hook is delivered while the tar pit hangs");
        }
    }
}
