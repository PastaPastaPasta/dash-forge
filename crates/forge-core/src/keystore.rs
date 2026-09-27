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
/// fallback when a HIGH key is absent.
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

    /// The `ENCRYPTION` entry a `dg auth keys add --encryption` run wrote but whose broadcast
    /// has not landed: the highest-id `ECDSA_SECP256K1` `ENCRYPTION` entry with a private key
    /// whose id is not among `on_chain_ids` and whose public key is not among
    /// `on_chain_public_keys` (hex). A re-run reuses it instead of drawing another key.
    pub fn pending_encryption_key(
        &self,
        on_chain_ids: &[u32],
        on_chain_public_keys: &[String],
    ) -> Option<&IdentityKey> {
        self.identity_keys
            .iter()
            .filter(|k| {
                k.purpose == "ENCRYPTION"
                    && k.key_type == "ECDSA_SECP256K1"
                    && !(k.private_key_hex.expose().trim().is_empty()
                        && k.private_key_wif.expose().trim().is_empty())
                    && !on_chain_ids.contains(&k.id)
                    && !on_chain_public_keys
                        .iter()
                        .any(|p| p.eq_ignore_ascii_case(k.public_key_hex.trim()))
            })
            .max_by_key(|k| k.id)
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
}

/// Write `entry` (with its private key) into the identity file at `path`, keeping every other
/// field of the file as it is.
///
/// The entry is appended to `identityKeys`. An entry that already has `entry.id` and the same
/// public key is kept, its private key filled in when it has none (a keys-only file); an entry
/// with `entry.id` and another public key is refused: a key is never overwritten or removed.
///
/// A symlink is followed, so the file it points to is the one updated. The write holds an
/// advisory lock on `<file>.lock` (two concurrent runs cannot drop each other's key) and is
/// atomic: a new file created 0600 next to the old one, synced, renamed over it, and the
/// directory synced. The directory's own mode is left alone. An inline `dfk1:` key is refused:
/// there is no file to store the key in.
pub fn store_identity_key(path: &Path, entry: &IdentityKey) -> Result<()> {
    if is_inline_key(path) {
        return Err(Error::Config(
            "a dfk1: key has no identity file to store a new key in; use the identity file \
             (--identity <file>)"
                .into(),
        ));
    }
    let path = std::fs::canonicalize(path)
        .map_err(|e| Error::Io(format!("resolving identity file {}: {e}", path.display())))?;
    let _lock = lock_beside(&path)?;
    let raw = zeroize::Zeroizing::new(
        std::fs::read_to_string(&path)
            .map_err(|e| Error::Io(format!("reading identity file {}: {e}", path.display())))?,
    );
    let mut doc: serde_json::Value = serde_json::from_str(&raw)?;
    let result = add_key_entry(&mut doc, entry, &path).and_then(|changed| {
        if !changed {
            return Ok(());
        }
        let mut out = zeroize::Zeroizing::new(serde_json::to_vec_pretty(&doc)?);
        out.push(b'\n');
        write_atomic_private(&path, &out)
    });
    zeroize_json_strings(&mut doc);
    result
}

/// Add `entry` to the parsed identity file `doc` (see [`store_identity_key`]); `false` when the
/// file already holds it with its private key.
fn add_key_entry(doc: &mut serde_json::Value, entry: &IdentityKey, path: &Path) -> Result<bool> {
    use serde_json::Value;
    let keys = doc
        .get_mut("identityKeys")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| {
            Error::Config(format!(
                "identity file {} has no identityKeys list",
                path.display()
            ))
        })?;
    let text = |k: &Value, field: &str| {
        k.get(field)
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default()
            .to_string()
    };
    let wif = Value::String(entry.private_key_wif.expose().to_string());
    let hex_key = Value::String(entry.private_key_hex.expose().to_string());
    if let Some(existing) = keys
        .iter_mut()
        .find(|k| k.get("id").and_then(Value::as_u64) == Some(u64::from(entry.id)))
    {
        if !text(existing, "publicKeyHex").eq_ignore_ascii_case(&entry.public_key_hex) {
            return Err(Error::Config(format!(
                "identity file {} already has a different key {}; not overwriting it",
                path.display(),
                entry.id
            )));
        }
        if !text(existing, "privateKeyHex").is_empty()
            || !text(existing, "privateKeyWif").is_empty()
        {
            return Ok(false);
        }
        existing["privateKeyWif"] = wif;
        existing["privateKeyHex"] = hex_key;
        return Ok(true);
    }
    keys.push(serde_json::json!({
        "id": entry.id,
        "name": entry.name,
        "keyType": entry.key_type,
        "purpose": entry.purpose,
        "securityLevel": entry.security_level,
        "privateKeyWif": wif,
        "privateKeyHex": hex_key,
        "publicKeyHex": entry.public_key_hex,
        "derivationPath": entry.derivation_path,
    }));
    Ok(true)
}

