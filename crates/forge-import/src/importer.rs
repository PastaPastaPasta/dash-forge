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

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

use forge_core::network::NetworkTarget;
use forge_core::platform::PlatformClient;
use forge_core::repo::credits_to_dash;

use crate::budget::Budget;
use crate::dest::{self, Outcome, Signer, REPO_CREATE_CREDITS};
use crate::gitsync::{GitPusher, PackStorage, ProofRepo, PushReport, Refs};
use crate::model::SrcCollab;
use crate::sink::Ledger;
use crate::snapshot::Snapshot;
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
    /// Lanes for each issue's and PR's dependent writes (comments, reviews, labels, state),
    /// behind its create ([`crate::pipeline`]); 1 writes one document at a time.
    pub concurrency: usize,
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
    let result = Box::pin(run_inner(
        cfg,
        &client,
        signer.as_ref(),
        &mut summary,
        &mut outcome,
    ))
    .await;
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
    // Keyed by the forge-collab contract too: a re-registered one starts empty (D-918).
    let collab_contract = client
        .target()
        .v2
        .as_ref()
        .map(|f| f.collab.clone())
        .unwrap_or_default();
    let mut sync_state = SyncState::load(
        cfg.state_path.as_deref(),
        &scope,
        &state::destination(existing_id.as_deref().unwrap_or_default(), &collab_contract),
    );
    let since = sync_state.since();
    // The read is kept beside `--state` (a full run's, not a `--limit` trial's), so a run that
    // dies part-way through its writes resumes them without reading the source again.
    let snapshot = cfg
        .state_path
        .as_deref()
        .filter(|_| cfg.limit == 0)
        .map(|p| Snapshot::new(p, &scope, since.as_deref(), sync_state.pending_revisits()));
    let mut collab_src = read_collab(
        src,
        cfg.classes,
        since.as_deref(),
        sync_state.pending_revisits(),
        cfg.limit,
        snapshot.as_ref(),
        started,
    )?;
    // An incremental run cannot place an earlier item it finds missing (dense numbers), except
    // one the destination already refused (its content, not its order, is the problem).
    collab_src.incremental = since.is_some();
    collab_src.refused = sync_state.refused_items();
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
    // Merged PRs are proved against base tips that contain their merge commits (D-602).
    let (mirror, _proof_dir) =
        proof_repo(cfg.classes, src, &work, &collab_src, &mut summary.warnings);

    // Price everything, then the up-front cap check. Branches and tags, then the open PRs'
    // heads, are separate pushes (see gitsync); the second is optional, so it is priced for
    // the report but kept out of the hard up-front check, and re-priced after the first.
    let create = dest.existing.is_none();
    // Where the helper will put the packs: the same git config it reads.
    let (storage, fallback) = if pushes.is_empty() {
        (PackStorage::PLATFORM, false)
    } else {
        let policy = crate::gitsync::storage_policy(&work).context("reading the storage policy")?;
        let storage = if policy.is_platform_only() {
            PackStorage::PLATFORM
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
        default_branch: meta.default_branch.clone(),
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
            crate::gitsync::estimate_fresh(&work, refs, storage, &meta.default_branch)
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
    // definitions unless asked; its releases are sealed, their files and asset lists stored on
    // the storage policy's own profiles).
    let private = dest
        .existing
        .as_ref()
        .is_some_and(|r| r.visibility == forge_core::rules::v2::Visibility::Private);
    let release_storage = if private && collab_src.releases.as_ref().is_some_and(|r| !r.is_empty())
    {
        // the mirror's git config when there is one (its global scope too), else this
        // directory's, as `dg release create` reads it
        let dir = if work.is_dir() {
            work.as_path()
        } else {
            Path::new(".")
        };
        crate::sealed_release::ReleaseStorage::from_git_dir(dir)
            .context("reading the storage policy for the releases' assets")?
    } else {
        None
    };
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
    let dry = dest::dry_collab(
        client,
        dest.existing.clone(),
        signer,
        &priced,
        mirror.clone(),
        release_storage.clone(),
        cfg.concurrency,
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
        sync_state = SyncState::load(
            cfg.state_path.as_deref(),
            &scope,
            &state::destination(repo.id(), &collab_contract),
        );
    }

    // 2. Branches and tags (required). The helper prices the push against the repo as it is
    //    now: the estimate is reused for an existing repo, re-asked for a new one.
    if let Some(code) = pushes.first() {
        let p = git_pusher(dest.url(), code);
        let est = match push_estimates.first().cloned().filter(|_| !create) {
            Some(e) => e,
            None => p.estimate()?,
        };
        let published = push_one(ledger, &p, est, "the git push (branches and tags)").await?;
        if !published {
            backfill_history(ledger, client, signer, &repo, &work, &meta.default_branch).await;
        }
    }

    // 3. Issues, PRs, comments, reviews, events, labels, releases (required).
    let definitions = cfg.classes.include_label_definitions;
    let source = dest::CollabSource {
        src: &collab_src,
        mirror,
        release_storage,
        lanes: cfg.concurrency,
    };
    // boxed: the write phase's future is large (the clippy `large_futures` limit)
    Box::pin(dest::write_collab(
        client,
        signer,
        role,
        repo,
        source,
        definitions,
        outcome,
    ))
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
    // Advance the incremental state only when every item was read and mirrored, or refused
    // for its content: items past `--limit`, or skipped for another reason, are retried by
    // the next run, and so is a release mirrored without an asset it could not seal or list.
    let (skipped, refused, left_out) = outcome
        .ledger
        .as_ref()
        .map_or((0, BTreeSet::new(), false), |l| {
            (l.counts.skipped, l.refused.clone(), l.incomplete)
        });
    if !state_advances(&collab_src, skipped, &refused, left_out) {
        return Ok(());
    }
    sync_state.set_refused(&collab_src.refused.union(&refused).copied().collect());
    // Nothing to revisit: a merge is recorded as soon as the source says merged (D-9), with
    // the base tip that proves it when there is one, else the source's merge commit.
    sync_state.save(started, Vec::new())?;
    // The pass it was kept for is complete; the next run reads from the new cursor.
    if let Some(s) = &snapshot {
        s.remove();
    }
    Ok(())
}

/// The source's collaboration data for this run. With a `snapshot` of an earlier read of the
/// same run (same scope, `since` and revisits) younger than a day, only what changed since that
/// read started is asked for and merged in ([`crate::snapshot`]); otherwise everything is read.
/// Either way the result is saved back to the snapshot, stamped `started` (the snapshot is a
/// cache: a failure to save it is a warning).
fn read_collab(
    src: &dyn Source,
    classes: crate::source::Classes,
    since: Option<&str>,
    revisit: &[u32],
    limit: usize,
    snapshot: Option<&Snapshot>,
    started: u64,
) -> Result<SrcCollab> {
    let cached = snapshot.and_then(|s| s.load(started, crate::snapshot::MAX_AGE_SECS));
    let collab = match (cached, snapshot) {
        (Some(cached), Some(s)) => {
            let refresh = cached.refresh_since();
            let age = started.saturating_sub(cached.fetched_at);
            eprintln!(
                "forge-import: reusing the source read saved in {} ({}m old); reading only what \
                 changed at the source since {refresh}",
                s.path().display(),
                age / 60
            );
            let fresh = src.collect(classes, Some(&refresh), revisit, limit)?;
            crate::snapshot::merge(cached.collab, fresh, |t| src.sort_targets(t))
        }
        _ => src.collect(classes, since, revisit, limit)?,
    };
    if let Some(s) = snapshot {
        match s.save(started, &collab) {
            Ok(()) => tracing::info!(path = %s.path().display(), "saved the source read"),
            Err(e) => tracing::warn!(
                error = %format!("{e:#}"),
                "could not save the source read; a restarted run reads the source again"
            ),
        }
    }
    Ok(collab)
}

/// Whether a run's incremental state may advance: every item was read (no `--limit` cut, no
/// unreadable listing), every skip was an item the destination refused for its content
/// (`refused`), which the next run leaves out of the order check and retries only once it
/// changes at the source, and nothing was mirrored without a part it could not seal or list
/// (`left_out`: [`crate::sink::Ledger::incomplete`]).
fn state_advances(
    src: &SrcCollab,
    skipped: u64,
    refused: &BTreeSet<(u8, u32)>,
    left_out: bool,
) -> bool {
    !src.truncated && !src.incomplete && !left_out && skipped <= refused.len() as u64
}

/// After the code push, when it did not publish one itself: publish the default branch's history
/// index from the work mirror when none covers its tip (the helper's own publish can miss one: a just-created repository's
/// config a lagging node did not list, a pack an earlier run recorded). Optional: priced, fitted
/// under the cap, and a failure is a warning, never a failed import.
async fn backfill_history(
    ledger: &mut Ledger<'_>,
    client: &PlatformClient,
    signer: &Signer,
    repo: &forge_core::scope::RepoRef,
    work: &std::path::Path,
    default_branch: &str,
) {
    if default_branch.is_empty() {
        return;
    }
    let svc = forge_core::repo::RepoService::new(client, &signer.identity, &signer.bridge);
    let outcome =
        crate::gitsync::history_backfill(&svc, repo, work, default_branch, &mut |credits| {
            ledger.budget.fits(credits)
        })
        .await;
    match outcome {
        Ok(Some(credits)) => {
            let _ = ledger.budget.charge(credits, "the history index");
            ledger.reconcile().await;
        }
        Ok(None) => {}
        Err(e) => ledger.warn(format!(
            "the history index was not published ({e:#}); the web walks history for the \
             file list's commit column until `dg repo reindex` publishes it"
        )),
    }
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
/// this charge, less what the estimate adds on top of the helper's own price (the guard
/// compares the helper's price).
async fn push_one(
    ledger: &mut Ledger<'_>,
    p: &GitPusher,
    est: PushReport,
    what: &str,
) -> Result<bool> {
    if est.refs == 0 {
        return Ok(false);
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
    match pushed {
        Ok(report) => {
            count_push(ledger, &report, what);
            Ok(report.history_published)
        }
        Err(e) => {
            // Refund the charge only when nothing can have been paid for without the ledger
            // knowing: the helper's guard refused before storing anything, or the balance
            // read just now succeeded (so the measured drop counts what a part-way push paid).
            if crate::gitsync::refused_before_storing(&e) || measured {
                ledger.budget.refund(est.est_credits);
            }
            // What landed before the failure is on chain and paid for: count it, so the
            // summary does not say "0 ref updates" (D-601). A re-run does not write it again
            // (git sees those refs up to date; the helper finds the pack recorded).
            if let Some(failed) = e.downcast_ref::<crate::gitsync::PushFailed>() {
                count_push(ledger, &failed.landed, what);
                if failed.landed != PushReport::default() {
                    ledger.warn(format!(
                        "{what} failed after writing {} ref update(s) and {} pack(s); they \
                         are on chain, and a re-run does not write them again",
                        failed.landed.refs, failed.landed.packs
                    ));
                }
            }
            Err(e)
        }
    }
}

/// Count what a push wrote, and warn when it left its browse index behind (D-920).
fn count_push(ledger: &mut Ledger<'_>, report: &PushReport, what: &str) {
    ledger.counts.add_push(report);
    for w in [&report.index_skipped, &report.history_skipped]
        .into_iter()
        .flatten()
    {
        ledger.warn(format!("{what}: {w}"));
    }
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

/// The git data merged PRs are proved against (D-602), and the temporary directory holding
/// it (removed when the guard drops). With `code`, the mirror this run pushes. Without it, the
/// base branches of the merged PRs are fetched: into the `--work-dir` mirror when a code run
/// left one there (whole commits, like the mirror's own), or else into a commits-only
/// repository in a temporary directory, never inside `--work-dir`, so a later code run can
/// still clone its mirror there. `None` (warned) when no merged PR needs a proof, or nothing
/// could be fetched.
fn proof_repo(
    classes: Classes,
    src: &dyn Source,
    work: &Path,
    collab: &crate::model::SrcCollab,
    warnings: &mut Vec<String>,
) -> (Option<ProofRepo>, Option<TempDir>) {
    if classes.code {
        let proof = ProofRepo {
            dir: work.to_path_buf(),
            pushed: true,
            unfetched: BTreeMap::new(),
        };
        return (Some(proof), None);
    }
    let bases: BTreeSet<String> = collab
        .targets
        .iter()
        .filter(|t| t.merged_oid.is_some())
        .filter_map(|t| t.patch.as_ref().map(|p| p.base_ref_name.clone()))
        .collect();
    if bases.is_empty() {
        return (None, None);
    }
    let bases: Vec<String> = bases.into_iter().collect();
    // A full mirror takes a full fetch (it must never become a partial clone); anything else
    // gets its own commits-only repository, outside `--work-dir`.
    let (dir, treeless, guard) = if work.join("HEAD").exists() {
        (work.to_path_buf(), false, None)
    } else {
        let dir = std::env::temp_dir().join(format!(
            "forge-import-proof-{}-{}",
            src.default_name(),
            std::process::id()
        ));
        (dir.clone(), true, Some(TempDir(dir)))
    };
    let why = match src.fetch_bases(&dir, &bases, treeless) {
        Ok(unfetched) if unfetched.len() < bases.len() => {
            let proof = ProofRepo {
                dir,
                pushed: false,
                unfetched,
            };
            return (Some(proof), guard);
        }
        Ok(_) => format!(
            "none of the merged PRs' base branches ({}) could be fetched from the source",
            bases.join(", ")
        ),
        Err(e) => format!("fetching the merged PRs' base branches failed ({e:#})"),
    };
    warnings.push(format!(
        "{why}, so their merges cannot be proved and they are recorded as closed"
    ));
    (None, guard)
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

    /// A release mirrored without an asset it could not seal or list ends the run partial and
    /// holds the incremental state, like a listing the source refused; skips the destination
    /// refused for their content do not.
    #[test]
    fn the_state_is_held_while_a_release_is_missing_an_asset() {
        let src = SrcCollab::default();
        let none = BTreeSet::new();
        assert!(state_advances(&src, 0, &none, false));
        assert!(!state_advances(&src, 0, &none, true), "left out");
        assert!(!state_advances(&src, 1, &none, false), "skipped");
        assert!(state_advances(&src, 1, &BTreeSet::from([(0, 5)]), false));
        let cut = SrcCollab {
            incomplete: true,
            ..SrcCollab::default()
        };
        assert!(!state_advances(&cut, 0, &none, false));
    }

    /// A source that answers `collect` with `items` numbered as given (the first ask) or `fresh`
    /// (any later ask), recording the `since` of every ask.
    struct Counted {
        first: Vec<u32>,
        fresh: Vec<u32>,
        asked: std::cell::RefCell<Vec<Option<String>>>,
    }

    impl Source for Counted {
        fn display(&self) -> String {
            "github.com/o/r".into()
        }
        fn default_name(&self) -> String {
            "r".into()
        }
        fn meta(&self) -> Result<crate::source::SourceMeta> {
            unreachable!()
        }
        fn collect(
            &self,
            _: Classes,
            since: Option<&str>,
            _: &[u32],
            _: usize,
        ) -> Result<crate::model::SrcCollab> {
            let first = self.asked.borrow().is_empty();
            self.asked.borrow_mut().push(since.map(str::to_string));
            let numbers = if first { &self.first } else { &self.fresh };
            Ok(SrcCollab {
                targets: numbers.iter().map(|&n| issue(n)).collect(),
                ..SrcCollab::default()
            })
        }
        fn sync_mirror(&self, _: &Path) -> Result<()> {
            unreachable!()
        }
        fn fetch_bases(
            &self,
            _: &Path,
            _: &[String],
            _: bool,
        ) -> Result<BTreeMap<String, crate::gitsync::Unfetched>> {
            unreachable!()
        }
        fn pull_head_prefix(&self) -> &'static str {
            "refs/pull/"
        }
    }

    fn issue(n: u32) -> crate::model::SrcTarget {
        crate::model::SrcTarget {
            kind: forge_core::collab::v2::TargetKind::Issue,
            number: n,
            patch: None,
            merged_oid: None,
            imported: forge_core::collab::Imported {
                url: format!("https://github.com/o/r/issues/{n}"),
                ..forge_core::collab::Imported::default()
            },
            ..merged_pr("refs/heads/main")
        }
    }

    /// A restarted run reads only what changed since the saved read (its `since` is the saved
    /// read's start, less the overlap) and merges it in; a run with no snapshot reads in full;
    /// a completed run removes it, so the next one reads from its own cursor.
    #[test]
    fn a_restarted_run_reads_the_source_from_its_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let state = dir.path().join("collab.sync.json");
        let src = Counted {
            first: vec![1, 2, 3],
            fresh: vec![3, 4],
            asked: std::cell::RefCell::new(Vec::new()),
        };
        let classes = Classes::parse("issues,prs").unwrap();
        let snap = Snapshot::new(&state, "scope", None, &[]);
        let read = read_collab(&src, classes, None, &[], 0, Some(&snap), 10_000).unwrap();
        assert_eq!(read.targets.len(), 3);
        assert_eq!(*src.asked.borrow(), [None], "a full read first");
        assert!(snap.path().exists(), "kept beside --state");

        // The restart, an hour later: only what changed since, merged in source order.
        let read = read_collab(&src, classes, None, &[], 0, Some(&snap), 13_600).unwrap();
        let numbers: Vec<u32> = read.targets.iter().map(|t| t.number).collect();
        assert_eq!(numbers, [1, 2, 3, 4]);
        let since = crate::github::unix_to_iso8601(10_000 - 600);
        assert_eq!(*src.asked.borrow(), [None, Some(since)]);

        // Without a snapshot (removed when a run completes, or never kept): in full.
        snap.remove();
        read_collab(&src, classes, None, &[], 0, Some(&snap), 14_000).unwrap();
        assert_eq!(src.asked.borrow().last().unwrap(), &None);
        read_collab(&src, classes, None, &[], 0, None, 14_000).unwrap();
        assert_eq!(src.asked.borrow().len(), 4);
    }

    /// A source served from a local repository (`file://`), for the proof fetch.
    struct Local(PathBuf);

    impl Source for Local {
        fn display(&self) -> String {
            "local".into()
        }
        fn default_name(&self) -> String {
            "local".into()
        }
        fn meta(&self) -> Result<crate::source::SourceMeta> {
            unreachable!()
        }
        fn collect(
            &self,
            _: Classes,
            _: Option<&str>,
            _: &[u32],
            _: usize,
        ) -> Result<crate::model::SrcCollab> {
            unreachable!()
        }
        fn sync_mirror(&self, dir: &Path) -> Result<()> {
            let ok = std::process::Command::new("git")
                .args(["clone", "--mirror", "--quiet"])
                .arg(&self.0)
                .arg(dir)
                .status()?
                .success();
            anyhow::ensure!(ok, "clone failed");
            Ok(())
        }
        fn fetch_bases(
            &self,
            dir: &Path,
            bases: &[String],
            treeless: bool,
        ) -> Result<BTreeMap<String, crate::gitsync::Unfetched>> {
            crate::gitsync::fetch_proof_bases(
                dir,
                &format!("file://{}", self.0.display()),
                bases,
                treeless,
                None,
            )
        }
        fn pull_head_prefix(&self) -> &'static str {
            "refs/pull/"
        }
    }

    /// C2 (review): an issues/PRs run into a `--work-dir` that holds no mirror yet must leave it
    /// empty: the proof repository lives elsewhere and is removed after the run, so a later
    /// code run can still clone its mirror there (git refuses to clone into a non-empty
    /// directory).
    #[test]
    fn a_collab_only_run_leaves_the_work_dir_for_the_code_run() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("src");
        std::fs::create_dir(&src).unwrap();
        let git = |args: &[&str]| {
            let ok = std::process::Command::new("git")
                .arg("-C")
                .arg(&src)
                .args(args)
                .env("GIT_AUTHOR_NAME", "t")
                .env("GIT_AUTHOR_EMAIL", "t@t")
                .env("GIT_COMMITTER_NAME", "t")
                .env("GIT_COMMITTER_EMAIL", "t@t")
                .status()
                .unwrap()
                .success();
            assert!(ok, "git {args:?}");
        };
        git(&["init", "-q", "-b", "main"]);
        git(&["commit", "-q", "--allow-empty", "-m", "a"]);
        let source = Local(src.clone());
        let work = tmp.path().join("work.git");
        let collab = crate::model::SrcCollab {
            targets: vec![merged_pr("refs/heads/main")],
            ..Default::default()
        };
        let mut warnings = Vec::new();
        let issues_prs = Classes::parse("issues,prs").unwrap();
        let (proof, guard) = proof_repo(issues_prs, &source, &work, &collab, &mut warnings);
        let proof = proof.expect("the base was fetched");
        assert!(warnings.is_empty(), "{warnings:?}");
        assert!(!proof.pushed);
        assert!(!proof.dir.starts_with(&work), "{}", proof.dir.display());
        assert!(!work.exists(), "the work dir is untouched");
        drop(guard);
        assert!(
            !proof.dir.exists(),
            "the proof repository is removed after the run"
        );
        // The code run then mirrors into the same work dir.
        source.sync_mirror(&work).unwrap();
        let (code, _) = proof_repo(
            Classes::parse("code").unwrap(),
            &source,
            &work,
            &collab,
            &mut warnings,
        );
        assert!(code.is_some_and(|p| p.pushed && p.dir == work));
        // With the code run's mirror there, a later issues/PRs run fetches into it (whole
        // commits, never a partial clone) and removes nothing.
        let (proof, guard) = proof_repo(issues_prs, &source, &work, &collab, &mut warnings);
        assert!(proof.is_some_and(|p| p.dir == work) && guard.is_none());
        let config = std::fs::read_to_string(work.join("config")).unwrap();
        assert!(
            !config.contains("promisor") && !config.contains("partialclone"),
            "{config}"
        );
    }

    fn merged_pr(base: &str) -> crate::model::SrcTarget {
        crate::model::SrcTarget {
            kind: forge_core::collab::v2::TargetKind::Patch,
            number: 1,
            title: "t".into(),
            body: String::new(),
            imported: forge_core::collab::Imported::default(),
            closed: true,
            close_reason: None,
            merged_without_sha: false,
            merged_oid: Some(vec![1; 20]),
            labels: std::collections::BTreeSet::new(),
            draft: false,
            patch: Some(crate::model::SrcPatch {
                base_ref_name: base.into(),
                source_ref_name: None,
                head_oid: vec![2; 20],
            }),
            comments: Vec::new(),
            reviews: Vec::new(),
        }
    }

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

    /// One item the destination refuses must not hold every later run: run 1 skips it and still
    /// advances the state, recording it refused; run 2 (incremental, the item still in its
    /// window, and a later item already mirrored) does not call it missing, so the order check
    /// lets the run through. Another kind of skip still holds the state.
    #[test]
    fn a_refused_item_does_not_stop_the_next_incremental_run() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.json");
        // Run 1: a full scan; issue #5 refused (content), nothing else skipped.
        let mut state = SyncState::load(Some(&path), "src", "R");
        let run1 = SrcCollab::default();
        let refused: BTreeSet<(u8, u32)> = [(0, 5)].into();
        assert!(state_advances(&run1, 1, &refused, false));
        assert!(
            !state_advances(&run1, 2, &refused, false),
            "another skip holds the state"
        );
        assert!(!state_advances(
            &SrcCollab {
                truncated: true,
                ..SrcCollab::default()
            },
            0,
            &BTreeSet::new(),
            false
        ));
        state.set_refused(&refused);
        state.save(1_000_000, Vec::new()).unwrap();
        // Run 2: incremental; #5 is back in the window (edited upstream, still bad), #7 is
        // held. #5 is not missing, a real gap (#6) still is.
        let state = SyncState::load(Some(&path), "src", "R");
        assert!(state.since().is_some());
        let run2 = SrcCollab {
            incremental: true,
            refused: state.refused_items(),
            ..SrcCollab::default()
        };
        assert_eq!(run2.refused, refused);
        let below: Vec<(u32, bool)> = [(5u32, false), (6, false)]
            .into_iter()
            .filter(|(n, _)| !run2.refused.contains(&(0, *n)))
            .collect();
        assert_eq!(crate::sink::missing_below(&below), vec![6]);
        assert!(crate::sink::missing_below(&[(6, true)]).is_empty());
    }
}
