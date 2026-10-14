//! Agents mode (mixed-visibility DESIGN §4.9, "The runner"; docs/guides/self-host-runner.md
//! §Agents): the runner's identity is a bot that people ask to work on an issue or pull request
//! (`dg bot ask`, an event of kind 27 addressed to it). Each poll reads the requests written since
//! the last one (`dg bot jobs`, the `addressee` index) and works on each that its access allows.
//! These are runner conventions, not consensus:
//!
//! * **Only proper requests get members-only input.** The bot's newest access notice must be live
//!   and have allowed the asker and the thread when the request was written; the members-only
//!   posts and code come only from the `read` key letter the asker wrote for this job, only when
//!   the notice lets the bot read on request, and never for a pull request from a fork or from
//!   someone outside the members. Anything else runs in **public mode**: what everyone reads, and
//!   nothing at all when the task or the thread is members-only.
//! * **Keys stay in the runner.** `dg`, run by the runner with its key, opens the letter and the
//!   posts; the agent gets plaintext in `/in/job.json` and the code in `/work`, and no key, Forge
//!   credential or environment value.
//! * **Taint.** A job that read anything members-only posts only members-only replies: a public
//!   post it asks for is refused here, before `dg` is run ([`post_audience`]).
//! * **Network.** The agent's container has no route out but the runner's egress proxy
//!   ([`crate::egress`]), which lets through the endpoints of the AI service the notice names and
//!   logs every attempt.
//! * **Output.** A reply, cut to `max_reply_bytes`, and at most `max_suggestions` suggested changes
//!   on a pull request's lines: suggestion first, never a push (pushes are phase 4E's).

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use anyhow::{bail, Context as _, Result};
use serde::Deserialize;

use crate::config::{Agents, Config, RepoConfig};
use crate::egress::{self, Endpoint, Proxy};
use crate::run;

/// The largest reply `max_reply_bytes` may allow: a bot's members-only comment holds 5,056 bytes
/// of text (v0x03 room), and the cut note needs some.
pub const MAX_REPLY_BYTES: usize = 4_800;

/// The largest suggested replacement text.
const MAX_SUGGESTION_BYTES: usize = 2_000;

/// The largest `/out/result.json` read.
const MAX_RESULT_FILE: u64 = 256 * 1024;

/// What a cut reply ends with.
const CUT_NOTE: &str = "\n\n(The rest of this reply was cut to fit.)";

/// The notice abilities the runner reads (`private-repos.md` §22.1).
const MAY_POST: &str = "post";
const MAY_POST_MEMBERS_ONLY: &str = "postMembersOnly";
const MAY_READ_ON_REQUEST: &str = "readOnRequest";

/// One request to the bot (`dg bot jobs --json`).
#[derive(Debug, Clone, Deserialize)]
pub struct JobRow {
    /// The request's event id: the job.
    pub id: String,
    /// The issue or pull request.
    pub number: u32,
    /// Who asked.
    pub asker: String,
    /// When (ms).
    pub at: u64,
    /// Whether the asker shared the thread's members-only content with the bot for it.
    pub letter: bool,
}

/// The bot and its requests since `since` (`dg bot jobs <repo> --since <ms>`), oldest first.
pub fn list_jobs(cfg: &Config, repo: &RepoConfig, since: u64) -> Result<(String, Vec<JobRow>)> {
    let v = run::dg_read_keyed(
        cfg,
        true,
        &["bot", "jobs", &repo.repo, "--since", &since.to_string()],
    )?;
    jobs_of(&v)
}

fn jobs_of(v: &serde_json::Value) -> Result<(String, Vec<JobRow>)> {
    let bot = v["bot"]
        .as_str()
        .context("dg bot jobs: no bot")?
        .to_string();
    let rows = serde_json::from_value(v["requests"].clone())
        .context("dg bot jobs: unexpected requests")?;
    Ok((bot, rows))
}

/// A bot's access as everyone reads it (`dg bot list --json`, one row).
#[derive(Debug, Clone, Default, Deserialize)]
pub struct Access {
    /// The bot.
    pub bot: String,
    /// What it may do.
    #[serde(default)]
    pub may: Vec<String>,
    /// The AI service that processes what it is given.
    #[serde(default)]
    pub processor: Option<String>,
    /// Whether it is live now (not ended, not taken away).
    #[serde(default)]
    pub live: bool,
}

impl Access {
    fn may(&self, ability: &str) -> bool {
        self.may.iter().any(|m| m == ability)
    }
}

/// The bot's current access in `repo`, if it has one.
fn access_of(cfg: &Config, repo: &RepoConfig, bot: &str) -> Result<Option<Access>> {
    let v = run::dg_read_keyed(cfg, true, &["bot", "list", &repo.repo])?;
    let rows: Vec<Access> =
        serde_json::from_value(v["bots"].clone()).context("dg bot list: unexpected rows")?;
    Ok(rows.into_iter().find(|a| a.bot == bot))
}

/// One post of the thread as `dg bot read --json` gives it.
#[derive(Debug, Clone, Deserialize, serde::Serialize)]
pub struct Post {
    /// `issue`, `pull request`, `comment` or `review`.
    pub kind: String,
    /// Its author.
    pub author: String,
    /// When (ms).
    pub at: u64,
    /// `public`, `membersOnly`, `notShared` or `after`.
    pub status: String,
    /// Its title.
    #[serde(default)]
    pub title: Option<String>,
    /// Its text.
    #[serde(default)]
    pub body: Option<String>,
}

/// A job as the bot reads it (`dg bot read --json`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Thread {
    /// The issue or pull request number.
    pub number: u32,
    /// Who asked.
    pub asker: String,
    /// The task, when it could be read.
    #[serde(default)]
    pub task: Option<String>,
    /// The task is members-only. Required: a `dg` too old to say must not be taken as "no".
    pub task_members_only: bool,
    /// Whether its access allowed it when it was written.
    pub allowed: bool,
    /// A pull request from a fork or from someone outside the members (`None`: an issue).
    /// Required, as `task_members_only` is.
    #[serde(deserialize_with = "required_nullable")]
    pub foreign_pull: Option<bool>,
    /// The `read` letter it was read with.
    #[serde(default)]
    pub letter: Option<String>,
    /// The members-only code's head, when the letter hands code on.
    #[serde(default)]
    pub head: Option<String>,
    /// How many members-only packs the letter hands on.
    #[serde(default)]
    pub packs: usize,
    /// The packs written (`--code`).
    #[serde(default)]
    pub pack_files: Vec<String>,
    /// The thread, the issue or pull request first.
    pub posts: Vec<Post>,
}

