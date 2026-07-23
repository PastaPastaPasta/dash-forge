//! `dg` — the gh-shaped Dash Forge CLI.
//!
//! The command surface deliberately mirrors `gh` (see `docs/prd/02-git-remote-helper-cli.md`
//! §B). Every command supports the global `--json` flag for machine-readable output, plus
//! `--network`, `--yes`, and an `--identity <file>` override. Cost-bearing commands print a
//! DASH (primary) / USD (secondary) estimate and prompt unless `--yes`.

mod auth;
mod collab;
mod common;
mod config;
mod context;
mod cost;
mod doctor;
mod fmt;
mod issue;
mod maint;
mod pr;
mod release;
mod repo;
mod storage;

use std::path::PathBuf;

use anyhow::Result;
use clap::{Parser, Subcommand};
use tokio::runtime::Runtime;

use config::Config;
use context::{report_error, Ctx};

/// Dash Forge command-line interface.
#[derive(Debug, Parser)]
#[command(name = "dg", version, about = "Dash Forge CLI (gh-shaped)")]
pub struct Cli {
    /// Emit machine-readable JSON instead of human output.
    #[arg(long, global = true)]
    pub json: bool,

    /// Skip confirmation prompts (for automation/CI).
    #[arg(long, short = 'y', global = true)]
    pub yes: bool,

    /// Target network (default: testnet, or the configured default).
    #[arg(long, global = true, value_enum)]
    pub network: Option<NetworkArg>,

    /// Override the identity file for this invocation.
    #[arg(long, global = true, value_name = "FILE")]
    pub identity: Option<PathBuf>,

    #[command(subcommand)]
    pub command: Command,
}

/// The network selector exposed on the CLI.
#[derive(Debug, Clone, Copy, clap::ValueEnum)]
pub enum NetworkArg {
    /// Dash testnet (default).
    Testnet,
    /// Dash mainnet.
    Mainnet,
}

#[derive(Debug, Subcommand)]
pub enum Command {
    /// Authentication and identity import.
    #[command(subcommand)]
    Auth(AuthCommand),
    /// Repository lifecycle and configuration.
    #[command(subcommand)]
    Repo(RepoCommand),
    /// Issue tracking.
    #[command(subcommand)]
    Issue(IssueCommand),
    /// Pull requests (patches).
    #[command(subcommand)]
    Pr(PrCommand),
    /// Releases.
    #[command(subcommand)]
    Release(ReleaseCommand),
    /// Collaborator (token) management.
    #[command(subcommand)]
    Collab(CollabCommand),
    /// Cost estimates and spend audits.
    #[command(subcommand)]
    Cost(CostCommand),
    /// Repack and reclaim storage (delete superseded docs → refund).
    Repack {
        /// The repository (`owner/name`).
        repo: Option<String>,
        /// Destination backend for the consolidated pack (default: platform).
        #[arg(long)]
        backend: Option<Backend>,
    },
    /// Re-upload packs and append mirror URIs.
    Reseed {
        /// The repository (`owner/name`).
        repo: Option<String>,
        /// Target backend to reseed to.
        #[arg(long = "to")]
        to: Option<Backend>,
    },
    /// Storage availability.
    #[command(subcommand)]
    Storage(StorageCommand),
    /// Import a repository from GitHub (thin wrapper over forge-import).
    Import {
        /// The GitHub repository URL.
        url: String,
    },
    /// Diagnose local environment and configuration.
    Doctor,
}

#[derive(Debug, Subcommand)]
pub enum AuthCommand {
    /// Import a bridge-format identity (via `--identity <file>`) and set it as default.
    Login,
    /// Show the current identity and auth status.
    Status,
    /// Show the identity's credit balance (credits + ~DASH).
    Balance,
}

