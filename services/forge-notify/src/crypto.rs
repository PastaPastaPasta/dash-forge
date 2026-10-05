//! Encryption at rest and the service's tokens.
//!
//! One 32-byte data key (`FORGE_NOTIFY_DATA_KEY`, base64) is expanded with HKDF-SHA256 into:
//! * an AES-256-GCM key for addresses and push endpoints (each sealed with a fresh 96-bit nonce
//!   and bound to its row by the associated data, so a ciphertext moved to another row fails);
//! * an HMAC key for the blind index of an address (`email_idx`: find "is this address already
//!   used" without decrypting every row);
//! * an HMAC key for unsubscribe tokens, which are stateless: identity, epoch and a tag.
//!
//! Losing the data key loses every address (subscribers sign up again); leaking it with the
//! database leaks them. Keep it out of the backups of the data volume.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine as _;
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use rand::RngCore;
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::error::{NotifyError, Result};

type HmacSha256 = Hmac<Sha256>;

/// The keys derived from the data key.
pub struct Vault {
    seal: Aes256Gcm,
    index: Zeroizing<[u8; 32]>,
    tokens: Zeroizing<[u8; 32]>,
}

impl std::fmt::Debug for Vault {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Vault([redacted])")
    }
}

fn expand(hk: &Hkdf<Sha256>, info: &str) -> Zeroizing<[u8; 32]> {
    let mut out = Zeroizing::new([0u8; 32]);
    hk.expand(info.as_bytes(), out.as_mut())
        .expect("32 bytes is a valid HKDF-SHA256 output length");
    out
}

/// 32 random bytes, base64url.
pub fn random_token() -> String {
    let mut b = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut b);
    URL_SAFE_NO_PAD.encode(b)
}

/// SHA-256 of a token, hex (what the store keeps of a verification token).
pub fn token_hash(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

impl Vault {
    /// The vault for a base64 data key of exactly 32 bytes.
    pub fn from_base64(key: &str) -> Result<Self> {
        let raw = Zeroizing::new(
            STANDARD
                .decode(key.trim())
                .map_err(|_| NotifyError::Config("FORGE_NOTIFY_DATA_KEY is not base64".into()))?,
        );
        let raw: &[u8; 32] = raw.as_slice().try_into().map_err(|_| {
            NotifyError::Config(
                "FORGE_NOTIFY_DATA_KEY must be 32 bytes (openssl rand -base64 32)".into(),
            )
        })?;
        Ok(Self::new(raw))
    }

    /// The vault for a raw key.
    pub fn new(key: &[u8; 32]) -> Self {
        let hk = Hkdf::<Sha256>::new(Some(b"forge-notify"), key);
        let seal_key = expand(&hk, "forge-notify/v1 seal");
        Self {
            seal: Aes256Gcm::new_from_slice(seal_key.as_ref()).expect("a 32-byte AES-256 key"),
            index: expand(&hk, "forge-notify/v1 index"),
            tokens: expand(&hk, "forge-notify/v1 tokens"),
        }
    }

    /// Seal `plain` for the row named by `context`: `nonce || ciphertext`.
    pub fn seal(&self, context: &str, plain: &[u8]) -> Result<Vec<u8>> {
        let mut nonce = [0u8; 12];
        rand::thread_rng().fill_bytes(&mut nonce);
        let ct = self
            .seal
            .encrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: plain,
                    aad: context.as_bytes(),
                },
            )
            .map_err(|_| NotifyError::Internal("sealing failed".into()))?;
        let mut out = nonce.to_vec();
        out.extend_from_slice(&ct);
        Ok(out)
    }

    /// Open what [`Self::seal`] sealed for `context`.
    pub fn open(&self, context: &str, sealed: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
        if sealed.len() < 12 + 16 {
            return Err(NotifyError::Internal("a sealed value is too short".into()));
        }
        let (nonce, ct) = sealed.split_at(12);
        self.seal
            .decrypt(
                Nonce::from_slice(nonce),
                Payload {
                    msg: ct,
                    aad: context.as_bytes(),
                },
            )
            .map(Zeroizing::new)
            .map_err(|_| {
                NotifyError::Internal("a sealed value does not open (wrong data key?)".into())
            })
    }

    /// Open a sealed UTF-8 string.
    pub fn open_string(&self, context: &str, sealed: &[u8]) -> Result<Zeroizing<String>> {
        let plain = self.open(context, sealed)?;
        String::from_utf8(plain.to_vec())
            .map(Zeroizing::new)
            .map_err(|_| NotifyError::Internal("a sealed value is not UTF-8".into()))
    }

    /// The blind index of an address (case-folded).
    pub fn email_index(&self, email: &str) -> String {
        let mut mac =
            <HmacSha256 as Mac>::new_from_slice(self.index.as_ref()).expect("any key length");
        mac.update(email.trim().to_lowercase().as_bytes());
        hex::encode(mac.finalize().into_bytes())
    }

    /// The blind key a per-address limit counts under: [`limit_address`] of the address, so
    /// `a+1@x` and `a+2@x` (and Gmail's dotted spellings) share one limit. Only for limits: the
    /// stored index ([`Vault::email_index`]) keeps the address as given.
    pub fn email_limit_key(&self, email: &str) -> String {
        let mut mac =
            <HmacSha256 as Mac>::new_from_slice(self.index.as_ref()).expect("any key length");
        mac.update(b"limit/v1\n");
        mac.update(limit_address(email).as_bytes());
        hex::encode(mac.finalize().into_bytes())
    }

    fn unsubscribe_tag(&self, identity: &str, epoch: u32) -> [u8; 16] {
        let mut mac =
            <HmacSha256 as Mac>::new_from_slice(self.tokens.as_ref()).expect("any key length");
        mac.update(b"unsubscribe/v1\n");
        mac.update(identity.as_bytes());
        mac.update(&epoch.to_be_bytes());
        let full = mac.finalize().into_bytes();
        let mut tag = [0u8; 16];
        tag.copy_from_slice(&full[..16]);
        tag
    }

    /// A one-click unsubscribe token for `identity` at `epoch` (the subscriber row's counter:
    /// bumping it voids every older link).
    pub fn unsubscribe_token(&self, identity: &str, epoch: u32) -> String {
        let mut raw = Vec::with_capacity(4 + 16 + identity.len());
        raw.extend_from_slice(&epoch.to_be_bytes());
        raw.extend_from_slice(&self.unsubscribe_tag(identity, epoch));
        raw.extend_from_slice(identity.as_bytes());
        URL_SAFE_NO_PAD.encode(raw)
    }

    /// The identity and epoch of a genuine unsubscribe token.
    pub fn check_unsubscribe_token(&self, token: &str) -> Option<(String, u32)> {
        let raw = URL_SAFE_NO_PAD.decode(token).ok()?;
        if raw.len() < 4 + 16 + 1 || raw.len() > 4 + 16 + 64 {
            return None;
        }
        let epoch = u32::from_be_bytes(raw[..4].try_into().ok()?);
        let identity = std::str::from_utf8(&raw[20..]).ok()?;
        let want = self.unsubscribe_tag(identity, epoch);
        bool::from(subtle::ConstantTimeEq::ct_eq(&want[..], &raw[4..20]))
            .then(|| (identity.to_string(), epoch))
    }
}