/// A field that must be present and may be `null`.
fn required_nullable<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> std::result::Result<Option<bool>, D::Error> {
    Option::deserialize(d)
}

impl Thread {
    fn is_pull(&self) -> bool {
        self.posts.first().is_some_and(|p| p.kind == "pull request")
    }
}

/// How a job runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// With what the asker's letter hands on.
    Members,
    /// With what everyone reads.
    Public,
}

impl Mode {
    /// The word the outcome and the job file give it.
    fn label(self) -> &'static str {
        match self {
            Self::Members => "members",
            Self::Public => "public",
        }
    }
}

/// Whether and how a request is worked on (DESIGN §4.9 "Run only proper requests"), from the
/// thread as everyone reads it (`t`, no letter opened) and whether the asker wrote the bot a
/// letter for it (`letter`): `Err` says why it is not.
pub fn decide(
    access: Option<&Access>,
    t: &Thread,
    letter: bool,
) -> std::result::Result<Mode, String> {
    let Some(a) = access.filter(|a| a.live) else {
        return Err("the bot has no access in this repository now".into());
    };
    if !t.allowed {
        return Err(
            "the request is outside the access the bot was given (who may ask, or which threads)"
                .into(),
        );
    }
    if !a.may(MAY_POST) && !a.may(MAY_POST_MEMBERS_ONLY) {
        return Err("the bot's access doesn't let it post here".into());
    }
    // a pull request whose origin is not known (`foreignPull` null) is taken for a fork's
    let from_members = !t.is_pull() || t.foreign_pull == Some(false);
    let proper = a.may(MAY_READ_ON_REQUEST) && letter && from_members;
    Ok(if proper { Mode::Members } else { Mode::Public })
}

/// `t` as public mode may use it: only public posts, and refused (`Err`) when the task or the
/// thread itself is members-only, which leaves nothing to work on.
pub fn public_input(mut t: Thread) -> std::result::Result<Thread, String> {
    if t.task_members_only || t.task.is_none() {
        return Err("the task is members-only, and this request runs in public mode".into());
    }
    if t.posts.first().is_none_or(|p| p.status != "public") {
        return Err("the thread is members-only, and this request runs in public mode".into());
    }
    t.posts.retain(|p| p.status == "public");
    t.letter = None;
    t.head = None;
    t.packs = 0;
    t.pack_files.clear();
    Ok(t)
}

/// Whether a job read anything members-only: its task, a post, or code from the letter.
pub fn tainted(mode: Mode, t: &Thread) -> bool {
    mode == Mode::Members
        && (t.task_members_only || t.packs > 0 || t.posts.iter().any(|p| p.status == "membersOnly"))
}

/// Who a post is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Audience {
    /// Everyone.
    Public,
    /// The repository's members.
    Members,
}

impl Audience {
    /// The word the outcome gives it.
    fn label(self) -> &'static str {
        match self {
            Self::Public => "public",
            Self::Members => "members",
        }
    }
}

/// Who the job's posts are for (DESIGN §4.9 "Taint"): what the agent asked for (`requested`),
/// else members-only after members-only input and public otherwise. A tainted job's public post
/// is refused, and so is any post the bot's access does not allow. `Err` says why.
pub fn post_audience(
    tainted: bool,
    requested: Option<Audience>,
    access: &Access,
) -> std::result::Result<Audience, String> {
    let want = requested.unwrap_or(if tainted {
        Audience::Members
    } else {
        Audience::Public
    });
    if tainted && want == Audience::Public {
        return Err(
            "refused a public post: this job read members-only content, so it may post members-only replies only"
                .into(),
        );
    }
    match want {
        Audience::Public if !access.may(MAY_POST) => {
            Err("the bot's access doesn't let it post public replies".into())
        }
        Audience::Members if !access.may(MAY_POST_MEMBERS_ONLY) => {
            Err("the bot's access doesn't let it post members-only replies".into())
        }
        a => Ok(a),
    }
}

/// One suggested change on a pull request's lines.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Suggestion {
    /// The file.
    pub path: String,
    /// The last line.
    pub line: u64,
    /// The first line of a range.
    #[serde(default)]
    pub start_line: Option<u64>,
    /// The replacement text.
    pub text: String,
}

/// `/out/result.json` as the agent writes it.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawResult {
    #[serde(default)]
    reply: String,
    #[serde(default)]
    suggestions: Vec<Suggestion>,
    #[serde(default)]
    audience: Option<String>,
}

/// What the agent gave back, checked and capped.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Output {
    /// The reply (cut to the cap).
    pub reply: String,
    /// Whether it was cut.
    pub cut: bool,
    /// The suggested changes kept.
    pub suggestions: Vec<Suggestion>,
    /// Suggestions left out, and why.
    pub dropped: Vec<String>,
    /// Who the agent asked its posts to be for.
    pub audience: Option<Audience>,
}

/// Read and check what the agent wrote ([`RawResult`]), capped by `a`.
pub fn read_output(bytes: &[u8], a: &Agents, pull: bool) -> Result<Output> {
    let raw: RawResult = serde_json::from_slice(bytes)
        .context("the agent's result.json is not what it should be")?;
    let audience = match raw.audience.as_deref() {
        None => None,
        Some("public") => Some(Audience::Public),
        Some("members") => Some(Audience::Members),
        Some(other) => bail!("the agent's result.json names an unknown audience {other:?}"),
    };
    let (reply, cut) = cap(raw.reply.trim(), a.max_reply_bytes);
    let mut suggestions = Vec::new();
    let mut dropped = Vec::new();
    for s in raw.suggestions {
        let why = if !pull {
            Some("suggested changes go on pull requests only")
        } else if suggestions.len() >= a.max_suggestions {
            Some("more than max_suggestions")
        } else if !safe_path(&s.path) {
            Some("not a file path in the repository")
        } else if s.line == 0 || s.start_line.is_some_and(|f| f == 0 || f > s.line) {
            Some("not a line range")
        } else if s.text.len() > MAX_SUGGESTION_BYTES {
            Some("too long")
        } else {
            None
        };
        match why {
            Some(w) => dropped.push(format!(
                "{}:{} ({w})",
                s.path.chars().take(80).collect::<String>(),
                s.line
            )),
            None => suggestions.push(s),
        }
    }
    Ok(Output {
        reply,
        cut,
        suggestions,
        dropped,
        audience,
    })
}

