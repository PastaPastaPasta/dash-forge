//! Command execution context: global-flag + config resolution, connection helpers,
//! confirmation prompts and JSON/human output. Errors are rendered by [`crate::errors`].

use std::io::{IsTerminal, Write};
use std::path::PathBuf;

use anyhow::{Context as _, Result};
use serde_json::Value;

use forge_core::keystore::BridgeIdentity;
use forge_core::network::{NetworkSettings, NetworkTarget};
use forge_core::platform::{LoadedIdentity, Network, PlatformClient};
use forge_core::user_error::{codes, UserError};

use crate::config::Config;
use crate::Cli;

/// The resolved runtime context for one `dg` invocation.
pub struct Ctx {
    /// Emit machine-readable JSON instead of human output.
    pub json: bool,
    /// Skip confirmation prompts (automation / CI).
    pub yes: bool,
    /// The resolved network and the registry to use on it.
    pub target: NetworkTarget,
    /// The resolved identity file path (from `--identity` / `DASH_FORGE_KEY` / config), if any.
    pub identity_path: Option<PathBuf>,
}

/// Stack the network layers in `dg`'s precedence order and resolve them.
///
/// Precedence, field by field: flags (`--network` / `--devnet-name` / `--dapi-addresses`) >
/// config file > environment (`DASH_FORGE_NETWORK`, `DASH_FORGE_DEVNET_NAME`,
/// `DASH_FORGE_DAPI_ADDRESSES`, `FORGE_REGISTRY_CONTRACT_ID`) > the embedded
/// `forge-contracts/deployments/<network>.json` > testnet. A lower layer that names a
/// different network contributes nothing network-specific (see `NetworkSettings::overlay`).
fn resolve_target(
    flags: NetworkSettings,
    config: &Config,
    env: NetworkSettings,
) -> Result<NetworkTarget> {
    Ok(flags
        .overlay(config.network_settings())
        .overlay(env)
        .resolve()?)
}

impl Ctx {
    /// Resolve the context from parsed CLI flags and the persisted config.
    ///
    /// Network: see [`resolve_target`]. Identity: `--identity` > `DASH_FORGE_KEY` env >
    /// config default.
    pub fn resolve(cli: &Cli, config: &Config) -> Result<Self> {
        let flags = NetworkSettings::from_flags(
            cli.network.map(|n| n.kind().to_string()),
            cli.devnet_name.clone(),
            cli.dapi_addresses.clone(),
        );
        let target = resolve_target(flags, config, NetworkSettings::from_env())
            .context("resolving the network (--network / --devnet-name / config.toml)")?;

        if cli
            .identity
            .as_deref()
            .is_some_and(forge_core::keystore::is_inline_key)
        {
            tracing::warn!("{}", forge_core::keystore::INLINE_KEY_ON_ARGV);
        }
        let identity_path = cli
            .identity
            .clone()
            .or_else(|| std::env::var_os("DASH_FORGE_KEY").map(PathBuf::from))
            .or_else(|| config.default_identity.as_deref().map(PathBuf::from));

        Ok(Self {
            json: cli.json,
            yes: cli.yes,
            target,
            identity_path,
        })
    }

    /// The resolved network.
    pub fn network(&self) -> &Network {
        &self.target.network
    }

    /// The network label used in JSON / output: `testnet`, `mainnet` or `devnet-<name>`.
    pub fn network_label(&self) -> String {
        self.target.network.key()
    }

    /// The resolved identity path, or an actionable error explaining how to set one.
    pub fn require_identity_path(&self) -> Result<&PathBuf> {
        self.identity_path.as_ref().ok_or_else(|| {
            UserError::new(codes::NO_IDENTITY, "no identity configured")
                .cause("this command signs with an identity, and none was given or set as the default")
                .fix("`dg auth login --identity <file>` (the bridge identity export) to set a default")
                .fix("or pass --identity <file>, or set DASH_FORGE_KEY=<file>")
                .into()
        })
    }

    /// Load the signing identity (bridge-format key material) from the resolved path.
    pub fn load_bridge(&self) -> Result<BridgeIdentity> {
        let path = self.require_identity_path()?;
        BridgeIdentity::load_from_file(path).with_context(|| {
            format!(
                "loading identity from {}",
                forge_core::keystore::describe_key_source(path)
            )
        })
    }

    /// Connect to the resolved network.
    pub async fn connect(&self) -> Result<PlatformClient> {
        PlatformClient::connect(self.target.clone())
            .await
            .with_context(|| format!("connecting to Dash Platform ({})", self.target.network))
    }

    /// Connect and fetch the signing identity in one step (the common preamble for
    /// mutating commands).
    pub async fn connect_with_identity(
        &self,
    ) -> Result<(PlatformClient, BridgeIdentity, LoadedIdentity)> {
        let bridge = self.load_bridge()?;
        let client = self.connect().await?;
        let identity = client
            .fetch_identity(&bridge.identity_id)
            .await
            .context("fetching the signing identity")?;
        Ok((client, bridge, identity))
    }

