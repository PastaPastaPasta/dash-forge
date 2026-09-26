//! Signed webhook delivery: HMAC-SHA256 signatures, exponential-backoff retry, bounded
//! concurrency per destination host, and a dead-letter log (PRD 05 §Deliver).
//!
//! Delivery is **at-least-once**: a retried POST may duplicate, so every delivery carries a
//! stable `X-GitHub-Delivery` id (derived from the hook id + source document id, so a re-poll
//! of the same document, on this relay or another, produces the *same* id) and consumers
//! dedupe on it. The body is signed with the webhook secret and sent as
//! `X-Hub-Signature-256: sha256=<hex>` exactly as GitHub does, so existing verification code
//! works unchanged. Secrets and payload bodies are never logged; URLs are logged without their
//! query string.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use hmac::{Hmac, Mac};
use sha2::Sha256;
use tokio::sync::Semaphore;

use crate::error::{RelayError, Result};
use crate::payload::WebhookEvent;
use crate::ssrf;

type HmacSha256 = Hmac<Sha256>;

/// The largest body the relay will POST. Payloads are small (a document's fields plus the
/// repository object); a bigger one means something is wrong, and it is refused rather than
/// sent. (GitHub's own cap is 25 MB.)
pub const MAX_BODY_BYTES: usize = 1024 * 1024;

/// Deliveries in flight at once to one host, across every hook and repo: one slow receiver
/// cannot take every connection, and hooks pointed at someone else's server cannot turn the
/// relay into a flood.
pub const MAX_IN_FLIGHT_PER_HOST: usize = 2;

/// Compute the GitHub-style `X-Hub-Signature-256` header value (`sha256=<hex>`) for
/// `body` under `secret`.
pub fn sign_body(secret: &[u8], body: &[u8]) -> String {
    let mut mac = HmacSha256::new_from_slice(secret).expect("HMAC accepts any key length");
    mac.update(body);
    let digest = mac.finalize().into_bytes();
    format!("sha256={}", hex::encode(digest))
}

/// Constant-time verify a `sha256=<hex>` signature over `body` under `secret` — the
/// primitive a consumer (e.g. the reference CI runner) uses to authenticate a delivery.
/// Exercised by the unit tests and mirrored in `examples/ci_consumer.rs` (a binary crate
/// cannot import its own modules into an example, so the logic is duplicated there).
#[allow(dead_code)]
pub fn verify_signature(secret: &[u8], body: &[u8], signature_header: &str) -> bool {
    let Some(hex_sig) = signature_header.strip_prefix("sha256=") else {
        return false;
    };
    let Ok(expected) = hex::decode(hex_sig) else {
        return false;
    };
    let mut mac = HmacSha256::new_from_slice(secret).expect("HMAC accepts any key length");
    mac.update(body);
    // `verify_slice` is constant-time.
    mac.verify_slice(&expected).is_ok()
}

