//! `runner.toml`: which repositories to watch, how to run their workflows, and where logs go.
//!
//! ```toml
//! network = "devnet"            # passed to dg / git-remote-dash as DASH_FORGE_NETWORK
//! devnet_name = "moutai"
//! state_dir = "/var/lib/forge-runner"
//! interval_secs = 120           # poll period (ls-remote per repo); at least 30
//! log_storage = "r2-logs"       # a `dg storage add` profile for job logs (optional)
//!
//! [[repo]]
//! repo = "alice/project"        # owner/name, as dg takes it
//! refs = ["refs/heads/**"]      # which refs run (`*` stays within a path segment, `**` does not)
//! trusted_refs = ["refs/heads/main"]   # only these get secrets
//! secrets_file = "/etc/forge-runner/alice-project.secrets"   # KEY=value lines (act --secret-file)
//! ```

use std::collections::BTreeMap;
use std::path::PathBuf;

use anyhow::{bail, Context as _, Result};
use serde::Deserialize;

/// The smallest poll period: an `ls-remote` costs a few DAPI requests per repo, and the gateway
/// allows 150 a minute per IP (platform-parity-spec §2.4).
pub const MIN_INTERVAL_SECS: u64 = 30;

/// The default job image: small, and it has bash (act runs `run:` steps with `bash -e`).
pub const DEFAULT_IMAGE: &str = "node:20-bookworm-slim";

/// The whole runner configuration.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    /// `testnet`, `mainnet` or `devnet` (DASH_FORGE_NETWORK for dg and git-remote-dash).
    #[serde(default)]
    pub network: Option<String>,
    /// The devnet name, with `network = "devnet"`.
    #[serde(default)]
    pub devnet_name: Option<String>,
    /// Where tip cursors, repo caches and job logs live.
    pub state_dir: PathBuf,
    /// Seconds between polls.
    #[serde(default = "default_interval")]
    pub interval_secs: u64,
    /// Workflow directories tried in order; the first that exists in the commit runs.
    #[serde(default = "default_workflow_dirs")]
    pub workflow_dirs: Vec<String>,
    /// `runs-on` label → image (act `-P`). Default: `ubuntu-latest` → [`DEFAULT_IMAGE`].
    #[serde(default)]
    pub platforms: BTreeMap<String, String>,
    /// The docker network job containers join (act `--network`). Default `bridge`: act's own
    /// default is `host`, which would put jobs on the runner's network namespace.
    #[serde(default = "default_network")]
    pub container_network: String,
    /// Mount the Docker socket into job containers (act `--container-daemon-socket`). Off by
    /// default: a job with the socket controls the Docker host.
    #[serde(default)]
    pub mount_docker_socket: bool,
    /// Extra `docker run` options for job containers (act `--container-options`). The runner
    /// owner's own setting (for example `--memory 4g --cpus 2 --read-only`); a workflow cannot
    /// set it.
    #[serde(default)]
    pub container_options: Option<String>,
    /// The runner owns its Docker daemon (a rootless or sysbox daemon, or a DinD sidecar used by
    /// nothing else): after a timed-out or crashed run it removes every `act-*` container,
    /// volume and network there, and it removes act's shared `act-toolcache` volume before
    /// every run. Leave it off on a daemon anything else uses.
    #[serde(default)]
    pub sweep_after_timeout: bool,
    /// How many polls retry a push whose checkout or run could not start (a network error).
    #[serde(default = "default_attempts")]
    pub attempts: u32,
    /// How long one push's workflows may run.
    #[serde(default = "default_timeout")]
    pub job_timeout_secs: u64,
    /// The storage profile job logs are uploaded to (`dg ci report --log --storage`). Without
    /// it, reports carry no log.
    #[serde(default)]
    pub log_storage: Option<String>,
    /// No longer has any effect (kept so existing configs still load): a private repository's
    /// check run cannot carry a log URL, so `dg` never uploads its logs.
    #[serde(default)]
    pub public_log: bool,
    /// The `dg`, `git` and `act` binaries (default: from PATH).
    #[serde(default)]
    pub bin: Bins,
    /// The repositories to watch.
    #[serde(rename = "repo")]
    pub repos: Vec<RepoConfig>,
}

/// Paths of the tools the runner drives.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Bins {
    /// `dg` (with `dg ci report`).
    #[serde(default = "default_dg")]
    pub dg: String,
    /// `git` (with `git-remote-dash` on its PATH for `dash://`).
    #[serde(default = "default_git")]
    pub git: String,
    /// nektos/act.
    #[serde(default = "default_act")]
    pub act: String,
}

