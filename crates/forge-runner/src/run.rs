//! One run, end to end: a push, or a pull request's activity. Check the commit out, read its
//! workflows, report every job queued, run each workflow file with act, and report each job's
//! result with its log.
//!
//! Every report goes through `dg ci report` (the CLI's own path: validation, the replace-or-create
//! choice, the log upload and its SHA-256, the checkRun-only key in DASH_FORGE_KEY). A job's
//! reports share one run id (`--external-id`, a hash of the repo, ref, commit, workflow file and
//! job), so its queued, in-progress and completed reports update one check run.
//!
//! A pull request runs its head commit, fetched from the branch the PR names (in this
//! repository or a fork) and checked against the head `dg` reports. Its checks are posted on the
//! head, named `<workflow> / <job> (pull_request)`, and keyed by `refs/pull/<n>/head`. It gets
//! the secrets only when [`pull_trusted`] says so; otherwise it runs as GitHub runs a fork's PR:
//! no secrets and an empty `GITHUB_TOKEN`.

use std::io::BufReader;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use anyhow::{bail, Context as _, Result};
use serde_json::json;

use crate::act::{self, Invocation, Outcome, Results};
use crate::config::{Config, RepoConfig};
use crate::watch::{PullEvent, PullRow, Push};
use crate::workflow::{self, Facts, Job, PullFacts, PushFacts};

/// What starts a run.
#[derive(Debug, Clone)]
pub enum Trigger {
    /// A push to one of the repository's own refs.
    Push(Push),
    /// A pull request's activity, and whether its author is a current member (owner,
    /// maintainer or writer) as the poll read the members.
    Pull {
        event: Box<PullEvent>,
        author_member: bool,
    },
}

impl Trigger {
    /// The ref and commit a run is keyed and reported by: the pushed ref, or
    /// `refs/pull/<n>/head` at the PR's head, so a PR's runs never share a run id with the
    /// branch's own push runs.
    pub fn key(&self) -> Push {
        match self {
            Trigger::Push(p) => p.clone(),
            Trigger::Pull { event, .. } => Push {
                refname: format!("refs/pull/{}/head", event.pr.number),
                oid: event.pr.head_oid.clone(),
                before: event.before.clone(),
            },
        }
    }

    /// act's event name.
    pub fn event_name(&self) -> &'static str {
        match self {
            Trigger::Push(_) => "push",
            Trigger::Pull { .. } => "pull_request",
        }
    }

    /// A job's check name: `<workflow> / <job>`, and ` (pull_request)` after it for a PR run
    /// (at most 100 characters, the suffix kept), so a PR's checks and the branch's push checks
    /// on the same commit never replace each other.
    pub fn check_name(&self, base: &str) -> String {
        const SUFFIX: &str = " (pull_request)";
        match self {
            Trigger::Push(_) => base.chars().take(100).collect(),
            Trigger::Pull { .. } => {
                let keep = 100 - SUFFIX.chars().count();
                format!("{}{SUFFIX}", base.chars().take(keep).collect::<String>())
            }
        }
    }

    /// How logs and summaries name what ran: the ref, or `PR #<n>`.
    pub fn label(&self) -> String {
        match self {
            Trigger::Push(p) => p.refname.clone(),
            Trigger::Pull { event, .. } => format!("PR #{}", event.pr.number),
        }
    }

    /// Whether this run gets the secrets file and its `GITHUB_TOKEN`.
    pub fn trusted(&self, repo: &RepoConfig) -> bool {
        match self {
            Trigger::Push(p) => repo.trusted(&p.refname),
            Trigger::Pull {
                event,
                author_member,
            } => pull_trusted(repo, &event.pr, *author_member),
        }
    }
}

/// Whether a pull request's run gets the secrets: only when its head is a branch of this
/// repository, never a fork's, that `trusted_refs` covers (so only those who could push there
/// with secrets anyway wrote the code), and its author is a current member (so the PR's title
/// and other event fields are a member's too). Anything else runs as GitHub runs a fork's PR:
/// no secrets and an empty `GITHUB_TOKEN`.
pub fn pull_trusted(repo: &RepoConfig, pr: &PullRow, author_member: bool) -> bool {
    !pr.is_fork()
        && author_member
        && pr
            .source_ref_name
            .as_deref()
            .is_some_and(|r| repo.trusted(r))
}

/// What a report says (the arguments `dg ci report` takes).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Report<'a> {
    pub repo: &'a str,
    pub oid: &'a str,
    pub name: String,
    pub external_id: String,
    pub status: &'static str,
    pub conclusion: Option<&'static str>,
    pub summary: Option<String>,
    pub log: Option<PathBuf>,
}

