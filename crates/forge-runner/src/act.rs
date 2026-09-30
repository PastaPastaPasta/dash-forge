//! Driving nektos/act: the command line (one builder for every invocation), its environment,
//! and each job's result read from act's JSON log (`--json`).

use std::collections::BTreeMap;
use std::path::Path;
use std::process::Command;

use serde::Deserialize;

use crate::config::Config;

/// How a job ended, from act's `jobResult`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    /// `success`.
    Success,
    /// `failure`.
    Failure,
    /// `skipped` (an `if:` that was false).
    Skipped,
    /// No result: act was stopped (timeout), crashed, or never started the job.
    Unfinished,
}

impl Outcome {
    /// The check-run conclusion for this outcome.
    pub fn conclusion(self, timed_out: bool) -> &'static str {
        match self {
            Outcome::Success => "success",
            Outcome::Skipped => "skipped",
            Outcome::Unfinished if timed_out => "timed_out",
            // A crash, or a job act never started, fails the check; it did not pass.
            Outcome::Failure | Outcome::Unfinished => "failure",
        }
    }
}

#[derive(Deserialize)]
struct Line {
    #[serde(rename = "jobID")]
    job_id: Option<String>,
    #[serde(rename = "jobResult")]
    job_result: Option<String>,
    msg: Option<String>,
    raw_output: Option<bool>,
}

/// The most of one job's log kept (the rest is cut, with a note).
pub const MAX_JOB_LOG_BYTES: usize = 16 * 1024 * 1024;

/// What act's JSON log says: each job's result, and each job's log text (the step output and
/// act's step lines, in order).
#[derive(Debug, Default)]
pub struct Results {
    /// Job id → outcome, for jobs that finished.
    pub outcomes: BTreeMap<String, Outcome>,
    /// Job id → its log.
    pub logs: BTreeMap<String, String>,
}

impl Results {
    /// A job's outcome ([`Outcome::Unfinished`] when act reported none).
    pub fn outcome(&self, job: &str) -> Outcome {
        self.outcomes
            .get(job)
            .copied()
            .unwrap_or(Outcome::Unfinished)
    }

    /// Take one line of act's `--json` output. Lines that are not JSON (act's own warnings) are
    /// skipped; a job's log stops growing at [`MAX_JOB_LOG_BYTES`].
    pub fn take_line(&mut self, line: &str) {
        let Ok(l) = serde_json::from_str::<Line>(line) else {
            return;
        };
        let Some(job) = l.job_id else { return };
        if let Some(res) = l.job_result.as_deref() {
            let o = match res {
                "success" => Outcome::Success,
                "skipped" => Outcome::Skipped,
                _ => Outcome::Failure,
            };
            self.outcomes.insert(job.clone(), o);
        }
        if let Some(msg) = l.msg {
            let log = self.logs.entry(job).or_default();
            if log.len() >= MAX_JOB_LOG_BYTES {
                return;
            }
            let room = MAX_JOB_LOG_BYTES - log.len();
            if msg.len() > room {
                let mut cut = room;
                while !msg.is_char_boundary(cut) {
                    cut -= 1;
                }
                log.push_str(&msg[..cut]);
                log.push_str("\n[forge-runner: log cut at 16 MiB]\n");
                return;
            }
            log.push_str(&msg);
            if l.raw_output != Some(true) && !msg.ends_with('\n') {
                log.push('\n');
            }
        }
    }
}

/// Read a whole `--json` output (the runner streams it through [`Results::take_line`]).
#[cfg(test)]
pub fn parse_json_log(out: &str) -> Results {
    let mut r = Results::default();
    for line in out.lines() {
        r.take_line(line);
    }
    r
}

/// The environment variables act may see; everything else is cleared. Forge keys, cloud
/// credentials and anything else in the runner's environment never reach act.
const ENV_ALLOW: [&str; 6] = ["PATH", "HOME", "TMPDIR", "USER", "LANG", "TZ"];
const ENV_ALLOW_PREFIXES: [&str; 2] = ["DOCKER_", "XDG_"];