#[derive(Debug, Subcommand)]
pub enum RepoCommand {
    /// Instantiate a repo contract, listing and token setup.
    Create {
        /// Repository name.
        name: String,
        /// Storage backend policy.
        #[arg(long, value_enum, default_value = "platform")]
        storage: StorageArg,
        /// Listing description.
        #[arg(long, default_value = "")]
        description: String,
    },
    /// Print the `git clone` command for a repo (`owner/name`).
    Clone {
        /// The repository (`owner/name`).
        repo: String,
    },
    /// Fork a repo (not yet wired).
    Fork {
        /// The repository (`owner/name`).
        repo: String,
    },
    /// View repo metadata (`owner/name`).
    View {
        /// The repository (`owner/name`).
        repo: String,
    },
    /// List an owner's repositories.
    List {
        /// The owner identity id (base58); defaults to the signing identity.
        #[arg(long)]
        owner: Option<String>,
    },
    /// Delete a repo's deletable storage (chunks + manifests → refund).
    Delete {
        /// The repository (`owner/name`), or just `name` for the signing identity.
        repo: String,
    },
    /// Backend configuration.
    #[command(subcommand)]
    Backend(RepoBackendCommand),
}

#[derive(Debug, Subcommand)]
pub enum RepoBackendCommand {
    /// Set the storage backend mode.
    Set {
        /// The repository (`owner/name`), or just `name` for the signing identity.
        repo: String,
        /// The backend mode.
        mode: Backend,
    },
}

#[derive(Debug, Subcommand)]
pub enum IssueCommand {
    /// List issues.
    List {
        /// The repository (`owner/name`).
        repo: String,
        /// State filter.
        #[arg(long, value_enum, default_value = "open")]
        state: StateArg,
        /// Max results (0 = server default).
        #[arg(long, default_value_t = 0)]
        limit: u32,
    },
    /// View an issue.
    View {
        /// The repository (`owner/name`).
        repo: String,
        /// The issue number.
        number: u64,
    },
    /// Create an issue.
    Create {
        /// The repository (`owner/name`).
        repo: String,
        /// Issue title.
        #[arg(long)]
        title: String,
        /// Issue body.
        #[arg(long, default_value = "")]
        body: String,
    },
    /// Comment on an issue.
    Comment {
        /// The repository (`owner/name`).
        repo: String,
        /// The issue number.
        number: u64,
        /// Comment body.
        #[arg(long)]
        body: String,
    },
    /// Close an issue.
    Close {
        /// The repository (`owner/name`).
        repo: String,
        /// The issue number.
        number: u64,
    },
    /// Reopen an issue.
    Reopen {
        /// The repository (`owner/name`).
        repo: String,
        /// The issue number.
        number: u64,
    },
    /// Add or remove a label on an issue.
    Label {
        /// The repository (`owner/name`).
        repo: String,
        /// The issue number.
        number: u64,
        /// Label to add.
        #[arg(long)]
        add: Option<String>,
        /// Label to remove.
        #[arg(long)]
        remove: Option<String>,
    },
}

#[derive(Debug, Subcommand)]
pub enum PrCommand {
    /// Create a pull request.
    Create {
        /// The repository (`owner/name`).
        repo: String,
        /// PR title.
        #[arg(long)]
        title: String,
        /// PR body.
        #[arg(long, default_value = "")]
        body: String,
        /// Base ref name in the target repo (e.g. `refs/heads/main`).
        #[arg(long, default_value = "refs/heads/main")]
        base: String,
        /// The source (fork) contract id (base58) where the PR objects live.
        #[arg(long = "source-contract")]
        source_contract: String,
        /// Head commit oid (hex) — the PR tip.
        #[arg(long = "head-oid")]
        head_oid: String,
        /// Source ref name in the fork (e.g. `refs/heads/feature`).
        #[arg(long = "source-ref")]
        source_ref: Option<String>,
    },
    /// List pull requests.
    List {
        /// The repository (`owner/name`).
        repo: String,
        /// Max results (0 = server default).
        #[arg(long, default_value_t = 0)]
        limit: u32,
    },
    /// View a pull request.
    View {
        /// The repository (`owner/name`).
        repo: String,
        /// The PR number.
        number: u64,
    },
    /// Check out a pull request's branch (thin git wrapper).
    Checkout {
        /// The repository (`owner/name`).
        repo: String,
        /// The PR number.
        number: u64,
    },
    /// Review a pull request.
    Review {
        /// The repository (`owner/name`).
        repo: String,
        /// The PR number.
        number: u64,
        /// The review verdict.
        #[arg(long, value_enum)]
        verdict: VerdictArg,
        /// Review body.
        #[arg(long, default_value = "")]
        body: String,
        /// The reviewed commit oid (hex); defaults to the PR head.
        #[arg(long)]
        commit: Option<String>,
    },
    /// Merge a pull request (posts the merge event; the git merge is client-side).
    Merge {
        /// The repository (`owner/name`).
        repo: String,
        /// The PR number.
        number: u64,
        /// The merge-commit oid (hex); defaults to the PR head oid.
        #[arg(long = "merge-oid")]
        merge_oid: Option<String>,
    },
    /// Show a pull request's diff (thin git wrapper).
    Diff {
        /// The repository (`owner/name`).
        repo: String,
        /// The PR number.
        number: u64,
    },
}

