//! Relay configuration: a TOML file overlaid with CLI flags (PRD 05 §Deployment —
//! "config = relay identity key + network").
//!
//! The daemon is stateless; all durable subscription state lives on Platform as `webhook`
//! docs. This file only carries operator-local settings: which network, the relay
//! identity, poll cadence, which repo contracts to watch, and the SSRF/secret knobs the
//! encrypted-secret production path is not yet covering (see [`crate::subscriptions`]).

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::Duration;

use serde::Deserialize;

use forge_core::platform::Network;

use crate::error::{RelayError, Result};

/// The default poll interval — the M2 acceptance is push → webhook in < 30 s, so 15 s
/// keeps worst-case latency (≈ poll interval + block time) comfortably under budget.
pub const DEFAULT_POLL_SECS: u64 = 15;

/// A statically-configured webhook (bypasses Platform `webhook` docs). Useful for local
/// testing and for operators who prefer file-based subscriptions; the Platform-doc path
/// (interchangeable instances) is the production default.
#[derive(Debug, Clone, Deserialize)]
pub struct StaticWebhook {
    /// The repo contract id this webhook belongs to (base58).
    pub repo: String,
    /// The delivery URL.
    pub url: String,
    /// The subscribed event names (`push`, `pull_request`, `issue_comment`, `check_run`,
    /// `issues`); empty = all.
    #[serde(default)]
    pub events: Vec<String>,
    /// The HMAC secret (plaintext for local testing).
    pub secret: String,
    /// A stable hook id (used in the delivery-id derivation); defaults to the URL.
    #[serde(default)]
    pub hook_id: Option<String>,
}

/// The on-disk TOML shape (all optional; CLI flags override).
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "kebab-case")]
struct FileConfig {
    network: Option<String>,
    identity: Option<PathBuf>,
    poll_interval_secs: Option<u64>,
    #[serde(default)]
    repos: Vec<String>,
    allow_private: Option<bool>,
    lookback: Option<u32>,
    web_base_url: Option<String>,
    use_platform_webhooks: Option<bool>,
    listen: Option<String>,
    #[serde(default)]
    webhook: Vec<StaticWebhook>,
    /// Secret map for Platform `webhook` docs whose `encryptedSecret` the relay cannot yet
    /// decrypt: `hookId(hex)` or delivery `url` → shared secret (the M2 fallback).
    #[serde(default)]
    secrets: BTreeMap<String, String>,
}

/// The fully-resolved relay configuration.
#[derive(Debug, Clone)]
pub struct RelayConfig {
    /// Target network.
    pub network: Network,
    /// Relay identity file (bridge-format JSON). The relay mostly READS, so its balance
    /// stays tiny; a CI-runner identity that writes `checkRun` docs is separate.
    pub identity_path: Option<PathBuf>,
    /// Poll cadence.
    pub poll_interval: Duration,
    /// Repo contract ids to watch.
    pub repos: Vec<String>,
    /// Whether private/loopback delivery targets are allowed (local testing; the M2 test
    /// delivers to 127.0.0.1).
    pub allow_private: bool,
    /// How many pre-existing docs per type to (re)deliver at startup. `0` = start from
    /// "now" (baseline to the newest doc, deliver nothing historical).
    pub lookback: u32,
    /// forge-web base URL for `html_url`/`compare` synthesis.
    pub web_base_url: String,
    /// Whether to read `webhook` docs from Platform (interchangeable-instance path).
    pub use_platform_webhooks: bool,
    /// Optional health-listener bind address.
    pub listen: Option<String>,
    /// Statically-configured webhooks.
    pub static_webhooks: Vec<StaticWebhook>,
    /// Secret map for Platform webhooks (hookId hex / url → secret).
    pub secrets: BTreeMap<String, String>,
}

/// CLI overrides applied on top of the file config.
#[derive(Debug, Default, Clone)]
pub struct CliOverrides {
    /// `--network`.
    pub network: Option<Network>,
    /// `--identity`.
    pub identity: Option<PathBuf>,
    /// `--repos` (comma-separated contract ids).
    pub repos: Option<Vec<String>>,
    /// `--poll-interval` (seconds).
    pub poll_interval_secs: Option<u64>,
    /// `--allow-private`.
    pub allow_private: Option<bool>,
    /// `--lookback`.
    pub lookback: Option<u32>,
    /// `--listen`.
    pub listen: Option<String>,
    /// `--web-base-url`.
    pub web_base_url: Option<String>,
}

