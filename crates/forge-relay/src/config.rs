//! Relay configuration: a TOML file overlaid with CLI flags (PRD 05 §Deployment —
//! "config = relay identity key + network").
//!
//! The daemon is stateless; subscriptions live on Platform as forge-v2 `webhook` documents
//! addressed to the relay identity, with their secrets encrypted to it. This file carries
//! only operator-local settings: the network, the relay identity, the poll cadence, an
//! optional repo filter, the SSRF switch, and static webhooks for local testing.

use std::path::PathBuf;
use std::time::Duration;

use serde::Deserialize;

use forge_core::network::{NetworkSettings, NetworkTarget};

use crate::error::{RelayError, Result};

/// The default poll interval. The acceptance is push → webhook in < 30 s, so 15 s keeps the
/// worst case (poll interval + block time + delivery) under budget.
pub const DEFAULT_POLL_SECS: u64 = 15;

/// Re-read the `webhook` documents every this many poll cycles by default (a minute at the
/// default interval): a new, re-pointed or disabled hook takes effect within that.
pub const DEFAULT_REFRESH_CYCLES: u64 = 4;

/// A statically configured webhook with a plaintext secret, for local testing (bypasses the
/// on-Platform `webhook` documents).
///
/// `Debug` is hand-written to redact `secret`.
#[derive(Clone, Deserialize)]
pub struct StaticWebhook {
    /// The repo: `owner/name` or a forge-v2 repo id (base58).
    pub repo: String,
    /// The delivery URL.
    pub url: String,
    /// The subscribed event names; empty = all.
    #[serde(default)]
    pub events: Vec<String>,
    /// The HMAC secret (plaintext).
    pub secret: String,
    /// A stable hook id (used in the delivery-id derivation); defaults to the SHA-256 of the URL.
    #[serde(default)]
    pub hook_id: Option<String>,
}

impl std::fmt::Debug for StaticWebhook {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StaticWebhook")
            .field("repo", &self.repo)
            .field("url", &crate::ssrf::redact(&self.url))
            .field("events", &self.events)
            .field("secret", &"[redacted]")
            .field("hook_id", &self.hook_id)
            .finish()
    }
}

/// The on-disk TOML shape (all optional; CLI flags override). Unknown keys (such as the v1
/// relay's `secrets` map or `registry-contract-id`) are ignored.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "kebab-case")]
struct FileConfig {
    network: Option<String>,
    devnet_name: Option<String>,
    dapi_addresses: Option<String>,
    quorum_url: Option<String>,
    identity: Option<PathBuf>,
    poll_interval_secs: Option<u64>,
    refresh_cycles: Option<u64>,
    #[serde(default)]
    repos: Vec<String>,
    allow_private: Option<bool>,
    lookback: Option<u32>,
    web_base_url: Option<String>,
    use_platform_webhooks: Option<bool>,
    listen: Option<String>,
    #[serde(default)]
    webhook: Vec<StaticWebhook>,
}

/// The fully resolved relay configuration.
#[derive(Debug, Clone)]
pub struct RelayConfig {
    /// Target network (its forge-v2 contracts are what the relay reads).
    pub target: NetworkTarget,
    /// Relay key file (minimal ENCRYPTION-key file or full bridge identity). Its id selects the `webhook` documents
    /// addressed to this relay, and its `ENCRYPTION` key decrypts their secrets. The relay
    /// never writes, so its balance can stay at zero.
    pub identity_path: Option<PathBuf>,
    /// Poll cadence.
    pub poll_interval: Duration,
    /// Re-read the `webhook` documents every this many cycles.
    pub refresh_cycles: u64,
    /// When non-empty, serve only these repos (`owner/name` or repo id); otherwise every repo
    /// with a hook addressed to this relay.
    pub repos: Vec<String>,
    /// Whether private/loopback delivery targets are allowed (local testing only).
    pub allow_private: bool,
    /// How many pre-existing docs per type to (re)deliver for repos found at startup. `0` =
    /// start from "now".
    pub lookback: u32,
    /// forge-web base URL for `html_url`/`compare` synthesis.
    pub web_base_url: String,
    /// Whether to read `webhook` documents from Platform.
    pub use_platform_webhooks: bool,
    /// Optional health-listener bind address.
    pub listen: Option<String>,
    /// Statically configured webhooks (plaintext secrets; local testing).
    pub static_webhooks: Vec<StaticWebhook>,
}