    /// Ask the user to confirm a cost-bearing / destructive action.
    ///
    /// `--yes` short-circuits to `true`. In `--json` mode a prompt is impossible, so an
    /// un-confirmed cost-bearing action is refused (pass `--yes` for automation). A
    /// non-interactive stdin (piped / CI without `--yes`) is likewise refused rather than
    /// silently proceeding.
    pub fn confirm(&self, prompt: &str) -> Result<bool> {
        if self.yes {
            return Ok(true);
        }
        let no_prompt = |why: &str| -> anyhow::Error {
            UserError::new(codes::CONFIRMATION_REQUIRED, "confirmation required")
                .cause(format!("{prompt} — and {why}"))
                .fix("check the estimate, then run the same command with --yes")
                .note("nothing was written")
                .into()
        };
        if self.json {
            return Err(no_prompt("--json mode cannot prompt"));
        }
        if !std::io::stdin().is_terminal() {
            return Err(no_prompt("stdin is not a terminal"));
        }
        eprint!("{prompt} [y/N] ");
        std::io::stderr().flush().ok();
        let mut line = String::new();
        std::io::stdin()
            .read_line(&mut line)
            .context("reading confirmation")?;
        Ok(matches!(
            line.trim().to_ascii_lowercase().as_str(),
            "y" | "yes"
        ))
    }

    /// [`Self::confirm`], turning a "no" into the E803 cancellation.
    pub fn confirm_or_cancel(&self, prompt: &str) -> Result<()> {
        if self.confirm(prompt)? {
            Ok(())
        } else {
            Err(crate::errors::cancelled())
        }
    }

    /// Print a `--json` value (pretty) or a human closure's output, choosing by mode.
    #[allow(clippy::needless_pass_by_value)]
    pub fn emit(&self, value: Value, human: impl FnOnce()) {
        if self.json {
            crate::errors::print_json(&value);
        } else {
            human();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use forge_core::network::{ContractSource, Registry};

    fn config(network: &str) -> Config {
        Config {
            network: Some(network.into()),
            ..Default::default()
        }
    }

    #[test]
    fn flags_beat_config_beat_env() {
        let env = NetworkSettings {
            network: Some("mainnet".into()),
            ..Default::default()
        };
        // Config wins over env.
        let t =
            resolve_target(NetworkSettings::default(), &config("testnet"), env.clone()).unwrap();
        assert_eq!(t.network, Network::Testnet);
        // Env applies when nothing above sets a network.
        let t = resolve_target(NetworkSettings::default(), &Config::default(), env).unwrap();
        assert_eq!(t.network, Network::Mainnet);
        // A flag wins over config.
        let flags = NetworkSettings::from_flags(Some("mainnet".into()), None, None);
        let t = resolve_target(flags, &config("testnet"), NetworkSettings::default()).unwrap();
        assert_eq!(t.network, Network::Mainnet);
    }

    #[test]
    fn devnet_name_flag_overrides_a_testnet_config() {
        let flags = NetworkSettings::from_flags(None, Some("moutai".into()), None);
        let t = resolve_target(flags, &config("testnet"), NetworkSettings::default()).unwrap();
        assert_eq!(t.network.key(), "devnet-moutai");
    }

    #[test]
    fn env_registry_override_beats_the_deployment_but_not_config() {
        let env = NetworkSettings {
            registry: Some(Registry::override_from(
                "ENVREG",
                "env FORGE_REGISTRY_CONTRACT_ID",
            )),
            ..Default::default()
        };
        let t =
            resolve_target(NetworkSettings::default(), &Config::default(), env.clone()).unwrap();
        assert_eq!(t.require_registry().unwrap().contract_id, "ENVREG");

        let cfg = Config {
            registry_contract_id: Some("CFGREG".into()),
            ..Default::default()
        };
        let t = resolve_target(NetworkSettings::default(), &cfg, env).unwrap();
        assert_eq!(t.require_registry().unwrap().contract_id, "CFGREG");
    }

    #[test]
    fn a_configured_testnet_registry_does_not_follow_network_mainnet() {
        let cfg = Config {
            network: Some("testnet".into()),
            registry_contract_id: Some("TESTREG".into()),
            ..Default::default()
        };
        let flags = NetworkSettings::from_flags(Some("mainnet".into()), None, None);
        let t = resolve_target(flags, &cfg, NetworkSettings::default()).unwrap();
        assert_eq!(t.network, Network::Mainnet);
        assert!(
            t.registry.is_none()
                || matches!(
                    t.registry.as_ref().unwrap().source,
                    ContractSource::Deployment(_)
                )
        );
    }
}
