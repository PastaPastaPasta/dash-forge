//! `dg bot` — what bots may do in a repository, and asking them to work on something
//! (mixed-visibility DESIGN §4.9, D33, §10 "Bots and runners"; `docs/security/private-repos.md`
//! §22).
//!
//! * `allow` writes the bot's **access notice** (kind 11, maintainers): what it may do, who may
//!   ask it, on which threads, which AI service processes what it is given, until when. Everyone
//!   reads it. `revoke` writes a newer one allowing nothing; `list` shows each bot's current
//!   access as everyone reads it.
//! * `ask` asks a bot to work on a pull request or issue: a public request (event kind 27; its
//!   task is members-only on a members-only thread) and, when the bot may read on request, a
//!   letter only it and you open, holding the thread's members-only posts as they are now (and,
//!   in a clone, a members-only pull request's code). Refused with E813 before anything is
//!   signed when the bot's access does not allow it.
//! * `jobs` and `read` are the bot's side: the requests addressed to it, and one request's
//!   thread as it was given it. Nothing written after the request is in it.

use std::path::{Path, PathBuf};

use anyhow::{Context as _, Result};
use clap::{Args, Subcommand, ValueEnum};
use serde_json::json;

use forge_core::collab::v2::{AskPlan, Collab, JobContent, NotShared, SharedCode, TargetKind};
use forge_core::private::access_notice::{
    self, AccessNotice, Askers, Threads, MAY_CI_MEMBERS_BRANCHES, MAY_POST, MAY_POST_MEMBERS_ONLY,
    MAY_READ_ON_REQUEST,
};
use forge_core::private::key_letter::ReadTarget;
use forge_core::private::DocKind;
use forge_core::rules::v2::{Role, Visibility};
use forge_core::scope::RepoRef;
use forge_core::user_error::{codes, UserError};

use crate::common::{resolve_identity, Session};
use crate::context::Ctx;
use crate::fmt::{cost_json, cost_line, safe};

/// `dg bot` subcommands.
#[derive(Debug, Subcommand)]
pub enum BotCommand {
    /// Give a bot access to a repository, or change it (maintainers): post comments and
    /// reviews, read the pull requests and issues it's asked about, run checks on members-only
    /// branches. Everyone can see a bot's access.
    Allow(Box<AllowArgs>),
    /// Take a bot's access away (maintainers). It gets nothing new from now on; what it was
    /// already given stays with it.
    Revoke {
        /// The repository (`owner/name`).
        repo: String,
        /// The bot: `@name`, a DPNS name or an identity id.
        bot: String,
    },
    /// Each bot's access to a repository, as everyone reads it.
    List {
        /// The repository (`owner/name`).
        repo: String,
    },
    /// Ask a bot to work on a pull request or issue. Everyone sees that you asked; only members
    /// see a members-only thread's task. The bot gets that thread's members-only posts (and, in
    /// a clone, its code) as they are now.
    Ask(Box<AskArgs>),
    /// The requests to a bot in a repository since a time: to you (as a bot), or to `--bot`.
    /// Everyone sees each request; a members-only thread's task only members and the bot.
    Jobs {
        /// The repository (`owner/name`).
        repo: String,
        /// Requests written at or after this time (ms since 1970). Default: the last day.
        #[arg(long, value_name = "MS")]
        since: Option<u64>,
        /// The bot whose requests to list (`@name`, a DPNS name or an identity id). Default: you.
        #[arg(long, value_name = "BOT")]
        bot: Option<String>,
    },
    /// As a bot: one request's thread as you were given it.
    Read {
        /// The repository (`owner/name`).
        repo: String,
        /// The request's id (`dg bot jobs` lists them).
        job: String,
        /// Write the members-only code you were given here, one git pack per file
        /// (`git index-pack` reads them).
        #[arg(long, value_name = "DIR", conflicts_with = "public")]
        code: Option<PathBuf>,
        /// Only what everyone can read: leave out anything members-only, even what you were
        /// given (a runner working on a request in public mode).
        #[arg(long)]
        public: bool,
    },
}

/// Who may ask a bot.
#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum AskersArg {
    /// People with Write or Maintain access, and the owner.
    Writers,
    /// Maintainers and the owner.
    Maintainers,
}

/// `dg bot allow`.
#[derive(Debug, Args)]
#[allow(clippy::struct_excessive_bools)] // independent clap flags
pub struct AllowArgs {
    /// The repository (`owner/name`).
    pub repo: String,
    /// The bot: `@name`, a DPNS name or an identity id.
    pub bot: String,
    /// Let it read the pull requests and issues it's asked about (members-only posts included).
    #[arg(long)]
    pub read: bool,
    /// Let it post members-only replies on threads it's asked about.
    #[arg(long)]
    pub members_only_replies: bool,
    /// Let it run checks on members-only branches.
    #[arg(long)]
    pub members_branches: bool,
    /// Don't let it post comments and reviews.
    #[arg(long)]
    pub no_post: bool,
    /// Who can ask it.
    #[arg(long, value_enum, default_value = "writers")]
    pub askers: AskersArg,
    /// Only these issues and pull requests, by number (`42,57`). Default: all of them.
    #[arg(long, value_delimiter = ',', value_name = "NUMBERS")]
    pub threads: Vec<u32>,
    /// The AI service that processes what it's given (shown to everyone and to whoever asks
    /// it).
    #[arg(long, value_name = "SERVICE")]
    pub processor: Option<String>,
    /// When its access ends (`YYYY-MM-DD`, UTC). Default: it doesn't.
    #[arg(long, value_name = "DATE")]
    pub until: Option<String>,
    /// A note everyone can read.
    #[arg(long, value_name = "TEXT", default_value = "")]
    pub note: String,
}