/// `text` within `max` bytes: as it is, or cut at a character boundary with [`CUT_NOTE`].
fn cap(text: &str, max: usize) -> (String, bool) {
    if text.len() <= max {
        return (text.to_string(), false);
    }
    let mut end = max.saturating_sub(CUT_NOTE.len());
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    (format!("{}{CUT_NOTE}", text[..end].trim_end()), true)
}

/// A relative path inside the repository: no leading `/`, no `..`, nothing unprintable.
fn safe_path(p: &str) -> bool {
    !p.is_empty()
        && p.len() <= 256
        && !p.starts_with('/')
        && p.split('/')
            .all(|seg| !seg.is_empty() && seg != "." && seg != "..")
        && !p.chars().any(char::is_control)
}

/// What one job came to, for the runner's log and `<state>/agents/<repo>/<job>.json`. Holds no
/// members-only text.
#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    /// The job.
    pub job: String,
    /// The issue or pull request.
    pub number: u32,
    /// `members`, `public`, or none when it was not worked on.
    pub mode: Option<&'static str>,
    /// Whether it read members-only content.
    pub tainted: bool,
    /// Why it was not worked on, or why nothing was posted.
    pub refused: Option<String>,
    /// What was posted (document ids) and for whom.
    pub posted: Vec<String>,
    /// Who the posts were for (`public` or `members`).
    pub audience: Option<&'static str>,
    /// What could not be posted, and why.
    pub failed: Vec<String>,
    /// The suggested changes left out.
    pub dropped: Vec<String>,
    /// Whether the reply was cut.
    pub cut: bool,
    /// The agent's exit code (`None`: killed or not run).
    pub exit: Option<i32>,
    /// Whether it ran past `timeout_secs`.
    pub timed_out: bool,
    /// The egress log, summarised (`allow api.example.com:443 ×3`).
    pub egress: Vec<String>,
}

/// Work on job `row` of `repo` (the job directory is `dir`, removed by the caller). `Err`: it
/// could not be read (tried again on the next poll); everything after that is an [`Outcome`].
#[allow(clippy::too_many_lines)] // one job, read to posted, each refusal where it is decided
pub fn work(
    cfg: &Config,
    repo: &RepoConfig,
    bot: &str,
    row: &JobRow,
    dir: &Path,
) -> Result<Outcome> {
    let a = cfg
        .agents
        .as_ref()
        .context("agents = true needs [agents]")?;
    let mut out = Outcome {
        job: row.id.clone(),
        number: row.number,
        ..Outcome::default()
    };
    let access = access_of(cfg, repo, bot)?;
    let packs_dir = dir.join("packs");
    // decided on what everyone reads: the letter is opened only for a proper request
    let public = read_thread(cfg, repo, &row.id, Read::Public)?;
    let mut mode = match decide(access.as_ref(), &public, row.letter) {
        Ok(m) => m,
        Err(why) => {
            out.refused = Some(why);
            return Ok(out);
        }
    };
    let access = access.unwrap_or_default();
    let mut thread = None;
    if mode == Mode::Members {
        let full = read_thread(cfg, repo, &row.id, Read::Letter(&packs_dir))?;
        if full.letter.is_some() {
            thread = Some(full);
        } else {
            mode = Mode::Public;
        }
    }
    let thread = match thread {
        Some(t) => t,
        None => match public_input(public) {
            Ok(t) => t,
            Err(why) => {
                out.refused = Some(why);
                return Ok(out);
            }
        },
    };
    out.mode = Some(mode.label());
    out.tainted = tainted(mode, &thread);
    let endpoints = match endpoints_for(a, access.processor.as_deref()) {
        Ok(e) => e,
        Err(why) => {
            out.refused = Some(why);
            return Ok(out);
        }
    };

    let (work, input, outdir, anon) = (
        dir.join("work"),
        dir.join("in"),
        dir.join("out"),
        dir.join("anon"),
    );
    for d in [&work, &input, &outdir, &anon] {
        std::fs::create_dir_all(d)?;
    }
    let head = match prepare_code(cfg, repo, mode, &thread, &packs_dir, &work, &anon) {
        Ok(h) => h,
        Err(e) => {
            eprintln!(
                "forge-runner: {} job {}: the code could not be checked out, the agent works without it: {e:#}",
                repo.repo, row.id
            );
            None
        }
    };
    let pull = thread.is_pull();
    let job = serde_json::json!({
        "repo": repo.repo,
        "number": thread.number,
        "kind": if pull { "pullRequest" } else { "issue" },
        "asker": thread.asker,
        "task": thread.task,
        "mode": out.mode,
        "membersOnly": out.tainted,
        "posts": thread.posts,
        "code": head.as_ref().map(|_| "/work"),
        "head": head,
        "output": {
            "maxReplyBytes": a.max_reply_bytes,
            "maxSuggestions": if pull { a.max_suggestions } else { 0 },
            "audiences": if out.tainted { vec!["members"] } else { vec!["public", "members"] },
        },
    });
    std::fs::write(input.join("job.json"), serde_json::to_vec_pretty(&job)?)?;

    let service_env = access
        .processor
        .as_deref()
        .and_then(|p| a.services.get(p))
        .and_then(|s| s.env_file.as_deref());
    let ran = run_agent(a, &row.id, dir, endpoints, service_env)?;
    out.exit = ran.exit;
    out.timed_out = ran.timed_out;
    out.egress = egress::summary(&ran.egress);
    if ran.timed_out || ran.exit != Some(0) {
        out.refused = Some(if ran.timed_out {
            "the agent ran out of time; nothing was posted".into()
        } else {
            format!("the agent exited with {:?}; nothing was posted", ran.exit)
        });
        return Ok(out);
    }
    let result = outdir.join("result.json");
    // never followed: a link the agent made would have the runner read a file of its host
    let bytes = match std::fs::symlink_metadata(&result) {
        Ok(m) if m.is_file() && m.len() <= MAX_RESULT_FILE => std::fs::read(&result)?,
        Ok(m) if !m.is_file() => {
            out.refused = Some("the agent's result.json is not a file; nothing was posted".into());
            return Ok(out);
        }
        Ok(_) => {
            out.refused = Some("the agent's result.json is too large; nothing was posted".into());
            return Ok(out);
        }
        Err(_) => {
            out.refused = Some("the agent wrote no result.json; nothing was posted".into());
            return Ok(out);
        }
    };
    let output = match read_output(&bytes, a, pull) {
        Ok(o) => o,
        Err(e) => {
            out.refused = Some(format!("{e:#}; nothing was posted"));
            return Ok(out);
        }
    };
    out.cut = output.cut;
    out.dropped.clone_from(&output.dropped);
    let audience = match post_audience(out.tainted, output.audience, &access) {
        Ok(a) => a,
        Err(why) => {
            out.refused = Some(why);
            return Ok(out);
        }
    };
    out.audience = Some(audience.label());
    // members mode read the thread through the request's letter: its members-only posts name it
    let job = (mode == Mode::Members).then_some(row.id.as_str());
    post(cfg, repo, &thread, audience, job, &output, &mut out);
    Ok(out)
}

