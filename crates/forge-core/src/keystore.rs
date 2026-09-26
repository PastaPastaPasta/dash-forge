//! Bridge-format identity JSON parsing and secret redaction.
//!
//! `bridge.thepasta.org` exports a non-custodial identity file (see
//! `docs/testing/e2e-test-plan.md` §1.1-B) containing a mnemonic, an asset-lock key,
//! and the identity's keys with WIF/hex private material. Secret fields are wrapped
//! in [`Secret`], whose `Debug`/`Display`-free surface keeps key material out of
//! logs, journals and panic output (style guide §B: "newtype with redacted Debug").
//!
//! OS-keychain and agent-protocol storage land later; this module only models the
//! import format and enforces redaction.

use std::fmt;
use std::path::Path;

use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::error::{Error, Result};

/// A secret string (mnemonic, WIF, private-key hex) that never reveals itself in
/// `Debug` **or** serialized output. Access the underlying value explicitly via
/// [`Secret::expose`].
///
/// `Deserialize` reads a plain string (so identity files load), but `Serialize` emits a
/// fixed `"[redacted]"` placeholder — so even if a parent struct (`IdentityKey`,
/// `BridgeIdentity`) is ever serialized into a journal or log, the WIF/mnemonic can
/// never leak. Round-tripping a `Secret` through serde is therefore intentionally lossy.
/// The string is wiped from memory when the `Secret` is dropped.
#[derive(Clone)]
pub struct Secret(zeroize::Zeroizing<String>);

/// The placeholder emitted whenever a [`Secret`] is serialized.
const REDACTED: &str = "[redacted]";

impl Secret {
    /// Wrap a plaintext secret.
    pub fn new(value: impl Into<String>) -> Self {
        Self(zeroize::Zeroizing::new(value.into()))
    }

    /// Borrow the underlying secret. The call site is the audit point — never log
    /// or format the returned value.
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Secret(<redacted>)")
    }
}

impl Serialize for Secret {
    /// Emit a redaction placeholder, never the secret material.
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(REDACTED)
    }
}

impl<'de> Deserialize<'de> for Secret {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        Ok(Self::new(String::deserialize(deserializer)?))
    }
}

/// A single identity key entry from the bridge export.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdentityKey {
    /// Key index within the identity (0 = Master).
    pub id: u32,
    /// Human-readable role name (e.g. "Master", "High-Auth").
    pub name: String,
    /// Key algorithm, e.g. `ECDSA_SECP256K1`.
    pub key_type: String,
    /// Key purpose, e.g. `AUTHENTICATION`, `TRANSFER`, `ENCRYPTION`.
    pub purpose: String,
    /// Security level, e.g. `MASTER`, `CRITICAL`, `HIGH`, `MEDIUM`.
    pub security_level: String,
    /// Wallet Import Format private key (secret).
    pub private_key_wif: Secret,
    /// Hex-encoded private key (secret).
    pub private_key_hex: Secret,
    /// Hex-encoded public key (not secret).
    pub public_key_hex: String,
    /// BIP-32 derivation path.
    pub derivation_path: String,
}

/// The asset-lock funding key from a bridge export (`mainnet-bridge` shape: an object,
/// not a bare string). Only the WIF is secret.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetLockKey {
    /// Wallet Import Format asset-lock private key (secret).
    pub wif: Secret,
    /// Hex-encoded public key (not secret).
    pub public_key_hex: String,
    /// BIP-44 derivation path.
    pub derivation_path: String,
}

/// A parsed bridge-format identity export.
///
/// Mirrors the `mainnet-bridge` key-backup shape produced by `tools/mint-identity`
/// (create mode). Unknown top-level fields (`created`, `mode`, `depositAddress`,
/// `txid`) are ignored.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeIdentity {
    /// Target network, e.g. `testnet` or `mainnet`.
    pub network: String,
    /// Base58 identity id.
    pub identity_id: String,
    /// The identity's keys.
    pub identity_keys: Vec<IdentityKey>,
    /// HD mnemonic the keys derive from (secret).
    pub mnemonic: Secret,
    /// Asset-lock funding key.
    pub asset_lock_key: AssetLockKey,
}

/// The prefix of an inline limited key (`dfk1:<network>:<identityId>:<keyId>:<wif>`).
pub const DFK1_PREFIX: &str = "dfk1:";

