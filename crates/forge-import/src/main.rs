//! `forge-import` — one-command GitHub → Dash Forge migration (PRD 06).
//!
//! Maps a GitHub repository — git data plus issues, PRs, releases, labels and milestones —
//! onto Dash Forge contracts. Git data rides the M1-proven `git push dash://…` path;
//! collaboration artifacts map to repo-contract collab docs stamped with `imported`
//! provenance (original author / time / URL, since Platform `$createdAt` is consensus time).
//! A cost gate prints a per-class estimate and requires confirmation; `--dry-run` estimates
//! with zero writes; `--max-spend` caps spend; `--resume` continues without double-paying.
//!
//! `forge-import claim <gh-login> --gist <url>` runs the gist-challenge author-claim flow.

mod claim;
mod estimate;
mod github;
mod importer;
mod state;

use std::path::PathBuf;

use anyhow::{bail, Context, Result};
use clap::Parser;

use estimate::SkipFlags;
use forge_core::platform::Network;
use github::GithubRepoRef;
use importer::{Backend, ImportConfig};

/// forge-import CLI.
#[derive(Debug, Parser)]
#[command(
    name = "forge-import",
    version,
    about = "GitHub → Dash Forge importer (PRD 06)"
)]
struct Cli {
    /// Source GitHub repo `owner/repo` (or a github.com URL). Omit only for `claim`.
    source: Option<String>,

    /// Destination Dash Forge repo name (defaults to the source repo name).
    #[arg(long)]
    repo_name: Option<String>,

    /// Import collaboration docs into this existing repo contract id (skips repo create +
    /// git push) — the cheap "import into an existing repo" path.
    #[arg(long)]
    repo_contract: Option<String>,

    /// Backend tier for a freshly created repo.
    #[arg(long, value_enum, default_value_t = BackendArg::Platform)]
    backend: BackendArg,

    /// Artifact classes to skip (repeatable): issues | prs | releases | comments.
    #[arg(long, value_enum)]
    skip: Vec<SkipArg>,

    /// Hard spend cap in DASH — abort before exceeding it.
    #[arg(long)]
    max_spend: Option<f64>,

    /// Cap the number of issues / PRs imported (0 = all) — keeps trial runs cheap.
    #[arg(long, default_value_t = 0)]
    limit: u64,

    /// Enumerate + estimate only; perform zero writes.
    #[arg(long)]
    dry_run: bool,

    /// Skip the confirmation prompt (automation / CI).
    #[arg(long)]
    yes: bool,

    /// Resume-state file (records progress so a rerun never duplicates or double-pays).
    #[arg(long)]
    resume: Option<PathBuf>,

    /// Dash network.
    #[arg(long, value_enum, default_value_t = NetworkArg::Testnet)]
    network: NetworkArg,

    /// Signing identity file (bridge JSON). Falls back to `DASH_FORGE_KEY`.
    #[arg(long)]
    identity: Option<PathBuf>,

    #[command(subcommand)]
    command: Option<Command>,
}

/// Subcommands (the bare form runs an import; `claim` runs the author-claim flow).
#[derive(Debug, clap::Subcommand)]
enum Command {
    /// Claim a placeholder GitHub author via a signed gist challenge.
    Claim {
        /// The GitHub login being claimed.
        login: String,
        /// The gist URL (or id) carrying the signed challenge.
        #[arg(long)]
        gist: String,
    },
}

#[derive(Debug, Clone, Copy, clap::ValueEnum)]
enum BackendArg {
    Platform,
    External,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, clap::ValueEnum)]
enum SkipArg {
    Issues,
    Prs,
    Releases,
    Comments,
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

impl From<BackendArg> for Backend {
    fn from(value: BackendArg) -> Self {
        match value {
            BackendArg::Platform => Backend::Platform,
            BackendArg::External => Backend::External,
        }
    }
}

/// Convert a non-negative DASH amount to whole credits, saturating (the caller has already
/// rejected negatives).
#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss
)]
fn dash_to_credits(dash: f64) -> u64 {
    (dash * forge_core::cost::CREDITS_PER_DASH as f64).round() as u64
}

/// Resolve the identity file path: `--identity` > `DASH_FORGE_KEY`.
fn resolve_identity_path(cli: &Cli) -> Result<PathBuf> {
    cli.identity
        .clone()
        .or_else(|| std::env::var_os("DASH_FORGE_KEY").map(PathBuf::from))
        .context("no identity — pass --identity <file> or set DASH_FORGE_KEY")
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let cli = Cli::parse();

    // `claim` subcommand: verify a gist author-claim and report the resulting record.
    if let Some(Command::Claim { login, gist }) = &cli.command {
        let claimed = claim::verify(login, gist)?;
        println!("author claim VERIFIED");
        println!("  github login: {}", claimed.github_login);
        println!("  dash identity: {}", claimed.identity_id);
        println!("  gist:          {}", claimed.gist_url);
        println!(
            "  signature:     {}…",
            &claimed.signature[..claimed.signature.len().min(24)]
        );
        println!(
            "\nGitHub control proven (gist owner == login) and the challenge binds the identity.\n\
             The on-chain `authorClaim` doc (repo-template v2) folds via FORGE_RULES_V1 so every\n\
             imported.author={:?} placeholder renders as identity {}.",
            claimed.github_login, claimed.identity_id
        );
        return Ok(());
    }

    // Otherwise: an import. Require a source.
    let source_raw = cli
        .source
        .clone()
        .context("missing source `owner/repo` (or use `forge-import claim …`)")?;
    let source = GithubRepoRef::parse(&source_raw)?;

    let mut skip = SkipFlags::default();
    for s in &cli.skip {
        match s {
            SkipArg::Issues => skip.issues = true,
            SkipArg::Prs => skip.prs = true,
            SkipArg::Releases => skip.releases = true,
            SkipArg::Comments => skip.comments = true,
        }
    }

    let max_spend_credits = match cli.max_spend {
        Some(d) if d < 0.0 => bail!("--max-spend must be non-negative"),
        Some(d) => Some(dash_to_credits(d)),
        None => None,
    };

    let resume_path = cli.resume.clone().unwrap_or_else(|| {
        std::env::temp_dir().join(format!(
            "forge-import-{}-{}.state.json",
            source.owner, source.repo
        ))
    });

    // A dry-run performs no writes and never connects, so it tolerates a missing identity.
    let identity_path = if cli.dry_run {
        resolve_identity_path(&cli).unwrap_or_default()
    } else {
        resolve_identity_path(&cli)?
    };

    let cfg = ImportConfig {
        source,
        repo_name: cli.repo_name.clone(),
        repo_contract_id: cli.repo_contract.clone(),
        backend: cli.backend.into(),
        skip,
        max_spend_credits,
        dry_run: cli.dry_run,
        yes: cli.yes,
        limit: cli.limit,
        resume_path,
        network: cli.network.into(),
        identity_path,
    };

    importer::run(&cfg).await
}