#[derive(Debug, Subcommand)]
pub enum ReleaseCommand {
    /// Create a release.
    Create {
        /// The repository (`owner/name`).
        repo: String,
        /// Tag name.
        #[arg(long)]
        tag: String,
        /// Display name.
        #[arg(long, default_value = "")]
        name: String,
        /// Release notes.
        #[arg(long, default_value = "")]
        notes: String,
        /// Mark the release yanked.
        #[arg(long)]
        yanked: bool,
    },
    /// List releases.
    List {
        /// The repository (`owner/name`).
        repo: String,
    },
    /// Download a release asset.
    Download {
        /// The repository (`owner/name`).
        repo: String,
        /// The release tag.
        tag: String,
        /// Asset name (defaults to the first asset).
        #[arg(long)]
        asset: Option<String>,
        /// Output path (defaults to the asset name in the cwd).
        #[arg(long)]
        output: Option<PathBuf>,
    },
}

#[derive(Debug, Subcommand)]
pub enum CollabCommand {
    /// Grant access (mint a WRITE/MAINTAIN token).
    Add {
        /// The repository (`owner/name`).
        repo: String,
        /// The collaborator identity id (base58).
        member: String,
        /// The role to grant.
        #[arg(long, value_enum, default_value = "write")]
        role: RoleArg,
    },
    /// Suspend a collaborator (freeze tokens).
    Suspend {
        /// The repository (`owner/name`).
        repo: String,
        /// The collaborator identity id (base58).
        member: String,
        /// The role to suspend.
        #[arg(long, value_enum, default_value = "write")]
        role: RoleArg,
    },
    /// Unsuspend a collaborator (thaw frozen tokens).
    Unsuspend {
        /// The repository (`owner/name`).
        repo: String,
        /// The collaborator identity id (base58).
        member: String,
        /// The role to unsuspend.
        #[arg(long, value_enum, default_value = "write")]
        role: RoleArg,
    },
    /// Remove a collaborator (freeze + destroy).
    Remove {
        /// The repository (`owner/name`).
        repo: String,
        /// The collaborator identity id (base58).
        member: String,
        /// The role to revoke.
        #[arg(long, value_enum, default_value = "write")]
        role: RoleArg,
    },
    /// List collaborators (token-balance query).
    List {
        /// The repository (`owner/name`).
        repo: String,
    },
}

#[derive(Debug, Subcommand)]
pub enum CostCommand {
    /// Pre-write cost quote.
    Estimate {
        /// Backend to price against.
        #[arg(long)]
        backend: Option<Backend>,
        /// Payload size in bytes.
        #[arg(long)]
        bytes: Option<u64>,
        /// Path whose size is priced (alternative to --bytes).
        #[arg(long)]
        path: Option<PathBuf>,
    },
    /// Per-operation cost reference (running spend is not tracked yet).
    Audit {
        /// The repository (`owner/name`), for a live storage tally.
        repo: Option<String>,
    },
}

