//! `dg ci` — CI runners and check runs (platform-parity-spec §2.2, §2.8).
//!
//! * `runner new` registers a key bound to `(forge-collab, checkRun)` (AUTHENTICATION / HIGH,
//!   `ContractBounds::SingleContractDocumentType`, with a budget and an expiry) on a runner
//!   identity, writes it as a `dfk1:` value (0600) **before** it is registered, and enrols the
//!   identity as a `runner` of the repo (a forge-core document only the repo owner can write).
//!   Without `--runner` the key goes on your own identity, which as the owner (a maintainer)
//!   needs no enrolment.
//! * `runner list` / `runner revoke`: the repo's runner memberships; revoking deletes the
//!   document, and consensus refuses the runner's next report (40120).
//! * `report` creates a `checkRun`, or replaces the reporter's open run of that name on that
//!   commit (queued → in_progress → completed), optionally uploading a log to a storage profile
//!   and recording its URL and SHA-256.
//! * `status` lists the newest run per name on a commit.

use std::path::{Path, PathBuf};

use anyhow::{Context as _, Result};
use clap::Subcommand;
use serde_json::json;

use forge_core::ci::{commit_web_url, CheckReport, CheckRuns, RunnerReader, RunnerService};
use forge_core::keystore::{self, BridgeIdentity};
use forge_core::platform::identity::{DocTypeKeySpec, FreshKey, KeySpec};

use crate::auth::{dash_to_credits, parse_days};
use crate::common::{Reader, Session};
use crate::context::Ctx;
use crate::fmt::{cost_json, cost_line, credits_to_dash, dash_amount, dash_usd_price};

/// Runner key defaults (spec §2.2): 0.5 DASH for 365 days.
const RUNNER_KEY_BUDGET_DASH: f64 = 0.5;
const RUNNER_KEY_DAYS: u64 = 365;
const DAY_MS: u64 = 24 * 60 * 60 * 1000;
/// One identity update adding a key, plus a `runner` document (an upper bound, credits).
const RUNNER_NEW_ESTIMATE_CREDITS: u64 = 40_000_000;
/// One `checkRun` create or replace (an upper bound, credits; measured on moutai in the docs).
const REPORT_ESTIMATE_CREDITS: u64 = 30_000_000;

/// `dg ci` subcommands.
#[derive(Debug, Subcommand)]
pub enum CiCommand {
    /// CI runner identities and their keys.
    #[command(subcommand)]
    Runner(RunnerCommand),
    /// Report a check run on a commit (create it, or update your open run of that name).
    Report(Box<ReportArgs>),
    /// The newest check run per name on a commit.
    Status {
        /// The repository (`owner/name`).
        repo: String,
        /// The commit (40 or 64 hex digits).
        sha: String,
    },
}

/// `dg ci runner` subcommands.
#[derive(Debug, Subcommand)]
pub enum RunnerCommand {
    /// Register a checkRun-only key for a runner identity and enrol it as a runner of the repo.
    New(Box<RunnerNewArgs>),
    /// Enrol an identity that already has a key as a runner of the repo (the owner signs).
    Add {
        /// The repository (`owner/name`).
        repo: String,
        /// The runner identity id (base58).
        runner: String,
    },
    /// List the repo's runners.
    List {
        /// The repository (`owner/name`).
        repo: String,
    },
    /// Revoke a runner (its next report is refused at consensus).
    Revoke {
        /// The repository (`owner/name`).
        repo: String,
        /// The runner identity id (base58).
        runner: String,
    },
}

/// `dg ci runner new` arguments.
#[derive(Debug, clap::Args)]
pub struct RunnerNewArgs {
    /// The repository (`owner/name`); you must own it to enrol a runner.
    pub repo: String,
    /// The runner identity's file, with its master key (e.g. from `dg auth new --backup-file`).
    /// The key is registered on it and it is enrolled as a runner. Without it the key goes on
    /// your own identity (no enrolment needed: the owner is a maintainer).
    #[arg(long, value_name = "FILE")]
    pub runner: Option<PathBuf>,
    /// Without --runner: your identity file with the master key (else you are asked for the
    /// recovery words).
    #[arg(long, value_name = "FILE", conflicts_with = "runner")]
    pub master: Option<PathBuf>,
    /// Where to write the `dfk1:` key (created 0600; refuses an existing file).
    #[arg(long, short = 'o', value_name = "FILE")]
    pub output: PathBuf,
    /// The key's total budget in DASH (default 0.5).
    #[arg(long, value_name = "DASH")]
    pub budget: Option<f64>,
    /// How long the key lives: `365d`, `12w`, `6m`, `1y` (default 365d).
    #[arg(long, value_name = "DURATION")]
    pub expires: Option<String>,
}

