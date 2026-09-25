//! Storage profiles: the user's own named storage targets, kept in
//! `~/.config/dash-forge/storage.toml` and shared by `dg` and `git-remote-dash`.
//!
//! A profile says *where* bytes go and *how to authenticate*, never the secret itself.
//! Secret fields hold a [`SecretRef`] (`env:VAR` or `keychain:service/account`), resolved
//! at use time into a redacting [`Secret`]; a literal secret in the file is refused at load
//! time. Nothing here is ever written on-chain — the chain only learns the public read
//! URIs a push records in its `packManifest`.
//!
//! ```toml
//! [read]
//! ipfs_gateways = ["https://ipfs.io", "https://dweb.link"]  # optional override
//!
//! [profiles.r2-main]
//! kind = "s3"
//! endpoint = "https://<account>.r2.cloudflarestorage.com"
//! region = "auto"
//! bucket = "forge"
//! path_style = true
//! public_url = "https://pub-<hash>.r2.dev"
//! access_key_id = "env:R2_ACCESS_KEY_ID"
//! secret_access_key = "keychain:dash-forge/r2-main"
//!
//! [profiles.kubo]
//! kind = "ipfs-kubo"
//! api = "http://127.0.0.1:5001"
//! gateway = "http://127.0.0.1:8080"
//! ```
//!
//! The same field names (camel-cased) are what the web app's settings will store in its
//! encrypted vault, so a profile can be described identically on both sides.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::backends::ipfs::{IpfsConfig, PinningServiceConfig, DEFAULT_PIN_TIMEOUT};
use crate::backends::s3::{S3Config, S3Credentials};
use crate::backends::{IpfsBackend, PackBackend, S3Backend};
use crate::error::{Error, Result};
use crate::keystore::Secret;

/// The built-in profile name for on-chain `chunk` storage. Always available; it may also
/// be declared explicitly (`kind = "platform"`) under another name.
pub const PLATFORM_PROFILE: &str = "platform";

/// Environment override for the profiles file path (tests, CI, multiple setups).
pub const STORAGE_CONFIG_ENV: &str = "DASH_FORGE_STORAGE_CONFIG";

/// A reference to a secret held outside the profiles file.
#[derive(Clone, PartialEq, Eq)]
pub enum SecretRef {
    /// An environment variable name (`env:R2_SECRET_ACCESS_KEY`).
    Env(String),
    /// An OS keychain entry (`keychain:<service>/<account>`): the macOS login keychain
    /// (`security`), or the freedesktop Secret Service (`secret-tool`) elsewhere.
    Keychain {
        /// Keychain service name.
        service: String,
        /// Keychain account name.
        account: String,
    },
}

impl std::fmt::Debug for SecretRef {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // The reference is not secret (it names where the secret lives), so show it.
        f.write_str(&self.to_string())
    }
}

impl std::fmt::Display for SecretRef {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SecretRef::Env(v) => write!(f, "env:{v}"),
            SecretRef::Keychain { service, account } => write!(f, "keychain:{service}/{account}"),
        }
    }
}

impl std::str::FromStr for SecretRef {
    type Err = Error;

    fn from_str(s: &str) -> Result<Self> {
        if let Some(var) = s.strip_prefix("env:") {
            let ok = !var.is_empty() && var.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_');
            if !ok {
                return Err(Error::Config(format!(
                    "`env:` reference needs a variable name of letters, digits and '_' (got {var:?})"
                )));
            }
            return Ok(SecretRef::Env(var.to_string()));
        }
        if let Some(rest) = s.strip_prefix("keychain:") {
            let (service, account) = rest.split_once('/').ok_or_else(|| {
                Error::Config(format!(
                    "`keychain:` reference must be keychain:<service>/<account> (got {rest:?})"
                ))
            })?;
            if service.is_empty() || account.is_empty() {
                return Err(Error::Config(
                    "`keychain:` reference has an empty service or account".into(),
                ));
            }
            return Ok(SecretRef::Keychain {
                service: service.to_string(),
                account: account.to_string(),
            });
        }
        // Deliberately does not echo `s`: it may be a pasted secret.
        Err(Error::Config(
            "a secret must be a reference — `env:VAR_NAME` or `keychain:<service>/<account>` — \
             never the literal value (secrets are not stored in storage.toml)"
                .into(),
        ))
    }
}

impl TryFrom<String> for SecretRef {
    type Error = Error;
    fn try_from(s: String) -> Result<Self> {
        s.parse()
    }
}

