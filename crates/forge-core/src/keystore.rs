//! Bridge-format identity JSON parsing and secret redaction.
//!
//! `bridge.thepasta.org` exports a non-custodial identity file (see
//! `docs/testing/e2e-test-plan.md` §1.1-B) containing a mnemonic, an asset-lock key,
//! and the identity's keys with WIF/hex private material. Secret fields are wrapped
//! in [`Secret`], whose `Debug`/`Display`-free surface keeps key material out of
//! logs, journals and panic output (style guide §B: "newtype with redacted Debug").
//!
//! Where a signing identity comes from (a *key source*, what `--identity` / `DASH_FORGE_KEY` /
//! the config default hold):
//!
//! * a path to a bridge-format identity file (plaintext JSON);
//! * a path to a passphrase-sealed file ([`crate::sealed`]) holding a bridge file or a `dfk1:`
//!   key: `dg auth login` writes one where there is no OS keychain;
//! * `keychain:dash-forge/<network>/<identityId>`: an OS keychain entry ([`crate::keychain`])
//!   holding the same (`dg auth new` / `dg auth login` store limited keys there);
//! * an inline `dfk1:<network>:<identityId>:<keyId>:<wif>` limited key (CI secrets).

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

/// The `dfk1:<network>:<identityId>:<keyId>:<wif>` value of one key.
pub fn dfk1(network: &str, identity_id: &str, key_id: u32, wif: &str) -> Secret {
    Secret::new(format!(
        "{DFK1_PREFIX}{network}:{identity_id}:{key_id}:{wif}"
    ))
}

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

/// The prefix of a key source kept in the OS keychain (`keychain:<service>/<account>`).
pub const KEYCHAIN_PREFIX: &str = "keychain:";

/// Whether `source` names a file on disk (not an inline `dfk1:` key or a keychain entry).
pub fn is_file_source(source: &Path) -> bool {
    source
        .to_str()
        .is_none_or(|s| !s.starts_with(DFK1_PREFIX) && !s.starts_with(KEYCHAIN_PREFIX))
}

/// The keychain key source for an identity: `keychain:dash-forge/<network>/<identityId>`.
pub fn keychain_source(network: &str, identity_id: &str) -> String {
    format!(
        "{KEYCHAIN_PREFIX}{}/{network}/{identity_id}",
        crate::keychain::SERVICE
    )
}

/// `(service, account)` of a `keychain:` key source.
pub fn parse_keychain_source(source: &str) -> Option<(&str, &str)> {
    source
        .strip_prefix(KEYCHAIN_PREFIX)?
        .split_once('/')
        .filter(|(s, a)| !s.is_empty() && !a.is_empty())
}

/// Dash Forge's config directory: `$XDG_CONFIG_HOME/dash-forge`, else
/// `~/.config/dash-forge` (ux-dx-spec §7.6).
pub fn forge_config_dir() -> Option<std::path::PathBuf> {
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .filter(|v| !v.is_empty())
        .map(std::path::PathBuf::from)
        .filter(|p| p.is_absolute())
        .or_else(|| {
            std::env::var_os("HOME").map(|h| std::path::PathBuf::from(h).join(".config"))
        })?;
    Some(base.join("dash-forge"))
}

/// The key source `dg` recorded as the default (`default_identity` in `config.toml`), for
/// tools without an `--identity` of their own (the remote helper). `None` when there is none.
pub fn configured_default_source() -> Option<String> {
    let raw = std::fs::read_to_string(forge_config_dir()?.join("config.toml")).ok()?;
    let v: toml::Value = toml::from_str(&raw).ok()?;
    v.get("default_identity")?
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Write `bytes` to `path` readable by the owner only, replacing it atomically: the data goes
/// to a 0600 temporary file in the same directory (created exclusively, so no symlink is
/// followed) that is then renamed over `path`. A parent directory under the Forge config
/// directory is created and kept 0700.
pub fn write_private_file(path: &Path, bytes: &[u8]) -> Result<()> {
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let io = |e: std::io::Error| Error::Io(format!("writing {}: {e}", path.display()));
    if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
        std::fs::create_dir_all(dir).map_err(io)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let forge_dir = forge_config_dir();
            // Only Forge's own directories are tightened, never one the user named.
            if forge_dir.is_some_and(|c| dir.starts_with(c)) {
                std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
                    .map_err(io)?;
            }
        }
    }
    let dir = path
        .parent()
        .filter(|d| !d.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let name = path
        .file_name()
        .ok_or_else(|| Error::Io(format!("{} names no file", path.display())))?;
    // Unique per process, thread and call; create_new refuses any collision.
    let mut nonce = [0u8; 8];
    rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut nonce);
    let tmp = dir.join(format!(
        ".{}.{}.{}.{}.tmp",
        name.to_string_lossy(),
        std::process::id(),
        SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
        hex::encode(nonce)
    ));
    create_private_file(&tmp, bytes)?;
    // rename() replaces a symlink at `path` instead of writing through it.
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        io(e)
    })?;
    // Make the new directory entry durable too.
    #[cfg(unix)]
    if let Ok(d) = std::fs::File::open(dir) {
        let _ = d.sync_all();
    }
    Ok(())
}

