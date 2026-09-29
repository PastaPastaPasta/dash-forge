//! One push, end to end: check the commit out, list its jobs, report them queued, run them with
//! act, and report each one's result with its log.
//!
//! Every report goes through `dg ci report` (the CLI's own path: validation, the replace-or-create
//! choice, the log upload and its SHA-256, the checkRun-only key in DASH_FORGE_KEY). The run id
//! (`--external-id forge-runner:<ref>:<oid>:<job>`) ties the reports of one job together, so the
//! queued, in-progress and completed reports update one check run.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use anyhow::{bail, Context as _, Result};
use serde_json::json;

use crate::act::{self, Job, Outcome};
use crate::config::{Config, RepoConfig};
use crate::watch::Push;

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
        a.extend(["--summary".into(), s.clone()]);
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

/// The run id a job's reports share (≤ 120 characters: the contract's `externalId` cap).
pub fn external_id(push: &Push, job: &str) -> String {
    let short = |s: &str| s.chars().take(80).collect::<String>();
    format!("forge-runner:{}:{}:{}", short(&push.refname), push.oid, job)
        .chars()
        .take(120)
        .collect()
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

/// Check `oid` out into a fresh directory under `work` (a partial clone of the ref, so a
/// large repository is not copied whole). The runner never keeps credentials in it.
fn checkout(cfg: &Config, repo: &RepoConfig, push: &Push, dir: &Path) -> Result<()> {
    if dir.exists() {
        std::fs::remove_dir_all(dir)?;
    }
    std::fs::create_dir_all(dir)?;
    let git = |args: &[&str]| {
        let mut c = with_network(Command::new(&cfg.bin.git), cfg);
        c.arg("-C").arg(dir).args(args);
        output(&mut c, &format!("git {}", args.first().unwrap_or(&"")))
    };
    git(&["init", "-q"])?;
    git(&["fetch", "-q", "--depth", "1", &repo.url(), &push.refname])?;
    let head = git(&["rev-parse", "FETCH_HEAD"])?;
    if head.trim() != push.oid {
        bail!(
            "{} moved while it was fetched ({} now, {} expected); the next poll runs the new tip",
            push.refname,
            head.trim(),
            push.oid
        );
    }
    git(&[
        "-c",
        "advice.detachedHead=false",
        "checkout",
        "-q",
        "--detach",
        &push.oid,
    ])?;
    Ok(())
}

/// The first configured workflow directory the commit has.
fn workflow_dir(cfg: &Config, checkout: &Path) -> Option<PathBuf> {
    cfg.workflow_dirs
        .iter()
        .map(|d| checkout.join(d))
        .find(|p| p.is_dir())
}

/// What a push produced: each job and its conclusion.
#[derive(Debug, Default)]
pub struct Ran {
    pub jobs: Vec<(Job, &'static str)>,
}

/// Report one step of one job; a failed report is logged, not fatal (the run goes on, and a
/// later report of the same run id carries the state forward).
fn report(cfg: &Config, r: &Report<'_>) {
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
        }
        Err(e) => eprintln!(
            "forge-runner: report of {} {} failed: {e:#}",
            r.repo, r.name
        ),
    }
}

/// A report of `job` of `push` with `status` and nothing else yet.
fn base_report<'a>(
    repo: &'a RepoConfig,
    push: &'a Push,
    job: &'a Job,
    status: &'static str,
) -> Report<'a> {
    Report {
        repo: &repo.repo,
        oid: &push.oid,
        name: &job.check_name,
        external_id: external_id(push, &job.id),
        status,
        conclusion: None,
        summary: None,
        log: None,
    }
}