fn parse_network(s: &str) -> Result<Network> {
    match s.to_ascii_lowercase().as_str() {
        "testnet" => Ok(Network::Testnet),
        "mainnet" => Ok(Network::Mainnet),
        "devnet" => Ok(Network::Devnet),
        other => Err(RelayError::Config(format!("unknown network {other:?}"))),
    }
}

impl RelayConfig {
    /// Load from an optional TOML file path, then apply CLI overrides. A missing file is
    /// only an error if a path was explicitly given; the default path missing is fine
    /// (fully CLI-driven operation).
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

        let network = if let Some(n) = cli.network {
            n
        } else if let Some(n) = &file.network {
            parse_network(n)?
        } else {
            Network::Testnet
        };

        let identity_path = cli.identity.clone().or(file.identity);

        let mut repos = cli.repos.clone().unwrap_or(file.repos);
        // Derive watched repos from static webhooks too, so a purely-static setup needs
        // no separate `repos` list.
        for w in &file.webhook {
            if !repos.contains(&w.repo) {
                repos.push(w.repo.clone());
            }
        }

        let poll_interval = Duration::from_secs(
            cli.poll_interval_secs
                .or(file.poll_interval_secs)
                .unwrap_or(DEFAULT_POLL_SECS)
                .max(1),
        );

        Ok(Self {
            network,
            identity_path,
            poll_interval,
            repos,
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
            secrets: file.secrets,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_full_toml() {
        let toml_src = r#"
network = "testnet"
identity = "/tmp/relay.json"
poll-interval-secs = 10
repos = ["AAA", "BBB"]
allow-private = true
lookback = 3
web-base-url = "https://forge.example"
use-platform-webhooks = false

[[webhook]]
repo = "CCC"
url = "http://127.0.0.1:9000/hook"
events = ["push"]
secret = "s3cr3t"

[secrets]
"deadbeef" = "shared"
"#;
        let file: FileConfig = toml::from_str(toml_src).unwrap();
        // Write to a temp file and load through the real path.
        let dir = std::env::temp_dir().join(format!("relay-cfg-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("relay.toml");
        std::fs::write(&path, toml_src).unwrap();

        let cfg = RelayConfig::load(Some(&path), &CliOverrides::default()).unwrap();
        assert_eq!(cfg.network, Network::Testnet);
        assert_eq!(cfg.poll_interval, Duration::from_secs(10));
        // repos includes the static webhook's repo (CCC) plus AAA, BBB.
        assert!(cfg.repos.contains(&"AAA".to_string()));
        assert!(cfg.repos.contains(&"CCC".to_string()));
        assert!(cfg.allow_private);
        assert_eq!(cfg.lookback, 3);
        assert!(!cfg.use_platform_webhooks);
        assert_eq!(cfg.static_webhooks.len(), 1);
        assert_eq!(
            cfg.secrets.get("deadbeef").map(String::as_str),
            Some("shared")
        );
        assert_eq!(file.webhook.len(), 1);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn cli_overrides_win() {
        let cli = CliOverrides {
            network: Some(Network::Mainnet),
            repos: Some(vec!["ZZZ".into()]),
            poll_interval_secs: Some(42),
            allow_private: Some(true),
            ..Default::default()
        };
        let cfg = RelayConfig::load(None, &cli).unwrap();
        assert_eq!(cfg.network, Network::Mainnet);
        assert_eq!(cfg.repos, vec!["ZZZ".to_string()]);
        assert_eq!(cfg.poll_interval, Duration::from_secs(42));
        assert!(cfg.allow_private);
    }

    #[test]
    fn missing_explicit_config_is_error() {
        let cli = CliOverrides::default();
        let err = RelayConfig::load(Some(std::path::Path::new("/no/such/file.toml")), &cli);
        assert!(err.is_err());
    }

    #[test]
    fn defaults_are_sane() {
        let cfg = RelayConfig::load(None, &CliOverrides::default()).unwrap();
        assert_eq!(cfg.network, Network::Testnet);
        assert_eq!(cfg.poll_interval, Duration::from_secs(DEFAULT_POLL_SECS));
        assert!(!cfg.allow_private);
        assert!(cfg.use_platform_webhooks);
    }
}
