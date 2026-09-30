//! `dg` — the gh-shaped Dash Forge CLI.
//!
//! The command surface deliberately mirrors `gh` (see `docs/prd/02-git-remote-helper-cli.md`
//! §B). Every command supports the global `--json` flag for machine-readable output, plus
//! `--network`, `--yes`, and an `--identity <file>` override. Cost-bearing commands print a
//! DASH (primary) / USD (secondary) estimate and prompt unless `--yes`.

mod auth;
mod ci;
mod collab;
mod common;
mod config;
mod context;
mod cost;
mod doctor;
mod errors;
mod fmt;
mod git;
mod import;
mod infer;
mod issue;
mod keys;
mod label;
mod maint;
mod milestone;
mod pr;
mod prompt;
mod publish;
mod release;
mod repo;
mod repo_settings;
mod storage;
mod storage_wizard;
mod webhook;

use std::path::PathBuf;

use anyhow::Result;
use clap::{CommandFactory, Parser, Subcommand};
use tokio::runtime::Runtime;

pub use auth::AuthCommand;
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

    /// Devnet name (e.g. `bonsia`); implies `--network devnet`.
    #[arg(long, global = true, value_name = "NAME")]
    pub devnet_name: Option<String>,

    /// Devnet DAPI addresses, comma-separated `host[:port]` (default port 1443). Defaults
    /// to the list in `forge-contracts/deployments/devnet-<name>.json`.
    #[arg(long, global = true, value_name = "ADDRS")]
    pub dapi_addresses: Option<String>,

    /// Override the identity file for this invocation.
    #[arg(long, global = true, value_name = "FILE")]
    pub identity: Option<PathBuf>,

    /// Write to an archived repository anyway (issues, PRs, comments, reviews, merges,
    /// releases). Archiving is a client rule; consensus still admits a member's writes.
    #[arg(long, global = true)]
    pub allow_archived: bool,

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
    /// Identities and keys: create, sign in, limited keys, DPNS names, export.
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
    /// Milestones (put an issue in one with `dg issue milestone`).
    #[command(subcommand)]
    Milestone(MilestoneCommand),
    /// Repository members (writers and maintainers).
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
        /// Storage profile(s) (from `dg storage add`, or `platform`) for the consolidated
        /// pack; a comma-separated list stores it on each, and every one must confirm.
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
    /// Webhooks a relay delivers (forge-v2).
    #[command(subcommand)]
    Webhook(webhook::WebhookCommand),
    /// CI: runner keys and memberships, and check runs on commits.
    #[command(subcommand)]
    Ci(ci::CiCommand),
    /// Import (or re-sync) a GitHub repository or GitLab project into forge-v2: code, issues, PRs/MRs, releases.
    Import(Box<import::ImportArgs>),
    /// Diagnose the identity, network, contracts, storage, git config and toolchain.
    Doctor {
        /// Apply the safe automatic fixes (create config directories with 0700, set missing
        /// git config keys in this repository). Never anything that spends credits.
        #[arg(long)]
        fix: bool,
    },
    /// Publish the git repository in the current directory: create its forge-v2 repo if
    /// missing, add the remote and push the current branch (`repo create --push` for the
    /// cwd; safe to re-run).
    Init(Box<InitArgs>),
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

/// Options `dg repo create` and `dg init` share.
#[derive(Debug, Clone, clap::Args)]
pub struct CreateOptions {
    /// Where pushes store packs: comma-separated storage profile names (`platform` is built
    /// in). Default: git config `dash.storage`, else your only profile; with neither, the
    /// command stops before spending (E508).
    #[arg(long, value_name = "PROFILES")]
    pub storage: Option<String>,
    /// Confirmations a push needs (default: every listed profile).
    #[arg(long)]
    pub replicas: Option<usize>,
    /// Description.
    #[arg(long, default_value = "")]
    pub description: String,
    /// Display name (defaults to none; the slug is shown).
    #[arg(long, default_value = "")]
    pub display_name: String,
    /// Default branch (default: the current branch when pushing, else `main`).
    #[arg(long)]
    pub default_branch: Option<String>,
    /// The git remote to add for the repo (default: origin). Pushing flows only.
    #[arg(long, value_name = "NAME")]
    pub remote: Option<String>,
    /// Record the storage's public URL on chain even though it is not a public https
    /// address (loopback, LAN, plain http, a temporary tunnel). Without it the command stops
    /// before creating anything. `dg init` keeps it for the repository (git config
    /// `dash.allowPrivateUri`), so later plain `git push`es record it too.
    #[arg(long)]
    pub allow_private_uri: bool,
    /// Create a private repository: contents (code, ref names, issues, PRs, comments,
    /// reviews) are encrypted to its members. Needs an encryption key on your identity
    /// (`dg auth keys add --encryption`). Visibility cannot be changed later.
    #[arg(long)]
    pub private: bool,
}

impl CreateOptions {
    /// The remote name (`origin` unless `--remote`).
    pub fn remote(&self) -> &str {
        self.remote.as_deref().unwrap_or("origin")
    }
}

/// `dg repo create` arguments.
#[derive(Debug, clap::Args)]
pub struct RepoCreateArgs {
    /// Repository name: the URL slug (a-z, 0-9, `.`, `_`, `-`; upper case is folded).
    /// Default: this directory's name.
    pub name: Option<String>,
    /// Also add the remote (`--remote`, default origin) to the git repository here and push
    /// the current branch with `-u`.
    #[arg(long)]
    pub push: bool,
    #[command(flatten)]
    pub opts: CreateOptions,
}