/// `dg bot ask`.
#[derive(Debug, Args)]
pub struct AskArgs {
    /// The repository (`owner/name`).
    pub repo: String,
    /// The bot: `@name`, a DPNS name or an identity id.
    pub bot: String,
    /// What to do (1 to 120 characters).
    pub task: String,
    /// The pull request.
    #[arg(
        long,
        value_name = "NUMBER",
        conflicts_with = "issue",
        required_unless_present = "issue"
    )]
    pub pr: Option<u32>,
    /// The issue.
    #[arg(long, value_name = "NUMBER")]
    pub issue: Option<u32>,
}

impl BotCommand {
    /// The error headline and the repo, for `errors::context_for`.
    pub fn context(&self) -> (&'static str, Option<&String>) {
        match self {
            BotCommand::Allow(a) => ("access not changed", Some(&a.repo)),
            BotCommand::Revoke { repo, .. } => ("access not changed", Some(repo)),
            BotCommand::List { repo } => ("could not read the bots' access", Some(repo)),
            BotCommand::Ask(a) => ("nothing was sent to the bot", Some(&a.repo)),
            BotCommand::Jobs { repo, .. } => ("could not read the requests", Some(repo)),
            BotCommand::Read { repo, .. } => ("could not read the request", Some(repo)),
        }
    }
}

/// Dispatch a `bot` subcommand.
pub async fn run(ctx: &Ctx, cmd: &BotCommand) -> Result<()> {
    match cmd {
        BotCommand::Allow(a) => allow(ctx, a).await,
        BotCommand::Revoke { repo, bot } => revoke(ctx, repo, bot).await,
        BotCommand::List { repo } => list(ctx, repo).await,
        BotCommand::Ask(a) => ask(ctx, a).await,
        BotCommand::Jobs { repo, since, bot } => jobs(ctx, repo, *since, bot.as_deref()).await,
        BotCommand::Read {
            repo,
            job,
            code,
            public,
        } => read(ctx, repo, job, code.as_deref(), *public).await,
    }
}

/// The abilities this version shows and sets; any other a notice lists is carried over untouched.
const KNOWN_MAY: [&str; 4] = [
    MAY_POST,
    MAY_POST_MEMBERS_ONLY,
    MAY_READ_ON_REQUEST,
    MAY_CI_MEMBERS_BRANCHES,
];

/// A notice's threads as the JSON output spells them: `"all"` or the numbers.
fn threads_json(threads: &Threads) -> serde_json::Value {
    match threads {
        Threads::All => json!("all"),
        Threads::Listed(ns) => json!(ns),
    }
}

/// `@name` for an identity: its DPNS name when it has one, else its id.
async fn handle(s: &Session, id: &str) -> String {
    s.client
        .dpns_first_names(vec![id])
        .await
        .get(id)
        .map_or_else(|| id.to_owned(), |n| format!("@{n}"))
}

/// `YYYY-MM-DD` as the last millisecond of that day (UTC): access lasts through the day named,
/// and the line everyone reads names that day.
fn parse_until(date: &str) -> Result<u64> {
    let bad = || crate::errors::usage(format!("--until {date:?}: give a date as YYYY-MM-DD"));
    let parts: Vec<&str> = date.split('-').collect();
    let [y, m, d] = parts.as_slice() else {
        return Err(bad());
    };
    let (y, m, d): (i64, i64, i64) = (
        y.parse().map_err(|_| bad())?,
        m.parse().map_err(|_| bad())?,
        d.parse().map_err(|_| bad())?,
    );
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    let days_in_month = match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return Err(bad()),
    };
    if !(1..=days_in_month).contains(&d) || !(1970..=9999).contains(&y) {
        return Err(bad());
    }
    // Howard Hinnant's days_from_civil
    let y2 = if m <= 2 { y - 1 } else { y };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    u64::try_from((days + 1) * 86_400_000 - 1).map_err(|_| bad())
}

/// Refuse, before anything is signed, access for someone who is already a member: members read
/// members-only content themselves, and access is for bots.
async fn require_not_a_member(s: &Session, bot: &str, name: &str) -> Result<()> {
    if bot == s.repo.owner_id() {
        return Err(crate::errors::usage(format!(
            "{} owns {}: access is for bots",
            safe(name),
            s.repo.display()
        )));
    }
    let role = forge_core::members::MemberReader::new(&s.client)
        .best_role(&s.repo, bot)
        .await?;
    match role {
        None | Some(Role::Bot) => Ok(()),
        Some(r) => Err(UserError::new(
            codes::USAGE,
            format!(
                "{} is a member of {} with {}: access is for bots",
                safe(name),
                s.repo.display(),
                forge_core::rules::agent_request::role_words(Some(r))
            ),
        )
        .note("nothing was written")
        .into()),
    }
}

