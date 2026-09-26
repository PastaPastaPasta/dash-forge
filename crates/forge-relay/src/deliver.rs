//! Signed webhook delivery, decoupled from polling (PRD 05 §Deliver).
//!
//! The poll loop never waits on a receiver. It hands each event to [`Dispatcher::enqueue`],
//! which puts it on the queue of every hook that wants it and returns at once. Each hook has
//! its own worker task and a bounded queue ([`QUEUE_PER_HOOK`]); a full queue drops the event
//! with a `DEAD-LETTER` log line. So a hook pointed at a tar pit (anyone can write a hook in
//! their own repo and address it to a public relay) holds up only itself:
//!
//! * a delivery is bounded by [`DeliverConfig::overall_timeout`] (DNS, a per-destination slot,
//!   every attempt and backoff);
//! * after [`BREAKER_THRESHOLD`] deliveries in a row fail, the hook's **circuit opens**: its
//!   queued and new events are dead-lettered without a connection for a cool-down that doubles
//!   each time (from [`BREAKER_BASE`] to [`BREAKER_MAX`]); one success closes it;
//! * at most [`MAX_IN_FLIGHT_PER_DEST`] deliveries go to one destination address at a time,
//!   across all hooks (a bounded map of pools keyed by the pinned IP, so many hostnames aimed
//!   at one server share its pool).
//!
//! Delivery is **best effort with retries inside one window**: up to `max_attempts` attempts
//! within `overall_timeout` (30 s by default), then a `DEAD-LETTER` log line. Nothing is kept
//! on disk and nothing is retried later; a restart loses what was queued. Every delivery
//! carries a stable `X-GitHub-Delivery` id (hook id + source document id), so a consumer that
//! sees a document twice (a retry, another relay) can dedupe on it. The body is signed as
//! `X-Hub-Signature-256: sha256=<hex>`, exactly as GitHub does. Logs never contain secrets,
//! bodies, or more of a URL than its scheme and host.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio::sync::{mpsc, Semaphore};

use forge_core::webhooks::sign_body;

use crate::error::{RelayError, Result};
use crate::payload::WebhookEvent;
use crate::ssrf;
use crate::subscriptions::WebhookSub;

/// The largest body the relay will POST (GitHub's own cap is 25 MB; ours are small).
pub const MAX_BODY_BYTES: usize = 1024 * 1024;

/// Deliveries in flight at once to one destination address, across every hook and repo.
pub const MAX_IN_FLIGHT_PER_DEST: usize = 2;

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

    /// The permit pool for destination `key`. The map is bounded: when full, pools nobody
    /// holds a permit of are dropped.
    fn dest_permits(&self, key: &str) -> Arc<Semaphore> {
        let mut map = self
            .dests
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if map.len() >= MAX_DEST_POOLS && !map.contains_key(key) {
            map.retain(|_, s| Arc::strong_count(s) > 1);
        }
        Arc::clone(
            map.entry(key.to_string())
                .or_insert_with(|| Arc::new(Semaphore::new(MAX_IN_FLIGHT_PER_DEST))),
        )
    }

    /// An HTTP client for one validated target, cached by host and pinned addresses. For a
    /// hostname it is **pinned** (`resolve_to_addrs`) to exactly the addresses
    /// [`ssrf::resolve_and_validate`] validated, so no second DNS resolution happens.
    /// Redirects are off (a 30x to an internal host would bypass the check), and so are
    /// proxies from the environment (a proxy would resolve the host itself).
    fn client_for(&self, target: &ssrf::ValidatedTarget) -> Result<reqwest::Client> {
        let key = format!("{}|{:?}", target.host, target.pinned_addrs);
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
        if let Some(addrs) = &target.pinned_addrs {
            builder = builder.resolve_to_addrs(&target.host, addrs);
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
            return Err(RelayError::DeliveryExhausted {
                attempts: 0,
                reason: format!(
                    "payload of {} bytes exceeds the {MAX_BODY_BYTES}-byte cap",
                    body.len()
                ),
            });
        }
        let target =
            ssrf::resolve_and_validate(url, self.config.allow_private, self.config.dns_timeout)
                .await?;
        let http = self.client_for(&target)?;
        let permits = self.dest_permits(&target.ip_key());
        let _permit = permits
            .acquire_owned()
            .await
            .map_err(|_| RelayError::Config("destination pool closed".into()))?;

        let signature = sign_body(secret, &body);
        let delivery = delivery_id(hook_id, &event.source_doc_id);
        let shown = ssrf::redact(url);

        let mut last_reason = String::new();
        let mut attempts = 0;
        for attempt in 1..=self.config.max_attempts {
            attempts = attempt;
            if attempt > 1 {
                tokio::time::sleep(self.config.base_backoff * 2u32.pow(attempt - 2)).await;
            }
            match http
                .post(target.url.clone())
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
                        break;
                    }
                }
                // reqwest's own message can include the full URL; keep only the kind.
                Err(e) => last_reason = describe(&e),
            }
            tracing::warn!(url = %shown, attempt, reason = %last_reason, "webhook delivery attempt failed");
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

