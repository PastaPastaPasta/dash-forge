//! `forge-relay` — the availability-only webhook daemon (PRD 05).
//!
//! Anyone can run a relay: it subscribes to the block/ST firehose and translates
//! state transitions into push-style webhooks for CI and notifications. Payload
//! consumers re-fetch and verify from Platform, so relay instances are interchangeable
//! and integrity-irrelevant. This scaffold parses configuration and starts an (empty)
//! async runtime; the subscription loop lands in Stage 2.

use clap::Parser;

use forge_core::platform::Network;

/// forge-relay daemon configuration.
#[derive(Debug, Parser)]
#[command(name = "forge-relay", version, about = "Dash Forge relay daemon")]
#[allow(clippy::struct_field_names)]
struct Config {
    /// Path to the relay configuration file.
    #[arg(long = "config", short = 'c', default_value = "forge-relay.toml")]
    config_path: String,

    /// Dash network to subscribe to.
    #[arg(long, value_enum, default_value_t = NetworkArg::Testnet)]
    network: NetworkArg,

    /// Address to bind the webhook/health HTTP listener to.
    #[arg(long, default_value = "127.0.0.1:8080")]
    listen: String,

    /// Path to the relay identity (bridge-format JSON); webhook secrets are
    /// encrypted to this identity.
    #[arg(long)]
    identity: Option<String>,
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

    tracing::info!(
        config = %config.config_path,
        ?network,
        listen = %config.listen,
        identity = ?config.identity,
        "forge-relay configured (subscription loop not yet implemented)"
    );

    Ok(())
}
