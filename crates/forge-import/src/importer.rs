//! `forge-import <source>`: mirror a GitHub repository or a GitLab project into forge-v2,
//! once or repeatedly. The source is a [`Source`]; everything else is shared.
//!
//! 1. Mirror the git data locally (branches, tags, PR/MR heads), read the collaboration
//!    data (only what changed since the last run with `--state`).
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
use crate::gitsync::{GitPusher, PackStorage, PushReport, Refs};
use crate::sink::Ledger;
use crate::source::{Classes, Source};
use crate::state::{self, SyncState};
use crate::summary::{Status, Summary};

/// Everything the CLI resolved.
pub struct ImportConfig {
    /// The source (GitHub or GitLab).
    pub source: Box<dyn Source>,
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
    let mut summary = Summary::new(cfg.network.network.key(), cfg.source.display());
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
    let src = cfg.source.as_ref();
    let meta = src
        .meta()
        .with_context(|| format!("reading {}", src.display()))?;
    let signer_id = signer.map(Signer::id);
    let spec = cfg.dest.clone().unwrap_or_else(|| src.default_name());
    let mut dest = dest::resolve(client, signer_id.as_deref(), &spec).await?;
    summary.repo = dest.info(false);

    // Collaboration data (diffed on chain; `since` narrows what the source is asked for).
    let scope = state::scope(&summary.source, cfg.classes, cfg.limit);
    let existing_id = dest.existing.as_ref().map(|r| r.id().to_string());
    let mut sync_state = SyncState::load(
        cfg.state_path.as_deref(),
        &scope,
        existing_id.as_deref().unwrap_or_default(),
    );
    let since = sync_state.since();
    let collab_src = src.collect(cfg.classes, since.as_deref(), cfg.limit)?;
    summary.warnings.extend(collab_src.warnings.iter().cloned());
    summary.incomplete = collab_src.incomplete;
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
            "forge-import-{}-{}",
            src.default_name(),
            std::process::id()
        ))
    });
    let _cleanup = cfg.work_dir.is_none().then(|| TempDir(work.clone()));
    let pushes = planned_pushes(cfg.classes, collab_src.open_pulls.as_deref());
    if cfg.classes.code {
        src.sync_mirror(&work).context("mirroring the git data")?;
        if let Some(open) = &collab_src.open_pulls {
            crate::gitsync::sync_pull_heads(&work, open, src.pull_head_prefix())
                .context("preparing the open pull requests' heads")?;
        }
    }

    // Price everything, then the up-front cap check. Branches and tags, then the open PRs'
    // heads, are separate pushes (see gitsync); the second is optional, so it is priced for
    // the report but kept out of the hard up-front check, and re-priced after the first.
    let create = dest.existing.is_none();
    // Where the helper will put the packs: the same git config it reads.
    let (storage, fallback) = if pushes.is_empty() {
        (PackStorage::Platform, false)
    } else {
        let policy = crate::gitsync::storage_policy(&work).context("reading the storage policy")?;
        let storage = if policy.is_platform_only() {
            PackStorage::Platform
        } else {
            let profiles = forge_core::storage::StorageProfiles::load()
                .context("reading the storage profiles")?;
            PackStorage::resolve(&policy, &profiles).context("reading the storage policy")?
        };
        (storage, policy.platform_fallback)
    };
    let git_pusher = |url: String, refs: &Refs| GitPusher {
        git_dir: work.clone(),
        url,
        key: cfg.key.clone().unwrap_or_default(),
        network: cfg.network.clone(),
        refs: refs.clone(),
        fallback,
    };
    let mut push_estimates = Vec::with_capacity(pushes.len());
    let mut heads_unpriced = None;
    for refs in &pushes {
        let est = if !create && signer.is_some() {
            // The helper prices a push into an existing repo (storage policy included).
            git_pusher(dest.url(), refs).estimate()
        } else {
            // A new repo (or no identity to ask the helper with): build the pack and price
            // what the storage policy writes on chain (all of it on Platform, or only the
            // manifests and refs when your own storage holds the pack).
            crate::gitsync::estimate_fresh(&work, refs, storage)
        };
        push_estimates.push(match (refs, est) {
            (_, Ok(e)) => e,
            (Refs::Code, Err(e)) => return Err(e),
            // Optional: a PR head the helper cannot price is skipped at push time (and
            // reported by a dry run).
            (Refs::PullHeads(_), Err(e)) => {
                heads_unpriced = Some(format!("{e:#}"));
                PushReport::default()
            }
        });
    }
    let code_estimate = push_estimates.first().map_or(0, |p| p.est_credits);
    let heads_estimate = push_estimates.get(1).map_or(0, |p| p.est_credits);
    let git_estimate = code_estimate + heads_estimate;
    // An existing private destination is priced on what it will get (no plaintext label
    // definitions unless asked; releases are skipped there too).
    let priced = match &dest.existing {
        Some(r) if r.visibility == forge_core::rules::v2::Visibility::Private => {
            let definitions = cfg.classes.include_label_definitions;
            dest::collab_plan(
                &collab_src,
                forge_core::rules::v2::Role::Maintainer,
                true,
                definitions,
            )
            .0
        }
        _ => collab_src.clone(),
    };
    let dry = dest::dry_collab(client, dest.existing.clone(), signer, &priced).await?;
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
        if let Some(e) = heads_unpriced {
            summary.counts.git_skipped += 1;
            summary.warnings.push(format!(
                "the open pull requests' heads could not be priced; a real run would skip \
                 them: {e}"
            ));
        }
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
            .map(str::trim)
            .filter(|d| !d.is_empty())
            .map_or_else(
                || format!("Mirror of {}", src.display()),
                |d| format!("{d} (mirror of {})", src.display()),
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

    // 2. Branches and tags (required). The helper prices the push against the repo as it is
    //    now: the estimate is reused for an existing repo, re-asked for a new one.
    if let Some(code) = pushes.first() {
        let p = git_pusher(dest.url(), code);
        let est = match push_estimates.first().cloned().filter(|_| !create) {
            Some(e) => e,
            None => p.estimate()?,
        };
        push_one(ledger, &p, est, "the git push (branches and tags)").await?;
    }

    // 3. Issues, PRs, comments, reviews, events, labels, releases (required).
    let definitions = cfg.classes.include_label_definitions;
    dest::write_collab(
        client,
        signer,
        role,
        repo,
        &collab_src,
        definitions,
        outcome,
    )
    .await?;

    // 4. The open PRs' heads, last: optional, so they may only use what the required writes
    //    left (a stranger's huge or unfetchable PR must never stop the mirror).
    if let Some(heads) = pushes.get(1) {
        let ledger = outcome
            .ledger
            .as_mut()
            .expect("the write phase has a ledger");
        push_optional(ledger, &git_pusher(dest.url(), heads), signer).await;
    }
    // Advance the incremental state only when every item was read and mirrored: items past
    // `--limit`, or skipped, are retried by the next run.
    let skipped = outcome.ledger.as_ref().map_or(0, |l| l.counts.skipped);
    if collab_src.truncated || collab_src.incomplete || skipped > 0 {
        return Ok(());
    }
    sync_state.save(started)
}

