//! Command execution context: global-flag + config resolution, connection helpers,
//! confirmation prompts, JSON/human output, and actionable error mapping.

use std::io::{IsTerminal, Write};
use std::path::PathBuf;

use anyhow::{anyhow, bail, Context as _, Result};
use serde_json::{json, Value};

use forge_core::keystore::BridgeIdentity;
use forge_core::platform::{LoadedIdentity, Network, PlatformClient};

use crate::config::Config;
use crate::Cli;

/// The resolved runtime context for one `dg` invocation.
pub struct Ctx {
    /// Emit machine-readable JSON instead of human output.
    pub json: bool,
    /// Skip confirmation prompts (automation / CI).
    pub yes: bool,
    /// The resolved network.
    pub network: Network,
    /// The resolved identity file path (from `--identity` / `DASH_FORGE_KEY` / config), if any.
    pub identity_path: Option<PathBuf>,
}

/// Map the CLI network enum to the forge-core network.
fn to_core_network(n: crate::NetworkArg) -> Network {
    match n {
        crate::NetworkArg::Testnet => Network::Testnet,
        crate::NetworkArg::Mainnet => Network::Mainnet,
    }
}

/// The lowercase network label used in JSON / config.
pub fn network_label(n: Network) -> &'static str {
    match n {
        Network::Testnet => "testnet",
        Network::Mainnet => "mainnet",
        Network::Devnet => "devnet",
    }
}

impl Ctx {
    /// Resolve the context from parsed CLI flags and the persisted config.
    ///
    /// Precedence — network: `--network` > config > `DASH_FORGE_NETWORK` env > testnet.
    /// Identity: `--identity` > `DASH_FORGE_KEY` env > config default.
    pub fn resolve(cli: &Cli, config: &Config) -> Self {
        let network = if let Some(n) = cli.network {
            to_core_network(n)
        } else if let Some(n) = config.network.as_deref() {
            match n {
                "mainnet" => Network::Mainnet,
                "devnet" => Network::Devnet,
                _ => Network::Testnet,
            }
        } else {
            match std::env::var("DASH_FORGE_NETWORK").as_deref() {
                Ok("mainnet") => Network::Mainnet,
                Ok("devnet") => Network::Devnet,
                _ => Network::Testnet,
            }
        };

        let identity_path = cli
            .identity
            .clone()
            .or_else(|| std::env::var_os("DASH_FORGE_KEY").map(PathBuf::from))
            .or_else(|| config.default_identity.as_deref().map(PathBuf::from));

        Self {
            json: cli.json,
            yes: cli.yes,
            network,
            identity_path,
        }
    }

    /// The resolved identity path, or an actionable error explaining how to set one.
    pub fn require_identity_path(&self) -> Result<&PathBuf> {
        self.identity_path.as_ref().ok_or_else(|| {
            anyhow!(
                "no identity configured — pass --identity <file>, set DASH_FORGE_KEY, or run \
                 `dg auth login --identity <file>` to set a default"
            )
        })
    }

    /// Load the signing identity (bridge-format key material) from the resolved path.
    pub fn load_bridge(&self) -> Result<BridgeIdentity> {
        let path = self.require_identity_path()?;
        BridgeIdentity::load_from_file(path)
            .with_context(|| format!("loading identity from {}", path.display()))
    }

    /// Connect to the resolved network.
    pub async fn connect(&self) -> Result<PlatformClient> {
        PlatformClient::connect(self.network)
            .await
            .context("connecting to Dash Platform")
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
        if self.json {
            bail!("refusing to run a cost-bearing command in --json mode without --yes");
        }
        if !std::io::stdin().is_terminal() {
            bail!(
                "refusing to run a cost-bearing command on a non-interactive stdin without --yes"
            );
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

    /// Print a `--json` value (pretty) or a human closure's output, choosing by mode.
    #[allow(clippy::needless_pass_by_value)]
    pub fn emit(&self, value: Value, human: impl FnOnce()) {
        if self.json {
            println!(
                "{}",
                serde_json::to_string_pretty(&value).unwrap_or_else(|_| value.to_string())
            );
        } else {
            human();
        }
    }
}

/// Render a top-level command error as an actionable message (human) or a structured
/// `{"error": …}` object (`--json`), enriching the known forge-core error classes with
/// remediation hints (funding bridge, token requirement).
pub fn report_error(json: bool, err: &anyhow::Error) {
    let hint = actionable_hint(err);
    // Alternate Display (`{:#}`) renders the full anyhow context chain (`outer: cause: …`),
    // which is what makes an error actionable.
    let message = format!("{err:#}");
    if json {
        let obj = json!({
            "error": message,
            "hint": hint,
        });
        println!(
            "{}",
            serde_json::to_string_pretty(&obj).unwrap_or_else(|_| obj.to_string())
        );
    } else {
        eprintln!("error: {message}");
        if let Some(h) = hint {
            eprintln!("  hint: {h}");
        }
    }
}

/// Map a known forge-core error class to a remediation hint.
fn actionable_hint(err: &anyhow::Error) -> Option<String> {
    use forge_core::error::Error as CoreError;
    let core = err.downcast_ref::<CoreError>()?;
    Some(match core {
        CoreError::InsufficientCredits { .. } => {
            "top up the identity's credits via the funding bridge / testnet faucet \
             (https://bridge.thepasta.org), then retry"
                .to_string()
        }
        CoreError::Unauthorized => {
            "this action needs a WRITE (push/upload) or MAINTAIN (releases/config) token — \
             ask the repo owner to grant it with `dg collab add`"
                .to_string()
        }
        CoreError::TokenFrozen => {
            "this identity's access has been suspended (token frozen); ask the repo owner to \
             `dg collab` unsuspend it"
                .to_string()
        }
        CoreError::NotFound => {
            "not found — check the owner/name or that the repo exists".to_string()
        }
        CoreError::Timeout { retryable: true } => {
            "timed out; the signed transition may still land — retry".to_string()
        }
        _ => return None,
    })
}
