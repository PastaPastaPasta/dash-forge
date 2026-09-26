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
use crate::gitsync::{GitPusher, PushReport, Refs};
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
    if collab_src.truncated && cfg.state_path.is_some() {
        // Every run would take the same first `--limit` items and never reach the rest.
        summary.warnings.push(format!(
            "--limit {} left issues or PRs out, so --state does not advance: a recurring run \
             with --limit never reaches the rest; drop --limit once the trial looks right",
            cfg.limit
        ));
    }

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
        crate::gitsync::sync_pull_heads(&work, &collab_src.open_pulls)
            .context("preparing the open pull requests' heads")?;
    }

    // Price everything, then the up-front cap check. Branches and tags, then the open PRs'
    // heads, are separate pushes (see gitsync); the second is optional, so it is priced for
    // the report but kept out of the hard up-front check, and re-priced after the first.
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
        let est = if !create && signer.is_some() {
            // The helper prices a push into an existing repo (storage policy included).
            git_pusher(dest.url(), refs).estimate()
        } else {
            // A new repo (or no identity to ask the helper with): price the whole pack.
            crate::gitsync::estimate_fresh(&work, refs)
        };
        push_estimates.push(match (refs, est) {
            (_, Ok(e)) => e,
            (Refs::Code, Err(e)) => return Err(e),
            // Optional: a PR head the helper cannot price is skipped at push time.
            (Refs::PullHeads(_), Err(_)) => PushReport::default(),
        });
    }
    let code_estimate = push_estimates.first().map_or(0, |p| p.est_credits);
    let heads_estimate = push_estimates.get(1).map_or(0, |p| p.est_credits);
    let git_estimate = code_estimate + heads_estimate;
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
    // What the run must be able to pay (the optional PR heads left out).
    let required = estimate - heads_estimate;
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
        if let Err(e) = budget.check_plan(required) {
            summary.warnings.push(format!("a real run would stop: {e}"));
        } else if !budget.fits(estimate) {
            summary.warnings.push(
                "the open pull requests' heads would not fit under --max-spend; a real run \
                 would skip them"
                    .into(),
            );
        }
        summary.status = Status::DryRun;
        return Ok(());
    }
    let signer = signer.expect("load_opt returns a signer outside a dry run");
    let key_left = signer.key_info(client).await.remaining_credits;
    budget.check_funds(required, signer.identity.balance(), key_left)?;
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

    // 2. Git data: branches and tags (required), then the open PRs' heads (optional: a
    //    stranger's huge or unfetchable PR must not stop the mirror).
    let mut code_estimate = push_estimates.into_iter().next();
    for refs in &pushes {
        let p = git_pusher(dest.url(), refs);
        let optional = matches!(refs, Refs::PullHeads(_));
        let what = if optional {
            "the push of open pull request heads"
        } else {
            "the git push (branches and tags)"
        };
        // Priced by the helper against the repo as it is now: the code estimate is reused
        // for an existing repo; the PR heads are re-priced after the code push landed.
        let est = match code_estimate.take().filter(|_| !create && !optional) {
            Some(e) => Ok(e),
            None => p.estimate(),
        };
        let res = match est {
            Ok(est) => push_one(ledger, &p, est, what).await,
            Err(e) => Err(e),
        };
        match res {
            Ok(()) => {}
            Err(e) if optional && e.downcast_ref::<crate::budget::CapExceeded>().is_none() => {
                ledger.skip_git(format!("{what} skipped this run: {e:#}"));
            }
            Err(e) if optional => {
                ledger.skip_git(format!(
                    "{what} does not fit under --max-spend; skipped: {e}"
                ));
            }
            Err(e) => return Err(e),
        }
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

/// Charge and push one ref set. The helper's guard gets what the budget had left BEFORE
/// this charge, less the index overhead the estimate adds on top of the helper's own price
/// (the guard compares the helper's price, which has none).
async fn push_one(
    ledger: &mut Ledger<'_>,
    p: &GitPusher,
    est: PushReport,
    what: &str,
) -> Result<()> {
    if est.refs == 0 {
        return Ok(());
    }
    let before = ledger.budget.remaining();
    ledger.budget.charge(est.est_credits, what)?;
    let guard = before.map(|b| b.saturating_sub(est.overhead()));
    let pushed = p.push(guard);
    if pushed.is_err() {
        // Refused before storing (the guard), or failed part-way: the measured balance
        // drop, folded in next, still counts whatever was really paid.
        ledger.budget.refund(est.est_credits);
    }
    ledger.reconcile().await;
    ledger.counts.add_push(&pushed?);
    Ok(())
}

/// Removes a temporary directory on drop.
struct TempDir(PathBuf);

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
