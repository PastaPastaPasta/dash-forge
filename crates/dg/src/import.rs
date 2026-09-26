//! `dg import` / `dg migrate`: thin wrappers over the forge-import library. Same engine as
//! the `forge-import` binary (and the GitHub Mirror Action): estimate first, `--max-spend`
//! checked before every write, idempotent re-runs.

use std::path::PathBuf;

use anyhow::Result;

use forge_core::user_error::{codes, UserError};
use forge_import::budget::dash_to_credits;
use forge_import::github::GithubRepoRef;
use forge_import::importer::{self, ImportConfig};
use forge_import::migrate::{self, MigrateConfig};
use forge_import::source_github::Classes;
use forge_import::summary::{Status, Summary};

use crate::context::Ctx;

/// `dg import` options.
#[derive(Debug, clap::Args)]
pub struct ImportArgs {
    /// The GitHub repository: `github.com/owner/repo`, its URL, or `owner/repo`.
    pub url: String,
    /// Destination repository (`owner/name`, or a bare name of yours; default: the GitHub
    /// name). Created when missing.
    #[arg(long)]
    pub repo: Option<String>,
    /// What to import: code, issues, prs, releases, labels, or all.
    #[arg(long, default_value = "all")]
    pub sync: String,
    /// Incremental state file (only GitHub items updated since the last run are read).
    #[arg(long)]
    pub state: Option<PathBuf>,
    /// Hard cap in DASH, checked before every write.
    #[arg(long, value_name = "DASH")]
    pub max_spend: Option<f64>,
    /// Price only; write nothing.
    #[arg(long)]
    pub dry_run: bool,
    /// Import at most this many issues and PRs (0 = all).
    #[arg(long, default_value_t = 0)]
    pub limit: usize,
}

/// `dg migrate` options.
#[derive(Debug, clap::Args)]
pub struct MigrateArgs {
    /// The forge-v1 repository: `owner/name` or its contract id.
    pub source: String,
    /// The network it is on.
    #[arg(long, default_value = "testnet", value_parser = ["testnet", "mainnet", "devnet"])]
    pub from_network: String,
    /// Its devnet name, when `--from-network devnet`.
    #[arg(long)]
    pub from_devnet_name: Option<String>,
    /// Destination repository (default: the v1 name, yours).
    #[arg(long)]
    pub repo: Option<String>,
    /// Leave out issues, prs, labels, releases or members (repeatable).
    #[arg(long, value_parser = ["issues", "prs", "labels", "releases", "members"])]
    pub skip: Vec<String>,
    /// Hard cap in DASH, checked before every write.
    #[arg(long, value_name = "DASH")]
    pub max_spend: Option<f64>,
    /// Price only; write nothing.
    #[arg(long)]
    pub dry_run: bool,
}

fn max_spend(dash: Option<f64>) -> Result<Option<u64>> {
    dash.map(dash_to_credits).transpose().map_err(|e| {
        UserError::new(codes::USAGE, "invalid --max-spend")
            .cause(e.to_string())
            .into()
    })
}

/// Report a summary: the table (or `--json`), and an error with the right code when the
/// run did not finish.
fn report(ctx: &Ctx, summary: &Summary) -> Result<()> {
    if ctx.json {
        crate::errors::print_json(&serde_json::to_value(summary)?);
    } else {
        summary.print();
    }
    match summary.status {
        Status::Ok | Status::DryRun => Ok(()),
        Status::CapExceeded => Err(UserError::new(codes::COST_GUARD, "stopped at --max-spend")
            .cause(summary.error.clone().unwrap_or_default())
            .fix("re-run with a higher --max-spend; what was written is not written again")
            .into()),
        Status::Error => Err(anyhow::anyhow!(summary
            .error
            .clone()
            .unwrap_or_else(|| "import failed".into()))),
    }
}

/// `dg import`.
pub async fn import(ctx: &Ctx, a: &ImportArgs) -> Result<()> {
    let cfg = ImportConfig {
        source: GithubRepoRef::parse(&a.url).map_err(|e| {
            UserError::new(codes::USAGE, "not a GitHub repository").cause(e.to_string())
        })?,
        dest: a.repo.clone(),
        classes: Classes::parse(&a.sync)
            .map_err(|e| UserError::new(codes::USAGE, "invalid --sync").cause(e.to_string()))?,
        state_path: a.state.clone(),
        work_dir: None,
        max_spend: max_spend(a.max_spend)?,
        dry_run: a.dry_run,
        yes: ctx.yes,
        limit: a.limit,
        network: ctx.target.clone(),
        key: ctx.identity_path.clone(),
    };
    report(ctx, &importer::run(&cfg).await)
}

/// `dg migrate`.
pub async fn migrate(ctx: &Ctx, a: &MigrateArgs) -> Result<()> {
    let (classes, members) = Classes::from_skip(&a.skip);
    let cfg = MigrateConfig {
        source: a.source.clone(),
        source_network: migrate::source_network(&a.from_network, a.from_devnet_name.clone())?,
        dest: a.repo.clone(),
        network: ctx.target.clone(),
        classes,
        members,
        max_spend: max_spend(a.max_spend)?,
        dry_run: a.dry_run,
        yes: ctx.yes,
        key: ctx.identity_path.clone(),
    };
    report(ctx, &migrate::run(&cfg).await)
}
