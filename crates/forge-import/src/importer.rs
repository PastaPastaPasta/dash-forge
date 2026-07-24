//! Migration orchestration: clone → enumerate → cost-gate → create/resolve repo → push git
//! data → map collaboration docs, all resumably and within `--max-spend`.
//!
//! Git data is pushed through the already-M1-proven `git push dash://…` path (the
//! `git-remote-dash` helper sits next to this binary): the pack pipeline, resumable chunk
//! journal, and cost accounting all apply for free (PRD 06: "pushed through the normal
//! remote helper — no special path"). Issues/PRs/releases/labels/milestones map onto Forge
//! collab docs via [`forge_core::collab`], each stamped with `imported` provenance.

use std::io::{IsTerminal, Write};
use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{anyhow, bail, Context, Result};

use forge_core::collab::{
    Imported, IssueService, LabelService, PullRequestInput, PullRequestService, ReleaseInput,
    ReleaseService,
};
use forge_core::keystore::BridgeIdentity;
use forge_core::pack::build_pack;
use forge_core::platform::{LoadedIdentity, Network, PlatformClient};
use forge_core::repo::{credits_to_dash, CreateRepoOpts, RepoService};
use forge_core::rules::EventKind;

use crate::estimate::{ClassCost, Plan, SkipFlags};
use crate::github::{iso8601_to_unix, GhIssue, GhPull, GithubClient, GithubRepoRef};
use crate::state::ImportState;

/// Backend storage tier for the created repo (writer-side default).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Backend {
    /// On-platform chunk storage (`config.backend.mode = 0`).
    Platform,
    /// External storage (`config.backend.mode = 3` https).
    External,
}

impl Backend {
    fn mode(self) -> u8 {
        match self {
            Backend::Platform => 0,
            Backend::External => 3,
        }
    }
}

/// Resolved import configuration (from the CLI).
pub struct ImportConfig {
    /// Source `owner/repo`.
    pub source: GithubRepoRef,
    /// Destination repo name (defaults to the source repo name).
    pub repo_name: Option<String>,
    /// Import collab docs directly into this existing repo contract id (skips create + git
    /// push) — the cheap "import into an existing repo" path.
    pub repo_contract_id: Option<String>,
    /// Backend tier for a freshly created repo.
    pub backend: Backend,
    /// Classes to skip.
    pub skip: SkipFlags,
    /// Hard spend cap in credits (abort before exceeding); `None` = uncapped.
    pub max_spend_credits: Option<u64>,
    /// Enumerate + estimate only, zero writes.
    pub dry_run: bool,
    /// Skip the confirmation prompt.
    pub yes: bool,
    /// Cap the number of issues / PRs imported (0 = all) — keeps trial runs cheap.
    pub limit: u64,
    /// Resume-state file path.
    pub resume_path: PathBuf,
    /// Dash network.
    pub network: Network,
    /// Identity file path (bridge JSON).
    pub identity_path: PathBuf,
}

/// Truncate a string to at most `max` Unicode scalar values (Platform maxLength is measured
/// in characters — mirrors `forge_core::collab`'s check).
fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        s.chars().take(max).collect()
    }
}

/// Build `imported` provenance from a login / ISO timestamp / URL.
fn provenance(login: &str, created_at_iso: &str, url: &str) -> Imported {
    Imported {
        author: truncate(login, 120),
        created_at: iso8601_to_unix(created_at_iso),
        url: truncate(url, 300),
    }
}

