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
mod errors;
mod fmt;
mod git;
mod issue;
mod label;
mod maint;
mod pr;
mod release;
mod repo;
mod storage;

use std::path::PathBuf;

use anyhow::Result;
use clap::{CommandFactory, Parser, Subcommand};
use tokio::runtime::Runtime;

use config::Config;
use context::Ctx;
use forge_core::user_error::{codes, ErrorContext, UserError};

/// Dash Forge command-line interface.
#[derive(Debug, Parser)]
#[command(
    name = "dg",
    version = env!("DASH_FORGE_VERSION"),
    about = "Dash Forge CLI (gh-shaped)"
)]
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

    /// Devnet name (e.g. `moutai`); implies `--network devnet`.
    #[arg(long, global = true, value_name = "NAME")]
    pub devnet_name: Option<String>,

    /// Devnet DAPI addresses, comma-separated `host[:port]` (default port 1443). Defaults
    /// to the list in `forge-contracts/deployments/devnet-<name>.json`.
    #[arg(long, global = true, value_name = "ADDRS")]
    pub dapi_addresses: Option<String>,

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
    /// A named devnet (with `--devnet-name`).
    Devnet,
}

impl NetworkArg {
    /// The network kind string forge-core's resolver takes.
    pub fn kind(self) -> &'static str {
        match self {
            NetworkArg::Testnet => "testnet",
            NetworkArg::Mainnet => "mainnet",
            NetworkArg::Devnet => "devnet",
        }
    }
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
    /// Label definitions (apply one with `dg issue label`).
    #[command(subcommand)]
    Label(LabelCommand),
    /// Collaborator (token) management.
    #[command(subcommand)]
    Collab(CollabCommand),
    /// Cost estimates and spend audits.
    #[command(subcommand)]
    Cost(CostCommand),
    /// Consolidate a repo's packs into one superseding pack (deletes nothing on Platform).
    Repack {
        /// The repository (`owner/name`).
        repo: Option<String>,
        /// Destination backend for the consolidated pack (default: platform). Legacy
        /// env-configured targets (FORGE_S3_* / FORGE_IPFS_*); prefer --profile.
        #[arg(long, conflicts_with = "profile")]
        backend: Option<Backend>,
        /// Storage profile (from `dg storage add`) for the consolidated pack.
        #[arg(long)]
        profile: Option<String>,
    },
    /// Re-upload packs and append mirror URIs.
    Reseed {
        /// The repository (`owner/name`).
        repo: Option<String>,
        /// Target backend to reseed to. Legacy env-configured targets; prefer --profile.
        #[arg(long = "to", conflicts_with = "profile")]
        to: Option<Backend>,
        /// Storage profile (from `dg storage add`) to reseed to.
        #[arg(long)]
        profile: Option<String>,
        /// Restore lost copies from THIS clone's local pack files (the git dir, default
        /// `.git`) instead of downloading them, uploading to the repo's storage policy
        /// (dash.storage / dash.replicas), or to --profile.
        #[arg(long, value_name = "GIT_DIR", num_args = 0..=1, default_missing_value = ".git", conflicts_with = "to")]
        from_local: Option<PathBuf>,
        /// With --from-local: only this pack (hex SHA-256).
        #[arg(long, requires = "from_local")]
        pack: Option<String>,
        /// With --from-local: re-upload even packs whose recorded copies still verify.
        #[arg(long, requires = "from_local")]
        force: bool,
    },
    /// Storage availability.
    #[command(subcommand)]
    Storage(StorageCommand),
    /// Import a repository from GitHub (thin wrapper over forge-import).
    Import {
        /// The GitHub repository URL.
        url: String,
    },
    /// Diagnose the identity, network, contracts, storage, git config and toolchain.
    Doctor {
        /// Apply the safe automatic fixes (create config directories with 0700, set missing
        /// git config keys in this repository). Never anything that spends credits.
        #[arg(long)]
        fix: bool,
    },
    /// Print a shell completion script to stdout.
    ///
    /// bash: `dg completions bash > ~/.local/share/bash-completion/completions/dg`
    /// zsh:  `dg completions zsh > "${fpath[1]}/_dg"`
    /// fish: `dg completions fish > ~/.config/fish/completions/dg.fish`
    /// PowerShell: `dg completions powershell | Out-String | Invoke-Expression`
    #[command(visible_alias = "completion")]
    Completions {
        /// The shell to generate completions for.
        shell: clap_complete::Shell,
    },
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
    /// Create a forge-v2 repository (repo + your maintainer membership + initial config).
    Create {
        /// Repository name: the URL slug (a-z, 0-9, `.`, `_`, `-`; upper case is folded).
        name: String,
        /// Storage backend policy.
        #[arg(long, value_enum, default_value = "platform")]
        storage: StorageArg,
        /// Description.
        #[arg(long, default_value = "")]
        description: String,
        /// Display name (defaults to none; the slug is shown).
        #[arg(long, default_value = "")]
        display_name: String,
        /// Default branch.
        #[arg(long, default_value = "main")]
        default_branch: String,
    },
    /// Print the `git clone` command for a repo (`owner/name`).
    Clone {
        /// The repository (`owner/name`).
        repo: String,
    },
    /// Fork a repo: a new repo with `forkOf`, the parent's packs recorded by reference
    /// (nothing re-uploaded) and its refs copied.
    Fork {
        /// The repository (`owner/name`).
        repo: String,
        /// The fork's name (default: the parent's).
        #[arg(long)]
        name: Option<String>,
    },
    /// Star a repo.
    Star {
        /// The repository (`owner/name`).
        repo: String,
    },
    /// Remove your star from a repo.
    Unstar {
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
    /// Open a pull request from a branch of this repo or of your fork.
    Create(Box<PrCreateArgs>),
    /// List pull requests.
    List {
        /// The repository (`owner/name`).
        repo: String,
        /// Max results (0 = one page of 100).
        #[arg(long, default_value_t = 0)]
        limit: u32,
        /// State filter.
        #[arg(long, value_enum, default_value = "open")]
        state: StateArg,
    },
    /// View a pull request: state, approvals, reviews, comments.
    View {
        /// The repository (`owner/name`).
        repo: String,
        /// The PR number.
        number: u64,
    },
    /// Check out a pull request as branch `pr/<n>`, fetching its head from the source repo.
    Checkout {
        /// The repository (`owner/name`).
        repo: String,
        /// The PR number.
        number: u64,
    },
    /// Review a pull request (on its current head).
    Review {
        /// The repository (`owner/name`).
        repo: String,
        /// The PR number.
        number: u64,
        /// Approve.
        #[arg(long)]
        approve: bool,
        /// Request changes.
        #[arg(long)]
        request_changes: bool,
        /// Comment without a verdict.
        #[arg(long)]
        comment: bool,
        /// The verdict (alternative to the flags above).
        #[arg(long, value_enum)]
        verdict: Option<VerdictArg>,
        /// Review body.
        #[arg(long, default_value = "")]
        body: String,
    },
    /// Merge a pull request: fast-forward or merge commit, push to the base, post the event.
    Merge {
        /// The repository (`owner/name`).
        repo: String,
        /// The PR number.
        number: u64,
        /// Only post the merge event (the merge was pushed some other way).
        #[arg(long)]
        event_only: bool,
        /// With --event-only: the commit the event names (default: the PR head, or the base
        /// tip when the head is already in it).
        #[arg(long = "merge-oid", requires = "event_only")]
        merge_oid: Option<String>,
    },
    /// Close a pull request without merging.
    Close {
        /// The repository (`owner/name`).
        repo: String,
        /// The PR number.
        number: u64,
    },
    /// Reopen a closed pull request.
    Reopen {
        /// The repository (`owner/name`).
        repo: String,
        /// The PR number.
        number: u64,
    },
    /// Show a pull request's diff against its base, fetching both first.
    Diff {
        /// The repository (`owner/name`).
        repo: String,
        /// The PR number.
        number: u64,
    },
}