/// Run `push` of `repo`: every job its workflows define, reported queued → in_progress →
/// completed. Secrets go to act only when the ref is trusted.
pub fn run_push(cfg: &Config, repo: &RepoConfig, push: &Push) -> Result<Ran> {
    let work = cfg
        .state_dir
        .join("work")
        .join(repo.repo.replace('/', "__"));
    let co = work.join("checkout");
    checkout(cfg, repo, push, &co)?;
    let Some(wf) = workflow_dir(cfg, &co) else {
        eprintln!(
            "forge-runner: {} {} has no {}; nothing to run",
            repo.repo,
            &push.oid[..12],
            cfg.workflow_dirs.join(" or ")
        );
        return Ok(Ran::default());
    };
    let mut list = Command::new(&cfg.bin.act);
    list.args(["push", "-l", "-C"])
        .arg(&co)
        .arg("-W")
        .arg(&wf)
        .args([
            "--no-recurse",
            "--env-file",
            "/dev/null",
            "--var-file",
            "/dev/null",
        ]);
    let jobs = act::parse_list(&output(&mut list, "act -l")?);
    if jobs.is_empty() {
        return Ok(Ran::default());
    }
    for j in &jobs {
        report(cfg, &base_report(repo, push, j, "queued"));
    }
    let event = work.join("event.json");
    std::fs::write(&event, serde_json::to_vec(&event_json(&repo.repo, push))?)?;
    let secrets = repo
        .trusted(&push.refname)
        .then(|| repo.secrets_file.clone())
        .flatten();
    for j in &jobs {
        report(cfg, &base_report(repo, push, j, "in_progress"));
    }
    let args = act::run_args(cfg, &co, &wf, &event, secrets.as_deref(), None);
    let started = Instant::now();
    let (log, timed_out) = run_with_timeout(
        Command::new(&cfg.bin.act).args(&args),
        Duration::from_secs(cfg.job_timeout_secs),
    )?;
    let results = act::parse_json_log(&log);
    let secs = started.elapsed().as_secs();
    let logs = work.join("logs");
    std::fs::create_dir_all(&logs)?;
    let secret_values = secrets
        .as_deref()
        .map(read_secret_values)
        .transpose()?
        .unwrap_or_default();
    let mut ran = Ran::default();
    for j in &jobs {
        let outcome = results.outcome(&j.id);
        let conclusion = outcome.conclusion(timed_out);
        let log_path = logs.join(format!("{}.log", j.id));
        let raw = results.logs.get(&j.id).map_or("", String::as_str);
        std::fs::write(&log_path, redact(raw, &secret_values))?;
        let summary = format!(
            "forge-runner: {} on {} in {secs}s{}{}",
            conclusion,
            push.refname,
            if secrets.is_some() {
                ", with secrets"
            } else {
                ""
            },
            if outcome == Outcome::Unfinished {
                " (no result from act)"
            } else {
                ""
            }
        );
        report(
            cfg,
            &Report {
                conclusion: Some(conclusion),
                summary: Some(summary),
                log: Some(log_path),
                ..base_report(repo, push, j, "completed")
            },
        );
        ran.jobs.push((j.clone(), conclusion));
    }
    Ok(ran)
}

/// The values of a `KEY=value` secrets file (act's format), for [`redact`].
fn read_secret_values(path: &Path) -> Result<Vec<String>> {
    let text = std::fs::read_to_string(path)
        .with_context(|| format!("reading the secrets file {}", path.display()))?;
    Ok(text
        .lines()
        .filter(|l| !l.trim_start().starts_with('#'))
        .filter_map(|l| l.split_once('='))
        .map(|(_, v)| v.trim().trim_matches('"').to_string())
        .filter(|v| v.len() >= 4)
        .collect())
}

/// `log` with every secret value replaced by `***`. act masks secrets in its own output
/// already; this is a second fence before a log leaves the machine (logs are public).
pub fn redact(log: &str, secrets: &[String]) -> String {
    secrets
        .iter()
        .fold(log.to_string(), |acc, s| acc.replace(s.as_str(), "***"))
}

/// Run `cmd`, capturing stdout, killing it after `limit`. Returns (stdout, timed out).
fn run_with_timeout(cmd: &mut Command, limit: Duration) -> Result<(String, bool)> {
    use std::io::Read as _;
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .context("starting act")?;
    let mut stdout = child.stdout.take().context("act stdout")?;
    let reader = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = stdout.read_to_string(&mut s);
        s
    });
    let deadline = Instant::now() + limit;
    let timed_out = loop {
        if child.try_wait()?.is_some() {
            break false;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            break true;
        }
        std::thread::sleep(Duration::from_millis(500));
    };
    let out = reader.join().unwrap_or_default();
    Ok((out, timed_out))
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
    fn a_jobs_reports_share_one_run_id() {
        let id = external_id(&push(), "build");
        assert_eq!(
            id,
            format!("forge-runner:refs/heads/main:{}:build", "ab".repeat(20))
        );
        assert!(id.len() <= 120);
        let long = Push {
            refname: format!("refs/heads/{}", "x".repeat(200)),
            ..push()
        };
        assert!(external_id(&long, "build").chars().count() <= 120);
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
        assert_eq!(
            v,
            ["abcd1234", "xyz789"],
            "too-short values are not redacted (they would eat the log)"
        );
        assert_eq!(redact("t=abcd1234 q=xyz789 ab", &v), "t=*** q=*** ab");
    }

    #[test]
    fn a_hung_act_is_stopped() {
        let (_, timed_out) =
            run_with_timeout(Command::new("sleep").arg("5"), Duration::from_millis(600)).unwrap();
        assert!(timed_out);
        let (out, timed_out) =
            run_with_timeout(Command::new("echo").arg("hi"), Duration::from_secs(5)).unwrap();
        assert!(!timed_out);
        assert_eq!(out.trim(), "hi");
    }
}
