//! One run, end to end: a push, or a pull request's activity. Check the commit out, read its
//! workflows, report every job queued, run each workflow file with act, and report each job's
//! result with its log.
//!
//! Every report goes through `dg ci report` (the CLI's own path: validation, the replace-or-create
//! choice, the log upload and its SHA-256, the checkRun-only key in DASH_FORGE_KEY). A job's
//! reports share one run id (`--external-id`, a hash of the repo, ref, commit, workflow file, job
//! and the run's start), so its queued, in-progress and completed reports update one check run,
//! and a re-run of the same commit (`forge-runner run`, a PR reopened) is a check run of its own:
//! `dg ci report` refuses a report that would change a completed run under its id.
//!
//! A pull request runs its head commit, fetched from the branch the PR names (in this
//! repository or a fork) and checked against the head `dg` reports. Its checks are posted on the
//! head, named `<workflow> / <job> (pull_request)`, and keyed by `refs/pull/<n>/head`. It gets
//! the secrets only when [`pull_trusted`] says so; otherwise it runs as GitHub runs a fork's PR:
//! no secrets and an empty `GITHUB_TOKEN`.

use std::collections::{BTreeMap, BTreeSet};
use std::io::BufReader;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use anyhow::{bail, Context as _, Result};
use serde_json::json;

use crate::act::{self, Invocation, Outcome, Results};
use crate::artifacts;
use crate::config::{Config, RepoConfig};
use crate::watch::{PullEvent, PullRow, Push};
use crate::workflow::{self, Facts, Job, PullFacts, PushFacts};

/// Who a pull request's author is to the repository, as the poll read its members.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Author {
    /// Not a member.
    Stranger,
    /// A writer: can push the repository's unprotected branches.
    Writer,
    /// The owner or a maintainer: can also push its protected branches.
    Maintainer,
}

/// What starts a run.
#[derive(Debug, Clone)]
pub enum Trigger {
    /// A push to one of the repository's own refs.
    Push(Push),
    /// A pull request's activity, and who its author is.
    Pull {
        event: Box<PullEvent>,
        author: Author,
    },
    /// A `schedule` cron expression's time came: the default branch's tip (`push.before` is
    /// `None`) runs the workflows that list `cron` and none of `earlier` (normalized
    /// expressions due in the same poll, whose runs come first).
    Schedule {
        push: Push,
        cron: String,
        earlier: Vec<String>,
    },
}

impl Trigger {
    /// The ref and commit a run is keyed and reported by: the pushed ref, or
    /// `refs/pull/<n>/head` at the PR's head, so a PR's runs never share a run id with the
    /// branch's own push runs.
    pub fn key(&self) -> Push {
        match self {
            Trigger::Push(p) | Trigger::Schedule { push: p, .. } => p.clone(),
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
            Trigger::Schedule { .. } => "schedule",
        }
    }

    /// A job's check name: `<workflow> / <job>`, then ` (pull_request)` for a member's PR run,
    /// ` (pull_request, non-member)` for anyone else's, or ` (schedule)` for a scheduled run (at
    /// most 100 characters, the suffix kept). So a PR's or a schedule's checks and the branch's
    /// push checks on one commit never replace each other, and a stranger's PR that names a
    /// member's commit as its head cannot post the run that decides the member's required check
    /// (readers keep the newest run per name).
    pub fn check_name(&self, base: &str) -> String {
        let suffix = match self {
            Trigger::Push(_) => "",
            Trigger::Schedule { .. } => " (schedule)",
            Trigger::Pull {
                author: Author::Stranger,
                ..
            } => " (pull_request, non-member)",
            Trigger::Pull { .. } => " (pull_request)",
        };
        let keep = 100 - suffix.chars().count();
        format!("{}{suffix}", base.chars().take(keep).collect::<String>())
    }

    /// Whether a job may set docker options or mounts (`allow_container_options`): only a
    /// push, or a member's PR from a branch of the repository itself, whose code members
    /// pushed. Never a fork's or a stranger's PR, which could otherwise take the daemon.
    pub fn allows_container_options(&self, repo: &RepoConfig) -> bool {
        repo.allow_container_options
            && match self {
                Trigger::Push(_) | Trigger::Schedule { .. } => true,
                Trigger::Pull { event, author } => {
                    !event.pr.is_fork() && *author != Author::Stranger
                }
            }
    }

    /// How logs and summaries name what ran: the ref, or `PR #<n>`.
    pub fn label(&self) -> String {
        match self {
            Trigger::Push(p) => p.refname.clone(),
            Trigger::Pull { event, .. } => format!("PR #{}", event.pr.number),
            Trigger::Schedule { push, cron, .. } => {
                format!("schedule {cron:?} on {}", push.refname)
            }
        }
    }

    /// Whether this run gets the secrets file and its `GITHUB_TOKEN`.
    pub fn trusted(&self, repo: &RepoConfig) -> bool {
        match self {
            Trigger::Push(p) | Trigger::Schedule { push: p, .. } => repo.trusted(&p.refname),
            Trigger::Pull { event, author } => pull_trusted(repo, &event.pr, *author),
        }
    }
}

/// Whether a pull request's run gets the secrets: only when its head is a branch of this
/// repository, never a fork's, that `trusted_refs` covers (so only those who could push there
/// with secrets anyway wrote the code), and its author is the owner or a maintainer (so the
/// PR's title, base and other event fields, which pick what runs and may reach a shell, are
/// set by someone who could push that branch too). Anything else runs as GitHub runs a fork's
/// PR: no secrets and an empty `GITHUB_TOKEN`.
pub fn pull_trusted(repo: &RepoConfig, pr: &PullRow, author: Author) -> bool {
    !pr.is_fork()
        && author == Author::Maintainer
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
    /// Artifacts to upload and record (a completed report only).
    pub artifacts: Vec<PathBuf>,
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
    // On a private repository `dg` leaves the summary, the run id, the log and the artifacts
    // out (a private repository's check run carries none) and uploads none of them.
    if let Some(storage) = &cfg.log_storage {
        if let Some(log) = &r.log {
            a.extend(["--log".into(), log.display().to_string()]);
        }
        for f in &r.artifacts {
            a.extend(["--artifact".into(), f.display().to_string()]);
        }
        if r.log.is_some() || !r.artifacts.is_empty() {
            a.extend(["--storage".into(), storage.clone()]);
        }
    }
    a
}