/// `dg init` arguments.
#[derive(Debug, clap::Args)]
pub struct InitArgs {
    /// Repository name (default: the git repository's directory name).
    #[arg(long)]
    pub name: Option<String>,
    #[command(flatten)]
    pub opts: CreateOptions,
}

#[derive(Debug, Subcommand)]
pub enum RepoCommand {
    /// Create a forge-v2 repository (repo + your maintainer membership + initial config);
    /// with --push, also add the remote and push the current branch.
    Create(Box<RepoCreateArgs>),
    /// Clone a repo (`owner/name`) with `git clone dash://…`, and record this network in the
    /// clone's git config so `git push` from it goes to the same place.
    Clone {
        /// The repository (`owner/name`).
        repo: String,
        /// Where to clone it (default: the repository's name).
        dir: Option<std::path::PathBuf>,
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
    /// Star a repo. A new star also counts toward Trending (one more small document, about
    /// 0.00015 DASH) unless `--no-trending` or `trending = false` in config.toml.
    Star {
        /// The repository (`owner/name`).
        repo: String,
        /// Star without counting toward Trending (no `starBeat`).
        #[arg(long)]
        no_trending: bool,
    },
    /// Remove your star from a repo.
    Unstar {
        /// The repository (`owner/name`).
        repo: String,
    },
    /// Watch a repo: the web app's inbox follows it, on every device you sign in on.
    Watch {
        /// The repository (`owner/name`).
        repo: String,
    },
    /// Stop watching a repo.
    Unwatch {
        /// The repository (`owner/name`).
        repo: String,
    },
    /// A repository's topics: list them, or (its owner) add and remove.
    Topic {
        /// The repository (`owner/name`).
        repo: String,
        /// Topics to add.
        #[arg(long = "add", value_name = "NAME")]
        add: Vec<String>,
        /// Topics to remove.
        #[arg(long = "remove", value_name = "NAME")]
        remove: Vec<String>,
    },
    /// View repo metadata (`owner/name`).
    View {
        /// The repository (`owner/name`).
        repo: String,
    },
    /// List an owner's repositories.
    List {
        /// The owner (identity id or DPNS name); defaults to the signing identity.
        #[arg(long)]
        owner: Option<String>,
    },
    /// Backend configuration.
    #[command(subcommand)]
    Backend(RepoBackendCommand),
    /// A private repository's keys: epochs, wraps, pending rotation, repair.
    #[command(subcommand)]
    Keys(RepoKeysCommand),
    /// Edit a repo's settings: default branch (config, maintainers), description and topics
    /// (the repo document, its owner).
    Edit(RepoEditArgs),
    /// Protected branches: which refs only maintainers may update.
    #[command(subcommand)]
    Protect(RepoProtectCommand),
    /// The branch policy (required approvals, approver role, merge methods): a client rule
    /// every Forge client applies to its merge controls; consensus does not enforce it.
    #[command(subcommand)]
    Policy(RepoPolicyCommand),
    /// Publish the browse index for stored packs that have none (a push that could not
    /// publish it), and the default branch's history index (last-commit column, exact commit
    /// count) when its tip has none. Reads the packs and uploads only the indexes: nothing is
    /// stored again.
    Reindex {
        /// The repository (`owner/name`).
        repo: String,
        /// Storage profile(s) for the index (from `dg storage add`, or `platform`); every one
        /// must confirm. Default: Platform, when the packs are stored there. Required when they
        /// are not, and inside a clone of the repository whose dash.storage names your own
        /// storage.
        #[arg(long)]
        profile: Option<String>,
        /// A local clone holding the default branch's tip, to compute the history index in.
        /// Default: the current directory.
        #[arg(long, value_name = "DIR")]
        git_dir: Option<std::path::PathBuf>,
    },
    /// Mark a repo archived (maintainers): every Forge client refuses writes to it. A client
    /// rule; consensus still admits a member's writes.
    Archive {
        /// The repository (`owner/name`).
        repo: String,
    },
    /// Clear a repo's archived mark (maintainers).
    Unarchive {
        /// The repository (`owner/name`).
        repo: String,
    },
}

#[derive(Debug, clap::Args)]
pub struct RepoEditArgs {
    /// The repository (`owner/name`).
    pub repo: String,
    /// The new default branch (`main` or `refs/heads/main`): what clones check out and the
    /// web opens. Writes a new `config` (maintainers only).
    #[arg(long = "default-branch")]
    pub default_branch: Option<String>,
    /// The new description (`""` clears it). Edits the `repo` document (its owner only).
    #[arg(long)]
    pub description: Option<String>,
    /// The topics, comma-separated (`""` clears them): up to 10 of `a-z`, `0-9`, `-`.
    #[arg(long)]
    pub topics: Option<String>,
}

#[derive(Debug, Subcommand)]
pub enum RepoProtectCommand {
    /// List the protected patterns in force.
    List {
        /// The repository (`owner/name`).
        repo: String,
    },
    /// Protect the refs matching a pattern (a branch name like `main`, or a glob like
    /// `refs/heads/release/*`; `*` stays within one path segment, `**` crosses them).
    Add {
        /// The repository (`owner/name`).
        repo: String,
        /// The branch or glob.
        pattern: String,
    },
    /// Stop protecting a pattern.
    Remove {
        /// The repository (`owner/name`).
        repo: String,
        /// The pattern, as `dg repo protect list` prints it (a bare branch name also works).
        pattern: String,
    },
}

#[derive(Debug, Subcommand)]
pub enum RepoPolicyCommand {
    /// Show the branch policy in force.
    Show {
        /// The repository (`owner/name`).
        repo: String,
    },
    /// Set the branch policy (maintainers). Unset options keep the current policy's value.
    Set(RepoPolicySetArgs),
}

#[derive(Debug, clap::Args)]
pub struct RepoPolicySetArgs {
    /// The repository (`owner/name`).
    pub repo: String,
    /// Approvals a merge needs (0-10).
    #[arg(long = "required-approvals")]
    pub required_approvals: Option<u32>,
    /// Count only maintainers' approvals (`true`), or every member's (`false`).
    #[arg(long = "maintainers-only")]
    pub maintainers_only: Option<bool>,
    /// Require passing checks.
    #[arg(long = "require-checks")]
    pub require_checks: Option<bool>,
    /// Allowed merge methods, comma-separated: `ff`, `merge`, `squash`, `rebase`, or `any`.
    #[arg(long = "merge-methods")]
    pub merge_methods: Option<String>,
    /// Drop the required check names and their pinned sources (otherwise the current policy's
    /// are kept).
    #[arg(long = "clear-required-checks")]
    pub clear_required_checks: bool,
}

#[derive(Debug, Subcommand)]
pub enum RepoKeysCommand {
    /// Show the key epochs, who holds a wrap for the current one, alerts and pending repairs.
    Status {
        /// The repository (`owner/name`).
        repo: String,
    },
    /// Run the repair check (maintainers): rotate if a non-member holds the current key,
    /// else wrap it to every member who has none.
    Repair {
        /// The repository (`owner/name`).
        repo: String,
    },
    /// Rotate to a new key epoch now (maintainers). Removing a member rotates on its own.
    Rotate {
        /// The repository (`owner/name`).
        repo: String,
    },
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
    /// List issues (every issue is read and folded; filters apply to the whole repo).
    List(Box<IssueListArgs>),
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
    /// Edit an issue's title and/or body (its author only).
    Edit {
        /// The repository (`owner/name`).
        repo: String,
        /// The issue number.
        number: u64,
        /// The new title.
        #[arg(long)]
        title: Option<String>,
        /// The new body (`""` clears it).
        #[arg(long, conflicts_with = "body_file")]
        body: Option<String>,
        /// Read the new body from a file (`-` for stdin).
        #[arg(long, value_name = "FILE")]
        body_file: Option<PathBuf>,
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
    /// Edit one of your comments (on an issue or a PR): its body only. In a private repo the
    /// text is re-sealed; an edit made while someone else's landed is refused (E607).
    EditComment {
        /// The repository (`owner/name`).
        repo: String,
        /// The comment's document id (`id` in `dg issue view --json` / `dg pr view --comments --json`).
        comment_id: String,
        /// The new body.
        #[arg(
            long,
            conflicts_with = "body_file",
            required_unless_present = "body_file"
        )]
        body: Option<String>,
        /// Read the new body from a file (`-` for stdin).
        #[arg(long, value_name = "FILE")]
        body_file: Option<PathBuf>,
    },
    /// Delete one of your comments (on an issue or a PR). Only its author can; replies to it
    /// stay, and read as replies to a deleted comment.
    DeleteComment {
        /// The repository (`owner/name`).
        repo: String,
        /// The comment's document id (`id` in `dg issue view --json` / `dg pr view --comments --json`).
        comment_id: String,
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
    /// Add or remove labels on an issue: `dg issue label <repo> <n> add bug docs`, or the
    /// older `--add bug` / `--remove bug`.
    Label {
        /// The repository (`owner/name`).
        repo: String,
        /// The issue number.
        number: u64,
        /// `add` or `remove`, followed by the label names.
        #[arg(value_name = "add|remove LABEL...")]
        words: Vec<String>,
        /// Label to add.
        #[arg(long)]
        add: Option<String>,
        /// Label to remove.
        #[arg(long)]
        remove: Option<String>,
    },
    /// Assign identities (ids or DPNS names; `me` for yourself) to an issue. Members only.
    Assign {
        /// The repository (`owner/name`).
        repo: String,
        /// The issue number.
        number: u64,
        /// Who to assign.
        #[arg(required = true)]
        who: Vec<String>,
    },
    /// Remove assignees from an issue. Members only.
    Unassign {
        /// The repository (`owner/name`).
        repo: String,
        /// The issue number.
        number: u64,
        /// Who to unassign.
        #[arg(required = true)]
        who: Vec<String>,
    },
    /// Put an issue in a milestone, or take it out with `--clear`. Members only.
    Milestone {
        /// The repository (`owner/name`).
        repo: String,
        /// The issue number.
        number: u64,
        /// The milestone's title (see `dg milestone list`).
        #[arg(required_unless_present = "clear")]
        title: Option<String>,
        /// Take the issue out of its milestone.
        #[arg(long, conflicts_with = "title")]
        clear: bool,
    },
    /// Pin an issue to the top of the repository's issue list (unpin with `--off`). Members only.
    Pin {
        /// The repository (`owner/name`).
        repo: String,
        /// The issue number.
        number: u64,
        /// Unpin.
        #[arg(long)]
        off: bool,
    },
    /// Lock an issue's conversation to members (unlock with `--off`). Members only.
    Lock {
        /// The repository (`owner/name`).
        repo: String,
        /// The issue number.
        number: u64,
        /// Unlock.
        #[arg(long)]
        off: bool,
    },
}

/// `dg milestone` subcommands.
#[derive(Debug, Subcommand)]
pub enum MilestoneCommand {
    /// List a repository's milestones with their open and closed issue counts.
    List {
        /// The repository (`owner/name`).
        repo: String,
    },
    /// Define (or redefine: the newest per title wins) a milestone. Maintainers and writers.
    Create {
        /// The repository (`owner/name`).
        repo: String,
        /// The title (1-63 characters): what issues name it by.
        title: String,
        /// A description.
        #[arg(long, default_value = "")]
        description: String,
        /// Due date, `YYYY-MM-DD` (UTC midnight).
        #[arg(long)]
        due: Option<String>,
    },
    /// Close a milestone (a new definition with `closed`), or reopen it with `--reopen`.
    Close {
        /// The repository (`owner/name`).
        repo: String,
        /// The title.
        title: String,
        /// Reopen instead.
        #[arg(long)]
        reopen: bool,
    },
}

/// `dg issue list` arguments.
#[derive(Debug, clap::Args)]
pub struct IssueListArgs {
    /// The repository (`owner/name`).
    pub repo: String,
    /// State filter.
    #[arg(long, value_enum, default_value = "open")]
    pub state: StateArg,
    /// Only issues with this label (repeatable: every one must match).
    #[arg(long = "label", value_name = "NAME")]
    pub labels: Vec<String>,
    /// Only issues by this author (identity id, DPNS name, or `me`).
    #[arg(long)]
    pub author: Option<String>,
    /// Only issues assigned to this identity (id, DPNS name, `me`), or `none`.
    #[arg(long)]
    pub assignee: Option<String>,
    /// Only issues whose title contains every word (`#12` matches the number).
    #[arg(long)]
    pub search: Option<String>,
    /// Rows per page (default 30, at most 100).
    #[arg(long, default_value_t = 30)]
    pub limit: u32,
    /// Page number, 1-based.
    #[arg(long, default_value_t = 1)]
    pub page: u32,
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
    /// View a pull request: state, reviewers, approvals, reviews, threads.
    View {
        /// The repository (`owner/name`).
        repo: String,
        /// The PR number.
        number: u64,
        /// Show every conversation: inline threads under their file and line (outdated and
        /// resolved marked), replies, suggestions, and general comments.
        #[arg(long)]
        comments: bool,
    },
    /// Check out a pull request as branch `pr/<n>`, fetching its head from the source repo,
    /// and switch to it (left for `git switch` when there are uncommitted changes).
    Checkout {
        /// The repository (`owner/name`).
        repo: String,
        /// The PR number.
        number: u64,
    },
    /// Review a pull request on its current head: a verdict, a summary and inline comments,
    /// written as one review plus one comment per `--file`. `--pending` keeps the inline
    /// comments in a local draft until a later run submits them with a verdict. An
    /// interrupted submit resumes when run again, and writes nothing twice.
    Review(Box<PrReviewArgs>),
    /// Post one comment: general, inline (`--file --line`), or a reply (`--reply-to`).
    Comment(Box<PrCommentArgs>),
    /// Edit the title and/or description of your pull request.
    Edit {
        /// The repository (`owner/name`).
        repo: String,
        /// The PR number.
        number: u64,
        /// The new title.
        #[arg(long)]
        title: Option<String>,
        /// The new description (an empty string removes it).
        #[arg(long, conflicts_with = "body_file")]
        body: Option<String>,
        /// Read the new description from a file (`-` for stdin).
        #[arg(long = "body-file")]
        body_file: Option<PathBuf>,
    },
    /// Move the PR head to where its source branch points now (a `headUpdate`). `git push`
    /// does this for you when you push the branch of your own PR (unless
    /// `git config dash.prAutoSync false`).
    Sync {
        /// The repository (`owner/name`).
        repo: String,
        /// The PR number.
        number: u64,
        /// Move the head to this commit instead of the branch tip.
        #[arg(long)]
        head: Option<String>,
    },
    /// Mark a draft pull request ready for review.
    Ready {
        /// The repository (`owner/name`).
        repo: String,
        /// The PR number.
        number: u64,
    },
    /// Convert a pull request to a draft.
    Draft {
        /// The repository (`owner/name`).
        repo: String,
        /// The PR number.
        number: u64,
    },
    /// Lock a pull request's conversation to members (unlock with `--off`). Members only.
    Lock {
        /// The repository (`owner/name`).
        repo: String,
        /// The PR number.
        number: u64,
        /// Unlock.
        #[arg(long)]
        off: bool,
    },
    /// Resolve a conversation (the thread of `comment_id`).
    Resolve {
        /// The repository (`owner/name`).
        repo: String,
        /// The PR number.
        number: u64,
        /// A comment of the thread (its root or any reply).
        comment_id: String,
    },
    /// Unresolve a conversation.
    Unresolve {
        /// The repository (`owner/name`).
        repo: String,
        /// The PR number.
        number: u64,
        /// A comment of the thread (its root or any reply).
        comment_id: String,
    },
    /// Request a review from identities (an identity id, or a DPNS name like `@alice`).
    /// Requesting again someone who has reviewed since re-requests.
    RequestReview {
        /// The repository (`owner/name`).
        repo: String,
        /// The PR number.
        number: u64,
        /// The reviewers.
        #[arg(required = true)]
        reviewers: Vec<String>,
        /// Remove the requests instead.
        #[arg(long)]
        remove: bool,
    },
    /// Remove review requests (`request-review --remove`).
    UnrequestReview {
        /// The repository (`owner/name`).
        repo: String,
        /// The PR number.
        number: u64,
        /// The reviewers.
        #[arg(required = true)]
        reviewers: Vec<String>,
    },
    /// Dismiss a review (maintainers and writers): it no longer counts for or against.
    DismissReview {
        /// The repository (`owner/name`).
        repo: String,
        /// The PR number.
        number: u64,
        /// The review's id (`dg pr view --json` lists them).
        review_id: String,
        /// Why (at most 120 characters; public, even in a private repository).
        #[arg(long, default_value = "")]
        reason: String,
    },
    /// The check runs reported on the PR's current head.
    Checks {
        /// The repository (`owner/name`).
        repo: String,
        /// The PR number.
        number: u64,
    },
    /// The commits the PR adds to its base (fetched over dash://).
    Commits {
        /// The repository (`owner/name`).
        repo: String,
        /// The PR number.
        number: u64,
        /// At most this many (newest first).
        #[arg(long, default_value_t = 250)]
        limit: usize,
    },
    /// Merge a pull request: fast-forward, merge commit or squash, push to the base, post the
    /// event.
    Merge(Box<PrMergeArgs>),
    /// Merge the base branch into the PR's source branch (a merge commit pushed to the source
    /// repository, then a head update). Needs write access to the source repository.
    UpdateBranch {
        /// The repository (`owner/name`).
        repo: String,
        /// The PR number.
        number: u64,
    },
    /// Review suggestions.
    #[command(subcommand)]
    Suggestion(PrSuggestionCommand),
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

/// `dg pr suggestion`.
#[derive(Debug, Subcommand)]
pub enum PrSuggestionCommand {
    /// Apply ```` ```suggestion ```` blocks from review comments as one commit on the PR's
    /// source branch, then move the PR head to it. Needs write access to the source repo.
    Apply {
        /// The repository (`owner/name`).
        repo: String,
        /// The PR number.
        number: u64,
        /// The comments whose suggestions to apply.
        comment_ids: Vec<String>,
        /// Every suggestion on the current head that is not applied yet and whose thread is
        /// not resolved.
        #[arg(long, conflicts_with = "comment_ids")]
        all: bool,
    },
}

/// `dg pr review` arguments.
#[derive(Debug, clap::Args)]
#[allow(clippy::struct_excessive_bools)] // clap flags
pub struct PrReviewArgs {
    /// The repository (`owner/name`).
    pub repo: String,
    /// The PR number.
    pub number: u64,
    /// Approve.
    #[arg(long)]
    pub approve: bool,
    /// Request changes.
    #[arg(long)]
    pub request_changes: bool,
    /// Comment without a verdict.
    #[arg(long)]
    pub comment: bool,
    /// The verdict (alternative to the flags above).
    #[arg(long, value_enum)]
    pub verdict: Option<VerdictArg>,
    /// Keep the given inline comments in the local pending review; nothing is written.
    #[arg(long, conflicts_with_all = ["approve", "request_changes", "comment", "verdict", "discard"])]
    pub pending: bool,
    /// Throw the local pending review away.
    #[arg(long, conflicts_with_all = ["approve", "request_changes", "comment", "verdict"])]
    pub discard: bool,
    /// Finish an interrupted submit (the verdict and summary are the draft's).
    #[arg(long, conflicts_with_all = ["approve", "request_changes", "comment", "verdict", "pending", "discard"])]
    pub resume: bool,
    /// The summary and the inline comments, in order.
    #[command(flatten)]
    pub inline: pr::inline::InlineArgs,
}

/// `dg pr comment` arguments.
#[derive(Debug, clap::Args)]
pub struct PrCommentArgs {
    /// The repository (`owner/name`).
    pub repo: String,
    /// The PR number.
    pub number: u64,
    /// The comment.
    #[arg(long, conflicts_with = "body_file")]
    pub body: Option<String>,
    /// Read the comment from a file (`-` for stdin).
    #[arg(long = "body-file")]
    pub body_file: Option<PathBuf>,
    /// Reply to this comment (its thread).
    #[arg(long = "reply-to", conflicts_with_all = ["file", "line", "start_line", "side"])]
    pub reply_to: Option<String>,
    /// Comment on this file (a file-level comment without `--line`).
    #[arg(long)]
    pub file: Option<String>,
    /// The line (the last line of a range).
    #[arg(long, requires = "file")]
    pub line: Option<u64>,
    /// The first line of a range.
    #[arg(long = "start-line", requires = "line")]
    pub start_line: Option<u64>,
    /// The side of the diff the line is on.
    #[arg(long, value_enum, requires = "line")]
    pub side: Option<pr::inline::SideArg>,
    /// Suggest this text for the lines (a ```` ```suggestion ```` block, new side).
    #[arg(long, requires = "line")]
    pub suggest: Option<String>,
}

/// `dg pr merge` arguments.
#[derive(Debug, clap::Args)]
#[allow(clippy::struct_excessive_bools)] // clap flags
pub struct PrMergeArgs {
    /// The repository (`owner/name`).
    pub repo: String,
    /// The PR number.
    pub number: u64,
    /// Squash the PR's commits into one commit on the base.
    #[arg(long, conflicts_with = "event_only")]
    pub squash: bool,
    /// The squash commit's message (default: the PR title, body and `Co-authored-by` lines).
    #[arg(long, requires = "squash")]
    pub message: Option<String>,
    /// Delete the source branch after merging (needs write access to the source repo).
    #[arg(long = "delete-branch", conflicts_with = "event_only")]
    pub delete_branch: bool,
    /// Merge although the branch policy's approvals or checks are not met (maintainers only;
    /// "bypass rules"). The bypassed rules are recorded on the PR as a comment; the allowed
    /// merge methods still apply. The policy is a client rule every Forge client applies;
    /// consensus does not enforce it.
    #[arg(long = "override-policy")]
    pub override_policy: bool,
    /// Only post the merge event (the merge was pushed some other way).
    #[arg(long)]
    pub event_only: bool,
    /// With --event-only: the commit the event names (default: the PR head, or the base
    /// tip when the head is already in it).
    #[arg(long = "merge-oid", requires = "event_only")]
    pub merge_oid: Option<String>,
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
    /// Open it as a draft (`dg pr ready` marks it ready for review).
    #[arg(long)]
    pub draft: bool,
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
    /// Download a release's assets (every one, or `--asset`). Needs no identity.
    Download {
        /// The repository (`owner/name`).
        repo: String,
        /// The release tag.
        tag: String,
        /// Only this asset (default: every asset of the release).
        #[arg(long)]
        asset: Option<String>,
        /// A directory to save the assets in, by name (default: the current directory), or a
        /// file name for a single asset.
        #[arg(long)]
        output: Option<PathBuf>,
    },
    /// Unpublish a live release (maintainers only): writes a revision with `delta` −1, so the
    /// tag no longer shows as a release. The tag itself, and its previous revisions, are kept
    /// (a release is never deleted); publishing the tag again starts a fresh one.
    Unpublish {
        /// The repository (`owner/name`).
        repo: String,
        /// The release tag.
        tag: String,
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
    /// Mark the release yanked (`--yanked=false` un-yanks it). A public release is yanked only
    /// when a revision says so; a private one keeps its last revision's by default.
    #[arg(long, num_args = 0..=1, default_missing_value = "true", value_name = "BOOL")]
    pub yanked: Option<bool>,
    /// A file to attach (repeatable): uploaded to your storage, sha256 recorded.
    #[arg(long = "asset", value_name = "FILE")]
    pub assets: Vec<PathBuf>,
    /// Storage profiles for the assets (default: this repository's `dash.storage`).
    #[arg(long)]
    pub storage: Option<String>,
    /// Mark the release a draft (`--draft=false` clears it). Private repositories only: a
    /// sealed label every member sees, not access control. Default: as the tag's last revision.
    #[arg(long, num_args = 0..=1, default_missing_value = "true", value_name = "BOOL")]
    pub draft: Option<bool>,
    /// Mark the release a pre-release (`--prerelease=false` clears it). Private repositories
    /// only; a tag with a pre-release suffix (`-rc.1`) is one anyway. Default: as the tag's
    /// last revision.
    #[arg(long, num_args = 0..=1, default_missing_value = "true", value_name = "BOOL")]
    pub prerelease: Option<bool>,
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
    /// Delete a label: retire it, then delete your own definition documents of it (a label
    /// defined by another member stays, retired). Issues keep the label events.
    Delete {
        /// The repository (`owner/name`).
        repo: String,
        /// The label name.
        name: String,
    },
}

#[derive(Debug, Subcommand)]
pub enum CollabCommand {
    /// Add a member (the repo owner creates a writer/maintainer document). The member must
    /// have run `dg collab accept <repo>` first.
    Add {
        /// The repository (`owner/name`).
        repo: String,
        /// The collaborator (identity id or DPNS name, e.g. `alice` or `alice.dash`).
        member: String,
        /// The role to grant.
        #[arg(long, value_enum, default_value = "writer")]
        role: RoleArg,
        /// Wait up to this many seconds for the member to accept (`dg collab accept`) before
        /// adding them. Without it, an add the member has not accepted yet is refused.
        #[arg(long, value_name = "SECONDS")]
        wait: Option<u64>,
    },
    /// Accept membership of a repository (write your consent), so its owner can add you.
    Accept {
        /// The repository (`owner/name`).
        repo: String,
        /// Withdraw an earlier acceptance instead (a membership already granted stands until
        /// the owner removes it).
        #[arg(long)]
        withdraw: bool,
    },
    /// Remove a member (the owner deletes their document; their next push is refused).
    Remove {
        /// The repository (`owner/name`).
        repo: String,
        /// The collaborator (identity id or DPNS name, e.g. `alice` or `alice.dash`).
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
    /// Pre-write quote for a first push: what Platform bills on the chosen backend (an upper
    /// bound, as `git push` quotes it). With neither --bytes nor --path, prices the repository
    /// in the current directory.
    Estimate {
        /// Where the pack bytes go (default: for a repository, the storage its `git push` uses;
        /// for --bytes or a file, platform). s3, ipfs and https keep them off-chain: Platform
        /// bills only the manifests and the ref update.
        #[arg(long)]
        backend: Option<Backend>,
        /// Pack size in bytes.
        #[arg(long, conflicts_with = "path")]
        bytes: Option<u64>,
        /// A repository (the pack of its HEAD and its history index are built, as a push
        /// builds them), or a file whose size is priced.
        #[arg(long)]
        path: Option<PathBuf>,
        /// Price a private repository: its pack and indexes are stored sealed (a little
        /// larger). Visibility is set on chain when the repository is created, so a local
        /// clone cannot tell.
        #[arg(long)]
        private: bool,
    },
    /// An identity's estimated Forge spend: total, per repository, per document type.
    Audit {
        /// The identity to audit (identity id or DPNS name); defaults to the signing
        /// identity. Named `--owner`, not `--identity`, to avoid colliding with the global
        /// `--identity <FILE>` (a key file, not the id being audited) and to mirror `repo
        /// list --owner`'s same "defaults to the signing identity" meaning. Not combined
        /// with the positional REPO argument (that mode audits a repository's storage, not
        /// an identity).
        #[arg(long, conflicts_with = "repo")]
        owner: Option<String>,
        /// Only count documents created at or after this: a duration (`24h`, `7d`, `2w`,
        /// `1y`) or an absolute date (`2026-01-01`). Not combined with REPO.
        #[arg(long, conflicts_with = "repo")]
        since: Option<String>,
        /// A repository (`owner/name`), for its live pack-storage tally instead of the
        /// identity-wide spend estimate.
        repo: Option<String>,
    },
    /// The per-operation price reference: what each kind of write costs, as an upper bound.
    Prices,
}

#[derive(Debug, Subcommand)]
pub enum StorageCommand {
    /// Per-URI availability matrix for a repo's packs.
    Status {
        /// The repository (`owner/name`).
        repo: String,
    },
    /// Add (or replace) a storage profile in ~/.config/dash-forge/storage.toml. With no
    /// arguments in a terminal, asks for each value, tests the storage and prints the
    /// equivalent command.
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
/// `keychain:<service>/<account>`), never values. The prompt flow builds the same struct
/// (`storage_wizard`), so its answers map 1:1 onto these flags.
#[derive(Debug, Default, Clone, PartialEq, Eq, clap::Args)]
#[allow(clippy::struct_field_names)]
pub struct StorageAddArgs {
    /// The profile name (letters, digits, `-`, `_`, `.`). Omit (with every other flag) in a
    /// terminal for the interactive setup.
    pub name: Option<String>,
    /// The profile kind (required with a name).
    #[arg(long, value_enum)]
    pub kind: Option<ProfileKindArg>,
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
    /// Let pushes record this profile's public URL / public gateway on chain even though it
    /// is not a public https address (loopback, LAN, plain http, a temporary tunnel): for a
    /// local test or a LAN-only mirror. Pushes refuse such an address otherwise.
    #[arg(long)]
    pub allow_private_uri: bool,
}

/// A storage backend mode (`repo backend set`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, clap::ValueEnum)]
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