/// CLI overrides applied on top of the file config.
#[derive(Debug, Default, Clone)]
pub struct CliOverrides {
    /// `--network`, `--devnet-name`, `--dapi-addresses`.
    pub network: NetworkSettings,
    /// `--identity`.
    pub identity: Option<PathBuf>,
    /// `--repos`.
    pub repos: Option<Vec<String>>,
    /// `--poll-interval` (seconds).
    pub poll_interval_secs: Option<u64>,
    /// `--refresh-cycles`.
    pub refresh_cycles: Option<u64>,
    /// `--allow-private`.
    pub allow_private: Option<bool>,
    /// `--lookback`.
    pub lookback: Option<u32>,
    /// `--listen`.
    pub listen: Option<String>,
    /// `--web-base-url`.
    pub web_base_url: Option<String>,
}

impl RelayConfig {
    /// Load from an optional TOML file path, then apply CLI overrides. A missing file is an
    /// error only when a path was given.
    pub fn load(config_path: Option<&std::path::Path>, cli: &CliOverrides) -> Result<Self> {
        let file: FileConfig = match config_path {
            Some(path) if path.exists() => {
                let raw = std::fs::read_to_string(path).map_err(|e| {
                    RelayError::Io(format!("reading config {}: {e}", path.display()))
                })?;
                toml::from_str(&raw).map_err(|e| {
                    RelayError::Config(format!("parsing config {}: {e}", path.display()))
                })?
            }
            Some(path) => {
                return Err(RelayError::Config(format!(
                    "config file not found: {}",
                    path.display()
                )))
            }
            None => FileConfig::default(),
        };

        // Network precedence, field by field: flags > config file > environment
        // (`DASH_FORGE_NETWORK`, ...) > embedded deployment.
        let file_network = NetworkSettings {
            network: file.network.clone(),
            devnet_name: file.devnet_name.clone(),
            dapi_addresses: file.dapi_addresses.clone(),
            quorum_base_url: file.quorum_url.clone(),
            registry: None,
        };
        let target = cli
            .network
            .clone()
            .overlay(file_network)
            .overlay(NetworkSettings::from_env())
            .resolve()
            .map_err(|e| RelayError::Config(e.to_string()))?;

        Ok(Self {
            target,
            identity_path: cli.identity.clone().or(file.identity),
            poll_interval: Duration::from_secs(
                cli.poll_interval_secs
                    .or(file.poll_interval_secs)
                    .unwrap_or(DEFAULT_POLL_SECS)
                    .max(1),
            ),
            refresh_cycles: cli
                .refresh_cycles
                .or(file.refresh_cycles)
                .unwrap_or(DEFAULT_REFRESH_CYCLES)
                .max(1),
            repos: cli.repos.clone().unwrap_or(file.repos),
            allow_private: cli.allow_private.or(file.allow_private).unwrap_or(false),
            lookback: cli.lookback.or(file.lookback).unwrap_or(0),
            web_base_url: cli
                .web_base_url
                .clone()
                .or(file.web_base_url)
                .unwrap_or_else(|| "https://forge.dash".to_string()),
            use_platform_webhooks: file.use_platform_webhooks.unwrap_or(true),
            listen: cli.listen.clone().or(file.listen),
            static_webhooks: file.webhook,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use forge_core::platform::Network;

    fn load_str(name: &str, src: &str, cli: &CliOverrides) -> Result<RelayConfig> {
        let dir = std::env::temp_dir().join(format!("relay-cfg-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("relay.toml");
        std::fs::write(&path, src).unwrap();
        let cfg = RelayConfig::load(Some(&path), cli);
        std::fs::remove_dir_all(&dir).ok();
        cfg
    }

    #[test]
    fn devnet_in_the_file_and_a_flag_overrides_it() {
        let src = "network = \"devnet\"\ndevnet-name = \"moutai\"\n";
        let cfg = load_str("devnet", src, &CliOverrides::default()).unwrap();
        assert_eq!(cfg.target.network.key(), "devnet-moutai");
        assert!(cfg.target.v2.is_some(), "moutai has a forge-v2 deployment");

        let cli = CliOverrides {
            network: NetworkSettings::from_flags(Some("testnet".into()), None, None),
            ..Default::default()
        };
        let cfg = load_str("devnet2", src, &cli).unwrap();
        assert_eq!(cfg.target.network, Network::Testnet);
    }

    #[test]
    fn parses_full_toml_and_ignores_v1_keys() {
        let src = r#"
network = "testnet"
identity = "/tmp/relay.json"
poll-interval-secs = 10
refresh-cycles = 3
repos = ["AAA", "owner/bbb"]
allow-private = true
lookback = 3
web-base-url = "https://forge.example"
use-platform-webhooks = false
registry-contract-id = "IGNORED"

[[webhook]]
repo = "owner/ccc"
url = "http://127.0.0.1:9000/hook?token=t"
events = ["push"]
secret = "s3cr3t"

[secrets]
"deadbeef" = "ignored"
"#;
        let cfg = load_str("full", src, &CliOverrides::default()).unwrap();
        assert_eq!(cfg.target.network, Network::Testnet);
        assert_eq!(cfg.poll_interval, Duration::from_secs(10));
        assert_eq!(cfg.refresh_cycles, 3);
        assert_eq!(cfg.repos, vec!["AAA".to_string(), "owner/bbb".to_string()]);
        assert!(cfg.allow_private);
        assert_eq!(cfg.lookback, 3);
        assert!(!cfg.use_platform_webhooks);
        assert_eq!(cfg.static_webhooks.len(), 1);
        let dumped = format!("{cfg:?}");
        assert!(!dumped.contains("s3cr3t"), "{dumped}");
        assert!(!dumped.contains("token=t"), "{dumped}");
    }

    #[test]
    fn cli_overrides_win() {
        let cli = CliOverrides {
            network: NetworkSettings::from_flags(Some("mainnet".into()), None, None),
            repos: Some(vec!["ZZZ".into()]),
            poll_interval_secs: Some(42),
            refresh_cycles: Some(0),
            allow_private: Some(true),
            ..Default::default()
        };
        let cfg = RelayConfig::load(None, &cli).unwrap();
        assert_eq!(cfg.target.network, Network::Mainnet);
        assert_eq!(cfg.repos, vec!["ZZZ".to_string()]);
        assert_eq!(cfg.poll_interval, Duration::from_secs(42));
        assert_eq!(cfg.refresh_cycles, 1, "clamped to at least one cycle");
        assert!(cfg.allow_private);
    }

    #[test]
    fn missing_explicit_config_is_error() {
        let err = RelayConfig::load(
            Some(std::path::Path::new("/no/such/file.toml")),
            &CliOverrides::default(),
        );
        assert!(err.is_err());
    }

    #[test]
    fn defaults_are_sane() {
        let cfg = RelayConfig::load(None, &CliOverrides::default()).unwrap();
        assert_eq!(cfg.poll_interval, Duration::from_secs(DEFAULT_POLL_SECS));
        assert_eq!(cfg.refresh_cycles, DEFAULT_REFRESH_CYCLES);
        assert!(!cfg.allow_private);
        assert!(cfg.use_platform_webhooks);
        assert!(cfg.repos.is_empty());
    }
}