/// The run id a job's reports share: `forge-runner:` and a SHA-256 over what identifies the run
/// (repo, ref, commit, workflow file, job, and `attempt`: the run's start, so each re-run of a
/// commit is its own check run, as a GitHub re-run attempt is), cut to 40 hex digits. Fixed
/// length, and two runs never share one because a ref name or a file name was cut.
pub fn external_id(repo: &str, push: &Push, file: &Path, job: &str, attempt: u64) -> String {
    use sha2::{Digest as _, Sha256};
    let mut h = Sha256::new();
    let attempt = attempt.to_string();
    for part in [
        repo,
        &push.refname,
        &push.oid,
        &file.to_string_lossy(),
        job,
        &attempt,
    ] {
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
                "ref": short_ref(pr.base()),
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

/// `git ls-remote --symref <url>` (the `HEAD` symref names the default branch).
pub fn ls_remote(cfg: &Config, repo: &RepoConfig) -> Result<String> {
    let mut cmd = with_network(Command::new(&cfg.bin.git), cfg);
    cmd.args(["ls-remote", "--symref", &repo.url()]);
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
    let limit = limit.to_string();
    let v = dg_read(cfg, &list_pulls_args(&repo.repo, &limit))?;
    serde_json::from_value(v["prs"].clone()).context("dg pr list: unexpected rows")
}

/// `dg pr list`'s arguments for [`list_pulls`]. `--include-hidden`: a maintainer's hide is display
/// only, and CI must see every PR (a hidden PR still merges, and a required check still gates it).
fn list_pulls_args<'a>(repo: &'a str, limit: &'a str) -> [&'a str; 8] {
    [
        "pr",
        "list",
        repo,
        "--state",
        "all",
        "--include-hidden",
        "--limit",
        limit,
    ]
}

/// One pull request, read by number (`dg pr view`), whatever its age.
pub fn view_pull(cfg: &Config, repo: &RepoConfig, number: u64) -> Result<PullRow> {
    let v = dg_read(cfg, &["pr", "view", &repo.repo, &number.to_string()])?;
    serde_json::from_value(v).with_context(|| format!("dg pr view {number}: unexpected JSON"))
}

/// The repository's current members by identity id: its maintainers and the owner as
/// [`Author::Maintainer`], its writers as [`Author::Writer`] (`dg collab list`).
pub fn list_members(cfg: &Config, repo: &RepoConfig) -> Result<Members> {
    members_of(&dg_read(cfg, &["collab", "list", &repo.repo])?)
}

/// Identity id → role.
pub type Members = std::collections::BTreeMap<String, Author>;

/// [`list_members`]' reading of `dg collab list --json`. The owner counts as a maintainer
/// whether or not it holds a maintainer document.
///
/// A list without `"roles": true` comes from a dg older than RC2 member roles, which lists
/// triage members and readers as "writer": it is refused, so their PRs never get a writer's
/// trusted-runner treatment.
pub fn members_of(v: &serde_json::Value) -> Result<Members> {
    let rows = v["members"]
        .as_array()
        .context("dg collab list: no members")?;
    if v["roles"].as_bool() != Some(true) {
        bail!(
            "dg collab list: no member roles (dg too old for this runner: it lists triage \
             members and readers as writers); upgrade dg"
        );
    }
    let mut m = Members::new();
    for r in rows {
        let (Some(id), Some(role)) = (r["identityId"].as_str(), r["role"].as_str()) else {
            continue;
        };
        let role = match role {
            "maintainer" => Author::Maintainer,
            "writer" => Author::Writer,
            // A role this runner does not know is not a member's; triage members and readers
            // (RC2 member roles) cannot push, so they are strangers here too.
            _ => continue,
        };
        let held = m.entry(id.to_string()).or_insert(role);
        *held = (*held).max(role);
    }
    let owner = v["ownerId"]
        .as_str()
        .context("dg collab list: no ownerId (dg too old for this runner)")?;
    m.insert(owner.to_string(), Author::Maintainer);
    Ok(m)
}

/// Who `id` is among `members`.
pub fn author_of(members: &Members, id: &str) -> Author {
    members.get(id).copied().unwrap_or(Author::Stranger)
}

/// Keep in `plan` only what reports check `only` under `trig`: the workflows with a job of
/// that check name (all their jobs run), and a broken file whose failure carries it.
pub fn keep_check(plan: &mut workflow::Plan, trig: &Trigger, only: &str) {
    let reports = |wf: &workflow::Workflow| {
        wf.jobs
            .iter()
            .any(|j| trig.check_name(&j.check_name) == only)
    };
    plan.run.retain(reports);
    plan.path_filtered.retain(reports);
    plan.broken
        .retain(|b| trig.check_name(&format!("{} (invalid workflow)", b.file.display())) == only);
}

/// One CI re-run request as `dg --json ci reruns` gives it.
#[derive(Debug, Clone, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RerunRow {
    /// The request's event id.
    pub id: String,
    /// The pull request's number.
    pub number: u64,
    /// The commit (hex).
    pub sha: String,
    /// The check to run again; `None`: every check of the head (the PR's and its branch's push runs).
    #[serde(default)]
    pub check: Option<String>,
    /// Who asked.
    pub requester: String,
    /// When (`$createdAt`, ms).
    pub created_at: u64,
    /// Whether it counts: the owner's, or a maintainer's or writer's at the time
    /// (`forge_core::rules::ci_rerun::rerun_counts`, judged by dg).
    pub counts: bool,
}

