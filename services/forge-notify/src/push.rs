//! Web Push (RFC 8030) with message encryption (RFC 8291, `aes128gcm`) and VAPID (RFC 8292).
//!
//! A browser subscribes with the service's VAPID public key (`/v1/info`) and gives back an
//! endpoint URL and two keys. The endpoint is a URL the client chose, so it is accepted only on
//! a known push service's host ([`crate::config::DEFAULT_PUSH_HOSTS`], or the operator's list),
//! over https: a subscription cannot make this service POST to an arbitrary server.
//!
//! The payload is end-to-end encrypted to the browser: the push service sees only its size.

use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use web_push_native::jwt_simple::algorithms::ES256KeyPair;
use web_push_native::p256::elliptic_curve::sec1::ToEncodedPoint as _;
use web_push_native::{Auth, WebPushBuilder};

use crate::error::{NotifyError, Result};

/// What a browser's `PushSubscription` gives.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PushTarget {
    /// The push service URL for this browser.
    pub endpoint: String,
    /// The browser's P-256 public key, base64url (65 bytes uncompressed).
    pub p256dh: String,
    /// The browser's auth secret, base64url (16 bytes).
    pub auth: String,
}

/// What a notification push carries (the service worker shows it).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PushMessage {
    /// The title line.
    pub title: String,
    /// The body.
    pub body: String,
    /// The page to open on click.
    pub url: String,
    /// Replaces an earlier notification with the same tag (one per thread).
    pub tag: String,
}

/// How a push went.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PushOutcome {
    /// Accepted by the push service.
    Sent,
    /// The subscription is gone (404 or 410): forget it.
    Gone,
    /// Failed; may work later.
    Failed(String),
}

/// A boxed push future.
pub type PushFuture<'a> = Pin<Box<dyn Future<Output = PushOutcome> + Send + 'a>>;

/// Sends pushes.
pub trait Pusher: Send + Sync {
    /// Send `message` to `target`.
    fn push<'a>(&'a self, target: &'a PushTarget, message: &'a PushMessage) -> PushFuture<'a>;
    /// The VAPID public key browsers subscribe with (base64url, uncompressed point).
    fn public_key(&self) -> String;
}

/// Check a subscription: an https endpoint on an allowed host (or, in local mode, http to a
/// loopback host), and keys of the right sizes.
pub fn check_target(t: &PushTarget, hosts: &[String], insecure_local: bool) -> Result<()> {
    if t.endpoint.len() > 1024 {
        return Err(NotifyError::BadRequest(
            "the push endpoint is too long".into(),
        ));
    }
    let u = url::Url::parse(&t.endpoint)
        .map_err(|_| NotifyError::BadRequest("the push endpoint is not a URL".into()))?;
    let host = u.host_str().unwrap_or_default().to_ascii_lowercase();
    let local = insecure_local && forge_relay::sinks::is_loopback_host(&host);
    let allowed = hosts
        .iter()
        .any(|h| host == *h || host.ends_with(&format!(".{h}")));
    if !(local || (u.scheme() == "https" && allowed && u.port().is_none())) {
        return Err(NotifyError::BadRequest(
            "the push endpoint is not on a known push service".into(),
        ));
    }
    if !u.username().is_empty() || u.password().is_some() {
        return Err(NotifyError::BadRequest(
            "the push endpoint has a user".into(),
        ));
    }
    let key = URL_SAFE_NO_PAD
        .decode(t.p256dh.trim_end_matches('='))
        .map_err(|_| NotifyError::BadRequest("p256dh is not base64url".into()))?;
    web_push_native::p256::PublicKey::from_sec1_bytes(&key)
        .map_err(|_| NotifyError::BadRequest("p256dh is not a P-256 public key".into()))?;
    let auth = URL_SAFE_NO_PAD
        .decode(t.auth.trim_end_matches('='))
        .map_err(|_| NotifyError::BadRequest("auth is not base64url".into()))?;
    if auth.len() != 16 {
        return Err(NotifyError::BadRequest("auth must be 16 bytes".into()));
    }
    Ok(())
}

