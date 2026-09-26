//! The `encryptedFor` envelope: Platform's `ecdh-secp256k1-aes256-cbc` scheme (protocol 14).
//!
//! A document property declared `encryptedFor {recipient, recipientKey, senderKey, scheme}`
//! holds bytes only the recipient (and the sender) can read. forge-v2 uses it for a webhook's
//! HMAC secret (`webhook.secret`, encrypted to the relay identity) and, later, for private-repo
//! key wraps (`repoKey.wrapped`). This module is the scheme, byte for byte as rs-sdk's
//! `platform::encrypted_for` writes it, built on the same `platform-encryption` crate:
//!
//! * shared key = libsecp256k1 ECDH of one side's private key and the other side's public key,
//!   `SHA256((y & 1 | 2) || x)` of the product point (`derive_shared_key_ecdh`);
//! * bytes = a random 16-byte IV followed by the plaintext under AES-256-CBC with PKCS7 padding.
//!
//! ECDH is symmetric: the recipient decrypts with its private key and the sender's public key,
//! and the sender can read its own message with its private key and the recipient's public key.
//!
//! **No authentication tag.** A wrong key is caught only by the padding check, which a wrong
//! key passes about once in 256 attempts and then yields garbage. Callers must therefore
//! recognise their plaintext (a webhook secret is checked for its length; a key wrap will be
//! checked against its key-check value) and must treat the result as opaque bytes, never as
//! proof of who wrote it. Consensus checks only the shape ([`is_valid_ciphertext_length`]) and
//! that the named keys exist, are enabled and are encryption keys.

use std::fmt;

use rand::RngCore;
use secp256k1::{PublicKey, Secp256k1, SecretKey};
use zeroize::Zeroizing;

use crate::error::{Error, Result};
use crate::keystore::{BridgeIdentity, IdentityKey};

/// The only scheme Platform defines for `encryptedFor`.
pub const SCHEME: &str = "ecdh-secp256k1-aes256-cbc";

/// The IV that prefixes every ciphertext.
pub const IV_LEN: usize = 16;

/// The AES block length; a ciphertext after its IV is whole blocks.
pub const BLOCK_LEN: usize = 16;

/// Whether `len` bytes can be a ciphertext of the scheme: an IV plus at least one whole block
/// (the shape consensus checks on an `encryptedFor` property).
pub fn is_valid_ciphertext_length(len: usize) -> bool {
    len >= IV_LEN + BLOCK_LEN && len.is_multiple_of(BLOCK_LEN)
}

/// The ciphertext length a `plaintext_len`-byte plaintext encrypts to (PKCS7 always pads).
pub fn ciphertext_len(plaintext_len: usize) -> usize {
    IV_LEN + (plaintext_len / BLOCK_LEN + 1) * BLOCK_LEN
}

/// Secret bytes (a decrypted webhook secret, a content key): wiped on drop, never printed.
#[derive(Clone, PartialEq, Eq)]
pub struct SecretBytes(Zeroizing<Vec<u8>>);

impl SecretBytes {
    /// Wrap secret bytes.
    pub fn new(bytes: Vec<u8>) -> Self {
        Self(Zeroizing::new(bytes))
    }

    /// Borrow the secret. The call site is the audit point: never log the result.
    pub fn expose(&self) -> &[u8] {
        &self.0
    }

    /// The secret's length (not secret).
    pub fn len(&self) -> usize {
        self.0.len()
    }

    /// Whether the secret is empty.
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl fmt::Debug for SecretBytes {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "SecretBytes(<{} bytes redacted>)", self.0.len())
    }
}

/// A secp256k1 private key used for ECDH. `Debug` is redacted; the scalar is erased on drop.
pub struct PrivateKey(SecretKey);

impl PrivateKey {
    /// Parse a 32-byte private key from hex (the bridge identity's `privateKeyHex`).
    pub fn from_hex(hex_key: &str) -> Result<Self> {
        let bytes = Zeroizing::new(
            hex::decode(hex_key.trim())
                .map_err(|_| Error::Config("encryption private key is not hex".into()))?,
        );
        Self::from_slice(&bytes)
    }

    /// Parse a 32-byte private key.
    pub fn from_slice(bytes: &[u8]) -> Result<Self> {
        SecretKey::from_slice(bytes)
            .map(Self)
            .map_err(|_| Error::Config("not a valid secp256k1 private key".into()))
    }