/// How a job's thread is read.
#[derive(Clone, Copy)]
enum Read<'a> {
    /// What everyone reads (`--public`): no letter is opened.
    Public,
    /// With the asker's letter, its members-only code written into the directory (`--code`).
    Letter(&'a Path),
}

/// `dg bot read --json` of `job`. A `dg` that does not say whether the task is members-only or
/// where a pull request comes from is refused: the runner would take the missing answers for
/// "public" and "not a fork".
fn read_thread(cfg: &Config, repo: &RepoConfig, job: &str, how: Read<'_>) -> Result<Thread> {
    let code_dir;
    let mut args = vec!["bot", "read", repo.repo.as_str(), job];
    match how {
        Read::Public => args.push("--public"),
        Read::Letter(dir) => {
            code_dir = dir.display().to_string();
            args.extend(["--code", code_dir.as_str()]);
        }
    }
    thread_of(run::dg_read_keyed(cfg, true, &args)?)
}

fn thread_of(v: serde_json::Value) -> Result<Thread> {
    serde_json::from_value(v).context(
        "dg bot read: unexpected JSON (the runner needs taskMembersOnly and foreignPull: dg too \
         old for this runner? upgrade dg)",
    )
}

/// The endpoints the agent may reach: those of the AI service the access names. `Err` when it
/// names one this runner does not know (the job would send content somewhere the maintainers did
/// not say). No service named: no endpoint at all.
pub fn endpoints_for(
    a: &Agents,
    processor: Option<&str>,
) -> std::result::Result<Vec<Endpoint>, String> {
    let Some(name) = processor else {
        return Ok(Vec::new());
    };
    let s = a.services.get(name).ok_or_else(|| {
        format!("the bot's access names {name:?} as its AI service, which this runner has no [agents.services] entry for")
    })?;
    Ok(s.endpoints
        .iter()
        .filter_map(|e| Endpoint::parse(e))
        .collect())
}

/// `git` in `dir` as nobody: without the runner's key, and with a home of its own (`anon`), so
/// git-remote-dash cannot fall back to an identity recorded on the runner host either. The
/// network and the storage read settings are kept.
fn git_anon(cfg: &Config, dir: &Path, anon: &Path, args: &[&str]) -> Result<String> {
    let mut c = run::with_network(Command::new(&cfg.bin.git), cfg);
    if let Some(storage) = storage_config() {
        c.env("DASH_FORGE_STORAGE_CONFIG", storage);
    }
    c.env_remove("DASH_FORGE_KEY")
        .env_remove("DASH_FORGE_PASSPHRASE")
        .env("HOME", anon)
        .env("XDG_CONFIG_HOME", anon.join("config"))
        .env("XDG_STATE_HOME", anon.join("state"))
        .env("DASH_FORGE_NO_KEYCHAIN", "1")
        .current_dir(dir)
        .args(args);
    run::output(&mut c, &format!("git {}", args.first().unwrap_or(&"")))
}

/// The storage profiles file dg and git-remote-dash read where pack copies are (its read
/// gateways), as the runner's environment names it.
fn storage_config() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("DASH_FORGE_STORAGE_CONFIG") {
        return Some(PathBuf::from(p));
    }
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))?;
    Some(base.join("dash-forge").join("storage.toml")).filter(|p| p.exists())
}

/// Check the job's code out in `work`, returning its head: a pull request's members-only head
/// from the letter's packs (on top of the public branches, which they build on), else its public
/// head (from the fork for a fork's pull request); an issue's repository at its default branch.
/// Every fetch is keyless: the only members-only objects come from the letter.
fn prepare_code(
    cfg: &Config,
    repo: &RepoConfig,
    mode: Mode,
    t: &Thread,
    packs: &Path,
    work: &Path,
    anon: &Path,
) -> Result<Option<String>> {
    git_anon(cfg, work, anon, &["init", "-q"])?;
    if mode == Mode::Members && !t.pack_files.is_empty() {
        let head = t
            .head
            .clone()
            .context("the letter hands on code but names no head")?;
        git_anon(
            cfg,
            work,
            anon,
            &[
                "fetch",
                "-q",
                "--no-tags",
                &repo.url(),
                "+refs/heads/*:refs/public/*",
            ],
        )?;
        // each pack is thin against the public branches and the packs before it on the branch,
        // so they are indexed in rounds until every one took
        let mut left: Vec<&Path> = t.pack_files.iter().map(Path::new).collect();
        for p in &left {
            anyhow::ensure!(
                p.starts_with(packs),
                "dg wrote a pack outside {}",
                packs.display()
            );
        }
        while !left.is_empty() {
            let before = left.len();
            left.retain(|p| !index_pack(cfg, work, p));
            anyhow::ensure!(
                left.len() < before,
                "git index-pack of a shared pack failed"
            );
        }
        git_anon(cfg, work, anon, &["checkout", "-q", "--detach", &head])?;
        return Ok(Some(head));
    }
    if t.is_pull() {
        let pr = run::view_pull_public(cfg, repo, u64::from(t.number))?;
        let Some(src) = pr.source_ref_name.as_deref().filter(|_| pr.is_public()) else {
            return Ok(None);
        };
        let url = repo.pull_source_url(&pr);
        // `sourceRefName` is the full ref (`refs/heads/feature`); a bare name is a branch
        let spec = if src.starts_with("refs/") {
            format!("+{src}:refs/forge-runner/pr")
        } else {
            format!("+refs/heads/{src}:refs/forge-runner/pr")
        };
        git_anon(cfg, work, anon, &["fetch", "-q", "--no-tags", &url, &spec])?;
        let tip = git_anon(cfg, work, anon, &["rev-parse", "refs/forge-runner/pr"])?;
        let head = pr.head_oid.to_ascii_lowercase();
        anyhow::ensure!(
            tip.trim() == head,
            "{src} moved past the pull request's head"
        );
        git_anon(cfg, work, anon, &["checkout", "-q", "--detach", &head])?;
        return Ok(Some(head));
    }
    let branch = run::default_branch_name(cfg, repo)?;
    let spec = format!("+refs/heads/{branch}:refs/forge-runner/head");
    git_anon(
        cfg,
        work,
        anon,
        &["fetch", "-q", "--no-tags", &repo.url(), &spec],
    )?;
    git_anon(
        cfg,
        work,
        anon,
        &["checkout", "-q", "--detach", "refs/forge-runner/head"],
    )?;
    Ok(Some(
        git_anon(cfg, work, anon, &["rev-parse", "HEAD"])?
            .trim()
            .to_string(),
    ))
}