    /// What an empty list says, as `gh` does ("no open pull requests"): the state filter is
    /// named, so an empty default (open) list is not read as an empty repository (QW2-086).
    pub fn empty(self, plural: &str) -> String {
        match self {
            StateArg::All => format!("no {plural}"),
            StateArg::Open => format!("no open {plural}"),
            StateArg::Closed => format!("no closed {plural}"),
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
    forge_core::logging::init_cli();

    let args: Vec<std::ffi::OsString> = std::env::args_os().collect();
    let cli = match Cli::try_parse_from(&args) {
        Ok(cli) => cli,
        // Inside a `dash://` clone a left-out repository is the clone's, as with `gh`.
        Err(e) if e.kind() == clap::error::ErrorKind::MissingRequiredArgument => {
            match infer::with_repo(&args, storage::clone_repo)
                .and_then(|a| Cli::try_parse_from(a).ok())
            {
                Some(cli) => cli,
                None => exit_on_parse_error(&e),
            }
        }
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
    if matches!(
        e.kind(),
        ErrorKind::DisplayHelp
            | ErrorKind::DisplayVersion
            | ErrorKind::DisplayHelpOnMissingArgumentOrSubcommand
    ) {
        e.exit();
    }
    let text = e.to_string();
    let (u, usage) = usage_error(&text);
    if std::env::args().any(|a| a == "--json") {
        errors::print_json(&u.to_json());
    } else {
        // The block every dg error prints (with its code, QW-082), then clap's usage line.
        u.eprint("");
        if !usage.is_empty() {
            eprintln!("\n{usage}");
        }
    }
    std::process::exit(u.exit_code());
}

/// E201 for clap's rendering of a usage error `text`: the whole message (not just its first
/// line: "the following required arguments were not provided: <REPO>") as the cause, and the
/// `Usage:` block, returned apart to print after it.
fn usage_error(text: &str) -> (UserError, String) {
    let (message, usage) = match text.find("\nUsage:") {
        Some(at) => text.split_at(at),
        None => (text, ""),
    };
    let cause = message
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    let usage = usage
        .lines()
        .filter(|l| !l.starts_with("For more information"))
        .collect::<Vec<_>>()
        .join("\n");
    let u = UserError::new(codes::USAGE, "invalid arguments")
        .cause(cause.trim_start_matches("error: "))
        .fix("see `dg --help` or `dg <command> --help`");
    (u, usage.trim().to_string())
}

/// Build the tokio runtime and dispatch the parsed command.
fn run(cli: &Cli) -> Result<()> {
    if cli.json {
        // `--json` is for scripts: no hidden prompt may wait on a terminal.
        forge_core::sealed::forbid_prompts();
    }
    let config = match Config::load() {
        Ok(config) => config,
        // `dg doctor` reports a config.toml that does not parse as a failing row, with the
        // fix, and runs its other checks on the defaults; every other command stops (E204).
        Err(_) if matches!(cli.command, Command::Doctor { .. }) => Config::default(),
        Err(e) => return Err(e),
    };
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
        Command::Milestone(cmd) => milestone::run(ctx, cmd).await,
        Command::Collab(cmd) => collab::run(ctx, cmd).await,
        Command::Cost(cmd) => cost::run(ctx, cmd).await,
        Command::Storage(cmd) => storage::run(ctx, cmd).await,
        Command::Webhook(cmd) => webhook::run(ctx, cmd).await,
        Command::Ci(cmd) => ci::run(ctx, cmd).await,
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
        Command::Import(args) => import::import(ctx, args).await,
        Command::Doctor { fix } => doctor::run(ctx, *fix).await,
        Command::Init(args) => repo::init(ctx, args).await,
        Command::Completions { .. } => unreachable!("handled in main before Ctx::resolve"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;

    /// QW2-086: an empty list names its state filter ("no open pull requests"), as `gh` does.
    #[test]
    fn an_empty_list_names_its_state() {
        assert_eq!(
            StateArg::Open.empty("pull requests"),
            "no open pull requests"
        );
        assert_eq!(StateArg::Closed.empty("issues"), "no closed issues");
        assert_eq!(StateArg::All.empty("issues"), "no issues");
    }

    /// QW2-086: `dg ci status` takes the commit as `dg ci report` does (`--sha`), or as the
    /// positional it always took; never both.
    #[test]
    fn ci_status_takes_the_sha_either_way() {
        let sha = "ab".repeat(20);
        for args in [
            vec!["dg", "ci", "status", "o/r", sha.as_str()],
            vec!["dg", "ci", "status", "o/r", "--sha", sha.as_str()],
            vec!["dg", "ci", "status", "o/r", "--head", sha.as_str()],
        ] {
            let cli = Cli::try_parse_from(&args).unwrap_or_else(|e| panic!("{args:?}: {e}"));
            let Command::Ci(ci::CiCommand::Status {
                sha: pos, sha_flag, ..
            }) = cli.command
            else {
                panic!("{args:?}: not ci status");
            };
            assert_eq!(pos.or(sha_flag).as_deref(), Some(sha.as_str()), "{args:?}");
        }
        assert!(Cli::try_parse_from(["dg", "ci", "status", "o/r"]).is_err());
        assert!(Cli::try_parse_from(["dg", "ci", "status", "o/r", &sha, "--sha", &sha]).is_err());
    }

    /// QW-082 / QW-081: a clap usage error is E201 with its whole message as the cause (the
    /// missing argument's name included), and the usage block kept for after the error block.
    #[test]
    fn a_usage_error_is_e201_with_the_whole_message() {
        let e = Cli::try_parse_from(["dg", "issue", "list"]).unwrap_err();
        let (u, usage) = usage_error(&e.to_string());
        assert_eq!((u.code, u.exit_code()), ("E201", 2));
        let cause = u.cause.unwrap();
        assert!(
            cause.contains("not provided") && cause.contains("<REPO>"),
            "{cause}"
        );
        assert!(!cause.starts_with("error:"), "{cause}");
        assert!(usage.starts_with("Usage: dg issue list"), "{usage}");
        assert!(!usage.contains("For more information"), "{usage}");
    }

    #[test]
    fn parses_issue_delete_comment() {
        let cli = Cli::parse_from([
            "dg",
            "-y",
            "issue",
            "delete-comment",
            "alice/proj",
            "CommentId1",
        ]);
        assert!(matches!(
            cli.command,
            Command::Issue(IssueCommand::DeleteComment { ref repo, ref comment_id })
                if repo == "alice/proj" && comment_id == "CommentId1"
        ));
    }

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
    fn cost_audit_owner_does_not_collide_with_the_global_identity_file_flag() {
        // Regression test: `CostCommand::Audit` once named its "identity id to audit" field
        // `identity`, the same clap arg id as the global `--identity <FILE>` key-file
        // override. Both `Cli::try_parse_from` orders used to panic in `FromArgMatches`
        // ("Mismatch between definition and access") instead of failing gracefully or
        // parsing correctly, since `debug_assert()` does not catch a value-type mismatch on
        // a shared id. Renaming the subcommand field to `--owner` fixed it; this pins both
        // orders parsing cleanly, with each flag going to the right place.
        let cli = Cli::try_parse_from([
            "dg",
            "cost",
            "audit",
            "--owner",
            "9cBMULwtQUMtxhBkgaTKb4tJtoczd8TEQ8gmiroDWf4F",
        ])
        .expect("dg cost audit --owner <id> must parse");
        assert!(matches!(
            cli.command,
            Command::Cost(CostCommand::Audit { owner: Some(o), .. })
                if o == "9cBMULwtQUMtxhBkgaTKb4tJtoczd8TEQ8gmiroDWf4F"
        ));

        let cli = Cli::try_parse_from([
            "dg",
            "--identity",
            "/tmp/id.json",
            "cost",
            "audit",
            "--since",
            "7d",
        ])
        .expect("dg --identity <file> cost audit --since <dur> must parse");
        assert_eq!(
            cli.identity.as_deref().unwrap().to_str().unwrap(),
            "/tmp/id.json"
        );
        assert!(matches!(
            cli.command,
            Command::Cost(CostCommand::Audit { since: Some(s), .. }) if s == "7d"
        ));
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
            "--push",
            "--storage",
            "r2-main,platform",
            "--replicas",
            "1",
            "--description",
            "hello",
        ]);
        match cli.command {
            Command::Repo(RepoCommand::Create(a)) => {
                assert_eq!(a.name.as_deref(), Some("my-repo"));
                assert!(a.push);
                assert_eq!(a.opts.storage.as_deref(), Some("r2-main,platform"));
                assert_eq!(a.opts.replicas, Some(1));
                assert_eq!(a.opts.description, "hello");
                assert_eq!(a.opts.remote(), "origin");
                assert_eq!(a.opts.default_branch, None);
            }
            _ => panic!("expected repo create"),
        }
        // The name is optional (the directory's name), and so is storage.
        let cli = Cli::parse_from(["dg", "repo", "create"]);
        assert!(matches!(cli.command, Command::Repo(RepoCommand::Create(a))
            if a.name.is_none() && a.opts.storage.is_none() && !a.push));
    }

    #[test]
    fn parses_init() {
        let cli = Cli::parse_from([
            "dg",
            "init",
            "--storage",
            "minio",
            "--name",
            "proj",
            "--remote",
            "forge",
        ]);
        match cli.command {
            Command::Init(a) => {
                assert_eq!(a.name.as_deref(), Some("proj"));
                assert_eq!(a.opts.storage.as_deref(), Some("minio"));
                assert_eq!(a.opts.remote(), "forge");
            }
            _ => panic!("expected init"),
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
            Command::Collab(CollabCommand::Add {
                repo, member, role, ..
            }) => {
                assert_eq!(repo, "o/r");
                assert_eq!(member, "member123");
                assert!(matches!(role, RoleArg::Maintainer));
            }
            _ => panic!("expected collab add"),
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
            assert!(script.contains("init"), "{name}: `init` missing");
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
