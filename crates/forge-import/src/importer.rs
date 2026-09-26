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

use std::io::IsTerminal as _;
use std::path::PathBuf;

use anyhow::{Context, Result};

use forge_core::collab::v2::Collab;
use forge_core::network::NetworkTarget;
use forge_core::platform::PlatformClient;
use forge_core::repo::credits_to_dash;

use crate::budget::Budget;
use crate::dest::{self, Signer, REPO_CREATE_CREDITS};
use crate::github::{GithubClient, GithubRepoRef};
use crate::gitsync::{GitPusher, PushReport};
use crate::sink::{Ledger, Sink};
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
    /// Storage backend mode advertised by a freshly created repo.
    pub backend_mode: u8,
}

/// Run an import. Always returns a summary; `Err` only for failures before one exists.
pub async fn run(cfg: &ImportConfig) -> Summary {
    let mut summary = Summary::new(
        cfg.network.network.key(),
        format!("github.com/{}", cfg.source.slug()),
    );
    match run_inner(cfg, &mut summary).await {
        Ok(()) => {}
        Err(e) => {
            summary.status = if e.downcast_ref::<crate::budget::CapExceeded>().is_some() {
                Status::CapExceeded
            } else {
                Status::Error
            };
            summary.error = Some(forge_core::user_error::redact(&format!("{e:#}")));
        }
    }
    summary
}