/// Write `notice` after showing what everyone will read and asking.
async fn write_notice(
    ctx: &Ctx,
    s: &Session,
    notice: &AccessNotice,
    name: &str,
    status: &str,
    prompt: &str,
) -> Result<()> {
    let collab = s.collab();
    let line = access_notice::public_line(notice, name, forge_core::cache::now_ms());
    let copies: u64 = if s.repo.visibility == Visibility::Private {
        2
    } else {
        1
    };
    let est = copies * forge_core::env::service::snapshot_credits(512 + 600);
    if !ctx.json {
        eprintln!("Everyone will read: {}", safe(&line));
        eprintln!("  Cost: about {}", cost_line(est, ctx.usd_price()));
    }
    ctx.confirm_or_cancel(prompt)?;
    let ((ids, pack_hash), spent) = s
        .metered(|| collab.write_access_notice(&s.repo, notice))
        .await?;
    ctx.emit(
        json!({
            "status": status,
            "bot": forge_core::platform::encode_identifier(notice.bot),
            "may": notice.may,
            "askers": notice.askers,
            "threads": threads_json(&notice.threads),
            "processor": notice.processor,
            "until": notice.until,
            "line": line,
            "notice": ids,
            "packHash": hex::encode(pack_hash),
            "cost": cost_json(spent, ctx.usd_price()),
        }),
        || {
            println!("✓ {}", safe(&line));
            println!("  spent {}", cost_line(spent, ctx.usd_price()));
        },
    );
    Ok(())
}

/// Refuse, before anything is shown or signed, a notice the signer may not write or the bot
/// could not receive (a private repository's notice is also a letter to the bot; taking access
/// away still works without one: members stop honouring the old notice).
async fn require_notice_writable(s: &Session, bot: &str, name: &str, revoking: bool) -> Result<()> {
    let collab = s.collab();
    collab.require_notice_writer(&s.repo).await?;
    if !revoking
        && s.repo.visibility == Visibility::Private
        && !collab.has_encryption_key(&s.repo, bot).await?
    {
        return Err(UserError::new(
            codes::NO_ENCRYPTION_KEY,
            format!(
                "{} has no encryption key, so it can't be told its access to {}",
                safe(name),
                s.repo.display()
            ),
        )
        .fix("ask its operator to add one: `dg auth keys add --encryption`")
        .note("nothing was written")
        .into());
    }
    Ok(())
}

#[allow(clippy::too_many_lines)] // one pass: who, the access, the checks, the write
async fn allow(ctx: &Ctx, a: &AllowArgs) -> Result<()> {
    let s = Session::open_for_write(ctx, &a.repo, "access not changed").await?;
    let bot = resolve_identity(&s.client, &a.bot, "bot").await?;
    let name = handle(&s, &bot).await;
    require_not_a_member(&s, &bot, &name).await?;
    require_notice_writable(&s, &bot, &name, false).await?;
    let notices = s.collab().access_notices(&s.repo).await?;
    let previous = notices.for_bot(&bot);
    // abilities and fields this version does not know (a later push grant) are carried over,
    // so changing a bot's access here never suspends what another client gave it
    let mut may: Vec<String> = previous.map_or_else(Vec::new, |p| {
        p.notice
            .may
            .iter()
            .filter(|m| !KNOWN_MAY.contains(&m.as_str()))
            .cloned()
            .collect()
    });
    for (on, ability) in [
        (!a.no_post, MAY_POST),
        (a.members_only_replies, MAY_POST_MEMBERS_ONLY),
        (a.read, MAY_READ_ON_REQUEST),
        (a.members_branches, MAY_CI_MEMBERS_BRANCHES),
    ] {
        if on {
            may.push(ability.to_owned());
        }
    }
    may.sort();
    may.dedup();
    if may.is_empty() {
        return Err(crate::errors::usage(
            "that gives the bot nothing to do: to take its access away, run `dg bot revoke`",
        ));
    }
    let mut threads = a.threads.clone();
    threads.sort_unstable();
    threads.dedup();
    if threads.first() == Some(&0) || threads.len() > access_notice::THREADS_MAX {
        return Err(crate::errors::usage(format!(
            "--threads takes 1 to {} issue or pull request numbers",
            access_notice::THREADS_MAX
        )));
    }
    let until = a.until.as_deref().map(parse_until).transpose()?;
    if until.is_some_and(|u| u <= forge_core::cache::now_ms()) {
        return Err(crate::errors::usage("--until is in the past"));
    }
    let notice = AccessNotice {
        bot: forge_core::platform::decode_identifier(&bot)?,
        may,
        askers: match a.askers {
            AskersArg::Writers => Askers::Writers,
            AskersArg::Maintainers => Askers::Maintainers,
        },
        threads: if threads.is_empty() {
            Threads::All
        } else {
            Threads::Listed(threads)
        },
        processor: a
            .processor
            .as_deref()
            .map(str::trim)
            .filter(|p| !p.is_empty())
            .map(str::to_owned),
        until,
        revokes: previous.map(|p| vec![p.pack_hash]).unwrap_or_default(),
        note: a.note.clone(),
        extra: previous.map(|p| p.notice.extra.clone()).unwrap_or_default(),
    };
    if notice.to_typed().is_none() {
        return Err(crate::errors::usage(format!(
            "the service name is at most {} characters and the note at most {}, with no control characters",
            access_notice::PROCESSOR_MAX,
            access_notice::NOTE_MAX
        )));
    }
    if notice.may(MAY_READ_ON_REQUEST)
        && !s.collab().has_encryption_key(&s.repo, &bot).await?
        && !ctx.json
    {
        eprintln!(
            "note: {} has no encryption key yet, so it can't read what it's asked about until its operator adds one",
            safe(&name)
        );
    }
    let kept: Vec<&str> = notice
        .may
        .iter()
        .map(String::as_str)
        .filter(|m| !KNOWN_MAY.contains(m))
        .chain(notice.extra.keys().map(String::as_str))
        .collect();
    if !kept.is_empty() && !ctx.json {
        eprintln!(
            "Keeps access this version can't show: {}",
            safe(&kept.join(", "))
        );
    }
    let prompt = format!("Give {} this access to {}?", safe(&name), s.repo.display());
    write_notice(ctx, &s, &notice, &name, "allowed", &prompt).await?;
    if notice.may(MAY_POST_MEMBERS_ONLY) {
        send_post_key(ctx, &s, &bot).await?;
    }
    Ok(())
}

