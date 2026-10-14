//! Publication dates for coordinated fixes (mixed-visibility DESIGN §4.7 "Embargo" and
//! "Release", D18; `forge_core::rules::embargo`, forge-v2.md §3.5).
//!
//! * `dg publish … --at <time> --issue N [--tag T]` ([`schedule`]) checks what would be
//!   published, then records the date and the plan on the members-only issue that tracks the fix
//!   (or the pull request): one member `event` of kind 28 whose value is sealed. Nothing is
//!   published.
//! * `dg embargo list` shows each date and its checklist; `dg embargo cancel` withdraws one.
//! * `dg embargo run` is the release bot: a member identity (Maintain access for a tag and
//!   release, or to make someone else's issue public; Write is enough otherwise) running in a
//!   clone. For each date that has come it checks everything first, then, in order, makes the
//!   tracking issue public, publishes the branch squashed into one new commit made now on the
//!   base as it is now, tags and releases it, and records the date done. Every step reads state
//!   first, so a run that stopped part way finishes when run again. `--wait` keeps it running
//!   until every waiting date is published (cron can run it without `--wait` instead).

use std::path::Path;

use anyhow::{Context as _, Result};
use serde_json::json;

use forge_core::collab::v2::{Collab, Target, TargetKind};
use forge_core::rules::embargo::{
    self, ChecklistItem, Embargo, EmbargoPlan, EmbargoState, EmbargoValue, Facts, Step,
};
use forge_core::rules::v2::Role;
use forge_core::scope::RepoRef;
use forge_core::user_error::{codes, UserError};

use crate::common::Session;
use crate::context::Ctx;
use crate::fmt::{cost_json, cost_line, safe, short};
use crate::publish_code::{PlanNames, PublishArgs};

/// `dg embargo` subcommands.
#[derive(Debug, clap::Subcommand)]
pub enum EmbargoCommand {
    /// List the repository's publication dates and their checklists (members).
    List {
        /// The repository (`owner/name`; default: this clone's).
        repo: Option<String>,
    },
    /// Withdraw a publication date: nothing is published at it.
    Cancel {
        /// The issue or pull request number that carries the date.
        number: u64,
        /// The repository (`owner/name`; default: this clone's).
        #[arg(long)]
        repo: Option<String>,
    },
    /// The release bot: publish every date that has come, in a clone of the repository.
    ///
    /// For each one it checks everything first, then makes the tracking issue public, publishes
    /// the branch (squashed into one new commit made now), tags and releases it, and records it
    /// done. Run it as a member with Maintain access (Write is enough without a tag, for your
    /// own issue), with --yes. Without --wait it publishes what is due and stops.
    Run {
        /// Keep running until every waiting date is published.
        #[arg(long)]
        wait: bool,
        /// With --wait: seconds between reads of the dates (a change or a cancellation is
        /// seen at the next one).
        #[arg(long, default_value_t = 60, value_name = "SECONDS")]
        poll: u64,
    },
}

/// `dg embargo`.
pub async fn run(ctx: &Ctx, cmd: &EmbargoCommand) -> Result<()> {
    match cmd {
        EmbargoCommand::List { repo } => list(ctx, &repo_arg(repo.as_deref())?).await,
        EmbargoCommand::Cancel { number, repo } => {
            cancel(ctx, &repo_arg(repo.as_deref())?, *number).await
        }
        EmbargoCommand::Run { wait, poll } => release_bot(ctx, *wait, *poll).await,
    }
}

/// The repository a command names, or this clone's.
fn repo_arg(repo: Option<&str>) -> Result<String> {
    repo.map(str::to_string)
        .or_else(crate::storage::clone_repo)
        .ok_or_else(|| {
            crate::errors::usage("name the repository (`owner/name`), or run it in a clone")
        })
}

// --- time ---------------------------------------------------------------------------------

/// Now, in Unix seconds.
pub(crate) fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