/// An act command with a cleared environment (plus [`ENV_ALLOW`] / [`ENV_ALLOW_PREFIXES`]).
pub fn command(cfg: &Config) -> Command {
    let mut c = Command::new(&cfg.bin.act);
    c.env_clear();
    for (k, v) in std::env::vars_os() {
        let name = k.to_string_lossy();
        if ENV_ALLOW.contains(&name.as_ref())
            || ENV_ALLOW_PREFIXES.iter().any(|p| name.starts_with(p))
        {
            c.env(&k, v);
        }
    }
    // act reads the URL jobs reach its artifact server at from its own environment.
    if let Some(url) = cfg.artifact_server_url.as_ref().filter(|_| cfg.artifacts) {
        c.env("ACTIONS_RUNTIME_URL", url);
    }
    c
}

/// One act invocation of one workflow file.
pub struct Invocation<'a> {
    /// The event act runs (`push`, `pull_request`): its first argument.
    pub event_name: &'a str,
    /// The checkout (`-C`).
    pub checkout: &'a Path,
    /// The workflow file (`-W`), inside the checkout.
    pub workflow: &'a Path,
    /// The event payload (`-e`).
    pub event: &'a Path,
    /// A secrets file, for a trusted ref only.
    pub secrets: Option<&'a Path>,
    /// Whether `secrets` sets a non-empty `GITHUB_TOKEN`. Then act takes it from that file;
    /// otherwise it is forced empty (act would fill it from the host's `gh auth token`). The
    /// value never goes on act's command line, where `ps` shows it to every local user.
    pub secrets_set_github_token: bool,
    /// Act's action cache and host workspaces for this run (`--action-cache-path`): per run, so
    /// nothing one run puts there reaches another.
    pub action_cache: &'a Path,
    /// Where act's artifact server keeps this workflow run's uploads (`--artifact-server-path`),
    /// with `artifacts = true`; `None` starts no server.
    pub artifacts: Option<&'a Path>,
}

/// The act arguments for `inv`: the event, one workflow file, isolation settings from
/// `cfg`, and `--json`. Every act call the runner makes is built here.
pub fn run_args(cfg: &Config, inv: &Invocation<'_>) -> Vec<String> {
    let mut a: Vec<String> = vec![
        inv.event_name.into(),
        "-C".into(),
        inv.checkout.display().to_string(),
        "-W".into(),
        inv.workflow.display().to_string(),
        "-e".into(),
        inv.event.display().to_string(),
        "--json".into(),
        // act reads `.actrc`, `.env`, `.secrets`, `.vars` and `.input` from its working
        // directory and the checkout by default; the checkout is untrusted, so each is named.
        "--env-file".into(),
        "/dev/null".into(),
        "--var-file".into(),
        "/dev/null".into(),
        "--input-file".into(),
        "/dev/null".into(),
        "--secret-file".into(),
        inv.secrets
            .map_or_else(|| "/dev/null".into(), |p| p.display().to_string()),
    ];
    if inv.secrets.is_none() || !inv.secrets_set_github_token {
        // An empty value only: act lets `-s` override the secrets file and fills a missing
        // token from `gh auth token`. A real token comes from the file, never from argv.
        a.extend(["-s".into(), "GITHUB_TOKEN=".into()]);
    }
    a.extend([
        // No shared cache server: one repository's job could otherwise read or poison another's
        // `actions/cache` entries.
        "--no-cache-server".into(),
        "--action-cache-path".into(),
        inv.action_cache.display().to_string(),
        "--network".into(),
        cfg.container_network.clone(),
        "--rm".into(),
        "--pull=false".into(),
    ]);
    if !cfg.mount_docker_socket {
        // `-`: act does not bind the Docker socket into job containers (its default does).
        a.push("--container-daemon-socket".into());
        a.push("-".into());
    }
    for (label, image) in &cfg.platforms {
        a.push("-P".into());
        a.push(format!("{label}={image}"));
    }
    if let Some(opts) = &cfg.container_options {
        a.push("--container-options".into());
        a.push(opts.clone());
    }
    if let Some(dir) = inv.artifacts {
        a.extend([
            "--artifact-server-path".into(),
            dir.display().to_string(),
            "--artifact-server-port".into(),
            cfg.artifact_server_port.to_string(),
        ]);
        if let Some(addr) = &cfg.artifact_server_addr {
            a.extend(["--artifact-server-addr".into(), addr.clone()]);
        }
    }
    a
}

#[cfg(test)]
mod tests {
    use super::*;