impl From<SecretRef> for String {
    fn from(r: SecretRef) -> String {
        r.to_string()
    }
}

impl Serialize for SecretRef {
    fn serialize<S: serde::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

impl<'de> Deserialize<'de> for SecretRef {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        s.parse().map_err(serde::de::Error::custom)
    }
}

impl SecretRef {
    /// Resolve the reference to the secret value. Errors name the reference, never the value.
    pub fn resolve(&self) -> Result<Secret> {
        match self {
            SecretRef::Env(var) => match std::env::var(var) {
                Ok(v) if !v.is_empty() => Ok(Secret::new(v)),
                _ => Err(Error::Config(format!(
                    "secret {self} is not set (export {var}=… in the environment git and dg run in)"
                ))),
            },
            SecretRef::Keychain { service, account } => keychain_lookup(service, account)
                .map(Secret::new)
                .map_err(|why| Error::Config(format!("secret {self}: {why}"))),
        }
    }

    /// Whether the reference currently resolves (for `dg storage list`), without keeping
    /// the value.
    pub fn is_available(&self) -> bool {
        self.resolve().is_ok()
    }
}

/// Look a secret up in the OS keychain.
fn keychain_lookup(service: &str, account: &str) -> std::result::Result<String, String> {
    use std::process::{Command, Stdio};
    let output = if cfg!(target_os = "macos") {
        Command::new("security")
            .args(["find-generic-password", "-s", service, "-a", account, "-w"])
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
    } else {
        Command::new("secret-tool")
            .args(["lookup", "service", service, "account", account])
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
    }
    .map_err(|e| format!("could not run the keychain tool: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "no keychain entry for service {service:?} account {account:?}"
        ));
    }
    let value = String::from_utf8(output.stdout)
        .map_err(|_| "keychain entry is not UTF-8".to_string())?
        .trim_end_matches(['\r', '\n'])
        .to_string();
    if value.is_empty() {
        return Err("keychain entry is empty".into());
    }
    Ok(value)
}

/// An access key id: a literal (it is not secret — it appears in every signed request) or
/// a reference.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeyId {
    /// A literal access key id.
    Literal(String),
    /// A reference resolved at use time.
    Ref(SecretRef),
}

impl Serialize for KeyId {
    fn serialize<S: serde::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        match self {
            KeyId::Literal(v) => s.serialize_str(v),
            KeyId::Ref(r) => r.serialize(s),
        }
    }
}

impl<'de> Deserialize<'de> for KeyId {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        KeyId::parse(&s).map_err(serde::de::Error::custom)
    }
}

impl KeyId {
    /// Parse an `env:`/`keychain:` reference, or take the string as a literal id.
    pub fn parse(s: &str) -> Result<Self> {
        if s.starts_with("env:") || s.starts_with("keychain:") {
            Ok(KeyId::Ref(s.parse()?))
        } else if s.is_empty() {
            Err(Error::Config("access_key_id is empty".into()))
        } else {
            Ok(KeyId::Literal(s.to_string()))
        }
    }

    fn resolve(&self) -> Result<String> {
        match self {
            KeyId::Literal(v) => Ok(v.clone()),
            KeyId::Ref(r) => r.resolve().map(|s| s.expose().to_string()),
        }
    }
}

fn default_true() -> bool {
    true
}

fn default_region() -> String {
    "us-east-1".into()
}

/// One named storage target.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Profile {
    /// An S3-compatible bucket.
    S3(S3Profile),
    /// A kubo node's RPC API (add + local pin).
    IpfsKubo(KuboProfile),
    /// kubo add + a remote IPFS Pinning Service API pin.
    IpfsPinningService(PinningProfile),
    /// On-chain `chunk` documents.
    Platform(PlatformProfile),
}

/// `kind = "platform"` has no settings.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PlatformProfile {}

/// `kind = "s3"`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct S3Profile {
    /// API endpoint origin.
    pub endpoint: String,
    /// SigV4 region.
    #[serde(default = "default_region")]
    pub region: String,
    /// Bucket name.
    pub bucket: String,
    /// Path-style addressing (default `true`: works for R2, B2, MinIO and AWS).
    #[serde(default = "default_true")]
    pub path_style: bool,
    /// Public read origin (`https://pub-….r2.dev`, a custom domain, …). Omit for a
    /// private bucket that only credentialed CLIs can read.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub public_url: Option<String>,
    /// Key prefix inside the bucket.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub prefix: String,
    /// Access key id (literal or reference). Omit, with the secret, for an anonymous
    /// public-write bucket (local MinIO fixture only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub access_key_id: Option<KeyId>,
    /// Secret access key reference.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secret_access_key: Option<SecretRef>,
    /// STS session token reference.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_token: Option<SecretRef>,
}