/// Days since 1970-01-01 for a Gregorian date (Howard Hinnant's `days_from_civil`).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn at_error(text: &str) -> anyhow::Error {
    UserError::new(codes::USAGE, format!("{} is not a time", safe(text)))
        .fix("give a time with its zone: --at 2026-10-20T14:00Z, --at '2026-10-20 14:00 UTC', --at 2026-10-20T16:00+02:00")
        .fix("or a time from now: --at +30m, +2h, +3d")
        .into()
}

/// `--at`'s time in Unix seconds: `+<n>m|h|d` from `now`, or a date and time with its zone
/// (`2026-10-20T14:00Z`, `2026-10-20 14:00:30 UTC`, `2026-10-20T16:00+02:00`). A time without
/// a zone is refused (whose 14:00?), as is one that is not in the future.
pub(crate) fn parse_at(text: &str, now: u64) -> Result<u64> {
    let t = text.trim();
    let at = if let Some(rel) = t.strip_prefix('+') {
        let (n, unit) = rel.split_at(rel.len().saturating_sub(1));
        let n: u64 = n.parse().map_err(|_| at_error(text))?;
        let secs = match unit {
            "m" => 60,
            "h" => 3600,
            "d" => 86_400,
            _ => return Err(at_error(text)),
        };
        n.checked_mul(secs)
            .and_then(|d| now.checked_add(d))
            .ok_or_else(|| at_error(text))?
    } else {
        absolute(t).ok_or_else(|| at_error(text))?
    };
    if at <= now {
        return Err(
            UserError::new(codes::USAGE, format!("{} is not in the future", when(at)))
                .fix("to publish now, leave out --at")
                .into(),
        );
    }
    Ok(at)
}

/// `YYYY-MM-DD[T ]HH:MM[:SS]` followed by `Z`, ` UTC` or `±HH:MM`, in Unix seconds.
fn absolute(t: &str) -> Option<u64> {
    let num = |s: &str| -> Option<i64> {
        (!s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))
            .then(|| s.parse().ok())
            .flatten()
    };
    let b = t.as_bytes();
    if b.len() < 16
        || b[4] != b'-'
        || b[7] != b'-'
        || !matches!(b[10], b'T' | b' ')
        || b[13] != b':'
    {
        return None;
    }
    let (y, mo, d) = (num(&t[0..4])?, num(&t[5..7])?, num(&t[8..10])?);
    let (h, mi) = (num(&t[11..13])?, num(&t[14..16])?);
    let mut rest = &t[16..];
    let mut s = 0;
    if let Some(r) = rest.strip_prefix(':') {
        s = num(r.get(0..2)?)?;
        rest = &r[2..];
    }
    let offset = match rest.trim_start() {
        "Z" | "UTC" => 0,
        z if (z.starts_with('+') || z.starts_with('-')) && z.len() == 6 && &z[3..4] == ":" => {
            let sign = if z.starts_with('-') { -1 } else { 1 };
            sign * (num(&z[1..3])? * 3600 + num(&z[4..6])? * 60)
        }
        _ => return None,
    };
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || s > 59 {
        return None;
    }
    let secs = days_from_civil(y, mo, d) * 86_400 + h * 3600 + mi * 60 + s - offset;
    u64::try_from(secs).ok()
}

/// `at` (Unix seconds) as people read it: `2026-10-20 14:00 UTC`.
pub(crate) fn when(at: u64) -> String {
    let full = crate::cost::format_utc(at.saturating_mul(1000));
    let full = full.strip_suffix(":00").unwrap_or(&full);
    format!("{full} UTC")
}

/// How far `at` is from `now`: "in 3 days", "in 2 hours", "5 minutes ago".
fn relative(at: u64, now: u64) -> String {
    let (d, future) = if at >= now {
        (at - now, true)
    } else {
        (now - at, false)
    };
    let span = match d {
        0..=59 => {
            return if future {
                "now".into()
            } else {
                "just now".into()
            }
        }
        60..=3599 => crate::fmt::plural(d / 60, "minute"),
        3600..=86_399 => crate::fmt::plural(d / 3600, "hour"),
        _ => crate::fmt::plural(d / 86_400, "day"),
    };
    if future {
        format!("in {span}")
    } else {
        format!("{span} ago")
    }
}

