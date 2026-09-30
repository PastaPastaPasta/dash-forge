//! `dg ci` — CI runners and check runs (platform-parity-spec §2.2, §2.8).
//!
//! * `runner new` registers a key bound to `(forge-community, checkRun)` (AUTHENTICATION / HIGH,
//!   `ContractBounds::SingleContractDocumentType`, with a budget and an expiry) on a runner
//!   identity, writes it as a `dfk1:` value (0600) **before** it is registered, and enrols the
//!   identity as a `runner` of the repo (a forge-core document only the repo owner can write).
//!   Without `--runner` the key goes on your own identity, which as the owner (a maintainer)
//!   needs no enrolment.
//! * `runner list` / `runner revoke`: the repo's runner memberships; revoking deletes the
//!   document, and consensus refuses the runner's next report (40120).
//! * `report` creates a `checkRun`, or replaces the reporter's open run of that name on that
//!   commit (queued → in_progress → completed), optionally uploading a log to a storage profile
//!   and recording its URL (https or `ipfs://`) and SHA-256. On a private repository the run
//!   records only its name, status, conclusion and times: the summary, details link, external
//!   id and log are left out with a warning (forge-community `privateNoText`), and no log is
//!   uploaded.
//! * `status` lists the newest run per name on a commit.

use std::path::{Path, PathBuf};

use anyhow::{Context as _, Result};
use clap::Subcommand;
use serde_json::json;

use forge_core::ci::{
    commit_web_url, is_log_url, CheckReport, CheckRuns, RunnerReader, RunnerService,
};
use forge_core::keystore::{self, BridgeIdentity};
use forge_core::platform::identity::{DocTypeKeySpec, FreshKey, KeySpec};
use forge_core::rules::v2::Visibility;
use forge_core::storage::policy::git_config_scoped;
use forge_core::storage::{Profile, StoragePolicy, StorageProfiles};
use forge_core::user_error::{codes, UserError};

use crate::auth::{dash_to_credits, expiry_ms, parse_days};
use crate::common::{resolve_identity, Reader, Session};
use crate::context::Ctx;
use crate::fmt::{cost_json, cost_line, credits_to_dash, dash_amount, dash_usd_price};

/// Runner key defaults (spec §2.2): 0.5 DASH for 365 days.
const RUNNER_KEY_BUDGET_DASH: f64 = 0.5;
const RUNNER_KEY_DAYS: u64 = 365;
/// Estimates (credits), upper bounds over what devnet bonsia charged on 2026-09-30 (Platform
/// 4.2.0-beta.7; docs/guides/ci.md "What it costs"): the runner key's identity update
/// (`ADD_KEY_ESTIMATE_CREDITS`, 43.0 M, paid by the runner), a `runner` document (47.3 M, paid
/// by the owner), a `checkRun` create (81.5–95.1 M; a repository's first, 121.9 M) and a
/// replace (4.7–5.5 M). A check run's text is priced on top ([`report_estimate`]): the contract
/// admits up to ~6 KB of it (a 1,000-character summary, 4,096 bytes of artifacts), which no
/// flat figure covers (QW-038: the flat 85 M and 5 M were exceeded).
const ENROL_ESTIMATE_CREDITS: u64 = 55_000_000;
const CREATE_BASE_CREDITS: u64 = 130_000_000;
/// A replace re-serializes the whole stored run, whose text it may not carry (a status-only
/// update of a run created with a full summary): the ~6 KB the contract admits, reprocessed at
/// ~412 credits/B (drive's replaced-bytes rate), is ~2.5 M on top of the 4.7 M measured.
const REPLACE_BASE_CREDITS: u64 = 8_000_000;
/// What each byte of a check run's text adds (the storage, its processing, the replaced bytes).
const REPORT_PER_BYTE_CREDITS: u64 = 27_500;
/// A log's URL (at most 300 bytes) and its SHA-256, priced before the log is uploaded.
const LOG_FIELDS_BYTES: u64 = 300 + 32;

