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
    /// The default key source: an identity file path, or `keychain:dash-forge/<network>/<id>`
    /// (written by `dg auth new` / `dg auth login`). Overridden by `--identity` /
    /// `DASH_FORGE_KEY`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_identity: Option<String>,
    /// Base58 id of the default identity (for display in `auth status`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_identity_id: Option<String>,
}

/// The config directory: `$XDG_CONFIG_HOME/dash-forge`, else `~/.config/dash-forge`.
pub fn config_dir() -> Result<PathBuf> {
    forge_core::keystore::forge_config_dir()
        .context("neither XDG_CONFIG_HOME nor HOME is set; cannot locate the dash-forge config")
}

/// The `config.toml` path.
pub fn config_path() -> Result<PathBuf> {
    Ok(config_dir()?.join("config.toml"))
}

impl Config {
    /// This config's network settings, as one layer for [`forge_core::network`] resolution.
    pub fn network_settings(&self) -> forge_core::network::NetworkSettings {
        forge_core::network::NetworkSettings {
            network: self.network.clone(),
            devnet_name: self.devnet_name.clone(),
            dapi_addresses: self.dapi_addresses.clone(),
            quorum_base_url: None,
        }
    }

    /// Load the config from `config.toml`, returning [`Config::default`] when absent.
    pub fn load() -> Result<Self> {
        let path = config_path()?;
        Self::load_from(&path)
    }

    /// Load the config from an explicit path (returns default when the file is absent). A
    /// file that does not parse is E204 naming its line and column, never the defaults: those
    /// would quietly switch to testnet and forget the signed-in identity.
    pub fn load_from(path: &Path) -> Result<Self> {
        let raw = match std::fs::read_to_string(path) {
            Ok(raw) => raw,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Self::default()),
            Err(e) => return Err(forge_core::config_file::config_read_error(path, &e).into()),
        };
        toml::from_str(&raw)
            .map_err(|e| forge_core::config_file::config_toml_error(path, &raw, &e).into())
    }

    /// Persist the config to `config.toml`, creating the directory if needed.
    pub fn save(&self) -> Result<()> {
        let path = config_path()?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating {}", parent.display()))?;
        }
        let raw = toml::to_string_pretty(self).context("serializing config")?;
        // Atomic replace: git-remote-dash reads the default key source from this file.
        forge_core::keystore::write_private_file(&path, raw.as_bytes())
            .with_context(|| format!("writing config {}", path.display()))?;
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
    fn a_config_that_does_not_parse_is_e204_naming_the_line() {
        // D-405: this used to fall back to the defaults (testnet, no identity) silently.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        std::fs::write(
            &path,
            "network = \"devnet\"\ndevnet_name = \"moutai\"\ndefault_identity = \n",
        )
        .unwrap();
        let err = Config::load_from(&path).unwrap_err();
        let u = forge_core::user_error::classify(
            err.chain(),
            &forge_core::user_error::ErrorContext::default(),
        );
        assert_eq!(u.code, "E204");
        let cause = u.cause.unwrap_or_default();
        assert!(
            cause.starts_with(&format!("{}: line 3, column 20: ", path.display())),
            "{cause}"
        );
        assert!(u.fix[0].contains("fix line 3 of"), "{:?}", u.fix);
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
             dapi_addresses = \"10.0.0.1\"\n",
        )
        .unwrap();
        let target = cfg.network_settings().resolve().unwrap();
        assert_eq!(target.network.key(), "devnet-moutai");
        assert!(target.require_v2().is_ok());
    }

    #[test]
    fn an_old_registry_key_is_ignored() {
        let cfg: Config =
            toml::from_str("network = \"testnet\"\nregistry_contract_id = \"REG\"\n").unwrap();
        assert_eq!(cfg.network.as_deref(), Some("testnet"));
    }
}