// --- reading -------------------------------------------------------------------------------

/// The repository's embargoes from its counted records.
async fn read_embargoes(collab: &Collab<'_>, repo: &RepoRef) -> Result<Vec<Embargo>> {
    let records: Vec<_> = collab
        .embargo_records(repo)
        .await?
        .into_iter()
        .filter_map(|(r, counts)| counts.then_some(r))
        .collect();
    Ok(embargo::embargoes(&records))
}

/// Issue or pull request `number` as a target, and whether it is an issue.
async fn target_of(collab: &Collab<'_>, repo: &RepoRef, number: u32) -> Result<Target> {
    for kind in [TargetKind::Issue, TargetKind::Patch] {
        if let Some(t) = collab.target_read(repo, kind, number).await? {
            return Ok(t.target(kind, number));
        }
    }
    Err(crate::errors::not_found(
        format!(
            "#{number} is not an issue or pull request of {}",
            repo.display()
        ),
        format!(
            "`dg embargo list {}` lists the publication dates",
            repo.display()
        ),
    ))
}

/// One checklist line, as people read it.
fn step_text(item: &ChecklistItem, plan: &EmbargoPlan) -> String {
    match &item.step {
        Step::MakePublic { issue } => format!("make #{issue} public"),
        Step::Publish => match (&plan.pr, &plan.branch, &plan.onto) {
            (Some(pr), _, _) => format!(
                "publish pull request #{pr}'s branch onto its base, squashed into one new commit, and record it merged"
            ),
            (None, Some(b), Some(o)) => format!(
                "publish {} onto {}, squashed into one new commit",
                safe(b),
                safe(o)
            ),
            _ => "publish the branch".to_string(),
        },
        Step::Tag { tag } => format!("tag {}", safe(tag)),
        Step::Release { tag } => format!("release {}", safe(tag)),
    }
}

/// The checklist's lines, numbered, ticked when done.
fn checklist_lines(e: &Embargo, items: &[ChecklistItem]) -> Vec<String> {
    items
        .iter()
        .enumerate()
        .map(|(i, it)| {
            format!(
                "  {} {}. {}",
                if it.done { "✓" } else { "·" },
                i + 1,
                step_text(it, &e.plan)
            )
        })
        .collect()
}

/// Who a release bot must be for `e`'s steps.
fn bot_needs(e: &Embargo) -> &'static str {
    if e.plan.tag.is_some() {
        "a member with Maintain access"
    } else {
        "a member with Write access or more (Maintain to make someone else's issue public or publish onto a protected branch)"
    }
}

// --- dg publish --at -------------------------------------------------------------------------

