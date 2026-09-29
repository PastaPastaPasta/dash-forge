//! One push, end to end: check the commit out, read its workflows, report every job queued, run
//! each workflow file with act, and report each job's result with its log.
//!
//! Every report goes through `dg ci report` (the CLI's own path: validation, the replace-or-create
//! choice, the log upload and its SHA-256, the checkRun-only key in DASH_FORGE_KEY). A job's
//! reports share one run id (`--external-id`, a hash of the repo, ref, commit, workflow file and
//! job), so its queued, in-progress and completed reports update one check run.

use std::io::{BufRead as _, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use anyhow::{bail, Context as _, Result};
use serde_json::json;

use crate::act::{self, Invocation, Outcome, Results};
use crate::config::{Config, RepoConfig};
use crate::watch::Push;
use crate::workflow::{self, Job, PushFacts};

/// What a report says (the arguments `dg ci report` takes).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Report<'a> {
    pub repo: &'a str,
    pub oid: &'a str,
    pub name: &'a str,
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
        r.name,
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
    if let (Some(log), Some(storage)) = (&r.log, &cfg.log_storage) {
        a.extend([
            "--log".into(),
            log.display().to_string(),
            "--storage".into(),
            storage.clone(),
        ]);
        if cfg.public_log {
            a.push("--public-log".into());
        }
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

/// The event act gets (`-e`): a GitHub-shaped `push` payload, enough for `github.ref`,
/// `github.sha` and `github.event.*` in workflows.
pub fn event_json(repo: &str, push: &Push) -> serde_json::Value {
    json!({
        "ref": push.refname,
        "before": push.before.clone().unwrap_or_else(|| "0".repeat(push.oid.len())),
        "after": push.oid,
        "repository": { "full_name": repo, "name": repo.rsplit('/').next().unwrap_or(repo) },
        "forge": { "remote": format!("dash://{repo}") },
    })
}

/// Runs a command, returning stdout; stderr goes to the runner's log.
fn output(cmd: &mut Command, what: &str) -> Result<String> {
    let out = cmd
        .stdin(Stdio::null())
        .output()
        .with_context(|| format!("{what}: could not start"))?;
    if !out.status.success() {
        bail!(
            "{what} failed ({}): {}",
            out.status,
            String::from_utf8_lossy(&out.stderr).trim()
        );
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

/// The per-repo directory under the state dir.
pub fn repo_dir(cfg: &Config, repo: &RepoConfig) -> PathBuf {
    cfg.state_dir
        .join("work")
        .join(repo.repo.replace('/', "__"))
}

/// Fetch `push.refname` into the repo's bare cache (dash:// serves full and partial fetches, not
/// shallow ones: E205), so each push fetches only what is new, and check that it is `push.oid`.
fn fetch(cfg: &Config, repo: &RepoConfig, push: &Push, cache: &Path) -> Result<()> {
    let git = |args: &[&str]| {
        let mut c = with_network(Command::new(&cfg.bin.git), cfg);
        c.arg("--git-dir").arg(cache).args(args);
        output(&mut c, &format!("git {}", args.first().unwrap_or(&"")))
    };
    if !cache.join("HEAD").exists() {
        std::fs::create_dir_all(cache)?;
        git(&["init", "-q", "--bare"])?;
    }
    let dest = format!("+{}:refs/forge-runner/fetched", push.refname);
    git(&["fetch", "-q", &repo.url(), &dest])?;
    let head = git(&["rev-parse", "refs/forge-runner/fetched"])?;
    if head.trim() != push.oid {
        bail!(
            "{} moved while it was fetched ({} now, {} expected); the next poll runs the new tip",
            push.refname,
            head.trim(),
            push.oid
        );
    }
    Ok(())
}

/// A fresh clone of the cache in `dir`, detached at the commit: act reads `github.sha` and
/// `github.ref` from the checkout's git metadata. Its origin is the cache on disk, never
/// dash://, and nothing a job writes survives into the next run.
fn checkout(cfg: &Config, cache: &Path, push: &Push, dir: &Path) -> Result<()> {
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
        &push.oid,
    ]);
    output(&mut co, "git checkout")?;
    Ok(())
}

/// The paths `push` changed, when it has a previous tip the cache holds (for `on.push.paths`).
fn changed_paths(cfg: &Config, cache: &Path, push: &Push) -> Option<Vec<String>> {
    let before = push.before.as_deref()?;
    let mut c = Command::new(&cfg.bin.git);
    c.arg("--git-dir").arg(cache).args([
        "diff",
        "--name-only",
        "--no-renames",
        "-z",
        before,
        &push.oid,
    ]);
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

/// What a push produced: each check name and its conclusion.
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

/// A report of one job with `status` and nothing else yet.
fn base_report<'a>(
    repo: &'a RepoConfig,
    push: &'a Push,
    file: &Path,
    job: &'a Job,
    status: &'static str,
) -> Report<'a> {
    Report {
        repo: &repo.repo,
        oid: &push.oid,
        name: &job.check_name,
        external_id: external_id(&repo.repo, push, file, &job.id),
        status,
        conclusion: None,
        summary: None,
        log: None,
    }
}

/// A completed report whose conclusion is `failure` for a reason the runner found itself (bad
/// YAML, a refused job): the check run says why, and nothing ran.
fn report_refusal(cfg: &Config, repo: &RepoConfig, push: &Push, name: &str, id: String, why: &str) {
    report(
        cfg,
        &Report {
            repo: &repo.repo,
            oid: &push.oid,
            name,
            external_id: id,
            status: "completed",
            conclusion: Some("failure"),
            summary: Some(format!("forge-runner did not run this: {why}")),
            log: None,
        },
    );
}

/// Run `push` of `repo`: every job of every workflow file that runs on it, reported queued →
/// in_progress → completed, one act run per file. Secrets go to act only when the ref is
/// trusted. `run_dir` is this run's own directory (checkout, event, logs, act's caches).
pub fn run_push(cfg: &Config, repo: &RepoConfig, push: &Push, run_dir: &Path) -> Result<Ran> {
    let cache = repo_dir(cfg, repo).join("cache.git");
    fetch(cfg, repo, push, &cache)?;
    let co = run_dir.join("checkout");
    checkout(cfg, &cache, push, &co)?;
    let mut ran = Ran::default();
    let Some(wf_dir) = workflow_dir(cfg, &co) else {
        eprintln!(
            "forge-runner: {} {} has no {}; nothing to run",
            repo.repo,
            &push.oid[..12],
            cfg.workflow_dirs.join(" or ")
        );
        return Ok(ran);
    };
    let changed = changed_paths(cfg, &cache, push);
    let facts = PushFacts {
        refname: &push.refname,
        changed: changed.as_deref(),
    };
    let plan = workflow::plan(&co, &wf_dir, &facts, repo.allow_container_options);
    for b in &plan.broken {
        let name: String = format!("{} (invalid workflow)", b.file.display())
            .chars()
            .take(100)
            .collect();
        let id = external_id(&repo.repo, push, &b.file, "");
        report_refusal(cfg, repo, push, &name, id, &b.reason);
        ran.checks.push((name, "failure"));
    }
    let event = run_dir.join("event.json");
    std::fs::write(&event, serde_json::to_vec(&event_json(&repo.repo, push))?)?;
    let trusted = repo.trusted(&push.refname);
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
        push,
        checkout: &co,
        event: &event,
        secrets: secrets.as_deref(),
        secret_values: &secret_values,
        github_token,
        logs: &logs,
        run_dir,
        deadline,
    };
    for wf in &plan.run {
        run_workflow(&ctx, wf, &mut ran)?;
    }
    Ok(ran)
}

