//! `forge-import <github repo>`: mirror a GitHub repository into forge-v2, once or
//! repeatedly.
//!
//! 1. Mirror the git data locally (`git clone --mirror`, then `fetch --prune`), read the
//!    GitHub collaboration data (only what changed since the last run with `--state`).
//! 2. Resolve the destination; price everything (the git push by a helper dry run, each
//!    document by its bytes); refuse up front past `--max-spend`.
//! 3. Push the git data through `git-remote-dash`, then write the collaboration documents
//!    missing on chain, charging each write to the budget before it is signed.
//!
//! A re-run with nothing new writes nothing and costs nothing: git sees up-to-date refs,
//! and the collaboration diff finds every item already there (see [`crate::sink`]).

use std::path::PathBuf;

use anyhow::{Context, Result};

use forge_core::network::NetworkTarget;
use forge_core::platform::PlatformClient;
use forge_core::repo::credits_to_dash;

use crate::budget::Budget;
use crate::dest::{self, Outcome, Signer, REPO_CREATE_CREDITS};
use crate::github::{GithubClient, GithubRepoRef};
use crate::gitsync::{GitPusher, Refs};
use crate::sink::Ledger;
use crate::source_github::{self, Classes};
use crate::state::{self, SyncState};
use crate::summary::{Status, Summary};

/// Everything the CLI resolved.
pub struct ImportConfig {
    /// The GitHub source.
    pub source: GithubRepoRef,
    /// The destination spec (default: the source's name, owned by the signer).
    pub dest: Option<String>,
    /// What to sync.
    pub classes: Classes,
    /// Incremental state file.
    pub state_path: Option<PathBuf>,
    /// Where the bare git mirror lives between runs (default: a temp dir).
    pub work_dir: Option<PathBuf>,
    /// Hard cap, credits.
    pub max_spend: Option<u64>,
    /// Enumerate, diff and price only.
    pub dry_run: bool,
    /// No confirmation prompt.
    pub yes: bool,
    /// Cap on issues + PRs (0 = all).
    pub limit: usize,
    /// The network.
    pub network: NetworkTarget,
    /// The signing identity source; optional for a dry run.
    pub key: Option<PathBuf>,
}

/// Run an import. Always returns a summary (a failure is its status and error; what was
/// spent before it is still reported).
pub async fn run(cfg: &ImportConfig) -> Summary {
    let mut summary = Summary::new(
        cfg.network.network.key(),
        format!("github.com/{}", cfg.source.slug()),
    );
    let client = match PlatformClient::connect(cfg.network.clone()).await {
        Ok(c) => c,
        Err(e) => {
            let err = anyhow::Error::from(e).context("connecting to Dash Platform");
            return dest::finish(summary, Outcome::default(), Err(err)).await;
        }
    };
    let signer = match Signer::load_opt(&client, cfg.key.as_deref(), cfg.dry_run).await {
        Ok(s) => s,
        Err(e) => return dest::finish(summary, Outcome::default(), Err(e)).await,
    };
    let mut outcome = Outcome {
        ledger: None,
        signer: signer.as_ref().map(|s| (&client, s)),
    };
    let result = run_inner(cfg, &client, signer.as_ref(), &mut summary, &mut outcome).await;
    dest::finish(summary, outcome, result).await
}