#[allow(clippy::too_many_lines)] // one sequential run: read, price, write
async fn run_inner(cfg: &ImportConfig, summary: &mut Summary) -> Result<()> {
    let started = state::now();
    let gh = GithubClient::new(cfg.source.clone());
    let meta = gh.repo_meta().context("reading the GitHub repository")?;

    let client = PlatformClient::connect(cfg.network.clone())
        .await
        .context("connecting to Dash Platform")?;
    let signer = match &cfg.key {
        Some(k) => Some(Signer::load(&client, k).await?),
        None if cfg.dry_run => None,
        None => anyhow::bail!("no signing identity: pass --identity <file> or set DASH_FORGE_KEY"),
    };
    let signer_id = signer.as_ref().map(Signer::id);
    let spec = cfg
        .dest
        .clone()
        .unwrap_or_else(|| cfg.source.repo.to_ascii_lowercase());
    let mut dest = dest::resolve(&client, signer_id.as_deref(), &spec).await?;
    summary.repo = dest.info(false);

    let mut budget = Budget::new(cfg.max_spend);
    if let Some(s) = &signer {
        budget.start(s.identity.balance());
    }

    // Collaboration data (diffed on chain; `since` narrows what GitHub is asked for).
    let mut sync_state = SyncState::load(
        cfg.state_path.as_deref(),
        &summary.source,
        &dest
            .existing
            .as_ref()
            .map(|r| r.id().to_string())
            .unwrap_or_default(),
    );
    let since = sync_state.since();
    let collab_src =
        source_github::collect(&gh, &cfg.source, cfg.classes, since.as_deref(), cfg.limit)?;

    // Git data.
    let work = match &cfg.work_dir {
        Some(d) => d.clone(),
        None => std::env::temp_dir().join(format!(
            "forge-import-{}-{}-{}",
            cfg.source.owner,
            cfg.source.repo,
            std::process::id()
        )),
    };
    let _cleanup = cfg.work_dir.is_none().then(|| TempDir(work.clone()));
    if cfg.classes.code {
        gh.sync_mirror(&work).context("mirroring the git data")?;
    }

    // Price everything, then the up-front cap check. The git push can only be priced by the
    // helper once the repository exists.
    let create = dest.existing.is_none();
    let git_pusher = |url: String| GitPusher {
        git_dir: work.clone(),
        url,
        key: cfg.key.clone().unwrap_or_default(),
        network: cfg.network.clone(),
        pull_heads: cfg.classes.prs,
    };
    let push_estimate = match (cfg.classes.code, create, signer.is_some()) {
        (false, _, _) => PushReport::default(),
        // The helper prices a push into an existing repo (storage policy included).
        (true, false, true) => git_pusher(dest.url()).estimate()?,
        // A new repo (or no identity to ask the helper with): price the whole pack.
        _ => crate::gitsync::estimate_fresh(&work, cfg.classes.prs)?,
    };
    let dry = {
        let mut dry = Sink::new(
            Collab::reader(&client),
            dest.existing.clone(),
            Ledger::new(&client, signer_id.clone(), true, Budget::new(None)),
        );
        dry.sync(&collab_src).await?;
        dry.ledger
    };
    let collab_estimate = dry.budget.spent();
    let create_credits = if create { REPO_CREATE_CREDITS } else { 0 };
    let estimate = create_credits + push_estimate.est_credits + collab_estimate;
    summary.estimate_credits = estimate;
    budget.check_plan(estimate)?;
    eprintln!(
        "{} → {}: estimated {:.6} DASH (repo {:.6}, git {:.6}, issues/PRs/releases {:.6})",
        summary.source,
        dest.url(),
        credits_to_dash(estimate),
        credits_to_dash(create_credits),
        credits_to_dash(push_estimate.est_credits),
        credits_to_dash(collab_estimate),
    );

    if cfg.dry_run {
        summary.counts = dry.counts;
        summary.counts.refs = push_estimate.refs;
        summary.counts.packs = push_estimate.packs;
        summary.counts.pack_bytes = push_estimate.pack_bytes;
        summary.warnings.extend(dry.warnings);
        summary.status = Status::DryRun;
        return Ok(());
    }
    let signer = signer.expect("checked above");
    if estimate > 0 && !confirm(cfg, estimate)? {
        anyhow::bail!("cancelled");
    }

    // 1. The repository.
    if create {
        budget.charge(REPO_CREATE_CREDITS, "creating the repository")?;
        let description = meta
            .description
            .as_deref()
            .filter(|d| !d.is_empty())
            .map_or_else(
                || format!("Mirror of github.com/{}", cfg.source.slug()),
                |d| format!("{d} (mirror of github.com/{})", cfg.source.slug()),
            );
        let created = dest::create(
            &client,
            &signer,
            &mut dest,
            &description,
            &meta.default_branch,
            cfg.backend_mode,
        )
        .await?;
        summary.repo = dest.info(created);
        budget.reconcile(client.get_balance(&signer.id()).await.unwrap_or(u64::MAX));
    }
    let repo = dest.existing.clone().expect("created or existing");
    dest::require_member(&client, &repo, &signer.id()).await?;
    if sync_state.repo_id.is_empty() {
        sync_state = SyncState::load(cfg.state_path.as_deref(), &summary.source, repo.id());
    }

    // 2. Git data: priced (again, now that the repo exists), charged, pushed.
    let mut ledger = Ledger::new(&client, Some(signer.id()), false, budget);
    if cfg.classes.code {
        let pusher = git_pusher(dest.url());
        let est = pusher.estimate()?;
        if est.refs > 0 {
            ledger.budget.charge(est.est_credits, "the git push")?;
            let done = pusher.push()?;
            ledger.counts.refs = done.refs;
            ledger.counts.packs = done.packs;
            ledger.counts.pack_bytes = done.pack_bytes;
            ledger.reconcile().await;
        }
    }

    // 3. Issues, PRs, comments, reviews, events, labels, releases.
    let mut sink = Sink::new(
        Collab::new(&client, &signer.identity, &signer.bridge),
        Some(repo),
        ledger,
    );
    let result = sink.sync(&collab_src).await;
    sink.ledger.reconcile().await;
    summary.counts = sink.ledger.counts;
    summary
        .warnings
        .extend(std::mem::take(&mut sink.ledger.warnings));
    summary.spent_credits = sink.ledger.budget.spent();
    summary.balance_credits = client.get_balance(&signer.id()).await.ok();
    summary.key = signer.key_info(&client).await;
    result?;
    sync_state.save(started)?;
    Ok(())
}

/// The cost confirmation: `--yes` skips it; without a terminal it refuses.
fn confirm(cfg: &ImportConfig, credits: u64) -> Result<bool> {
    if cfg.yes {
        return Ok(true);
    }
    if !std::io::stdin().is_terminal() {
        anyhow::bail!(
            "refusing to spend without confirmation on a non-interactive stdin; pass --yes"
        );
    }
    eprint!("Proceed (~{:.6} DASH)? [y/N] ", credits_to_dash(credits));
    let mut line = String::new();
    std::io::stdin().read_line(&mut line)?;
    Ok(matches!(
        line.trim().to_ascii_lowercase().as_str(),
        "y" | "yes"
    ))
}

/// Removes a temporary directory on drop.
struct TempDir(PathBuf);

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