/// What every workflow file of one push shares.
struct RunCtx<'a> {
    cfg: &'a Config,
    repo: &'a RepoConfig,
    push: &'a Push,
    checkout: &'a Path,
    event: &'a Path,
    secrets: Option<&'a Path>,
    secret_values: &'a [(String, String)],
    github_token: &'a str,
    logs: &'a Path,
    run_dir: &'a Path,
    deadline: Instant,
}

/// Run one workflow file with act (its refused jobs reported, not run) and report its jobs.
fn run_workflow(c: &RunCtx<'_>, wf: &workflow::Workflow, ran: &mut Ran) -> Result<()> {
    let (refused, runnable): (Vec<&Job>, Vec<&Job>) =
        wf.jobs.iter().partition(|j| j.refused.is_some());
    for j in &refused {
        let id = external_id(&c.repo.repo, c.push, &wf.file, &j.id);
        report_refusal(
            c.cfg,
            c.repo,
            c.push,
            &j.check_name,
            id,
            j.refused.as_deref().unwrap_or(""),
        );
        ran.checks.push((j.check_name.clone(), "failure"));
    }
    if runnable.is_empty() {
        return Ok(());
    }
    for j in &runnable {
        report(c.cfg, &base_report(c.repo, c.push, &wf.file, j, "queued"));
    }
    for j in &runnable {
        report(
            c.cfg,
            &base_report(c.repo, c.push, &wf.file, j, "in_progress"),
        );
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
            c.push.refname,
            wf.file.display(),
            if c.secrets.is_some() {
                ", with secrets"
            } else {
                ""
            },
        );
        report(
            c.cfg,
            &Report {
                conclusion: Some(conclusion),
                summary: Some(summary),
                log: Some(log_path),
                ..base_report(c.repo, c.push, &wf.file, j, "completed")
            },
        );
        ran.checks.push((j.check_name.clone(), conclusion));
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
        let mut r = Results::default();
        for line in BufReader::new(stdout)
            .lines()
            .map_while(std::result::Result::ok)
        {
            r.take_line(&line);
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
            name: "ci / build",
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
        assert!(with.contains(&"--public-log".to_string()));
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
