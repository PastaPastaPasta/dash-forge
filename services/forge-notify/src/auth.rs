//! Signed requests: prove control of a Forge identity with no account and no password
//! (`docs/design/service-auth.md`).
//!
//! The client sends `{"request": "<JSON text>", "signature": "<base64>"}`. The signature is a
//! 64-byte compact ECDSA secp256k1 signature (r ‖ s, RFC 6979) over
//! `SHA-256(SHA-256("DashForgeService/v1\n" ‖ request))`, by one of the identity's keys.
//! The request text is signed exactly as sent, so nothing is canonicalised. It carries:
//!
//! ```json
//! {"v":1,"service":"notify.example.org","action":"email.set","identity":"<base58 id>",
//!  "key":3,"nonce":"<16-64 base64url chars>","time":1791130000,"payload":{"email":"…"}}
//! ```
//!
//! The service accepts it when `service` is its operator name, `time` is within
//! [`MAX_SKEW_SECS`] of its clock, the nonce is new, and key `key` of `identity`, read from
//! Platform with proofs, is enabled, `AUTHENTICATION`, `HIGH` or `CRITICAL`, `ECDSA_SECP256K1`,
//! and verifies the signature. The domain line means the signed bytes can never be a state
//! transition; the operator name means a request for one operator is refused by another.
//!
//! This is an off-chain convention of Dash Forge's services, not a Platform protocol feature.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use secp256k1::{ecdsa::Signature, Message, PublicKey, Secp256k1};
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

use forge_core::platform::{IdentityKeyInfo, PlatformClient};

use crate::error::{NotifyError, Result};

/// The domain line every signed request starts with.
pub const DOMAIN: &str = "DashForgeService/v1\n";

/// How far a request's `time` may be from the service's clock.
pub const MAX_SKEW_SECS: u64 = 300;

/// The longest request text accepted.
pub const MAX_REQUEST_BYTES: usize = 8 * 1024;

/// The actions a signed request can name.
pub const ACTIONS: &[&str] = &[
    "account.get",
    "email.set",
    "email.remove",
    "prefs.set",
    "push.add",
    "push.remove",
    "test.send",
    "data.export",
    "data.delete",
];

/// What the client posts.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SignedEnvelope {
    /// The request JSON, as signed.
    pub request: String,
    /// The signature, base64 (64 bytes).
    pub signature: String,
}

/// A request, parsed after its signature checked out.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SignedRequest {
    /// Format version: 1.
    pub v: u8,
    /// The operator name this request is for.
    pub service: String,
    /// One of [`ACTIONS`].
    pub action: String,
    /// The identity (base58).
    pub identity: String,
    /// The signing key's id.
    pub key: u32,
    /// A one-time value.
    pub nonce: String,
    /// Unix seconds.
    pub time: u64,
    /// The action's arguments.
    #[serde(default)]
    pub payload: Value,
}

/// The bytes a request's signature covers: `SHA-256(SHA-256(DOMAIN ‖ request))`.
pub fn digest(request: &str) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(DOMAIN.as_bytes());
    h.update(request.as_bytes());
    Sha256::digest(h.finalize()).into()
}

/// Sign `request` with a raw secp256k1 secret key: the base64 compact signature (what a client
/// does; used by tests and the CLI's `sign` helper).
pub fn sign(request: &str, secret: &secp256k1::SecretKey) -> String {
    let secp = Secp256k1::signing_only();
    let sig = secp.sign_ecdsa(&Message::from_digest(digest(request)), secret);
    STANDARD.encode(sig.serialize_compact())
}

/// A boxed read of an identity's keys.
pub type KeysFuture<'a> = std::pin::Pin<
    Box<dyn std::future::Future<Output = Result<Option<Vec<IdentityKeyInfo>>>> + Send + 'a>,
>;

/// A cached read of an identity's keys (`None`: no such identity), and when it was read.
type CachedKeys = (Option<Vec<IdentityKeyInfo>>, Instant);

/// Where an identity's public keys come from.
pub trait KeySource: Send + Sync {
    /// The identity's keys, read with proofs. `Ok(None)` when there is no such identity.
    fn keys<'a>(&'a self, identity: &'a str) -> KeysFuture<'a>;
}

/// Identity keys from Platform (the SDK verifies the proofs), cached for a minute.
pub struct PlatformKeys {
    client: Arc<PlatformClient>,
    cache: Mutex<HashMap<String, CachedKeys>>,
}