    // Real lines from act 0.2.89 (`--json`), trimmed.
    const LOG: &str = r#"{"level":"info","msg":"Using docker host 'unix:///var/run/docker.sock', and daemon socket '-'"}
level=warning msg= ⚠ Apple M-series ⚠
{"job":"ci/build","jobID":"build","msg":"⭐ Run Main echo hi","stage":"Main"}
{"job":"ci/build","jobID":"build","msg":"hi\n","raw_output":true,"stage":"Main"}
{"job":"ci/build","jobID":"build","jobResult":"success","msg":"🏁  Job succeeded"}
{"job":"ci/test ","jobID":"test","msg":"t\n","raw_output":true}
{"job":"ci/test ","jobID":"test","jobResult":"failure","msg":"🏁  Job failed"}
"#;

    #[test]
    fn reads_each_jobs_result_and_log() {
        let r = parse_json_log(LOG);
        assert_eq!(r.outcome("build"), Outcome::Success);
        assert_eq!(r.outcome("test"), Outcome::Failure);
        assert_eq!(r.outcome("lint"), Outcome::Unfinished);
        assert_eq!(
            r.logs["build"],
            "⭐ Run Main echo hi\nhi\n🏁  Job succeeded\n"
        );
        assert!(r.logs["test"].starts_with("t\n"));
        assert_eq!(Outcome::Unfinished.conclusion(true), "timed_out");
        assert_eq!(
            Outcome::Unfinished.conclusion(false),
            "failure",
            "a crash is a failure, not a cancel"
        );
        assert_eq!(Outcome::Skipped.conclusion(false), "skipped");
    }

    #[test]
    fn a_job_log_is_capped() {
        let mut r = Results::default();
        let big = "x".repeat(MAX_JOB_LOG_BYTES / 2 + 10);
        for _ in 0..3 {
            r.take_line(
                &serde_json::json!({"jobID": "a", "msg": big, "raw_output": true}).to_string(),
            );
        }
        assert!(r.logs["a"].len() <= MAX_JOB_LOG_BYTES + 64);
        assert!(r.logs["a"].ends_with("[forge-runner: log cut at 16 MiB]\n"));
    }

    fn cfg(extra: &str) -> Config {
        Config::parse(&format!(
            "state_dir = \"/s\"\n{extra}\n[[repo]]\nrepo = \"a/b\""
        ))
        .unwrap()
    }

    fn pair(a: &[String], flag: &str) -> Option<String> {
        a.iter().position(|x| x == flag).map(|i| a[i + 1].clone())
    }

