//! `forge-import`: mirror a GitHub repository or a GitLab project into forge-v2 (once, or
//! incrementally from CI), or run the gist author-claim check.

use std::path::PathBuf;
use std::process::ExitCode;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};

use forge_core::network::{NetworkSettings, NetworkTarget};
use forge_import::budget::dash_to_credits;
use forge_import::importer::{self, ImportConfig};
use forge_import::source::{self, Classes};
use forge_import::summary::{Status, Summary};

/// forge-import CLI.
#[derive(Debug, Parser)]
#[command(
    name = "forge-import",
    version = env!("DASH_FORGE_VERSION"),
    about = "Mirror a GitHub repository or a GitLab project into Dash Forge (forge-v2)",
    args_conflicts_with_subcommands = true
)]
struct Cli {
    /// The source. GitHub: `owner/repo`, `github.com/owner/repo` or its https URL (read with
    /// `gh`). GitLab: `gitlab.com/group/project` or its https URL, or `group/project` with
    /// `--gitlab-url` (read with `GITLAB_TOKEN`, a token with the `read_api` scope).
    source: Option<String>,

    #[command(flatten)]
    run: RunArgs,

    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Debug, clap::Args)]
struct RunArgs {
    /// Destination forge-v2 repository: `owner/name`, `dash://owner/name`, a repo id, or a
    /// bare name (yours). Created when missing and you are the owner. Default: the source's
    /// name.
    #[arg(long, alias = "repo-name")]
    repo: Option<String>,

    /// What to mirror: comma list of code, issues, prs, releases, labels (or all). `prs`
    /// means merge requests for GitLab (`mrs` works too).
    #[arg(long, default_value = "all")]
    sync: String,

    #[command(flatten)]
    gitlab: source::GitlabOptions,

    /// Incremental state file: only items updated at the source since the last successful
    /// run are read. Optional; what is already mirrored is always decided on chain.
    #[arg(long)]
    state: Option<PathBuf>,

    /// Keep the bare git mirror here between runs (default: a temporary directory).
    #[arg(long)]
    work_dir: Option<PathBuf>,

    /// Hard cap for this run, in DASH: refused up front when the estimate exceeds it, and
    /// checked again before every write against what the run has spent so far.
    #[arg(long, value_name = "DASH")]
    max_spend: Option<f64>,

    /// Read, diff and price only; write nothing.
    #[arg(long)]
    dry_run: bool,

    /// A private destination: mirror the label definitions too. Their names, colours and
    /// descriptions are not encrypted, so by default they are left out (the labels set on
    /// issues and PRs are encrypted either way).
    #[arg(long)]
    include_label_definitions: bool,

    /// Do not ask for confirmation.
    #[arg(long, short = 'y')]
    yes: bool,

    /// Mirror at most this many issues and PRs (0 = all); for cheap trials.
    #[arg(long, default_value_t = 0)]
    limit: usize,

    /// Write the run summary as JSON here (the Mirror Action reads it).
    #[arg(long)]
    summary_json: Option<PathBuf>,

    #[command(flatten)]
    net: NetArgs,
}

#[derive(Debug, clap::Args)]
struct NetArgs {
    /// Signing identity: a bridge identity file, or `dfk1:<network>:<id>:<keyId>:<wif>`.
    /// Default: `DASH_FORGE_KEY`.
    #[arg(long, global = true)]
    identity: Option<PathBuf>,

    /// Network (default: `DASH_FORGE_NETWORK`, else testnet).
    #[arg(long, global = true, value_parser = ["testnet", "mainnet", "devnet"])]
    network: Option<String>,

    /// Devnet name (e.g. `bonsia`); implies `--network devnet`.
    #[arg(long, global = true)]
    devnet_name: Option<String>,

    /// Devnet DAPI addresses, comma-separated.
    #[arg(long, global = true)]
    dapi_addresses: Option<String>,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Check a GitHub author claim (signed gist challenge).
    Claim {
        /// The GitHub login being claimed.
        login: String,
        /// The gist URL (or id) carrying the signed challenge.
        #[arg(long)]
        gist: String,
    },
}

fn target(net: &NetArgs) -> Result<NetworkTarget> {
    Ok(NetworkSettings::from_flags(
        net.network.clone(),
        net.devnet_name.clone(),
        net.dapi_addresses.clone(),
    )
    .overlay(NetworkSettings::from_env())
    .resolve()?)
}

fn key(net: &NetArgs) -> Option<PathBuf> {
    if net
        .identity
        .as_deref()
        .is_some_and(forge_core::keystore::is_inline_key)
    {
        eprintln!(
            "forge-import: warning: {}",
            forge_core::keystore::INLINE_KEY_ON_ARGV
        );
    }
    net.identity.clone().or_else(|| {
        std::env::var_os("DASH_FORGE_KEY")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
    })
}