/// `dg pr create` arguments.
#[derive(Debug, clap::Args)]
pub struct PrCreateArgs {
    /// The target repository (`owner/name`).
    pub repo: String,
    /// PR title (default: the head commit's subject).
    #[arg(long)]
    pub title: Option<String>,
    /// PR body.
    #[arg(long, default_value = "")]
    pub body: String,
    /// Base branch in the target repo (default: its default branch).
    #[arg(long)]
    pub base: Option<String>,
    /// The branch holding the change (default: the current branch).
    #[arg(long)]
    pub head: Option<String>,
    /// The repository holding that branch, `owner/name` or repo id (default: your fork of
    /// the target, else the target itself).
    #[arg(long = "head-repo")]
    pub head_repo: Option<String>,
    /// The head commit (default: where the branch points in the head repo).
    #[arg(long = "head-oid")]
    pub head_oid: Option<String>,
}

#[derive(Debug, Subcommand)]
pub enum ReleaseCommand {
    /// Create a release (maintainers only), optionally with files.
    Create(Box<ReleaseCreateArgs>),
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

/// `dg release create` arguments.
#[derive(Debug, clap::Args)]
pub struct ReleaseCreateArgs {
    /// The repository (`owner/name`).
    pub repo: String,
    /// Tag name.
    #[arg(long)]
    pub tag: String,
    /// Display name.
    #[arg(long, default_value = "")]
    pub name: String,
    /// Release notes.
    #[arg(long, default_value = "")]
    pub notes: String,
    /// Mark the release yanked.
    #[arg(long)]
    pub yanked: bool,
    /// A file to attach (repeatable): uploaded to your storage, sha256 recorded.
    #[arg(long = "asset", value_name = "FILE")]
    pub assets: Vec<PathBuf>,
    /// Storage profiles for the assets (default: this repository's `dash.storage`).
    #[arg(long)]
    pub storage: Option<String>,
}

#[derive(Debug, Subcommand)]
pub enum LabelCommand {
    /// List a repository's labels.
    List {
        /// The repository (`owner/name`).
        repo: String,
        /// Include retired labels.
        #[arg(long)]
        all: bool,
    },
    /// Define (or redefine) a label.
    Create {
        /// The repository (`owner/name`).
        repo: String,
        /// The label name.
        name: String,
        /// Color, `#rrggbb`.
        #[arg(long, default_value = "")]
        color: String,
        /// Description.
        #[arg(long, default_value = "")]
        description: String,
    },
    /// Retire a label (a newer definition marked retired).
    Retire {
        /// The repository (`owner/name`).
        repo: String,
        /// The label name.
        name: String,
    },
}

#[derive(Debug, Subcommand)]
pub enum CollabCommand {
    /// Add a member (the repo owner creates a writer/maintainer document).
    Add {
        /// The repository (`owner/name`).
        repo: String,
        /// The collaborator identity id (base58).
        member: String,
        /// The role to grant.
        #[arg(long, value_enum, default_value = "writer")]
        role: RoleArg,
    },
    /// Not supported on forge-v2 (remove revokes access immediately).
    #[command(hide = true)]
    Suspend {
        /// The repository (`owner/name`).
        repo: String,
        /// The collaborator identity id (base58).
        member: String,
        /// The role to suspend.
        #[arg(long, value_enum, default_value = "writer")]
        role: RoleArg,
    },
    /// Not supported on forge-v2 (add restores access).
    #[command(hide = true)]
    Unsuspend {
        /// The repository (`owner/name`).
        repo: String,
        /// The collaborator identity id (base58).
        member: String,
        /// The role to unsuspend.
        #[arg(long, value_enum, default_value = "writer")]
        role: RoleArg,
    },
    /// Remove a member (the owner deletes their document; their next push is refused).
    Remove {
        /// The repository (`owner/name`).
        repo: String,
        /// The collaborator identity id (base58).
        member: String,
        /// The role to revoke.
        #[arg(long, value_enum, default_value = "writer")]
        role: RoleArg,
    },
    /// List members.
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
    /// Add (or replace) a storage profile in ~/.config/dash-forge/storage.toml.
    Add(Box<StorageAddArgs>),
    /// List storage profiles (secrets are shown as references, never values).
    List,
    /// Remove a storage profile.
    Remove {
        /// The profile name.
        name: String,
    },
    /// Put/get/delete a probe object, then check public reads and browser CORS.
    Test {
        /// The profile name.
        name: String,
    },
    /// Set which profiles `git push` stores packs on, for the repo in the current
    /// directory (git config dash.storage / dash.replicas).
    Use {
        /// Comma-separated profile names (`platform` is built in).
        profiles: String,
        /// Confirmations required (default: every listed profile).
        #[arg(long)]
        replicas: Option<usize>,
        /// Store on Platform when the external targets cannot confirm.
        #[arg(long)]
        platform_fallback: bool,
        /// Write to the user's global git config instead of this repo's.
        #[arg(long)]
        global: bool,
    },
    /// Advertise this repo's storage mode + public read URLs on-chain (config.backend).
    Advertise {
        /// The repository (`owner/name`).
        repo: String,
        /// Read the policy the helper would use for this git remote (its
        /// `remote.<name>.dash*` overrides), not just `dash.*`.
        #[arg(long)]
        remote: Option<String>,
    },
}

/// A storage profile kind (`dg storage add --kind`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, clap::ValueEnum)]
pub enum ProfileKindArg {
    /// S3-compatible bucket (AWS S3, Cloudflare R2, Backblaze B2, MinIO).
    S3,
    /// A kubo node's RPC API.
    IpfsKubo,
    /// kubo add + an IPFS Pinning Service API pin.
    IpfsPinningService,
    /// On-chain Platform chunk documents.
    Platform,
}

/// `dg storage add` arguments. Secrets are given as references (`env:VAR` or
/// `keychain:<service>/<account>`), never values.
#[derive(Debug, clap::Args)]
#[allow(clippy::struct_field_names)]
pub struct StorageAddArgs {
    /// The profile name (letters, digits, `-`, `_`, `.`).
    pub name: String,
    /// The profile kind.
    #[arg(long, value_enum)]
    pub kind: ProfileKindArg,
    /// s3: API endpoint origin (e.g. https://<account>.r2.cloudflarestorage.com).
    #[arg(long)]
    pub endpoint: Option<String>,
    /// s3: SigV4 region (R2: auto; B2: e.g. us-west-004).
    #[arg(long)]
    pub region: Option<String>,
    /// s3: bucket name.
    #[arg(long)]
    pub bucket: Option<String>,
    /// s3: use virtual-hosted addressing (bucket.endpoint) instead of path-style.
    #[arg(long)]
    pub virtual_hosted: bool,
    /// s3: public read origin readers use (r2.dev / custom domain / CDN).
    #[arg(long)]
    pub public_url: Option<String>,
    /// s3: key prefix inside the bucket.
    #[arg(long)]
    pub prefix: Option<String>,
    /// s3: access key id (literal, or env:/keychain: reference).
    #[arg(long)]
    pub access_key_id: Option<String>,
    /// s3: secret access key REFERENCE (env:VAR or keychain:service/account).
    #[arg(long)]
    pub secret_access_key: Option<String>,
    /// s3: session token reference.
    #[arg(long)]
    pub session_token: Option<String>,
    /// ipfs: kubo RPC API origin (e.g. http://127.0.0.1:5001).
    #[arg(long)]
    pub api: Option<String>,
    /// ipfs: a gateway serving this node's content (for upload verification).
    #[arg(long)]
    pub gateway: Option<String>,
    /// ipfs: a PUBLIC https gateway to record for browsers.
    #[arg(long)]
    pub public_gateway: Option<String>,
    /// ipfs: kubo RPC Authorization header reference.
    #[arg(long)]
    pub api_auth: Option<String>,
    /// pinning service: Pinning Service API base URL.
    #[arg(long)]
    pub pinning_endpoint: Option<String>,
    /// pinning service: access token reference.
    #[arg(long)]
    pub pinning_token: Option<String>,
    /// pinning service: seconds to wait for `pinned`.
    #[arg(long)]
    pub pin_timeout_secs: Option<u64>,
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

impl StateArg {
    /// Whether an item that is `open` passes this filter.
    pub fn matches(self, open: bool) -> bool {
        match self {
            StateArg::All => true,
            StateArg::Open => open,
            StateArg::Closed => !open,
        }
    }
}

impl From<StateArg> for forge_core::collab::StateFilter {
    fn from(s: StateArg) -> Self {
        match s {
            StateArg::All => Self::All,
            StateArg::Open => Self::Open,
            StateArg::Closed => Self::Closed,
        }
    }
}

/// PR review verdict.
#[derive(Debug, Clone, Copy, PartialEq, Eq, clap::ValueEnum)]
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

/// A member role.
#[derive(Debug, Clone, Copy, clap::ValueEnum)]
pub enum RoleArg {
    /// Push, upload (a `writer` document).
    #[value(alias = "write")]
    Writer,
    /// Also protected refs, config, releases (a `maintainer` document).
    #[value(alias = "maintain")]
    Maintainer,
}

impl RoleArg {
    /// The forge-v2 role.
    pub fn to_core(self) -> forge_core::rules::v2::Role {
        match self {
            RoleArg::Writer => forge_core::rules::v2::Role::Writer,
            RoleArg::Maintainer => forge_core::rules::v2::Role::Maintainer,
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

    let cli = match Cli::try_parse() {
        Ok(cli) => cli,
        Err(e) => exit_on_parse_error(&e),
    };

    // Completions touch neither config nor the network: handle them before `Ctx::resolve`,
    // so a broken config or an undeployed network cannot stop a shell from loading them.
    if let Command::Completions { shell } = cli.command {
        // Render to a buffer, then write once: `generate` panics on a write error, and a
        // closed pipe (`dg completions zsh | head`) is not an error worth a backtrace.
        let mut script = Vec::new();
        print_completions(shell, &mut script);
        let mut stdout = std::io::stdout().lock();
        if let Err(e) = std::io::Write::write_all(&mut stdout, &script)
            .and_then(|()| std::io::Write::flush(&mut stdout))
        {
            if e.kind() != std::io::ErrorKind::BrokenPipe {
                eprintln!("dg: writing completions: {e}");
                std::process::exit(1);
            }
        }
        return;
    }

    let (goal, repo) = errors::context_for(&cli.command);
    let err_ctx = ErrorContext {
        goal,
        repo,
        ..ErrorContext::default()
    };
    if let Err(err) = run(&cli) {
        std::process::exit(errors::report(cli.json, &err, &err_ctx));
    }
}

/// Write the `shell` completion script for `dg` to `out`.
fn print_completions(shell: clap_complete::Shell, out: &mut dyn std::io::Write) {
    clap_complete::generate(shell, &mut Cli::command(), "dg", out);
}
/// A command line clap rejected: `--help`/`--version` print and exit 0 as usual; a usage
/// error exits 2 (E201), as `{"error": …}` on stdout when `--json` was asked for.
fn exit_on_parse_error(e: &clap::Error) -> ! {
    use clap::error::ErrorKind;
    let wants_json = std::env::args().any(|a| a == "--json");
    if !wants_json
        || matches!(
            e.kind(),
            ErrorKind::DisplayHelp
                | ErrorKind::DisplayVersion
                | ErrorKind::DisplayHelpOnMissingArgumentOrSubcommand
        )
    {
        e.exit();
    }
    let text = e.to_string();
    let first = text
        .lines()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("invalid arguments")
        .trim_start_matches("error: ");
    let u = UserError::new(codes::USAGE, "invalid arguments")
        .cause(first)
        .fix("see `dg --help` or `dg <command> --help`");
    errors::print_json(&u.to_json());
    std::process::exit(u.exit_code());
}

/// Build the tokio runtime and dispatch the parsed command.
fn run(cli: &Cli) -> Result<()> {
    let config = Config::load().unwrap_or_default();
    let ctx = Ctx::resolve(cli, &config)?;
    let rt = Runtime::new()?;
    rt.block_on(dispatch(&ctx, cli))
}

/// Route the parsed command to its handler.
async fn dispatch(ctx: &Ctx, cli: &Cli) -> Result<()> {
    match &cli.command {
        Command::Auth(cmd) => auth::run(ctx, cmd).await,
        Command::Repo(cmd) => repo::run(ctx, cmd).await,
        Command::Issue(cmd) => issue::run(ctx, cmd).await,
        Command::Pr(cmd) => Box::pin(pr::run(ctx, cmd)).await,
        Command::Release(cmd) => release::run(ctx, cmd).await,
        Command::Label(cmd) => label::run(ctx, cmd).await,
        Command::Collab(cmd) => collab::run(ctx, cmd).await,
        Command::Cost(cmd) => cost::run(ctx, cmd).await,
        Command::Storage(cmd) => storage::run(ctx, cmd).await,
        Command::Repack {
            repo,
            backend,
            profile,
        } => maint::repack(ctx, repo.as_deref(), *backend, profile.as_deref()).await,
        Command::Reseed {
            repo,
            profile,
            from_local: Some(git_dir),
            pack,
            force,
            ..
        } => {
            maint::reseed_from_local(
                ctx,
                repo.as_deref(),
                git_dir,
                profile.as_deref(),
                pack.as_deref(),
                *force,
            )
            .await
        }
        Command::Reseed {
            repo, to, profile, ..
        } => maint::reseed(ctx, repo.as_deref(), *to, profile.as_deref()).await,
        Command::Import { url } => maint::import(ctx, url),
        Command::Doctor { fix } => doctor::run(ctx, *fix).await,
        Command::Completions { .. } => unreachable!("handled in main before Ctx::resolve"),
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
    fn parses_devnet_flags() {
        let cli = Cli::parse_from([
            "dg",
            "doctor",
            "--network",
            "devnet",
            "--devnet-name",
            "moutai",
            "--dapi-addresses",
            "10.0.0.1,10.0.0.2:2443",
        ]);
        assert!(matches!(cli.network, Some(NetworkArg::Devnet)));
        assert_eq!(cli.devnet_name.as_deref(), Some("moutai"));
        assert_eq!(
            cli.dapi_addresses.as_deref(),
            Some("10.0.0.1,10.0.0.2:2443")
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
                ..
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
                assert!(matches!(role, RoleArg::Maintainer));
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
                assert!(matches!(role, RoleArg::Writer)); // default role
            }
            _ => panic!("expected collab unsuspend"),
        }
    }

    #[test]
    fn cli_definition_is_consistent() {
        Cli::command().debug_assert();
    }

    #[test]
    fn version_names_commit_and_target() {
        let v = Cli::command().render_version();
        assert!(v.starts_with("dg "), "{v}");
        assert!(v.contains(env!("CARGO_PKG_VERSION")), "{v}");
        assert!(v.contains(env!("DASH_FORGE_TARGET")), "{v}");
        assert!(v.contains(env!("DASH_FORGE_GIT_SHA")), "{v}");
    }

    #[test]
    fn completions_generate_for_every_shell() {
        for (name, marker) in [
            ("bash", "_dg()"),
            ("zsh", "#compdef dg"),
            ("fish", "complete -c dg"),
            ("powershell", "Register-ArgumentCompleter"),
        ] {
            let cli = Cli::parse_from(["dg", "completions", name]);
            let Command::Completions { shell } = cli.command else {
                panic!("expected completions");
            };
            let mut out = Vec::new();
            print_completions(shell, &mut out);
            let script = String::from_utf8(out).unwrap();
            assert!(script.contains(marker), "{name}: missing {marker}");
            assert!(script.contains("doctor"), "{name}: subcommands missing");
        }
        // `completion` (gh's spelling, spec §7.6) is an alias.
        let cli = Cli::parse_from(["dg", "completion", "zsh"]);
        assert!(matches!(cli.command, Command::Completions { .. }));
    }

    /// The form the helper and error fixes print must parse as intended: `--from-local`
    /// takes an optional GIT_DIR, so the repo has to come before it.
    #[test]
    fn the_printed_reseed_command_parses() {
        let id = "8hJmcHWTsdvkHyCrk4UgjbyugDAmE7QfuCTQXpXAc7nB";
        for repo in [format!("{id}/project"), id.to_string()] {
            let cli = Cli::parse_from(["dg", "reseed", repo.as_str(), "--from-local"]);
            match cli.command {
                Command::Reseed {
                    repo: Some(r),
                    from_local: Some(dir),
                    ..
                } => {
                    assert_eq!(r, repo);
                    assert_eq!(dir, PathBuf::from(".git"));
                }
                other => panic!("unexpected parse {other:?}"),
            }
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
