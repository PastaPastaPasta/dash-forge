//! `forge-import` — one-command GitHub → Dash Forge migration (PRD 06).
//!
//! Maps GitHub repositories (git data plus issues, PRs, releases and labels) onto
//! Dash Forge contracts using Forgejo migration-layer semantics over the GitHub
//! REST/GraphQL APIs. This scaffold parses configuration and starts an async runtime;
//! the migration pipeline lands in Stage 2.

use clap::Parser;

use forge_core::platform::Network;

/// forge-import configuration.
#[derive(Debug, Parser)]
#[command(name = "forge-import", version, about = "GitHub → Dash Forge importer")]
struct Config {
    /// Source GitHub repository URL (e.g. https://github.com/owner/repo).
    source: String,

    /// Destination Dash Forge repo name (defaults to the source repo name).
    #[arg(long)]
    dest: Option<String>,

    /// Dash network to import into.
    #[arg(long, value_enum, default_value_t = NetworkArg::Testnet)]
    network: NetworkArg,

    /// Path to the importing identity (bridge-format JSON).
    #[arg(long)]
    identity: Option<String>,

    /// GitHub API token. When omitted, the GITHUB_TOKEN environment variable is used.
    #[arg(long)]
    github_token: Option<String>,

    /// Import issues, pull requests, releases and labels in addition to git data.
    #[arg(long, default_value_t = true)]
    collaboration: bool,
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

    let config = Config::parse();
    let network: Network = config.network.into();
    let github_token = config
        .github_token
        .clone()
        .or_else(|| std::env::var("GITHUB_TOKEN").ok());

    tracing::info!(
        source = %config.source,
        dest = ?config.dest,
        ?network,
        identity = ?config.identity,
        has_token = github_token.is_some(),
        collaboration = config.collaboration,
        "forge-import configured (migration pipeline not yet implemented)"
    );

    Ok(())
}