/// Send `bot` the post key of the current members key once its access allows members-only
/// replies (§23): only to a Bot row of a repository with members-only content, and only when
/// this signer has not sent it one for the current epoch already. Rotations and repairs keep
/// sending it while the access allows it.
async fn send_post_key(ctx: &Ctx, s: &Session, bot: &str) -> Result<()> {
    let signer = crate::keys::signer(s);
    let kr = signer.keyring(&s.repo).await?;
    let is_bot = forge_core::bot_keys::bots_of(kr.members(), &[])
        .iter()
        .any(|b| b == bot);
    let Some(keys) = kr.write_epoch_keys().filter(|_| is_bot) else {
        return Ok(());
    };
    let bots = vec![bot.to_owned()];
    let missing = Box::pin(forge_core::bot_keys::missing(&signer, &s.repo, keys, &bots)).await?;
    if missing.is_empty() {
        return Ok(());
    }
    let issued = Box::pin(forge_core::bot_keys::issue(
        &signer, &s.repo, keys, &missing,
    ))
    .await
    .context(
        "sending the bot its key for members-only replies (`dg repo keys repair` finishes it)",
    )?;
    if !ctx.json {
        crate::keys::print_post_keys(&s.repo, &issued);
    }
    Ok(())
}

async fn revoke(ctx: &Ctx, repo: &str, bot: &str) -> Result<()> {
    let s = Session::open_for_write(ctx, repo, "access not changed").await?;
    let bot = resolve_identity(&s.client, bot, "bot").await?;
    let name = handle(&s, &bot).await;
    require_notice_writable(&s, &bot, &name, true).await?;
    let notices = s.collab().access_notices(&s.repo).await?;
    let Some(previous) = notices.for_bot(&bot).filter(|p| !p.notice.may.is_empty()) else {
        return Err(UserError::new(
            codes::NOT_FOUND,
            format!("{} has no access to {}", safe(&name), s.repo.display()),
        )
        .note("nothing was written")
        .into());
    };
    let notice = AccessNotice {
        revokes: vec![previous.pack_hash],
        ..AccessNotice::empty(previous.notice.bot)
    };
    if !ctx.json {
        eprintln!(
            "{} gets nothing new from now on. What it was already given stays with it.",
            safe(&name)
        );
    }
    let prompt = format!("Stop {}'s access to {}?", safe(&name), s.repo.display());
    write_notice(ctx, &s, &notice, &name, "revoked", &prompt).await
}

async fn list(ctx: &Ctx, repo: &str) -> Result<()> {
    let s = Session::open(ctx, repo).await?;
    let notices = s.collab().access_notices(&s.repo).await?;
    let now = forge_core::cache::now_ms();
    let mut rows = Vec::new();
    for e in notices.current.values() {
        let id = forge_core::platform::encode_identifier(e.notice.bot);
        let name = handle(&s, &id).await;
        let writer = handle(&s, &e.writer).await;
        rows.push((id, name, writer, e));
    }
    ctx.emit(
        json!({
            "repo": s.repo.display(),
            "count": rows.len(),
            "unreadable": notices.unreadable,
            "bots": rows.iter().map(|(id, name, _, e)| json!({
                "bot": id,
                "may": e.notice.may,
                "askers": e.notice.askers,
                "threads": threads_json(&e.notice.threads),
                "processor": e.notice.processor,
                "until": e.notice.until,
                "live": e.notice.live_at(now) && !e.notice.may.is_empty(),
                "note": e.notice.note,
                "by": e.writer,
                "at": e.created_at,
                "line": access_notice::public_line(&e.notice, name, now),
                "notice": e.id,
            })).collect::<Vec<_>>(),
        }),
        || {
            if rows.is_empty() {
                println!("No bots yet. A bot can report checks, post comments and work on pull requests you ask it to. It only reads members-only content when someone asks it to work on that thread.");
            }
            for (_, name, writer, e) in &rows {
                println!("{}", safe(&access_notice::public_line(&e.notice, name, now)));
                if !e.notice.note.is_empty() {
                    println!("  {}", safe(&e.notice.note));
                }
                println!("  set by {}", safe(writer));
            }
            if notices.unreadable > 0 {
                eprintln!("note: {} access record(s) couldn't be read", notices.unreadable);
            }
        },
    );
    Ok(())
}