/// The repository's CI re-run requests written at or after `since` (ms), oldest first.
pub fn list_reruns(cfg: &Config, repo: &RepoConfig, since: u64) -> Result<Vec<RerunRow>> {
    let since = since.to_string();
    let v = dg_read(cfg, &["ci", "reruns", &repo.repo, "--since", &since])?;
    serde_json::from_value(v["requests"].clone()).context("dg ci reruns: unexpected rows")
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
fn fetch(cfg: &Config, src: &Source<'_>, refname: &str, dest: &str) -> Result<String> {
    let git = |args: &[&str]| {
        let mut c = with_network(Command::new(&cfg.bin.git), cfg);
        c.arg("--git-dir").arg(src.cache).args(args);
        output(&mut c, &format!("git {}", args.first().unwrap_or(&"")))
    };
    if !src.cache.join("HEAD").exists() {
        std::fs::create_dir_all(src.cache)?;
        git(&["init", "-q", "--bare"])?;
    }
    let spec = format!("+{refname}:{dest}");
    // git follows the tags that point into what it fetched; a fork's tags must never reach a
    // checkout, where they would shadow the repository's own.
    let mut args = vec!["fetch", "-q"];
    if !src.tags {
        args.push("--no-tags");
    }
    args.extend([src.url, spec.as_str()]);
    git(&args)?;
    Ok(git(&["rev-parse", dest])?.trim().to_string())
}

/// Where a fetch reads from and into.
struct Source<'a> {
    url: &'a str,
    /// The bare cache it fetches into.
    cache: &'a Path,
    /// Whether tags pointing into the fetched history come along (the repository's own only).
    tags: bool,
}