/// Run a full migration per `cfg`.
pub async fn run(cfg: &ImportConfig) -> Result<()> {
    // 1. Source: connect to GitHub and enumerate everything (needed even for --dry-run).
    let gh = GithubClient::connect(cfg.source.clone())?;
    tracing::info!(source = %cfg.source.slug(), "enumerating GitHub source");
    let mut plan = enumerate(&gh, cfg)?;

    // 2. Clone + build the git pack to size the git-data cost exactly (local read; a
    //    dry-run still clones — cloning to /tmp writes nothing to Platform).
    let clone_dir = std::env::temp_dir().join(format!(
        "forge-import-{}-{}",
        cfg.source.repo,
        std::process::id()
    ));
    let _clone_guard = CloneGuard(clone_dir.clone());
    let push_git = cfg.repo_contract_id.is_none();
    if push_git {
        size_git_data(&gh, &clone_dir, &mut plan)?;
    }
    // A fresh repo is created only when no existing contract was named and none resolves.
    let mut state = ImportState::load_or_new(&cfg.resume_path, &cfg.source.slug())?;

    // 3. Cost estimate + gate.
    let costs = plan.cost(cfg.skip);
    print_estimate(&plan, &costs, cfg);
    let total = Plan::grand_total(&costs);
    if let Some(cap) = cfg.max_spend_credits {
        if total.total() > cap {
            bail!(
                "estimated cost {:.6} DASH exceeds --max-spend {:.6} DASH — aborting before any \
                 write (raise the cap or --skip a class)",
                total.total_dash(),
                credits_to_dash(cap)
            );
        }
    }
    if cfg.dry_run {
        println!("\n--dry-run: enumeration + estimate only, zero writes performed.");
        return Ok(());
    }
    if !confirm(cfg, total.total_dash())? {
        println!("aborted.");
        return Ok(());
    }

    // 4. Connect to Platform with the signing identity.
    let bridge = BridgeIdentity::load_from_file(&cfg.identity_path)
        .with_context(|| format!("loading identity from {}", cfg.identity_path.display()))?;
    let client = PlatformClient::connect(cfg.network)
        .await
        .context("connecting to Dash Platform")?;
    let identity = client
        .fetch_identity(&bridge.identity_id)
        .await
        .context("fetching signing identity")?;
    let balance_before = identity.balance();

    // 5. Resolve or create the destination repo.
    let repo_contract_id =
        resolve_or_create(&client, &identity, &bridge, cfg, &plan, &mut state).await?;

    // 6. Git data (skipped for the import-into-existing-contract path).
    if push_git && !state.refs_pushed {
        push_git_data(cfg, &clone_dir, &state)?;
        state.refs_pushed = true;
        state.save()?;
    }

    // 7. Collaboration docs.
    import_collab(
        &client,
        &identity,
        &bridge,
        &gh,
        cfg,
        &plan,
        &repo_contract_id,
        &mut state,
    )
    .await?;

    // 8. Report actual vs estimated.
    let after = client
        .get_balance(&bridge.identity_id)
        .await
        .unwrap_or(balance_before);
    let spent = balance_before.saturating_sub(after);
    report_actual(spent, total.total());
    Ok(())
}

/// Enumerate every artifact class from GitHub into a [`Plan`] (PR records filtered out of the
/// issue class; drafts dropped from releases).
fn enumerate(gh: &GithubClient, cfg: &ImportConfig) -> Result<Plan> {
    let meta = gh.repo_meta()?;
    let mut plan = Plan {
        meta,
        creates_repo: cfg.repo_contract_id.is_none(),
        ..Plan::default()
    };

    if !cfg.skip.issues {
        plan.issues = gh
            .issues()?
            .into_iter()
            .filter(|i| !i.is_pull_request())
            .collect();
    }
    if !cfg.skip.prs {
        plan.pulls = gh.pulls()?;
    }
    if !cfg.skip.releases {
        plan.releases = gh.releases()?.into_iter().filter(|r| !r.draft).collect();
    }
    plan.labels = gh.labels()?;
    plan.milestones = gh.milestones()?;

    // Apply the trial `--limit` cap to the unbounded classes.
    if cfg.limit > 0 {
        let n = usize::try_from(cfg.limit).unwrap_or(usize::MAX);
        plan.issues.truncate(n);
        plan.pulls.truncate(n);
    }
    Ok(plan)
}