#[derive(Debug, Subcommand)]
pub enum StorageCommand {
    /// Per-URI availability matrix for a repo's packs.
    Status {
        /// The repository (`owner/name`).
        repo: String,
    },
}

/// A storage backend mode (`repo backend set`).
#[derive(Debug, Clone, Copy, clap::ValueEnum)]
pub enum Backend {
    Platform,
    Ipfs,
    S3,
    Https,
    Mixed,
}

impl Backend {
    /// The `config.backend.mode` numeric encoding.
    pub fn mode(self) -> u8 {
        match self {
            Backend::Platform => 0,
            Backend::Ipfs => 1,
            Backend::S3 => 2,
            Backend::Https => 3,
            Backend::Mixed => 4,
        }
    }

    /// The lowercase label.
    pub fn label(self) -> &'static str {
        match self {
            Backend::Platform => "platform",
            Backend::Ipfs => "ipfs",
            Backend::S3 => "s3",
            Backend::Https => "https",
            Backend::Mixed => "mixed",
        }
    }
}

/// The `repo create --storage` policy (platform | external | mixed).
#[derive(Debug, Clone, Copy, clap::ValueEnum)]
pub enum StorageArg {
    /// On-chain `chunk` documents (mode 0).
    Platform,
    /// An external mirror (defaults to the https tier, mode 3).
    External,
    /// Mixed platform + external (mode 4).
    Mixed,
}

impl StorageArg {
    /// The `config.backend.mode` numeric encoding.
    pub fn mode(self) -> u8 {
        match self {
            StorageArg::Platform => 0,
            StorageArg::External => 3,
            StorageArg::Mixed => 4,
        }
    }

    /// The lowercase label.
    pub fn label(self) -> &'static str {
        match self {
            StorageArg::Platform => "platform",
            StorageArg::External => "external",
            StorageArg::Mixed => "mixed",
        }
    }
}

/// Issue state filter.
#[derive(Debug, Clone, Copy, clap::ValueEnum)]
pub enum StateArg {
    All,
    Open,
    Closed,
}

/// PR review verdict.
#[derive(Debug, Clone, Copy, clap::ValueEnum)]
pub enum VerdictArg {
    Approve,
    RequestChanges,
    Comment,
}

impl VerdictArg {
    /// The stored numeric verdict (data-contracts §2.3).
    pub fn code(self) -> u64 {
        match self {
            VerdictArg::Approve => 1,
            VerdictArg::RequestChanges => 2,
            VerdictArg::Comment => 3,
        }
    }
}

/// A collaborator role.
#[derive(Debug, Clone, Copy, clap::ValueEnum)]
pub enum RoleArg {
    Write,
    Maintain,
}

impl RoleArg {
    /// The forge-core role.
    pub fn to_core(self) -> forge_core::tokens::Role {
        match self {
            RoleArg::Write => forge_core::tokens::Role::Write,
            RoleArg::Maintain => forge_core::tokens::Role::Maintain,
        }
    }
}

fn main() {
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("warn")),
        )
        .init();

    let cli = Cli::parse();
    let json = cli.json;

    match run(&cli) {
        Ok(()) => {}
        Err(err) => {
            report_error(json, &err);
            std::process::exit(1);
        }
    }
}

/// Build the tokio runtime and dispatch the parsed command.
fn run(cli: &Cli) -> Result<()> {
    let config = Config::load().unwrap_or_default();
    let ctx = Ctx::resolve(cli, &config);
    let rt = Runtime::new()?;
    rt.block_on(dispatch(&ctx, cli))
}