/// `dg publish … --at`: record the date and the plan (`names`: the branch and base the checks
/// just ran on; `view`: the pull request with `--pr`) on the tracking issue or the pull request,
/// after the publish's own checks passed. Nothing is published.
pub(crate) async fn schedule(
    ctx: &Ctx,
    s: &Session,
    fold: &forge_core::repo::MembersRefs,
    a: &PublishArgs,
    names: &PlanNames,
    at: u64,
    view: Option<&forge_core::collab::v2::PatchView>,
) -> Result<()> {
    let collab = s.collab();
    let target = match (a.issue, view) {
        (Some(n), _) => {
            let n = u32::try_from(n).map_err(|_| crate::errors::usage("no such issue"))?;
            collab
                .target_read(&s.repo, TargetKind::Issue, n)
                .await?
                .ok_or_else(|| {
                    crate::errors::not_found(
                        format!("issue #{n} not found in {}", s.repo.display()),
                        "--issue names the members-only issue that tracks the fix",
                    )
                })?
                .target(TargetKind::Issue, n)
        }
        (None, Some(v)) => v.patch.target(),
        (None, None) => return Err(crate::errors::usage(
            "--at records the date on the members-only issue that tracks the fix: pass --issue N",
        )),
    };
    let pr =
        a.pr.map(|n| u32::try_from(n).map_err(|_| crate::errors::usage("no such pull request")))
            .transpose()?;
    let plan = EmbargoPlan {
        at,
        pr,
        branch: pr.is_none().then(|| names.branch.clone()),
        onto: pr.is_none().then(|| names.base.clone()),
        tag: a.tag.clone(),
        message: a.message.clone(),
    };
    let value = EmbargoValue::Schedule(plan.clone());
    let text = value
        .encode()
        .map_err(|why| UserError::new(codes::USAGE, why).note("nothing was written"))?;
    if let Some(t) = &a.tag {
        if fold
            .get(&format!("refs/tags/{t}"))
            .is_some_and(|r| forge_core::rules::tip_of(&r.state).is_some())
        {
            return Err(UserError::new(
                codes::USAGE,
                format!("tag {} already exists in {}", safe(t), s.repo.display()),
            )
            .fix("name a new tag with --tag")
            .note("nothing was written")
            .into());
        }
    }
    if collab.target_reads_public(&s.repo, &target.id).await? {
        return Err(UserError::new(
            codes::USAGE,
            format!(
                "#{} is public, so its publication date would be public too",
                target.number
            ),
        )
        .cause("the date and what is published are kept members-only on the issue that tracks the fix")
        .fix(format!(
            "open a members-only issue for the fix (`dg issue create {} --members`) and pass --issue with its number",
            s.repo.display()
        ))
        .note("nothing was written")
        .into());
    }
    collab
        .require_role(
            &s.repo,
            Role::Writer,
            &format!("set a publication date on #{}", target.number),
        )
        .await?;
    let replaces = read_embargoes(&collab, &s.repo)
        .await?
        .into_iter()
        .find(|e| e.target_id == target.id && e.state == EmbargoState::Scheduled);
    let est = crate::quote::event(text.len() as u64 + 128, true);
    let replacing = replaces.as_ref().map_or(String::new(), |e| {
        format!(" It replaces the date set for {}.", when(e.plan.at))
    });
    ctx.confirm_or_cancel(&format!(
        "Publish it on {} ({}), recorded members-only on #{}?{replacing} (one event, {})",
        when(at),
        relative(at, now_secs()),
        target.number,
        cost_line(est, ctx.usd_price())
    ))?;
    let (id, spent) = s
        .metered(|| collab.set_embargo(&s.repo, &target, &value))
        .await?;
    let e = Embargo {
        target_id: target.id.clone(),
        number: target.number,
        plan: plan.clone(),
        set_by: collab.signer_id()?,
        set_at: 0,
        id: id.clone(),
        state: EmbargoState::Scheduled,
    };
    let items = embargo::checklist(&e, target.kind == TargetKind::Issue, &Facts::default());
    ctx.emit(
        json!({
            "status": "scheduled",
            "number": target.number,
            "at": at,
            "plan": plan,
            "checklist": items,
            "eventId": id,
            "cost": cost_json(spent, ctx.usd_price()),
        }),
        || {
            println!(
                "✓ publication date set on #{}: {} ({}) · {}",
                target.number,
                when(at),
                relative(at, now_secs()),
                cost_line(spent, ctx.usd_price())
            );
            println!("  Only members can read the date and what is published. At that time a release bot will:");
            for l in checklist_lines(&e, &items) {
                println!("{l}");
            }
            println!(
                "  The release bot is {} running `dg embargo run --wait --yes` in a clone of {}.",
                bot_needs(&e),
                s.repo.display()
            );
            println!(
                "  Change the date by running this again with another --at; withdraw it with `dg embargo cancel {}`.",
                target.number
            );
        },
    );
    Ok(())
}

// --- dg embargo list / cancel ----------------------------------------------------------------

