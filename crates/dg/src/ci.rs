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
    commit_web_url, is_log_url, CheckReport, CheckRuns, Reported, RunnerReader, RunnerService,
};
use forge_core::collab::ReleaseAsset;
use forge_core::keystore::{self, BridgeIdentity};
use forge_core::platform::identity::{DocTypeKeySpec, FreshKey, KeySpec};
use forge_core::rules::v2::Visibility;
use forge_core::storage::policy::git_config_scoped;
use forge_core::storage::{Profile, StoragePolicy, StorageProfiles};
use forge_core::user_error::{codes, UserError};

use crate::auth::{dash_to_credits, expiry_ms, parse_days};
use crate::common::{resolve_identity, Reader, Session};
use crate::context::Ctx;
use crate::fmt::{cost_json, cost_line, credits_to_dash, dash_amount};

/// Runner key defaults (spec §2.2): 0.5 DASH for 365 days.
const RUNNER_KEY_BUDGET_DASH: f64 = 0.5;
const RUNNER_KEY_DAYS: u64 = 365;
/// Estimates (credits), upper bounds over what devnet bonsia charged on 2026-09-30 (Platform
/// 4.2.0-beta.7; docs/guides/ci.md "What it costs"): the runner key's identity update
/// (`ADD_KEY_ESTIMATE_CREDITS`, 43.0 M, paid by the runner), a `runner` document (47.3 M, paid
/// by the owner), a `checkRun` create (81.5–95.1 M; a repository's first, 121.9 M) and a
/// replace (4.7–5.5 M). A check run's text is priced on top ([`report_estimate`]): the contract
/// admits up to 6,716 bytes of it (a 1,000-character summary is up to 2,000 bytes; 4,096 bytes
/// of artifacts) plus 332 for a log, which no flat figure covers (QW-038: the flat 85 M and 5 M
/// were exceeded).
const ENROL_ESTIMATE_CREDITS: u64 = 55_000_000;
const CREATE_BASE_CREDITS: u64 = 130_000_000;
/// A replace re-serializes the whole stored run, whose text it may not carry (a status-only
/// update of a run created with a full summary): the ~7 KB the contract admits, reprocessed at
/// ~412 credits/B (drive's replaced-bytes rate), is ~2.9 M on top of the 4.7 M measured.
const REPLACE_BASE_CREDITS: u64 = 8_000_000;
/// What each byte of a check run's text adds (the storage, its processing, the replaced bytes),
/// at the per-byte rate forge-core measured for chunk documents (27,450-27,650, priced 27,700).
const REPORT_PER_BYTE_CREDITS: u64 = forge_core::cost::push_fees::CHUNK_PER_BYTE;
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
        /// The commit: a full id, or inside a clone anything `git rev-parse` takes (`HEAD`, a
        /// branch, an abbreviated id). Default: the clone's `HEAD`. `--sha` works too, as in
        /// `dg ci report`.
        #[arg(conflicts_with = "sha_flag")]
        sha: Option<String>,
        /// The commit, as `dg ci report` takes it.
        #[arg(long = "sha", alias = "head", value_name = "SHA")]
        sha_flag: Option<String>,
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
    /// your own identity (no enrolment needed: the owner is a maintainer). A sealed file's
    /// passphrase is read from DASH_FORGE_RUNNER_PASSPHRASE (then DASH_FORGE_PASSPHRASE), or
    /// asked for in a terminal.
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
    /// The commit the check ran on: a full id (40 or 64 hex digits), or inside a clone
    /// anything `git rev-parse` takes (`HEAD`, a branch, an abbreviated id).
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
    /// Upload this file as an artifact of the run (repeatable, at most 10): content-addressed to
    /// your storage like the log, and recorded with its SHA-256, size and URL in the run's
    /// `artifacts` (the shape of a release's assets), which fits about a dozen. Not uploaded on
    /// a private repository.
    #[arg(long = "artifact", value_name = "FILE")]
    pub artifacts: Vec<PathBuf>,
    /// The storage profile(s) for --log and --artifact (default: the repository's
    /// dash.storage).
    #[arg(long)]
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
        CiCommand::Status {
            repo,
            sha,
            sha_flag,
        } => {
            // `dg ci status HEAD` (or `61a02cb`) inside a clone: the one positional is the
            // commit, not a repository called HEAD (QW3-026).
            let given = sha.as_deref().or(sha_flag.as_deref());
            let (repo, given) = status_target(repo, given, crate::storage::clone_repo())?;
            status(ctx, &repo, &resolve_commit(&repo, given.as_deref())?).await
        }
    }
}