impl Default for Bins {
    fn default() -> Self {
        Self {
            dg: default_dg(),
            git: default_git(),
            act: default_act(),
        }
    }
}

/// One watched repository.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RepoConfig {
    /// `owner/name` as dg takes it.
    pub repo: String,
    /// The git URL to fetch (default `dash://<repo>`); tests point it at a local repository.
    #[serde(default)]
    pub url: Option<String>,
    /// Ref globs that run.
    #[serde(default = "default_refs")]
    pub refs: Vec<String>,
    /// Ref globs whose runs get the secrets file. Everything else runs without secrets.
    #[serde(default)]
    pub trusted_refs: Vec<String>,
    /// act secrets (`KEY=value` lines), given only to trusted refs.
    #[serde(default)]
    pub secrets_file: Option<PathBuf>,
    /// Run jobs that set `container.options` / `container.volumes`, the same on `services.*`,
    /// or call a reusable workflow (`uses:`). Off by default: each reaches past the job
    /// container (`--privileged`, a mounted socket, a host path). Turn it on only for a
    /// repository whose every pusher you trust with the Docker daemon.
    #[serde(default)]
    pub allow_container_options: bool,
}

fn default_interval() -> u64 {
    120
}
fn default_workflow_dirs() -> Vec<String> {
    vec![".forge/workflows".into()]
}
fn default_network() -> String {
    "bridge".into()
}
fn default_timeout() -> u64 {
    3600
}
fn default_attempts() -> u32 {
    3
}
fn default_refs() -> Vec<String> {
    vec!["refs/heads/**".into()]
}
fn default_dg() -> String {
    "dg".into()
}
fn default_git() -> String {
    "git".into()
}
fn default_act() -> String {
    "act".into()
}

impl Config {
    /// Read and check `path`.
    pub fn load(path: &std::path::Path) -> Result<Self> {
        let text =
            std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
        Self::parse(&text).with_context(|| format!("in {}", path.display()))
    }

    /// Parse and check a config text.
    pub fn parse(text: &str) -> Result<Self> {
        let mut c: Config = toml::from_str(text)?;
        if c.interval_secs < MIN_INTERVAL_SECS {
            bail!("interval_secs must be at least {MIN_INTERVAL_SECS}");
        }
        if c.repos.is_empty() {
            bail!("no [[repo]] to watch");
        }
        for r in &c.repos {
            let ok = r.repo.split_once('/').is_some_and(|(o, n)| {
                !o.is_empty()
                    && !n.is_empty()
                    && !n.contains('/')
                    && r.repo
                        .chars()
                        .all(|ch| ch.is_ascii_alphanumeric() || "/._-".contains(ch))
            });
            if !ok {
                bail!("repo {:?} is not owner/name", r.repo);
            }
            for g in r.refs.iter().chain(&r.trusted_refs) {
                if !g.starts_with("refs/") {
                    bail!("ref pattern {g:?} must start with refs/");
                }
            }
            if !r.trusted_refs.is_empty() && r.secrets_file.is_none() {
                bail!(
                    "{}: trusted_refs without a secrets_file gives nothing",
                    r.repo
                );
            }
        }
        for (label, image) in &c.platforms {
            // `-self-hosted` makes act run the job directly on the runner's host, outside
            // Docker.
            if image.trim() == "-self-hosted" || image.trim().is_empty() {
                bail!("platforms.{label} = {image:?}: jobs run in a container image, never on the host");
            }
        }
        if c.network.as_deref() == Some("devnet") && c.devnet_name.is_none() {
            bail!("network = \"devnet\" needs devnet_name");
        }
        c.platforms
            .entry("ubuntu-latest".into())
            .or_insert_with(|| DEFAULT_IMAGE.into());
        Ok(c)
    }
}

impl RepoConfig {
    /// The git URL the runner fetches.
    pub fn url(&self) -> String {
        self.url
            .clone()
            .unwrap_or_else(|| format!("dash://{}", self.repo))
    }

    /// Whether pushes to `refname` run.
    pub fn runs(&self, refname: &str) -> bool {
        self.refs.iter().any(|g| glob_match(g, refname))
    }

    /// Whether a run of `refname` gets the secrets.
    pub fn trusted(&self, refname: &str) -> bool {
        self.secrets_file.is_some() && self.trusted_refs.iter().any(|g| glob_match(g, refname))
    }
}

