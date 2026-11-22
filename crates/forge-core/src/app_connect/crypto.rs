//! App Connect v2 response encryption (`crypto.ts`):
//!
//! ```text
//! key  = HKDF-SHA256(ECDH-x(appEph, walletEph), salt "dash:key-exchange:v1", info "app-connect:v2")
//! aad  = "dash:app-connect:v2" ‖ hash160(appEphPub) ‖ $ownerId
//! body = nonce(12) ‖ AES-256-GCM(key, nonce, aad, slot₀ ‖ … ‖ slotₙ₋₁) ‖ tag(16)
//! ```
//!
//! Each slot is a 32-byte private key. The AAD ties the ciphertext to the request and to the
//! identity that publishes it, so a response copied under another identity fails to open.

use aes_gcm::aead::{Aead as _, Payload};
use aes_gcm::{Aes256Gcm, KeyInit as _, Nonce};
use hkdf::Hkdf;
use secp256k1::{PublicKey, SecretKey};
use sha2::Sha256;
use zeroize::Zeroizing;

use super::{hash160, public_of, Id, SecretBytes};

/// The HKDF `info` of the session key.
pub const HKDF_INFO: &[u8] = b"app-connect:v2";
/// The HKDF salt every Dash key exchange uses.
const HKDF_SALT: &[u8] = b"dash:key-exchange:v1";
/// The AAD's prefix.
pub const AAD_PREFIX: &[u8] = b"dash:app-connect:v2";
/// The nonce at the front of a payload.
pub const NONCE_BYTES: usize = 12;
/// The nonce and the tag.
pub const ENVELOPE_BYTES: usize = NONCE_BYTES + 16;
/// One granted private key.
pub const SLOT_BYTES: usize = 32;
/// The `loginKeyResponse` schema's limit (a 572-byte payload).
pub const MAX_SLOTS: usize = 17;

/// Why a payload does not open.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum PayloadError {
    /// Its length is not `28 + 32n` with `1 <= n <= 17`.
    #[error("the payload is not 28 + 32n bytes with 1 <= n <= 17")]
    Framing,
    /// Wrong request, wrong owner (a copied response), tampered, or not a wallet key.
    #[error("the payload does not decrypt for this request and owner")]
    Decrypt,
}

/// `"dash:app-connect:v2" ‖ hash160(appEphPub) ‖ ownerId`.
pub fn aad(app_ephemeral_pub_key: &[u8; 33], owner_id: &Id) -> Vec<u8> {
    [
        AAD_PREFIX,
        &hash160(app_ephemeral_pub_key),
        owner_id.as_slice(),
    ]
    .concat()
}

/// The number of key slots a payload of this length holds, or `None` when the framing is wrong.
pub fn slot_count(payload_len: usize) -> Option<usize> {
    let body = payload_len.checked_sub(ENVELOPE_BYTES)?;
    if body == 0 || body % SLOT_BYTES != 0 {
        return None;
    }
    Some(body / SLOT_BYTES).filter(|n| *n <= MAX_SLOTS)
}

/// ECDH x-coordinate, then HKDF-SHA256 with the App Connect info. Symmetric: the wallet calls it
/// with its private key and the app's public key.
pub fn session_key(secret: &SecretKey, public: &PublicKey) -> Zeroizing<[u8; 32]> {
    let point = Zeroizing::new(secp256k1::ecdh::shared_secret_point(public, secret));
    let hk = Hkdf::<Sha256>::new(Some(HKDF_SALT), &point[..32]);
    let mut key = Zeroizing::new([0u8; 32]);
    hk.expand(HKDF_INFO, key.as_mut())
        .expect("32 bytes is a valid HKDF-SHA256 length");
    key
}