/// Create `path` for a new export or backup, owner-only, refusing to overwrite anything or to
/// follow a symlink planted at the name (`O_EXCL` does not follow links).
pub fn create_private_file(path: &Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write as _;
    let io = |e: std::io::Error| Error::Io(format!("writing {}: {e}", path.display()));
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        opts.mode(0o600);
    }
    let mut f = opts.open(path).map_err(io)?;
    f.write_all(bytes).map_err(io)?;
    f.sync_all().map_err(io)
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
    ///
    /// Also takes a `keychain:<service>/<account>` source (an OS keychain entry) and a
    /// passphrase-sealed file (the passphrase comes from `DASH_FORGE_PASSPHRASE` or a hidden
    /// prompt on the terminal); see the module docs.
    pub fn load_from_file(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref();
        if let Some(inline) = path.to_str().filter(|s| s.starts_with(DFK1_PREFIX)) {
            return Self::from_dfk1(inline);
        }
        if let Some(src) = path.to_str().filter(|s| s.starts_with(KEYCHAIN_PREFIX)) {
            let (service, account) = parse_keychain_source(src).ok_or_else(|| {
                Error::Config(format!(
                    "identity source {src:?} must be keychain:<service>/<account>"
                ))
            })?;
            let text = crate::keychain::get(service, account)?.ok_or_else(|| {
                Error::Io(format!(
                    "reading identity: no key in the keychain under {service}/{account}"
                ))
            })?;
            return Self::from_source_text(text.expose());
        }
        let raw =
            zeroize::Zeroizing::new(std::fs::read_to_string(path).map_err(|e| {
                Error::Io(format!("reading identity file {}: {e}", path.display()))
            })?);
        if crate::sealed::is_sealed(&raw) {
            let pass = crate::sealed::passphrase(&path.display().to_string(), false)?;
            let plain = crate::sealed::open(&raw, pass.expose())?;
            let text = std::str::from_utf8(&plain)
                .map_err(|_| Error::Io("the sealed identity file does not hold text".into()))?;
            return Self::from_source_text(text);
        }
        if path.extension().is_some_and(|e| e == "key") {
            tracing::warn!(
                "{} holds an unencrypted identity key (stored with --insecure-plaintext)",
                path.display()
            );
        }
        Self::from_source_text(&raw)
    }

    /// Parse what a keychain entry or a key file holds: a `dfk1:` limited key or a
    /// bridge-format identity JSON.
    pub fn from_source_text(text: &str) -> Result<Self> {
        let t = text.trim();
        if t.starts_with(DFK1_PREFIX) {
            Self::from_dfk1(t)
        } else {
            // serde_json quotes the offending text in its errors, and this text holds keys.
            Self::from_json(t).map_err(|_| {
                Error::Config(
                    "the stored identity is neither a dfk1: key nor a bridge-format identity file"
                        .into(),
                )
            })
        }
    }

    /// The identity as bridge-format JSON **with its secrets** (unlike `Serialize`, which
    /// redacts them): what a `--full-key` login stores and `dg auth export --reveal-secrets`
    /// writes. Handle the result as a secret.
    pub fn to_json_with_secrets(&self) -> Secret {
        let keys: Vec<serde_json::Value> = self
            .identity_keys
            .iter()
            .map(|k| {
                serde_json::json!({
                    "id": k.id,
                    "name": k.name,
                    "keyType": k.key_type,
                    "purpose": k.purpose,
                    "securityLevel": k.security_level,
                    "privateKeyWif": k.private_key_wif.expose(),
                    "privateKeyHex": k.private_key_hex.expose(),
                    "publicKeyHex": k.public_key_hex,
                    "derivationPath": k.derivation_path,
                })
            })
            .collect();
        let v = serde_json::json!({
            "network": self.network,
            "identityId": self.identity_id,
            "identityKeys": keys,
            "mnemonic": self.mnemonic.expose(),
            "assetLockKey": {
                "wif": self.asset_lock_key.wif.expose(),
                "publicKeyHex": self.asset_lock_key.public_key_hex,
                "derivationPath": self.asset_lock_key.derivation_path,
            },
        });
        Secret::new(serde_json::to_string_pretty(&v).unwrap_or_default() + "\n")
    }

    /// The identity's MASTER authentication key, when this source carries one.
    pub fn master_key(&self) -> Option<&IdentityKey> {
        self.auth_key("MASTER")
            .filter(|k| !k.private_key_wif.expose().is_empty())
    }

    /// The `dfk1:` form of key `key_id` of this identity.
    pub fn to_dfk1(&self, key_id: u32) -> Option<Secret> {
        let k = self.identity_keys.iter().find(|k| k.id == key_id)?;
        Some(dfk1(
            &self.network,
            &self.identity_id,
            k.id,
            k.private_key_wif.expose(),
        ))
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
        // The network and id end up in file names and keychain accounts: letters, digits
        // and `-` only for the network, base58 for the id.
        if !network
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        {
            return Err(bad("the network is not a network name"));
        }
        if !(40..=44).contains(&identity_id.len())
            || !identity_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() && !b"0OIl".contains(&b))
        {
            return Err(bad("the identity id is not base58"));
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
        let v = "dfk1:devnet-moutai:FAKEid1111111111111111111111111111111111111:5:cFAKEwifDONOTUSE";
        let id = BridgeIdentity::load_from_file(v).unwrap();
        assert_eq!(id.network, "devnet-moutai");
        assert_eq!(
            id.identity_id,
            "FAKEid1111111111111111111111111111111111111"
        );
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
        assert_eq!(
            shown,
            "dfk1:devnet-moutai:FAKEid1111111111111111111111111111111111111:5:[redacted]"
        );
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
            // An id that is not base58, and a network that is not a name (both end up in file
            // names and keychain accounts).
            "dfk1:testnet:../../etc/passwd:5:cWIFsecret",
            "dfk1:test/net:FAKEid1111111111111111111111111111111111111:5:cWIFsecret",
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