/// The `dg` arguments for `r` (the network flags come from the environment).
pub fn report_args(cfg: &Config, r: &Report<'_>) -> Vec<String> {
    let mut a: Vec<String> = [
        "--yes",
        "--json",
        "ci",
        "report",
        r.repo,
        "--sha",
        r.oid,
        "--name",
        &r.name,
        "--status",
        r.status,
        "--external-id",
    ]
    .iter()
    .map(ToString::to_string)
    .collect();
    a.push(r.external_id.clone());
    if let Some(c) = r.conclusion {
        a.extend(["--conclusion".into(), c.into()]);
    }
    if let Some(s) = &r.summary {
        a.extend(["--summary".into(), s.chars().take(1000).collect()]);
    }
    // On a private repository `dg` leaves the summary, the run id and the log out (a private
    // repository's check run carries none) and does not upload the log.
    if let (Some(log), Some(storage)) = (&r.log, &cfg.log_storage) {
        a.extend([
            "--log".into(),
            log.display().to_string(),
            "--storage".into(),
            storage.clone(),
        ]);
    }
    a
}

/// The run id a job's reports share: `forge-runner:` and a SHA-256 over what identifies the run
/// (repo, ref, commit, workflow file, job), cut to 40 hex digits. Fixed length, and two runs
/// never share one because a ref name or a file name was cut.
pub fn external_id(repo: &str, push: &Push, file: &Path, job: &str) -> String {
    use sha2::{Digest as _, Sha256};
    let mut h = Sha256::new();
    for part in [repo, &push.refname, &push.oid, &file.to_string_lossy(), job] {
        h.update(part.as_bytes());
        h.update([0]);
    }
    format!("forge-runner:{}", &hex::encode(h.finalize())[..40])
}

/// The event act gets (`-e`) for a push: a GitHub-shaped `push` payload, enough for
/// `github.ref`, `github.sha` and `github.event.*` in workflows.
pub fn event_json(repo: &str, push: &Push) -> serde_json::Value {
    json!({
        "ref": push.refname,
        "before": push.before.clone().unwrap_or_else(|| "0".repeat(push.oid.len())),
        "after": push.oid,
        "repository": { "full_name": repo, "name": repo.rsplit('/').next().unwrap_or(repo) },
        "forge": { "remote": format!("dash://{repo}") },
    })
}

/// A branch's short name (`main` for `refs/heads/main`), as GitHub's `head.ref` / `base.ref`.
fn short_ref(r: &str) -> &str {
    r.strip_prefix("refs/heads/").unwrap_or(r)
}

/// The event act gets for a pull request: GitHub's `pull_request` payload shape. act reads
/// `number` (`github.ref` = `refs/pull/<n>/merge`) and `pull_request.head.ref` /
/// `pull_request.base.ref` (`github.head_ref` / `github.base_ref`); `github.sha` is the
/// checkout's HEAD, the PR head (GitHub runs a merge preview instead). `head.repo.fork` says
/// whether the head is a fork's; `forge.trusted` whether the run has the secrets.
pub fn pull_event_json(
    repo: &str,
    ev: &PullEvent,
    base_sha: Option<&str>,
    source_url: &str,
    trusted: bool,
) -> serde_json::Value {
    let pr = &ev.pr;
    let name = repo.rsplit('/').next().unwrap_or(repo);
    let repository = json!({ "full_name": repo, "name": name, "fork": false });
    let head_repo = if pr.is_fork() {
        json!({ "full_name": pr.source_repo_id, "name": pr.source_repo_id, "fork": true })
    } else {
        repository.clone()
    };
    let zeros = "0".repeat(pr.head_oid.len());
    let mut e = json!({
        "action": ev.action,
        "number": pr.number,
        "pull_request": {
            "number": pr.number,
            "title": pr.title,
            "draft": pr.draft,
            "state": "open",
            "user": { "login": pr.author },
            "head": {
                "ref": short_ref(pr.source_ref_name.as_deref().unwrap_or_default()),
                "sha": pr.head_oid,
                "repo": head_repo,
            },
            "base": {
                "ref": short_ref(&pr.base_ref),
                "sha": base_sha.unwrap_or(&zeros),
                "repo": repository,
            },
        },
        "repository": repository,
        "sender": { "login": pr.author },
        "forge": { "remote": format!("dash://{repo}"), "source_remote": source_url, "trusted": trusted },
    });
    if let Some(before) = &ev.before {
        e["before"] = json!(before);
        e["after"] = json!(pr.head_oid);
    }
    e
}

