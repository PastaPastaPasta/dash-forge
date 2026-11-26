//! App Connect v2, the app side: ask a Dash wallet for a key and read its answer from Platform
//! (platform-auth `docs/APP_CONNECT_PROFILE.md`; `docs/design/wallet-primary.md` item 7).
//!
//! A port of the TypeScript module forge-web vendors (`forge-web/lib/vendor/platform-auth/
//! app-connect`, platform-auth commit `a627708d`), checked against its `vectors.json` byte for
//! byte, plus Forge's own request and rules from `forge-web/lib/auth/app-connect-v2.ts`:
//!
//! 1. [`forge::LoginRequest::new`] draws an ephemeral key and builds Forge's request: one
//!    AUTHENTICATION / HIGH key bound to the dash-forge contract group, with a budget and an
//!    expiry ([`request`] has the codec, [`request::build_uri`] the `dashpay://connect` link a QR code
//!    shows).
//! 2. The wallet registers the key on the user's identity and publishes a `loginKeyResponse`
//!    in the App Connect system contract ([`APP_CONNECT_CONTRACT_ID`]), keyed by
//!    `hash160(appEphemeralPub)` and its `$ownerId`.
//! 3. [`forge::await_forge_grant`] pages through every answer ([`poll`]), opens each with the
//!    ephemeral key ([`crypto`]), checks it against the chain ([`verify`]) and then against
//!    Forge's rules, and yields a [`forge::WalletGrant`]: a limited key `dg` stores as `dfk1:`.
//!
//! Chain reads go through [`verify::IdentityPort`] and [`poll::ResponsePort`], so everything
//! here runs without a network in tests; [`crate::platform::PlatformClient`] implements both.
//!
//! Who answered is not proven: anyone who sees the QR code can answer from their own identity.
//! Two answers are refused, and without an identity hint the caller must ask "Continue as …?".

pub mod crypto;
pub mod forge;
pub mod poll;
pub mod request;
pub mod verify;

use std::fmt;

use ripemd::Ripemd160;
use sha2::{Digest as _, Sha256};
use zeroize::Zeroizing;

/// The App Connect system contract (protocol 14).
pub const APP_CONNECT_CONTRACT_ID: &str = "H8F9mP1BM55TE1ShsxPZHzhyinaMdY9bMmP85mkDhcJJ";
/// The document type a wallet answers with.
pub const RESPONSE_DOCUMENT_TYPE: &str = "loginKeyResponse";

/// A 32-byte Platform id (identity, contract or group).
pub type Id = [u8; 32];

/// Platform's `Purpose` numbers.
pub mod purpose {
    /// `AUTHENTICATION`.
    pub const AUTHENTICATION: u8 = 0;
    /// `ENCRYPTION`.
    pub const ENCRYPTION: u8 = 1;
    /// `DECRYPTION`.
    pub const DECRYPTION: u8 = 2;
    /// `TRANSFER`.
    pub const TRANSFER: u8 = 3;
}

/// Platform's `SecurityLevel` numbers (lower is more privileged).
pub mod level {
    /// `MASTER`.
    pub const MASTER: u8 = 0;
    /// `CRITICAL`.
    pub const CRITICAL: u8 = 1;
    /// `HIGH`.
    pub const HIGH: u8 = 2;
    /// `MEDIUM`.
    pub const MEDIUM: u8 = 3;
}

/// Platform's `KeyType` numbers.
pub mod key_type {
    /// `ECDSA_SECP256K1`: the data is the 33-byte compressed point.
    pub const ECDSA_SECP256K1: u8 = 0;
    /// `ECDSA_HASH160`: the data is `hash160` of the compressed point.
    pub const ECDSA_HASH160: u8 = 2;
}

/// An identity key's `contractBounds`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeyBounds {
    /// One contract.
    SingleContract {
        /// The contract.
        contract_id: Id,
    },
    /// One document type of one contract.
    DocumentType {
        /// The contract.
        contract_id: Id,
        /// The document type.
        document_type_name: String,
    },
    /// Every member of a contract group.
    ContractGroup {
        /// The group.
        group_id: Id,
    },
}

/// An identity public key as the verifier needs it (V0 or V1).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChainKey {
    /// The key id.
    pub id: u32,
    /// A [`key_type`] number.
    pub key_type: u8,
    /// A [`purpose`] number.
    pub purpose: u8,
    /// A [`level`] number.
    pub security_level: u8,
    /// The 33-byte point (`ECDSA_SECP256K1`) or its 20-byte hash160 (`ECDSA_HASH160`).
    pub data: Vec<u8>,
    /// Whether the key is disabled.
    pub disabled: bool,
    /// What the key is bound to; `None` for an unbound key.
    pub bounds: Option<KeyBounds>,
    /// V1 limit: the lifetime credit budget.
    pub total_budget: Option<u64>,
    /// V1 limit: the block time (ms) from which the key can no longer sign.
    pub expires_at_ms: Option<u64>,
}