/// The mailbox an address reaches, as far as a rate limit cares: lowercased, without a
/// `+tag`, and for Gmail (`gmail.com`, `googlemail.com`) without dots in the local part.
pub fn limit_address(email: &str) -> String {
    let e = email.trim().to_lowercase();
    let Some((local, domain)) = e.rsplit_once('@') else {
        return e;
    };
    let local = local.split('+').next().unwrap_or_default();
    if matches!(domain, "gmail.com" | "googlemail.com") {
        format!("{}@gmail.com", local.replace('.', ""))
    } else {
        format!("{local}@{domain}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limits_count_one_mailbox_however_it_is_spelled() {
        assert_eq!(limit_address(" Bob+x@Example.org"), "bob@example.org");
        assert_eq!(limit_address("b.o.b@example.org"), "b.o.b@example.org");
        assert_eq!(limit_address("B.o.b+tag@googlemail.com"), "bob@gmail.com");
        assert_eq!(limit_address("bob@gmail.com"), "bob@gmail.com");
        let v = Vault::new(&[7; 32]);
        assert_eq!(
            v.email_limit_key("b.ob+1@gmail.com"),
            v.email_limit_key("bob+2@googlemail.com")
        );
        assert_ne!(
            v.email_limit_key("bob@gmail.com"),
            v.email_index("bob@gmail.com")
        );
        assert_ne!(
            v.email_index("bob+1@example.org"),
            v.email_index("bob@example.org")
        );
    }

    #[test]
    fn sealing_is_bound_to_its_row() {
        let v = Vault::new(&[7; 32]);
        let s = v.seal("email:A", b"a@example.org").unwrap();
        assert_eq!(v.open("email:A", &s).unwrap().as_slice(), b"a@example.org");
        assert!(v.open("email:B", &s).is_err());
        assert!(Vault::new(&[8; 32]).open("email:A", &s).is_err());
        assert_ne!(s, v.seal("email:A", b"a@example.org").unwrap());
    }

    #[test]
    fn the_index_folds_case_and_unsubscribe_tokens_verify() {
        let v = Vault::new(&[7; 32]);
        assert_eq!(
            v.email_index(" A@Example.org"),
            v.email_index("a@example.org")
        );
        let t = v.unsubscribe_token("IdentityA", 3);
        assert_eq!(v.check_unsubscribe_token(&t), Some(("IdentityA".into(), 3)));
        let mut forged = URL_SAFE_NO_PAD.decode(&t).unwrap();
        let last = forged.len() - 1;
        forged[last] ^= 1;
        assert!(v
            .check_unsubscribe_token(&URL_SAFE_NO_PAD.encode(forged))
            .is_none());
        assert!(Vault::new(&[8; 32]).check_unsubscribe_token(&t).is_none());
        assert!(Vault::from_base64("c2hvcnQ=").is_err());
    }
}
