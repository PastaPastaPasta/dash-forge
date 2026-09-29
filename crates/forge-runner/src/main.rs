//! `forge-runner` — a self-hosted CI runner for Dash Forge, built on nektos/act.
//!
//! It watches repositories (`git ls-remote dash://…` every `interval_secs`, cursors in the state
//! dir), and on a push it checks the commit out, runs `.forge/workflows/*.yml` (GitHub Actions
//! syntax) with [act](https://github.com/nektos/act) in Docker, and reports each job as a Forge
//! check run through `dg ci report`, uploading the job's log to a storage profile with its
//! SHA-256. It signs with DASH_FORGE_KEY: a runner key from `dg ci runner new`, which can write
//! check runs and nothing else.
//!
//! Isolation (docs/guides/ci.md §Self-host a runner): job containers get no Docker socket and
//! join the `bridge` network unless configured otherwise; secrets are passed only for
//! `trusted_refs`; the checkout's own `.actrc`, `.env`, `.secrets`, `.vars` and `.input` are
//! never read. The runner runs pushes to the repository's own refs only: a pull request from
//! a fork is never run.
//!
//! Module map: [`config`] (runner.toml), [`watch`] (refs, cursors), [`act`] (act's CLI and
//! JSON log), [`run`] (one push end to end).

mod act;
mod config;
mod run;
mod watch;

use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context as _, Result};
use clap::{Parser, Subcommand};

use crate::config::Config;
use crate::watch::{parse_ls_remote, pushes, state_path, RepoState};

/// forge-runner command line.
#[derive(Debug, Parser)]
#[command(
    name = "forge-runner",
    version,
    about = "Run Dash Forge workflows with act and report check runs"
)]
struct Cli {
    /// The runner configuration (TOML).
    #[arg(long, short = 'c', default_value = "runner.toml", global = true)]
    config: PathBuf,
    #[command(subcommand)]
    command: Cmd,
}

#[derive(Debug, Subcommand)]
enum Cmd {
    /// Watch the configured repositories and run every push (the default service).
    Watch {
        /// Poll once and exit (cron, tests).
        #[arg(long)]
        once: bool,
    },
    /// Run one commit now, without watching (a manual re-run).
    Run {
        /// The repository (`owner/name`, as configured).
        repo: String,
        /// The ref it was pushed to (`refs/heads/main`).
        #[arg(long = "ref")]
        refname: String,
        /// The commit.
        #[arg(long)]
        sha: String,
    },
}

fn main() {
    let cli = Cli::parse();
    if let Err(e) = real_main(&cli) {
        eprintln!("forge-runner: {e:#}");
        std::process::exit(1);
    }
}

fn real_main(cli: &Cli) -> Result<()> {
    let cfg = Config::load(&cli.config)?;
    if std::env::var_os("DASH_FORGE_KEY").is_none() {
        eprintln!(
            "forge-runner: warning: DASH_FORGE_KEY is not set; reports use dg's default identity"
        );
    }
    match &cli.command {
        Cmd::Watch { once } => loop {
            for repo in &cfg.repos {
                if let Err(e) = poll(&cfg, repo) {
                    eprintln!("forge-runner: {}: {e:#}", repo.repo);
                }
            }
            if *once {
                return Ok(());
            }
            std::thread::sleep(Duration::from_secs(cfg.interval_secs));
        },
        Cmd::Run { repo, refname, sha } => {
            let r = cfg
                .repos
                .iter()
                .find(|r| &r.repo == repo)
                .with_context(|| format!("{repo} is not in {}", cli.config.display()))?;
            let push = watch::Push {
                refname: refname.clone(),
                oid: sha.to_ascii_lowercase(),
                before: None,
            };
            let ran = run::run_push(&cfg, r, &push)?;
            for (job, conclusion) in &ran.jobs {
                println!("{}\t{conclusion}", job.check_name);
            }
            Ok(())
        }
    }
}

/// One poll of one repository: list its refs, run the pushes to watched refs, save the tips.
fn poll(cfg: &Config, repo: &config::RepoConfig) -> Result<()> {
    let path = state_path(&cfg.state_dir, &repo.repo);
    let mut state = RepoState::load(&path)?;
    let now = parse_ls_remote(&run::ls_remote(cfg, repo)?);
    if !state.primed {
        // The first poll records where the repository is; it does not run its history.
        eprintln!("forge-runner: watching {} ({} refs)", repo.repo, now.len());
        state.tips = now;
        state.primed = true;
        return state.save(&path);
    }
    for push in pushes(&state.tips, &now) {
        if repo.runs(&push.refname) {
            eprintln!(
                "forge-runner: {} {} → {}",
                repo.repo,
                push.refname,
                &push.oid[..12]
            );
            if let Err(e) = run::run_push(cfg, repo, &push) {
                eprintln!("forge-runner: {} {}: {e:#}", repo.repo, push.refname);
            }
        }
        // Recorded either way: a failed checkout is not retried every poll (`run` re-runs it).
        state.tips.insert(push.refname.clone(), push.oid.clone());
        state.save(&path)?;
    }
    // Deleted refs leave the cursor too.
    state.tips.retain(|r, _| now.contains_key(r));
    state.save(&path)
}
