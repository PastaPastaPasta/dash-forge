//! Handing a limited key from `dg` to a browser tab, so the recovery phrase never reaches a web
//! page (trust and safety TS-06; `docs/contracts/forge-v2.md` "Key handoff").
//!
//! 1. The browser draws a one-time secp256k1 key pair and shows its public half as a
//!    **request**: `dfkr1:<network>:<base64url(compressed public key, 33 bytes)>`.
//! 2. `dg auth keys add --for-browser <request>` registers a limited key (signed by the master
//!    key on the terminal) and prints a **reply** sealed to that public key:
//!    `dfkh1:<network>:<base64url(ephemeral public key (33) ‖ nonce (12) ‖ AES-256-GCM ciphertext)>`.
//! 3. The browser opens the reply with its one-time private key, checks the key on chain and
//!    keeps it in its vault.
//!
//! The AES key is `HKDF-SHA256(ikm = x(ECDH), salt = ephemeral public ‖ request public,
//! info = "dash-forge/key-handoff/1")`; the associated data is `"dfkh1:" ‖ network`, so a reply
//! for one network does not open on another. The plaintext is a JSON object
//! ([`Payload`]). The reply is useless to anyone without the browser's one-time private key, so
//! it may be printed and pasted; the key it carries is still a limited key, which is the point.
//!
//! The browser side is `forge-web/lib/auth/key-handoff.ts`; both run the
//! `key_handoff_*` conformance vectors.

use aes_gcm::aead::{Aead as _, Payload as AeadPayload};
use aes_gcm::{Aes256Gcm, KeyInit as _, Nonce};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use hkdf::Hkdf;
use secp256k1::{PublicKey, SecretKey};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use zeroize::Zeroizing;

use crate::error::{Error, Result};

/// The prefix of a browser's request.
pub const REQUEST_PREFIX: &str = "dfkr1:";
/// The prefix of `dg`'s reply.
pub const REPLY_PREFIX: &str = "dfkh1:";
/// The HKDF `info` of the reply key.
const INFO: &[u8] = b"dash-forge/key-handoff/1";
/// The largest plaintext a reply carries (a key, an encryption key and their ids fit in 400 B).
const MAX_PAYLOAD: usize = 2048;

/// The fixed warning shown before every recovery-phrase prompt, in `dg` and in the web app
/// (TS-06; vector `copy__recovery_phrase_warning`).
pub const RECOVERY_PHRASE_WARNING: &str =
    "Your recovery phrase controls your identity. Forge asks \
for it only after you start a key action yourself, never because a message, an email or a pop-up \
says so. If you didn't start this, stop here.";

/// A browser's request: the network it is on and its one-time public key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Request {
    /// The network key (`sakura`, `testnet`, …).
    pub network: String,
    /// The browser's one-time public key.
    pub public_key: PublicKey,
}

fn bad_request(why: &str) -> Error {
    Error::Config(format!(
        "that is not a browser key request ({why}); copy the whole dfkr1:… line the browser shows"
    ))
}

fn valid_network(n: &str) -> bool {
    !n.is_empty() && n.len() <= 32 && n.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// Parse a `dfkr1:` request.
pub fn parse_request(text: &str) -> Result<Request> {
    let rest = text
        .trim()
        .strip_prefix(REQUEST_PREFIX)
        .ok_or_else(|| bad_request("it does not start with dfkr1:"))?;
    let (network, key) = rest
        .split_once(':')
        .ok_or_else(|| bad_request("it has no network"))?;
    if !valid_network(network) {
        return Err(bad_request("the network is not a network name"));
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(key)
        .map_err(|_| bad_request("the key is not base64url"))?;
    if bytes.len() != 33 {
        return Err(bad_request("the key is not a compressed public key"));
    }
    let public_key =
        PublicKey::from_slice(&bytes).map_err(|_| bad_request("the key is not on the curve"))?;
    Ok(Request {
        network: network.to_string(),
        public_key,
    })
}

/// The `dfkr1:` text of a request (the browser makes these; here for tests).
pub fn request_text(network: &str, public_key: &PublicKey) -> String {
    format!(
        "{REQUEST_PREFIX}{network}:{}",
        URL_SAFE_NO_PAD.encode(public_key.serialize())
    )
}

/// The key the reply carries.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Payload {
    /// Always 1.
    pub v: u32,
    /// The network key; equal to the request's.
    pub network: String,
    /// The identity the key belongs to.
    pub identity_id: String,
    /// The new limited key's id on the identity.
    pub key_id: u32,
    /// Its private key, WIF.
    pub wif: String,
    /// The limited key it replaced (disabled in the same update), if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replaced_key_id: Option<u32>,
    /// The identity's encryption key, when the user chose to hand it over too.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub encryption_key: Option<EncryptionKey>,
}

/// An `ENCRYPTION` key in a [`Payload`].
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EncryptionKey {
    /// Its id on the identity.
    pub key_id: u32,
    /// The private key, 64 hex characters.
    pub private_key_hex: String,
}

impl Drop for Payload {
    fn drop(&mut self) {
        use zeroize::Zeroize as _;
        self.wif.zeroize();
    }
}

impl Drop for EncryptionKey {
    fn drop(&mut self) {
        use zeroize::Zeroize as _;
        self.private_key_hex.zeroize();
    }
}

impl std::fmt::Debug for EncryptionKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EncryptionKey")
            .field("key_id", &self.key_id)
            .finish_non_exhaustive()
    }
}

