//! Driving nektos/act: listing a workflow directory's jobs, building the command line, and
//! reading each job's result from act's JSON log (`--json`).

use std::collections::BTreeMap;
use std::path::Path;

use serde::Deserialize;

use crate::config::Config;

/// One job act lists (`act -l`): its id, and the check name the runner reports it under.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Job {
    /// The job id (the key under `jobs:`).
    pub id: String,
    /// `<workflow name> / <job name>`, the check-run name (≤ 100 characters).
    pub check_name: String,
}

/// Parse `act -l` output (a table: `Stage  Job ID  Job name  Workflow name  Workflow file
/// Events`). act separates columns with two or more spaces; a name with a single space in it
/// stays whole.
pub fn parse_list(out: &str) -> Vec<Job> {
    let mut jobs = Vec::new();
    let mut header_seen = false;
    for line in out.lines() {
        let cols: Vec<&str> = line
            .split("  ")
            .map(str::trim)
            .filter(|c| !c.is_empty())
            .collect();
        if cols.first() == Some(&"Stage") {
            header_seen = true;
            continue;
        }
        if !header_seen || cols.len() < 4 || !cols[0].chars().all(|c| c.is_ascii_digit()) {
            continue;
        }
        let (id, name, workflow) = (cols[1], cols[2], cols[3]);
        let check: String = format!("{workflow} / {name}").chars().take(100).collect();
        jobs.push(Job {
            id: id.to_string(),
            check_name: check,
        });
    }
    jobs
}

/// How a job ended, from act's `jobResult`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    /// `success`.
    Success,
    /// `failure`.
    Failure,
    /// `skipped` (an `if:` that was false).
    Skipped,
    /// No result: act was stopped (timeout) or crashed before the job finished.
    Unfinished,
}

impl Outcome {
    /// The check-run conclusion for this outcome.
    pub fn conclusion(self, timed_out: bool) -> &'static str {
        match self {
            Outcome::Success => "success",
            Outcome::Failure => "failure",
            Outcome::Skipped => "skipped",
            Outcome::Unfinished if timed_out => "timed_out",
            Outcome::Unfinished => "cancelled",
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
}

/// Read act's `--json` output. Lines that are not JSON (act's own warnings) are skipped.
pub fn parse_json_log(out: &str) -> Results {
    let mut r = Results::default();
    for line in out.lines() {
        let Ok(l) = serde_json::from_str::<Line>(line) else {
            continue;
        };
        let Some(job) = l.job_id else { continue };
        if let Some(res) = l.job_result.as_deref() {
            let o = match res {
                "success" => Outcome::Success,
                "skipped" => Outcome::Skipped,
                _ => Outcome::Failure,
            };
            r.outcomes.insert(job.clone(), o);
        }
        if let Some(msg) = l.msg {
            let log = r.logs.entry(job).or_default();
            log.push_str(&msg);
            if l.raw_output != Some(true) && !msg.ends_with('\n') {
                log.push('\n');
            }
        }
    }
    r
}

/// Whether a job id can go on act's command line (`-j`).
fn safe_job_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 100
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// The act arguments for one push: `event` (`push`), the workflow dir, the event file, the
/// isolation settings from `cfg`, secrets only when `secrets` is given, and `--json`.
/// `job` limits the run to one job.
pub fn run_args(
    cfg: &Config,
    checkout: &Path,
    workflows: &Path,
    event_file: &Path,
    secrets: Option<&Path>,
    job: Option<&str>,
) -> Vec<String> {
    let mut a: Vec<String> = vec![
        "push".into(),
        "-C".into(),
        checkout.display().to_string(),
        "-W".into(),
        workflows.display().to_string(),
        "-e".into(),
        event_file.display().to_string(),
        "--json".into(),
        "--no-recurse".into(),
        // act reads `.actrc` and `.env` / `.secrets` from its working directory by default;
        // the checkout is untrusted, so name empty ones explicitly.
        "--env-file".into(),
        "/dev/null".into(),
        "--var-file".into(),
        "/dev/null".into(),
        "--input-file".into(),
        "/dev/null".into(),
        "--network".into(),
        cfg.container_network.clone(),
        "--rm".into(),
    ];
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
    a.push("--secret-file".into());
    a.push(secrets.map_or_else(|| "/dev/null".into(), |p| p.display().to_string()));
    if let Some(j) = job.filter(|j| safe_job_id(j)) {
        a.push("-j".into());
        a.push(j.into());
    }
    a
}

#[cfg(test)]
mod tests {
    use super::*;

    const LIST: &str = "time=\"…\" level=info msg=\"Using docker host\"\n\
level=warning msg= ⚠ You are using Apple M-series chip\n\
\n\
Stage  Job ID  Job name     Workflow name  Workflow file  Events\n\
0      build   build        ci             ci.yml         push  \n\
0      test    unit tests   ci             ci.yml         push  \n";

    #[test]
    fn lists_jobs_with_their_check_names() {
        let jobs = parse_list(LIST);
        assert_eq!(
            jobs,
            [
                Job {
                    id: "build".into(),
                    check_name: "ci / build".into()
                },
                Job {
                    id: "test".into(),
                    check_name: "ci / unit tests".into()
                },
            ]
        );
    }

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
        assert_eq!(Outcome::Unfinished.conclusion(false), "cancelled");
        assert_eq!(Outcome::Skipped.conclusion(false), "skipped");
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

    #[test]
    fn isolation_by_default() {
        let a = run_args(
            &cfg(""),
            Path::new("/co"),
            Path::new("/co/.forge/workflows"),
            Path::new("/ev.json"),
            None,
            Some("build"),
        );
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
        assert_eq!(pair(&a, "--env-file").as_deref(), Some("/dev/null"));
        assert_eq!(
            pair(&a, "-P").as_deref(),
            Some("ubuntu-latest=node:20-bookworm-slim")
        );
        assert_eq!(pair(&a, "-j").as_deref(), Some("build"));
        assert!(a.contains(&"--rm".to_string()));
        assert!(!a.contains(&"--privileged".to_string()));
    }

    #[test]
    fn secrets_and_socket_only_when_asked() {
        let a = run_args(
            &cfg("mount_docker_socket = true"),
            Path::new("/co"),
            Path::new("/w"),
            Path::new("/e"),
            Some(Path::new("/sec")),
            None,
        );
        assert_eq!(pair(&a, "--secret-file").as_deref(), Some("/sec"));
        assert!(
            !a.contains(&"--container-daemon-socket".to_string()),
            "act's default mounts the socket"
        );
        assert!(!a.contains(&"-j".to_string()));
        let a = run_args(
            &cfg(""),
            Path::new("/co"),
            Path::new("/w"),
            Path::new("/e"),
            None,
            Some("x; rm -rf /"),
        );
        assert!(
            !a.contains(&"-j".to_string()),
            "an odd job id is not passed on"
        );
    }
}