/// What can be told cheaply of `e`'s steps: the issue public, the pull request merged, the tag
/// on Forge, its release live.
async fn facts_of(
    collab: &Collab<'_>,
    repo: &RepoRef,
    e: &Embargo,
    is_issue: bool,
    tags: &[String],
    released: &[String],
) -> Facts {
    let issue_public = if is_issue {
        collab.target_reads_public(repo, &e.target_id).await.ok()
    } else {
        None
    };
    let published = match e.plan.pr {
        Some(n) => match collab.patch(repo, n).await {
            Ok(Some(p)) => collab
                .patch_view(repo, p)
                .await
                .ok()
                .map(|v| v.state.merged),
            _ => None,
        },
        None => None,
    };
    let tag = e.plan.tag.as_deref();
    Facts {
        issue_public,
        published,
        tagged: tag.map(|t| tags.iter().any(|x| x == t)),
        released: tag.map(|t| released.iter().any(|x| x == t)),
    }
}

/// `dg embargo list`.
async fn list(ctx: &Ctx, repo: &str) -> Result<()> {
    let s = Session::open(ctx, repo).await?;
    let collab = s.collab();
    let fold = collab
        .members_refs(&s.repo)
        .await?
        .ok_or_else(|| crate::pr::members_key_needed(&s.repo, "read publication dates"))?;
    let all = read_embargoes(&collab, &s.repo).await?;
    let tags: Vec<String> = fold
        .refs
        .iter()
        .filter(|r| !r.members_only && forge_core::rules::tip_of(&r.state).is_some())
        .filter_map(|r| r.name.strip_prefix("refs/tags/").map(str::to_string))
        .collect();
    let released: Vec<String> = if all.iter().any(|e| e.plan.tag.is_some()) {
        collab
            .releases(&s.repo)
            .await?
            .current
            .into_iter()
            .map(|r| r.tag_name)
            .collect()
    } else {
        Vec::new()
    };
    let now = now_secs();
    let mut rows = Vec::new();
    for e in &all {
        let is_issue = collab
            .target_read(&s.repo, TargetKind::Issue, e.number)
            .await?
            .is_some_and(|t| t.target(TargetKind::Issue, e.number).id == e.target_id);
        let facts = facts_of(&collab, &s.repo, e, is_issue, &tags, &released).await;
        let items = embargo::checklist(e, is_issue, &facts);
        rows.push((e, items));
    }
    ctx.emit(
        json!(rows
            .iter()
            .map(|(e, items)| json!({
                "number": e.number,
                "at": e.plan.at,
                "due": e.due(now),
                "plan": e.plan,
                "setBy": e.set_by,
                "setAt": e.set_at,
                "state": e.state,
                "checklist": items,
            }))
            .collect::<Vec<_>>()),
        || {
            if rows.is_empty() {
                println!("No publication dates in {}.", s.repo.display());
            }
            for (e, items) in &rows {
                let state = match &e.state {
                    EmbargoState::Scheduled if e.due(now) => {
                        format!(
                            "due since {} ({})",
                            when(e.plan.at),
                            relative(e.plan.at, now)
                        )
                    }
                    EmbargoState::Scheduled => {
                        format!(
                            "publishes {} ({})",
                            when(e.plan.at),
                            relative(e.plan.at, now)
                        )
                    }
                    EmbargoState::Cancelled { by, .. } => format!(
                        "cancelled by {} (was {})",
                        crate::fmt::short_identity(by),
                        when(e.plan.at)
                    ),
                    EmbargoState::Done { commit, .. } => {
                        format!("published as {} ({})", short(commit), when(e.plan.at))
                    }
                };
                println!(
                    "#{} · {state} · set by {}",
                    e.number,
                    crate::fmt::short_identity(&e.set_by)
                );
                for l in checklist_lines(e, items) {
                    println!("{l}");
                }
            }
        },
    );
    Ok(())
}