/// `git index-pack --stdin --fix-thin` of the pack file `pack` in the repository `work`:
/// whether it took.
fn index_pack(cfg: &Config, work: &Path, pack: &Path) -> bool {
    let Ok(f) = std::fs::File::open(pack) else {
        return false;
    };
    Command::new(&cfg.bin.git)
        .current_dir(work)
        .args(["index-pack", "--stdin", "--fix-thin"])
        .stdin(f)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

/// What the agent's run came to.
struct AgentRun {
    exit: Option<i32>,
    timed_out: bool,
    egress: Vec<egress::Attempt>,
}

/// `docker` with `args`, its stdout; `Err` when it fails.
fn docker(a: &Agents, args: &[&str]) -> Result<String> {
    let mut c = Command::new(&a.docker);
    c.args(args);
    run::output(&mut c, &format!("docker {}", args.first().unwrap_or(&"")))
}

/// The `docker run` arguments of the agent's container: on network `net` only, no capabilities,
/// no outside DNS, the proxy as `HTTPS_PROXY`, the job's three directories, and nothing from the
/// runner's environment but the service's own `env_file`.
fn agent_args(
    a: &Agents,
    name: &str,
    net: &str,
    dir: &Path,
    env_file: Option<&Path>,
    user: Option<String>,
) -> Vec<String> {
    let mount = |sub: &str, at: &str, ro: bool| {
        format!(
            "type=bind,source={},target={at}{}",
            dir.join(sub).display(),
            if ro { ",readonly" } else { "" }
        )
    };
    let proxy = "http://egress:3128";
    let mut v: Vec<String> = vec![
        "run".into(),
        "--rm".into(),
        "--name".into(),
        name.into(),
        "--network".into(),
        net.into(),
        // container names resolve (the relay); nothing outside does: the embedded resolver's
        // upstream is an address that answers nobody (TEST-NET-1)
        "--dns".into(),
        "192.0.2.1".into(),
        "--cap-drop".into(),
        "ALL".into(),
        "--security-opt".into(),
        "no-new-privileges".into(),
        "--pids-limit".into(),
        "512".into(),
        "--memory".into(),
        a.memory.clone(),
        "--cpus".into(),
        a.cpus.clone(),
        "--tmpfs".into(),
        "/tmp".into(),
        "-e".into(),
        "HOME=/tmp".into(),
    ];
    for var in ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"] {
        v.extend(["-e".into(), format!("{var}={proxy}")]);
    }
    if let Some(f) = env_file {
        v.extend(["--env-file".into(), f.display().to_string()]);
    }
    if let Some(u) = user {
        v.extend(["--user".into(), u]);
    }
    v.extend([
        "--mount".into(),
        mount("work", "/work", false),
        "--mount".into(),
        mount("in", "/in", true),
        "--mount".into(),
        mount("out", "/out", false),
        "-w".into(),
        "/work".into(),
        a.image.clone(),
    ]);
    v.extend(a.command.iter().cloned());
    v
}

/// Who the agent runs as: the runner's own user and group (`uid:gid` of the job directory), so
/// it can write `/out` on a Linux host; never root: a runner running as root gives the agent
/// `nobody`, and hands it `in`, `work` and `out` (owned by it, mode 0700, never opened to other
/// local users), the job directory itself traversable only. `None` where there are no such ids.
fn job_user(dir: &Path) -> Option<String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt as _, PermissionsExt as _};
        let m = std::fs::metadata(dir).ok()?;
        if m.uid() != 0 {
            return Some(format!("{}:{}", m.uid(), m.gid()));
        }
        for sub in ["in", "work", "out"] {
            let path = dir.join(sub);
            let _ = Command::new("chown")
                .args(["-R", "65534:65534"])
                .arg(&path)
                .status();
            let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700));
        }
        let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o711));
        Some("65534:65534".into())
    }
    #[cfg(not(unix))]
    {
        let _ = dir;
        None
    }
}

/// The oldest Docker Engine agents run on: 28.0 gives an internal network a gateway the
/// containers cannot reach the host through (`gateway_mode_ipv4=isolated`), and is past
/// CVE-2024-29018 (an internal network's resolver forwarding outside).
const MIN_DOCKER_MAJOR: u32 = 28;

/// Refuse a Docker Engine older than [`MIN_DOCKER_MAJOR`].
fn check_docker(a: &Agents) -> Result<()> {
    let v = docker(a, &["version", "--format", "{{.Server.Version}}"])?;
    let major: u32 = v
        .trim()
        .split('.')
        .next()
        .and_then(|m| m.parse().ok())
        .with_context(|| format!("docker version said {:?}", v.trim()))?;
    if major < MIN_DOCKER_MAJOR {
        bail!(
            "agents need Docker Engine {MIN_DOCKER_MAJOR} or newer (this daemon is {}): older \
             engines let a container on an internal network reach the host",
            v.trim()
        );
    }
    Ok(())
}

/// `job` (an event id) as a file or container name part: its alphanumeric characters.
pub fn safe_id(job: &str) -> String {
    job.chars().filter(char::is_ascii_alphanumeric).collect()
}

/// The prefix of everything a job starts on the Docker daemon.
const DOCKER_PREFIX: &str = "forge-agent-";

/// Remove every container and network a job left behind (a runner that crashed mid-job). Only
/// with `sweep_after_timeout`, on a daemon the runner owns: it removes everything named
/// `forge-agent-*`.
pub fn sweep(a: &Agents) {
    let list = |args: &[&str]| -> Vec<String> {
        docker(a, args)
            .map(|s| s.split_whitespace().map(str::to_string).collect())
            .unwrap_or_default()
    };
    let filter = format!("name=^{DOCKER_PREFIX}");
    for c in list(&["ps", "-aq", "--filter", &filter]) {
        let _ = docker(a, &["rm", "-f", &c]);
    }
    for n in list(&["network", "ls", "-q", "--filter", &filter]) {
        let _ = docker(a, &["network", "rm", &n]);
    }
}