/// The warning for a `dfk1:` key passed as a command-line argument: other local users can
/// read a process's arguments (`ps`), and shells keep them in history.
pub const INLINE_KEY_ON_ARGV: &str = "an inline dfk1: key on the command line is visible to \
    other local users (ps) and kept in shell history; set DASH_FORGE_KEY instead";

/// Whether a `DASH_FORGE_KEY` / `--identity` value is an inline `dfk1:` key, not a path.
pub fn is_inline_key(source: &Path) -> bool {
    source.to_str().is_some_and(|s| s.starts_with(DFK1_PREFIX))
}

/// How to name a key source in messages: the path of an identity file, or for an inline
/// `dfk1:` key everything but its WIF.
pub fn describe_key_source(source: &Path) -> String {
    match source.to_str().filter(|s| s.starts_with(DFK1_PREFIX)) {
        Some(inline) => {
            let parts: Vec<&str> = inline[DFK1_PREFIX.len()..].splitn(4, ':').collect();
            match parts[..] {
                [network, id, key, _] => format!("dfk1:{network}:{id}:{key}:[redacted]"),
                _ => "dfk1:[redacted]".to_string(),
            }
        }
        None => source.display().to_string(),
    }
}

/// Security levels acceptable for signing a document create/delete, in preference
/// order. Document ops accept HIGH (spike S0.7); CRITICAL also works and is the
/// fallback when a HIGH key is absent. Token-admin ops (mint/freeze/destroy) require
/// CRITICAL — see [`BridgeIdentity::token_admin_key`].
pub const DOC_OP_LEVELS: [&str; 2] = ["HIGH", "CRITICAL"];

impl BridgeIdentity {
    /// Parse a bridge-format identity export from JSON.
    pub fn from_json(raw: &str) -> Result<Self> {
        Ok(serde_json::from_str(raw)?)
    }

    /// Load a signing identity from `path`: a bridge-format identity export on disk, or an
    /// inline limited key `dfk1:<network>:<identityId>:<keyId>:<wif>` (the one-value form CI
    /// secrets use, ux-dx-spec §2.4). Every tool reads `DASH_FORGE_KEY` as a path, so taking
    /// the inline form here gives all of them the CI format at once.
    ///
    /// Never format `path` into a message yourself: use [`describe_key_source`], which keeps
    /// an inline key's WIF out of it.
    pub fn load_from_file(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref();
        if let Some(inline) = path.to_str().filter(|s| s.starts_with(DFK1_PREFIX)) {
            return Self::from_dfk1(inline);
        }
        let raw = std::fs::read_to_string(path)
            .map_err(|e| Error::Io(format!("reading identity file {}: {e}", path.display())))?;
        Self::from_json(&raw)
    }

    /// Parse an inline limited key `dfk1:<network>:<identityId>:<keyId>:<wif>` into an
    /// identity carrying just that key. The key is listed as a HIGH authentication key (what
    /// document writes sign with); the write engine still matches it against the identity's
    /// on-chain keys, so a key that is not one of them, or not usable for writes, is refused
    /// there. No mnemonic, no master key: that is the point of the format.
    pub fn from_dfk1(value: &str) -> Result<Self> {
        let bad = |why: &str| {
            Error::Config(format!(
                "DASH_FORGE_KEY is not a valid dfk1 key ({why}); expected \
                 dfk1:<network>:<identityId>:<keyId>:<wif>"
            ))
        };
        let rest = value
            .trim()
            .strip_prefix(DFK1_PREFIX)
            .ok_or_else(|| bad("no dfk1: prefix"))?;
        let parts: Vec<&str> = rest.splitn(4, ':').collect();
        let [network, identity_id, key_id, wif] = parts[..] else {
            return Err(bad("it needs four fields after dfk1:"));
        };
        if network.is_empty() || identity_id.is_empty() || wif.is_empty() {
            return Err(bad("an empty field"));
        }
        let id: u32 = key_id
            .parse()
            .map_err(|_| bad("the key id is not a number"))?;
        Ok(Self {
            network: network.to_string(),
            identity_id: identity_id.to_string(),
            identity_keys: vec![IdentityKey {
                id,
                name: "dfk1".into(),
                key_type: "ECDSA_SECP256K1".into(),
                purpose: "AUTHENTICATION".into(),
                security_level: "HIGH".into(),
                private_key_wif: Secret::new(wif),
                private_key_hex: Secret::new(""),
                public_key_hex: String::new(),
                derivation_path: String::new(),
            }],
            mnemonic: Secret::new(""),
            asset_lock_key: AssetLockKey {
                wif: Secret::new(""),
                public_key_hex: String::new(),
                derivation_path: String::new(),
            },
        })
    }