/// The identity whose master key registers the runner key: `--runner <file>`, else your own.
fn key_holder(ctx: &Ctx, args: &RunnerNewArgs, me: &str) -> Result<BridgeIdentity> {
    let Some(file) = &args.runner else {
        return crate::auth::master_identity(ctx, args.master.as_deref(), me);
    };
    // Its own passphrase, when it is sealed with another than your key (QW2-022).
    let envs = [
        forge_core::sealed::RUNNER_PASSPHRASE_ENV,
        forge_core::sealed::PASSPHRASE_ENV,
    ];
    let b = BridgeIdentity::load_from_file_with(file, &envs).with_context(|| {
        format!(
            "loading the runner identity from {}",
            keystore::describe_key_source(file)
        )
    })?;
    if b.master_key().is_none() {
        return Err(crate::errors::usage(format!(
            "{} has no master key; registering the runner key needs the runner identity's master key once",
            keystore::describe_key_source(file)
        )));
    }
    Ok(b)
}

#[allow(clippy::too_many_lines)] // one linear flow: key, enrolment, report
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
    // A runner that is enrolled already needs only its key: no enrolment is quoted, written,
    // or claimed (QW2-084).
    let enrolled = if holder.identity_id == s.identity.id() {
        None
    } else {
        RunnerReader::new(&s.client)
            .get(&s.repo, &holder.identity_id)
            .await?
    };
    let enrol = holder.identity_id != s.identity.id() && enrolled.is_none();
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
    explain_runner_key(
        ctx,
        &s,
        &holder.identity_id,
        &spec,
        days,
        enrol,
        enrolled.is_some(),
    );
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
            "alreadyEnrolled": enrolled.as_ref().map(|m| m.document_id.clone()),
            "keyCost": cost_json(key_spent, ctx.usd_price()),
            "enrolCost": cost_json(enrol_spent, ctx.usd_price()),
        }),
        || {
            println!(
                "✓ runner key #{key_id} on {} written to {} (0600, UNENCRYPTED)",
                holder.identity_id,
                args.output.display()
            );
            println!("  the key cost {}", cost_line(key_spent, ctx.usd_price()));
            if membership.is_some() {
                // A balance read that has not moved yet is not a free write (QW-083: it read
                // "(~0 DASH)").
                let cost = if enrol_spent == 0 {
                    "its cost is not visible in the balance yet".to_string()
                } else {
                    cost_line(enrol_spent, ctx.usd_price())
                };
                println!("✓ enrolled as a runner of {} ({cost})", s.repo.display());
            }
            if let Some(m) = &enrolled {
                println!(
                    "✓ already a runner of {} (membership {}); no enrolment written",
                    s.repo.display(),
                    m.document_id
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
    already_enrolled: bool,
) {
    if ctx.json {
        return;
    }
    let price = ctx.usd_price();
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
    } else if already_enrolled {
        eprintln!(
            "  {holder} is already a runner of {}: no enrolment is written",
            s.repo.display()
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
    let runner = s.client.fetch_signer(holder).await?;
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
    // Enrolled already: nothing to quote or write (the enrolment is idempotent, and said "is a
    // runner" as if it had just been written, QW2-084).
    if let Some(m) = RunnerReader::new(&s.client).get(&s.repo, runner).await? {
        ctx.emit(
            json!({ "status": "exists", "runner": runner, "documentId": m.document_id, "id": m.document_id, "written": false }),
            || println!("{runner} is already a runner of {}; nothing written", s.repo.display()),
        );
        return Ok(());
    }
    ctx.confirm_or_cancel(&format!(
        "Enrol {runner} as a runner of {}? ({})",
        s.repo.display(),
        cost_line(ENROL_ESTIMATE_CREDITS, ctx.usd_price())
    ))?;
    let before = s.balance().await;
    let m = RunnerService::new(&s.client, &s.identity, &s.bridge)
        .enrol(&s.repo, runner)
        .await?;
    let spent = s.spent_since(before).await;
    ctx.emit(
        json!({ "status": "enrolled", "runner": runner, "documentId": m.document_id, "id": m.document_id, "cost": cost_json(spent, ctx.usd_price()) }),
        || println!("✓ {runner} is a runner of {} ({})", s.repo.display(), cost_line(spent, ctx.usd_price())),
    );
    Ok(())
}

async fn runner_list(ctx: &Ctx, repo: &str) -> Result<()> {
    let r = Reader::open(ctx, repo).await?;
    let runners = RunnerReader::new(&r.client).list(&r.repo).await?;
    ctx.emit(
        json!({ "count": runners.len(), "runners": crate::fmt::with_ids(&runners) }),
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

/// Refuse, before anything is uploaded: no storage of your own at all (a Platform-only
/// repository and no `--storage`), or storage none of whose profiles records an https or IPFS
/// address (a plain-http or private bucket), where the check run could not name the log.
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
    if policy.external.is_empty() {
        return Err(no_log_storage(storage.is_some()));
    }
    if policy.external.iter().any(|(_, p)| gives_log_url(p)) {
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

/// E501 for `--log` / `--artifact` with no storage of your own: they are uploaded there, never
/// to Platform. Before, this was the release command's "release not created: no storage for
/// the assets" (QW2-077).
fn no_log_storage(storage_given: bool) -> anyhow::Error {
    let why = if storage_given {
        "the --storage given names no storage of your own (only Platform)"
    } else {
        "dash.storage names none (it is unset, or platform), and no --storage was given"
    };
    UserError::new(
        codes::STORAGE_CONFIG,
        "check run not reported: --log and --artifact need your own storage",
    )
    .cause(format!(
        "a check run's log and artifacts are uploaded to your own storage (an S3 bucket with an https public_url, or IPFS) and the run records their URL; {why}"
    ))
    .fix("pass --storage <profile> (`dg storage list` shows yours; `dg storage add <name> …` adds one)")
    .fix("or report the run without --log / --artifact")
    .note("nothing was uploaded or written")
    .into()
}

/// The log's https (else `ipfs://`) URL and its SHA-256, after uploading it to `storage`.
async fn upload_log(path: &Path, storage: Option<&str>) -> Result<(String, [u8; 32])> {
    let (targets, required) = crate::release::asset_targets(storage, "check run not reported")?;
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
            if a.log.is_some() || !a.artifacts.is_empty() {
                " (nothing is uploaded)"
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
        head_oid: resolve_commit(&a.repo, Some(&a.sha))?,
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
        forge_core::error::Error::Config(m) | forge_core::error::Error::InvalidInput(m) => {
            crate::errors::usage(m)
        }
        other => other.into(),
    };
    r.for_visibility(Visibility::Private)
        .0
        .validate()
        .map_err(usage)?;
    check_artifact_paths(&a.artifacts)?;
    let s = Session::open_for_write(ctx, &a.repo, "check run not reported").await?;
    let private = s.repo.visibility == Visibility::Private;
    let (kept, mut left_out) = r.for_visibility(s.repo.visibility);
    kept.validate().map_err(usage)?;
    if private {
        if a.log.is_some() {
            left_out.push("logUrl");
        }
        if !a.artifacts.is_empty() {
            left_out.push("artifacts");
        }
    } else if a.log.is_some() || !a.artifacts.is_empty() {
        check_log_storage(a.storage.as_deref())?;
    }
    warn_private(a, &s, &left_out);
    // A check the branch policy pins to another source still records, but never counts toward
    // the policy (QW2-086): say so before anything is paid.
    let not_counted = pinned_elsewhere(&s, &r.name).await;
    if let Some(note) = &not_counted {
        // stderr, JSON mode too (as `warn_private`): before the prompt and the payment.
        eprintln!("warning: {note}");
    }
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
        cost_line(estimate, ctx.usd_price())
    ))?;
    if let Some(p) = a.log.as_ref().filter(|_| !private) {
        r.log = Some(upload_log(p, a.storage.as_deref()).await?);
    }
    let mut artifacts_left_out = Vec::new();
    if !private && !a.artifacts.is_empty() {
        (r.artifacts, artifacts_left_out) =
            upload_artifacts(&a.artifacts, a.storage.as_deref()).await?;
    }
    let before = s.balance().await;
    let done = runs.execute(&s.repo, &r, plan).await?;
    let spent = if done.action == "unchanged" {
        0
    } else {
        s.spent_since(before).await
    };
    let url = commit_web_url(&s.repo, &r.head_oid);
    emit_report(
        ctx,
        &r,
        &done,
        &Outcome {
            spent,
            url: &url,
            left_out: &left_out,
            artifacts_left_out: &artifacts_left_out,
            not_counted: not_counted.as_deref(),
        },
    );
    Ok(())
}

/// Why a run of check `name` reported by this signer will not count toward the branch policy:
/// the policy pins `name` to other sources (`requiredCheckSources`). `None` when it counts, or
/// the policy cannot be read (a warning is never a reason to fail the report).
async fn pinned_elsewhere(s: &Session, name: &str) -> Option<String> {
    let policy = s.collab().policy(&s.repo).await.ok()??;
    let me = s.identity.id();
    pinned_note(&policy, name, &me)
}

/// [`pinned_elsewhere`]'s rule on a read policy.
fn pinned_note(policy: &forge_core::rules::review::Policy, name: &str, me: &str) -> Option<String> {
    let rules = policy.checks_policy();
    let pins = forge_core::rules::parity::pinned_sources(&rules);
    let sources = pins.get(name)?;
    if sources.contains(me) {
        return None;
    }
    Some(format!(
        "the branch policy requires `{}` from {}, so a run you report is shown but never counts toward it (the merge box and `dg pr merge` judge only that source's runs)",
        crate::fmt::safe(name),
        sources.iter().copied().collect::<Vec<_>>().join(" or ")
    ))
}

/// What a report did beyond the write itself, for [`emit_report`].
struct Outcome<'a> {
    spent: u64,
    url: &'a str,
    left_out: &'a [&'a str],
    artifacts_left_out: &'a [String],
    /// [`pinned_elsewhere`]: the run will not count toward the branch policy.
    not_counted: Option<&'a str>,
}

/// Print what `dg ci report` did: the write, and what the run carries.
fn emit_report(ctx: &Ctx, r: &CheckReport, done: &Reported, o: &Outcome<'_>) {
    let Outcome {
        spent,
        url,
        left_out,
        artifacts_left_out,
        not_counted,
    } = *o;
    // The `artifacts` JSON this report recorded, read back for the output.
    let artifacts: Vec<ReleaseAsset> = r
        .artifacts
        .as_deref()
        .and_then(|j| serde_json::from_str(j).ok())
        .unwrap_or_default();
    ctx.emit(
        json!({
            "status": done.action,
            "documentId": done.document_id,
            "id": done.document_id,
            "name": r.name,
            "checkStatus": r.status,
            "conclusion": r.conclusion,
            "headOid": r.head_oid,
            "logUrl": r.log.as_ref().map(|(u, _)| u.clone()),
            "logSha256": r.log.as_ref().map(|(_, h)| hex::encode(h)),
            "artifacts": artifacts,
            "artifactsLeftOut": artifacts_left_out,
            // What a private repository's run left out (forge-community `privateNoText`).
            "leftOut": left_out,
            "url": url,
            "cost": cost_json(spent, ctx.usd_price()),
            // Set when the policy pins this check to another source: the run never counts
            // toward it. `null` says only that no pin excludes it.
            "policyNote": not_counted,
        }),
        || {
            println!(
                "✓ {} {} ({}), {}",
                done.action,
                r.name,
                r.conclusion.as_deref().unwrap_or(&r.status),
                cost_line(spent, ctx.usd_price())
            );
            if let Some((u, _)) = &r.log {
                println!("  log: {u}");
            }
            for x in &artifacts {
                println!(
                    "  artifact: {} ({} bytes)",
                    crate::fmt::safe(&x.name),
                    x.size_bytes
                );
            }
            println!("  {url}");
        },
    );
}

/// The most artifacts one report takes: the run's `artifacts` field holds at most
/// [`ARTIFACTS_MAX_BYTES`], about a dozen entries.
const MAX_ARTIFACTS: usize = 10;

/// forge-community `checkRun.artifacts`: `maxBytes` 4096.
const ARTIFACTS_MAX_BYTES: usize = 4096;

/// Refuse, before anything is signed or uploaded, too many artifacts, or one that is not a
/// readable regular file.
fn check_artifact_paths(paths: &[PathBuf]) -> Result<()> {
    if paths.len() > MAX_ARTIFACTS {
        return Err(crate::errors::usage(format!(
            "{} artifacts; a report takes at most {MAX_ARTIFACTS} (the run's list holds \
             {ARTIFACTS_MAX_BYTES} bytes): archive them into fewer files",
            paths.len()
        )));
    }
    for p in paths {
        let meta = std::fs::metadata(p).with_context(|| format!("artifact {}", p.display()))?;
        if !meta.is_file() {
            return Err(crate::errors::usage(format!(
                "artifact {} is not a regular file",
                p.display()
            )));
        }
    }
    Ok(())
}

/// Upload each artifact to `storage` and list what fits the run's `artifacts` (a release's
/// assets shape: name, SHA-256, size, and the https, else `ipfs://`, URL a check run's log may
/// have). Returns the JSON (none when nothing fits) and the names that did not fit.
async fn upload_artifacts(
    paths: &[PathBuf],
    storage: Option<&str>,
) -> Result<(Option<String>, Vec<String>)> {
    let (targets, required) = crate::release::asset_targets(storage, "check run not reported")?;
    let mut uploaded = Vec::new();
    for p in paths {
        let (mut asset, _) = crate::release::upload_asset(p, &targets, required).await?;
        let url = log_url(&asset.uris).cloned().with_context(|| {
            format!(
                "artifact {}: the storage recorded no https or ipfs:// URL a check run can name",
                asset.name
            )
        })?;
        asset.uris = vec![url];
        uploaded.push(asset);
    }
    let (kept, dropped) = fit_artifacts(uploaded);
    if !dropped.is_empty() {
        eprintln!(
            "warning: {} did not fit the run's artifact list ({ARTIFACTS_MAX_BYTES} bytes) and {} \
             not recorded (uploaded, but no page links to {})",
            dropped.join(", "),
            if dropped.len() == 1 { "is" } else { "are" },
            if dropped.len() == 1 { "it" } else { "them" },
        );
    }
    let json = (!kept.is_empty())
        .then(|| serde_json::to_string(&kept))
        .transpose()?;
    Ok((json, dropped))
}

/// The artifacts, in order, whose JSON list fits [`ARTIFACTS_MAX_BYTES`], and the names of the
/// ones that did not (a later, smaller one may still fit).
fn fit_artifacts(assets: Vec<ReleaseAsset>) -> (Vec<ReleaseAsset>, Vec<String>) {
    let mut kept = Vec::new();
    let mut dropped = Vec::new();
    for a in assets {
        kept.push(a);
        if serde_json::to_string(&kept).map_or(true, |s| s.len() > ARTIFACTS_MAX_BYTES) {
            if let Some(x) = kept.pop() {
                dropped.push(x.name);
            }
        }
    }
    (kept, dropped)
}

/// Whether `repo` (as typed, or filled in from the clone) is the repository of the clone
/// `here` names: the same reference, or its bare name.
fn is_this_clone(repo: &str, here: &str) -> bool {
    let name = here.rsplit('/').next().unwrap_or(here);
    repo == here || (!repo.contains('/') && repo.eq_ignore_ascii_case(name))
}

/// The repository and commit `dg ci status <positional> [<sha>]` means (QW3-026); a commit
/// of `None` is the clone's `HEAD`.
///
/// * Both given: as typed.
/// * The clone's own repository (`dg ci status` alone fills it in): that repository, at its
///   `HEAD`.
/// * In a clone of `here`, a lone positional that does not name a repository is a commit of
///   the clone's repository: `dg ci status HEAD`, `dg ci status 61a02cb`, `dg ci status
///   feat/login`. One the clone does not have is named as such when it is resolved.
/// * Outside a clone, a lone commit id: E201 asking for the repository.
fn status_target(
    positional: &str,
    sha: Option<&str>,
    here: Option<String>,
) -> Result<(String, Option<String>)> {
    if let Some(sha) = sha {
        return Ok((positional.to_string(), Some(sha.to_string())));
    }
    match here {
        Some(here) if is_this_clone(positional, &here) => Ok((here, None)),
        Some(here) if !crate::infer::names_a_repo(positional, &here) => {
            Ok((here, Some(positional.to_string())))
        }
        None if crate::git::is_oid(positional) => Err(UserError::new(
            codes::USAGE,
            "which repository? outside a clone `dg ci status` needs it",
        )
        .fix(format!("`dg ci status <owner>/<name> {positional}`"))
        .into()),
        _ => Ok((positional.to_string(), None)),
    }
}

/// The current directory, where a clone's revisions resolve.
fn here() -> PathBuf {
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

/// The commit of `repo` that `given` names, as a full lower-case id (QW3-026); `None` is
/// `HEAD`. A full id is taken as it is. Anything else (`HEAD`, a branch, an abbreviated id)
/// is resolved by `git rev-parse` in the current directory, as `gh` and git do, but only when
/// that is a clone of `repo`: another repository's `HEAD` is not a commit of `repo`. Otherwise
/// an E201 says what to pass.
fn resolve_commit(repo: &str, given: Option<&str>) -> Result<String> {
    resolve_commit_in(
        &here(),
        crate::storage::clone_repo().as_deref(),
        repo,
        given,
    )
}

/// [`resolve_commit`] with the clone at `dir`, of the repository `here` (`None`: no clone).
fn resolve_commit_in(
    dir: &Path,
    here: Option<&str>,
    repo: &str,
    given: Option<&str>,
) -> Result<String> {
    let rev = given.map_or("HEAD", str::trim);
    if crate::git::is_oid(rev) {
        return Ok(rev.to_ascii_lowercase());
    }
    if !here.is_some_and(|h| is_this_clone(repo, h)) {
        let what = match given {
            None => format!("which commit of {repo}? none was given"),
            Some(_) => format!(
                "{rev:?} is not a full commit id, and this directory is not a clone of {repo}"
            ),
        };
        return Err(UserError::new(codes::USAGE, what)
            .fix(format!(
                "pass the commit's full id (40 hex digits), or run it inside a clone of {repo}: `HEAD`, a branch or an abbreviated id work there"
            ))
            .into());
    }
    let spec = format!("{rev}^{{commit}}");
    crate::git::git(dir, &["rev-parse", "--verify", "--quiet", &spec], &[])
        .ok()
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| crate::git::is_oid(s))
        .ok_or_else(|| {
            UserError::new(
                codes::USAGE,
                format!("{rev:?} is not a commit this clone has"),
            )
            .fix("pass the commit's full id (40 hex digits), or fetch it into this clone first")
            .into()
        })
}

async fn status(ctx: &Ctx, repo: &str, sha: &str) -> Result<()> {
    let r = Reader::open(ctx, repo).await?;
    let sha = sha.to_ascii_lowercase();
    let runs = r.collab().check_runs(&r.repo, &sha).await?;
    let url = commit_web_url(&r.repo, &sha);
    // The newest run per name is listed; when the branch policy pins that check to another
    // source, the run is shown but not counted (the merge judges only the pinned source's).
    let policy = if runs.is_empty() {
        None
    } else {
        r.collab().policy(&r.repo).await.ok().flatten()
    };
    let pinned_to = |c: &forge_core::collab::v2::CheckRun| -> Option<String> {
        let rules = policy.as_ref()?.checks_policy();
        let pins = forge_core::rules::parity::pinned_sources(&rules);
        let sources = pins.get(c.name.as_str())?;
        (!sources.contains(c.reporter.as_str()))
            .then(|| sources.iter().copied().collect::<Vec<_>>().join(" or "))
    };
    let rows: Vec<serde_json::Value> = runs
        .iter()
        .map(|c| {
            let mut v = serde_json::to_value(c).unwrap_or_default();
            if let (Some(o), Some(to)) = (v.as_object_mut(), pinned_to(c)) {
                o.insert("notCountedPinnedTo".into(), json!(to));
            }
            v
        })
        .collect();
    ctx.emit(
        json!({ "headOid": sha, "checks": crate::fmt::with_ids(&rows), "url": url }),
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
                let note = if !c.trusted {
                    "  (reporter is no longer a member or runner: not counted)".to_string()
                } else if let Some(to) = pinned_to(c) {
                    format!("  (not counted: the branch policy counts only runs by {to})")
                } else {
                    String::new()
                };
                println!("  {:<24} {state}{note}", crate::fmt::safe(&c.name));
                for x in &c.artifacts {
                    println!(
                        "    artifact {} ({} bytes, sha256 {})",
                        crate::fmt::safe(&x.name),
                        x.size_bytes,
                        crate::fmt::safe(x.sha256.get(..12).unwrap_or_default())
                    );
                }
            }
            println!("  {url}");
        },
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_git(dir: &Path, args: &[&str]) -> String {
        let out = std::process::Command::new("git")
            .current_dir(dir)
            .args(["-c", "user.name=t", "-c", "user.email=t@example.org"])
            .args([
                "-c",
                "commit.gpgsign=false",
                "-c",
                "init.defaultBranch=main",
            ])
            .args(args)
            .output()
            .expect("git");
        assert!(out.status.success(), "git {args:?}: {out:?}");
        String::from_utf8(out.stdout).unwrap().trim().to_owned()
    }

    /// QW3-026: in a clone, `dg ci status HEAD` / `<short id>` / `<branch>` read the clone's
    /// repository at that commit; the clone's own repository alone is its HEAD; another
    /// repository stays a repository.
    #[test]
    fn a_lone_commit_in_a_clone_is_the_commit_of_the_clones_repository() {
        const HERE: &str = "8hJmcHWTsdvkHyCrk4UgjbyugDAmE7QfuCTQXpXAc7nB/project";
        let here = || Some(HERE.to_string());
        let full = "556ec1132b8e0e216276d9154edb0d267f390e1d";
        for rev in ["HEAD", "61a02cb", "main", "feat/login", full, "nosuchrev"] {
            assert_eq!(
                status_target(rev, None, here()).unwrap(),
                (HERE.to_string(), Some(rev.to_string())),
                "{rev}"
            );
        }
        // the clone's own repository, however it is named: the clone's, at HEAD
        for repo in [HERE, "project", "Project"] {
            assert_eq!(
                status_target(repo, None, here()).unwrap(),
                (HERE.to_string(), None),
                "{repo}"
            );
        }
        // another repository: as typed (its commit is asked for when it is resolved)
        let other = "DYXPkp8gdKUjUzMUtGGjWGP2tP1dtrBPyDq3vLgu5Cx6/other";
        assert_eq!(
            status_target(other, None, here()).unwrap(),
            (other.to_string(), None)
        );
        // outside a clone, a lone commit id is not a repository
        let e = status_target(full, None, None).unwrap_err();
        let u = e.downcast_ref::<UserError>().unwrap();
        assert!(u.message.starts_with("which repository?"), "{u:?}");
        // both given: as typed
        assert_eq!(
            status_target(other, Some("HEAD"), here()).unwrap(),
            (other.to_string(), Some("HEAD".to_string()))
        );
    }

    /// QW3-026: `HEAD`, a branch and an abbreviated id resolve through the clone (as git and
    /// `gh` do), a full id is taken as it is, and anything else is an E201 saying what to pass;
    /// another repository's commit is never taken from this clone.
    #[test]
    fn a_commit_resolves_through_the_clone() {
        const HERE: &str = "8hJmcHWTsdvkHyCrk4UgjbyugDAmE7QfuCTQXpXAc7nB/project";
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        fixture_git(d, &["init", "-q"]);
        fixture_git(d, &["commit", "-q", "--allow-empty", "-m", "one"]);
        let head = fixture_git(d, &["rev-parse", "HEAD"]);
        let at = |given: Option<&str>| resolve_commit_in(d, Some(HERE), HERE, given);
        assert_eq!(at(None).unwrap(), head);
        assert_eq!(at(Some("HEAD")).unwrap(), head);
        assert_eq!(at(Some("main")).unwrap(), head);
        assert_eq!(at(Some(&head[..7])).unwrap(), head);
        let full = "61A02CB35170F0FAFCF5EE60C8E2606848EB85E2";
        assert_eq!(at(Some(full)).unwrap(), full.to_ascii_lowercase());
        for bad in ["nosuchbranch", "61a02cb"] {
            let e = at(Some(bad)).unwrap_err();
            let u = e.downcast_ref::<UserError>().unwrap();
            assert_eq!(u.code, "E201", "{u:?}");
            assert!(
                u.message.contains("is not a commit this clone has"),
                "{u:?}"
            );
        }
        // another repository, or no clone: only a full id
        for (here, given) in [
            (Some(HERE), Some("HEAD")),
            (None, None),
            (None, Some("main")),
        ] {
            let e = resolve_commit_in(d, here, "alice/other", given).unwrap_err();
            let u = e.downcast_ref::<UserError>().unwrap();
            assert_eq!(u.code, "E201", "{u:?}");
            assert!(u.fix[0].contains("full id"), "{u:?}");
        }
        assert_eq!(
            resolve_commit_in(d, None, "alice/other", Some(full)).unwrap(),
            full.to_ascii_lowercase()
        );
    }

    /// QW2-077:`--log` on a Platform-only repository names the flag and the fix, not the
    /// release command's "release not created".
    #[test]
    fn a_log_without_storage_says_it_needs_storage() {
        let e = no_log_storage(false);
        let u = e.downcast_ref::<UserError>().unwrap();
        assert_eq!((u.code, u.exit_code()), ("E501", 5));
        assert!(u.message.starts_with("check run not reported"), "{u:?}");
        assert!(!u.message.contains("release"), "{u:?}");
        assert!(
            u.cause
                .as_deref()
                .unwrap()
                .contains("no --storage was given"),
            "{u:?}"
        );
        assert!(u.fix[0].contains("--storage <profile>"), "{u:?}");
        let given = no_log_storage(true);
        let u = given.downcast_ref::<UserError>().unwrap();
        assert!(
            u.cause.as_deref().unwrap().contains("the --storage given"),
            "{u:?}"
        );
    }

    /// QW2-086: a report of a check the policy pins to another source says it will not count.
    #[test]
    fn a_check_pinned_to_another_source_is_noted() {
        let policy = forge_core::rules::review::Policy {
            require_checks: true,
            required_checks: vec!["build".into(), "lint".into()],
            required_check_sources: vec!["OWNER".into(), String::new()],
            ..Default::default()
        };
        let note = pinned_note(&policy, "build", "MEMBER").unwrap();
        assert!(note.contains("`build` from OWNER"), "{note}");
        assert!(note.contains("never counts"), "{note}");
        // the pinned source itself, an unpinned check, and a check the policy does not name
        assert_eq!(pinned_note(&policy, "build", "OWNER"), None);
        assert_eq!(pinned_note(&policy, "lint", "MEMBER"), None);
        assert_eq!(pinned_note(&policy, "e2e", "MEMBER"), None);
    }

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

    /// The contract admits ~7 KB of text on a run: the quote grows with it, and a log adds its
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

    fn asset(name: &str, url_len: usize) -> ReleaseAsset {
        ReleaseAsset {
            name: name.into(),
            sha256: "a".repeat(64),
            size_bytes: 10,
            uris: vec![format!("https://b.example/{}", "x".repeat(url_len))],
            uri: None,
        }
    }

    #[test]
    fn artifacts_are_recorded_while_the_list_fits_the_field() {
        let (kept, dropped) = fit_artifacts(vec![
            asset("a.zip", 100),
            asset("huge.zip", 4000),
            asset("b.zip", 100),
        ]);
        let names: Vec<_> = kept.iter().map(|a| a.name.as_str()).collect();
        assert_eq!(names, ["a.zip", "b.zip"], "a later, smaller one still fits");
        assert_eq!(dropped, ["huge.zip"]);
        let json = serde_json::to_string(&kept).unwrap();
        assert!(json.len() <= ARTIFACTS_MAX_BYTES);
        assert!(
            json.contains("\"sizeBytes\":10") && json.contains("\"uris\""),
            "the release assets' shape, which the web app reads: {json}"
        );
        assert!(fit_artifacts(Vec::new()).0.is_empty());
    }

    #[test]
    fn artifact_paths_are_checked_before_anything_is_signed() {
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join("a.zip");
        std::fs::write(&f, b"zip").unwrap();
        assert!(check_artifact_paths(std::slice::from_ref(&f)).is_ok());
        assert!(
            check_artifact_paths(&[d.path().to_path_buf()]).is_err(),
            "a directory"
        );
        assert!(check_artifact_paths(&[d.path().join("missing")]).is_err());
        assert!(
            check_artifact_paths(&vec![f; MAX_ARTIFACTS + 1]).is_err(),
            "too many"
        );
    }
}
