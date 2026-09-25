//! `~/.config/dash-forge/config.toml` — the persisted CLI configuration.
//!
//! Records the default network and default identity so subsequent commands run without
//! repeating `--network` / `--identity`. Written by `dg auth login`; read by every
//! command's context resolution ([`crate::context`]).
//!
//! ```toml
//! network = "devnet"            # testnet | mainnet | devnet
//! devnet_name = "moutai"        # devnet only
//! dapi_addresses = "68.67.122.254,68.67.122.207"   # devnet only; default: deployments file
//! registry_contract_id = "…"    # optional override of deployments/<network>.json
//! ```

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

/// The persisted CLI configuration.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Config {
    /// Default network (`testnet` / `mainnet` / `devnet`). Overridden by `--network`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub network: Option<String>,
    /// Devnet name (`moutai`) when `network = "devnet"`. Overridden by `--devnet-name`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub devnet_name: Option<String>,
    /// Comma-separated devnet DAPI addresses. Overridden by `--dapi-addresses`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dapi_addresses: Option<String>,
    /// Registry contract id override for `network` (default: the embedded
    /// `forge-contracts/deployments/<network>.json`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub registry_contract_id: Option<String>,
    /// Absolute path to the default identity file. Overridden by `--identity` / `DASH_FORGE_KEY`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_identity: Option<String>,
    /// Base58 id of the default identity (for display in `auth status`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_identity_id: Option<String>,
}

/// The `~/.config/dash-forge` directory (honoring `$HOME`).
pub fn config_dir() -> Result<PathBuf> {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .context("HOME is not set; cannot locate ~/.config/dash-forge")?;
    Ok(home.join(".config/dash-forge"))
}

/// The `config.toml` path.
pub fn config_path() -> Result<PathBuf> {
    Ok(config_dir()?.join("config.toml"))
}

/// The per-network identity import directory (`identities/<network>/`).
pub fn identities_dir(network: &str) -> Result<PathBuf> {
    Ok(config_dir()?.join("identities").join(network))
}

impl Config {
    /// This config's network settings, as one layer for [`forge_core::network`] resolution.
    pub fn network_settings(&self) -> forge_core::network::NetworkSettings {
        forge_core::network::NetworkSettings {
            network: self.network.clone(),
            devnet_name: self.devnet_name.clone(),
            dapi_addresses: self.dapi_addresses.clone(),
            quorum_base_url: None,
            registry: self.registry_contract_id.clone().map(|id| {
                forge_core::network::Registry::override_from(id, "config registry_contract_id")
            }),
        }
    }

    /// Load the config from `config.toml`, returning [`Config::default`] when absent.
    pub fn load() -> Result<Self> {
        let path = config_path()?;
        Self::load_from(&path)
    }

    /// Load the config from an explicit path (returns default when the file is absent).
    pub fn load_from(path: &Path) -> Result<Self> {
        if !path.exists() {
            return Ok(Self::default());
        }
        let raw = std::fs::read_to_string(path)
            .with_context(|| format!("reading config {}", path.display()))?;
        toml::from_str(&raw).with_context(|| format!("parsing config {}", path.display()))
    }

    /// Persist the config to `config.toml`, creating the directory if needed.
    pub fn save(&self) -> Result<()> {
        let path = config_path()?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating {}", parent.display()))?;
        }
        let raw = toml::to_string_pretty(self).context("serializing config")?;
        std::fs::write(&path, raw).with_context(|| format!("writing config {}", path.display()))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::Config;

    #[test]
    fn absent_config_loads_as_default() {
        let cfg = Config::load_from(std::path::Path::new(
            "/nonexistent/definitely/not/here/config.toml",
        ))
        .unwrap();
        assert!(cfg.network.is_none());
        assert!(cfg.default_identity.is_none());
    }

    #[test]
    fn config_round_trips_through_toml() {
        let dir = std::env::temp_dir().join(format!("dg-cfg-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("config.toml");

        let cfg = Config {
            network: Some("testnet".into()),
            default_identity: Some("/home/u/.config/dash-forge/identities/testnet/x.json".into()),
            default_identity_id: Some("abc123".into()),
            ..Default::default()
        };
        let raw = toml::to_string_pretty(&cfg).unwrap();
        std::fs::write(&path, raw).unwrap();

        let loaded = Config::load_from(&path).unwrap();
        assert_eq!(loaded.network.as_deref(), Some("testnet"));
        assert_eq!(loaded.default_identity_id.as_deref(), Some("abc123"));
        assert!(loaded.default_identity.unwrap().ends_with("x.json"));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn config_skips_none_fields_in_toml() {
        let cfg = Config {
            network: Some("mainnet".into()),
            ..Default::default()
        };
        let raw = toml::to_string_pretty(&cfg).unwrap();
        assert!(raw.contains("network"));
        assert!(!raw.contains("default_identity"));
        assert!(!raw.contains("devnet_name"));
    }

    #[test]
    fn devnet_config_parses_into_a_network_layer() {
        let cfg: Config = toml::from_str(
            "network = \"devnet\"\ndevnet_name = \"moutai\"\n\
             dapi_addresses = \"10.0.0.1\"\nregistry_contract_id = \"REG\"\n",
        )
        .unwrap();
        let target = cfg.network_settings().resolve().unwrap();
        assert_eq!(target.network.key(), "devnet-moutai");
        let registry = target.require_registry().unwrap();
        assert_eq!(registry.contract_id, "REG");
        assert_eq!(
            registry.source.to_string(),
            "override (config registry_contract_id)"
        );
    }
}
