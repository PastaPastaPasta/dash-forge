//! The `forge-notify` binary: see the library ([`forge_notify`]).

use base64::Engine as _;
use clap::{Parser, Subcommand};
use rand::RngCore as _;

use forge_notify::config::ServeArgs;
use forge_notify::push::WebPusher;

/// Optional email and Web Push notifications for Dash Forge identities.
#[derive(Debug, Parser)]
#[command(name = "forge-notify", version)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Run the service (settings from flags or FORGE_NOTIFY_* variables).
    Serve(Box<ServeArgs>),
    /// Print a new data key and VAPID key pair as environment lines (store them as secrets).
    Keys,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();
    match Cli::parse().command {
        Command::Serve(args) => {
            let cfg = args.resolve()?;
            forge_notify::server::run(cfg).await?;
        }
        Command::Keys => {
            let mut key = [0u8; 32];
            rand::rngs::OsRng.fill_bytes(&mut key);
            let vapid = WebPusher::generate_private_key();
            let public = WebPusher::new(&vapid, "mailto:x@example.org")?;
            println!(
                "FORGE_NOTIFY_DATA_KEY={}",
                base64::engine::general_purpose::STANDARD.encode(key)
            );
            println!("FORGE_NOTIFY_VAPID_PRIVATE_KEY={vapid}");
            println!(
                "# VAPID public key (served at /v1/info): {}",
                forge_notify::push::Pusher::public_key(&public)
            );
        }
    }
    Ok(())
}