#[allow(clippy::too_many_lines)] // one sequential run: read, price, confirm, write
async fn run_inner<'a>(
    cfg: &ImportConfig,
    client: &'a PlatformClient,
    signer: Option<&'a Signer>,
    summary: &mut Summary,
    outcome: &mut Outcome<'a>,
) -> Result<()> {
    let started = state::now();
    let gh = GithubClient::new(cfg.source.clone());
    let meta = gh.repo_meta().context("reading the GitHub repository")?;
    let signer_id = signer.map(Signer::id);
    let spec = cfg
        .dest
        .clone()
        .unwrap_or_else(|| cfg.source.repo.to_ascii_lowercase());
    let mut dest = dest::resolve(client, signer_id.as_deref(), &spec).await?;
    summary.repo = dest.info(false);

    // Collaboration data (diffed on chain; `since` narrows what GitHub is asked for).
    let scope = state::scope(&summary.source, cfg.classes, cfg.limit);
    let existing_id = dest.existing.as_ref().map(|r| r.id().to_string());
    let mut sync_state = SyncState::load(
        cfg.state_path.as_deref(),
        &scope,
        existing_id.as_deref().unwrap_or_default(),
    );
    let since = sync_state.since();
    let collab_src =
        source_github::collect(&gh, &cfg.source, cfg.classes, since.as_deref(), cfg.limit)?;

    // Git data.
    let work = cfg.work_dir.clone().unwrap_or_else(|| {
        std::env::temp_dir().join(format!(
            "forge-import-{}-{}-{}",
            cfg.source.owner,
            cfg.source.repo,
            std::process::id()
        ))
    });
    let _cleanup = cfg.work_dir.is_none().then(|| TempDir(work.clone()));
    if cfg.classes.code {
        gh.sync_mirror(&work).context("mirroring the git data")?;
    }

    // Price everything, then the up-front cap check. Branches and tags, then the open PRs'
    // heads, are separate pushes (see gitsync).
    let create = dest.existing.is_none();
    let pushes: Vec<Refs> = if cfg.classes.code {
        vec![Refs::Code, Refs::PullHeads(collab_src.open_pulls.clone())]
    } else {
        Vec::new()
    };
    let git_pusher = |url: String, refs: &Refs| GitPusher {
        git_dir: work.clone(),
        url,
        key: cfg.key.clone().unwrap_or_default(),
        network: cfg.network.clone(),
        refs: refs.clone(),
    };
    let mut push_estimates = Vec::with_capacity(pushes.len());
    for refs in &pushes {
        push_estimates.push(if !create && signer.is_some() {
            // The helper prices a push into an existing repo (storage policy included).
            git_pusher(dest.url(), refs).estimate()?
        } else {
            // A new repo (or no identity to ask the helper with): price the whole pack.
            crate::gitsync::estimate_fresh(&work, refs)?
        });
    }
    let git_estimate: u64 = push_estimates.iter().map(|p| p.est_credits).sum();
    let dry = dest::dry_collab(
        client,
        dest.existing.clone(),
        signer_id.clone(),
        &collab_src,
    )
    .await?;
    let collab_estimate = dry.budget.spent();
    let create_credits = if create { REPO_CREATE_CREDITS } else { 0 };
    let estimate = create_credits + git_estimate + collab_estimate;
    summary.estimate_credits = estimate;
    eprintln!(
        "{} → {}: estimated {:.6} DASH (repo {:.6}, git {:.6}, issues/PRs/releases {:.6})",
        summary.source,
        dest.url(),
        credits_to_dash(estimate),
        credits_to_dash(create_credits),
        credits_to_dash(git_estimate),
        credits_to_dash(collab_estimate),
    );
    let mut budget = Budget::new(cfg.max_spend);

    if cfg.dry_run {
        summary.counts = dry.counts;
        for p in &push_estimates {
            summary.counts.add_push(p);
        }
        summary.warnings.extend(dry.warnings);
        if let Err(e) = budget.check_plan(estimate) {
            summary.warnings.push(format!("a real run would stop: {e}"));
        }
        summary.status = Status::DryRun;
        return Ok(());
    }
    let signer = signer.expect("load_opt returns a signer outside a dry run");
    let key_left = signer.key_info(client).await.remaining_credits;
    budget.check_funds(estimate, signer.identity.balance(), key_left)?;
    dest::confirm(cfg.yes, estimate)?;
    budget.start(signer.identity.balance());
    outcome.ledger = Some(Ledger::new(client, Some(signer.id()), false, budget));
    let ledger = outcome.ledger.as_mut().expect("just set");

    // 1. The repository.
    if create {
        ledger
            .budget
            .charge(REPO_CREATE_CREDITS, "creating the repository")?;
        let description = meta
            .description
            .as_deref()
            .filter(|d| !d.is_empty())
            .map_or_else(
                || format!("Mirror of github.com/{}", cfg.source.slug()),
                |d| format!("{d} (mirror of github.com/{})", cfg.source.slug()),
            );
        let created = dest::create(
            client,
            signer,
            &mut dest,
            &description,
            &meta.default_branch,
        )
        .await?;
        summary.repo = dest.info(created);
        ledger.reconcile().await;
    }
    let repo = dest.existing.clone().expect("created or existing");
    let role = dest::require_member(client, &repo, &signer.id()).await?;
    if existing_id.is_none() {
        sync_state = SyncState::load(cfg.state_path.as_deref(), &scope, repo.id());
    }

    // 2. Git data: each push priced (reusing the estimate for an existing repo), charged,
    //    then pushed with the helper's guard set to what is left of the budget.
    for (refs, est) in pushes.iter().zip(push_estimates) {
        let p = git_pusher(dest.url(), refs);
        let est = if create { p.estimate()? } else { est };
        if est.refs == 0 {
            continue;
        }
        let what = match refs {
            Refs::Code => "the git push (branches and tags)".to_string(),
            Refs::PullHeads(_) => "the push of open pull request heads".to_string(),
        };
        if matches!(refs, Refs::PullHeads(_)) && !ledger.budget.fits(est.est_credits) {
            // Heads of PRs are optional: a stranger's huge PR must not stop the mirror.
            ledger.skip(format!(
                "{what} (~{:.6} DASH) does not fit under --max-spend; skipped this run",
                credits_to_dash(est.est_credits)
            ));
            continue;
        }
        ledger.budget.charge(est.est_credits, what)?;
        let guard = ledger
            .budget
            .remaining()
            .map(|r| r.saturating_add(est.est_credits));
        ledger.counts.add_push(&p.push(guard)?);
        ledger.reconcile().await;
    }

    // 3. Issues, PRs, comments, reviews, events, labels, releases.
    dest::write_collab(client, signer, role, repo, &collab_src, outcome).await?;
    // Advance the incremental state only when every item was read and mirrored: items past
    // `--limit`, or skipped, are retried by the next run.
    let skipped = outcome.ledger.as_ref().map_or(0, |l| l.counts.skipped);
    if collab_src.truncated || skipped > 0 {
        return Ok(());
    }
    sync_state.save(started)
}

/// Removes a temporary directory on drop.
pub(crate) struct TempDir(pub(crate) PathBuf);

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