/// One hook's worker: its queue and the subscription it currently delivers to (replaced when
/// discovery re-reads the hook, so a rotated secret or URL takes effect for queued events).
struct HookWorker {
    tx: mpsc::Sender<Arc<WebhookEvent>>,
    sub: Arc<Mutex<WebhookSub>>,
}

/// The delivery front end: a worker task and bounded queue per hook.
pub struct Dispatcher {
    deliverer: Arc<Deliverer>,
    hooks: HashMap<String, HookWorker>,
}

impl Dispatcher {
    /// A dispatcher over `deliverer`.
    pub fn new(deliverer: Deliverer) -> Self {
        Self {
            deliverer: Arc::new(deliverer),
            hooks: HashMap::new(),
        }
    }

    /// The worker key of a subscription (a hook id is per repo; the same id can recur).
    fn key(sub: &WebhookSub) -> String {
        format!("{}:{}", sub.repo_id, sub.hook_id)
    }

    /// Make the running workers exactly `subs`: start new hooks, update changed ones, stop
    /// (drop the queue of) hooks that are gone.
    pub fn sync(&mut self, subs: &[WebhookSub]) {
        let wanted: HashMap<String, &WebhookSub> = subs.iter().map(|s| (Self::key(s), s)).collect();
        self.hooks.retain(|k, _| wanted.contains_key(k));
        for (key, sub) in wanted {
            if let Some(w) = self.hooks.get(&key) {
                *w.sub
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner) = sub.clone();
                continue;
            }
            let (tx, rx) = mpsc::channel(QUEUE_PER_HOOK);
            let shared = Arc::new(Mutex::new(sub.clone()));
            tokio::spawn(run_hook(
                Arc::clone(&self.deliverer),
                Arc::clone(&shared),
                rx,
            ));
            self.hooks.insert(key, HookWorker { tx, sub: shared });
        }
    }

    /// Queue `event` for every hook of `repo_id` that wants it. Never waits.
    pub fn enqueue(&self, repo_id: &str, event: WebhookEvent) {
        let event = Arc::new(event);
        for (key, w) in &self.hooks {
            let wants = {
                let sub = w
                    .sub
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                sub.repo_id == repo_id && sub.wants(event.event)
            };
            if !wants {
                continue;
            }
            if w.tx.try_send(Arc::clone(&event)).is_err() {
                tracing::error!(hook = %key, event = event.event, source = %event.source_doc_id, "DEAD-LETTER: the hook's queue is full; event dropped");
            }
        }
    }
}

/// A hook's worker loop: deliver queued events one at a time, behind the circuit breaker.
async fn run_hook(
    deliverer: Arc<Deliverer>,
    sub: Arc<Mutex<WebhookSub>>,
    mut rx: mpsc::Receiver<Arc<WebhookEvent>>,
) {
    let mut breaker = Breaker::default();
    while let Some(event) = rx.recv().await {
        let sub = sub
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        let url = ssrf::redact(&sub.url);
        if breaker.is_open(Instant::now()) {
            tracing::error!(repo = %sub.repo_id, hook = %sub.hook_id, %url, event = event.event, source = %event.source_doc_id, "DEAD-LETTER: circuit open for this hook; not delivered");
            continue;
        }
        let result = deliverer
            .deliver(&sub.url, sub.secret.expose(), &sub.hook_id, &event)
            .await;
        match &result {
            Ok(receipt) => tracing::info!(
                repo = %sub.repo_id,
                hook = %sub.hook_id,
                %url,
                event = event.event,
                action = event.action.unwrap_or("-"),
                delivery_id = %receipt.delivery_id,
                status = receipt.status,
                attempts = receipt.attempts,
                source = %event.source_doc_id,
                "delivered webhook"
            ),
            Err(e) => tracing::error!(
                repo = %sub.repo_id,
                hook = %sub.hook_id,
                %url,
                event = event.event,
                source = %event.source_doc_id,
                error = %e,
                "DEAD-LETTER: webhook delivery failed"
            ),
        }
        if let Some(cool) = breaker.record(result.is_ok(), Instant::now()) {
            tracing::warn!(repo = %sub.repo_id, hook = %sub.hook_id, %url, cool_down_s = cool.as_secs(), "circuit opened after repeated failures");
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

    #[tokio::test]
    async fn destination_pools_are_shared_and_bounded() {
        let d = Deliverer::new(DeliverConfig::default());
        let a = d.dest_permits("192.0.2.1");
        assert!(Arc::ptr_eq(&a, &d.dest_permits("192.0.2.1")));
        let _p1 = Arc::clone(&a).acquire_owned().await.unwrap();
        let _p2 = Arc::clone(&a).acquire_owned().await.unwrap();
        assert!(a.clone().try_acquire_owned().is_err());
        assert!(d.dest_permits("192.0.2.2").try_acquire_owned().is_ok());
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

        let mut d = Dispatcher::new(Deliverer::new(DeliverConfig {
            allow_private: true,
            timeout: Duration::from_secs(30),
            overall_timeout: Duration::from_secs(60),
            ..DeliverConfig::default()
        }));
        let mut bad = sub(&format!("http://{pit_addr}/h"), &[]);
        bad.hook_id = "pit".into();
        let mut ok = sub(&format!("http://{good_addr}/h"), &["push"]);
        ok.hook_id = "good".into();
        d.sync(&[bad, ok]);

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