/// The quote for a check-run write: a create (the first report of a run) or a replace, plus
/// the text it carries, and the log's URL and hash when one is uploaded after the prompt.
fn report_estimate(r: &CheckReport, replaces: bool, with_log: bool) -> u64 {
    let text = [
        Some(r.name.as_str()),
        r.details_url.as_deref(),
        r.summary.as_deref(),
        r.external_id.as_deref(),
        r.artifacts.as_deref(),
    ]
    .into_iter()
    .flatten()
    .map(|s| s.len() as u64)
    .sum::<u64>()
        + if with_log { LOG_FIELDS_BYTES } else { 0 };
    let base = if replaces {
        REPLACE_BASE_CREDITS
    } else {
        CREATE_BASE_CREDITS
    };
    base + REPORT_PER_BYTE_CREDITS * text
}

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
        /// The runner: an identity id (base58) or a DPNS name (`alice`, `@alice`, `alice.dash`).
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
        /// The runner: an identity id (base58) or a DPNS name (`alice`, `@alice`, `alice.dash`).
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
    /// A link to the run (https:// only), e.g. the GitHub Actions run. Left out on a private
    /// repository.
    #[arg(long)]
    pub details_url: Option<String>,
    /// A one-line summary (≤ 1000 characters). Left out on a private repository.
    #[arg(long, conflicts_with = "summary_file")]
    pub summary: Option<String>,
    /// Read the summary from a file.
    #[arg(long, value_name = "FILE")]
    pub summary_file: Option<PathBuf>,
    /// The CI's own run id: reporting it again updates that run until it completes (a completed
    /// run is final on forge-community; a report after that is a new run). Left out on a
    /// private repository, where your open run of that name is the one updated.
    #[arg(long)]
    pub external_id: Option<String>,
    /// Upload this log file to your storage (content-addressed) and record its URL and SHA-256.
    /// The storage must give an https (S3 `public_url`) or IPFS address. Not uploaded on a
    /// private repository.
    #[arg(long, value_name = "FILE")]
    pub log: Option<PathBuf>,
    /// The storage profile(s) for --log (default: the repository's dash.storage).
    #[arg(long, requires = "log")]
    pub storage: Option<String>,
    /// No longer has any effect: a private repository's check run cannot carry a log URL
    /// (forge-community refuses one), so `--log` is not uploaded there.
    #[arg(long, requires = "log", hide = true)]
    pub public_log: bool,
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
        expires_at_ms: expiry_ms(days),
        contract: s.repo.forge().community.clone(),
        document_type: forge_core::collab::v2::DOC_CHECK_RUN.to_string(),
    };
    explain_runner_key(ctx, &s, &holder.identity_id, &spec, days, enrol);
    ctx.confirm_or_cancel("Register the runner key?")?;
    let holder_before = holder_balance(&s, &holder.identity_id).await;
    let key_id = register_runner_key(ctx, &s, &holder, &spec, &args.output).await?;
    let key_spent = holder_spent(&s, &holder.identity_id, holder_before).await;
    // The owner pays the enrolment; the key update is paid by the key holder.
    let (membership, enrol_spent) = if enrol {
        let before = s.balance().await;
        let m = RunnerService::new(&s.client, &s.identity, &s.bridge)
            .enrol(&s.repo, &holder.identity_id)
            .await
            .with_context(|| {
                format!(
                    "enrolling the runner (key #{key_id} is registered and saved in {}; enrol it with `dg ci runner add {} {}`)",
                    args.output.display(),
                    s.repo.display(),
                    holder.identity_id
                )
            })?;
        (Some(m), s.spent_since(before).await)
    } else {
        (None, 0)
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
            "keyCost": cost_json(key_spent, dash_usd_price()),
            "enrolCost": cost_json(enrol_spent, dash_usd_price()),
        }),
        || {
            println!(
                "✓ runner key #{key_id} on {} written to {} (0600, UNENCRYPTED)",
                holder.identity_id,
                args.output.display()
            );
            println!("  the key cost {}", cost_line(key_spent, dash_usd_price()));
            if membership.is_some() {
                println!(
                    "✓ enrolled as a runner of {} ({})",
                    s.repo.display(),
                    cost_line(enrol_spent, dash_usd_price())
                );
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

/// What `runner new` is about to do and cost, on stderr.
fn explain_runner_key(
    ctx: &Ctx,
    s: &Session,
    holder: &str,
    spec: &DocTypeKeySpec,
    days: u64,
    enrol: bool,
) {
    if ctx.json {
        return;
    }
    let price = dash_usd_price();
    eprintln!(
        "Registering a runner key on {holder} ({}):",
        ctx.network_label()
    );
    eprintln!(
        "  it can only write checkRun documents, spend at most {} DASH, and expires in {days} day(s)",
        dash_amount(credits_to_dash(spec.budget_credits))
    );
    eprintln!(
        "  the key: one identity update, {} (paid by {holder})",
        cost_line(
            forge_core::platform::identity_keys::ADD_KEY_ESTIMATE_CREDITS,
            price
        )
    );
    if enrol {
        eprintln!(
            "  the enrolment as a runner of {}: one document, {} (paid by you)",
            s.repo.display(),
            cost_line(ENROL_ESTIMATE_CREDITS, price)
        );
    }
}

/// The key holder's balance (0 when unreadable), for [`holder_spent`].
async fn holder_balance(s: &Session, id: &str) -> u64 {
    s.client.get_balance(id).await.unwrap_or(0)
}

/// Credits the key holder spent since `before` (read until it moves, like
/// [`Session::spent_since`]); 0 when unreadable.
async fn holder_spent(s: &Session, id: &str, before: u64) -> u64 {
    for attempt in 0..4 {
        if let Ok(after) = s.client.get_balance(id).await {
            if after < before || attempt == 3 {
                return before.saturating_sub(after);
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
    }
    0
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
        .with_context(|| {
            format!(
                "registering the runner key on {} (it may still land: `dg auth keys list --identity <runner file>` shows it; {} holds the key if it did — delete it if not, and run again with a new -o)",
                holder.identity_id,
                output.display()
            )
        })?;
    let key_id = *ids.first().context("no key id")?;
    if key_id != predicted {
        keystore::write_private_file(output, dfk1_for(key_id).expose().as_bytes())?;
    }
    crate::auth::await_key(&s.client, &holder.identity_id, "runner key", |i| {
        i.check_doc_type_key(key_id, wif.expose(), ctx.network(), spec)
    })
    .await?;
    Ok(key_id)
}

async fn runner_add(ctx: &Ctx, repo: &str, runner: &str) -> Result<()> {
    let s = Session::open(ctx, repo).await?;
    // `runner` is an identity id or a DPNS name; resolve it once so the existence check and
    // enrolment below both see a plain identity id.
    let runner: &str = &resolve_identity(&s.client, runner, "runner").await?;
    s.client
        .fetch_identity(runner)
        .await
        .with_context(|| format!("{runner} is not an identity on this network"))?;
    ctx.confirm_or_cancel(&format!(
        "Enrol {runner} as a runner of {}? ({})",
        s.repo.display(),
        cost_line(ENROL_ESTIMATE_CREDITS, dash_usd_price())
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
    // `runner` is an identity id or a DPNS name; resolve it once so the revoke below sees a
    // plain identity id.
    let runner: &str = &resolve_identity(&s.client, runner, "runner").await?;
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

/// The URL a check run records for a log stored at `uris`: the first https one the contract's
/// `logUrl` pattern accepts (a browser reads it), else an `ipfs://` one. Never `http://` or
/// `s3://`, which forge-community refuses.
fn log_url(uris: &[String]) -> Option<&String> {
    uris.iter()
        .find(|u| u.starts_with("https://") && is_log_url(u))
        .or_else(|| uris.iter().find(|u| is_log_url(u)))
}

/// Whether a storage profile records an address a check run's `logUrl` accepts: an S3 bucket
/// with an https `public_url`, or IPFS (`ipfs://<cid>`).
fn gives_log_url(profile: &Profile) -> bool {
    match profile {
        Profile::S3(p) => p
            .public_url
            .as_deref()
            .is_some_and(|u| is_log_url(&format!("{}/log", u.trim_end_matches('/')))),
        Profile::IpfsKubo(_) | Profile::IpfsPinningService(_) => true,
        Profile::Platform(_) => false,
    }
}

/// Refuse, before anything is uploaded, storage none of whose profiles records an https or
/// IPFS address (a plain-http or private bucket): the check run could not name the log.
fn check_log_storage(storage: Option<&str>) -> Result<()> {
    let (list, replicas) = match storage {
        Some(s) => (Some(s.to_string()), None),
        None => (
            git_config_scoped("dash.storage").map(|(_, v)| v),
            git_config_scoped("dash.replicas").map(|(_, v)| v),
        ),
    };
    let policy = StoragePolicy::from_git_values(list.as_deref(), replicas.as_deref(), None)?
        .resolve(&StorageProfiles::load()?)?;
    if policy.external.is_empty() || policy.external.iter().any(|(_, p)| gives_log_url(p)) {
        // No external storage at all: `asset_targets` explains that.
        return Ok(());
    }
    Err(UserError::new(
        codes::STORAGE_CONFIG,
        "the log's storage gives no https or IPFS address",
    )
    .cause(format!(
        "a check run's log URL must be https:// or ipfs:// (forge-community), and {} records \
         neither (a bucket without a public_url, or a plain-http one)",
        policy
            .external
            .iter()
            .map(|(n, _)| n.as_str())
            .collect::<Vec<_>>()
            .join(", ")
    ))
    .fix("give the bucket an https public_url (`dg storage add … --public-url https://…`), or pass --storage with an IPFS profile")
    .note("nothing was uploaded or written")
    .into())
}

/// The log's https (else `ipfs://`) URL and its SHA-256, after uploading it to `storage`.
async fn upload_log(path: &Path, storage: Option<&str>) -> Result<(String, [u8; 32])> {
    let (targets, required) = crate::release::asset_targets(storage)?;
    let (asset, _) = crate::release::upload_asset(path, &targets, required).await?;
    let url = log_url(&asset.uris)
        .cloned()
        .context("the log's storage recorded no https or ipfs:// URL a check run can name")?;
    let mut sha = [0u8; 32];
    hex::decode_to_slice(&asset.sha256, &mut sha).context("the log's SHA-256")?;
    Ok((url, sha))
}

/// Warn that a private repository's run leaves out `fields` (forge-community `privateNoText`),
/// and that `--public-log` no longer does anything.
fn warn_private(a: &ReportArgs, s: &Session, fields: &[&str]) {
    if a.public_log {
        eprintln!(
            "warning: --public-log has no effect any more: a private repository's check run \
             cannot carry a log URL"
        );
    }
    if !fields.is_empty() {
        eprintln!(
            "warning: {} is private; its check run records only the name, status, conclusion \
             and times, so {} {} left out{}",
            s.repo.display(),
            fields.join(", "),
            if fields.len() == 1 { "is" } else { "are" },
            if a.log.is_some() {
                " (the log is not uploaded)"
            } else {
                ""
            }
        );
    }
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
    // `startedAt` / `completedAt` are set by the write itself (`CheckReport::write`): the first
    // report that is not queued starts the run, the first completed one ends it, whatever the
    // report skipped (a run that jumps straight to completed gets both), and a stored time is
    // never moved.
    let mut r = CheckReport {
        head_oid: a.sha.to_ascii_lowercase(),
        name: a.name.clone(),
        status: a.status.clone(),
        conclusion: a.conclusion.clone(),
        details_url: a.details_url.clone(),
        summary,
        external_id: a.external_id.clone(),
        ..CheckReport::default()
    };
    // Refused before anything is uploaded or signed: what every run carries at once, and the
    // text once the repository's visibility says whether it is kept (a private repository's
    // run drops it with a warning instead).
    let usage = |e: forge_core::error::Error| match e {
        forge_core::error::Error::Config(m) => crate::errors::usage(m),
        other => other.into(),
    };
    r.for_visibility(Visibility::Private)
        .0
        .validate()
        .map_err(usage)?;
    let s = Session::open_for_write(ctx, &a.repo, "check run not reported").await?;
    let private = s.repo.visibility == Visibility::Private;
    let (kept, mut left_out) = r.for_visibility(s.repo.visibility);
    kept.validate().map_err(usage)?;
    if a.log.is_some() {
        if private {
            left_out.push("logUrl");
        } else {
            check_log_storage(a.storage.as_deref())?;
        }
    }
    warn_private(a, &s, &left_out);
    let runs = CheckRuns::new(&s.client, &s.identity, &s.bridge);
    // Decided before the prompt, so it prices the write that happens. The plan gets the
    // report as given: an external id, even one a private repository drops, tells it the
    // run may have been created a moment ago.
    let plan = runs.plan(&s.repo, &r).await?;
    r = kept;
    let verb = if plan.replaces() { "update" } else { "create" };
    let estimate = report_estimate(&r, plan.replaces(), a.log.is_some() && !private);
    ctx.confirm_or_cancel(&format!(
        "Report {} = {} on {} in {}? ({verb} a check run, {})",
        r.name,
        r.conclusion.as_deref().unwrap_or(&r.status),
        &r.head_oid[..7.min(r.head_oid.len())],
        s.repo.display(),
        cost_line(estimate, dash_usd_price())
    ))?;
    if let Some(p) = a.log.as_ref().filter(|_| !private) {
        r.log = Some(upload_log(p, a.storage.as_deref()).await?);
    }
    let before = s.balance().await;
    let done = runs.execute(&s.repo, &r, plan).await?;
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
            // What a private repository's run left out (forge-community `privateNoText`).
            "leftOut": left_out,
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
                        ""
                    } else {
                        "  (reporter is no longer a member or runner: not counted)"
                    }
                );
            }
            println!("  {url}");
        },
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// QW-038: every check-run write and runner key measured on bonsia (Platform 4.2.0-beta.7,
    /// 2026-09-30) is at or under its quote. The flat quotes it replaces were exceeded: a
    /// repository's first create paid 121.9M against 85M, an update with a summary 5.5M
    /// against 5M, and the runner key 43.0M against 35M.
    #[test]
    fn quotes_cover_what_bonsia_charged() {
        let report = |summary: Option<&str>, details: Option<&str>| CheckReport {
            head_oid: "ebd9aca21a24167d7b1f1544eca17ea2a9be6b4f".into(),
            name: "build".into(),
            status: "completed".into(),
            conclusion: Some("success".into()),
            details_url: details.map(str::to_string),
            summary: summary.map(str::to_string),
            ..CheckReport::default()
        };
        // (report, replaces, charged)
        let first = report(None, Some("https://ci.example.org/runs/42"));
        let lint = CheckReport {
            name: "lint".into(),
            ..report(Some("shellcheck: 1 warning"), None)
        };
        for (r, replaces, charged) in [
            (&first, false, 121_929_000),
            (&lint, false, 81_508_000),
            (&report(None, None), false, 95_093_000),
            (&report(None, None), true, 4_651_000),
            (&report(Some("2 tests passed"), None), true, 5_546_420),
        ] {
            let quote = report_estimate(r, replaces, false);
            assert!(quote >= charged, "{}: {quote} < {charged}", r.name);
        }
        const { assert!(forge_core::platform::identity_keys::ADD_KEY_ESTIMATE_CREDITS >= 43_008_000) };
        const { assert!(ENROL_ESTIMATE_CREDITS >= 47_298_000) };
    }

    /// The contract admits ~6 KB of text on a run: the quote grows with it, and a log adds its
    /// URL and hash.
    #[test]
    fn a_reports_text_and_log_are_priced() {
        let bare = CheckReport {
            name: "build".into(),
            ..CheckReport::default()
        };
        let big = CheckReport {
            summary: Some("x".repeat(1000)),
            artifacts: Some("y".repeat(4096)),
            ..bare.clone()
        };
        let extra = report_estimate(&big, false, false) - report_estimate(&bare, false, false);
        assert_eq!(extra, REPORT_PER_BYTE_CREDITS * 5096);
        assert_eq!(
            report_estimate(&bare, true, true) - report_estimate(&bare, true, false),
            REPORT_PER_BYTE_CREDITS * LOG_FIELDS_BYTES
        );
    }

    #[test]
    fn a_log_is_named_by_an_https_or_ipfs_url_only() {
        let uris = |u: &[&str]| u.iter().map(|s| (*s).to_string()).collect::<Vec<_>>();
        // https first (a browser reads it), then ipfs; never http or s3.
        assert_eq!(
            log_url(&uris(&[
                "s3://b/k",
                "ipfs://bafy1",
                "http://127.0.0.1:9000/b/k",
                "https://pub.example/b/k"
            ])),
            Some(&"https://pub.example/b/k".to_string())
        );
        assert_eq!(
            log_url(&uris(&["s3://b/k", "http://x/k", "ipfs://bafy1"])),
            Some(&"ipfs://bafy1".to_string())
        );
        assert_eq!(log_url(&uris(&["s3://b/k", "http://x/k"])), None);
    }

    #[test]
    fn only_storage_with_an_https_or_ipfs_address_can_hold_a_log() {
        let profile = |v: serde_json::Value| serde_json::from_value::<Profile>(v).unwrap();
        let s3 = |public: Option<&str>| {
            let mut v = json!({"kind": "s3", "endpoint": "https://s3.example", "bucket": "b"});
            if let Some(p) = public {
                v["public_url"] = json!(p);
            }
            profile(v)
        };
        assert!(gives_log_url(&s3(Some("https://pub-1.r2.dev"))));
        assert!(gives_log_url(&s3(Some("https://pub-1.r2.dev/"))));
        assert!(!gives_log_url(&s3(Some("http://127.0.0.1:9000/b"))));
        assert!(!gives_log_url(&s3(None)));
        assert!(gives_log_url(&profile(
            json!({"kind": "ipfs-kubo", "api": "http://127.0.0.1:5001"})
        )));
        assert!(!gives_log_url(&profile(json!({"kind": "platform"}))));
    }
}