/// A deterministic delivery id (GitHub sends a GUID in `X-GitHub-Delivery`). Derived from
/// the hook id + source document id so the *same* on-chain document always maps to the
/// same delivery id — that is what makes at-least-once + consumer-side dedupe correct
/// across relay restarts and interchangeable relay instances.
pub fn delivery_id(hook_id: &str, source_doc_id: &str) -> String {
    let digest = <Sha256 as sha2::Digest>::digest(format!("{hook_id}:{source_doc_id}").as_bytes());
    let h = hex::encode(&digest[..16]);
    // UUID-shaped (8-4-4-4-12), not a real UUIDv4: the shape tooling expects.
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
    /// Base backoff; attempt `n` waits `base * 2^(n-1)`.
    pub base_backoff: Duration,
    /// Per-request timeout.
    pub timeout: Duration,
    /// Overall wall-clock budget for one delivery (waiting for a per-host slot, DNS, every
    /// retry and backoff). A hung or tar-pitting target cannot stall the poll cycle past it.
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

/// The result of a delivery attempt sequence.
#[derive(Debug, Clone)]
pub struct DeliveryReceipt {
    /// The delivery id sent (`X-GitHub-Delivery`).
    pub delivery_id: String,
    /// HTTP status of the successful attempt.
    pub status: u16,
    /// Number of attempts made (≥1).
    pub attempts: u32,
}

/// A webhook deliverer.
pub struct Deliverer {
    config: DeliverConfig,
    /// One permit pool per destination host ([`MAX_IN_FLIGHT_PER_HOST`]).
    per_host: Mutex<HashMap<String, Arc<Semaphore>>>,
}

impl Deliverer {
    /// Build a deliverer with the given config. Clients are built per-delivery (pinned to
    /// the SSRF-validated addresses), so construction itself is infallible.
    pub fn new(config: DeliverConfig) -> Self {
        Self {
            config,
            per_host: Mutex::new(HashMap::new()),
        }
    }

    /// The permit pool for `host`.
    fn host_permits(&self, host: &str) -> Arc<Semaphore> {
        let mut map = self
            .per_host
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        Arc::clone(
            map.entry(host.to_string())
                .or_insert_with(|| Arc::new(Semaphore::new(MAX_IN_FLIGHT_PER_HOST))),
        )
    }

    /// Build an HTTP client for one validated target. For a hostname target the client is
    /// **pinned** (`resolve_to_addrs`) to the exact addresses [`ssrf::resolve_and_validate`]
    /// validated, so reqwest performs no second DNS resolution — closing the rebinding
    /// TOCTOU. Redirects are disabled (a 30x to an internal host would bypass the check), and
    /// so are proxies from the environment (a proxy would resolve the host itself).
    fn client_for(&self, target: &ssrf::ValidatedTarget) -> Result<reqwest::Client> {
        let mut builder = reqwest::Client::builder()
            .timeout(self.config.timeout)
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy();
        if let Some(addrs) = &target.pinned_addrs {
            builder = builder.resolve_to_addrs(&target.host, addrs);
        }
        builder
            .build()
            .map_err(|e| RelayError::Config(format!("building HTTP client: {e}")))
    }

    /// Deliver `event` to `url`, signed with `secret`, identified by `hook_id`.
    ///
    /// Resolves + validates the target once and pins the connection to the validated IPs
    /// (SSRF + rebinding defense), waits for a slot of the host's pool, signs the body, and
    /// retries with exponential backoff up to `max_attempts` — the whole sequence bounded by
    /// `overall_timeout`. A run that never gets a 2xx returns
    /// [`RelayError::DeliveryExhausted`] (the caller dead-letters it).
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
                    "overall delivery budget of {:?} exceeded (target hung or tar-pitting, or \
                     its host kept {MAX_IN_FLIGHT_PER_HOST} deliveries busy)",
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
        let permits = self.host_permits(target.url.host_str().unwrap_or_default());
        let _permit = permits
            .acquire_owned()
            .await
            .map_err(|_| RelayError::Config("per-host delivery pool closed".into()))?;

        let signature = sign_body(secret, &body);
        let delivery = delivery_id(hook_id, &event.source_doc_id);
        let shown = ssrf::redact(url);

        let mut last_reason = String::new();
        for attempt in 1..=self.config.max_attempts {
            if attempt > 1 {
                let backoff = self.config.base_backoff * 2u32.pow(attempt - 2);
                tokio::time::sleep(backoff).await;
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
                    // A client error other than throttling will not recover; stop early.
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
            attempts: self.config.max_attempts,
            reason: last_reason,
        })
    }
}

/// A reqwest error without its URL (which may carry a token in its query).
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hmac_known_answer_and_roundtrip() {
        // Known-answer: HMAC-SHA256("It's a Secret to Everybody", "Hello, World!") is the
        // value GitHub's own docs publish for X-Hub-Signature-256.
        let sig = sign_body(b"It's a Secret to Everybody", b"Hello, World!");
        assert_eq!(
            sig,
            "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17"
        );
        assert!(verify_signature(
            b"It's a Secret to Everybody",
            b"Hello, World!",
            &sig
        ));
    }

    #[test]
    fn verify_rejects_tampered_body_and_wrong_secret() {
        let secret = b"topsecret";
        let body = br#"{"ref":"refs/heads/main"}"#;
        let sig = sign_body(secret, body);
        assert!(verify_signature(secret, body, &sig));
        assert!(!verify_signature(
            secret,
            br#"{"ref":"refs/heads/evil"}"#,
            &sig
        ));
        assert!(!verify_signature(b"guessed", body, &sig));
        assert!(!verify_signature(secret, body, "not-a-signature"));
        assert!(!verify_signature(secret, body, "sha256=zzzz"));
    }

    #[test]
    fn delivery_id_is_deterministic_and_uuid_shaped() {
        let a = delivery_id("hook1", "docA");
        assert_eq!(a, delivery_id("hook1", "docA"), "same inputs, same id");
        assert_ne!(delivery_id("hook1", "docB"), a);
        assert_ne!(delivery_id("hook2", "docA"), a);
        let parts: Vec<usize> = a.split('-').map(str::len).collect();
        assert_eq!(parts, vec![8, 4, 4, 4, 12]);
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
    async fn a_host_pool_is_shared_and_bounded() {
        let d = Deliverer::new(DeliverConfig::default());
        let a = d.host_permits("ci.example");
        let b = d.host_permits("ci.example");
        assert!(Arc::ptr_eq(&a, &b));
        let _p1 = Arc::clone(&a).acquire_owned().await.unwrap();
        let _p2 = Arc::clone(&a).acquire_owned().await.unwrap();
        assert!(a.clone().try_acquire_owned().is_err());
        assert!(d.host_permits("other.example").try_acquire_owned().is_ok());
    }
}