/// `dg embargo cancel`.
async fn cancel(ctx: &Ctx, repo: &str, number: u64) -> Result<()> {
    let s = Session::open_for_write(ctx, repo, "nothing was written").await?;
    let collab = s.collab();
    let n = u32::try_from(number).map_err(|_| crate::errors::usage("no such issue"))?;
    let target = target_of(&collab, &s.repo, n).await?;
    let current = read_embargoes(&collab, &s.repo)
        .await?
        .into_iter()
        .find(|e| e.target_id == target.id && e.state == EmbargoState::Scheduled)
        .ok_or_else(|| {
            UserError::new(
                codes::NOT_FOUND,
                format!("#{n} has no publication date waiting"),
            )
            .fix(format!("`dg embargo list {repo}` lists them"))
        })?;
    let est = crate::quote::event(160, true);
    ctx.confirm_or_cancel(&format!(
        "Withdraw #{n}'s publication date ({})? Nothing is published then. (one event, {})",
        when(current.plan.at),
        cost_line(est, ctx.usd_price())
    ))?;
    let (id, spent) = s
        .metered(|| collab.set_embargo(&s.repo, &target, &EmbargoValue::Cancel))
        .await?;
    ctx.emit(
        json!({
            "status": "cancelled",
            "number": n,
            "eventId": id,
            "cost": cost_json(spent, ctx.usd_price()),
        }),
        || {
            println!(
                "✓ #{n}'s publication date ({}) withdrawn · {}",
                when(current.plan.at),
                cost_line(spent, ctx.usd_price())
            );
        },
    );
    Ok(())
}

// --- dg embargo run --------------------------------------------------------------------------

/// `dg embargo run [--wait]`: the release bot.
async fn release_bot(ctx: &Ctx, wait: bool, poll: u64) -> Result<()> {
    ctx.require_confirmable("dg embargo run")?;
    let cwd = std::env::current_dir().context("reading the current directory")?;
    let repo = crate::storage::clone_repo().ok_or_else(|| {
        crate::errors::usage(
            "run dg embargo run inside a clone of the repository (it publishes from the clone)",
        )
    })?;
    let remote = crate::storage::dash_remote_name().unwrap_or_else(|| "origin".into());
    let poll = poll.max(10);
    let mut failed: Option<anyhow::Error> = None;
    loop {
        let s = Session::open(ctx, &repo).await?;
        let all = read_embargoes(&s.collab(), &s.repo).await?;
        drop(s);
        let now = now_secs();
        let waiting: Vec<&Embargo> = all
            .iter()
            .filter(|e| e.state == EmbargoState::Scheduled)
            .collect();
        let due: Vec<&Embargo> = waiting.iter().copied().filter(|e| e.due(now)).collect();
        for e in &due {
            if !ctx.json {
                println!("#{} is due ({}): publishing", e.number, when(e.plan.at));
            }
            match publish_one(ctx, &repo, &cwd, &remote, e).await {
                Ok(commit) => ctx.emit(
                    json!({"status": "published", "number": e.number, "commit": commit}),
                    || println!("✓ #{} published as {}", e.number, short(&commit)),
                ),
                Err(err) => {
                    eprintln!("error: #{} was not published: {err:#}", e.number);
                    failed = Some(err);
                }
            }
        }
        let next = waiting
            .iter()
            .filter(|e| !e.due(now))
            .map(|e| e.plan.at)
            .min();
        if !wait {
            if due.is_empty() && !ctx.json {
                match next {
                    Some(at) => println!(
                        "Nothing is due in {repo}. Next: {} ({}).",
                        when(at),
                        relative(at, now)
                    ),
                    None => println!("No publication dates are waiting in {repo}."),
                }
            }
            return failed.map_or(Ok(()), Err);
        }
        if next.is_none() && (due.is_empty() || failed.is_none()) {
            if !ctx.json {
                println!("No publication dates are waiting in {repo}.");
            }
            return failed.map_or(Ok(()), Err);
        }
        failed = None;
        let sleep = next.map_or(poll, |at| at.saturating_sub(now_secs()).clamp(1, poll));
        if !ctx.json {
            if let Some(at) = next {
                println!(
                    "Waiting: next {} ({}); reading the dates again in {}s",
                    when(at),
                    relative(at, now_secs()),
                    sleep
                );
            }
        }
        tokio::time::sleep(std::time::Duration::from_secs(sleep)).await;
    }
}

