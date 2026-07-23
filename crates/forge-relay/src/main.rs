//! `forge-relay` — the availability-only webhook daemon (PRD 05).
//!
//! Anyone can run a relay: it polls the watched repo contracts for new documents
//! (Platform has no document push subscriptions — spike S0.8) and translates state
//! transitions into GitHub-compatible webhooks (`push` / `pull_request` / `issue_comment`
//! / `check_run`) so existing CI tooling (Blacksmith/Depot/Jenkins/GitHub Actions runners)
//! integrates with near-zero work. Payload consumers re-fetch and verify from Platform, so
//! relay instances are interchangeable and integrity-irrelevant; the subscription lives on
//! Platform as a `webhook` doc addressed to a relay identity, so pointing a repo at a
//! different relay is a single doc update.
//!
//! Module map:
//!  * [`config`] — TOML + CLI configuration.
//!  * [`payload`] — GitHub-shape payload construction (pure, unit-tested).
//!  * [`ingest`] — cursor-based polling + document → event translation.
//!  * [`subscriptions`] — `webhook` doc resolution (Platform + static) and secrets.
//!  * [`deliver`] — HMAC-SHA256 signing, retry/backoff, dead-letter.
//!  * [`ssrf`] — delivery-target SSRF guard.
//!  * [`daemon`] — the poll → translate → deliver loop.
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

use forge_core::platform::Network;

use crate::config::{CliOverrides, RelayConfig};

/// forge-relay command-line interface.
#[derive(Debug, Parser)]
#[command(name = "forge-relay", version, about = "Dash Forge relay daemon")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, clap::Subcommand)]
enum Command {
    /// Run the relay daemon (poll watched repos → deliver GitHub-shape webhooks).
    Run(RunArgs),
}

/// `forge-relay run` arguments (all override the config file).
#[derive(Debug, Parser)]
struct RunArgs {
    /// Path to the relay configuration file (TOML). Optional — the relay can run purely
    /// from CLI flags.
    #[arg(long = "config", short = 'c')]
    config: Option<PathBuf>,

    /// Path to the relay identity (bridge-format JSON). Its identity id is used to filter
    /// on-Platform `webhook` docs addressed to this relay; the relay never needs its keys
    /// for delivery (it only READS on-chain).
    #[arg(long)]
    identity: Option<PathBuf>,

    /// Comma-separated repo contract ids to watch.
    #[arg(long, value_delimiter = ',')]
    repos: Vec<String>,

    /// Poll interval in seconds (default 15).
    #[arg(long = "poll-interval")]
    poll_interval: Option<u64>,

    /// Dash network.
    #[arg(long, value_enum)]
    network: Option<NetworkArg>,

    /// Allow delivery to private/loopback/link-local targets (LOCAL TESTING ONLY — the M2
    /// test delivers to 127.0.0.1).
    #[arg(long)]
    allow_private: bool,

    /// Deliver the last N pre-existing docs per type at startup (default 0 = start from now).
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

impl From<NetworkArg> for Network {
    fn from(value: NetworkArg) -> Self {
        match value {
            NetworkArg::Testnet => Network::Testnet,
            NetworkArg::Mainnet => Network::Mainnet,
            NetworkArg::Devnet => Network::Devnet,
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
        network: args.network.map(Network::from),
        identity: args.identity,
        repos: if args.repos.is_empty() {
            None
        } else {
            Some(args.repos)
        },
        poll_interval_secs: args.poll_interval,
        allow_private: if args.allow_private { Some(true) } else { None },
        lookback: args.lookback,
        listen: args.listen,
        web_base_url: args.web_base_url,
    };

    let cfg = RelayConfig::load(args.config.as_deref(), &overrides)?;
    tracing::info!(
        ?cfg.network,
        repos = cfg.repos.len(),
        poll_interval_s = cfg.poll_interval.as_secs(),
        allow_private = cfg.allow_private,
        use_platform_webhooks = cfg.use_platform_webhooks,
        "forge-relay configured"
    );

    daemon::run(cfg).await?;
    Ok(())
}