/// The members-only code of pull request `number` to hand on, when this is a clone of the
/// session's repository holding its members-only branch; else why not (`Err`: a line for the
/// asker).
async fn pr_code(ctx: &Ctx, s: &Session, number: u32) -> Result<Option<SharedCode>, String> {
    let collab = s.collab();
    let Ok(Some(patch)) = collab.patch(&s.repo, number).await else {
        return Ok(None);
    };
    if !patch.from_members_only_branch() {
        return Ok(None);
    }
    let Some(source) = patch.source_ref_name.clone() else {
        return Ok(None);
    };
    let full = crate::git::full_ref(&source);
    let short = forge_core::repo::short_branch_name(&full).to_owned();
    let not_here = || {
        format!(
            "its code isn't included: run this in a clone of {} that has {}",
            s.repo.display(),
            safe(&short)
        )
    };
    let Some(clone) = crate::storage::clone_repo() else {
        return Err(not_here());
    };
    let same = match crate::common::RepoRef::parse(&clone) {
        Ok(r) => crate::common::resolve(&s.client, &s.identity, &r)
            .await
            .is_ok_and(|r| r.id() == s.repo.id()),
        Err(_) => false,
    };
    if !same {
        return Err(not_here());
    }
    let cwd = std::env::current_dir().map_err(|_| not_here())?;
    let svc = forge_core::repo::RepoService::new(&s.client, &s.identity, &s.bridge);
    let kr = svc.keyring(&s.repo).await.map_err(|e| e.to_string())?;
    let snap = crate::branch_share::snapshot(ctx, s, &svc, &kr, &cwd, &full)
        .await
        .map_err(|e| format!("its code isn't included: {e:#}"))?;
    // the code handed on is the pull request's head, never a newer push to its branch
    if patch
        .real_head
        .as_deref()
        .is_none_or(|h| !h.eq_ignore_ascii_case(&snap.tip))
    {
        return Err(format!(
            "its code isn't included: {} has moved past the pull request's head; run `dg pr sync {} {number}` first",
            safe(&short),
            s.repo.display()
        ));
    }
    Ok(Some(SharedCode {
        branch: short,
        head: snap.letter.head,
        packs: snap.letter.packs,
        extra_commits: snap.extra_commits,
    }))
}

/// The confirmation the asker reads before signing (DESIGN §10, "Ask").
fn ask_summary(plan: &AskPlan, name: &str, code_note: Option<&str>) -> Vec<String> {
    let thread = format!("#{}", plan.target.number);
    let plural = |n: usize, one: &str| format!("{n} {one}{}", if n == 1 { "" } else { "s" });
    let mut out = Vec::new();
    match &plan.letter {
        Some(l) => {
            let comments = l.count(DocKind::Comment) + l.count(DocKind::Review);
            let own = l.count(DocKind::Patch) + l.count(DocKind::Issue) > 0;
            let mut what = Vec::new();
            if comments > 0 || !own {
                what.push(plural(comments, "comment"));
            }
            if let Some(c) = &l.code {
                what.push(format!("branch {}", safe(&c.branch)));
            }
            let things = match (l.code.is_some(), comments > 0 || !own) {
                (true, true) => "members-only comments and code",
                (true, false) => "members-only text and code",
                (false, _) if own && comments == 0 => "members-only text",
                (false, _) => "members-only comments",
            };
            out.push(if what.is_empty() {
                format!("{name} will get {thread}'s {things} as they are now.")
            } else {
                format!(
                    "{name} will get {thread}'s {things} as they are now ({}).",
                    what.join(", ")
                )
            });
            if let Some(c) = l.code.as_ref().filter(|c| c.extra_commits > 0) {
                out.push(format!(
                    "It also gets {} that aren't on {} (stored with its commits by another members-only branch or an earlier push).",
                    plural(c.extra_commits, "commit"),
                    safe(&c.branch)
                ));
            }
            if let Some(p) = &plan.processor {
                out.push(format!("{} processes them.", safe(p)));
            }
            out.push("It can't see anything added later unless you ask again.".into());
        }
        None if plan.members_only => {}
        None => {
            out.push(format!(
                "{name} will work on {thread} as everyone can read it."
            ));
            if let Some(p) = &plan.processor {
                out.push(format!("{} processes it.", safe(p)));
            }
        }
    }
    let count = |why: NotShared| plan.left_out.iter().filter(|(_, _, w)| *w == why).count();
    let letters = count(NotShared::Letter);
    if letters > 0 {
        out.push(format!(
            "{} to specific people {} included.",
            plural(letters, "message"),
            if letters == 1 { "isn't" } else { "aren't" }
        ));
    }
    let older = count(NotShared::Older);
    if older > 0 {
        out.push(format!(
            "Older items in this repo can't be shared one at a time ({older} left out)."
        ));
    }
    let unreadable = count(NotShared::Unreadable);
    if unreadable > 0 {
        out.push(format!(
            "{} you can't read {} included.",
            plural(unreadable, "members-only post"),
            if unreadable == 1 { "isn't" } else { "aren't" }
        ));
    }
    if plan.foreign {
        out.push(format!(
            "{thread} comes from a fork or from someone outside the members: {name} gets only what everyone can read."
        ));
    } else if !plan.reads {
        out.push(format!(
            "{name} isn't allowed to read members-only content here."
        ));
    }
    if let Some(n) = code_note {
        out.push(format!("Note: {n}."));
    }
    out.push(if plan.members_only {
        "Everyone can see that you asked; only members can see what you asked.".into()
    } else {
        "Everyone can see that you asked and what you asked.".into()
    });
    out
}