/// Fetch the members-only `branch` from `remote` into this clone's branch of that name (the
/// release bot's clone mirrors Forge). A branch checked out here is left as it is.
fn fetch_branch(ctx: &Ctx, cwd: &Path, remote: &str, branch: &str) -> Result<()> {
    let env = crate::git::dash_env_signing(ctx)?;
    crate::git::git_dash(
        cwd,
        &["fetch", "-q", remote, &format!("refs/heads/{branch}")],
        &env,
    )
    .with_context(|| format!("fetching {branch} from {remote}"))?;
    if crate::git::current_branch(cwd).as_deref() == Some(branch) {
        return Ok(());
    }
    crate::git::git(
        cwd,
        &["update-ref", &format!("refs/heads/{branch}"), "FETCH_HEAD"],
        &[],
    )?;
    Ok(())
}

/// Publish one due embargo `e` from the clone `cwd`; the public commit.
async fn publish_one(
    ctx: &Ctx,
    repo: &str,
    cwd: &Path,
    remote: &str,
    e: &Embargo,
) -> Result<String> {
    let s = Session::open_for_write(ctx, repo, "nothing was published").await?;
    let collab = s.collab();
    let me = collab.signer_id()?;
    let role = collab.signer_role(&s.repo).await?;
    let target = target_of(&collab, &s.repo, e.number).await?;
    if target.id != e.target_id {
        anyhow::bail!("#{} is not the thread the date was set on", e.number);
    }
    let is_issue = target.kind == TargetKind::Issue;
    let issue_public = !is_issue || collab.target_reads_public(&s.repo, &target.id).await?;
    // 0. everything is checked before anything is written
    if !issue_public && target.author != me && role != Some(Role::Maintainer) {
        return Err(UserError::new(
            codes::NOT_A_WRITER,
            format!(
                "the release bot can't make #{} public: it was written by someone else",
                e.number
            ),
        )
        .fix("run the release bot as a member with Maintain access")
        .note("nothing was published")
        .into());
    }
    let tag = e.plan.tag.as_deref();
    if tag.is_some() && role != Some(Role::Maintainer) {
        return Err(UserError::new(
            codes::NOT_A_WRITER,
            "the release bot can't release: releases need Maintain access",
        )
        .fix("run the release bot as a member with Maintain access")
        .note("nothing was published")
        .into());
    }
    let mut args = PublishArgs {
        branch: e.plan.branch.clone(),
        onto: e.plan.onto.clone(),
        pr: e.plan.pr.map(u64::from),
        squash: true,
        history: false,
        message: e.plan.message.clone(),
        co_authors: false,
        make_public: false,
        at: None,
        issue: None,
        tag: None,
        check: true,
        release_bot: true,
    };
    let merged = match e.plan.pr {
        Some(n) => {
            let p = collab.patch(&s.repo, n).await?.ok_or_else(|| {
                crate::errors::not_found(format!("pull request #{n} not found"), "")
            })?;
            let view = collab.patch_view(&s.repo, p).await?;
            view.state.merged.then(|| view.merge_oid()).flatten()
        }
        None => {
            if let Some(b) = &e.plan.branch {
                fetch_branch(ctx, cwd, remote, b)?;
            }
            None
        }
    };
    // the publish's own checks (and, for a branch, whether a run before this one published it)
    let published = match merged {
        Some(c) => Some(c),
        None => crate::publish_code::publish(ctx, &args).await?.commit,
    };
    // 1. the tracking issue
    if !issue_public {
        crate::make_public::run(ctx, repo, &[e.number.to_string()], false, false).await?;
    }
    // 2. the code: a squash made now, on the base as it is now
    let commit = match published {
        Some(c) => c,
        None => {
            args.check = false;
            crate::publish_code::publish(ctx, &args)
                .await?
                .commit
                .ok_or_else(|| anyhow::anyhow!("the publish named no commit"))?
        }
    };
    // 3. and 4. the tag and its release
    if let Some(t) = tag {
        tag_and_release(
            ctx,
            &s,
            cwd,
            remote,
            repo,
            t,
            &commit,
            is_issue.then_some(e.number),
        )
        .await?;
    }
    // done: the completion closes the date for every member
    collab
        .set_embargo(
            &s.repo,
            &target,
            &EmbargoValue::Done {
                commit: commit.to_ascii_lowercase(),
            },
        )
        .await?;
    Ok(commit)
}