/// Fetch `refname` and check that it is at `oid`: what runs is what the ref holds.
fn fetch_at(cfg: &Config, src: &Source<'_>, refname: &str, oid: &str) -> Result<()> {
    let tip = fetch(cfg, src, refname, "refs/forge-runner/fetched")?;
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

/// The `on.schedule` cron expressions of the workflows `refname` holds at `oid` (fetched into the
/// repository's cache, then read from git: no checkout), each with the workflow file that lists
/// it, from the first configured workflow directory the commit has, as a run reads them. A file
/// a run would refuse whole (not YAML, a merge key, no jobs) lists none, and is logged.
pub fn scheduled_crons(
    cfg: &Config,
    repo: &RepoConfig,
    refname: &str,
    oid: &str,
) -> Result<Vec<(String, String)>> {
    let cache = repo_dir(cfg, repo).join("cache.git");
    let url = repo.url();
    let own = Source {
        url: &url,
        cache: &cache,
        tags: true,
    };
    fetch_at(cfg, &own, refname, oid)?;
    let git = |args: &[&str]| {
        let mut c = Command::new(&cfg.bin.git);
        c.arg("--git-dir").arg(&cache).args(args);
        output(&mut c, &format!("git {}", args.first().unwrap_or(&"")))
    };
    let mut out = Vec::new();
    for dir in &cfg.workflow_dirs {
        let dir = format!("{}/", dir.trim_end_matches('/'));
        // `<mode> <type> <oid> <size>\t<path>` per entry.
        let listing = git(&["ls-tree", "-l", "-z", oid, "--", &dir])?;
        if listing.is_empty() {
            continue;
        }
        for (meta, path) in listing.split('\0').filter_map(|e| e.split_once('\t')) {
            let m: Vec<&str> = meta.split_whitespace().collect();
            // Regular files only (no symlinks or submodules), as a run reads them.
            let [mode, "blob", blob, size] = m[..] else {
                continue;
            };
            let yaml = Path::new(path)
                .extension()
                .is_some_and(|x| x == "yml" || x == "yaml");
            if !matches!(mode, "100644" | "100755")
                || !yaml
                || size
                    .parse::<u64>()
                    .map_or(true, |n| n > workflow::MAX_WORKFLOW_BYTES)
            {
                continue;
            }
            let text = git(&["cat-file", "blob", blob])?;
            match workflow::read_workflow(Path::new(path), &text, true, &[]) {
                Ok((_, on)) => out.extend(
                    workflow::schedule_crons(&on)
                        .into_iter()
                        .map(|c| (c, path.to_string())),
                ),
                Err(why) => eprintln!(
                    "forge-runner: {} {path}: its schedules do not run: {why}",
                    repo.repo
                ),
            }
        }
        // The first directory the commit has is the one that runs.
        break;
    }
    Ok(out)
}

/// The repository's default branch (`dg repo view`), short (`main`).
pub fn default_branch_name(cfg: &Config, repo: &RepoConfig) -> Result<String> {
    let v = dg_read(cfg, &["repo", "view", &repo.repo])?;
    v["defaultBranch"]
        .as_str()
        .map(str::to_string)
        .context("dg repo view: no defaultBranch")
}

/// The runner's clock, ms since 1970.
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

/// What narrows or annotates one run.
#[derive(Debug, Clone, Default)]
pub struct RunOpts {
    /// Only the workflows that report this check (a re-run of one check): every job of each
    /// such workflow runs, as GitHub re-runs a workflow's jobs. `None`: every workflow.
    pub only: Option<String>,
    /// Who asked for this run (a CI re-run request's writer), named in each summary and in the
    /// event (`forge.rerun_requested_by`).
    pub requested_by: Option<String>,
    /// A re-run of a pull request's checks: its workflows are those of any activity the runner
    /// runs PRs on ([`workflow::PullFacts::any_type`]), not only the trigger's own.
    pub rerun: bool,
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
            let v = serde_json::from_str::<serde_json::Value>(&out).unwrap_or_default();
            eprintln!(
                "forge-runner: {} {} = {} ({})",
                r.repo,
                r.name,
                r.conclusion.unwrap_or(r.status),
                v["status"].as_str().unwrap_or_default()
            );
            // Uploaded, but past what the run's artifact list holds.
            if let Some(left) = v["artifactsLeftOut"].as_array().filter(|a| !a.is_empty()) {
                eprintln!(
                    "forge-runner: {} {}: artifacts not recorded (the list is full): {}",
                    r.repo,
                    r.name,
                    left.iter()
                        .filter_map(serde_json::Value::as_str)
                        .collect::<Vec<_>>()
                        .join(", ")
                );
            }
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
    logs: &'a Path,
    run_dir: &'a Path,
    deadline: Instant,
    /// Appended to every summary (who asked for a re-run).
    note: String,
    /// When this run started (ms since 1970): part of every job's run id ([`external_id`]).
    attempt: u64,
}

impl RunCtx<'_> {
    /// A report of check `name` (`id` its job, `file` its workflow) with `status` and nothing
    /// else yet.
    fn report_of(&self, file: &Path, id: &str, name: &str, status: &'static str) -> Report<'_> {
        Report {
            repo: &self.repo.repo,
            oid: &self.key.oid,
            name: self.trig.check_name(name),
            external_id: external_id(&self.repo.repo, self.key, file, id, self.attempt),
            status,
            conclusion: None,
            summary: None,
            log: None,
            artifacts: Vec::new(),
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

/// What a run fetched: the cache holding its commit, the paths it changes, the PR's base
/// branch (short), and act's event.
struct Fetched {
    cache: PathBuf,
    changed: Option<Vec<String>>,
    base: Option<String>,
    event: serde_json::Value,
}

/// Fetch what `trig` runs and build its event. The repository's own history is cached across
/// runs; a fork's head goes into a cache of this run's own, deleted with it, and brings no
/// tags, so a fork's objects and refs never reach the cache push runs (with their secrets) are
/// checked out from.
fn fetch_run(
    cfg: &Config,
    repo: &RepoConfig,
    trig: &Trigger,
    run_dir: &Path,
    trusted: bool,
) -> Result<Fetched> {
    let fork = matches!(trig, Trigger::Pull { event, .. } if event.pr.is_fork());
    let cache = if fork {
        run_dir.join("fork.git")
    } else {
        repo_dir(cfg, repo).join("cache.git")
    };
    let repo_url = repo.url();
    let own = Source {
        url: &repo_url,
        cache: &cache,
        tags: !fork,
    };
    let (changed, base, event) = match trig {
        Trigger::Push(p) => {
            fetch_at(cfg, &own, &p.refname, &p.oid)?;
            let changed = p
                .before
                .as_deref()
                .and_then(|b| changed_paths(cfg, &cache, &format!("{b}..{}", p.oid)));
            (changed, None, event_json(&repo.repo, p))
        }
        Trigger::Schedule { push, cron, .. } => {
            fetch_at(cfg, &own, &push.refname, &push.oid)?;
            // GitHub's `schedule` payload: the cron expression that fired. act takes a
            // schedule's `github.ref` from `repository.default_branch`, not from `ref`.
            let mut event = event_json(&repo.repo, push);
            event["schedule"] = json!(cron);
            event["repository"]["default_branch"] = json!(short_ref(&push.refname));
            (None, None, event)
        }
        Trigger::Pull { event: ev, .. } => {
            let pr = &ev.pr;
            let source = pr
                .source_ref_name
                .as_deref()
                .context("the PR names no source branch")?;
            let url = repo.pull_source_url(pr);
            let head = Source {
                url: &url,
                cache: &cache,
                tags: false,
            };
            fetch_at(cfg, &head, source, &pr.head_oid)?;
            // The base, for `base.sha` and the PR's changed paths (`base...head`).
            let base = fetch(cfg, &own, pr.base(), "refs/forge-runner/base")
                .map_err(|e| eprintln!("forge-runner: {}: base not fetched: {e:#}", repo.repo))
                .ok();
            let changed = base
                .as_deref()
                .and_then(|b| changed_paths(cfg, &cache, &format!("{b}...{}", pr.head_oid)));
            let event = pull_event_json(&repo.repo, ev, base.as_deref(), &url, trusted);
            (changed, Some(short_ref(pr.base()).to_string()), event)
        }
    };
    Ok(Fetched {
        cache,
        changed,
        base,
        event,
    })
}

/// Run `trig` for `repo`: every job of every workflow file that runs on it, reported queued →
/// in_progress → completed, one act run per file. Secrets go to act only when
/// [`Trigger::trusted`]. `run_dir` is this run's own directory (checkout, event, logs, act's
/// caches).
pub fn run(
    cfg: &Config,
    repo: &RepoConfig,
    trig: &Trigger,
    opts: &RunOpts,
    run_dir: &Path,
) -> Result<Ran> {
    let key = trig.key();
    let trusted = trig.trusted(repo);
    let mut f = fetch_run(cfg, repo, trig, run_dir, trusted)?;
    if let Some(who) = &opts.requested_by {
        f.event["forge"]["rerun_requested_by"] = json!(who);
    }
    let co = run_dir.join("checkout");
    checkout(cfg, &f.cache, &key.oid, &co)?;
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
    let changed = f.changed.as_deref();
    let facts = match (trig, &f.base) {
        (Trigger::Pull { event, .. }, Some(base)) => Facts::PullRequest(PullFacts {
            base,
            action: event.action,
            changed,
            any_type: opts.rerun,
        }),
        (Trigger::Schedule { cron, earlier, .. }, _) => Facts::Schedule(cron, earlier),
        _ => Facts::Push(PushFacts {
            refname: &key.refname,
            changed,
        }),
    };
    let labels: Vec<&str> = cfg.platforms.keys().map(String::as_str).collect();
    let allow = trig.allows_container_options(repo);
    let mut plan = workflow::plan(&co, &wf_dir, &facts, allow, &labels);
    if matches!(trig, Trigger::Schedule { .. }) {
        // A broken file is reported on its push, not again at every scheduled time.
        plan.broken.clear();
    }
    if let Some(only) = &opts.only {
        keep_check(&mut plan, trig, only);
        if plan.run.is_empty() && plan.broken.is_empty() && plan.path_filtered.is_empty() {
            eprintln!(
                "forge-runner: {} {}: no workflow here reports the check {only:?}; nothing re-run",
                repo.repo,
                &key.oid[..12]
            );
            return Ok(ran);
        }
    }
    let event_path = run_dir.join("event.json");
    std::fs::write(&event_path, serde_json::to_vec(&f.event)?)?;
    let secrets = trusted.then(|| repo.secrets_file.clone()).flatten();
    let secret_values = secrets
        .as_deref()
        .map(read_secret_values)
        .transpose()?
        .unwrap_or_default();
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
        logs: &logs,
        run_dir,
        deadline,
        note: opts
            .requested_by
            .as_ref()
            .map_or_else(String::new, |w| format!(", re-run requested by {w}")),
        attempt: now_ms(),
    };
    for b in &plan.broken {
        let name = format!("{} (invalid workflow)", b.file.display());
        let name = ctx.refuse(&b.file, "", &name, &b.reason);
        ran.checks.push((name, "failure"));
    }
    if !plan.path_filtered.is_empty() {
        skip_required(&ctx, &plan.path_filtered, &mut ran);
    }
    for wf in &plan.run {
        run_workflow(&ctx, wf, &mut ran)?;
    }
    Ok(ran)
}

/// The repository's required check names (`dg repo policy show`): `Some` empty with no policy,
/// `None` when the policy could not be read.
fn required_checks(cfg: &Config, repo: &RepoConfig) -> Option<BTreeSet<String>> {
    match dg_read(cfg, &["repo", "policy", "show", &repo.repo]) {
        Ok(v) => Some(required_checks_of(&v)),
        Err(e) => {
            eprintln!("forge-runner: {}: branch policy not read: {e:#}", repo.repo);
            None
        }
    }
}

/// [`required_checks`]' reading of `dg repo policy show --json`.
fn required_checks_of(v: &serde_json::Value) -> BTreeSet<String> {
    v["policy"]["requiredChecks"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(serde_json::Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// Report `skipped` for each job of `filtered` (workflows a pull request's paths filtered out)
/// whose check the branch policy requires, so the check is decided instead of waiting forever
/// for a run that will never come (GitHub's "Expected — waiting for status" trap). Other jobs
/// get nothing: each report is a paid write. When the policy can't be read, every job is
/// reported, so a required one is never left waiting.
fn skip_required(c: &RunCtx<'_>, filtered: &[workflow::Workflow], ran: &mut Ran) {
    let required = required_checks(c.cfg, c.repo);
    for wf in filtered {
        for j in &wf.jobs {
            let name = c.trig.check_name(&j.check_name);
            if required.as_ref().is_some_and(|r| !r.contains(&name)) {
                continue;
            }
            let r = Report {
                conclusion: Some("skipped"),
                summary: Some(format!(
                    "Skipped: {} changes no file this workflow's `paths` filters select{}.",
                    c.trig.label(),
                    c.note
                )),
                ..c.report_of(&wf.file, &j.id, &j.check_name, "completed")
            };
            report(c.cfg, &r);
            ran.checks.push((r.name, "skipped"));
        }
    }
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
    // Each workflow file's uploads in a directory of their own, so they are told apart.
    let art_key = artifacts::file_name(&wf.file.to_string_lossy());
    let art_dir = c
        .cfg
        .artifacts
        .then(|| c.run_dir.join("artifacts").join(&art_key));
    // One value for both: a bare `-s GITHUB_TOKEN` with no token in act's environment would
    // make act prompt for it (on a null stdin, failing the run).
    let token = github_token(c.secret_values);
    let args = act::run_args(
        c.cfg,
        &Invocation {
            event_name: c.trig.event_name(),
            checkout: c.checkout,
            workflow: &workflow_path,
            event: c.event,
            secrets: c.secrets,
            github_token: token,
            action_cache: &action_cache,
            artifacts: art_dir.as_deref(),
        },
    );
    let started = Instant::now();
    let limit = c.deadline.saturating_duration_since(Instant::now());
    let (results, timed_out, crashed) = run_act(c.cfg, &args, token, limit);
    if timed_out || crashed {
        sweep_containers(c.cfg);
    }
    let secs = started.elapsed().as_secs();
    let ids: Vec<&str> = runnable.iter().map(|j| j.id.as_str()).collect();
    let mut uploads = match &art_dir {
        Some(d) => job_artifacts(
            d,
            &c.run_dir.join("artifact-zips").join(&art_key),
            &results,
            &ids,
        ),
        None => BTreeMap::new(),
    };
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
        let (files, note) = uploads.remove(&j.id).unwrap_or_default();
        let summary = format!(
            "forge-runner: {conclusion} on {} in {secs}s ({}){}{}{why}{note}",
            c.trig.label(),
            wf.file.display(),
            if c.secrets.is_some() {
                ", with secrets"
            } else {
                ""
            },
            c.note,
        );
        let r = Report {
            conclusion: Some(conclusion),
            summary: Some(summary),
            log: Some(log_path),
            artifacts: files,
            ..c.report_of(&wf.file, &j.id, &j.check_name, "completed")
        };
        report_completed(c.cfg, &r);
        ran.checks.push((r.name, conclusion));
    }
    Ok(())
}

/// Report a job's result. A failed artifact upload must not leave the run in progress for good:
/// if the report with artifacts fails, report the result again without them, and say so.
///
/// The first report may have landed anyway (a timeout that "may still land"). A retry that
/// reads the run as completed continues it, and RC2 forge-community freezes a completed run's
/// summary, log and artifacts (S1): `dg ci report` leaves them as stored
/// (`forge_core::ci::EVIDENCE_FIELDS`), so the retry records nothing new instead of being
/// refused with 40128. A retry that reads a node still a block behind is refused (40128, or a
/// stale revision); the run then stands as the first report recorded it.
fn report_completed(cfg: &Config, r: &Report<'_>) {
    if !report(cfg, r) && !r.artifacts.is_empty() {
        report(
            cfg,
            &Report {
                artifacts: Vec::new(),
                summary: r
                    .summary
                    .as_ref()
                    .map(|s| format!("{s}; artifacts not recorded: their upload failed")),
                ..r.clone()
            },
        );
    }
}

/// Each job's artifacts from act's server directory `dir` (zipped into `out`): at most
/// [`artifacts::MAX_PER_JOB`] files per job, and a note for its summary on what was left out.
fn job_artifacts(
    dir: &Path,
    out: &Path,
    results: &Results,
    jobs: &[&str],
) -> BTreeMap<String, (Vec<PathBuf>, String)> {
    let found = artifacts::collect(dir, out).unwrap_or_else(|e| {
        eprintln!("forge-runner: artifacts not collected: {e:#}");
        artifacts::Collected::default()
    });
    for s in &found.skipped {
        eprintln!("forge-runner: artifact left out: {s}");
    }
    let left_out =
        (!found.skipped.is_empty()).then(|| format!("left out: {}", found.skipped.join("; ")));
    artifacts::assign(&found.artifacts, &results.logs, jobs)
        .into_iter()
        .map(|(job, mine)| {
            let files: Vec<PathBuf> = mine
                .iter()
                .take(artifacts::MAX_PER_JOB)
                .map(|a| a.zip.clone())
                .collect();
            let over = mine.len().saturating_sub(artifacts::MAX_PER_JOB);
            let mut parts = Vec::new();
            if !files.is_empty() {
                parts.push(format!("{} artifact(s)", files.len()));
            }
            if over > 0 {
                parts.push(format!(
                    "{over} more not recorded (at most {})",
                    artifacts::MAX_PER_JOB
                ));
            }
            parts.extend(left_out.clone());
            let note = if parts.is_empty() {
                String::new()
            } else {
                format!("; {}", parts.join(", "))
            };
            (job, (files, note))
        })
        .collect()
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

/// The `GITHUB_TOKEN` a secrets file's pairs set, or `""` (act upper-cases the names it reads
/// from the file, so the match ignores case). act gets this value, the one [`redact`] masks.
fn github_token(values: &[(String, String)]) -> &str {
    values
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("GITHUB_TOKEN"))
        .map_or("", |(_, v)| v.as_str())
}

/// `log` with every secret value (of 4 characters or more) replaced by `***`, in the clear and
/// in the encoded forms a job most often prints it in: base64 (standard and URL-safe, at any
/// alignment, as inside a `Basic` credential) and URL-encoding. act masks secrets in its own
/// output already; this is a second fence before a log leaves the machine (logs are public).
pub fn redact(log: &str, secrets: &[String]) -> String {
    let mut forms: Vec<String> = secrets
        .iter()
        .filter(|s| s.len() >= 4)
        .flat_map(|s| encoded_forms(s))
        .collect();
    // Longest first, so a form is never cut short by a shorter one inside it.
    forms.sort_by(|a, b| b.len().cmp(&a.len()).then_with(|| a.cmp(b)));
    forms.dedup();
    forms
        .iter()
        .fold(log.to_string(), |acc, s| acc.replace(s.as_str(), "***"))
}

/// The shortest base64 part [`encoded_forms`] masks.
const MIN_BASE64_FORM: usize = 6;

/// `s` itself, its URL-encoding (RFC 3986, upper-case hex: best effort, other encoders
/// differ), and the part of its base64 encoding that depends on `s` alone at each of the three
/// byte alignments it can start at inside a longer encoded string. A base64 part shorter than
/// [`MIN_BASE64_FORM`] is left out: it would match unrelated text too often.
fn encoded_forms(s: &str) -> Vec<String> {
    use base64::engine::general_purpose::{STANDARD_NO_PAD, URL_SAFE_NO_PAD};
    use base64::Engine as _;
    let mut forms = vec![s.to_string(), url_encode(s)];
    for lead in 0..3usize {
        let mut bytes = vec![0u8; lead];
        bytes.extend_from_slice(s.as_bytes());
        let bits = bytes.len() * 8;
        // Characters holding any bit of the `lead` filler bytes, and a last character that
        // holds bits of whatever follows `s`, are not `s`'s alone.
        let skip = (lead * 8).div_ceil(6);
        let keep = bits / 6;
        for engine in [&STANDARD_NO_PAD, &URL_SAFE_NO_PAD] {
            let enc = engine.encode(&bytes);
            if let Some(core) = enc.get(skip..keep).filter(|c| c.len() >= MIN_BASE64_FORM) {
                forms.push(core.to_string());
            }
        }
    }
    forms
}

/// Percent-encoding of everything but RFC 3986's unreserved characters (upper-case hex).
fn url_encode(s: &str) -> String {
    use std::fmt::Write as _;
    s.bytes().fold(String::new(), |mut out, b| {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
            out.push(b as char);
        } else {
            let _ = write!(out, "%{b:02X}");
        }
        out
    })
}

/// Run act with `args`, streaming its JSON log, stopped after `limit`: SIGINT first (act then
/// tears its containers down), SIGKILL 20 s later. `github_token` goes in act's environment
/// ([`act::command`]). Returns (results, timed out, crashed).
fn run_act(
    cfg: &Config,
    args: &[String],
    github_token: &str,
    limit: Duration,
) -> (Results, bool, bool) {
    let mut cmd = act::command(cfg, github_token);
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
    fn a_rerun_of_one_check_keeps_the_workflows_that_report_it() {
        let wf = |file: &str, name: &str, jobs: &[&str]| workflow::Workflow {
            file: PathBuf::from(file),
            name: name.into(),
            jobs: jobs
                .iter()
                .map(|j| workflow::Job {
                    id: (*j).into(),
                    check_name: format!("{name} / {j}"),
                    refused: None,
                })
                .collect(),
            doc: serde_json::Value::Null,
        };
        let plan = || workflow::Plan {
            run: vec![
                wf("ci.yml", "CI", &["build", "test"]),
                wf("lint.yml", "Lint", &["lint"]),
            ],
            broken: vec![workflow::Broken {
                file: PathBuf::from(".forge/workflows/bad.yml"),
                reason: "x".into(),
            }],
            path_filtered: vec![wf("docs.yml", "Docs", &["spell"])],
        };
        let push = Trigger::Push(push());
        let mut p = plan();
        keep_check(&mut p, &push, "CI / test");
        assert_eq!(p.run.len(), 1);
        assert_eq!(
            p.run[0].jobs.len(),
            2,
            "every job of the workflow runs again"
        );
        assert!(p.broken.is_empty() && p.path_filtered.is_empty());
        let mut p = plan();
        keep_check(&mut p, &push, "Docs / spell");
        assert!(
            p.run.is_empty() && p.path_filtered.len() == 1,
            "a re-run of a skipped check is judged again"
        );
        let mut p = plan();
        keep_check(&mut p, &push, ".forge/workflows/bad.yml (invalid workflow)");
        assert!(p.run.is_empty() && p.broken.len() == 1);
        let mut p = plan();
        keep_check(&mut p, &push, "CI / test (pull_request)");
        assert!(
            p.run.is_empty(),
            "a push run does not report a PR run's check"
        );
        let pr = Trigger::Pull {
            event: Box::new(pull(false, "refs/heads/feature")),
            author: Author::Writer,
        };
        let mut p = plan();
        keep_check(&mut p, &pr, "Lint / lint (pull_request)");
        assert_eq!(p.run.len(), 1);
        assert_eq!(p.run[0].name, "Lint");
    }

    #[test]
    fn the_required_checks_come_from_the_policy() {
        let v = json!({"repo": "o/r", "policy": {"requiredChecks": ["CI / test (pull_request)", "Lint / lint"]}});
        assert_eq!(
            required_checks_of(&v),
            BTreeSet::from([
                "CI / test (pull_request)".to_string(),
                "Lint / lint".to_string()
            ])
        );
        assert!(
            required_checks_of(&json!({"repo": "o/r", "policy": null})).is_empty(),
            "no policy requires nothing"
        );
    }

    #[test]
    fn rerun_requests_read_from_dg() {
        let v = serde_json::json!([{
            "id": "E1", "targetId": "T", "number": 4, "sha": "ab".repeat(20),
            "check": null, "requester": "W", "createdAt": 5, "counts": true
        }, {
            "id": "E2", "targetId": "T", "number": 4, "sha": "ab".repeat(20),
            "check": "CI / build", "requester": "X", "createdAt": 6, "counts": false
        }]);
        let rows: Vec<RerunRow> = serde_json::from_value(v).unwrap();
        assert_eq!(rows[0].check, None);
        assert!(rows[0].counts && !rows[1].counts);
        assert_eq!(rows[1].check.as_deref(), Some("CI / build"));
    }

    /// Hiding is display only: the runner lists every PR, hidden ones too, so a hidden PR still
    /// gets its required checks.
    #[test]
    fn the_runner_lists_hidden_pull_requests_too() {
        let args = list_pulls_args("a/b", "50");
        assert!(args.contains(&"--include-hidden"), "{args:?}");
        assert_eq!(&args[..3], ["pr", "list", "a/b"]);
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
            artifacts: vec!["/a/dist.zip".into()],
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
        let id = external_id("a/b", &push(), f, "build", 1);
        assert!(id.starts_with("forge-runner:") && id.len() == 13 + 40);
        assert_eq!(id, external_id("a/b", &push(), f, "build", 1), "stable");
        assert_ne!(
            id,
            external_id(
                "a/b",
                &push(),
                Path::new(".forge/workflows/other.yml"),
                "build",
                1
            ),
            "the file is part of it"
        );
        // QW4-011: a re-run of the same commit is a check run of its own, never a report that
        // would change the completed one under its id.
        assert_ne!(
            id,
            external_id("a/b", &push(), f, "build", 2),
            "the attempt"
        );
        let long = |s: &str| Push {
            refname: format!("refs/heads/{}{s}", "x".repeat(200)),
            ..push()
        };
        assert_ne!(
            external_id("a/b", &long("1"), f, "b", 1),
            external_id("a/b", &long("2"), f, "b", 1)
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
                retargeted_to: None,
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
    fn a_pull_request_gets_secrets_only_from_a_trusted_branch_here_by_a_maintainer() {
        use Author::{Maintainer, Stranger, Writer};
        let r = trusting();
        let here = pull(false, "refs/heads/release/1");
        assert!(
            pull_trusted(&r, &here.pr, Maintainer),
            "trusted branch here, maintainer"
        );
        assert!(
            !pull_trusted(&r, &here.pr, Writer),
            "a writer who cannot push the trusted branch cannot pick a secrets run's event"
        );
        assert!(
            !pull_trusted(&r, &here.pr, Stranger),
            "a stranger's PR: no secrets"
        );
        let fork = pull(true, "refs/heads/release/1");
        assert!(
            !pull_trusted(&r, &fork.pr, Maintainer),
            "a fork's head never gets secrets, even a maintainer's, even from a trusted name"
        );
        let feature = pull(false, "refs/heads/feature");
        assert!(
            !pull_trusted(&r, &feature.pr, Maintainer),
            "an untrusted branch"
        );
        let short = pull(false, "release/1");
        assert!(
            !pull_trusted(&r, &short.pr, Maintainer),
            "patterns match full ref names"
        );
        let t = Trigger::Pull {
            event: Box::new(fork),
            author: Maintainer,
        };
        assert!(!t.trusted(&r));
        let default = Config::parse("state_dir = \"/s\"\n[[repo]]\nrepo = \"a/b\"")
            .unwrap()
            .repos
            .remove(0);
        assert!(
            !pull_trusted(&default, &here.pr, Maintainer),
            "no trusted_refs: nothing gets secrets"
        );
    }

    #[test]
    fn container_options_never_reach_a_fork_or_a_strangers_pull_request() {
        let r = Config::parse(
            "state_dir = \"/s\"\n[[repo]]\nrepo = \"a/b\"\nallow_container_options = true",
        )
        .unwrap()
        .repos
        .remove(0);
        let pr = |fork, author| Trigger::Pull {
            event: Box::new(pull(fork, "refs/heads/x")),
            author,
        };
        assert!(Trigger::Push(push()).allows_container_options(&r));
        assert!(pr(false, Author::Writer).allows_container_options(&r));
        assert!(
            !pr(true, Author::Maintainer).allows_container_options(&r),
            "a fork"
        );
        assert!(
            !pr(false, Author::Stranger).allows_container_options(&r),
            "a stranger"
        );
        assert!(
            !pr(false, Author::Writer).allows_container_options(&trusting()),
            "off"
        );
    }

    #[test]
    fn members_come_with_their_roles_and_the_owner() {
        let v = serde_json::json!({
            "members": [
                {"identityId": "M", "role": "maintainer"},
                {"identityId": "W", "role": "writer"},
                {"identityId": "B", "role": "writer"},
                {"identityId": "B", "role": "maintainer"},
                {"identityId": "T", "role": "triage"},
                {"identityId": "R", "role": "reader"},
            ],
            "ownerId": "O",
            "roles": true,
        });
        let m = members_of(&v).unwrap();
        // RC2 member roles: triage members and readers cannot push, so a PR of theirs is a
        // stranger's to the runner (no trusted-branch run, no secrets).
        assert_eq!(author_of(&m, "T"), Author::Stranger);
        assert_eq!(author_of(&m, "R"), Author::Stranger);
        assert_eq!(author_of(&m, "M"), Author::Maintainer);
        assert_eq!(author_of(&m, "W"), Author::Writer);
        assert_eq!(
            author_of(&m, "B"),
            Author::Maintainer,
            "the higher role wins"
        );
        assert_eq!(
            author_of(&m, "O"),
            Author::Maintainer,
            "the owner, without a document"
        );
        assert_eq!(author_of(&m, "X"), Author::Stranger);
        assert!(
            members_of(&serde_json::json!({"members": [], "roles": true})).is_err(),
            "a dg without ownerId is refused, not read as 'no owner'"
        );
        // A dg older than member roles lists triage members and readers as "writer": its list
        // is refused rather than trusted.
        let old = serde_json::json!({
            "members": [{"identityId": "T", "role": "writer"}],
            "ownerId": "O",
        });
        let e = members_of(&old).unwrap_err().to_string();
        assert!(e.contains("upgrade dg"), "{e}");
    }

    #[test]
    fn a_pull_requests_checks_are_named_and_keyed_apart_from_pushes() {
        let t = Trigger::Pull {
            event: Box::new(pull(false, "refs/heads/feature")),
            author: Author::Writer,
        };
        let stranger = Trigger::Pull {
            event: Box::new(pull(true, "refs/heads/feature")),
            author: Author::Stranger,
        };
        assert_eq!(
            stranger.check_name("ci / build"),
            "ci / build (pull_request, non-member)",
            "a stranger's run can never be the one a member's required check reads"
        );
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
            external_id("a/b", &k, f, "build", 1),
            external_id("a/b", &as_push, f, "build", 1),
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
    fn a_github_token_in_the_secrets_file_is_found_whatever_its_case() {
        let pairs = |p: &[(&str, &str)]| -> Vec<(String, String)> {
            p.iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect()
        };
        let with = pairs(&[("A", "b"), ("GITHUB_TOKEN", "ghs_FAKE")]);
        assert_eq!(github_token(&with), "ghs_FAKE");
        assert_eq!(
            github_token(&pairs(&[("github_token", "ghs_FAKE")])),
            "ghs_FAKE"
        );
        assert_eq!(github_token(&pairs(&[("GITHUB_TOKEN", "")])), "");
        assert_eq!(github_token(&pairs(&[("GH_TOKEN", "ghs_FAKE")])), "");
    }

    /// A job that prints a secret base64-encoded (a `Basic` credential, at any alignment) or
    /// URL-encoded is masked too.
    #[test]
    fn encoded_secret_values_never_reach_a_log() {
        use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
        use base64::Engine as _;
        let secret = "ghs_FAKE+tok/en=Value?1".to_string();
        let values = std::slice::from_ref(&secret);
        for prefix in ["", "x", "xy", "x-access-token:"] {
            // The characters holding only the secret's bits run from the first character that
            // starts at or after its first bit to the last one that ends by its last bit: all
            // of them go, and at most one character on each side (4 bits of it) is left.
            let (from, to) = (prefix.len() * 8, (prefix.len() + secret.len()) * 8);
            let (first, last) = (from.div_ceil(6), to / 6);
            for encoded in [
                STANDARD.encode(format!("{prefix}{secret}")),
                URL_SAFE_NO_PAD.encode(format!("{prefix}{secret}:suffix")),
            ] {
                let log = format!("Authorization: Basic {encoded}\n");
                let want = format!(
                    "Authorization: Basic {}***{}\n",
                    &encoded[..first],
                    &encoded[last..]
                );
                assert_eq!(redact(&log, values), want, "{prefix:?}");
            }
        }
        let url = "https://h/?t=ghs_FAKE%2Btok%2Fen%3DValue%3F1&x=1";
        assert_eq!(redact(url, values), "https://h/?t=***&x=1");
        assert_eq!(
            redact("plain ghs_FAKE+tok/en=Value?1.", values),
            "plain ***."
        );
    }

    /// End to end through a real process: act gets the token in its environment and a bare
    /// `-s GITHUB_TOKEN`; its argv never holds the value.
    #[cfg(unix)]
    #[test]
    fn act_gets_the_token_in_its_environment_not_its_argv() {
        use std::os::unix::fs::PermissionsExt as _;
        let d = tempfile::tempdir().unwrap();
        let (argv_file, env_file) = (d.path().join("argv"), d.path().join("env"));
        let fake = d.path().join("act");
        std::fs::write(
            &fake,
            format!(
                "#!/bin/sh\nprintf '%s\\n' \"$@\" > '{}'\nprintf '%s' \"$GITHUB_TOKEN\" > '{}'\n",
                argv_file.display(),
                env_file.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o700)).unwrap();
        let c = cfg(&format!("[bin]\nact = \"{}\"", fake.display()));
        let token = "ghs_FAKEtokenFAKEtoken";
        let act_args = act::run_args(
            &c,
            &Invocation {
                event_name: "push",
                checkout: d.path(),
                workflow: d.path(),
                event: d.path(),
                secrets: Some(d.path()),
                github_token: token,
                action_cache: d.path(),
                artifacts: None,
            },
        );
        run_act(&c, &act_args, token, Duration::from_secs(10));
        let argv = std::fs::read_to_string(argv_file).unwrap();
        assert!(!argv.contains("FAKE"), "{argv}");
        assert!(argv.lines().any(|l| l == "GITHUB_TOKEN"), "{argv}");
        assert_eq!(std::fs::read_to_string(env_file).unwrap(), token);
    }

    #[test]
    fn a_hung_act_is_stopped_and_a_missing_act_is_a_crash() {
        let c = cfg("[bin]\nact = \"sleep\"");
        let (_, timed_out, _) = run_act(&c, &["5".into()], "", Duration::from_millis(600));
        assert!(timed_out);
        let c = cfg("[bin]\nact = \"/nonexistent/act\"");
        let (_, timed_out, crashed) = run_act(&c, &[], "", Duration::from_secs(5));
        assert!(!timed_out && crashed);
        let c = cfg("[bin]\nact = \"false\"");
        let (_, _, crashed) = run_act(&c, &[], "", Duration::from_secs(5));
        assert!(!crashed, "a non-zero exit (a failed job) is not a crash");
    }
}