async fn ask(ctx: &Ctx, a: &AskArgs) -> Result<()> {
    let s = Session::open_for_write(ctx, &a.repo, "nothing was sent to the bot").await?;
    s.refuse_if_banned("nothing was sent to the bot").await?;
    let bot = resolve_identity(&s.client, &a.bot, "bot").await?;
    let name = handle(&s, &bot).await;
    let (kind, number) = match (a.pr, a.issue) {
        (Some(n), _) => (TargetKind::Patch, n),
        (None, Some(n)) => (TargetKind::Issue, n),
        (None, None) => return Err(crate::errors::usage("name the thread: --pr N or --issue N")),
    };
    let collab = s.collab();
    // the access is checked first; the members-only code is looked for only when the bot may
    // read it
    let plan = collab
        .plan_ask(&s.repo, kind, number, (&bot, &name), &a.task)
        .await?;
    let (plan, code_note) = if plan.reads && !plan.foreign && kind == TargetKind::Patch {
        match pr_code(ctx, &s, number).await {
            Ok(Some(code)) => (collab.plan_with_code(&s.repo, plan, code).await?, None),
            Ok(None) => (plan, None),
            Err(why) => (plan, Some(why)),
        }
    } else {
        (plan, None)
    };
    let letter_bytes = plan.letter.as_ref().map_or(0, |l| {
        128 + 140 * (l.docs.len() as u64 + 1)
            + 140 * l.bodies.len() as u64
            + l.code
                .as_ref()
                .map_or(0, |c| 140 * c.packs.len() as u64 + 200)
    });
    let est = crate::quote::event(a.task.len() as u64 + 61, true)
        + if letter_bytes > 0 {
            forge_core::env::service::snapshot_credits(letter_bytes.div_ceil(512) * 512 + 300)
        } else {
            0
        };
    if !ctx.json {
        for line in ask_summary(&plan, &name, code_note.as_deref()) {
            eprintln!("{line}");
        }
        eprintln!("Cost: about {}", cost_line(est, ctx.usd_price()));
    }
    ctx.confirm_or_cancel(&format!("Ask {} to work on #{number}?", safe(&name)))?;
    let (asked, spent) = s.metered(|| collab.write_ask(&s.repo, &plan)).await?;
    let thread = match kind {
        TargetKind::Patch => "pr",
        TargetKind::Issue => "issue",
    };
    let mut out = json!({
            "status": "asked",
            "bot": bot,
            "request": asked.event,
            "letter": asked.letter,
            "documents": plan.letter.as_ref().map_or(0, |l| l.docs.len()),
            "code": plan.letter.as_ref().and_then(|l| l.code.as_ref()).map(|c| c.branch.clone()),
            "membersOnly": plan.members_only,
            "cost": cost_json(spent, ctx.usd_price()),
    });
    out[thread] = json!(number);
    ctx.emit(out, || {
        println!("✓ asked {} to work on #{number}", safe(&name));
        println!("  request {}", asked.event);
        if asked.letter.is_some() {
            println!("  it got this thread's members-only content as it is now");
        }
        println!("  spent {}", cost_line(spent, ctx.usd_price()));
    });
    Ok(())
}

async fn jobs(ctx: &Ctx, repo: &str, since: Option<u64>, bot: Option<&str>) -> Result<()> {
    let s = Session::open(ctx, repo).await?;
    let collab = s.collab();
    let me = s.identity.id();
    let bot = match bot {
        Some(b) => resolve_identity(&s.client, b, "bot").await?,
        None => me.clone(),
    };
    let since = since.unwrap_or_else(|| forge_core::cache::now_ms().saturating_sub(86_400_000));
    let requests = collab.bot_requests(&s.repo, &bot, since).await?;
    // only the bot itself holds the letters addressed to it
    let letters = if requests.is_empty() || bot != me {
        Vec::new()
    } else {
        collab.read_letters(&s.repo).await?
    };
    let has_letter = |job: &str, asker: &str| {
        forge_core::platform::decode_identifier(job).is_ok_and(|j| {
            letters
                .iter()
                .any(|l| l.letter.job == j && l.sender == asker)
        })
    };
    ctx.emit(
        json!({
            "bot": bot,
            "since": since,
            "count": requests.len(),
            "requests": requests.iter().map(|(r, allowed)| json!({
                "id": r.id,
                "number": r.number,
                "asker": r.asker,
                "task": r.task,
                "at": r.created_at,
                "allowed": allowed,
                "letter": has_letter(&r.id, &r.asker),
            })).collect::<Vec<_>>(),
        }),
        || {
            if requests.is_empty() {
                println!("no requests to you since {since}");
            }
            for (r, allowed) in &requests {
                println!(
                    "{}  #{}  by {}  {}{}{}",
                    r.id,
                    r.number,
                    r.asker,
                    r.task.as_deref().map_or_else(
                        || "(the task is members-only)".to_owned(),
                        |t| format!("{:?}", safe(t))
                    ),
                    if has_letter(&r.id, &r.asker) {
                        "  [members-only content shared]"
                    } else {
                        ""
                    },
                    if *allowed {
                        ""
                    } else {
                        "  [outside the access the bot was given: not worked on]"
                    }
                );
            }
        },
    );
    Ok(())
}

