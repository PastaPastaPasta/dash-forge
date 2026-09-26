//! `forge-relay` — the availability-only webhook daemon (PRD 05), for forge-v2 repositories.
//!
//! A maintainer writes a forge-collab `webhook` document (`dg webhook add`) naming a URL, the
//! events it wants, and a relay identity, with the HMAC secret encrypted to that relay's
//! encryption key. A relay started with that identity finds every hook addressed to it
//! (`relay` index), decrypts the secrets in memory, polls those repos' documents (Platform has
//! no document push subscriptions), and POSTs GitHub-shaped `push` / `issues` /
//! `pull_request` / `issue_comment` / `pull_request_review` / `release` / `check_run`
//! webhooks, signed with `X-Hub-Signature-256`. Relays are interchangeable: re-pointing a hook
//! at another relay is one document. Consumers re-fetch and verify from Platform, so a relay
//! is trusted for availability only.
//!
//! forge-v1 repositories (one contract each) are read-only and not served.
//!
//! Module map:
//!  * [`config`] — TOML + CLI configuration.
//!  * [`subscriptions`] — discovery of the `webhook` documents addressed to this relay.
//!  * [`ingest`] — per-repo streams, cursors, and document → event translation.
//!  * [`payload`] — GitHub-shape payload construction (pure, unit-tested).
//!  * [`deliver`] — HMAC-SHA256 signing, retry/backoff, per-host bounds, dead-letter.
//!  * [`ssrf`] — delivery-target SSRF guard.
//!  * [`daemon`] — the discover → poll → translate → deliver loop.
//!  * [`health`] — optional liveness listener.

mod config;
mod daemon;
mod deliver;
mod error;
mod health;
mod ingest;
mod payload;
mod ssrf;
mod subscriptions;

use std::path::PathBuf;

use clap::Parser;

use crate::config::{CliOverrides, RelayConfig};

/// forge-relay command-line interface.
#[derive(Debug, Parser)]
#[command(
    name = "forge-relay",
    version = env!("DASH_FORGE_VERSION"),
    about = "Dash Forge relay daemon"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, clap::Subcommand)]
enum Command {
    /// Run the relay daemon (discover hooks → poll repos → deliver GitHub-shape webhooks).
    Run(RunArgs),
}

/// `forge-relay run` arguments (all override the config file).
#[derive(Debug, Parser)]
struct RunArgs {
    /// Path to the relay configuration file (TOML). Optional.
    #[arg(long = "config", short = 'c')]
    config: Option<PathBuf>,

    /// Path to the relay identity (bridge-format JSON). Its id selects the webhooks addressed
    /// to this relay and its ENCRYPTION key decrypts their secrets. Mount it read-only; the
    /// relay never signs or spends.
    #[arg(long)]
    identity: Option<PathBuf>,

    /// Serve only these repos (comma-separated `owner/name` or repo ids). Default: every
    /// repo with a hook addressed to this relay.
    #[arg(long, value_delimiter = ',')]
    repos: Vec<String>,

    /// Poll interval in seconds (default 15).
    #[arg(long = "poll-interval")]
    poll_interval: Option<u64>,

    /// Re-read the webhook documents every N poll cycles (default 4).
    #[arg(long = "refresh-cycles")]
    refresh_cycles: Option<u64>,

    /// Dash network.
    #[arg(long, value_enum)]
    network: Option<NetworkArg>,

    /// Devnet name (e.g. `moutai`); implies `--network devnet`.
    #[arg(long = "devnet-name")]
    devnet_name: Option<String>,

    /// Devnet DAPI addresses, comma-separated `host[:port]` (default port 1443). Defaults
    /// to the list in `forge-contracts/deployments/devnet-<name>.json`.
    #[arg(long = "dapi-addresses")]
    dapi_addresses: Option<String>,

    /// Allow delivery to private/loopback/link-local targets (LOCAL TESTING ONLY: a public
    /// relay with this flag lets any maintainer of any repo probe its network).
    #[arg(long)]
    allow_private: bool,

    /// Deliver the last N pre-existing documents per stream at startup (default 0 = start
    /// from now).
    #[arg(long)]
    lookback: Option<u32>,

    /// Bind address for the optional health/liveness listener (e.g. 127.0.0.1:8080).
    #[arg(long)]
    listen: Option<String>,

    /// forge-web base URL for synthesized html_url / compare links.
    #[arg(long = "web-base-url")]
    web_base_url: Option<String>,
}

#[derive(Debug, Clone, Copy, clap::ValueEnum)]
enum NetworkArg {
    Testnet,
    Mainnet,
    Devnet,
}

impl NetworkArg {
    fn kind(self) -> &'static str {
        match self {
            NetworkArg::Testnet => "testnet",
            NetworkArg::Mainnet => "mainnet",
            NetworkArg::Devnet => "devnet",
        }
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let cli = Cli::parse();
    match cli.command {
        Command::Run(args) => run(args).await,
    }
}

async fn run(args: RunArgs) -> anyhow::Result<()> {
    let overrides = CliOverrides {
        network: forge_core::network::NetworkSettings::from_flags(
            args.network.map(|n| n.kind().to_string()),
            args.devnet_name,
            args.dapi_addresses,
        ),
        identity: args.identity,
        repos: (!args.repos.is_empty()).then_some(args.repos),
        poll_interval_secs: args.poll_interval,
        refresh_cycles: args.refresh_cycles,
        allow_private: args.allow_private.then_some(true),
        lookback: args.lookback,
        listen: args.listen,
        web_base_url: args.web_base_url,
    };

    let cfg = RelayConfig::load(args.config.as_deref(), &overrides)?;
    if cfg.allow_private {
        tracing::warn!(
            "--allow-private: delivering to private and loopback addresses (local testing only)"
        );
    }
    daemon::run(cfg).await?;
    Ok(())
}