/// The optional PR-heads push: re-priced now, admitted only if it fits the cap AND the
/// signer's balance (an uncapped run must not drain the identity for it either); any
/// failure is a git skip (the run is partial, the state still advances).
async fn push_optional(ledger: &mut Ledger<'_>, p: &GitPusher, signer: &Signer) {
    const WHAT: &str = "the push of open pull request heads";
    let est = match p.estimate() {
        Ok(e) => e,
        Err(e) => return ledger.skip_git(format!("{WHAT} skipped this run: {e:#}")),
    };
    let balance = ledger.balance(&signer.id()).await;
    if !ledger.budget.fits(est.est_credits) || balance.is_some_and(|b| b < est.est_credits) {
        return ledger.skip_git(format!(
            "{WHAT} (~{:.6} DASH) does not fit what is left of --max-spend or the balance; \
             skipped this run",
            credits_to_dash(est.est_credits)
        ));
    }
    if let Err(e) = push_one(ledger, p, est, WHAT).await {
        ledger.skip_git(format!("{WHAT} skipped this run: {e:#}"));
    }
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
    let traced = ledger.traced_balance().await;
    let pushed = p.push(guard);
    let measured = ledger.reconcile().await;
    tracing::debug!(
        target: "forge_import::cost",
        what,
        helper = est.helper_credits,
        refs = est.refs,
        packs = est.packs,
        pack_bytes = est.pack_bytes,
        "push estimate"
    );
    ledger.trace_cost(what, est.est_credits, traced).await;
    if let Err(e) = &pushed {
        // Refund the charge only when nothing can have been paid for without the ledger
        // knowing: the helper's guard refused before storing anything, or the balance read
        // just now succeeded (so the measured drop counts what a part-way push paid).
        if crate::gitsync::refused_before_storing(e) || measured {
            ledger.budget.refund(est.est_credits);
        }
    }
    ledger.counts.add_push(&pushed?);
    Ok(())
}

/// The git pushes of a run: branches and tags with `code`, then the open PRs'/MRs' heads
/// with `code` and `prs`. The heads push runs whenever the open list was read, even empty:
/// its wildcard refspec with `--prune` then deletes the heads of PRs that closed. When the
/// list was not read (`None`: the source refused it) that push is left out, since pruning
/// against an unknown list would delete every head already mirrored.
pub(crate) fn planned_pushes(classes: Classes, open: Option<&[u64]>) -> Vec<Refs> {
    match (classes.code, classes.prs, open) {
        (true, true, Some(open)) => vec![Refs::Code, Refs::PullHeads(open.to_vec())],
        (true, _, _) => vec![Refs::Code],
        _ => Vec::new(),
    }
}

/// Removes a temporary directory on drop.
struct TempDir(PathBuf);

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn heads_are_pushed_only_when_the_open_list_was_read() {
        let all = Classes::parse("all").unwrap();
        assert_eq!(
            planned_pushes(all, Some(&[3])),
            [Refs::Code, Refs::PullHeads(vec![3])]
        );
        // Read and empty: still pushed, so the closed PRs' heads are pruned.
        assert_eq!(
            planned_pushes(all, Some(&[])),
            [Refs::Code, Refs::PullHeads(vec![])]
        );
        // Not read (refused): never a prune against an unknown list.
        assert_eq!(planned_pushes(all, None), [Refs::Code]);
        assert_eq!(
            planned_pushes(Classes::parse("code").unwrap(), None),
            [Refs::Code]
        );
        assert!(planned_pushes(Classes::parse("issues,prs").unwrap(), Some(&[1])).is_empty());
    }
}