fn finish(summary: &Summary, json: Option<&PathBuf>) -> ExitCode {
    summary.print();
    if let Some(p) = json {
        if let Err(e) = summary.write_json(p) {
            eprintln!("forge-import: writing {}: {e}", p.display());
            return ExitCode::FAILURE;
        }
    }
    match summary.status {
        Status::Ok | Status::DryRun => ExitCode::SUCCESS,
        Status::CapExceeded => ExitCode::from(3),
        Status::Partial => ExitCode::from(4),
        Status::Error => ExitCode::FAILURE,
    }
}

#[tokio::main]
async fn main() -> ExitCode {
    // Runs unattended (the Mirror Action): a sealed key file needs DASH_FORGE_PASSPHRASE.
    forge_core::sealed::forbid_prompts();
    forge_core::logging::init_cli();
    match Box::pin(run(Cli::parse())).await {
        Ok(code) => code,
        Err(e) => {
            eprintln!(
                "forge-import: {}",
                forge_core::user_error::redact(&format!("{e:#}"))
            );
            ExitCode::FAILURE
        }
    }
}

async fn run(cli: Cli) -> Result<ExitCode> {
    match cli.command {
        Some(Command::Claim { login, gist }) => {
            let c = forge_import::claim::verify(&login, &gist)?;
            println!(
                "author claim verified: github {} → dash identity {}",
                c.github_login, c.identity_id
            );
            Ok(ExitCode::SUCCESS)
        }
        None => {
            let spec = cli.source.context(
                "missing the source (owner/repo, or gitlab.com/group/project); see --help",
            )?;
            let r = cli.run;
            let cfg = ImportConfig {
                source: source::parse(&spec, &r.gitlab)?,
                dest: r.repo.clone(),
                classes: Classes {
                    include_label_definitions: r.include_label_definitions,
                    ..Classes::parse(&r.sync)?
                },
                state_path: r.state.clone(),
                work_dir: r.work_dir.clone(),
                max_spend: r.max_spend.map(dash_to_credits).transpose()?,
                dry_run: r.dry_run,
                yes: r.yes,
                limit: r.limit,
                network: target(&r.net)?,
                key: key(&r.net),
            };
            Ok(finish(&importer::run(&cfg).await, r.summary_json.as_ref()))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::CommandFactory;

    #[test]
    fn cli_is_consistent() {
        Cli::command().debug_assert();
    }

    #[test]
    fn parses_the_action_invocation() {
        let cli = Cli::try_parse_from([
            "forge-import",
            "o/r",
            "--repo",
            "mirror",
            "--sync",
            "code,issues",
            "--state",
            "/tmp/s.json",
            "--max-spend",
            "0.05",
            "--yes",
            "--summary-json",
            "/tmp/sum.json",
            "--network",
            "devnet",
            "--devnet-name",
            "moutai",
        ])
        .unwrap();
        assert_eq!(cli.source.as_deref(), Some("o/r"));
        assert_eq!(cli.run.max_spend, Some(0.05));
        assert!(cli.command.is_none());
    }

    #[test]
    fn parses_a_gitlab_invocation() {
        let cli = Cli::try_parse_from([
            "forge-import",
            "team/app",
            "--gitlab-url",
            "https://git.example.org",
            "--sync",
            "code,issues,mrs",
        ])
        .unwrap();
        let src = source::parse(cli.source.as_deref().unwrap(), &cli.run.gitlab).unwrap();
        assert_eq!(src.display(), "git.example.org/team/app");
        assert!(Classes::parse(&cli.run.sync).unwrap().prs);
        let none = source::GitlabOptions::default();
        assert_eq!(
            source::parse("gitlab.com/g/p", &none).unwrap().display(),
            "gitlab.com/g/p"
        );
        assert_eq!(
            source::parse("o/r", &none).unwrap().display(),
            "github.com/o/r"
        );
        // GitLab-only flags on a GitHub source are a mistake worth saying.
        let members = source::GitlabOptions {
            include_members_only: true,
            ..Default::default()
        };
        assert!(source::parse("o/r", &members).is_err());
        // http:// needs --allow-http.
        let http =
            Cli::try_parse_from(["forge-import", "a/b", "--gitlab-url", "http://lab"]).unwrap();
        assert!(source::parse("a/b", &http.run.gitlab).is_err());
        let allowed = Cli::try_parse_from([
            "forge-import",
            "a/b",
            "--gitlab-url",
            "http://lab",
            "--allow-http",
        ])
        .unwrap();
        assert!(source::parse("a/b", &allowed.run.gitlab).is_ok());
    }
}