impl std::fmt::Debug for Payload {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Payload")
            .field("network", &self.network)
            .field("identity_id", &self.identity_id)
            .field("key_id", &self.key_id)
            .finish_non_exhaustive()
    }
}

/// The AES key for a reply between `ephemeral` (dg's) and `request` (the browser's) keys.
fn reply_key(shared_x: &[u8], ephemeral: &PublicKey, request: &PublicKey) -> Zeroizing<[u8; 32]> {
    let mut salt = [0u8; 66];
    salt[..33].copy_from_slice(&ephemeral.serialize());
    salt[33..].copy_from_slice(&request.serialize());
    let hk = Hkdf::<Sha256>::new(Some(&salt), shared_x);
    let mut key = Zeroizing::new([0u8; 32]);
    hk.expand(INFO, key.as_mut())
        .expect("32 bytes is a valid HKDF-SHA256 length");
    key
}

fn shared_x(point: &PublicKey, scalar: &SecretKey) -> Zeroizing<[u8; 32]> {
    let full = Zeroizing::new(secp256k1::ecdh::shared_secret_point(point, scalar));
    let mut x = Zeroizing::new([0u8; 32]);
    x.copy_from_slice(&full[..32]);
    x
}

fn aad(network: &str) -> Vec<u8> {
    format!("{REPLY_PREFIX}{network}").into_bytes()
}

/// Seal `payload` for `request` with a fresh ephemeral key and nonce.
pub fn seal(request: &Request, payload: &Payload) -> Result<String> {
    let mut eph = Zeroizing::new([0u8; 32]);
    let mut nonce = [0u8; 12];
    loop {
        getrandom::getrandom(eph.as_mut())
            .map_err(|e| Error::Config(format!("no randomness: {e}")))?;
        if SecretKey::from_slice(eph.as_ref()).is_ok() {
            break;
        }
    }
    getrandom::getrandom(&mut nonce).map_err(|e| Error::Config(format!("no randomness: {e}")))?;
    seal_with(request, payload, &eph, nonce)
}

/// [`seal`] with a given ephemeral secret and nonce (conformance vectors).
pub fn seal_with(
    request: &Request,
    payload: &Payload,
    ephemeral_secret: &[u8; 32],
    nonce: [u8; 12],
) -> Result<String> {
    if payload.network != request.network {
        return Err(Error::Config(format!(
            "the key is for {}, but the browser is on {}",
            payload.network, request.network
        )));
    }
    let plain = Zeroizing::new(
        serde_json::to_vec(payload).map_err(|e| Error::Config(format!("payload: {e}")))?,
    );
    seal_bytes(request, &plain, ephemeral_secret, nonce)
}

/// Seal raw plaintext bytes (the vectors fix them byte for byte).
pub fn seal_bytes(
    request: &Request,
    plain: &[u8],
    ephemeral_secret: &[u8; 32],
    nonce: [u8; 12],
) -> Result<String> {
    if plain.len() > MAX_PAYLOAD {
        return Err(Error::Config("the key handoff is too large".into()));
    }
    let secp = secp256k1::Secp256k1::new();
    let eph = SecretKey::from_slice(ephemeral_secret)
        .map_err(|_| Error::Config("bad ephemeral key".into()))?;
    let eph_pub = PublicKey::from_secret_key(&secp, &eph);
    let x = shared_x(&request.public_key, &eph);
    let key = reply_key(x.as_ref(), &eph_pub, &request.public_key);
    let cipher = Aes256Gcm::new_from_slice(key.as_ref()).expect("32-byte key");
    let aad = aad(&request.network);
    let ct = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            AeadPayload {
                msg: plain,
                aad: &aad,
            },
        )
        .map_err(|_| Error::Config("sealing the key handoff failed".into()))?;
    let mut out = Vec::with_capacity(33 + 12 + ct.len());
    out.extend_from_slice(&eph_pub.serialize());
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ct);
    Ok(format!(
        "{REPLY_PREFIX}{}:{}",
        request.network,
        URL_SAFE_NO_PAD.encode(out)
    ))
}