/// Download each pack the letter hands on and open it with its file key into `dir`.
async fn write_code(
    s: &Session,
    letter: &forge_core::private::key_letter::ReadLetter,
    dir: &Path,
) -> Result<Vec<String>> {
    let svc = forge_core::repo::RepoService::new(&s.client, &s.identity, &s.bridge);
    let manifests = svc.read_pack_manifests(&s.repo).await?;
    let store = forge_core::storage::PackReader::from_user_config();
    std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    let mut written = Vec::new();
    for p in &letter.packs {
        let copies: Vec<_> = manifests
            .iter()
            .filter(|m| {
                m.pack_hash == p.pack_hash
                    && m.kind == u64::from(forge_core::pack::KIND_MEMBERS_GIT_PACK)
            })
            .collect();
        let mut plain = None;
        for &m in &copies {
            let Ok(sealed) = svc.fetch_artifact(&s.repo, m, &store).await else {
                continue;
            };
            if let Ok(b) =
                forge_core::private::pack::open_with_file_key(&sealed, m.size_bytes, &p.key)
            {
                plain = Some(b);
                break;
            }
        }
        // long bodies are read with the thread; only git packs are written here
        let Some(plain) = plain else {
            if !copies.is_empty() {
                eprintln!(
                    "note: pack {} could not be read from any copy; skipped",
                    hex::encode(p.pack_hash)
                );
            }
            continue;
        };
        let path = dir.join(format!("pack-{}.pack", hex::encode(p.pack_hash)));
        std::fs::write(&path, &plain).with_context(|| format!("writing {}", path.display()))?;
        written.push(path.display().to_string());
    }
    Ok(written)
}

#[allow(clippy::too_many_lines)] // the JSON and the human view of one job
async fn read(ctx: &Ctx, repo: &str, job: &str, code: Option<&Path>, public: bool) -> Result<()> {
    let s = Session::open(ctx, repo).await?;
    let read = s.collab().read_job_as(&s.repo, job, !public).await?;
    let packs = match (code, &read.letter) {
        (Some(dir), Some(l)) if !l.letter.packs.is_empty() => {
            write_code(&s, &l.letter, dir).await?
        }
        _ => Vec::new(),
    };
    let kind_word = |k: DocKind| match k {
        DocKind::Patch => "pull request",
        DocKind::Issue => "issue",
        DocKind::Review => "review",
        _ => "comment",
    };
    let posts: Vec<serde_json::Value> = read
        .posts
        .iter()
        .map(|p| {
            let (status, title, body) = match &p.content {
                JobContent::Text {
                    fields,
                    members_only,
                } => (
                    if *members_only {
                        "membersOnly"
                    } else {
                        "public"
                    },
                    fields.title.clone(),
                    fields.body.clone(),
                ),
                JobContent::NotShared => ("notShared", None, None),
                JobContent::After => ("after", None, None),
            };
            json!({
                "kind": kind_word(p.kind),
                "id": p.id,
                "author": p.author,
                "at": p.created_at,
                "status": status,
                "title": title,
                "body": body,
            })
        })
        .collect();
    let letter = read.letter.as_ref();
    let first_head = letter.and_then(|l| l.letter.heads.first());
    let pack_count = letter.map_or(0, |l| l.letter.packs.len());
    ctx.emit(
        json!({
            "request": read.request.id,
            "allowed": read.allowed,
            "number": read.request.number,
            "asker": read.request.asker,
            "task": read.request.task,
            "taskMembersOnly": read.task_members_only,
            "foreignPull": read.foreign_pull,
            "at": read.request.created_at,
            "letter": letter.map(|l| l.id.clone()),
            "asOf": letter.map(|l| l.letter.as_of),
            "head": first_head.map(|h| hex::encode(&h.oid)),
            "packs": pack_count,
            "packFiles": packs,
            "posts": posts,
        }),
        || {
            println!(
                "#{} asked by {}: {}",
                read.request.number,
                read.request.asker,
                read.request
                    .task
                    .as_deref()
                    .map_or_else(|| "(you weren't given the task)".to_owned(), |t| safe(t).to_string())
            );
            if !read.allowed {
                println!("this request is outside the access you were given: don't work on it");
            }
            match letter {
                Some(l) => println!(
                    "members-only content shared as of {} by {}",
                    forge_core::env::service::utc(l.letter.as_of),
                    l.sender
                ),
                None => println!("no members-only content was shared with you for this request"),
            }
            if let Some(h) = first_head {
                println!(
                    "code: head {} in {} pack(s){}",
                    hex::encode(&h.oid),
                    pack_count,
                    if packs.is_empty() {
                        String::new()
                    } else {
                        format!(", written to {}", packs.join(", "))
                    }
                );
            }
            for p in &read.posts {
                let head = format!("— {} {} by {}", kind_word(p.kind), p.id, p.author);
                match &p.content {
                    JobContent::Text {
                        fields,
                        members_only,
                    } => {
                        println!(
                            "{head}{}",
                            if *members_only { " (members-only)" } else { "" }
                        );
                        if let Some(t) = &fields.title {
                            println!("{}", safe(t));
                        }
                        if let Some(b) = &fields.body {
                            println!("{}", safe(b));
                        }
                    }
                    JobContent::NotShared => println!(
                        "{head}: members-only, not shared with you (written or changed after the request, or not included)"
                    ),
                    JobContent::After => {
                        println!("{head}: written after the request, not part of it");
                    }
                }
            }
        },
    );
    Ok(())
}