/// A ref glob: `*` matches any run of characters within one path segment (never a `/`), and
/// `**` matches anything, slashes included. So `refs/heads/*` covers `refs/heads/main` but not
/// `refs/heads/feat/x`, `refs/heads/**` covers both, and `refs/heads/release-*` does not reach
/// into `refs/heads/release-1/hotfix`: a trusted-ref pattern never grows to cover more than it
/// says.
pub fn glob_match(pattern: &str, name: &str) -> bool {
    fn go(p: &[u8], n: &[u8]) -> bool {
        match p {
            [] => n.is_empty(),
            [b'*', b'*', rest @ ..] => (0..=n.len()).any(|i| go(rest, &n[i..])),
            [b'*', rest @ ..] => (0..=n.len())
                .take_while(|&i| i == 0 || n[i - 1] != b'/')
                .any(|i| go(rest, &n[i..])),
            [c, rest @ ..] => n.first() == Some(c) && go(rest, &n[1..]),
        }
    }
    go(pattern.as_bytes(), name.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIN: &str = r#"
state_dir = "/tmp/x"
[[repo]]
repo = "alice/project"
"#;

    #[test]
    fn defaults_are_the_safe_ones() {
        let c = Config::parse(MIN).unwrap();
        assert!(
            !c.mount_docker_socket,
            "no Docker socket in jobs by default"
        );
        assert_eq!(c.container_network, "bridge");
        assert_eq!(c.platforms["ubuntu-latest"], DEFAULT_IMAGE);
        assert_eq!(c.workflow_dirs, [".forge/workflows"]);
        let r = &c.repos[0];
        assert_eq!(r.url(), "dash://alice/project");
        assert!(r.runs("refs/heads/main") && r.runs("refs/heads/feat/x"));
        assert!(!r.runs("refs/tags/v1"));
        assert!(
            !r.trusted("refs/heads/main"),
            "no secrets unless configured"
        );
        assert!(
            !r.allow_container_options,
            "workflow docker options refused by default"
        );
        assert!(
            !c.sweep_after_timeout,
            "no daemon-wide sweep unless the daemon is the runner's"
        );
    }

    #[test]
    fn refuses_what_would_surprise() {
        for bad in [
            "state_dir = \"/x\"\ninterval_secs = 5\n[[repo]]\nrepo = \"a/b\"",
            "state_dir = \"/x\"\n[[repo]]\nrepo = \"a/b/c\"",
            "state_dir = \"/x\"\n[[repo]]\nrepo = \"a/b\"\ntrusted_refs = [\"refs/heads/main\"]",
            "state_dir = \"/x\"\n[[repo]]\nrepo = \"a/b\"\nrefs = [\"main\"]",
            "state_dir = \"/x\"\nnetwork = \"devnet\"\n[[repo]]\nrepo = \"a/b\"",
            "state_dir = \"/x\"\nsocket = true\n[[repo]]\nrepo = \"a/b\"",
            "state_dir = \"/x\"\n[platforms]\nubuntu-latest = \"-self-hosted\"\n[[repo]]\nrepo = \"a/b\"",
            "state_dir = \"/x\"",
        ] {
            assert!(Config::parse(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn secrets_go_only_to_trusted_refs() {
        let c = Config::parse(
            "state_dir = \"/x\"\n[[repo]]\nrepo = \"a/b\"\ntrusted_refs = [\"refs/heads/main\", \"refs/heads/release-*\"]\nsecrets_file = \"/s\"",
        )
        .unwrap();
        let r = &c.repos[0];
        assert!(r.trusted("refs/heads/main"));
        assert!(r.trusted("refs/heads/release-1"));
        assert!(!r.trusted("refs/heads/release-1/hotfix"));
        assert!(!r.trusted("refs/heads/feature"));
        assert!(!r.trusted("refs/heads/mainline"));
    }

    #[test]
    fn globs() {
        assert!(!glob_match("refs/heads/*", "refs/heads/a/b"));
        assert!(glob_match("refs/heads/*", "refs/heads/a"));
        assert!(glob_match("refs/heads/**", "refs/heads/a/b"));
        assert!(glob_match("refs/*/main", "refs/heads/main"));
        assert!(!glob_match("refs/*/main", "refs/a/b/main"));
        assert!(glob_match("refs/heads/main", "refs/heads/main"));
        assert!(!glob_match("refs/heads/main", "refs/heads/main2"));
    }
}