    fn inv(secrets: Option<&Path>) -> Invocation<'_> {
        Invocation {
            event_name: "push",
            checkout: Path::new("/co"),
            workflow: Path::new("/co/.forge/workflows/ci.yml"),
            event: Path::new("/ev.json"),
            secrets,
            secrets_set_github_token: false,
            action_cache: Path::new("/s/run/1/act"),
            artifacts: None,
        }
    }

    /// A trusted ref's `GITHUB_TOKEN` comes from the secrets file act reads; argv (which `ps`
    /// shows every local user) never holds it. Without one it is forced empty.
    #[test]
    fn the_github_token_is_never_on_the_command_line() {
        let file = Path::new("/etc/forge/secrets");
        let with = run_args(
            &cfg(""),
            &Invocation {
                secrets_set_github_token: true,
                ..inv(Some(file))
            },
        );
        assert_eq!(
            pair(&with, "--secret-file").as_deref(),
            Some("/etc/forge/secrets")
        );
        assert!(
            !with.iter().any(|a| a.contains("GITHUB_TOKEN")),
            "the file's token is not overridden: {with:?}"
        );
        for (secrets, sets) in [(Some(file), false), (None, false), (None, true)] {
            let a = run_args(
                &cfg(""),
                &Invocation {
                    secrets_set_github_token: sets,
                    ..inv(secrets)
                },
            );
            assert_eq!(pair(&a, "-s").as_deref(), Some("GITHUB_TOKEN="), "{a:?}");
        }
    }

    #[test]
    fn isolation_by_default() {
        let a = run_args(&cfg(""), &inv(None));
        assert_eq!(
            pair(&a, "--container-daemon-socket").as_deref(),
            Some("-"),
            "no host socket"
        );
        assert_eq!(
            pair(&a, "--network").as_deref(),
            Some("bridge"),
            "not the host network"
        );
        assert_eq!(
            pair(&a, "--secret-file").as_deref(),
            Some("/dev/null"),
            "no secrets"
        );
        assert_eq!(
            pair(&a, "-s").as_deref(),
            Some("GITHUB_TOKEN="),
            "act never falls back to the host's gh token"
        );
        for f in ["--env-file", "--var-file", "--input-file"] {
            assert_eq!(pair(&a, f).as_deref(), Some("/dev/null"), "{f}");
        }
        assert!(a.contains(&"--no-cache-server".to_string()));
        assert_eq!(
            pair(&a, "--action-cache-path").as_deref(),
            Some("/s/run/1/act")
        );
        assert_eq!(
            pair(&a, "-W").as_deref(),
            Some("/co/.forge/workflows/ci.yml"),
            "one file"
        );
        assert_eq!(
            pair(&a, "-P").as_deref(),
            Some("ubuntu-latest=node:20-bookworm-slim")
        );
        assert!(
            !a.contains(&"-j".to_string()),
            "act runs one whole (filtered) file"
        );
        assert!(!a.contains(&"--privileged".to_string()));
    }

    #[test]
    fn the_artifact_server_only_with_artifacts_on() {
        let off = run_args(&cfg(""), &inv(None));
        assert!(!off.iter().any(|a| a.starts_with("--artifact")));
        let c = cfg("log_storage = \"l\"\nartifacts = true\nartifact_server_addr = \"172.17.0.1\"\nartifact_server_url = \"http://host.docker.internal:34567/\"");
        let on = run_args(
            &c,
            &Invocation {
                artifacts: Some(Path::new("/r/artifacts/ci")),
                ..inv(None)
            },
        );
        assert_eq!(
            pair(&on, "--artifact-server-path").as_deref(),
            Some("/r/artifacts/ci")
        );
        assert_eq!(
            pair(&on, "--artifact-server-port").as_deref(),
            Some("34567")
        );
        assert_eq!(
            pair(&on, "--artifact-server-addr").as_deref(),
            Some("172.17.0.1")
        );
        let url = command(&c)
            .get_envs()
            .find(|(k, _)| *k == "ACTIONS_RUNTIME_URL")
            .and_then(|(_, v)| v.map(|v| v.to_string_lossy().into_owned()));
        assert_eq!(url.as_deref(), Some("http://host.docker.internal:34567/"));
        assert!(
            command(&cfg(""))
                .get_envs()
                .all(|(k, _)| k != "ACTIONS_RUNTIME_URL"),
            "no runtime URL from the runner's own environment"
        );
        let with = |extra: &str| {
            Config::parse(&format!(
                "state_dir = \"/s\"\nartifacts = true\n{extra}\n[[repo]]\nrepo = \"a/b\""
            ))
        };
        assert!(
            with("artifact_server_addr = \"127.0.0.1\"").is_err(),
            "needs log_storage"
        );
        assert!(
            with("log_storage = \"l\"").is_err(),
            "needs an address chosen for it: act's default may be public"
        );
        assert!(with("log_storage = \"l\"\nartifact_server_addr = \"127.0.0.1\"").is_ok());
    }

    #[test]
    fn secrets_and_socket_only_when_asked() {
        let a = run_args(
            &cfg("mount_docker_socket = true"),
            &inv(Some(Path::new("/sec"))),
        );
        assert_eq!(pair(&a, "--secret-file").as_deref(), Some("/sec"));
        assert!(!a.contains(&"--container-daemon-socket".to_string()));
    }

    #[test]
    fn act_sees_only_the_allowed_environment() {
        let c = command(&cfg(""));
        let envs: BTreeMap<String, Option<String>> = c
            .get_envs()
            .map(|(k, v)| {
                (
                    k.to_string_lossy().into_owned(),
                    v.map(|v| v.to_string_lossy().into_owned()),
                )
            })
            .collect();
        assert!(
            envs.keys().all(|k| ENV_ALLOW.contains(&k.as_str())
                || ENV_ALLOW_PREFIXES.iter().any(|p| k.starts_with(p))),
            "{envs:?}"
        );
        assert!(!envs.contains_key("DASH_FORGE_KEY"));
    }
}