    /// The private key of a bridge-identity key entry.
    pub fn from_identity_key(key: &IdentityKey) -> Result<Self> {
        Self::from_hex(key.private_key_hex.expose())
    }

    /// The compressed (33-byte) public key, as Platform stores an `ECDSA_SECP256K1` key.
    pub fn public_key(&self) -> [u8; 33] {
        PublicKey::from_secret_key(&Secp256k1::signing_only(), &self.0).serialize()
    }
}

impl Drop for PrivateKey {
    fn drop(&mut self) {
        self.0.non_secure_erase();
    }
}

impl fmt::Debug for PrivateKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("PrivateKey(<redacted>)")
    }
}

/// Parse a compressed or uncompressed secp256k1 public key.
fn public_key(bytes: &[u8]) -> Result<PublicKey> {
    PublicKey::from_slice(bytes)
        .map_err(|_| Error::Config("not a valid secp256k1 public key".into()))
}

/// Encrypt `plaintext` from `sender` to the holder of `recipient_public` (compressed or
/// uncompressed secp256k1 key). A fresh random IV every call.
pub fn encrypt(sender: &PrivateKey, recipient_public: &[u8], plaintext: &[u8]) -> Result<Vec<u8>> {
    let mut iv = [0u8; IV_LEN];
    rand::rngs::OsRng.fill_bytes(&mut iv);
    encrypt_with_iv(sender, recipient_public, plaintext, &iv)
}

/// [`encrypt`] with a caller-chosen IV. Private: an IV must never repeat under one shared key,
/// so only the known-answer tests pin it.
fn encrypt_with_iv(
    sender: &PrivateKey,
    recipient_public: &[u8],
    plaintext: &[u8],
    iv: &[u8; IV_LEN],
) -> Result<Vec<u8>> {
    let shared = Zeroizing::new(platform_encryption::derive_shared_key_ecdh(
        &sender.0,
        &public_key(recipient_public)?,
    ));
    let mut out = iv.to_vec();
    out.extend(platform_encryption::encrypt_aes_256_cbc(
        &shared, iv, plaintext,
    ));
    Ok(out)
}

/// Decrypt `ciphertext` with the recipient's private key and the sender's public key (or, the
/// scheme being symmetric, the sender's private key and the recipient's public key).
///
/// Refuses a ciphertext of the wrong shape before any decryption. A padding failure means the
/// keys are not the ones the bytes were encrypted with (or the bytes are corrupt); a success
/// does **not** prove the keys were right (see the module docs).
pub fn decrypt(
    recipient: &PrivateKey,
    sender_public: &[u8],
    ciphertext: &[u8],
) -> Result<SecretBytes> {
    if !is_valid_ciphertext_length(ciphertext.len()) {
        return Err(Error::Config(format!(
            "{SCHEME} ciphertext of {} bytes: expected a {IV_LEN}-byte IV plus whole \
             {BLOCK_LEN}-byte blocks",
            ciphertext.len()
        )));
    }
    let (iv, blocks) = ciphertext.split_at(IV_LEN);
    let iv: [u8; IV_LEN] = iv.try_into().expect("split at IV_LEN");
    let shared = Zeroizing::new(platform_encryption::derive_shared_key_ecdh(
        &recipient.0,
        &public_key(sender_public)?,
    ));
    platform_encryption::decrypt_aes_256_cbc(&shared, &iv, blocks)
        .map(SecretBytes::new)
        .map_err(|_| {
            Error::Config(
                "decryption failed: the keys are not the ones the bytes were encrypted with".into(),
            )
        })
}