/// Wipe every string of a parsed identity file (its mnemonic and private keys) before the
/// memory is freed.
fn zeroize_json_strings(value: &mut serde_json::Value) {
    use zeroize::Zeroize as _;
    match value {
        serde_json::Value::String(s) => s.zeroize(),
        serde_json::Value::Array(items) => items.iter_mut().for_each(zeroize_json_strings),
        serde_json::Value::Object(map) => map.values_mut().for_each(zeroize_json_strings),
        _ => {}
    }
}

/// An exclusive advisory lock on `<path>.lock`, held until the returned file is dropped.
fn lock_beside(path: &Path) -> Result<std::fs::File> {
    let mut lock_path = path.as_os_str().to_owned();
    lock_path.push(".lock");
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    let file = options
        .open(&lock_path)
        .map_err(|e| Error::Io(format!("locking identity file {}: {e}", path.display())))?;
    file.lock()
        .map_err(|e| Error::Io(format!("locking identity file {}: {e}", path.display())))?;
    Ok(file)
}

/// Replace `path` (already resolved, no symlink) with `bytes` atomically, owner-only (see
/// [`store_identity_key`]).
fn write_atomic_private(path: &Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write as _;
    let io = |what: &str, e: std::io::Error| Error::Io(format!("{what} {}: {e}", path.display()));
    let dir = path
        .parent()
        .ok_or_else(|| Error::Config(format!("{} is not a file path", path.display())))?;
    let name = path
        .file_name()
        .ok_or_else(|| Error::Config(format!("{} is not a file path", path.display())))?;
    let mut suffix = [0u8; 6];
    getrandom::getrandom(&mut suffix).map_err(|e| Error::Io(format!("random temp name: {e}")))?;
    let tmp = dir.join(format!(
        ".{}.{}-{}.tmp",
        name.to_string_lossy(),
        std::process::id(),
        hex::encode(suffix)
    ));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    let result = (|| {
        let mut f = options
            .open(&tmp)
            .map_err(|e| io("creating a temp file for", e))?;
        f.write_all(bytes).map_err(|e| io("writing", e))?;
        f.sync_all().map_err(|e| io("syncing", e))?;
        std::fs::rename(&tmp, path).map_err(|e| io("replacing", e))
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result?;
    // Make the rename itself durable before the caller broadcasts.
    if let Ok(d) = std::fs::File::open(dir) {
        let _ = d.sync_all();
    }
    Ok(())
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
            id.auth_key("CRITICAL").is_none(),
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

    fn new_entry(id: u32, public: &str) -> super::IdentityKey {
        super::IdentityKey {
            id,
            name: "Encryption".into(),
            key_type: "ECDSA_SECP256K1".into(),
            purpose: "ENCRYPTION".into(),
            security_level: "MEDIUM".into(),
            private_key_wif: Secret::new("FAKE-new-wif"),
            private_key_hex: Secret::new("FAKE-new-hex"),
            public_key_hex: public.into(),
            derivation_path: format!("m/9'/1'/5'/0'/0'/0'/{id}'"),
        }
    }

    #[test]
    fn storing_a_key_appends_it_and_keeps_every_other_field() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("id.identity.json");
        // Extra top-level fields the struct does not model must survive.
        let mut raw: serde_json::Value = serde_json::from_str(FIXTURE).unwrap();
        raw["created"] = "2026-09-25".into();
        raw["txid"] = "abc".into();
        std::fs::write(&path, serde_json::to_string(&raw).unwrap()).unwrap();
        #[cfg(unix)]
        let dir_mode_before = {
            use std::os::unix::fs::PermissionsExt as _;
            std::fs::metadata(dir.path()).unwrap().permissions().mode() & 0o777
        };

        super::store_identity_key(&path, &new_entry(4, "02new")).unwrap();
        let after: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(after["created"], "2026-09-25");
        assert_eq!(after["txid"], "abc");
        assert_eq!(after["mnemonic"], raw["mnemonic"]);
        let keys = after["identityKeys"].as_array().unwrap();
        assert_eq!(keys.len(), 3);
        assert_eq!(keys[0], raw["identityKeys"][0]);
        assert_eq!(keys[2]["id"], 4);
        assert_eq!(keys[2]["purpose"], "ENCRYPTION");
        assert_eq!(keys[2]["privateKeyWif"], "FAKE-new-wif");
        assert_eq!(keys[2]["privateKeyHex"], "FAKE-new-hex");
        assert_eq!(keys[2]["derivationPath"], "m/9'/1'/5'/0'/0'/0'/4'");
        // The file still loads, and the new key is the pending one until it is on chain (by
        // id or by public key).
        let loaded = BridgeIdentity::load_from_file(&path).unwrap();
        assert_eq!(loaded.pending_encryption_key(&[0, 2], &[]).unwrap().id, 4);
        assert!(loaded.pending_encryption_key(&[0, 2, 4], &[]).is_none());
        assert!(loaded
            .pending_encryption_key(&[0, 2, 9], &["02NEW".into()])
            .is_none());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let mode =
                |p: &std::path::Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode(&path), 0o600);
            // The directory is the user's: its mode is left alone.
            assert_eq!(mode(dir.path()), dir_mode_before);
        }
        // No temp file is left behind (the lock file stays, empty).
        let mut names: Vec<String> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(names, ["id.identity.json", "id.identity.json.lock"]);
    }

    #[test]
    fn storing_never_overwrites_a_different_key_and_fills_a_keys_only_entry() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("id.identity.json");
        std::fs::write(&path, FIXTURE).unwrap();
        super::store_identity_key(&path, &new_entry(4, "02new")).unwrap();
        let written = std::fs::read(&path).unwrap();
        // The same key again is a no-op; a different key 4 is refused.
        super::store_identity_key(&path, &new_entry(4, "02NEW")).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), written);
        let err = super::store_identity_key(&path, &new_entry(4, "02other")).unwrap_err();
        assert!(err.to_string().contains("not overwriting"), "{err}");
        assert!(!err.to_string().contains("FAKE-new"), "{err}");

        // A keys-only entry (public key, no private key) gets its private key filled in.
        let mut raw: serde_json::Value = serde_json::from_str(FIXTURE).unwrap();
        let mut bare = serde_json::to_value(new_entry(4, "02new")).unwrap();
        bare["privateKeyWif"] = "".into();
        bare["privateKeyHex"] = "".into();
        raw["identityKeys"].as_array_mut().unwrap().push(bare);
        std::fs::write(&path, raw.to_string()).unwrap();
        let loaded = BridgeIdentity::load_from_file(&path).unwrap();
        assert!(
            loaded.pending_encryption_key(&[], &[]).is_none(),
            "an entry without a private key is never reused"
        );
        super::store_identity_key(&path, &new_entry(4, "02new")).unwrap();
        let loaded = BridgeIdentity::load_from_file(&path).unwrap();
        assert_eq!(loaded.identity_keys.len(), 3);
        assert_eq!(
            loaded.identity_keys[2].private_key_hex.expose(),
            "FAKE-new-hex"
        );
    }

    #[cfg(unix)]
    #[test]
    fn storing_through_a_symlink_updates_the_target() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("real.identity.json");
        let link = dir.path().join("link.identity.json");
        std::fs::write(&target, FIXTURE).unwrap();
        std::os::unix::fs::symlink(&target, &link).unwrap();
        super::store_identity_key(&link, &new_entry(4, "02new")).unwrap();
        assert!(std::fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        let loaded = BridgeIdentity::load_from_file(&target).unwrap();
        assert_eq!(loaded.identity_keys.len(), 3);
    }

    #[test]
    fn storing_into_an_inline_key_is_refused() {
        let v = std::path::Path::new("dfk1:testnet:ID:1:cFAKEwif");
        let err = super::store_identity_key(v, &new_entry(4, "02new")).unwrap_err();
        assert!(err.to_string().contains("dfk1"), "{err}");
        assert!(!err.to_string().contains("cFAKEwif"), "{err}");
    }

    #[test]
    fn wiping_a_parsed_file_clears_every_string() {
        let mut doc: serde_json::Value = serde_json::from_str(FIXTURE).unwrap();
        super::zeroize_json_strings(&mut doc);
        let dumped = doc.to_string();
        assert!(!dumped.contains("FAKE"), "{dumped}");
        assert!(!dumped.contains("fake"), "{dumped}");
    }
}