/// A 32-byte private key, wiped on drop and never printed.
#[derive(Clone, PartialEq, Eq)]
pub struct SecretBytes(Zeroizing<[u8; 32]>);

impl SecretBytes {
    /// Wrap `bytes`.
    pub fn new(bytes: [u8; 32]) -> Self {
        Self(Zeroizing::new(bytes))
    }

    /// The key bytes.
    pub fn expose(&self) -> &[u8; 32] {
        &self.0
    }
}

impl fmt::Debug for SecretBytes {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("SecretBytes(<redacted>)")
    }
}

/// `RIPEMD160(SHA256(data))`.
pub fn hash160(data: &[u8]) -> [u8; 20] {
    Ripemd160::digest(Sha256::digest(data)).into()
}

/// Base58 (Bitcoin alphabet).
pub fn encode_base58(bytes: &[u8]) -> String {
    bs58::encode(bytes).into_string()
}

/// A base58 id, or `None` when it is not base58 or not 32 bytes.
pub fn decode_id(text: &str) -> Option<Id> {
    bs58::decode(text).into_vec().ok()?.try_into().ok()
}

/// The public key of `secret`.
fn public_of(secret: &secp256k1::SecretKey) -> secp256k1::PublicKey {
    secp256k1::PublicKey::from_secret_key(secret)
}

/// `f` over `secret` as a secp256k1 key, wiped afterwards (`SecretKey` does not wipe itself);
/// `None` when the bytes are not a private key.
fn with_secret_key<T>(secret: &[u8; 32], f: impl FnOnce(&secp256k1::SecretKey) -> T) -> Option<T> {
    let mut key = secp256k1::SecretKey::from_secret_bytes(*secret).ok()?;
    let out = f(&key);
    key.non_secure_erase();
    Some(out)
}

/// The compressed public key of a 32-byte private key, or `None` when it is not one.
pub(crate) fn public_key_of(secret: &[u8; 32]) -> Option<[u8; 33]> {
    with_secret_key(secret, |key| public_of(key).serialize())
}

/// A fresh random secp256k1 private key from the OS RNG.
fn random_secret() -> crate::Result<SecretBytes> {
    let mut bytes = Zeroizing::new([0u8; 32]);
    loop {
        getrandom::getrandom(bytes.as_mut())
            .map_err(|e| crate::Error::Config(format!("no randomness: {e}")))?;
        if secp256k1::SecretKey::from_secret_bytes(*bytes).is_ok() {
            return Ok(SecretBytes(bytes));
        }
    }
}

#[cfg(test)]
pub(crate) mod test_vectors {
    //! The published interop vectors and the fixtures they are built from
    //! (`test-helpers.ts`). `vectors.json` is read from the vendored copy in forge-web, so a
    //! re-vendor that changes it fails here too.

    use serde_json::Value;
    use sha2::{Digest as _, Sha256};

    use super::request::{AuthBinding, BindingKind, EncBinding, Mode, Request};
    use super::{decode_id, level, public_key_of, purpose, Id};

    pub const VECTORS: &str =
        include_str!("../../../../forge-web/lib/vendor/platform-auth/app-connect/vectors.json");

    pub fn vectors() -> Value {
        serde_json::from_str(VECTORS).unwrap()
    }

    pub fn hex(v: &Value) -> Vec<u8> {
        hex::decode(v.as_str().unwrap()).unwrap()
    }

    pub fn hex_list(v: &Value) -> Vec<Vec<u8>> {
        v.as_array().unwrap().iter().map(hex).collect()
    }

    /// The three granted keys of the vectors: group, DashPay profile, encryption.
    pub fn slot_seeds() -> [[u8; 32]; 3] {
        [
            "slot group key",
            "slot dashpay profile key",
            "slot encryption key",
        ]
        .map(seed)
    }

    pub fn secret(label: &str) -> secp256k1::SecretKey {
        secp256k1::SecretKey::from_secret_bytes(seed(label)).unwrap()
    }

    /// `sha256("dash app-connect v2 vector/" + label)`.
    pub fn seed(label: &str) -> [u8; 32] {
        Sha256::digest(format!("dash app-connect v2 vector/{label}")).into()
    }

    pub const DASHPAY_CONTRACT_ID: &str = "Bwr4WHCPz5rFVAD87RqTs3izo4zpzwsEdKPWUT1NS1C7";
    pub const VECTOR_CREATED_AT: u64 = 1_791_676_800_000;
    pub const NINETY_DAYS_MS: u64 = 90 * 24 * 60 * 60 * 1000;

    pub fn connection_id() -> [u8; 16] {
        seed("connection id")[..16].try_into().unwrap()
    }