/// The bridge identity's `ENCRYPTION` keys whose private key parses, with their key ids.
/// Every fixture identity carries one (key 4, `ENCRYPTION`/`MEDIUM`).
pub fn encryption_keys(bridge: &BridgeIdentity) -> Vec<(u32, PrivateKey)> {
    bridge
        .identity_keys
        .iter()
        .filter(|k| k.purpose == "ENCRYPTION" && k.key_type == "ECDSA_SECP256K1")
        .filter_map(|k| PrivateKey::from_identity_key(k).ok().map(|p| (k.id, p)))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(scalar: u8) -> PrivateKey {
        PrivateKey::from_slice(&[scalar; 32]).unwrap()
    }

    /// rs-sdk's `DASHPAY_VECTOR_HEX` (`packages/rs-sdk/src/platform/encrypted_for/tests.rs`,
    /// tag v4.2.0-beta.4): the 69-byte compact xpub below, encrypted from the key of scalar
    /// `0xC0..` to the key of scalar `0x0D..` under an IV of `0x5a` bytes, cross-checked there
    /// against an independent ECDH and OpenSSL AES-256-CBC.
    const VECTOR_HEX: &str = "5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a864d1b3807cf80fd27df6cac063a5128\
                              fd6119d0d40491a7788cb4e1975bc47e5070c7919e3d8c21ab26be1a763e7908\
                              b97cd32a5e36309f3bf9535c519b1b32b2f206696ec6d0e244a2e182fceaa750";

    /// `compact_xpub_bytes([0x11,0x22,0x33,0x44], [0xAA;32], pubkey(0x07..))`: fingerprint ‖
    /// chain code ‖ compressed public key.
    fn vector_plaintext() -> Vec<u8> {
        let mut p = vec![0x11, 0x22, 0x33, 0x44];
        p.extend([0xAA; 32]);
        p.extend(key(0x07).public_key());
        p
    }

    #[test]
    fn matches_the_platform_known_answer_vector() {
        let sender = key(0xC0);
        let recipient = key(0x0D);
        let ct = encrypt_with_iv(
            &sender,
            &recipient.public_key(),
            &vector_plaintext(),
            &[0x5a; 16],
        )
        .unwrap();
        assert_eq!(hex::encode(&ct), VECTOR_HEX);
        let pt = decrypt(&recipient, &sender.public_key(), &ct).unwrap();
        assert_eq!(pt.expose(), vector_plaintext().as_slice());
    }

    #[test]
    fn round_trips_and_the_sender_can_read_its_own_message() {
        let sender = key(0x21);
        let recipient = key(0x42);
        let secret = b"0123456789abcdef0123456789abcdef";
        let ct = encrypt(&sender, &recipient.public_key(), secret).unwrap();
        assert_eq!(ct.len(), ciphertext_len(secret.len()));
        assert!(is_valid_ciphertext_length(ct.len()));
        // Recipient: its private key + the sender's public key.
        assert_eq!(
            decrypt(&recipient, &sender.public_key(), &ct)
                .unwrap()
                .expose(),
            secret
        );
        // Sender: its private key + the recipient's public key (ECDH is symmetric).
        assert_eq!(
            decrypt(&sender, &recipient.public_key(), &ct)
                .unwrap()
                .expose(),
            secret
        );
        // A fresh IV each time.
        assert_ne!(
            encrypt(&sender, &recipient.public_key(), secret).unwrap(),
            ct
        );
    }

    #[test]
    fn a_wrong_key_fails_or_yields_a_different_plaintext() {
        let sender = key(0x21);
        let recipient = key(0x42);
        let secret = [0x61u8; 32];
        for i in 0..32u8 {
            let ct = encrypt(&sender, &recipient.public_key(), &secret).unwrap();
            let stranger = key(0x43 + i);
            match decrypt(&stranger, &sender.public_key(), &ct) {
                Err(_) => {}
                Ok(garbage) => assert_ne!(garbage.expose(), secret.as_slice()),
            }
            // The right recipient with the wrong sender key: same.
            match decrypt(&recipient, &key(0x22).public_key(), &ct) {
                Err(_) => {}
                Ok(garbage) => assert_ne!(garbage.expose(), secret.as_slice()),
            }
        }
    }

    #[test]
    fn refuses_bad_lengths_and_bad_keys() {
        let k = key(0x21);
        let pubk = key(0x42).public_key();
        for len in [0, 15, 16, 31, 33, 47] {
            assert!(decrypt(&k, &pubk, &vec![0u8; len]).is_err(), "{len}");
        }
        assert!(!is_valid_ciphertext_length(16));
        assert!(is_valid_ciphertext_length(32));
        assert_eq!(ciphertext_len(0), 32);
        assert_eq!(ciphertext_len(32), 64);
        assert_eq!(ciphertext_len(64), 96);
        assert!(encrypt(&k, &[2u8; 10], b"x").is_err());
        assert!(PrivateKey::from_slice(&[0u8; 32]).is_err());
        assert!(PrivateKey::from_hex("zz").is_err());
    }

    #[test]
    fn debug_never_prints_secret_material() {
        let s = SecretBytes::new(b"hunter2hunter2".to_vec());
        assert_eq!(format!("{s:?}"), "SecretBytes(<14 bytes redacted>)");
        let k = key(0x21);
        assert_eq!(format!("{k:?}"), "PrivateKey(<redacted>)");
    }
}