impl PlatformKeys {
    /// Keys read through `client`.
    pub fn new(client: Arc<PlatformClient>) -> Self {
        Self {
            client,
            cache: Mutex::new(HashMap::new()),
        }
    }
}

const KEY_CACHE_TTL: Duration = Duration::from_secs(60);
const KEY_CACHE_MAX: usize = 10_000;

impl KeySource for PlatformKeys {
    fn keys<'a>(&'a self, identity: &'a str) -> KeysFuture<'a> {
        Box::pin(async move {
            if let Some((keys, at)) = lock(&self.cache).get(identity) {
                if at.elapsed() < KEY_CACHE_TTL {
                    return Ok(keys.clone());
                }
            }
            let keys = match self.client.fetch_identity(identity).await {
                Ok(i) => Some(i.public_keys()),
                Err(forge_core::error::Error::NotFound) => None,
                Err(e) => return Err(e.into()),
            };
            let mut cache = lock(&self.cache);
            if cache.len() >= KEY_CACHE_MAX {
                // Expired entries first, then misses (random ids cost a read each and must not
                // push real subscribers' keys out), and only then everything.
                cache.retain(|_, (_, at)| at.elapsed() < KEY_CACHE_TTL);
                if cache.len() >= KEY_CACHE_MAX {
                    cache.retain(|_, (k, _)| k.is_some());
                }
                if cache.len() >= KEY_CACHE_MAX {
                    cache.clear();
                }
            }
            cache.insert(identity.to_string(), (keys.clone(), Instant::now()));
            Ok(keys)
        })
    }
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Whether `k` may sign service requests.
pub fn usable_signing_key(k: &IdentityKeyInfo) -> bool {
    !k.disabled
        && k.purpose == "AUTHENTICATION"
        && matches!(k.security_level.as_str(), "HIGH" | "CRITICAL")
        && k.key_type == "ECDSA_SECP256K1"
}

/// A plausible identity id: base58 of 32 bytes.
pub fn valid_identity(id: &str) -> bool {
    forge_core::platform::decode_identifier(id).is_ok()
}

/// Check the envelope's shape, time, service and signature. The nonce is checked (and
/// recorded) by the caller, against the store.
pub async fn verify(
    env: &SignedEnvelope,
    operator: &str,
    keys: &dyn KeySource,
    now_secs: u64,
) -> Result<SignedRequest> {
    if env.request.len() > MAX_REQUEST_BYTES {
        return Err(NotifyError::BadRequest("the request is too long".into()));
    }
    let req: SignedRequest = serde_json::from_str(&env.request)
        .map_err(|e| NotifyError::BadRequest(format!("the request does not parse: {e}")))?;
    if req.v != 1 {
        return Err(NotifyError::BadRequest("unknown request version".into()));
    }
    if req.service != operator {
        return Err(NotifyError::Unauthorized(format!(
            "the request is for {:?}, not this service ({operator:?})",
            req.service
        )));
    }
    if !ACTIONS.contains(&req.action.as_str()) {
        return Err(NotifyError::BadRequest(format!(
            "unknown action {:?}",
            req.action
        )));
    }
    if !valid_identity(&req.identity) {
        return Err(NotifyError::BadRequest(
            "identity is not an identity id".into(),
        ));
    }
    if !(16..=64).contains(&req.nonce.len())
        || !req
            .nonce
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(NotifyError::BadRequest(
            "nonce must be 16 to 64 base64url characters".into(),
        ));
    }
    if req.time.abs_diff(now_secs) > MAX_SKEW_SECS {
        return Err(NotifyError::Unauthorized(
            "the request's time is more than 5 minutes off; check this device's clock".into(),
        ));
    }
    let sig_bytes = STANDARD
        .decode(env.signature.trim())
        .map_err(|_| NotifyError::BadRequest("signature is not base64".into()))?;
    let sig = Signature::from_compact(&sig_bytes)
        .map_err(|_| NotifyError::BadRequest("signature is not a 64-byte signature".into()))?;
    let Some(all) = keys.keys(&req.identity).await? else {
        return Err(NotifyError::Unauthorized("no such identity".into()));
    };
    let key = all
        .iter()
        .find(|k| k.id == req.key)
        .ok_or_else(|| NotifyError::Unauthorized(format!("the identity has no key {}", req.key)))?;
    if !usable_signing_key(key) {
        return Err(NotifyError::Unauthorized(format!(
            "key {} cannot sign service requests (it must be an enabled ECDSA_SECP256K1 \
             AUTHENTICATION key of HIGH or CRITICAL level)",
            req.key
        )));
    }
    let public = PublicKey::from_slice(&key.public_key)
        .map_err(|_| NotifyError::Unauthorized("the key's data is not a public key".into()))?;
    let mut sig = sig;
    sig.normalize_s();
    Secp256k1::verification_only()
        .verify_ecdsa(&Message::from_digest(digest(&env.request)), &sig, &public)
        .map_err(|_| NotifyError::Unauthorized("the signature does not verify".into()))?;
    Ok(req)
}