/// App side: checks the framing and the tag, and returns the slots in payload order.
pub fn open(
    app_ephemeral_secret: &SecretKey,
    owner_id: &Id,
    wallet_ephemeral_pub_key: &[u8],
    encrypted_payload: &[u8],
) -> Result<Vec<SecretBytes>, PayloadError> {
    let slots = slot_count(encrypted_payload.len()).ok_or(PayloadError::Framing)?;
    let wallet =
        PublicKey::from_slice(wallet_ephemeral_pub_key).map_err(|_| PayloadError::Decrypt)?;
    let app_pub = public_of(app_ephemeral_secret).serialize();
    let key = session_key(app_ephemeral_secret, &wallet);
    let (nonce, sealed) = encrypted_payload.split_at(NONCE_BYTES);
    let plain = Zeroizing::new(
        Aes256Gcm::new_from_slice(key.as_ref())
            .expect("32-byte key")
            .decrypt(
                Nonce::from_slice(nonce),
                Payload {
                    msg: sealed,
                    aad: &aad(&app_pub, owner_id),
                },
            )
            .map_err(|_| PayloadError::Decrypt)?,
    );
    debug_assert_eq!(plain.len(), slots * SLOT_BYTES);
    Ok(plain
        .as_chunks::<SLOT_BYTES>()
        .0
        .iter()
        .map(|slot| SecretBytes::new(*slot))
        .collect())
}

/// Wallet side, for the vectors and tests: encrypts `slots` to the app's request with a given
/// wallet ephemeral key and nonce. Returns the wallet's ephemeral public key and the payload.
#[cfg(any(test, feature = "vectors"))]
pub fn seal_with(
    app_ephemeral_pub_key: &[u8; 33],
    owner_id: &Id,
    slots: &[[u8; 32]],
    wallet_ephemeral_secret: &SecretKey,
    nonce: [u8; NONCE_BYTES],
) -> crate::Result<([u8; 33], Vec<u8>)> {
    if slots.is_empty() || slots.len() > MAX_SLOTS {
        return Err(crate::Error::InvalidInput(format!(
            "expected 1 to {MAX_SLOTS} slots, got {}",
            slots.len()
        )));
    }
    let app = PublicKey::from_slice(app_ephemeral_pub_key)
        .map_err(|_| crate::Error::InvalidInput("not an app ephemeral key".into()))?;
    let wallet_pub = public_of(wallet_ephemeral_secret).serialize();
    let key = session_key(wallet_ephemeral_secret, &app);
    let plain = Zeroizing::new(slots.concat());
    let sealed = Aes256Gcm::new_from_slice(key.as_ref())
        .expect("32-byte key")
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: &plain,
                aad: &aad(app_ephemeral_pub_key, owner_id),
            },
        )
        .map_err(|_| crate::Error::InvalidInput("sealing failed".into()))?;
    Ok((wallet_pub, [nonce.as_slice(), &sealed].concat()))
}

#[cfg(test)]
mod tests {
    use super::super::test_vectors::{hex, nonce, seed, vectors, yappr_request};
    use super::*;

    fn secret(label: &str) -> SecretKey {
        SecretKey::from_slice(&seed(label)).unwrap()
    }

    fn slots() -> [[u8; 32]; 3] {
        [
            seed("slot group key"),
            seed("slot dashpay profile key"),
            seed("slot encryption key"),
        ]
    }

    #[test]
    fn reproduces_the_vector_response_byte_for_byte() {
        let v = vectors();
        let r = &v["response"];
        let app_pub = yappr_request().app_ephemeral_pub_key;
        let owner = seed("owner");
        let key = session_key(
            &secret("wallet ephemeral"),
            &PublicKey::from_slice(&app_pub).unwrap(),
        );
        assert_eq!(key.to_vec(), hex(&r["sessionKey"]));
        assert_eq!(aad(&app_pub, &owner), hex(&r["aad"]));
        assert_eq!(slots().concat(), hex(&r["plaintext"]));

        let (wallet_pub, payload) = seal_with(
            &app_pub,
            &owner,
            &slots(),
            &secret("wallet ephemeral"),
            nonce(),
        )
        .unwrap();
        assert_eq!(wallet_pub.to_vec(), hex(&r["walletEphemeralPubKey"]));
        assert_eq!(payload, hex(&r["encryptedPayload"]));

        let pubs: Vec<Vec<u8>> = slots()
            .iter()
            .map(|s| super::super::public_key_of(s).unwrap().to_vec())
            .collect();
        let expected: Vec<Vec<u8>> = r["slotPublicKeys"]
            .as_array()
            .unwrap()
            .iter()
            .map(hex)
            .collect();
        assert_eq!(pubs, expected);
        let hashes: Vec<Vec<u8>> = pubs.iter().map(|p| hash160(p).to_vec()).collect();
        let expected: Vec<Vec<u8>> = r["slotPublicKeyHashes"]
            .as_array()
            .unwrap()
            .iter()
            .map(hex)
            .collect();
        assert_eq!(hashes, expected);
    }