/// Run the agent for job `job` with the job directory `dir`: its egress proxy, an internal
/// network, the relay that is its only way out, and the container itself, stopped after
/// `timeout_secs`. Everything it started is removed afterwards.
fn run_agent(
    a: &Agents,
    job: &str,
    dir: &Path,
    endpoints: Vec<Endpoint>,
    env_file: Option<&Path>,
) -> Result<AgentRun> {
    check_docker(a)?;
    let short: String = safe_id(job).chars().take(12).collect();
    let tag = format!("{}-{}", short.to_ascii_lowercase(), std::process::id());
    // the agent's network has no way out and no gateway into the host; the relay's own uplink
    // is a network of its own, so no other container (a CI job) reaches the relay
    let named = |suffix: &str| format!("{DOCKER_PREFIX}{tag}{suffix}");
    let (net, uplink, relay, agent) = (named(""), named("-up"), named("-relay"), named("-run"));
    let proxy = Proxy::start(&a.proxy_listen, endpoints, &dir.join("egress.log"))?;
    let cleanup = || {
        let _ = docker(a, &["rm", "-f", &agent]);
        let _ = docker(a, &["rm", "-f", &relay]);
        let _ = docker(a, &["network", "rm", &net]);
        let _ = docker(a, &["network", "rm", &uplink]);
    };
    let started = (|| -> Result<()> {
        docker(
            a,
            &[
                "network",
                "create",
                "--internal",
                "-o",
                "com.docker.network.bridge.gateway_mode_ipv4=isolated",
                &net,
            ],
        )?;
        docker(a, &["network", "create", &uplink])?;
        docker(
            a,
            &[
                "run",
                "-d",
                "--rm",
                "--name",
                &relay,
                "--network",
                &uplink,
                "--add-host",
                "host.docker.internal:host-gateway",
                "--cap-drop",
                "ALL",
                &a.relay_image,
                "TCP-LISTEN:3128,fork,reuseaddr",
                &format!("TCP:{}:{}", a.proxy_host, proxy.port()),
            ],
        )?;
        docker(
            a,
            &["network", "connect", "--alias", "egress", &net, &relay],
        )?;
        Ok(())
    })();
    if let Err(e) = started {
        cleanup();
        return Err(e.context("the agent's network could not be set up"));
    }
    let args = agent_args(a, &agent, &net, dir, env_file, job_user(dir));
    let mut child = match Command::new(&a.docker)
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            cleanup();
            return Err(anyhow::Error::from(e).context("docker run (the agent) could not start"));
        }
    };
    let deadline = Instant::now() + Duration::from_secs(a.timeout_secs);
    let mut timed_out = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break Some(s),
            Ok(None) => {}
            Err(_) => break None,
        }
        if Instant::now() >= deadline {
            timed_out = true;
            let _ = docker(a, &["kill", &agent]);
            let _ = child.kill();
            break child.wait().ok();
        }
        std::thread::sleep(Duration::from_millis(250));
    };
    cleanup();
    // give a tunnel closing with the container a moment to be logged
    std::thread::sleep(Duration::from_millis(200));
    Ok(AgentRun {
        exit: status.and_then(|s| s.code()),
        timed_out,
        egress: proxy.attempts(),
    })
}

/// The `dg` argument lists that post `output` on `thread` for `audience`: the reply, then each
/// suggested change on its lines. A members-only post in members mode names its request
/// (`job`, `--job`): a bot reads a members-only thread through what that request shared with
/// it, never with the members key (private-repos.md §22.3, §23). `Err` when nothing may be
/// posted: a public post after members-only input (checked again here, right before `dg`), or
/// nothing to post.
pub fn post_args(
    repo: &str,
    thread: &Thread,
    tainted: bool,
    audience: Audience,
    job: Option<&str>,
    output: &Output,
) -> std::result::Result<Vec<Vec<String>>, String> {
    if tainted && audience == Audience::Public {
        return Err("refused a public post after members-only input".into());
    }
    let number = thread.number.to_string();
    let kind = if thread.is_pull() { "pr" } else { "issue" };
    let head = || {
        vec![
            kind.to_string(),
            "comment".into(),
            repo.to_string(),
            number.clone(),
        ]
    };
    let mut posts: Vec<Vec<String>> = Vec::new();
    // `--flag=value`: the agent's text may start with `-`
    if !output.reply.is_empty() {
        let mut a = head();
        a.push(format!("--body={}", output.reply));
        posts.push(a);
    }
    for s in &output.suggestions {
        let mut a = head();
        a.extend([
            format!("--file={}", s.path),
            format!("--line={}", s.line),
            format!("--suggest={}", s.text),
            "--body=Suggested change.".into(),
        ]);
        if let Some(f) = s.start_line {
            a.push(format!("--start-line={f}"));
        }
        posts.push(a);
    }
    if posts.is_empty() {
        return Err("the agent gave no reply and no suggestion; nothing was posted".into());
    }
    if audience == Audience::Members {
        for a in &mut posts {
            a.push("--members".into());
            if let Some(job) = job {
                a.push(format!("--job={job}"));
            }
        }
    }
    Ok(posts)
}

/// Post `output` as `audience` ([`post_args`]; the audience was checked against the taint and the
/// access by [`post_audience`]); `job` is the request, in members mode.
fn post(
    cfg: &Config,
    repo: &RepoConfig,
    thread: &Thread,
    audience: Audience,
    job: Option<&str>,
    output: &Output,
    out: &mut Outcome,
) {
    let posts = match post_args(&repo.repo, thread, out.tainted, audience, job, output) {
        Ok(p) => p,
        Err(why) => {
            out.refused = Some(why);
            return;
        }
    };
    for args in posts {
        let mut cmd = run::with_network(Command::new(&cfg.bin.dg), cfg);
        cmd.args(["--yes", "--json"]).args(&args);
        match run::output(&mut cmd, &format!("dg {} comment", args[0])) {
            Ok(said) => {
                let v: serde_json::Value = serde_json::from_str(&said).unwrap_or_default();
                let id = v["commentId"].as_str().unwrap_or("posted");
                out.posted.push(id.to_string());
            }
            Err(e) => out.failed.push(format!("{e:#}")),
        }
    }
}

/// Where a job's outcome is kept: `<state>/agents/<owner>__<name>/<job>.json`.
pub fn outcome_path(cfg: &Config, repo: &RepoConfig, job: &str) -> PathBuf {
    cfg.state_dir
        .join("agents")
        .join(repo.repo.replace('/', "__"))
        .join(format!("{}.json", safe_id(job)))
}