/// A reply on issue or pull request `target` of `repo` by a signer with the Bot role (§22.3,
/// §23): its `read` letter for the thread ([`Collab::reply_letter`]: the request `job`'s when
/// given, else the newest naming the thread) is given to `collab`, so the members-only posts it
/// lists open and the reply is written under the bot's post key, never needing the members key;
/// `Ok(true)`. A bot with no letter for the thread is refused before anything is signed (E311).
/// `Ok(false)` for anyone else, with or without `job`: a member reads with the members key, as
/// before.
pub(crate) async fn reply_letter(
    collab: &Collab<'_>,
    repo: &RepoRef,
    target: ReadTarget,
    job: Option<&str>,
) -> Result<bool> {
    if collab.cached_role(repo).await? != Some(Role::Bot) {
        return Ok(false);
    }
    if let Some(j) = job {
        crate::common::document_id_arg(j, "request id", "`dg bot jobs <owner>/<repo>`")?;
    }
    let Some(l) = collab.reply_letter(repo, target, job).await? else {
        return Err(forge_core::collab::v2::not_asked_here(repo, target, job).into());
    };
    collab.use_read_letter(repo, &l.letter)?;
    Ok(true)
}

/// A bot's `--reply-to` comment `reply` of thread `target` (document `target_id`) of `repo`: it
/// replies only to what it can read, a public comment or one its `read` letter lists (looked up
/// now, when `letter` is false and the comment is members-only), else it is refused before
/// anything is signed ([`comment_not_shared`]). Nothing is read for anyone but a bot.
pub(crate) async fn require_reply_shared(
    collab: &Collab<'_>,
    repo: &RepoRef,
    target: (ReadTarget, &str),
    reply: &str,
    letter: bool,
) -> Result<()> {
    if !letter && collab.cached_role(repo).await? != Some(Role::Bot) {
        return Ok(());
    }
    let (thread, target_id) = target;
    let unopened = || async {
        let (_, sealed, _) = collab.comments_read(repo, target_id).await?;
        Ok::<bool, anyhow::Error>(sealed.iter().any(|m| m.document_id == reply))
    };
    if !unopened().await? {
        return Ok(());
    }
    if !letter && reply_letter(collab, repo, thread, None).await? && !unopened().await? {
        return Ok(());
    }
    Err(comment_not_shared(reply))
}

/// A bot's `--reply-to` a members-only comment its `read` letter does not open: written or
/// edited after it was asked, or not shared with it.
pub(crate) fn comment_not_shared(comment: &str) -> anyhow::Error {
    UserError::new(
        codes::NO_KEY_SHARED,
        format!(
            "comment {} hasn't been shared with you",
            safe(comment)
        ),
    )
    .cause("it is members-only, and it was written or changed after you were asked, or left out of what was shared")
    .fix("reply to the conversation itself (without --reply-to)")
    .fix("or have someone with Write access ask you again: that shares what is there now")
    .note("checked before anything was signed; nothing was written or paid")
    .into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn until_is_the_last_moment_of_the_day_named() {
        // 2026-01-01 00:00 UTC is 1767225600000; 2025-12-31 ends just before it
        let until = parse_until("2025-12-31").unwrap();
        assert_eq!(until, 1_767_225_599_999);
        assert_eq!(access_notice::date_words(until), "31 Dec 2025");
        assert_eq!(parse_until("2028-02-29").unwrap() % 86_400_000, 86_399_999);
        assert!(parse_until("2026-02-29").is_err());
        assert!(parse_until("2026-04-31").is_err());
        assert!(parse_until("2025-13-01").is_err());
        assert!(parse_until("tomorrow").is_err());
    }

    /// A bot's reply to a members-only comment its request did not share is refused before
    /// signing, as E311, in plain words.
    #[test]
    fn a_bots_reply_to_a_comment_not_shared_is_refused_in_plain_words() {
        let e = comment_not_shared("C1");
        let u = e.downcast_ref::<UserError>().expect("a user error");
        assert_eq!(u.code, codes::NO_KEY_SHARED);
        let all = format!("{u} {}", u.fix.join(" ")).to_lowercase();
        assert!(all.contains("c1") && all.contains("--reply-to"), "{all}");
        for banned in [
            "sealed",
            "lane",
            "named",
            "restricted",
            "reveal",
            "epoch",
            "key letter",
            "disclosure",
        ] {
            assert!(!all.contains(banned), "{banned} in {all}");
        }
    }
}