/// `kind = "ipfs-kubo"`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct KuboProfile {
    /// kubo RPC API origin (`http://127.0.0.1:5001`).
    pub api: String,
    /// A gateway that serves this node's content, used to re-read uploads for
    /// verification (`http://127.0.0.1:8080`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gateway: Option<String>,
    /// A PUBLIC https gateway serving this node's content. When set, pushes also record
    /// `<public_gateway>/ipfs/<cid>` so browsers can read it directly.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub public_gateway: Option<String>,
    /// Full `Authorization` header value for an RPC API behind auth.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_auth: Option<SecretRef>,
}

/// `kind = "ipfs-pinning-service"`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PinningProfile {
    /// The kubo node the content is added through (and that the service fetches from).
    pub api: String,
    /// A gateway for verification re-reads.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gateway: Option<String>,
    /// A public https gateway to record alongside `ipfs://`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub public_gateway: Option<String>,
    /// kubo RPC `Authorization` header reference.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_auth: Option<SecretRef>,
    /// The Pinning Service API base URL.
    pub pinning_endpoint: String,
    /// The service access token reference.
    pub pinning_token: SecretRef,
    /// Seconds to wait for `pinned` (default 120).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pin_timeout_secs: Option<u64>,
}

/// Reader settings.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReadSettings {
    /// IPFS gateways to race for `ipfs://` URIs (replaces the shared default list).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ipfs_gateways: Option<Vec<String>>,
}

/// The whole `storage.toml`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StorageProfiles {
    /// Reader settings.
    #[serde(default)]
    pub read: ReadSettings,
    /// Named profiles.
    #[serde(default)]
    pub profiles: BTreeMap<String, Profile>,
}

/// Whether `name` is a usable profile name (it becomes part of git config values, so no
/// commas or whitespace).
pub fn valid_profile_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
}

fn http_origin(field: &str, value: &str) -> Result<()> {
    let url = reqwest::Url::parse(value)
        .map_err(|e| Error::Config(format!("{field} {value:?} is not a URL: {e}")))?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err(Error::Config(format!(
            "{field} {value:?} must be an http(s) URL"
        )));
    }
    Ok(())
}