/// `dg ci report` arguments.
#[derive(Debug, clap::Args)]
pub struct ReportArgs {
    /// The repository (`owner/name`).
    pub repo: String,
    /// The commit the check ran on (40 or 64 hex digits).
    #[arg(long, alias = "head")]
    pub sha: String,
    /// The check's name (`build`, `test`); the newest run per name is what readers show.
    #[arg(long)]
    pub name: String,
    /// `queued`, `in_progress` or `completed`.
    #[arg(long, value_parser = forge_core::ci::STATUSES)]
    pub status: String,
    /// With `--status completed`: success, failure, neutral, cancelled, skipped, timed_out,
    /// action_required or stale.
    #[arg(long, value_parser = forge_core::ci::CONCLUSIONS)]
    pub conclusion: Option<String>,
    /// A link to the run (https), e.g. the GitHub Actions run.
    #[arg(long)]
    pub details_url: Option<String>,
    /// A one-line summary (≤ 1000 characters).
    #[arg(long, conflicts_with = "summary_file")]
    pub summary: Option<String>,
    /// Read the summary from a file.
    #[arg(long, value_name = "FILE")]
    pub summary_file: Option<PathBuf>,
    /// The CI's own run id: reporting it again updates that run, even once completed.
    #[arg(long)]
    pub external_id: Option<String>,
    /// Upload this log file to your storage (content-addressed) and record its URL and SHA-256.
    #[arg(long, value_name = "FILE")]
    pub log: Option<PathBuf>,
    /// The storage profile(s) for --log (default: the repository's dash.storage).
    #[arg(long, requires = "log")]
    pub storage: Option<String>,
}

impl CiCommand {
    /// The error headline and the repo, for `errors::context_for`.
    pub fn context(&self) -> (&'static str, Option<&String>) {
        match self {
            CiCommand::Runner(RunnerCommand::New(a)) => ("runner not created", Some(&a.repo)),
            CiCommand::Runner(RunnerCommand::Add { repo, .. }) => {
                ("runner not enrolled", Some(repo))
            }
            CiCommand::Runner(RunnerCommand::List { repo }) => {
                ("could not list runners", Some(repo))
            }
            CiCommand::Runner(RunnerCommand::Revoke { repo, .. }) => {
                ("runner not revoked", Some(repo))
            }
            CiCommand::Report(a) => ("check run not reported", Some(&a.repo)),
            CiCommand::Status { repo, .. } => ("could not read check runs", Some(repo)),
        }
    }
}