/// Clone the source repo and build the self-contained pack to size the git-data cost.
fn size_git_data(gh: &GithubClient, clone_dir: &Path, plan: &mut Plan) -> Result<()> {
    tracing::info!("cloning source git data (bare) to size the pack");
    gh.clone_bare(clone_dir)?;
    let tips = ref_tips(clone_dir)?;
    if tips.is_empty() {
        tracing::warn!("source repo has no refs — no git data to push");
        return Ok(());
    }
    let want: Vec<&str> = tips.iter().map(|(oid, _)| oid.as_str()).collect();
    let report = build_pack(clone_dir, &want, &[]).context("building import pack")?;
    let objects = report.pack.parsed.object_count() as u64;
    plan.set_pack(&report.pack.bytes, objects, tips.len());
    tracing::info!(
        bytes = report.pack.bytes.len(),
        objects,
        chunks = plan.pack_chunks,
        refs = tips.len(),
        "sized git data"
    );
    Ok(())
}

/// The `(oid, refname)` tips of every branch and tag in a bare clone.
fn ref_tips(repo: &Path) -> Result<Vec<(String, String)>> {
    let out = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args([
            "for-each-ref",
            "--format=%(objectname) %(refname)",
            "refs/heads/",
            "refs/tags/",
        ])
        .output()
        .context("git for-each-ref")?;
    if !out.status.success() {
        bail!(
            "git for-each-ref failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let mut tips = Vec::new();
    for line in text.lines() {
        if let Some((oid, name)) = line.split_once(' ') {
            tips.push((oid.to_string(), name.to_string()));
        }
    }
    Ok(tips)
}

/// Resolve the destination repo (existing contract id, or by name under the signing owner),
/// creating a fresh repo-v1 contract when none exists. Records the outcome in `state` so a
/// resume never re-pays the ~1.18 DASH create.
async fn resolve_or_create(
    client: &PlatformClient,
    identity: &LoadedIdentity,
    bridge: &BridgeIdentity,
    cfg: &ImportConfig,
    plan: &Plan,
    state: &mut ImportState,
) -> Result<String> {
    if let Some(id) = &cfg.repo_contract_id {
        // Verify it exists / is fetchable, then import collab straight into it.
        client
            .fetch_contract(id)
            .await
            .with_context(|| format!("fetching destination contract {id}"))?;
        state.repo_contract_id = Some(id.clone());
        state.save()?;
        tracing::info!(repo_contract = %id, "importing into existing repo contract");
        return Ok(id.clone());
    }

    if let Some(id) = &state.repo_contract_id {
        tracing::info!(repo_contract = %id, "resuming into repo from state");
        return Ok(id.clone());
    }

    let name = cfg
        .repo_name
        .clone()
        .unwrap_or_else(|| cfg.source.repo.clone());
    let svc = RepoService::new(client, identity, bridge);
    let default_branch = if plan.meta.default_branch.is_empty() {
        "main".to_string()
    } else {
        plan.meta.default_branch.clone()
    };
    let description = truncate(
        plan.meta
            .description
            .as_deref()
            .filter(|d| !d.is_empty())
            .map_or_else(
                || format!("Imported from github.com/{}", cfg.source.slug()),
                |d| format!("{d} (imported from github.com/{})", cfg.source.slug()),
            )
            .as_str(),
        500,
    );
    let opts = CreateRepoOpts {
        default_branch,
        backend_mode: cfg.backend.mode(),
        description,
        template_version: 1,
    };
    tracing::info!(%name, "creating destination repo (repo-v1 contract)");
    let result = svc
        .create_repo(&name, &opts)
        .await
        .context("creating destination repo")?;
    state.repo_contract_id = Some(result.handle.repo_contract_id.clone());
    state.owner_id = Some(result.handle.owner_id.clone());
    state.repo_name = Some(result.handle.normalized_name.clone());
    state.repo_created = result.repo_v1_instantiation_cost_credits > 0;
    state.add_spend(result.repo_v1_instantiation_cost_credits)?;
    Ok(result.handle.repo_contract_id)
}

/// Push all branches + tags through `git push dash://<owner>/<repo>` — the M1-proven helper
/// path. The `git-remote-dash` helper is discovered next to this binary and prepended to
/// `PATH`, and the identity + network are handed to it via the same env vars it reads.
fn push_git_data(cfg: &ImportConfig, clone_dir: &Path, state: &ImportState) -> Result<()> {
    let owner = state
        .owner_id
        .clone()
        .ok_or_else(|| anyhow!("cannot push git data: destination owner id unknown"))?;
    let name = state
        .repo_name
        .clone()
        .ok_or_else(|| anyhow!("cannot push git data: destination repo name unknown"))?;

    let helper_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
        .ok_or_else(|| anyhow!("cannot locate the git-remote-dash helper next to this binary"))?;
    let path = std::env::var("PATH").unwrap_or_default();
    let new_path = format!("{}:{path}", helper_dir.display());
    let url = format!("dash://{owner}/{name}");

    // Testnet transport drops (connection resets) are routine over a multi-hour push, so the
    // push is retried: the helper's chunk journal (in this clone's .git, alive across
    // attempts) resumes where the last attempt stopped, and chunk/packManifest re-broadcasts
    // are idempotent (unique-index duplicate == already stored), so a retry never double-pays.
    const PUSH_ATTEMPTS: u32 = 5;
    for attempt in 1..=PUSH_ATTEMPTS {
        tracing::info!(%url, attempt, "pushing git data via git-remote-dash");
        let status = Command::new("git")
            .arg("-C")
            .arg(clone_dir)
            .args([
                "push",
                &url,
                "refs/heads/*:refs/heads/*",
                "refs/tags/*:refs/tags/*",
            ])
            .env("PATH", &new_path)
            .env("DASH_FORGE_KEY", &cfg.identity_path)
            .env("DASH_FORGE_NETWORK", network_label(cfg.network))
            .status()
            .context("running git push dash://")?;
        if status.success() {
            return Ok(());
        }
        if attempt < PUSH_ATTEMPTS {
            let wait = std::time::Duration::from_secs(15 * u64::from(attempt));
            tracing::warn!(
                attempt,
                wait_secs = wait.as_secs(),
                "git push failed — retrying (journal resumes already-confirmed chunks)"
            );
            std::thread::sleep(wait);
        }
    }
    bail!("git push to {url} failed after {PUSH_ATTEMPTS} attempts")
}

/// The lowercase network label the helper reads from `DASH_FORGE_NETWORK`.
fn network_label(n: Network) -> &'static str {
    match n {
        Network::Testnet => "testnet",
        Network::Mainnet => "mainnet",
        Network::Devnet => "devnet",
    }
}

/// Import labels, milestone-derived labels, issues (+ state/label events + comments), PRs
/// (+ state events), and releases — each resumable and provenance-stamped.
#[allow(clippy::too_many_arguments)]
async fn import_collab(
    client: &PlatformClient,
    identity: &LoadedIdentity,
    bridge: &BridgeIdentity,
    gh: &GithubClient,
    cfg: &ImportConfig,
    plan: &Plan,
    repo_contract_id: &str,
    state: &mut ImportState,
) -> Result<()> {
    // Labels (MAINTAIN) + milestone-derived labels.
    let labels = LabelService::new(client, identity, bridge);
    for l in &plan.labels {
        if l.name.is_empty() || state.done_labels.contains(&l.name) {
            continue;
        }
        guard_spend(cfg, state)?;
        labels
            .create_label(
                repo_contract_id,
                &truncate(&l.name, 30),
                &normalize_color(&l.color),
                &truncate(l.description.as_deref().unwrap_or(""), 200),
                false,
            )
            .await
            .with_context(|| format!("importing label {:?}", l.name))?;
        state.done_labels.insert(l.name.clone());
        state.save()?;
    }
    for m in &plan.milestones {
        let name = truncate(&format!("milestone:{}", m.title), 30);
        if m.title.is_empty() || state.done_labels.contains(&name) {
            continue;
        }
        guard_spend(cfg, state)?;
        // Milestone → label + convention: fold state + due date into the description so no
        // milestone doc type is needed (data-contracts §2: template v1 has none).
        let mut desc = m.description.clone().unwrap_or_default();
        if !m.state.is_empty() {
            desc = format!("[{}] {desc}", m.state);
        }
        if let Some(due) = &m.due_on {
            if !due.is_empty() {
                desc = format!("{desc} (due {due})");
            }
        }
        let desc = truncate(desc.trim(), 200);
        labels
            .create_label(repo_contract_id, &name, "#ededed", &desc, false)
            .await
            .with_context(|| format!("importing milestone-label {:?}", m.title))?;
        state.done_labels.insert(name);
        state.save()?;
    }

    // Issues (un-gated) + their state, labels, and comments.
    if !cfg.skip.issues {
        let issues = IssueService::new(client, identity, bridge);
        for gi in &plan.issues {
            if state.done_issues.contains(&gi.number) {
                continue;
            }
            guard_spend(cfg, state)?;
            import_one_issue(&issues, gh, cfg, repo_contract_id, gi).await?;
            state.done_issues.insert(gi.number);
            state.save()?;
        }
    }

    // Pull requests → patch docs (archived metadata: title/body/state, not full packs).
    if !cfg.skip.prs {
        let prs = PullRequestService::new(client, identity, bridge);
        let issues = IssueService::new(client, identity, bridge);
        for gp in &plan.pulls {
            if state.done_prs.contains(&gp.number) {
                continue;
            }
            guard_spend(cfg, state)?;
            import_one_pr(&prs, &issues, gh, cfg, repo_contract_id, gp).await?;
            state.done_prs.insert(gp.number);
            state.save()?;
        }
    }

    // Releases (MAINTAIN).
    if !cfg.skip.releases {
        let releases = ReleaseService::new(client, identity, bridge);
        for r in &plan.releases {
            if r.tag_name.is_empty() || state.done_releases.contains(&r.tag_name) {
                continue;
            }
            guard_spend(cfg, state)?;
            releases
                .create_release(
                    repo_contract_id,
                    &ReleaseInput {
                        tag_name: truncate(&r.tag_name, 63),
                        name: truncate(r.name.as_deref().unwrap_or(&r.tag_name), 120),
                        notes: truncate(r.body.as_deref().unwrap_or(""), 5120),
                        yanked: false,
                        assets: Vec::new(),
                    },
                )
                .await
                .with_context(|| format!("importing release {:?}", r.tag_name))?;
            state.done_releases.insert(r.tag_name.clone());
            state.save()?;
        }
    }
    Ok(())
}

/// Import one issue: the doc (with provenance), its label events, its close event if closed,
/// and its comment thread.
async fn import_one_issue(
    issues: &IssueService<'_>,
    gh: &GithubClient,
    cfg: &ImportConfig,
    repo_contract_id: &str,
    gi: &GhIssue,
) -> Result<()> {
    let imported = provenance(&gi.user.login, &gi.created_at, &gi.html_url);
    let issue = issues
        .create_issue_imported(
            repo_contract_id,
            &truncate(&gi.title, 256),
            &truncate(gi.body.as_deref().unwrap_or(""), 5120),
            Some(&imported),
        )
        .await
        .with_context(|| format!("importing issue #{}", gi.number))?;

    // Label events (kind 4 = label+), value = label name.
    for l in &gi.labels {
        if l.name.is_empty() {
            continue;
        }
        issues
            .add_event(
                repo_contract_id,
                &issue.document_id,
                EventKind::LabelAdd,
                Some(&truncate(&l.name, 120)),
                None,
            )
            .await
            .ok();
    }
    // Closed state.
    if gi.state.eq_ignore_ascii_case("closed") {
        issues
            .close(repo_contract_id, &issue.document_id)
            .await
            .ok();
    }
    // Comments (fetched now — not during enumeration).
    if !cfg.skip.comments {
        import_comments(issues, gh, repo_contract_id, &issue.document_id, gi.number).await;
    }
    Ok(())
}

/// Import one PR as an archived `patch` doc plus its resolved state, then its comment thread.
async fn import_one_pr(
    prs: &PullRequestService<'_>,
    issues: &IssueService<'_>,
    gh: &GithubClient,
    cfg: &ImportConfig,
    repo_contract_id: &str,
    gp: &GhPull,
) -> Result<()> {
    let imported = provenance(&gp.user.login, &gp.created_at, &gp.html_url);
    let base_branch = if gp.base.ref_name.is_empty() {
        "main"
    } else {
        &gp.base.ref_name
    };
    let base_ref_name = format!("refs/heads/{base_branch}");
    // Archived metadata: point sourceContractId at the base repo itself (no fork pack was
    // uploaded — PRD 06 controls closed-PR cost by storing metadata + head oid, not packs).
    let head_oid = hex::decode(&gp.head.sha).unwrap_or_default();
    let input = PullRequestInput {
        title: truncate(&gp.title, 256),
        body: truncate(gp.body.as_deref().unwrap_or(""), 5120),
        base_ref_name,
        source_listing_id: None,
        source_contract_id: repo_contract_id.to_string(),
        source_ref_name: None,
        head_oid: if head_oid.is_empty() {
            vec![0u8; 20]
        } else {
            head_oid
        },
        patch_manifest_hash: None,
    };
    let pr = prs
        .create_pr_imported(repo_contract_id, &input, Some(&imported))
        .await
        .with_context(|| format!("importing PR #{}", gp.number))?;

    // State events (audit): merged → merge event with the head oid; closed → close.
    if gp.is_merged() {
        let oid = hex::decode(&gp.head.sha).unwrap_or_default();
        if !oid.is_empty() {
            prs.merge_event(repo_contract_id, &pr.document_id, &oid)
                .await
                .ok();
        }
    } else if gp.state.eq_ignore_ascii_case("closed") {
        issues.close(repo_contract_id, &pr.document_id).await.ok();
    }
    if !cfg.skip.comments {
        import_comments(issues, gh, repo_contract_id, &pr.document_id, gp.number).await;
    }
    Ok(())
}

/// Import an issue/PR comment thread (best-effort; a failed comment never aborts a
/// migration). Comment bodies are fetched here, not during enumeration, so the cost pass
/// stays a single API sweep.
async fn import_comments(
    issues: &IssueService<'_>,
    gh: &GithubClient,
    repo_contract_id: &str,
    target_id: &str,
    number: u64,
) {
    let Ok(comments) = gh.issue_comments(number) else {
        tracing::warn!(number, "fetching comments failed; skipping thread");
        return;
    };
    for c in comments {
        let imported = provenance(&c.user.login, &c.created_at, &c.html_url);
        let _ = issues
            .comment_imported(
                repo_contract_id,
                target_id,
                &truncate(c.body.as_deref().unwrap_or(""), 5120),
                None,
                Some(&imported),
            )
            .await;
    }
}

/// Abort before a write if it would push spend past `--max-spend`.
fn guard_spend(cfg: &ImportConfig, state: &ImportState) -> Result<()> {
    if let Some(cap) = cfg.max_spend_credits {
        if state.spent_credits >= cap {
            bail!(
                "--max-spend cap {:.6} DASH reached (spent {:.6}) — stopping; rerun with \
                 --resume {} to continue after raising the cap",
                credits_to_dash(cap),
                credits_to_dash(state.spent_credits),
                cfg.resume_path.display()
            );
        }
    }
    Ok(())
}

/// Normalize a GitHub 6-hex color (`ee0701`) to the Forge `#rrggbb` form (≤ 7 chars).
fn normalize_color(color: &str) -> String {
    let c = color.trim().trim_start_matches('#');
    if c.len() == 6 && c.chars().all(|ch| ch.is_ascii_hexdigit()) {
        format!("#{c}")
    } else {
        "#ededed".to_string()
    }
}

/// Print the per-class cost estimate table.
fn print_estimate(plan: &Plan, costs: &[ClassCost], cfg: &ImportConfig) {
    println!(
        "\nDash Forge import — cost estimate for {}",
        cfg.source.slug()
    );
    println!(
        "  source: default branch {:?}, GitHub-reported size {} KiB",
        plan.meta.default_branch, plan.meta.size
    );
    println!(
        "  git data: {} bytes, {} objects, {} chunks, {} refs",
        plan.pack_bytes, plan.pack_objects, plan.pack_chunks, plan.ref_count
    );
    println!(
        "  issues: {}  prs: {}  labels: {}  milestones: {}  releases: {}  (projected comments: {})",
        plan.issues.len(),
        plan.pulls.len(),
        plan.labels.len(),
        plan.milestones.len(),
        plan.releases.len(),
        plan.projected_comments(),
    );
    println!(
        "\n  {:<14} {:>7} {:>16} {:>16}",
        "class", "count", "deposit(DASH)", "total(DASH)"
    );
    for c in costs {
        println!(
            "  {:<14} {:>7} {:>16.6} {:>16.6}",
            c.label,
            c.count,
            credits_to_dash(c.deposit),
            c.total_dash(),
        );
    }
    let total = Plan::grand_total(costs);
    println!("  {:-<56}", "");
    println!(
        "  {:<14} {:>7} {:>16.6} {:>16.6}",
        "TOTAL",
        "",
        credits_to_dash(total.deposit),
        total.total_dash()
    );
    println!(
        "  (deposit is refundable perpetual storage; burn = {:.6} DASH non-refundable)",
        credits_to_dash(total.burn)
    );
}

/// Report actual on-chain spend vs the estimate, with the delta percentage.
#[allow(clippy::cast_precision_loss)]
fn report_actual(spent_credits: u64, estimated_credits: u64) {
    let spent = credits_to_dash(spent_credits);
    let est = credits_to_dash(estimated_credits);
    let delta_pct = if estimated_credits > 0 {
        (spent_credits as f64 - estimated_credits as f64) / estimated_credits as f64 * 100.0
    } else {
        0.0
    };
    println!("\nimport complete.");
    println!("  estimated: {est:.6} DASH");
    println!("  actual:    {spent:.6} DASH");
    println!("  delta:     {delta_pct:+.1}% vs estimate");
}

/// Confirmation gate (mirrors `dg`): `--yes` short-circuits; a non-interactive stdin is
/// refused rather than silently spending.
fn confirm(cfg: &ImportConfig, total_dash: f64) -> Result<bool> {
    if cfg.yes {
        return Ok(true);
    }
    if !std::io::stdin().is_terminal() {
        bail!("refusing to spend on a non-interactive stdin without --yes");
    }
    eprint!("Proceed with import (~{total_dash:.6} DASH)? [y/N] ");
    std::io::stderr().flush().ok();
    let mut line = String::new();
    std::io::stdin()
        .read_line(&mut line)
        .context("reading confirmation")?;
    Ok(matches!(
        line.trim().to_ascii_lowercase().as_str(),
        "y" | "yes"
    ))
}

/// RAII cleanup of the temp clone directory.
struct CloneGuard(PathBuf);
impl Drop for CloneGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[cfg(test)]
mod tests {
    use super::{normalize_color, provenance, truncate, Backend};

    #[test]
    fn truncate_counts_chars() {
        assert_eq!(truncate("hello", 10), "hello");
        assert_eq!(truncate("hello", 3), "hel");
        assert_eq!(truncate("héllo", 2).chars().count(), 2);
    }

    #[test]
    fn color_normalizes_or_defaults() {
        assert_eq!(normalize_color("ee0701"), "#ee0701");
        assert_eq!(normalize_color("#ee0701"), "#ee0701");
        assert_eq!(normalize_color("nothex"), "#ededed");
        assert_eq!(normalize_color(""), "#ededed");
    }

    #[test]
    fn provenance_maps_fields() {
        let p = provenance("octocat", "2020-01-02T03:04:05Z", "https://x/y");
        assert_eq!(p.author, "octocat");
        assert_eq!(p.created_at, 1_577_934_245);
        assert_eq!(p.url, "https://x/y");
    }

    #[test]
    fn backend_modes() {
        assert_eq!(Backend::Platform.mode(), 0);
        assert_eq!(Backend::External.mode(), 3);
    }
}