/// Web Push over HTTPS with a VAPID key.
pub struct WebPusher {
    key: ES256KeyPair,
    public: String,
    subject: String,
    http: reqwest::Client,
}

impl WebPusher {
    /// A pusher for a base64url P-256 private key (32 bytes) and a `mailto:`/`https:` subject.
    pub fn new(private_b64url: &str, subject: &str) -> Result<Self> {
        let raw = zeroize::Zeroizing::new(
            URL_SAFE_NO_PAD
                .decode(private_b64url.trim().trim_end_matches('='))
                .map_err(|_| {
                    NotifyError::Config("FORGE_NOTIFY_VAPID_PRIVATE_KEY is not base64url".into())
                })?,
        );
        let secret = web_push_native::p256::SecretKey::from_slice(&raw).map_err(|_| {
            NotifyError::Config("FORGE_NOTIFY_VAPID_PRIVATE_KEY is not a P-256 key".into())
        })?;
        let public = URL_SAFE_NO_PAD.encode(secret.public_key().to_encoded_point(false).as_bytes());
        let key = ES256KeyPair::from_bytes(&raw).map_err(|_| {
            NotifyError::Config("FORGE_NOTIFY_VAPID_PRIVATE_KEY is unusable".into())
        })?;
        Ok(Self {
            key,
            public,
            subject: subject.to_string(),
            http: forge_relay::sinks::send::http_client(),
        })
    }

    /// A fresh VAPID private key, base64url (for `forge-notify keys`).
    pub fn generate_private_key() -> String {
        let secret = web_push_native::p256::SecretKey::random(&mut rand::rngs::OsRng);
        URL_SAFE_NO_PAD.encode(secret.to_bytes())
    }

    fn request(
        &self,
        t: &PushTarget,
        body: &[u8],
    ) -> std::result::Result<reqwest::Request, String> {
        let endpoint = t.endpoint.parse().map_err(|_| "bad endpoint".to_string())?;
        let ua = URL_SAFE_NO_PAD
            .decode(t.p256dh.trim_end_matches('='))
            .map_err(|_| "bad p256dh".to_string())?;
        let ua = web_push_native::p256::PublicKey::from_sec1_bytes(&ua)
            .map_err(|_| "bad p256dh".to_string())?;
        let auth = URL_SAFE_NO_PAD
            .decode(t.auth.trim_end_matches('='))
            .map_err(|_| "bad auth".to_string())?;
        if auth.len() != 16 {
            return Err("bad auth".into());
        }
        let req = WebPushBuilder::new(endpoint, ua, Auth::clone_from_slice(&auth))
            .with_valid_duration(Duration::from_hours(12))
            .with_vapid(&self.key, &self.subject)
            .build(body.to_vec())
            .map_err(|e| format!("encrypting the push: {e}"))?;
        let (parts, body) = req.into_parts();
        let mut out = reqwest::Request::new(
            reqwest::Method::POST,
            parts
                .uri
                .to_string()
                .parse()
                .map_err(|_| "bad endpoint".to_string())?,
        );
        for (name, value) in &parts.headers {
            out.headers_mut().insert(name.clone(), value.clone());
        }
        // Urgency: a notification, not a background sync; keep it a day at most.
        out.headers_mut().insert(
            "urgency",
            reqwest::header::HeaderValue::from_static("normal"),
        );
        out.headers_mut()
            .insert("ttl", reqwest::header::HeaderValue::from_static("86400"));
        *out.body_mut() = Some(body.into());
        Ok(out)
    }
}

impl Pusher for WebPusher {
    fn push<'a>(&'a self, target: &'a PushTarget, message: &'a PushMessage) -> PushFuture<'a> {
        Box::pin(async move {
            let body = match serde_json::to_vec(message) {
                Ok(b) => b,
                Err(e) => return PushOutcome::Failed(e.to_string()),
            };
            let req = match self.request(target, &body) {
                Ok(r) => r,
                Err(e) => return PushOutcome::Failed(e),
            };
            match self.http.execute(req).await {
                Ok(r) if r.status().is_success() => PushOutcome::Sent,
                Ok(r) if matches!(r.status().as_u16(), 404 | 410) => PushOutcome::Gone,
                Ok(r) => PushOutcome::Failed(format!("push service answered {}", r.status())),
                Err(e) => PushOutcome::Failed(if e.is_timeout() {
                    "timed out".into()
                } else {
                    "connection failed".into()
                }),
            }
        })
    }

    fn public_key(&self) -> String {
        self.public.clone()
    }
}

