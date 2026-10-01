//! `dg import`: a thin wrapper over the forge-import library. Same engine as
//! the `forge-import` binary (and the GitHub Mirror Action): estimate first, `--max-spend`
//! checked before every write, idempotent re-runs.

use std::path::PathBuf;

use anyhow::Result;

use forge_core::user_error::{codes, UserError};
use forge_import::budget::dash_to_credits;
use forge_import::importer::{self, ImportConfig};
use forge_import::source::{self, Classes};
use forge_import::summary::{Status, Summary};

use crate::context::Ctx;

/// `dg import` options.
#[derive(Debug, clap::Args)]
pub struct ImportArgs {
    /// The source. GitHub: `github.com/owner/repo`, its URL, or `owner/repo`. GitLab:
    /// `gitlab.com/group/project` or its URL, or `group/project` with `--gitlab-url`
    /// (token: `GITLAB_TOKEN`).
    pub url: String,
    #[command(flatten)]
    pub gitlab: source::GitlabOptions,
    /// Destination repository (`owner/name`, or a bare name of yours; default: the source's
    /// name). Created when missing.
    #[arg(long)]
    pub repo: Option<String>,
    /// What to import: code, issues, prs, releases, labels, or all.
    #[arg(long, default_value = "all")]
    pub sync: String,
    /// Incremental state file (only items updated at the source since the last run are read).
    #[arg(long)]
    pub state: Option<PathBuf>,
    /// Hard cap in DASH, checked before every write.
    #[arg(long, value_name = "DASH")]
    pub max_spend: Option<f64>,
    /// Price only; write nothing.
    #[arg(long)]
    pub dry_run: bool,
    /// A private destination: mirror the label definitions too. Their names, colours and
    /// descriptions are not encrypted, so by default they are left out (the labels set on
    /// issues and PRs are encrypted either way).
    #[arg(long)]
    pub include_label_definitions: bool,
    /// Import at most this many issues and PRs (0 = all).
    #[arg(long, default_value_t = 0)]
    pub limit: usize,
    /// Parallel lanes for each issue's and PR's comments, reviews, labels and state (issues
    /// and PRs are always created one at a time, in upstream order). 1: one write at a time.
    #[arg(
        long,
        value_name = "N",
        default_value_t = forge_import::pipeline::DEFAULT_LANES,
        value_parser = forge_import::pipeline::parse_lanes
    )]
    pub concurrency: usize,
}

fn max_spend(dash: Option<f64>) -> Result<Option<u64>> {
    dash.map(dash_to_credits).transpose().map_err(|e| {
        UserError::new(codes::USAGE, "invalid --max-spend")
            .cause(e.to_string())
            .into()
    })
}

/// Report a summary: the table (or, with `--json`, the summary as the one JSON object on
/// stdout, carrying an `"error"` block when the run did not finish), and an error with the
/// right code when it did not.
fn report(ctx: &Ctx, summary: &Summary) -> Result<()> {
    if !ctx.json {
        summary.print();
    }
    let error = match summary.status {
        Status::Ok | Status::DryRun => None,
        Status::Partial => Some(
            UserError::new(codes::PARTIAL, "some items were not mirrored")
                .cause(if summary.incomplete {
                    "part of what was asked for was left out (the source refused to list it, or a release's asset could not be sealed); see the warnings".to_string()
                } else {
                    format!(
                        "{} item(s) and {} optional git push(es) skipped; see the warnings",
                        summary.counts.skipped, summary.counts.git_skipped
                    )
                })
                .fix("re-run later: skipped items are retried, and written ones are not written again"),
        ),
        Status::CapExceeded => Some(
            UserError::new(codes::COST_GUARD, "stopped at --max-spend")
                .cause(summary.error.clone().unwrap_or_default())
                .fix("re-run with a higher --max-spend; what was written is not written again"),
        ),
        Status::Error => {
            let e = anyhow::anyhow!(summary
                .error
                .clone()
                .unwrap_or_else(|| "the run failed".into()));
            Some(forge_core::user_error::classify(
                e.chain(),
                &forge_core::user_error::ErrorContext::default(),
            ))
        }
    };
    let body = serde_json::to_value(summary)?;
    match error {
        None => {
            if ctx.json {
                crate::errors::print_json(&body);
            }
            Ok(())
        }
        // In human mode the table is already out, and `reported` prints only the error.
        Some(e) => Err(crate::errors::reported(e, body)),
    }
}

/// `dg import`.
pub async fn import(ctx: &Ctx, a: &ImportArgs) -> Result<()> {
    let cfg = ImportConfig {
        source: source::parse(&a.url, &a.gitlab).map_err(|e| {
            UserError::new(codes::USAGE, "not a GitHub repository or GitLab project")
                .cause(e.to_string())
        })?,
        dest: a.repo.clone(),
        classes: Classes {
            include_label_definitions: a.include_label_definitions,
            ..Classes::parse(&a.sync)
                .map_err(|e| UserError::new(codes::USAGE, "invalid --sync").cause(e.to_string()))?
        },
        state_path: a.state.clone(),
        work_dir: None,
        max_spend: max_spend(a.max_spend)?,
        dry_run: a.dry_run,
        yes: ctx.yes,
        limit: a.limit,
        network: ctx.target.clone(),
        key: ctx.identity_path.clone(),
        concurrency: a.concurrency,
    };
    report(ctx, &importer::run(&cfg).await)
}