/// Runs a command, returning stdout. A failure says what the command said: its stderr, else
/// (`dg --json` reports errors on stdout) the start of its stdout.
fn output(cmd: &mut Command, what: &str) -> Result<String> {
    let out = cmd
        .stdin(Stdio::null())
        .output()
        .with_context(|| format!("{what}: could not start"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let said = if err.trim().is_empty() {
            String::from_utf8_lossy(&out.stdout)
                .chars()
                .take(600)
                .collect()
        } else {
            err.trim().to_string()
        };
        bail!("{what} failed ({}): {}", out.status, said.trim());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// The environment every child gets for the network (dg and git-remote-dash read it).
fn with_network(mut cmd: Command, cfg: &Config) -> Command {
    if let Some(n) = &cfg.network {
        cmd.env("DASH_FORGE_NETWORK", n);
    }
    if let Some(n) = &cfg.devnet_name {
        cmd.env("DASH_FORGE_DEVNET_NAME", n);
    }
    cmd
}

/// `git ls-remote <url>`.
pub fn ls_remote(cfg: &Config, repo: &RepoConfig) -> Result<String> {
    let mut cmd = with_network(Command::new(&cfg.bin.git), cfg);
    cmd.args(["ls-remote", &repo.url()]);
    output(&mut cmd, "git ls-remote")
}

/// A `dg --json` read (no key: reading public documents needs none, and the runner key signs
/// check runs only).
fn dg_read(cfg: &Config, args: &[&str]) -> Result<serde_json::Value> {
    let mut cmd = with_network(Command::new(&cfg.bin.dg), cfg);
    cmd.env_remove("DASH_FORGE_KEY").arg("--json").args(args);
    let out = output(&mut cmd, &format!("dg {}", args.join(" ")))?;
    serde_json::from_str(&out).with_context(|| format!("dg {}: not JSON", args.join(" ")))
}

/// The repository's pull requests (`dg pr list --state all`, the newest `limit`).
pub fn list_pulls(cfg: &Config, repo: &RepoConfig, limit: u32) -> Result<Vec<PullRow>> {
    let v = dg_read(
        cfg,
        &[
            "pr",
            "list",
            &repo.repo,
            "--state",
            "all",
            "--limit",
            &limit.to_string(),
        ],
    )?;
    serde_json::from_value(v["prs"].clone()).context("dg pr list: unexpected rows")
}

/// The repository's current members (owner, maintainers, writers) by identity id.
pub fn list_members(cfg: &Config, repo: &RepoConfig) -> Result<Vec<String>> {
    let v = dg_read(cfg, &["collab", "list", &repo.repo])?;
    let members = v["members"]
        .as_array()
        .context("dg collab list: no members")?;
    Ok(members
        .iter()
        .filter_map(|m| m["identityId"].as_str().map(str::to_string))
        .collect())
}

/// The per-repo directory under the state dir.
pub fn repo_dir(cfg: &Config, repo: &RepoConfig) -> PathBuf {
    cfg.state_dir
        .join("work")
        .join(repo.repo.replace('/', "__"))
}

/// Fetch `refname` of `url` into the repo's bare cache as `dest` (dash:// serves full and
/// partial fetches, not shallow ones: E205), so each run fetches only what is new. Returns the
/// fetched tip.
fn fetch(cfg: &Config, url: &str, refname: &str, cache: &Path, dest: &str) -> Result<String> {
    let git = |args: &[&str]| {
        let mut c = with_network(Command::new(&cfg.bin.git), cfg);
        c.arg("--git-dir").arg(cache).args(args);
        output(&mut c, &format!("git {}", args.first().unwrap_or(&"")))
    };
    if !cache.join("HEAD").exists() {
        std::fs::create_dir_all(cache)?;
        git(&["init", "-q", "--bare"])?;
    }
    git(&["fetch", "-q", url, &format!("+{refname}:{dest}")])?;
    Ok(git(&["rev-parse", dest])?.trim().to_string())
}

/// Fetch `refname` of `url` and check that it is at `oid`: what runs is what the ref holds.
fn fetch_at(cfg: &Config, url: &str, refname: &str, oid: &str, cache: &Path) -> Result<()> {
    let tip = fetch(cfg, url, refname, cache, "refs/forge-runner/fetched")?;
    if tip != oid {
        bail!(
            "{refname} is at {tip}, not {oid} (it moved, or the PR names another commit); the \
             next poll tries again"
        );
    }
    Ok(())
}

/// A fresh clone of the cache in `dir`, detached at `oid`: act reads `github.sha` and
/// `github.ref` from the checkout's git metadata. Its origin is the cache on disk, never
/// dash://, and nothing a job writes survives into the next run.
fn checkout(cfg: &Config, cache: &Path, oid: &str, dir: &Path) -> Result<()> {
    if dir.exists() {
        std::fs::remove_dir_all(dir)?;
    }
    let mut clone = Command::new(&cfg.bin.git);
    clone
        .args(["clone", "-q", "--no-checkout", "--no-hardlinks"])
        .arg(cache)
        .arg(dir);
    output(&mut clone, "git clone (local cache)")?;
    let mut co = Command::new(&cfg.bin.git);
    co.arg("-C").arg(dir).args([
        "-c",
        "advice.detachedHead=false",
        "checkout",
        "-q",
        "--detach",
        oid,
    ]);
    output(&mut co, "git checkout")?;
    Ok(())
}

/// The paths changed between `range` (a `git diff` revision range) in the cache.
fn changed_paths(cfg: &Config, cache: &Path, range: &str) -> Option<Vec<String>> {
    let mut c = Command::new(&cfg.bin.git);
    c.arg("--git-dir")
        .arg(cache)
        .args(["diff", "--name-only", "--no-renames", "-z", range]);
    let out = output(&mut c, "git diff").ok()?;
    Some(
        out.split('\0')
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .collect(),
    )
}

/// The first configured workflow directory the commit has (a real directory, not a symlink).
fn workflow_dir(cfg: &Config, checkout: &Path) -> Option<PathBuf> {
    cfg.workflow_dirs
        .iter()
        .map(|d| checkout.join(d))
        .find(|p| std::fs::symlink_metadata(p).is_ok_and(|m| m.is_dir()))
}

/// What a run produced: each check name and its conclusion.
#[derive(Debug, Default)]
pub struct Ran {
    pub checks: Vec<(String, &'static str)>,
}

/// Report one step of one run; a failed report is logged, not fatal (the run goes on, and a
/// later report of the same run id carries the state forward). Returns whether dg succeeded.
fn report(cfg: &Config, r: &Report<'_>) -> bool {
    let mut cmd = with_network(Command::new(&cfg.bin.dg), cfg);
    cmd.args(report_args(cfg, r));
    match output(&mut cmd, "dg ci report") {
        Ok(out) => {
            let status = serde_json::from_str::<serde_json::Value>(&out)
                .ok()
                .and_then(|v| v["status"].as_str().map(str::to_string))
                .unwrap_or_default();
            eprintln!(
                "forge-runner: {} {} = {} ({status})",
                r.repo,
                r.name,
                r.conclusion.unwrap_or(r.status)
            );
            true
        }
        Err(e) => {
            eprintln!(
                "forge-runner: report of {} {} failed: {e:#}",
                r.repo, r.name
            );
            false
        }
    }
}

/// What every workflow file of one run shares.
struct RunCtx<'a> {
    cfg: &'a Config,
    repo: &'a RepoConfig,
    trig: &'a Trigger,
    /// [`Trigger::key`]: the ref and commit reports are keyed by.
    key: &'a Push,
    checkout: &'a Path,
    event: &'a Path,
    secrets: Option<&'a Path>,
    secret_values: &'a [(String, String)],
    github_token: &'a str,
    logs: &'a Path,
    run_dir: &'a Path,
    deadline: Instant,
}

impl RunCtx<'_> {
    /// A report of check `name` (`id` its job, `file` its workflow) with `status` and nothing
    /// else yet.
    fn report_of(&self, file: &Path, id: &str, name: &str, status: &'static str) -> Report<'_> {
        Report {
            repo: &self.repo.repo,
            oid: &self.key.oid,
            name: self.trig.check_name(name),
            external_id: external_id(&self.repo.repo, self.key, file, id),
            status,
            conclusion: None,
            summary: None,
            log: None,
        }
    }

    /// A completed `failure` for a reason the runner found itself (bad YAML, a refused job):
    /// the check run says why, and nothing ran. Returns the check's name.
    fn refuse(&self, file: &Path, id: &str, name: &str, why: &str) -> String {
        let r = Report {
            conclusion: Some("failure"),
            summary: Some(format!("forge-runner did not run this: {why}")),
            ..self.report_of(file, id, name, "completed")
        };
        report(self.cfg, &r);
        r.name
    }
}

/// Run `trig` for `repo`: every job of every workflow file that runs on it, reported queued →
/// in_progress → completed, one act run per file. Secrets go to act only when
/// [`Trigger::trusted`]. `run_dir` is this run's own directory (checkout, event, logs, act's
/// caches).
pub fn run(cfg: &Config, repo: &RepoConfig, trig: &Trigger, run_dir: &Path) -> Result<Ran> {
    let cache = repo_dir(cfg, repo).join("cache.git");
    let key = trig.key();
    let trusted = trig.trusted(repo);
    let (changed, facts_base, event) = match trig {
        Trigger::Push(p) => {
            fetch_at(cfg, &repo.url(), &p.refname, &p.oid, &cache)?;
            let changed = p
                .before
                .as_deref()
                .and_then(|b| changed_paths(cfg, &cache, &format!("{b}..{}", p.oid)));
            (changed, None, event_json(&repo.repo, p))
        }
        Trigger::Pull { event: ev, .. } => {
            let pr = &ev.pr;
            let source = pr
                .source_ref_name
                .as_deref()
                .context("the PR names no source branch")?;
            let url = repo.pull_source_url(pr);
            fetch_at(cfg, &url, source, &pr.head_oid, &cache)?;
            // The base, for `base.sha` and the PR's changed paths (`base...head`).
            let base = fetch(
                cfg,
                &repo.url(),
                &pr.base_ref,
                &cache,
                "refs/forge-runner/base",
            )
            .map_err(|e| eprintln!("forge-runner: {}: base not fetched: {e:#}", repo.repo))
            .ok();
            let changed = base
                .as_deref()
                .and_then(|b| changed_paths(cfg, &cache, &format!("{b}...{}", pr.head_oid)));
            let event = pull_event_json(&repo.repo, ev, base.as_deref(), &url, trusted);
            (changed, Some(short_ref(&pr.base_ref).to_string()), event)
        }
    };
    let co = run_dir.join("checkout");
    checkout(cfg, &cache, &key.oid, &co)?;
    let mut ran = Ran::default();
    let Some(wf_dir) = workflow_dir(cfg, &co) else {
        eprintln!(
            "forge-runner: {} {} has no {}; nothing to run",
            repo.repo,
            &key.oid[..12],
            cfg.workflow_dirs.join(" or ")
        );
        return Ok(ran);
    };
    let facts = match (trig, &facts_base) {
        (Trigger::Pull { event: ev, .. }, Some(base)) => Facts::PullRequest(PullFacts {
            base,
            action: ev.action,
            changed: changed.as_deref(),
        }),
        _ => Facts::Push(PushFacts {
            refname: &key.refname,
            changed: changed.as_deref(),
        }),
    };
    let labels: Vec<&str> = cfg.platforms.keys().map(String::as_str).collect();
    let plan = workflow::plan(&co, &wf_dir, &facts, repo.allow_container_options, &labels);
    let event_path = run_dir.join("event.json");
    std::fs::write(&event_path, serde_json::to_vec(&event)?)?;
    let secrets = trusted.then(|| repo.secrets_file.clone()).flatten();
    let secret_values = secrets
        .as_deref()
        .map(read_secret_values)
        .transpose()?
        .unwrap_or_default();
    let github_token = secret_values
        .iter()
        .find(|(k, _)| k == "GITHUB_TOKEN")
        .map_or("", |(_, v)| v.as_str());
    let logs = run_dir.join("logs");
    std::fs::create_dir_all(&logs)?;
    let deadline = Instant::now() + Duration::from_secs(cfg.job_timeout_secs);
    let ctx = RunCtx {
        cfg,
        repo,
        trig,
        key: &key,
        checkout: &co,
        event: &event_path,
        secrets: secrets.as_deref(),
        secret_values: &secret_values,
        github_token,
        logs: &logs,
        run_dir,
        deadline,
    };
    for b in &plan.broken {
        let name = format!("{} (invalid workflow)", b.file.display());
        let name = ctx.refuse(&b.file, "", &name, &b.reason);
        ran.checks.push((name, "failure"));
    }
    for wf in &plan.run {
        run_workflow(&ctx, wf, &mut ran)?;
    }
    Ok(ran)
}

/// Run one workflow file with act (its refused jobs reported, not run) and report its jobs.
fn run_workflow(c: &RunCtx<'_>, wf: &workflow::Workflow, ran: &mut Ran) -> Result<()> {
    let (refused, runnable): (Vec<&Job>, Vec<&Job>) =
        wf.jobs.iter().partition(|j| j.refused.is_some());
    for j in &refused {
        let why = j.refused.as_deref().unwrap_or("");
        let name = c.refuse(&wf.file, &j.id, &j.check_name, why);
        ran.checks.push((name, "failure"));
    }
    if runnable.is_empty() {
        return Ok(());
    }
    for status in ["queued", "in_progress"] {
        for j in &runnable {
            report(c.cfg, &c.report_of(&wf.file, &j.id, &j.check_name, status));
        }
    }
    let action_cache = c.run_dir.join("act");
    // With refused jobs, act gets a copy without them (outside the checkout, where a job cannot
    // rewrite it); else the file itself.
    let workflow_path = match wf.without_refused() {
        Some(doc) => {
            let dir = c.run_dir.join("filtered");
            std::fs::create_dir_all(&dir)?;
            let p = dir.join(wf.file.file_name().unwrap_or_default());
            std::fs::write(&p, serde_json::to_vec(&doc)?)?;
            p
        }
        None => c.checkout.join(&wf.file),
    };
    let args = act::run_args(
        c.cfg,
        &Invocation {
            event_name: c.trig.event_name(),
            checkout: c.checkout,
            workflow: &workflow_path,
            event: c.event,
            secrets: c.secrets,
            github_token: c.github_token,
            action_cache: &action_cache,
        },
    );
    let started = Instant::now();
    let limit = c.deadline.saturating_duration_since(Instant::now());
    let (results, timed_out, crashed) = run_act(c.cfg, &args, limit);
    if timed_out || crashed {
        sweep_containers(c.cfg);
    }
    let secs = started.elapsed().as_secs();
    let values: Vec<String> = c.secret_values.iter().map(|(_, v)| v.clone()).collect();
    for j in runnable {
        let outcome = results.outcome(&j.id);
        let conclusion = outcome.conclusion(timed_out);
        let log_path = c.logs.join(format!("{}.log", j.id));
        let raw = results.logs.get(&j.id).map_or("", String::as_str);
        std::fs::write(&log_path, redact(raw, &values))?;
        let why = match (outcome, timed_out, crashed) {
            (Outcome::Unfinished, true, _) => " (stopped at the time limit)",
            (Outcome::Unfinished, _, true) => " (act exited without a result for this job)",
            (Outcome::Unfinished, _, _) => " (no result from act)",
            _ => "",
        };
        let summary = format!(
            "forge-runner: {conclusion} on {} in {secs}s ({}){}{why}",
            c.trig.label(),
            wf.file.display(),
            if c.secrets.is_some() {
                ", with secrets"
            } else {
                ""
            },
        );
        let r = Report {
            conclusion: Some(conclusion),
            summary: Some(summary),
            log: Some(log_path),
            ..c.report_of(&wf.file, &j.id, &j.check_name, "completed")
        };
        report(c.cfg, &r);
        ran.checks.push((r.name, conclusion));
    }
    Ok(())
}

/// The `KEY=value` pairs of a secrets file (act's format).
fn read_secret_values(path: &Path) -> Result<Vec<(String, String)>> {
    let text = std::fs::read_to_string(path)
        .with_context(|| format!("reading the secrets file {}", path.display()))?;
    Ok(text
        .lines()
        .filter(|l| !l.trim_start().starts_with('#'))
        .filter_map(|l| l.split_once('='))
        .map(|(k, v)| (k.trim().to_string(), v.trim().trim_matches('"').to_string()))
        .collect())
}

/// `log` with every secret value (of 4 characters or more) replaced by `***`. act masks
/// secrets in its own output already; this is a second fence before a log leaves the machine
/// (logs are public).
pub fn redact(log: &str, secrets: &[String]) -> String {
    secrets
        .iter()
        .filter(|s| s.len() >= 4)
        .fold(log.to_string(), |acc, s| acc.replace(s.as_str(), "***"))
}

/// Run act with `args`, streaming its JSON log, stopped after `limit`: SIGINT first (act then
/// tears its containers down), SIGKILL 20 s later. Returns (results, timed out, crashed).
fn run_act(cfg: &Config, args: &[String], limit: Duration) -> (Results, bool, bool) {
    let mut cmd = act::command(cfg);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    let Ok(mut child) = cmd.spawn() else {
        eprintln!("forge-runner: could not start act");
        return (Results::default(), false, true);
    };
    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill();
        return (Results::default(), false, true);
    };
    let reader = std::thread::spawn(move || {
        use std::io::BufRead as _;
        let mut r = Results::default();
        let mut reader = BufReader::new(stdout);
        let mut buf = Vec::new();
        // Bytes, not `lines()`: a job's invalid UTF-8 must not end the capture.
        while reader.read_until(b'\n', &mut buf).is_ok_and(|n| n > 0) {
            r.take_line(String::from_utf8_lossy(&buf).trim_end_matches('\n'));
            buf.clear();
        }
        r
    });
    let deadline = Instant::now() + limit;
    let mut timed_out = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break Some(s),
            Ok(None) => {}
            Err(_) => break None,
        }
        if Instant::now() >= deadline {
            timed_out = true;
            interrupt(child.id());
            let grace = Instant::now() + Duration::from_secs(20);
            while Instant::now() < grace && child.try_wait().ok().flatten().is_none() {
                std::thread::sleep(Duration::from_millis(250));
            }
            let _ = child.kill();
            break child.wait().ok();
        }
        std::thread::sleep(Duration::from_millis(250));
    };
    let results = reader.join().unwrap_or_default();
    // act exits non-zero when a job fails; that is not a crash. A crash is an exit (or none)
    // with some job left without a result, which the caller sees as `Unfinished`.
    let crashed = !timed_out && status.is_none_or(|s| s.code().is_none());
    (results, timed_out, crashed)
}