impl Profile {
    /// Short kind label (`s3`, `ipfs-kubo`, …).
    pub fn kind(&self) -> &'static str {
        match self {
            Profile::S3(_) => "s3",
            Profile::IpfsKubo(_) => "ipfs-kubo",
            Profile::IpfsPinningService(_) => "ipfs-pinning-service",
            Profile::Platform(_) => "platform",
        }
    }

    /// Whether this is the on-chain tier.
    pub fn is_platform(&self) -> bool {
        matches!(self, Profile::Platform(_))
    }

    /// Structural validation (URLs parse, S3 names are sane, credential pairs complete).
    pub fn validate(&self) -> Result<()> {
        match self {
            Profile::S3(p) => {
                p.to_config_unresolved().validate()?;
                if p.access_key_id.is_some() != p.secret_access_key.is_some() {
                    return Err(Error::Config(
                        "s3 profile needs both access_key_id and secret_access_key, or neither"
                            .into(),
                    ));
                }
                if p.session_token.is_some() && p.secret_access_key.is_none() {
                    return Err(Error::Config("s3 session_token without access keys".into()));
                }
                Ok(())
            }
            Profile::IpfsKubo(p) => {
                http_origin("api", &p.api)?;
                if let Some(g) = &p.gateway {
                    http_origin("gateway", g)?;
                }
                if let Some(g) = &p.public_gateway {
                    http_origin("public_gateway", g)?;
                }
                Ok(())
            }
            Profile::IpfsPinningService(p) => {
                http_origin("api", &p.api)?;
                http_origin("pinning_endpoint", &p.pinning_endpoint)?;
                if let Some(g) = &p.gateway {
                    http_origin("gateway", g)?;
                }
                if let Some(g) = &p.public_gateway {
                    http_origin("public_gateway", g)?;
                }
                Ok(())
            }
            Profile::Platform(_) => Ok(()),
        }
    }

    /// The secret references this profile uses (for `dg storage list`).
    pub fn secret_refs(&self) -> Vec<(&'static str, &SecretRef)> {
        let mut out = Vec::new();
        match self {
            Profile::S3(p) => {
                if let Some(KeyId::Ref(r)) = &p.access_key_id {
                    out.push(("access_key_id", r));
                }
                if let Some(r) = &p.secret_access_key {
                    out.push(("secret_access_key", r));
                }
                if let Some(r) = &p.session_token {
                    out.push(("session_token", r));
                }
            }
            Profile::IpfsKubo(p) => {
                if let Some(r) = &p.api_auth {
                    out.push(("api_auth", r));
                }
            }
            Profile::IpfsPinningService(p) => {
                if let Some(r) = &p.api_auth {
                    out.push(("api_auth", r));
                }
                out.push(("pinning_token", &p.pinning_token));
            }
            Profile::Platform(_) => {}
        }
        out
    }

    /// Build the backend for an external profile, resolving its secrets. `None` for the
    /// platform kind (the on-chain tier is not a [`PackBackend`] the push path owns).
    pub fn build_backend(&self, client: &reqwest::Client) -> Result<Option<Box<dyn PackBackend>>> {
        Ok(match self {
            Profile::S3(p) => Some(Box::new(S3Backend::with_client(
                p.to_config()?,
                client.clone(),
            ))),
            Profile::IpfsKubo(p) => Some(Box::new(IpfsBackend::with_client(
                IpfsConfig {
                    api: Some(p.api.trim_end_matches('/').to_string()),
                    api_auth: p.api_auth.as_ref().map(SecretRef::resolve).transpose()?,
                    gateway: verify_gateway(p.gateway.as_deref(), p.public_gateway.as_deref()),
                    pinning: None,
                },
                client.clone(),
            ))),
            Profile::IpfsPinningService(p) => Some(Box::new(IpfsBackend::with_client(
                IpfsConfig {
                    api: Some(p.api.trim_end_matches('/').to_string()),
                    api_auth: p.api_auth.as_ref().map(SecretRef::resolve).transpose()?,
                    gateway: verify_gateway(p.gateway.as_deref(), p.public_gateway.as_deref()),
                    pinning: Some(PinningServiceConfig {
                        endpoint: p.pinning_endpoint.trim_end_matches('/').to_string(),
                        token: p.pinning_token.resolve()?,
                        timeout: p
                            .pin_timeout_secs
                            .map_or(DEFAULT_PIN_TIMEOUT, Duration::from_secs),
                        poll_interval: Duration::from_secs(2),
                    }),
                },
                client.clone(),
            ))),
            Profile::Platform(_) => None,
        })
    }

    /// The public gateway to record for an ipfs profile.
    pub fn public_gateway(&self) -> Option<&str> {
        match self {
            Profile::IpfsKubo(p) => p.public_gateway.as_deref(),
            Profile::IpfsPinningService(p) => p.public_gateway.as_deref(),
            _ => None,
        }
    }

    /// Whether uploads to this profile can be re-read for verification.
    pub fn can_reread(&self) -> bool {
        match self {
            Profile::IpfsKubo(p) => p.gateway.is_some() || p.public_gateway.is_some(),
            Profile::IpfsPinningService(p) => p.gateway.is_some() || p.public_gateway.is_some(),
            _ => true,
        }
    }
}

/// The gateway an ipfs backend re-reads through: the public one when set (it is what the
/// manifest records), else the local one, else empty (no re-read).
fn verify_gateway(local: Option<&str>, public: Option<&str>) -> String {
    public
        .or(local)
        .unwrap_or_default()
        .trim_end_matches('/')
        .to_string()
}

impl S3Profile {
    fn to_config_unresolved(&self) -> S3Config {
        S3Config {
            endpoint: self.endpoint.trim_end_matches('/').to_string(),
            region: self.region.clone(),
            bucket: self.bucket.clone(),
            path_style: self.path_style,
            public_url: self
                .public_url
                .as_ref()
                .map(|u| u.trim_end_matches('/').to_string()),
            prefix: self.prefix.clone(),
            credentials: None,
        }
    }

    /// The backend config with secrets resolved.
    pub fn to_config(&self) -> Result<S3Config> {
        let mut cfg = self.to_config_unresolved();
        if let (Some(id), Some(secret)) = (&self.access_key_id, &self.secret_access_key) {
            cfg.credentials = Some(S3Credentials {
                access_key_id: id.resolve()?,
                secret_access_key: secret.resolve()?,
                session_token: self
                    .session_token
                    .as_ref()
                    .map(SecretRef::resolve)
                    .transpose()?,
            });
        }
        cfg.validate()?;
        Ok(cfg)
    }
}

