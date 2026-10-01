//! `forge-relay` — the availability-only webhook daemon (PRD 05), for forge-v2 repositories.
//!
//! A maintainer writes a forge-community `webhook` document (`dg webhook add`) naming a URL, the
//! events it wants, and a relay identity, with the HMAC secret encrypted to that relay's
//! encryption key. A relay started with that identity finds every hook addressed to it
//! (`relay` index), decrypts the secrets in memory, polls those repos' documents (Platform has
//! no document push subscriptions), and POSTs GitHub-shaped `push` / `issues` /
//! `pull_request` / `issue_comment` / `pull_request_review` / `release` / `check_run`
//! webhooks, signed with `X-Hub-Signature-256`. Relays are interchangeable: re-pointing a hook
//! at another relay is one document. Consumers re-fetch and verify from Platform, so a relay
//! is trusted for availability only.
//!
//! Module map:
//!  * [`config`] — TOML + CLI configuration.
//!  * [`subscriptions`] — discovery of the `webhook` documents addressed to this relay.
//!  * [`ingest`] — per-repo streams, cursors, and document → event translation.
//!  * [`payload`] — GitHub-shape payload construction (pure, unit-tested).
//!  * [`deliver`] — HMAC-SHA256 signing, retry/backoff, per-host bounds, dead-letter.
//!  * [`ssrf`] — delivery-target SSRF guard.
//!  * [`daemon`] — the discover → poll → translate → deliver loop.
//!  * [`health`] — the optional listener: liveness, and runner wake-ups.
//!  * [`wake`] — runner wake-ups: a signed long-poll that tells a runner to poll now.

mod checkruns;
mod config;
mod daemon;
mod deliver;
mod error;
mod health;
mod ingest;
mod payload;
mod queue;
mod ssrf;
mod subscriptions;
mod wake;

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
    Run(Box<RunArgs>),
    /// List queued deliveries (pending retries, and dropped ones kept for inspection). Reads
    /// the state dir only; makes no network calls.
    Deliveries(DeliveriesArgs),
}

/// `forge-relay deliveries` arguments.
#[derive(Debug, Parser)]
struct DeliveriesArgs {
    /// The relay's config file, to use its `state-dir` (the same file as `run --config`). Only
    /// `state-dir` is read.
    #[arg(long = "config", short = 'c')]
    config: Option<PathBuf>,
    /// The relay's state dir (default: `$FORGE_RELAY_STATE_DIR`, else
    /// `$XDG_STATE_HOME/dash-forge/relay`, else `~/.local/state/dash-forge/relay`).
    #[arg(long = "state-dir")]
    state_dir: Option<PathBuf>,
    /// Machine-readable output.
    #[arg(long)]
    json: bool,
}

/// `forge-relay run` arguments (all override the config file).
#[derive(Debug, Parser)]
struct RunArgs {
    /// Path to the relay configuration file (TOML). Optional.
    #[arg(long = "config", short = 'c')]
    config: Option<PathBuf>,

    /// Path to the relay key file: a minimal `{identityId, identityKeys: [ENCRYPTION key]}` file
    /// or a full bridge identity export. Its id selects the webhooks addressed to this relay and
    /// its ENCRYPTION key decrypts their secrets. Mount it read-only; the relay never signs.
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

    /// Devnet name (e.g. `sakura`); implies `--network devnet`.
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

    /// forge-web base URL for synthesized html_url / compare links [default:
    /// https://forge.dashhq.org]. Include the base path of a sub-path deploy
    /// (e.g. https://owner.github.io/dash-forge).
    #[arg(long = "web-base-url")]
    web_base_url: Option<String>,

    /// Where the durable delivery queue lives (created 0700; default: `$FORGE_RELAY_STATE_DIR`,
    /// else `$XDG_STATE_HOME/dash-forge/relay`, else `~/.local/state/dash-forge/relay`). Set
    /// here or as `state-dir`, an unusable dir is fatal; the default falls back to memory.
    #[arg(long = "state-dir")]
    state_dir: Option<PathBuf>,
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
        Command::Run(args) => run(*args).await,
        Command::Deliveries(args) => deliveries(&args),
    }
}

/// `forge-relay deliveries`: the queue files, as a table or JSON. No network.
fn deliveries(args: &DeliveriesArgs) -> anyhow::Result<()> {
    let state = match (&args.state_dir, &args.config) {
        (Some(d), _) => d.clone(),
        (None, Some(path)) => config::state_dir_from_file(path)?,
        (None, None) => queue::default_state_dir()?,
    };
    let mut entries = queue::read_dir(&queue::queue_dir(&state))?;
    entries.sort_by_key(|e| (e.status == queue::Status::Dropped, e.next_ms));
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX));
    if args.json {
        let rows: Vec<serde_json::Value> = entries
            .iter()
            .map(|e| {
                serde_json::json!({
                    "deliveryId": e.id,
                    "status": e.status,
                    "repoId": e.repo_id,
                    "hookId": e.hook_id,
                    "event": e.event,
                    "sourceDocId": e.source_doc_id,
                    "attempts": e.tries,
                    "nextAttemptMs": (e.status == queue::Status::Pending).then_some(e.next_ms),
                    "lastError": e.last_error,
                    "dropReason": e.drop_reason,
                    "ageSecs": now.saturating_sub(e.created_ms) / 1000,
                })
            })
            .collect();
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "stateDir": state,
                "pending": entries.iter().filter(|e| e.status == queue::Status::Pending).count(),
                "dropped": entries.iter().filter(|e| e.status == queue::Status::Dropped).count(),
                "deliveries": rows,
            }))?
        );
        return Ok(());
    }
    if entries.is_empty() {
        println!(
            "No queued deliveries in {}.",
            queue::queue_dir(&state).display()
        );
        return Ok(());
    }
    println!(
        "{:<8} {:<14} {:<12} {:<20} {:>5} {:>10} {:>8}  LAST ERROR",
        "STATUS", "HOOK", "REPO", "EVENT", "TRIES", "NEXT IN", "AGE"
    );
    for e in &entries {
        let (status, next) = match e.status {
            queue::Status::Pending => ("pending", human(e.next_ms.saturating_sub(now) / 1000)),
            queue::Status::Dropped => ("dropped", "-".to_string()),
        };
        let error = e.drop_reason.as_deref().unwrap_or(&e.last_error);
        println!(
            "{:<8} {:<14} {:<12} {:<20} {:>5} {:>10} {:>8}  {}",
            status,
            e.hook_id.chars().take(12).collect::<String>(),
            e.repo_id.chars().take(10).collect::<String>(),
            e.event,
            e.tries,
            next,
            human(now.saturating_sub(e.created_ms) / 1000),
            error
        );
    }
    Ok(())
}

/// Seconds as `42s`, `5m`, `3h`, `2d`.
fn human(secs: u64) -> String {
    match secs {
        s if s < 60 => format!("{s}s"),
        s if s < 3600 => format!("{}m", s / 60),
        s if s < 86_400 => format!("{}h", s / 3600),
        s => format!("{}d", s / 86_400),
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
        state_dir: args.state_dir,
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