    /// Find an authentication key at the given security level, if present.
    pub fn auth_key(&self, security_level: &str) -> Option<&IdentityKey> {
        self.identity_keys
            .iter()
            .find(|k| k.purpose == "AUTHENTICATION" && k.security_level == security_level)
    }

    /// Pick the best AUTHENTICATION key for a document create/delete, preferring
    /// HIGH and falling back to CRITICAL (spike S0.7: document ops accept both).
    pub fn doc_op_key(&self) -> Result<&IdentityKey> {
        DOC_OP_LEVELS
            .iter()
            .find_map(|level| self.auth_key(level))
            .ok_or_else(|| {
                Error::Config("no HIGH or CRITICAL AUTHENTICATION key in identity file".into())
            })
    }

    /// Pick the AUTHENTICATION/CRITICAL key required for token-admin operations
    /// (mint/freeze/destroy). HIGH is rejected at consensus for these (spike S0.7).
    pub fn token_admin_key(&self) -> Result<&IdentityKey> {
        self.auth_key("CRITICAL").ok_or_else(|| {
            Error::Config(
                "no CRITICAL AUTHENTICATION key in identity file (required for token admin)".into(),
            )
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{BridgeIdentity, Secret};

    // All key material below is FAKE — non-functional placeholder strings only.
    const FIXTURE: &str = r#"{
        "network": "testnet",
        "identityId": "FAKEidentity1111111111111111111111111111111",
        "identityKeys": [
            {
                "id": 0,
                "name": "Master",
                "keyType": "ECDSA_SECP256K1",
                "purpose": "AUTHENTICATION",
                "securityLevel": "MASTER",
                "privateKeyWif": "FAKE-wif-master-DO-NOT-USE",
                "privateKeyHex": "deadbeefmaster",
                "publicKeyHex": "02aabbccddmaster",
                "derivationPath": "m/9'/1'/5'/0'/0'"
            },
            {
                "id": 2,
                "name": "High-Auth",
                "keyType": "ECDSA_SECP256K1",
                "purpose": "AUTHENTICATION",
                "securityLevel": "HIGH",
                "privateKeyWif": "FAKE-wif-high-DO-NOT-USE",
                "privateKeyHex": "deadbeefhigh",
                "publicKeyHex": "02aabbccddhigh",
                "derivationPath": "m/9'/1'/5'/0'/2'"
            }
        ],
        "mnemonic": "fake fake fake fake fake fake fake fake fake fake fake fake",
        "assetLockKey": {
            "wif": "FAKE-asset-lock-key-DO-NOT-USE",
            "publicKeyHex": "02aabbccddassetlock",
            "derivationPath": "m/44'/1'/0'/0/0"
        }
    }"#;

    #[test]
    fn parses_bridge_fixture() {
        let id = BridgeIdentity::from_json(FIXTURE).expect("fixture should parse");
        assert_eq!(id.network, "testnet");
        assert_eq!(
            id.identity_id,
            "FAKEidentity1111111111111111111111111111111"
        );
        assert_eq!(id.identity_keys.len(), 2);

        let master = &id.identity_keys[0];
        assert_eq!(master.name, "Master");
        assert_eq!(master.key_type, "ECDSA_SECP256K1");
        assert_eq!(master.purpose, "AUTHENTICATION");
        assert_eq!(master.security_level, "MASTER");
        assert_eq!(master.public_key_hex, "02aabbccddmaster");
        assert_eq!(master.derivation_path, "m/9'/1'/5'/0'/0'");
        // Secret values are still accessible via explicit expose().
        assert_eq!(
            master.private_key_wif.expose(),
            "FAKE-wif-master-DO-NOT-USE"
        );
    }

    #[test]
    fn finds_auth_key_by_security_level() {
        let id = BridgeIdentity::from_json(FIXTURE).unwrap();
        let high = id.auth_key("HIGH").expect("HIGH auth key present");
        assert_eq!(high.name, "High-Auth");
        assert!(id.auth_key("CRITICAL").is_none());
    }

    #[test]
    fn doc_op_key_prefers_high_then_critical() {
        let id = BridgeIdentity::from_json(FIXTURE).unwrap();
        // Fixture has MASTER + HIGH but no CRITICAL: doc ops select HIGH.
        let key = id.doc_op_key().expect("a HIGH or CRITICAL key is present");
        assert_eq!(key.security_level, "HIGH");
    }

    #[test]
    fn token_admin_key_requires_critical() {
        let id = BridgeIdentity::from_json(FIXTURE).unwrap();
        // No CRITICAL key in the fixture — token admin must fail loudly.
        assert!(id.token_admin_key().is_err());
    }

    #[test]
    fn load_from_missing_file_is_io_error() {
        let err = BridgeIdentity::load_from_file("/nonexistent/definitely-not-here.json")
            .expect_err("missing file should error");
        assert!(matches!(err, crate::error::Error::Io(_)));
    }

    #[test]
    fn secret_debug_is_redacted() {
        let secret = Secret::new("super-secret-wif");
        let rendered = format!("{secret:?}");
        assert_eq!(rendered, "Secret(<redacted>)");
        assert!(!rendered.contains("super-secret-wif"));
    }

    #[test]
    fn serializing_identity_never_leaks_secrets() {
        let id = BridgeIdentity::from_json(FIXTURE).unwrap();
        // A future journal/log that serializes the identity must not emit secrets.
        let json = serde_json::to_string(&id).expect("serialize identity");
        assert!(!json.contains("FAKE-wif-master-DO-NOT-USE"));
        assert!(!json.contains("deadbeefmaster"));
        assert!(!json.contains("FAKE-asset-lock-key-DO-NOT-USE"));
        assert!(!json.contains("fake fake fake"));
        assert!(json.contains("[redacted]"));
        // Non-secret fields still serialize normally.
        assert!(json.contains("testnet"));
    }

    #[test]
    fn an_inline_dfk1_key_loads_as_one_high_auth_key() {
        let v = "dfk1:devnet-moutai:FAKEid111:5:cFAKEwifDONOTUSE";
        let id = BridgeIdentity::load_from_file(v).unwrap();
        assert_eq!(id.network, "devnet-moutai");
        assert_eq!(id.identity_id, "FAKEid111");
        let key = id.doc_op_key().unwrap();
        assert_eq!(key.id, 5);
        assert_eq!(key.private_key_wif.expose(), "cFAKEwifDONOTUSE");
        assert!(
            id.token_admin_key().is_err(),
            "a limited key is never CRITICAL"
        );
        assert!(id.mnemonic.expose().is_empty());
        // Nothing prints the WIF.
        assert!(!format!("{id:?}").contains("cFAKEwif"));
        let shown = super::describe_key_source(std::path::Path::new(v));
        assert_eq!(shown, "dfk1:devnet-moutai:FAKEid111:5:[redacted]");
        assert!(super::is_inline_key(std::path::Path::new(v)));
        assert!(!super::is_inline_key(std::path::Path::new("/tmp/id.json")));
    }

    #[test]
    fn malformed_dfk1_keys_are_refused_without_echoing_the_wif() {
        for bad in [
            "dfk1:",
            "dfk1:testnet:id:5",
            "dfk1:testnet:id:five:cWIFsecret",
            "dfk1::id:5:cWIFsecret",
        ] {
            let err = BridgeIdentity::from_dfk1(bad).unwrap_err().to_string();
            assert!(err.contains("dfk1:<network>"), "{err}");
            assert!(!err.contains("cWIFsecret"), "{err}");
        }
    }

    #[test]
    fn secret_serializes_to_redaction_placeholder() {
        let secret = Secret::new("super-secret-wif");
        let json = serde_json::to_string(&secret).unwrap();
        assert_eq!(json, "\"[redacted]\"");
        assert!(!json.contains("super-secret-wif"));
    }

    #[test]
    fn identity_debug_never_leaks_secrets() {
        let id = BridgeIdentity::from_json(FIXTURE).unwrap();
        let dumped = format!("{id:?}");
        // No secret material should appear anywhere in the Debug rendering.
        assert!(!dumped.contains("FAKE-wif-master-DO-NOT-USE"));
        assert!(!dumped.contains("deadbeefmaster"));
        assert!(!dumped.contains("FAKE-asset-lock-key-DO-NOT-USE"));
        assert!(!dumped.contains("fake fake fake"));
        assert!(dumped.contains("<redacted>"));
        // Non-secret fields are still visible for diagnostics.
        assert!(dumped.contains("testnet"));
        assert!(dumped.contains("02aabbccddmaster"));
    }
}