/// A pusher that keeps what it is given (tests).
#[derive(Default)]
pub struct CapturePusher {
    /// `(endpoint, message)` pairs.
    pub sent: std::sync::Mutex<Vec<(String, PushMessage)>>,
}

impl Pusher for CapturePusher {
    fn push<'a>(&'a self, target: &'a PushTarget, message: &'a PushMessage) -> PushFuture<'a> {
        self.sent
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push((target.endpoint.clone(), message.clone()));
        Box::pin(async { PushOutcome::Sent })
    }

    fn public_key(&self) -> String {
        "test-public-key".into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target(endpoint: &str) -> PushTarget {
        let ua = web_push_native::p256::SecretKey::random(&mut rand::rngs::OsRng);
        PushTarget {
            endpoint: endpoint.into(),
            p256dh: URL_SAFE_NO_PAD.encode(ua.public_key().to_encoded_point(false).as_bytes()),
            auth: URL_SAFE_NO_PAD.encode([9u8; 16]),
        }
    }

    #[test]
    fn only_known_push_services_are_endpoints() {
        let hosts: Vec<String> = crate::config::DEFAULT_PUSH_HOSTS
            .iter()
            .map(ToString::to_string)
            .collect();
        assert!(check_target(
            &target("https://fcm.googleapis.com/fcm/send/abc"),
            &hosts,
            false
        )
        .is_ok());
        assert!(check_target(&target("https://web.push.apple.com/QGf"), &hosts, false).is_ok());
        assert!(check_target(
            &target("https://evil.example/fcm.googleapis.com"),
            &hosts,
            false
        )
        .is_err());
        assert!(check_target(
            &target("https://fcm.googleapis.com.evil.example/x"),
            &hosts,
            false
        )
        .is_err());
        assert!(check_target(&target("http://fcm.googleapis.com/x"), &hosts, false).is_err());
        assert!(check_target(&target("https://fcm.googleapis.com:8443/x"), &hosts, false).is_err());
        assert!(check_target(&target("http://127.0.0.1:9/x"), &hosts, false).is_err());
        assert!(check_target(&target("http://127.0.0.1:9/x"), &hosts, true).is_ok());
        let mut bad = target("https://fcm.googleapis.com/x");
        bad.auth = URL_SAFE_NO_PAD.encode([1u8; 8]);
        assert!(check_target(&bad, &hosts, false).is_err());
    }

    #[test]
    fn a_push_is_encrypted_to_the_browser_and_signed_with_vapid() {
        let ua = web_push_native::p256::SecretKey::random(&mut rand::rngs::OsRng);
        let auth = [7u8; 16];
        let t = PushTarget {
            endpoint: "https://fcm.googleapis.com/fcm/send/x".into(),
            p256dh: URL_SAFE_NO_PAD.encode(ua.public_key().to_encoded_point(false).as_bytes()),
            auth: URL_SAFE_NO_PAD.encode(auth),
        };
        let p =
            WebPusher::new(&WebPusher::generate_private_key(), "mailto:ops@example.org").unwrap();
        let req = p.request(&t, b"{\"title\":\"hi\"}").unwrap();
        assert!(req.headers()["authorization"]
            .to_str()
            .unwrap()
            .starts_with("vapid t="));
        assert_eq!(req.headers()["content-encoding"], "aes128gcm");
        let body = req.body().unwrap().as_bytes().unwrap().to_vec();
        let plain = web_push_native::decrypt(body, &ua, &Auth::clone_from_slice(&auth)).unwrap();
        assert_eq!(plain, b"{\"title\":\"hi\"}");
        assert_eq!(p.public_key().len(), 87);
    }
}