impl StorageProfiles {
    /// The default profiles path: `$DASH_FORGE_STORAGE_CONFIG`, else
    /// `~/.config/dash-forge/storage.toml`.
    pub fn default_path() -> Result<PathBuf> {
        if let Some(p) = std::env::var_os(STORAGE_CONFIG_ENV) {
            return Ok(PathBuf::from(p));
        }
        let home = std::env::var_os("HOME").ok_or_else(|| {
            Error::Config("HOME is not set; cannot locate ~/.config/dash-forge/storage.toml".into())
        })?;
        Ok(PathBuf::from(home).join(".config/dash-forge/storage.toml"))
    }

    /// Load from the default path (empty when the file does not exist).
    pub fn load() -> Result<Self> {
        Self::load_from(&Self::default_path()?)
    }

    /// Load from `path` (empty when absent), validating every profile.
    pub fn load_from(path: &Path) -> Result<Self> {
        let raw = match std::fs::read_to_string(path) {
            Ok(r) => r,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Self::default()),
            Err(e) => return Err(Error::Io(format!("reading {}: {e}", path.display()))),
        };
        let parsed =
            Self::parse(&raw).map_err(|e| Error::Config(format!("{}: {e}", path.display())))?;
        Ok(parsed)
    }

    /// Parse + validate TOML text.
    pub fn parse(raw: &str) -> Result<Self> {
        let parsed: Self = toml::from_str(raw).map_err(|e| Error::Config(e.to_string()))?;
        for (name, profile) in &parsed.profiles {
            if !valid_profile_name(name) {
                return Err(Error::Config(format!(
                    "profile name {name:?} must be letters, digits, '-', '_' or '.'"
                )));
            }
            profile
                .validate()
                .map_err(|e| Error::Config(format!("profile {name:?}: {e}")))?;
        }
        if let Some(gws) = &parsed.read.ipfs_gateways {
            for g in gws {
                http_origin("read.ipfs_gateways entry", g)?;
            }
        }
        Ok(parsed)
    }

    /// Serialize to TOML.
    pub fn to_toml(&self) -> Result<String> {
        toml::to_string_pretty(self)
            .map_err(|e| Error::Config(format!("serializing profiles: {e}")))
    }

    /// Write to `path` atomically (temp file + rename), creating the directory.
    pub fn save_to(&self, path: &Path) -> Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| Error::Io(format!("creating {}: {e}", parent.display())))?;
        }
        let body = format!(
            "# Dash Forge storage profiles (docs/guides/bring-your-own-storage.md).\n\
             # Secrets are references (env:VAR / keychain:service/account), never values.\n\n{}",
            self.to_toml()?
        );
        let tmp = path.with_extension("toml.tmp");
        std::fs::write(&tmp, body)
            .map_err(|e| Error::Io(format!("writing {}: {e}", tmp.display())))?;
        std::fs::rename(&tmp, path)
            .map_err(|e| Error::Io(format!("replacing {}: {e}", path.display())))
    }

    /// Look up `name`, with `platform` always resolving to the built-in on-chain tier.
    pub fn get(&self, name: &str) -> Option<Profile> {
        match self.profiles.get(name) {
            Some(p) => Some(p.clone()),
            None if name == PLATFORM_PROFILE => Some(Profile::Platform(PlatformProfile {})),
            None => None,
        }
    }

    /// The IPFS gateway list readers race: the user's override, else the shared default.
    pub fn ipfs_gateways(&self) -> Vec<String> {
        self.read
            .ipfs_gateways
            .clone()
            .filter(|g| !g.is_empty())
            .unwrap_or_else(super::default_ipfs_gateways)
            .into_iter()
            .map(|g| g.trim_end_matches('/').to_string())
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"
[read]
ipfs_gateways = ["https://gw.example"]

[profiles.r2-main]
kind = "s3"
endpoint = "https://acct.r2.cloudflarestorage.com"
region = "auto"
bucket = "forge"
public_url = "https://pub-1.r2.dev/"
access_key_id = "env:R2_KEY_ID"
secret_access_key = "keychain:dash-forge/r2-main"

[profiles.kubo]
kind = "ipfs-kubo"
api = "http://127.0.0.1:5001"
gateway = "http://127.0.0.1:8080"

[profiles.pins]
kind = "ipfs-pinning-service"
api = "http://127.0.0.1:5001"
pinning_endpoint = "https://pins.example/psa"
pinning_token = "env:PIN_TOKEN"

[profiles.chain]
kind = "platform"
"#;

    #[test]
    fn parses_every_kind_and_round_trips() {
        let p = StorageProfiles::parse(SAMPLE).unwrap();
        assert_eq!(p.profiles.len(), 4);
        assert_eq!(p.profiles["r2-main"].kind(), "s3");
        assert_eq!(p.profiles["pins"].kind(), "ipfs-pinning-service");
        assert!(p.profiles["chain"].is_platform());
        assert_eq!(p.ipfs_gateways(), vec!["https://gw.example".to_string()]);
        let again = StorageProfiles::parse(&p.to_toml().unwrap()).unwrap();
        assert_eq!(again, p);
    }

    #[test]
    fn literal_secrets_are_refused_without_echoing_them() {
        let raw = r#"
[profiles.x]
kind = "s3"
endpoint = "https://s3.amazonaws.com"
bucket = "b"
access_key_id = "AKIDLITERALISFINE"
secret_access_key = "wJalrXUtnFEMI-LITERAL-SECRET"
"#;
        let err = StorageProfiles::parse(raw).unwrap_err().to_string();
        assert!(err.contains("reference"), "{err}");
        assert!(!err.contains("LITERAL-SECRET"), "{err}");
    }

    #[test]
    fn unknown_fields_and_bad_names_are_refused() {
        let typo =
            "[profiles.k]\nkind = \"ipfs-kubo\"\napi = \"http://x\"\ngatway = \"http://y\"\n";
        assert!(StorageProfiles::parse(typo).is_err());
        let bad_name = "[profiles.\"a,b\"]\nkind = \"platform\"\n";
        assert!(StorageProfiles::parse(bad_name).is_err());
        let bad_kind = "[profiles.k]\nkind = \"ftp\"\n";
        assert!(StorageProfiles::parse(bad_kind).is_err());
    }

    #[test]
    fn half_credentials_are_refused() {
        let raw = "[profiles.x]\nkind = \"s3\"\nendpoint = \"https://h\"\nbucket = \"b\"\naccess_key_id = \"AK\"\n";
        assert!(StorageProfiles::parse(raw).is_err());
    }

    #[test]
    fn platform_is_always_available() {
        let p = StorageProfiles::default();
        assert!(p.get("platform").unwrap().is_platform());
        assert!(p.get("nope").is_none());
        assert!(!p.ipfs_gateways().is_empty(), "shared default list applies");
    }

    #[test]
    fn env_refs_resolve_and_report_missing_without_values() {
        let r: SecretRef = "env:FORGE_TEST_SECRET_REF_X".parse().unwrap();
        std::env::remove_var("FORGE_TEST_SECRET_REF_X");
        let err = r.resolve().unwrap_err().to_string();
        assert!(err.contains("FORGE_TEST_SECRET_REF_X"));
        std::env::set_var("FORGE_TEST_SECRET_REF_X", "hunter2");
        let s = r.resolve().unwrap();
        assert_eq!(s.expose(), "hunter2");
        assert!(!format!("{s:?}").contains("hunter2"));
        std::env::remove_var("FORGE_TEST_SECRET_REF_X");
    }

    #[test]
    fn secret_ref_syntax() {
        assert!("env:".parse::<SecretRef>().is_err());
        assert!("env:A-B".parse::<SecretRef>().is_err());
        assert!("keychain:svc".parse::<SecretRef>().is_err());
        assert_eq!(
            "keychain:svc/acct"
                .parse::<SecretRef>()
                .unwrap()
                .to_string(),
            "keychain:svc/acct"
        );
    }

    #[test]
    fn s3_profile_builds_a_redacted_backend() {
        std::env::set_var("FORGE_TEST_S3_SECRET_Y", "top-secret-value");
        let raw = "[profiles.x]\nkind = \"s3\"\nendpoint = \"http://127.0.0.1:9000\"\nbucket = \"b\"\naccess_key_id = \"AK\"\nsecret_access_key = \"env:FORGE_TEST_S3_SECRET_Y\"\n";
        let p = StorageProfiles::parse(raw).unwrap();
        let backend = p.profiles["x"]
            .build_backend(&reqwest::Client::new())
            .unwrap()
            .unwrap();
        assert_eq!(backend.scheme(), "s3");
        let Profile::S3(s3) = &p.profiles["x"] else {
            unreachable!()
        };
        let cfg = s3.to_config().unwrap();
        assert!(!format!("{cfg:?}").contains("top-secret-value"));
        std::env::remove_var("FORGE_TEST_S3_SECRET_Y");
    }
}
