//! `dg` — the gh-shaped Dash Forge CLI.
//!
//! The command surface deliberately mirrors `gh` (see `docs/prd/02-git-remote-helper-cli.md`
//! §B). Every subcommand here is a stub that prints "not implemented"; the global
//! `--json` flag is threaded through so machine-readable output is a first-class
//! concern from the start. Stage 2 wires each leaf to a forge-core service.

use clap::{Parser, Subcommand};

/// Dash Forge command-line interface.
#[derive(Debug, Parser)]
#[command(name = "dg", version, about = "Dash Forge CLI (gh-shaped)")]
struct Cli {
    /// Emit machine-readable JSON instead of human output.
    #[arg(long, global = true)]
    json: bool,

    /// Skip confirmation prompts (for automation/CI).
    #[arg(long, short = 'y', global = true)]
    yes: bool,

    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
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
    Repack,
    /// Re-upload packs and append mirror URIs.
    Reseed {
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
enum AuthCommand {
    /// Import a bridge-format identity and store it in the OS keychain.
    Login,
    /// Show the current identity and auth status.
    Status,
}

#[derive(Debug, Subcommand)]
enum RepoCommand {
    /// Instantiate a repo contract, listing and token setup.
    Create,
    /// Clone a repo.
    Clone,
    /// Fork a repo.
    Fork,
    /// View repo metadata.
    View,
    /// Delete a repo (with storage refund).
    Delete,
    /// Backend configuration.
    #[command(subcommand)]
    Backend(RepoBackendCommand),
}

#[derive(Debug, Subcommand)]
enum RepoBackendCommand {
    /// Set the storage backend mode.
    Set {
        /// The backend mode.
        mode: Backend,
    },
}

#[derive(Debug, Subcommand)]
enum IssueCommand {
    /// List issues.
    List,
    /// View an issue.
    View,
    /// Create an issue.
    Create,
    /// Comment on an issue.
    Comment,
    /// Close an issue.
    Close,
    /// Reopen an issue.
    Reopen,
    /// Label an issue.
    Label,
}

#[derive(Debug, Subcommand)]
enum PrCommand {
    /// Create a pull request.
    Create,
    /// List pull requests.
    List,
    /// View a pull request.
    View,
    /// Check out a pull request's branch.
    Checkout,
    /// Review a pull request.
    Review,
    /// Merge a pull request.
    Merge,
    /// Show a pull request's diff.
    Diff,
}

#[derive(Debug, Subcommand)]
enum ReleaseCommand {
    /// Create a release.
    Create,
    /// List releases.
    List,
    /// Download release assets.
    Download,
}

#[derive(Debug, Subcommand)]
enum CollabCommand {
    /// Grant access (mint WRITE/MAINTAIN tokens).
    Add,
    /// Suspend a collaborator (freeze tokens).
    Suspend,
    /// Remove a collaborator (freeze + destroy).
    Remove,
    /// List collaborators (token-balance query).
    List,
}

#[derive(Debug, Subcommand)]
enum CostCommand {
    /// Pre-write cost quote.
    Estimate {
        /// Backend to price against.
        #[arg(long)]
        backend: Option<Backend>,
    },
    /// Reconcile actual credits consumed vs estimates.
    Audit,
}

#[derive(Debug, Subcommand)]
enum StorageCommand {
    /// Per-URI availability matrix.
    Status,
}

/// A storage backend mode.
#[derive(Debug, Clone, Copy, clap::ValueEnum)]
enum Backend {
    Platform,
    Ipfs,
    S3,
    Https,
    Mixed,
}

/// Print a uniform "not implemented" stub, honoring `--json`.
fn stub(json: bool, command: &str) {
    if json {
        println!("{{\"command\":\"{command}\",\"status\":\"not_implemented\"}}");
    } else {
        println!("dg {command}: not implemented");
    }
}

fn main() {
    let cli = Cli::parse();
    let json = cli.json;

    let command = match &cli.command {
        Command::Auth(AuthCommand::Login) => "auth login",
        Command::Auth(AuthCommand::Status) => "auth status",
        Command::Repo(RepoCommand::Create) => "repo create",
        Command::Repo(RepoCommand::Clone) => "repo clone",
        Command::Repo(RepoCommand::Fork) => "repo fork",
        Command::Repo(RepoCommand::View) => "repo view",
        Command::Repo(RepoCommand::Delete) => "repo delete",
        Command::Repo(RepoCommand::Backend(RepoBackendCommand::Set { .. })) => "repo backend set",
        Command::Issue(IssueCommand::List) => "issue list",
        Command::Issue(IssueCommand::View) => "issue view",
        Command::Issue(IssueCommand::Create) => "issue create",
        Command::Issue(IssueCommand::Comment) => "issue comment",
        Command::Issue(IssueCommand::Close) => "issue close",
        Command::Issue(IssueCommand::Reopen) => "issue reopen",
        Command::Issue(IssueCommand::Label) => "issue label",
        Command::Pr(PrCommand::Create) => "pr create",
        Command::Pr(PrCommand::List) => "pr list",
        Command::Pr(PrCommand::View) => "pr view",
        Command::Pr(PrCommand::Checkout) => "pr checkout",
        Command::Pr(PrCommand::Review) => "pr review",
        Command::Pr(PrCommand::Merge) => "pr merge",
        Command::Pr(PrCommand::Diff) => "pr diff",
        Command::Release(ReleaseCommand::Create) => "release create",
        Command::Release(ReleaseCommand::List) => "release list",
        Command::Release(ReleaseCommand::Download) => "release download",
        Command::Collab(CollabCommand::Add) => "collab add",
        Command::Collab(CollabCommand::Suspend) => "collab suspend",
        Command::Collab(CollabCommand::Remove) => "collab remove",
        Command::Collab(CollabCommand::List) => "collab list",
        Command::Cost(CostCommand::Estimate { .. }) => "cost estimate",
        Command::Cost(CostCommand::Audit) => "cost audit",
        Command::Repack => "repack",
        Command::Reseed { .. } => "reseed",
        Command::Storage(StorageCommand::Status) => "storage status",
        Command::Import { .. } => "import",
        Command::Doctor => "doctor",
    };

    stub(json, command);
}