/// Keep `o` and its egress log (`egress.log` in `dir`) beside it, and say what happened.
pub fn record(cfg: &Config, repo: &RepoConfig, row: &JobRow, dir: &Path, o: &Outcome) {
    let path = outcome_path(cfg, repo, &row.id);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_vec_pretty(o) {
        let _ = std::fs::write(&path, json);
    }
    let _ = std::fs::copy(dir.join("egress.log"), path.with_extension("egress.log"));
    let what = format!(
        "forge-runner: {} job {} (#{} asked by {})",
        repo.repo, row.id, row.number, row.asker
    );
    match (&o.refused, o.posted.is_empty()) {
        (Some(why), _) => eprintln!("{what}: not posted: {why}"),
        (None, false) => eprintln!(
            "{what}: {} mode{}: posted {} ({})",
            o.mode.unwrap_or("?"),
            if o.tainted {
                ", members-only input"
            } else {
                ""
            },
            o.posted.join(", "),
            o.audience.unwrap_or("?")
        ),
        (None, true) => eprintln!("{what}: nothing posted: {}", o.failed.join("; ")),
    }
    for e in &o.egress {
        eprintln!("{what}: egress {e}");
    }
}

/// The ids among `rows` not handled yet: after the cursor `since`, or at it and not in `seen`.
pub fn fresh(rows: Vec<JobRow>, since: u64, seen: &BTreeSet<String>) -> Vec<JobRow> {
    rows.into_iter()
        .filter(|r| r.at > since || (r.at == since && !seen.contains(&r.id)))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agents() -> Agents {
        let c = Config::parse(
            "state_dir = \"/s\"\n[agents]\nimage = \"a\"\nmax_reply_bytes = 100\nmax_suggestions = 2\n[agents.services.\"Example AI\"]\nendpoints = [\"api.example.com:443\"]\n[[repo]]\nrepo = \"a/b\"\nagents = true",
        )
        .unwrap();
        c.agents.unwrap()
    }

    fn access(may: &[&str]) -> Access {
        Access {
            bot: "B".into(),
            may: may.iter().map(ToString::to_string).collect(),
            processor: Some("Example AI".into()),
            live: true,
        }
    }

    fn post(status: &str, kind: &str) -> Post {
        Post {
            kind: kind.into(),
            author: "A".into(),
            at: 1,
            status: status.into(),
            title: None,
            body: Some(format!("{status} text")),
        }
    }

    fn thread(letter: bool, foreign: Option<bool>, posts: Vec<Post>) -> Thread {
        Thread {
            number: 42,
            asker: "A".into(),
            task: Some("fix it".into()),
            task_members_only: false,
            allowed: true,
            foreign_pull: foreign,
            letter: letter.then(|| "L".into()),
            head: None,
            packs: 0,
            pack_files: Vec::new(),
            posts,
        }
    }

    #[test]
    fn only_a_proper_request_reads_what_the_letter_hands_on() {
        let all = access(&["post", "postMembersOnly", "readOnRequest"]);
        let pr = vec![
            post("public", "pull request"),
            post("membersOnly", "comment"),
        ];
        let t = thread(false, Some(false), pr.clone());
        assert_eq!(decide(Some(&all), &t, true), Ok(Mode::Members));
        // a fork's or an outsider's pull request, or one whose origin dg did not say: public
        // mode, whatever the letter says
        assert_eq!(
            decide(Some(&all), &thread(false, Some(true), pr.clone()), true),
            Ok(Mode::Public)
        );
        assert_eq!(
            decide(Some(&all), &thread(false, None, pr.clone()), true),
            Ok(Mode::Public)
        );
        // an issue has no origin to check
        let issue = thread(false, None, vec![post("public", "issue")]);
        assert_eq!(decide(Some(&all), &issue, true), Ok(Mode::Members));
        // no letter, or an access without reading on request: public mode
        assert_eq!(decide(Some(&all), &t, false), Ok(Mode::Public));
        assert_eq!(
            decide(Some(&access(&["post", "postMembersOnly"])), &t, true),
            Ok(Mode::Public)
        );
        // no access now, an ended one, or a request outside it: not worked on
        assert!(decide(None, &t, true).is_err());
        let mut ended = all.clone();
        ended.live = false;
        assert!(decide(Some(&ended), &t, true).is_err());
        let mut outside = t.clone();
        outside.allowed = false;
        assert!(decide(Some(&all), &outside, true).is_err());
        assert!(decide(Some(&access(&["readOnRequest"])), &t, true).is_err());
    }

    #[test]
    fn public_mode_keeps_only_public_posts_and_nothing_members_only() {
        let t = thread(
            true,
            Some(true),
            vec![
                post("public", "pull request"),
                post("membersOnly", "comment"),
                post("notShared", "comment"),
                post("public", "review"),
            ],
        );
        let p = public_input(t).unwrap();
        assert!(p.posts.iter().all(|x| x.status == "public"));
        assert_eq!(p.posts.len(), 2);
        assert!(p.letter.is_none() && p.packs == 0);
        assert!(!tainted(Mode::Public, &p));
        // a members-only task or thread leaves nothing to work on
        let mut hidden = thread(false, Some(true), vec![post("public", "pull request")]);
        hidden.task_members_only = true;
        assert!(public_input(hidden).is_err());
        let sealed = thread(false, None, vec![post("notShared", "issue")]);
        assert!(public_input(sealed).is_err());
    }

    #[test]
    fn members_only_input_taints_the_job() {
        let clean = thread(true, Some(false), vec![post("public", "pull request")]);
        assert!(!tainted(Mode::Members, &clean));
        let mut code = clean.clone();
        code.packs = 2;
        assert!(tainted(Mode::Members, &code));
        let mut task = clean.clone();
        task.task_members_only = true;
        assert!(tainted(Mode::Members, &task));
        let posts = thread(
            true,
            Some(false),
            vec![
                post("public", "pull request"),
                post("membersOnly", "comment"),
            ],
        );
        assert!(tainted(Mode::Members, &posts));
    }

    #[test]
    fn a_tainted_jobs_public_post_is_refused() {
        let all = access(&["post", "postMembersOnly", "readOnRequest"]);
        let e = post_audience(true, Some(Audience::Public), &all).unwrap_err();
        assert!(e.contains("refused a public post"), "{e}");
        assert_eq!(post_audience(true, None, &all), Ok(Audience::Members));
        assert_eq!(post_audience(false, None, &all), Ok(Audience::Public));
        assert_eq!(
            post_audience(false, Some(Audience::Members), &all),
            Ok(Audience::Members)
        );
        // and nothing the access does not allow
        assert!(post_audience(true, None, &access(&["post", "readOnRequest"])).is_err());
        assert!(post_audience(false, None, &access(&["postMembersOnly"])).is_err());
    }

    #[test]
    fn output_is_capped_and_suggestions_checked() {
        let a = agents();
        let long = "é".repeat(200);
        let o = read_output(
            serde_json::json!({
                "reply": long,
                "suggestions": [
                    {"path": "src/a.rs", "line": 3, "text": "x"},
                    {"path": "../etc/passwd", "line": 1, "text": "x"},
                    {"path": "b.rs", "line": 2, "startLine": 5, "text": "x"},
                    {"path": "c.rs", "line": 1, "text": "x"},
                    {"path": "d.rs", "line": 1, "text": "x"},
                ],
                "audience": "members",
            })
            .to_string()
            .as_bytes(),
            &a,
            true,
        )
        .unwrap();
        assert!(o.cut && o.reply.len() <= 100 && o.reply.ends_with(CUT_NOTE.trim_start()));
        assert_eq!(o.suggestions.len(), 2, "{:?}", o.dropped);
        assert_eq!(o.dropped.len(), 3);
        assert_eq!(o.audience, Some(Audience::Members));
        // suggestions go on pull requests only; an unknown audience or field is refused
        let o = read_output(
            br#"{"reply":"r","suggestions":[{"path":"a","line":1,"text":"x"}]}"#,
            &a,
            false,
        )
        .unwrap();
        assert!(o.suggestions.is_empty());
        assert!(read_output(br#"{"reply":"r","audience":"everyone"}"#, &a, true).is_err());
        assert!(read_output(br#"{"reply":"r","push":"main"}"#, &a, true).is_err());
    }

    #[test]
    fn the_agent_reaches_only_the_service_the_access_names() {
        let a = agents();
        assert_eq!(
            endpoints_for(&a, Some("Example AI")).unwrap(),
            vec![Endpoint::parse("api.example.com:443").unwrap()]
        );
        assert!(endpoints_for(&a, None).unwrap().is_empty());
        assert!(endpoints_for(&a, Some("Other AI")).is_err());
    }

    #[test]
    fn the_agent_container_gets_no_route_out_and_no_runner_environment() {
        let a = agents();
        let args = agent_args(&a, "n", "net", Path::new("/j"), None, Some("1:2".into()));
        let s = args.join(" ");
        assert!(
            s.contains("--network net --dns 192.0.2.1 --cap-drop ALL"),
            "{s}"
        );
        assert!(s.contains("--memory 2g --cpus 2"), "{s}");
        assert!(s.contains("HTTPS_PROXY=http://egress:3128"), "{s}");
        assert!(s.contains("source=/j/in,target=/in,readonly"), "{s}");
        assert!(!s.contains("DASH_FORGE"), "{s}");
        assert!(!args.iter().any(|x| x == "--env"), "{s}");
    }

    #[test]
    fn a_dg_that_does_not_say_where_a_pull_request_comes_from_is_refused() {
        let new = serde_json::json!({
            "request": "j", "allowed": true, "number": 4, "asker": "A", "task": "t",
            "taskMembersOnly": false, "foreignPull": null, "at": 1, "letter": null, "asOf": null,
            "head": null, "packs": 0, "packFiles": [], "posts": [],
        });
        assert!(thread_of(new.clone()).is_ok());
        for missing in ["taskMembersOnly", "foreignPull"] {
            let mut old = new.clone();
            old.as_object_mut().unwrap().remove(missing);
            let e = format!("{:#}", thread_of(old).unwrap_err());
            assert!(e.contains("too old"), "{e}");
        }
    }

    #[test]
    fn posts_are_built_for_their_audience_and_never_public_after_members_only_input() {
        let a = agents();
        let pr = thread(true, Some(false), vec![post("public", "pull request")]);
        let out = read_output(
            br#"{"reply":"-r","suggestions":[{"path":"a.rs","line":3,"startLine":2,"text":"x"}]}"#,
            &a,
            true,
        )
        .unwrap();
        // a public post never names its request, even in members mode
        let p = post_args("o/r", &pr, false, Audience::Public, Some("J"), &out).unwrap();
        assert_eq!(p[0], ["pr", "comment", "o/r", "42", "--body=-r"]);
        assert!(
            p[1].contains(&"--suggest=x".to_string())
                && p[1].contains(&"--start-line=2".to_string())
        );
        assert!(p
            .iter()
            .all(|a| !a.iter().any(|x| x == "--members" || x.starts_with("--job"))));
        // public mode: members-only, with no request to name
        let m = post_args("o/r", &pr, true, Audience::Members, None, &out).unwrap();
        assert!(m
            .iter()
            .all(|a| a.last().map(String::as_str) == Some("--members")));
        // members mode: every members-only post names its request, so the bot reads the thread
        // through what it shared (§22.3)
        let m = post_args("o/r", &pr, true, Audience::Members, Some("J"), &out).unwrap();
        assert_eq!(m.len(), 2);
        assert!(m
            .iter()
            .all(|a| a[a.len() - 2..] == ["--members".to_string(), "--job=J".to_string()]));
        assert!(post_args("o/r", &pr, true, Audience::Public, Some("J"), &out).is_err());
        let issue = thread(true, None, vec![post("public", "issue")]);
        let p = post_args(
            "o/r",
            &issue,
            false,
            Audience::Public,
            None,
            &read_output(br#"{"reply":"r"}"#, &a, false).unwrap(),
        )
        .unwrap();
        assert_eq!(p[0][0], "issue");
        let p = post_args(
            "o/r",
            &issue,
            true,
            Audience::Members,
            Some("J"),
            &read_output(br#"{"reply":"r"}"#, &a, false).unwrap(),
        )
        .unwrap();
        assert_eq!(
            p[0],
            [
                "issue",
                "comment",
                "o/r",
                "42",
                "--body=r",
                "--members",
                "--job=J"
            ]
        );
        assert!(post_args(
            "o/r",
            &issue,
            false,
            Audience::Public,
            None,
            &read_output(b"{}", &a, false).unwrap()
        )
        .is_err());
    }

    #[test]
    fn jobs_are_read_from_dg_and_handled_once() {
        let (bot, rows) = jobs_of(&serde_json::json!({
            "bot": "B", "since": 5, "count": 2,
            "requests": [
                {"id": "j1", "number": 4, "asker": "A", "task": null, "at": 5, "allowed": true, "letter": true},
                {"id": "j2", "number": 4, "asker": "A", "task": "t", "at": 9, "allowed": false, "letter": false},
            ],
        }))
        .unwrap();
        assert_eq!(bot, "B");
        let seen = BTreeSet::from(["j1".to_string()]);
        let left = fresh(rows, 5, &seen);
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].id, "j2");
    }
}
