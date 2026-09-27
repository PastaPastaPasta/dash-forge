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
    /// The resolved network and the forge-v2 contracts deployed on it.
    pub target: NetworkTarget,
    /// The resolved identity file path (from `--identity` / `DASH_FORGE_KEY` / config), if any.
    pub identity_path: Option<PathBuf>,
    /// `--identity` as given on the command line (not the environment or the default).
    pub cli_identity: Option<PathBuf>,
    /// Whether stdin is a terminal (a prompt can be answered).
    pub stdin_tty: bool,
}

/// Why a confirmation prompt cannot be asked, or `None` when it can (or `--yes` answers it).
fn prompt_blocker(yes: bool, json: bool, stdin_tty: bool) -> Option<&'static str> {
    if yes {
        None
    } else if json {
        Some("--json mode cannot prompt")
    } else if !stdin_tty {
        Some("stdin is not a terminal")
    } else {
        None
    }
}

/// Stack the network layers in `dg`'s precedence order and resolve them.
///
/// Precedence, field by field: flags (`--network` / `--devnet-name` / `--dapi-addresses`) >
/// config file > environment (`DASH_FORGE_NETWORK`, `DASH_FORGE_DEVNET_NAME`,
/// `DASH_FORGE_DAPI_ADDRESSES`) > the embedded
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
            cli_identity: cli.identity.clone(),
            stdin_tty: std::io::stdin().is_terminal(),
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
                .fix("`dg auth new` creates an identity; `dg auth login <file>` (or `--mnemonic`) signs in with one")
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
        self.ask(prompt, false)
    }

    /// [`Self::confirm`] for a question whose empty answer is yes (`[Y/n]`); a "no" is the
    /// E803 cancellation.
    pub fn proceed(&self, prompt: &str) -> Result<()> {
        if self.ask(prompt, true)? {
            Ok(())
        } else {
            Err(crate::errors::cancelled())
        }
    }

    /// Whether prompt flows may ask questions: stdin is a terminal and neither `--yes` nor
    /// `--json` was given (UX spec §7.1).
    pub fn interactive(&self) -> bool {
        !self.yes && !self.json && self.stdin_tty
    }

    /// E802 up front, for a command (`what`) that will ask before it spends: when the answer
    /// could not be given (no `--yes`, and `--json` or a stdin that is not a terminal), stop
    /// before any identity load, network read or plan output, not at the prompt.
    pub fn require_confirmable(&self, what: &str) -> Result<()> {
        match prompt_blocker(self.yes, self.json, self.stdin_tty) {
            None => Ok(()),
            Some(why) => Err(
                UserError::new(codes::CONFIRMATION_REQUIRED, "confirmation required")
                    .cause(format!(
                        "{what} asks for confirmation before it spends, and {why}"
                    ))
                    .fix("pass --yes (-y) to confirm without a prompt, as scripts and CI must")
                    .fix("run it in a terminal to review the plan and answer the prompt")
                    .note("nothing was written")
                    .into(),
            ),
        }
    }

    fn ask(&self, prompt: &str, default_yes: bool) -> Result<bool> {
        if self.yes {
            return Ok(true);
        }
        if let Some(why) = prompt_blocker(self.yes, self.json, self.stdin_tty) {
            return Err(
                UserError::new(codes::CONFIRMATION_REQUIRED, "confirmation required")
                    .cause(format!("{prompt} — and {why}"))
                    .fix("check the estimate, then run the same command with --yes")
                    .note("nothing was written")
                    .into(),
            );
        }
        eprint!("{prompt} {} ", if default_yes { "[Y/n]" } else { "[y/N]" });
        std::io::stderr().flush().ok();
        let mut line = String::new();
        if std::io::stdin()
            .read_line(&mut line)
            .context("reading confirmation")?
            == 0
        {
            // EOF (Ctrl-D) is never a yes.
            return Ok(false);
        }
        Ok(match line.trim().to_ascii_lowercase().as_str() {
            "" => default_yes,
            answer => matches!(answer, "y" | "yes"),
        })
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
impl Ctx {
    /// A `Ctx` for devnet moutai (forge-v2 deployed) as a script would run it, for tests.
    pub(crate) fn scripted(
        yes: bool,
        json: bool,
        stdin_tty: bool,
        identity_path: Option<PathBuf>,
    ) -> Self {
        let flags = NetworkSettings::from_flags(None, Some("moutai".into()), None);
        Self {
            json,
            yes,
            target: resolve_target(flags, &Config::default(), NetworkSettings::default()).unwrap(),
            identity_path,
            cli_identity: None,
            stdin_tty,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn prompts_need_yes_unless_a_terminal_can_answer() {
        assert_eq!(prompt_blocker(true, true, false), None);
        assert_eq!(prompt_blocker(false, false, true), None);
        assert_eq!(
            prompt_blocker(false, false, false),
            Some("stdin is not a terminal")
        );
        assert_eq!(
            prompt_blocker(false, true, true),
            Some("--json mode cannot prompt")
        );
    }

    fn scripted_ctx(yes: bool, json: bool, stdin_tty: bool) -> Ctx {
        Ctx::scripted(yes, json, stdin_tty, None)
    }

    #[test]
    fn require_confirmable_names_yes_when_it_refuses() {
        assert!(scripted_ctx(true, false, false)
            .require_confirmable("`dg init`")
            .is_ok());
        assert!(scripted_ctx(false, false, true)
            .require_confirmable("`dg init`")
            .is_ok());
        let err = scripted_ctx(false, false, false)
            .require_confirmable("`dg init`")
            .unwrap_err();
        let u = forge_core::user_error::classify(
            err.chain(),
            &forge_core::user_error::ErrorContext::default(),
        );
        assert_eq!((u.code, u.exit_code()), ("E802", 8));
        assert!(u
            .cause
            .as_deref()
            .unwrap()
            .contains("stdin is not a terminal"));
        assert!(u.fix[0].contains("--yes"), "{:?}", u.fix);
        assert_eq!(u.note.as_deref(), Some("nothing was written"));
    }

    #[test]
    fn devnet_name_flag_overrides_a_testnet_config() {
        let flags = NetworkSettings::from_flags(None, Some("moutai".into()), None);
        let t = resolve_target(flags, &config("testnet"), NetworkSettings::default()).unwrap();
        assert_eq!(t.network.key(), "devnet-moutai");
    }
}