/// SIGINT to `pid` (act stops its jobs on it); a no-op where there is no `kill`.
fn interrupt(pid: u32) {
    let _ = Command::new("kill")
        .args(["-INT", &pid.to_string()])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

/// Remove what a killed act can leave behind on the runner's Docker daemon: containers,
/// volumes and networks whose names start with `act-`. Only safe on a daemon the runner owns
/// (docs/guides/self-host-runner.md): it removes every act-made object there.
fn sweep_containers(cfg: &Config) {
    if !cfg.sweep_after_timeout {
        return;
    }
    let docker = |args: &[&str]| -> Vec<String> {
        let mut c = Command::new("docker");
        c.args(args);
        output(&mut c, "docker")
            .map(|o| {
                o.lines()
                    .map(str::to_string)
                    .filter(|l| !l.is_empty())
                    .collect()
            })
            .unwrap_or_default()
    };
    let containers = docker(&["ps", "-aq", "--filter", "name=^act-"]);
    if !containers.is_empty() {
        let mut a = vec!["rm", "-f"];
        a.extend(containers.iter().map(String::as_str));
        docker(&a);
    }
    let volumes = docker(&["volume", "ls", "-q", "--filter", "name=^act-"]);
    if !volumes.is_empty() {
        let mut a = vec!["volume", "rm", "-f"];
        a.extend(volumes.iter().map(String::as_str));
        docker(&a);
    }
    let networks = docker(&["network", "ls", "-q", "--filter", "name=^act-"]);
    if !networks.is_empty() {
        let mut a = vec!["network", "rm"];
        a.extend(networks.iter().map(String::as_str));
        docker(&a);
    }
}

/// Remove act's shared tool cache volume before a run, so one run's tools never reach the next
/// (a job can write to it). Only on a daemon the runner owns.
pub fn reset_toolcache(cfg: &Config) {
    if cfg.sweep_after_timeout {
        let _ = Command::new("docker")
            .args(["volume", "rm", "-f", "act-toolcache"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(extra: &str) -> Config {
        Config::parse(&format!(
            "state_dir = \"/s\"\n{extra}\n[[repo]]\nrepo = \"a/b\""
        ))
        .unwrap()
    }

    fn push() -> Push {
        Push {
            refname: "refs/heads/main".into(),
            oid: "ab".repeat(20),
            before: None,
        }
    }

    #[test]
    fn a_completed_report_carries_the_log_only_with_a_storage_profile() {
        let r = Report {
            repo: "a/b",
            oid: "abc",
            name: "ci / build".into(),
            external_id: "x".into(),
            status: "completed",
            conclusion: Some("success"),
            summary: Some("ok".into()),
            log: Some("/l/build.log".into()),
        };
        let without = report_args(&cfg(""), &r);
        assert!(!without.contains(&"--log".to_string()));
        assert!(without.windows(2).any(|w| w == ["--conclusion", "success"]));
        assert!(without.windows(2).any(|w| w == ["--external-id", "x"]));
        let with = report_args(&cfg("log_storage = \"logs\"\npublic_log = true"), &r);
        assert!(with.windows(2).any(|w| w == ["--log", "/l/build.log"]));
        assert!(with.windows(2).any(|w| w == ["--storage", "logs"]));
        // A private repository's run cannot carry a log URL any more: `public_log` is inert.
        assert!(!with.contains(&"--public-log".to_string()));
    }

    #[test]
    fn run_ids_are_fixed_length_and_never_collide_on_long_names() {
        let f = Path::new(".forge/workflows/ci.yml");
        let id = external_id("a/b", &push(), f, "build");
        assert!(id.starts_with("forge-runner:") && id.len() == 13 + 40);
        assert_eq!(id, external_id("a/b", &push(), f, "build"), "stable");
        assert_ne!(
            id,
            external_id(
                "a/b",
                &push(),
                Path::new(".forge/workflows/other.yml"),
                "build"
            ),
            "the file is part of it"
        );
        let long = |s: &str| Push {
            refname: format!("refs/heads/{}{s}", "x".repeat(200)),
            ..push()
        };
        assert_ne!(
            external_id("a/b", &long("1"), f, "b"),
            external_id("a/b", &long("2"), f, "b")
        );
    }

    fn pull(fork: bool, source: &str) -> PullEvent {
        PullEvent {
            action: "synchronize",
            before: Some("aa".repeat(20)),
            pr: PullRow {
                number: 7,
                title: "Add $(evil)".into(),
                author: "MEMBER".into(),
                state: "open".into(),
                base_ref: "refs/heads/main".into(),
                base_tip: None,
                head_oid: "cd".repeat(20),
                repo_id: "REPO".into(),
                source_repo_id: if fork { "FORK" } else { "REPO" }.into(),
                source_ref_name: Some(source.into()),
                draft: true,
            },
        }
    }

    fn trusting() -> RepoConfig {
        Config::parse(
            "state_dir = \"/s\"\n[[repo]]\nrepo = \"a/b\"\ntrusted_refs = [\"refs/heads/release/*\"]\nsecrets_file = \"/sec\"",
        )
        .unwrap()
        .repos
        .remove(0)
    }

    #[test]
    fn a_pull_request_gets_secrets_only_from_a_trusted_branch_here_by_a_member() {
        let r = trusting();
        let here = pull(false, "refs/heads/release/1");
        assert!(
            pull_trusted(&r, &here.pr, true),
            "trusted branch here, member author"
        );
        assert!(
            !pull_trusted(&r, &here.pr, false),
            "a non-member's PR: no secrets"
        );
        let fork = pull(true, "refs/heads/release/1");
        assert!(
            !pull_trusted(&r, &fork.pr, true),
            "a fork's head never gets secrets, even a member's, even from a trusted name"
        );
        let feature = pull(false, "refs/heads/feature");
        assert!(
            !pull_trusted(&r, &feature.pr, true),
            "an untrusted branch: no secrets"
        );
        let t = Trigger::Pull {
            event: Box::new(fork),
            author_member: true,
        };
        assert!(!t.trusted(&r));
        let default = Config::parse("state_dir = \"/s\"\n[[repo]]\nrepo = \"a/b\"")
            .unwrap()
            .repos
            .remove(0);
        assert!(
            !pull_trusted(&default, &here.pr, true),
            "no trusted_refs: nothing gets secrets"
        );
    }

    #[test]
    fn a_pull_requests_checks_are_named_and_keyed_apart_from_pushes() {
        let t = Trigger::Pull {
            event: Box::new(pull(false, "refs/heads/feature")),
            author_member: true,
        };
        assert_eq!(t.event_name(), "pull_request");
        assert_eq!(t.check_name("ci / build"), "ci / build (pull_request)");
        let long = t.check_name(&"x".repeat(200));
        assert_eq!(long.chars().count(), 100);
        assert!(long.ends_with(" (pull_request)"));
        let k = t.key();
        assert_eq!(k.refname, "refs/pull/7/head");
        assert_eq!(k.oid, "cd".repeat(20));
        let f = Path::new(".forge/workflows/ci.yml");
        let as_push = Push {
            refname: "refs/heads/feature".into(),
            ..k.clone()
        };
        assert_ne!(
            external_id("a/b", &k, f, "build"),
            external_id("a/b", &as_push, f, "build"),
            "a PR run and the branch's push run are separate check runs"
        );
        let p = Trigger::Push(push());
        assert_eq!(
            (p.event_name(), p.check_name("ci / build").as_str()),
            ("push", "ci / build")
        );
    }

    #[test]
    fn the_pull_request_event_has_the_shape_act_reads() {
        let ev = pull(true, "refs/heads/feature");
        let e = pull_event_json("alice/p", &ev, Some(&"bb".repeat(20)), "dash://FORK", false);
        assert_eq!(e["action"], "synchronize");
        assert_eq!(e["number"], 7, "act: github.ref = refs/pull/<number>/merge");
        assert_eq!(
            e["pull_request"]["head"]["ref"], "feature",
            "github.head_ref"
        );
        assert_eq!(e["pull_request"]["base"]["ref"], "main", "github.base_ref");
        assert_eq!(e["pull_request"]["head"]["sha"], "cd".repeat(20));
        assert_eq!(e["pull_request"]["base"]["sha"], "bb".repeat(20));
        assert_eq!(e["pull_request"]["draft"], true);
        assert_eq!(e["pull_request"]["head"]["repo"]["fork"], true);
        assert_eq!(e["pull_request"]["base"]["repo"]["full_name"], "alice/p");
        assert_eq!(e["before"], "aa".repeat(20));
        assert_eq!(e["after"], "cd".repeat(20));
        assert_eq!(e["forge"]["trusted"], false);
        let opened = PullEvent {
            action: "opened",
            before: None,
            ..pull(false, "refs/heads/feature")
        };
        let e = pull_event_json("alice/p", &opened, None, "dash://alice/p", true);
        assert!(e.get("before").is_none());
        assert_eq!(e["pull_request"]["base"]["sha"], "0".repeat(40));
        assert_eq!(e["pull_request"]["head"]["repo"]["fork"], false);
    }

    #[test]
    fn a_forks_head_is_fetched_from_the_fork() {
        let r = trusting();
        assert_eq!(
            r.pull_source_url(&pull(false, "refs/heads/x").pr),
            "dash://a/b"
        );
        assert_eq!(
            r.pull_source_url(&pull(true, "refs/heads/x").pr),
            "dash://FORK"
        );
        let mut t = r.clone();
        t.fork_url = Some("/tmp/forks/{id}".into());
        assert_eq!(
            t.pull_source_url(&pull(true, "refs/heads/x").pr),
            "/tmp/forks/FORK"
        );
    }

    #[test]
    fn the_event_is_a_push_payload() {
        let e = event_json("alice/p", &push());
        assert_eq!(e["ref"], "refs/heads/main");
        assert_eq!(e["after"], "ab".repeat(20));
        assert_eq!(e["before"], "0".repeat(40));
        assert_eq!(e["repository"]["name"], "p");
    }

    #[test]
    fn secret_values_never_reach_a_log() {
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join("s");
        std::fs::write(
            &f,
            "# comment\nTOKEN=abcd1234\nSHORT=ab\nQUOTED=\"xyz789\"\n",
        )
        .unwrap();
        let v = read_secret_values(&f).unwrap();
        assert_eq!(v[0], ("TOKEN".to_string(), "abcd1234".to_string()));
        let values: Vec<String> = v.into_iter().map(|(_, v)| v).collect();
        assert_eq!(
            redact("t=abcd1234 q=xyz789 ab", &values),
            "t=*** q=*** ab",
            "too-short values are left"
        );
    }

    #[test]
    fn a_hung_act_is_stopped_and_a_missing_act_is_a_crash() {
        let c = cfg("[bin]\nact = \"sleep\"");
        let (_, timed_out, _) = run_act(&c, &["5".into()], Duration::from_millis(600));
        assert!(timed_out);
        let c = cfg("[bin]\nact = \"/nonexistent/act\"");
        let (_, timed_out, crashed) = run_act(&c, &[], Duration::from_secs(5));
        assert!(!timed_out && crashed);
        let c = cfg("[bin]\nact = \"false\"");
        let (_, _, crashed) = run_act(&c, &[], Duration::from_secs(5));
        assert!(!crashed, "a non-zero exit (a failed job) is not a crash");
    }
}