/// Route the parsed command to its handler.
async fn dispatch(ctx: &Ctx, cli: &Cli) -> Result<()> {
    match &cli.command {
        Command::Auth(cmd) => auth::run(ctx, cmd).await,
        Command::Repo(cmd) => repo::run(ctx, cmd).await,
        Command::Issue(cmd) => issue::run(ctx, cmd).await,
        Command::Pr(cmd) => pr::run(ctx, cmd).await,
        Command::Release(cmd) => release::run(ctx, cmd).await,
        Command::Collab(cmd) => collab::run(ctx, cmd).await,
        Command::Cost(cmd) => cost::run(ctx, cmd).await,
        Command::Storage(cmd) => storage::run(ctx, cmd).await,
        Command::Repack { repo, backend } => maint::repack(ctx, repo.as_deref(), *backend).await,
        Command::Reseed { repo, to } => maint::reseed(ctx, repo.as_deref(), *to).await,
        Command::Import { url } => maint::import(ctx, url),
        Command::Doctor => doctor::run(ctx).await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;

    #[test]
    fn parses_auth_balance_with_global_flags() {
        let cli = Cli::parse_from(["dg", "--json", "auth", "balance"]);
        assert!(cli.json);
        assert!(matches!(cli.command, Command::Auth(AuthCommand::Balance)));
    }

    #[test]
    fn parses_network_and_identity_globals_after_subcommand() {
        let cli = Cli::parse_from([
            "dg",
            "auth",
            "balance",
            "--network",
            "mainnet",
            "--identity",
            "/tmp/id.json",
        ]);
        assert!(matches!(cli.network, Some(NetworkArg::Mainnet)));
        assert_eq!(
            cli.identity.as_deref().unwrap().to_str().unwrap(),
            "/tmp/id.json"
        );
    }

    #[test]
    fn parses_repo_create_with_storage_and_description() {
        let cli = Cli::parse_from([
            "dg",
            "repo",
            "create",
            "my-repo",
            "--storage",
            "mixed",
            "--description",
            "hello",
        ]);
        match cli.command {
            Command::Repo(RepoCommand::Create {
                name,
                storage,
                description,
            }) => {
                assert_eq!(name, "my-repo");
                assert_eq!(storage.mode(), 4);
                assert_eq!(description, "hello");
            }
            _ => panic!("expected repo create"),
        }
    }

    #[test]
    fn parses_cost_estimate_bytes() {
        let cli = Cli::parse_from(["dg", "cost", "estimate", "--bytes", "1000000"]);
        match cli.command {
            Command::Cost(CostCommand::Estimate { bytes, .. }) => {
                assert_eq!(bytes, Some(1_000_000));
            }
            _ => panic!("expected cost estimate"),
        }
    }

    #[test]
    fn parses_collab_add_role() {
        let cli = Cli::parse_from([
            "dg",
            "collab",
            "add",
            "o/r",
            "member123",
            "--role",
            "maintain",
        ]);
        match cli.command {
            Command::Collab(CollabCommand::Add { repo, member, role }) => {
                assert_eq!(repo, "o/r");
                assert_eq!(member, "member123");
                assert!(matches!(role, RoleArg::Maintain));
            }
            _ => panic!("expected collab add"),
        }
    }

    #[test]
    fn parses_collab_unsuspend() {
        let cli = Cli::parse_from(["dg", "collab", "unsuspend", "o/r", "member123"]);
        match cli.command {
            Command::Collab(CollabCommand::Unsuspend { repo, member, role }) => {
                assert_eq!(repo, "o/r");
                assert_eq!(member, "member123");
                assert!(matches!(role, RoleArg::Write)); // default role
            }
            _ => panic!("expected collab unsuspend"),
        }
    }

    #[test]
    fn backend_mode_encoding() {
        assert_eq!(Backend::Platform.mode(), 0);
        assert_eq!(Backend::Ipfs.mode(), 1);
        assert_eq!(Backend::S3.mode(), 2);
        assert_eq!(Backend::Https.mode(), 3);
        assert_eq!(Backend::Mixed.mode(), 4);
    }

    #[test]
    fn verdict_codes() {
        assert_eq!(VerdictArg::Approve.code(), 1);
        assert_eq!(VerdictArg::RequestChanges.code(), 2);
        assert_eq!(VerdictArg::Comment.code(), 3);
    }
}