/// Why a reply does not open.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpenError {
    /// Not a `dfkh1:` reply, or cut short.
    Malformed,
    /// Made for another network.
    Network,
    /// Not sealed to this request's key, or altered.
    Unreadable,
}

/// Open a reply with the browser's one-time `secret` (the browser does this; here for tests and
/// for the vectors). Returns the plaintext bytes.
pub fn open(
    reply: &str,
    network: &str,
    secret: &[u8; 32],
) -> std::result::Result<Zeroizing<Vec<u8>>, OpenError> {
    let rest = reply
        .trim()
        .strip_prefix(REPLY_PREFIX)
        .ok_or(OpenError::Malformed)?;
    let (net, body) = rest.split_once(':').ok_or(OpenError::Malformed)?;
    if !valid_network(net) {
        return Err(OpenError::Malformed);
    }
    if net != network {
        return Err(OpenError::Network);
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(body)
        .map_err(|_| OpenError::Malformed)?;
    if bytes.len() < 33 + 12 + 16 {
        return Err(OpenError::Malformed);
    }
    let eph_pub = PublicKey::from_slice(&bytes[..33]).map_err(|_| OpenError::Malformed)?;
    let mine = SecretKey::from_slice(secret).map_err(|_| OpenError::Unreadable)?;
    let secp = secp256k1::Secp256k1::new();
    let my_pub = PublicKey::from_secret_key(&secp, &mine);
    let x = shared_x(&eph_pub, &mine);
    let key = reply_key(x.as_ref(), &eph_pub, &my_pub);
    let cipher = Aes256Gcm::new_from_slice(key.as_ref()).expect("32-byte key");
    let aad = aad(net);
    cipher
        .decrypt(
            Nonce::from_slice(&bytes[33..45]),
            AeadPayload {
                msg: &bytes[45..],
                aad: &aad,
            },
        )
        .map(Zeroizing::new)
        .map_err(|_| OpenError::Unreadable)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn browser() -> ([u8; 32], Request) {
        let secret = [7u8; 32];
        let secp = secp256k1::Secp256k1::new();
        let pk = PublicKey::from_secret_key(&secp, &SecretKey::from_slice(&secret).unwrap());
        (
            secret,
            Request {
                network: "sakura".into(),
                public_key: pk,
            },
        )
    }

    fn payload(network: &str) -> Payload {
        Payload {
            v: 1,
            network: network.into(),
            identity_id: "8hJmcHWTsdvkHyCrk4UgjbyugDAmE7QfuCTQXpXAc7nB".into(),
            key_id: 7,
            wif: "cTestWif".into(),
            replaced_key_id: Some(5),
            encryption_key: None,
        }
    }

    #[test]
    fn a_request_round_trips_and_garbage_is_refused() {
        let (_, req) = browser();
        let text = request_text("sakura", &req.public_key);
        assert_eq!(parse_request(&text).unwrap(), req);
        assert_eq!(parse_request(&format!("  {text}\n")).unwrap(), req);
        for bad in [
            "",
            "dfkr1:",
            "dfkr1:sakura",
            "dfkr1:sa kura:AAAA",
            "dfkh1:sakura:AAAA",
            "dfkr1:sakura:AAAA",
        ] {
            assert!(parse_request(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_reply_opens_only_with_the_request_key_and_network() {
        let (secret, req) = browser();
        let reply = seal(&req, &payload("sakura")).unwrap();
        let plain = open(&reply, "sakura", &secret).unwrap();
        let back: Payload = serde_json::from_slice(&plain).unwrap();
        assert_eq!(back.key_id, 7);
        assert_eq!(back.replaced_key_id, Some(5));
        assert_eq!(
            open(&reply, "testnet", &secret).unwrap_err(),
            OpenError::Network
        );
        assert_eq!(
            open(&reply, "sakura", &[9u8; 32]).unwrap_err(),
            OpenError::Unreadable
        );
        // one flipped character of the ciphertext
        let mut tampered = reply.clone();
        let last = tampered.pop().unwrap();
        tampered.push(if last == 'A' { 'B' } else { 'A' });
        assert!(open(&tampered, "sakura", &secret).is_err());
        // the network in the clear cannot be swapped: it is the associated data
        let moved = reply.replacen("dfkh1:sakura:", "dfkh1:testnet:", 1);
        assert_eq!(
            open(&moved, "testnet", &secret).unwrap_err(),
            OpenError::Unreadable
        );
    }

    #[test]
    fn a_key_for_another_network_is_never_sealed() {
        let (_, req) = browser();
        assert!(seal(&req, &payload("testnet")).is_err());
    }

    #[test]
    fn the_payload_never_debug_prints_its_keys() {
        let p = payload("sakura");
        assert!(!format!("{p:?}").contains("cTestWif"));
    }
}