    #[test]
    fn opens_the_vector_payload_on_the_app_side() {
        let v = vectors();
        let opened = open(
            &secret("app ephemeral"),
            &seed("owner"),
            &hex(&v["response"]["walletEphemeralPubKey"]),
            &hex(&v["response"]["encryptedPayload"]),
        )
        .unwrap();
        let opened: Vec<[u8; 32]> = opened.iter().map(|s| *s.expose()).collect();
        assert_eq!(opened, slots());
    }

    fn sealed(owner: &Id) -> ([u8; 33], Vec<u8>) {
        let app_pub = yappr_request().app_ephemeral_pub_key;
        seal_with(
            &app_pub,
            owner,
            &slots()[..2],
            &secret("wallet ephemeral"),
            nonce(),
        )
        .unwrap()
    }

    #[test]
    fn opens_what_it_seals_and_refuses_another_owner_or_request() {
        let (wallet, payload) = sealed(&seed("owner"));
        assert_eq!(payload.len(), 28 + 64);
        assert_eq!(
            open(&secret("app ephemeral"), &seed("owner"), &wallet, &payload)
                .unwrap()
                .len(),
            2
        );
        assert_eq!(
            open(
                &secret("app ephemeral"),
                &seed("someone else"),
                &wallet,
                &payload
            ),
            Err(PayloadError::Decrypt)
        );
        assert_eq!(
            open(
                &secret("another request"),
                &seed("owner"),
                &wallet,
                &payload
            ),
            Err(PayloadError::Decrypt)
        );
    }

    #[test]
    fn refuses_a_tampered_tag_or_ciphertext_and_a_bad_wallet_key() {
        let (wallet, payload) = sealed(&seed("owner"));
        for i in [12, payload.len() - 1] {
            let mut p = payload.clone();
            p[i] ^= 1;
            assert_eq!(
                open(&secret("app ephemeral"), &seed("owner"), &wallet, &p),
                Err(PayloadError::Decrypt)
            );
        }
        let mut not_a_point = [0xffu8; 33];
        not_a_point[0] = 2;
        assert_eq!(
            open(
                &secret("app ephemeral"),
                &seed("owner"),
                &not_a_point,
                &payload
            ),
            Err(PayloadError::Decrypt)
        );
    }

    #[test]
    fn checks_framing_before_decrypting() {
        let wallet = public_of(&secret("wallet ephemeral")).serialize();
        for len in [0, 28, 59, 61, 28 + 32 * 18] {
            assert_eq!(slot_count(len), None, "length {len}");
            assert_eq!(
                open(
                    &secret("app ephemeral"),
                    &seed("owner"),
                    &wallet,
                    &vec![0; len]
                ),
                Err(PayloadError::Framing)
            );
        }
        assert_eq!(slot_count(60), Some(1));
        assert_eq!(slot_count(28 + 32 * 17), Some(17));
    }

    #[test]
    fn refuses_to_seal_no_slots() {
        let app_pub = yappr_request().app_ephemeral_pub_key;
        assert!(seal_with(&app_pub, &seed("owner"), &[], &secret("w"), nonce()).is_err());
    }

    #[test]
    fn ecdh_is_symmetric() {
        let a = secret("a");
        let b = secret("b");
        let pa = public_of(&a);
        let pb = public_of(&b);
        assert_eq!(session_key(&a, &pb), session_key(&b, &pa));
    }
}