#[cfg(test)]
pub mod tests {
    use super::*;

    /// A key source that knows one identity and its keys.
    pub struct StaticKeys(pub String, pub Vec<IdentityKeyInfo>);

    impl KeySource for StaticKeys {
        fn keys<'a>(&'a self, identity: &'a str) -> KeysFuture<'a> {
            let found = (identity == self.0).then(|| self.1.clone());
            Box::pin(async move { Ok(found) })
        }
    }

    /// An AUTHENTICATION/HIGH key `id` for secret `s`.
    pub fn key_info(id: u32, s: &secp256k1::SecretKey) -> IdentityKeyInfo {
        IdentityKeyInfo {
            id,
            purpose: "AUTHENTICATION".into(),
            security_level: "HIGH".into(),
            key_type: "ECDSA_SECP256K1".into(),
            public_key: PublicKey::from_secret_key(&Secp256k1::new(), s)
                .serialize()
                .to_vec(),
            disabled: false,
            bound_to: None,
        }
    }

    pub const IDENTITY: &str = "FrNpRnZQPP5gLFAjD7Foz4tZaML5DJ88CqaCvAkYNYjU";

    fn request(time: u64, service: &str) -> String {
        format!(
            r#"{{"v":1,"service":"{service}","action":"account.get","identity":"{IDENTITY}","key":2,"nonce":"AAAAAAAAAAAAAAAAAAAAAA","time":{time},"payload":{{}}}}"#
        )
    }

    async fn check(
        request: &str,
        signature: String,
        operator: &str,
        keys: &StaticKeys,
        now: u64,
    ) -> Result<SignedRequest> {
        let env = SignedEnvelope {
            request: request.to_string(),
            signature,
        };
        verify(&env, operator, keys, now).await
    }

    #[tokio::test]
    async fn a_good_signature_verifies_and_every_mismatch_is_refused() {
        let s = secp256k1::SecretKey::from_slice(&[0x11; 32]).unwrap();
        let keys = StaticKeys(IDENTITY.into(), vec![key_info(2, &s)]);
        let op = "notify.example.org";
        let req = request(1_000_000, op);
        let ok = check(&req, sign(&req, &s), op, &keys, 1_000_100)
            .await
            .unwrap();
        assert_eq!((ok.action.as_str(), ok.key), ("account.get", 2));

        let other = secp256k1::SecretKey::from_slice(&[0x22; 32]).unwrap();
        let unauthorized =
            |r: Result<SignedRequest>| matches!(r, Err(NotifyError::Unauthorized(_)));
        assert!(unauthorized(
            check(&req, sign(&req, &other), op, &keys, 1_000_100).await
        ));
        assert!(unauthorized(
            check(&req, sign(&req, &s), "evil.example", &keys, 1_000_100).await
        ));
        assert!(unauthorized(
            check(&req, sign(&req, &s), op, &keys, 1_000_400).await
        ));
        // The signature covers the exact text.
        let edited = req.replace("account.get", "data.delete");
        assert!(unauthorized(
            check(&edited, sign(&req, &s), op, &keys, 1_000_100).await
        ));

        let mut master = key_info(2, &s);
        master.security_level = "MASTER".into();
        let keys = StaticKeys(IDENTITY.into(), vec![master]);
        assert!(unauthorized(
            check(&req, sign(&req, &s), op, &keys, 1_000_100).await
        ));
    }

    /// The vector in `docs/design/service-auth.md` (and forge-web's test): RFC 6979 makes the
    /// signature deterministic, so both implementations must produce these exact bytes.
    #[test]
    fn the_shared_test_vector() {
        let s = secp256k1::SecretKey::from_slice(&[0x11; 32]).unwrap();
        let req = request(1_791_130_000, "notify.example.org");
        assert_eq!(
            hex::encode(digest(&req)),
            include_str!("../testdata/vector-digest.txt").trim()
        );
        assert_eq!(
            sign(&req, &s),
            include_str!("../testdata/vector-signature.txt").trim()
        );
    }
}