/// Dispatch a `ci` subcommand.
pub async fn run(ctx: &Ctx, cmd: &CiCommand) -> Result<()> {
    match cmd {
        CiCommand::Runner(RunnerCommand::New(a)) => runner_new(ctx, a).await,
        CiCommand::Runner(RunnerCommand::Add { repo, runner }) => {
            runner_add(ctx, repo, runner).await
        }
        CiCommand::Runner(RunnerCommand::List { repo }) => runner_list(ctx, repo).await,
        CiCommand::Runner(RunnerCommand::Revoke { repo, runner }) => {
            runner_revoke(ctx, repo, runner).await
        }
        CiCommand::Report(a) => report(ctx, a).await,
        CiCommand::Status { repo, sha } => status(ctx, repo, sha).await,
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

/// The identity whose master key registers the runner key: `--runner <file>`, else your own.
fn key_holder(ctx: &Ctx, args: &RunnerNewArgs, me: &str) -> Result<BridgeIdentity> {
    let Some(file) = &args.runner else {
        return crate::auth::master_identity(ctx, args.master.as_deref(), me);
    };
    let b = BridgeIdentity::load_from_file(file).with_context(|| {
        format!(
            "loading the runner identity from {}",
            keystore::describe_key_source(file)
        )
    })?;
    if b.master_key().is_none() {
        return Err(crate::errors::usage(format!(
            "{} has no master key; registering the runner key needs the runner identity's master key once",
            file.display()
        )));
    }
    Ok(b)
}

async fn runner_new(ctx: &Ctx, args: &RunnerNewArgs) -> Result<()> {
    if args.output.exists() {
        return Err(crate::errors::usage(format!(
            "{} already exists; pass a new path with -o",
            args.output.display()
        )));
    }
    let s = Session::open(ctx, &args.repo).await?;
    if s.repo.owner_id() != s.identity.id() {
        return Err(crate::errors::usage(format!(
            "only the owner of {} ({}) can enrol a runner",
            s.repo.display(),
            s.repo.owner_id()
        )));
    }
    let holder = key_holder(ctx, args, &s.identity.id())?;
    let enrol = holder.identity_id != s.identity.id();
    let days = args
        .expires
        .as_deref()
        .map_or(Ok(RUNNER_KEY_DAYS), parse_days)?;
    let spec = DocTypeKeySpec {
        budget_credits: dash_to_credits(args.budget.unwrap_or(RUNNER_KEY_BUDGET_DASH))?,
        expires_at_ms: now_ms() + days * DAY_MS,
        contract: s.repo.forge().collab.clone(),
        document_type: forge_core::collab::v2::DOC_CHECK_RUN.to_string(),
    };
    if !ctx.json {
        eprintln!(
            "Registering a runner key on {} ({}):",
            holder.identity_id,
            ctx.network_label()
        );
        eprintln!(
            "  it can only write checkRun documents, spend at most {} DASH, and expires in {days} day(s)",
            dash_amount(credits_to_dash(spec.budget_credits))
        );
        if enrol {
            eprintln!("  and enrols it as a runner of {}", s.repo.display());
        }
        eprintln!(
            "  {}",
            cost_line(RUNNER_NEW_ESTIMATE_CREDITS, dash_usd_price())
        );
    }
    ctx.confirm_or_cancel("Register the runner key?")?;
    let before = s.balance().await;
    let key_id = register_runner_key(ctx, &s, &holder, &spec, &args.output).await?;
    let membership = if enrol {
        Some(
            RunnerService::new(&s.client, &s.identity, &s.bridge)
                .enrol(&s.repo, &holder.identity_id)
                .await
                .context("enrolling the runner (the key is registered and saved)")?,
        )
    } else {
        None
    };
    // The owner pays the enrolment; the key update is paid by the key holder.
    let spent = if enrol {
        s.spent_since(before).await
    } else {
        0
    };
    ctx.emit(
        json!({
            "status": "created",
            "repo": s.repo.display(),
            "runner": holder.identity_id,
            "keyId": key_id,
            "boundTo": { "contract": spec.contract, "documentType": spec.document_type },
            "budgetCredits": spec.budget_credits,
            "expiresAt": spec.expires_at_ms,
            "path": args.output.display().to_string(),
            "enrolled": membership.as_ref().map(|m| m.document_id.clone()),
            "enrolCost": cost_json(spent, dash_usd_price()),
        }),
        || {
            println!(
                "✓ runner key #{key_id} on {} written to {} (0600, UNENCRYPTED)",
                holder.identity_id,
                args.output.display()
            );
            if membership.is_some() {
                println!("✓ enrolled as a runner of {}", s.repo.display());
            }
            println!("  use it as a CI secret: DASH_FORGE_KEY=<the file's contents>");
            println!(
                "  it can only report check runs: `dg ci report {} --sha … --name … --status …`",
                s.repo.display()
            );
        },
    );
    Ok(())
}

/// Register a key for `spec` on `holder` (signed once by its master key), writing its `dfk1:`
/// value to `output` before anything is broadcast, and read it back from the chain.
async fn register_runner_key(
    ctx: &Ctx,
    s: &Session,
    holder: &BridgeIdentity,
    spec: &DocTypeKeySpec,
    output: &Path,
) -> Result<u32> {
    let runner = s.client.fetch_identity(&holder.identity_id).await?;
    let fresh = FreshKey::generate(ctx.network());
    let wif = fresh.wif();
    let network = ctx.network_label();
    let dfk1_for = |id| keystore::dfk1(&network, &holder.identity_id, id, wif.expose());
    let predicted = runner.next_key_id();
    // Kept before it is registered, so a key nobody holds is never registered.
    keystore::create_private_file(output, dfk1_for(predicted).expose().as_bytes())?;
    let master = holder.master_key().context("no master key")?;
    let ids = s
        .client
        .update_identity_keys(
            &holder.identity_id,
            &master.private_key_wif,
            &[(&fresh, KeySpec::DocumentType(spec.clone()))],
            &[],
        )
        .await
        .context("registering the runner key")?;
    let key_id = *ids.first().context("no key id")?;
    if key_id != predicted {
        keystore::write_private_file(output, dfk1_for(key_id).expose().as_bytes())?;
    }
    verify_key(ctx, s, &holder.identity_id, key_id, &wif, spec).await?;
    Ok(key_id)
}

async fn verify_key(
    ctx: &Ctx,
    s: &Session,
    identity_id: &str,
    key_id: u32,
    wif: &keystore::Secret,
    spec: &DocTypeKeySpec,
) -> Result<()> {
    let mut last = None;
    for attempt in 0..8u64 {
        match s.client.fetch_identity(identity_id).await {
            Ok(i) => match i.check_doc_type_key(key_id, wif.expose(), ctx.network(), spec) {
                Ok(()) => return Ok(()),
                Err(e) => last = Some(e),
            },
            Err(e) => last = Some(e),
        }
        tokio::time::sleep(std::time::Duration::from_millis(1500 * (attempt + 1))).await;
    }
    Err(last.map_or_else(|| anyhow::anyhow!("the new key was not found"), Into::into))
        .context("verifying the runner key on chain")
}

async fn runner_add(ctx: &Ctx, repo: &str, runner: &str) -> Result<()> {
    let s = Session::open(ctx, repo).await?;
    s.client
        .fetch_identity(runner)
        .await
        .with_context(|| format!("{runner} is not an identity on this network"))?;
    ctx.confirm_or_cancel(&format!(
        "Enrol {runner} as a runner of {}? ({})",
        s.repo.display(),
        cost_line(RUNNER_NEW_ESTIMATE_CREDITS, dash_usd_price())
    ))?;
    let before = s.balance().await;
    let m = RunnerService::new(&s.client, &s.identity, &s.bridge)
        .enrol(&s.repo, runner)
        .await?;
    let spent = s.spent_since(before).await;
    ctx.emit(
        json!({ "status": "enrolled", "runner": runner, "documentId": m.document_id, "cost": cost_json(spent, dash_usd_price()) }),
        || println!("✓ {runner} is a runner of {} ({})", s.repo.display(), cost_line(spent, dash_usd_price())),
    );
    Ok(())
}

async fn runner_list(ctx: &Ctx, repo: &str) -> Result<()> {
    let r = Reader::open(ctx, repo).await?;
    let runners = RunnerReader::new(&r.client).list(&r.repo).await?;
    ctx.emit(
        json!({ "count": runners.len(), "runners": runners }),
        || {
            if runners.is_empty() {
                println!("no runners");
            }
            for x in &runners {
                println!("{}  (membership {})", x.identity_id, x.document_id);
            }
        },
    );
    Ok(())
}

async fn runner_revoke(ctx: &Ctx, repo: &str, runner: &str) -> Result<()> {
    let s = Session::open(ctx, repo).await?;
    ctx.confirm_or_cancel(&format!(
        "Revoke runner {runner} of {}? (one document delete)",
        s.repo.display()
    ))?;
    let existed = RunnerService::new(&s.client, &s.identity, &s.bridge)
        .revoke(&s.repo, runner)
        .await?;
    ctx.emit(
        json!({ "status": if existed { "revoked" } else { "not_a_runner" }, "runner": runner }),
        || {
            if existed {
                println!("✓ {runner} is no longer a runner; its next report is refused");
            } else {
                println!("{runner} was not a runner of {}", s.repo.display());
            }
        },
    );
    Ok(())
}

/// The log's first https URL and its SHA-256, after uploading it to `storage`.
async fn upload_log(path: &Path, storage: Option<&str>) -> Result<(String, [u8; 32])> {
    let (targets, required) = crate::release::asset_targets(storage)?;
    let (asset, _) = crate::release::upload_asset(path, &targets, required).await?;
    let url = asset
        .uris
        .iter()
        .find(|u| u.starts_with("https://") || u.starts_with("http://"))
        .cloned()
        .context("the log's storage recorded no http(s) URL a browser can read")?;
    let mut sha = [0u8; 32];
    hex::decode_to_slice(&asset.sha256, &mut sha).context("the log's SHA-256")?;
    Ok((url, sha))
}

async fn report(ctx: &Ctx, a: &ReportArgs) -> Result<()> {
    let summary = match &a.summary_file {
        Some(p) => Some(
            std::fs::read_to_string(p)
                .with_context(|| format!("reading {}", p.display()))?
                .trim()
                .to_string(),
        ),
        None => a.summary.clone(),
    }
    .filter(|s| !s.is_empty());
    let now = now_ms();
    let mut r = CheckReport {
        head_oid: a.sha.to_ascii_lowercase(),
        name: a.name.clone(),
        status: a.status.clone(),
        conclusion: a.conclusion.clone(),
        details_url: a.details_url.clone(),
        summary,
        external_id: a.external_id.clone(),
        started_at: (a.status == "in_progress").then_some(now),
        completed_at: (a.status == "completed").then_some(now),
        ..CheckReport::default()
    };
    // Refused before anything is uploaded or signed.
    r.validate().map_err(|e| {
        crate::errors::usage(
            e.to_string()
                .trim_start_matches("configuration error: ")
                .to_string(),
        )
    })?;
    let s = Session::open_for_write(ctx, &a.repo, "check run not reported").await?;
    if let Some(p) = &a.log {
        r.log = Some(upload_log(p, a.storage.as_deref()).await?);
    }
    ctx.confirm_or_cancel(&format!(
        "Report {} = {} on {} in {}? ({})",
        r.name,
        r.conclusion.as_deref().unwrap_or(&r.status),
        &r.head_oid[..7.min(r.head_oid.len())],
        s.repo.display(),
        cost_line(REPORT_ESTIMATE_CREDITS, dash_usd_price())
    ))?;
    let before = s.balance().await;
    let done = CheckRuns::new(&s.client, &s.identity, &s.bridge)
        .report(&s.repo, &r)
        .await?;
    let spent = if done.action == "unchanged" {
        0
    } else {
        s.spent_since(before).await
    };
    let url = commit_web_url(&s.repo, &r.head_oid);
    ctx.emit(
        json!({
            "status": done.action,
            "documentId": done.document_id,
            "name": r.name,
            "checkStatus": r.status,
            "conclusion": r.conclusion,
            "headOid": r.head_oid,
            "logUrl": r.log.as_ref().map(|(u, _)| u.clone()),
            "logSha256": r.log.as_ref().map(|(_, h)| hex::encode(h)),
            "url": url,
            "cost": cost_json(spent, dash_usd_price()),
        }),
        || {
            println!(
                "✓ {} {} ({}), {}",
                done.action,
                r.name,
                r.conclusion.as_deref().unwrap_or(&r.status),
                cost_line(spent, dash_usd_price())
            );
            if let Some((u, _)) = &r.log {
                println!("  log: {u}");
            }
            println!("  {url}");
        },
    );
    Ok(())
}

async fn status(ctx: &Ctx, repo: &str, sha: &str) -> Result<()> {
    let r = Reader::open(ctx, repo).await?;
    let sha = sha.to_ascii_lowercase();
    let runs = r.collab().check_runs(&r.repo, &sha).await?;
    let url = commit_web_url(&r.repo, &sha);
    ctx.emit(
        json!({ "headOid": sha, "checks": runs, "url": url }),
        || {
            if runs.is_empty() {
                println!("no checks reported for {}", &sha[..7.min(sha.len())]);
            }
            for c in &runs {
                let state = if c.status == "completed" {
                    c.conclusion.as_str()
                } else {
                    c.status.as_str()
                };
                println!(
                    "  {:<24} {state}{}",
                    crate::fmt::safe(&c.name),
                    if c.trusted {
                        String::new()
                    } else {
                        "  (reporter is no longer a member or runner: not counted)".into()
                    }
                );
            }
            println!("  {url}");
        },
    );
    Ok(())
}