    pub fn nonce() -> [u8; 12] {
        seed("nonce")[..12].try_into().unwrap()
    }

    pub fn dashpay() -> Id {
        decode_id(DASHPAY_CONTRACT_ID).unwrap()
    }

    /// Yappr's request: group key CRITICAL 0.5 DASH / 90 d, DashPay profile HIGH 1e9 / 90 d,
    /// encryption on the anchor.
    pub fn yappr_request() -> Request {
        let expires_at_ms = Some(VECTOR_CREATED_AT + NINETY_DAYS_MS);
        Request {
            app_ephemeral_pub_key: public_key_of(&seed("app ephemeral")).unwrap(),
            app_id: seed("app id"),
            label: "Yappr".into(),
            auth_bindings: vec![
                AuthBinding {
                    kind: BindingKind::ContractGroup,
                    id: seed("group id"),
                    document_type_name: None,
                    security_level: level::CRITICAL,
                    total_budget: Some(50_000_000_000),
                    expires_at_ms,
                },
                AuthBinding {
                    kind: BindingKind::DocumentType,
                    id: dashpay(),
                    document_type_name: Some("profile".into()),
                    security_level: level::HIGH,
                    total_budget: Some(1_000_000_000),
                    expires_at_ms,
                },
            ],
            enc_bindings: vec![EncBinding {
                contract_id: seed("app id"),
                purpose: purpose::ENCRYPTION,
            }],
            created_at_ms: VECTOR_CREATED_AT,
            identity_hint: None,
            connection_id: Some(connection_id()),
            mode: None,
        }
    }

    /// A renewal for a known identity: IDENTITY_HINT and MODE = renew, group binding only.
    pub fn renew_request() -> Request {
        let mut r = yappr_request();
        r.auth_bindings.truncate(1);
        r.enc_bindings.clear();
        r.identity_hint = Some(seed("owner"));
        r.mode = Some(Mode::Renew);
        r
    }

    #[test]
    fn the_fixture_inputs_are_the_seeds() {
        let v = vectors();
        let inputs = &v["inputs"];
        assert_eq!(
            hex(&inputs["appEphemeralPrivateKey"]),
            seed("app ephemeral")
        );
        assert_eq!(
            hex(&inputs["walletEphemeralPrivateKey"]),
            seed("wallet ephemeral")
        );
        assert_eq!(hex(&inputs["nonce"]), nonce());
        assert_eq!(hex(&inputs["connectionId"]), connection_id());
        for (field, label) in [
            ("appId", "app id"),
            ("groupId", "group id"),
            ("ownerId", "owner"),
        ] {
            assert_eq!(
                decode_id(inputs[field].as_str().unwrap()).unwrap(),
                seed(label),
                "{field}"
            );
        }
        assert_eq!(inputs["createdAt"], VECTOR_CREATED_AT);
        assert_eq!(inputs["expiresAt"], VECTOR_CREATED_AT + NINETY_DAYS_MS);
        assert_eq!(
            hex_list(&inputs["slotPrivateKeys"]),
            slot_seeds().map(|s| s.to_vec())
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base58_matches_known_bitcoin_alphabet_vectors() {
        let cases = [
            ("", ""),
            ("00", "1"),
            ("0000", "11"),
            ("61", "2g"),
            ("00000001", "1112"),
            // "Hello World!"
            ("48656c6c6f20576f726c6421", "2NEpo7TZRRrLZSi2U"),
            (
                "00eb15231dfceb60925886b67d065299925915aeb172c06647",
                "1NS17iag9jJgTHD1VXjvLCEnZuQ3rJDE9L",
            ),
        ];
        for (h, b) in cases {
            assert_eq!(encode_base58(&hex::decode(h).unwrap()), b);
            assert_eq!(hex::encode(bs58::decode(b).into_vec().unwrap()), h);
        }
    }

    #[test]
    fn ids_must_be_32_bytes_of_base58() {
        assert!(decode_id("Bwr4WHCPz5rFVAD87RqTs3izo4zpzwsEdKPWUT1NS1C7").is_some());
        assert!(decode_id(&encode_base58(&[1; 31])).is_none());
        for bad in ["0", "O", "I", "l", "ab c"] {
            assert!(decode_id(bad).is_none());
        }
        for first in [0u8, 1, 0x80, 0xff] {
            let mut id = [7u8; 32];
            id[0] = first;
            assert_eq!(decode_id(&encode_base58(&id)), Some(id));
        }
    }

    #[test]
    fn hash160_of_nothing_is_the_well_known_value() {
        assert_eq!(
            hex::encode(hash160(&[])),
            "b472a266d0bd89c13706a4132ccfb16f7c3b9fcb"
        );
    }

    #[test]
    fn secrets_never_print() {
        assert_eq!(
            format!("{:?}", SecretBytes::new([9; 32])),
            "SecretBytes(<redacted>)"
        );
    }
}