/// Tag `commit` as `tag` on Forge (unless it is already), then release it (unless it is).
#[allow(clippy::too_many_arguments)] // the session, the clone and the step's names
async fn tag_and_release(
    ctx: &Ctx,
    s: &Session,
    cwd: &Path,
    remote: &str,
    repo: &str,
    tag: &str,
    commit: &str,
    issue: Option<u32>,
) -> Result<()> {
    let collab = s.collab();
    collab.refs_changed();
    let fold = collab
        .members_refs(&s.repo)
        .await?
        .ok_or_else(|| crate::pr::members_key_needed(&s.repo, "tag the published commit"))?;
    let full = format!("refs/tags/{tag}");
    match fold
        .get(&full)
        .and_then(|r| forge_core::rules::tip_of(&r.state))
    {
        Some(at) if at.eq_ignore_ascii_case(commit) => {}
        Some(at) => {
            return Err(UserError::new(
                codes::USAGE,
                format!("tag {} already exists at {}", safe(tag), short(&at)),
            )
            .note(format!("the code is published as {}", short(commit)))
            .into())
        }
        None => {
            let argv = crate::pr::push_argv(ctx, remote, commit, &full);
            crate::pr::push_to(
                cwd,
                &argv,
                &crate::git::dash_env_signing(ctx)?,
                &format!("tag {tag} not pushed"),
            )?;
            if !ctx.json {
                println!("✓ tagged {} as {}", short(commit), safe(tag));
            }
        }
    }
    let released = collab
        .releases(&s.repo)
        .await?
        .current
        .iter()
        .any(|r| r.tag_name == tag);
    if !released {
        let notes = issue.map_or_else(String::new, |n| format!("See #{n}."));
        crate::release::run(
            ctx,
            &crate::ReleaseCommand::Create(Box::new(crate::ReleaseCreateArgs {
                repo: repo.to_string(),
                tag: tag.to_string(),
                name: tag.to_string(),
                notes,
                yanked: None,
                assets: Vec::new(),
                storage: None,
                draft: None,
                prerelease: None,
            })),
        )
        .await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: u64 = 1_792_000_000;

    #[test]
    fn times_need_a_zone_and_the_future() {
        assert_eq!(parse_at("+30m", NOW).unwrap(), NOW + 1800);
        assert_eq!(parse_at("+2h", NOW).unwrap(), NOW + 7200);
        assert_eq!(parse_at("+3d", NOW).unwrap(), NOW + 3 * 86_400);
        // 2026-10-20 14:00 UTC
        let t = 1_792_504_800;
        assert_eq!(parse_at("2026-10-20T14:00Z", NOW).unwrap(), t);
        assert_eq!(parse_at("2026-10-20 14:00 UTC", NOW).unwrap(), t);
        assert_eq!(parse_at("2026-10-20T14:00:00Z", NOW).unwrap(), t);
        assert_eq!(parse_at("2026-10-20T16:00+02:00", NOW).unwrap(), t);
        assert_eq!(parse_at("2026-10-20T09:00-05:00", NOW).unwrap(), t);
        for bad in [
            "2026-10-20T14:00",
            "2026-10-20",
            "tomorrow",
            "+5",
            "+5y",
            "2026-13-01T00:00Z",
            "2026-10-20T24:00Z",
        ] {
            assert!(parse_at(bad, NOW).is_err(), "{bad}");
        }
        assert!(parse_at("2020-01-01T00:00Z", NOW).is_err(), "the past");
    }

    #[test]
    fn times_print_in_utc() {
        assert_eq!(when(1_792_504_800), "2026-10-20 14:00 UTC");
        assert_eq!(relative(NOW + 7200, NOW), "in 2 hours");
        assert_eq!(relative(NOW - 3 * 86_400, NOW), "3 days ago");
    }
}
