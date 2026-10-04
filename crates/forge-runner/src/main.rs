//! `forge-runner` — a self-hosted CI runner for Dash Forge, built on nektos/act.
//!
//! It watches repositories (`git ls-remote dash://…` every `interval_secs`, and at once when the
//! owner's own relay wakes it, [`relay`]; cursors in the state dir), and on a push, a pull
//! request's activity or a member's CI re-run request (`dg ci reruns`, [`poll_reruns`]) it checks the
//! commit out, runs `.forge/workflows/*.yml` (GitHub Actions syntax) with
//! [act](https://github.com/nektos/act) in Docker, and reports each job as a Forge check run
//! through `dg ci report`, uploading the job's log to a storage profile with its SHA-256. It
//! signs with DASH_FORGE_KEY: a runner key from `dg ci runner new`, which can write check runs
//! and nothing else.
//!
//! What the runner enforces (docs/guides/self-host-runner.md §Security): job containers get no
//! Docker socket and join the `bridge` network; a job that sets docker options or mounts
//! (`container.options` / `.volumes`, the same on services) or calls a reusable workflow is
//! refused unless the repository allows it; secrets and a `GITHUB_TOKEN` go only to
//! `trusted_refs`; act runs with a cleared environment and never reads the checkout's `.actrc`,
//! `.env`, `.secrets`, `.vars` or `.input`; no cache server is shared between runs. Pull
//! requests run as `pull_request` on their head, by default only members' (`pull_requests`), and
//! with the secrets only from a trusted branch of the repository itself by the owner or a maintainer
//! ([`run::pull_trusted`]): a fork's or a stranger's head never gets them. It does NOT isolate
//! jobs from the Docker daemon it drives: give it a daemon of its own.
//!
//! Module map: [`config`] (runner.toml), [`watch`] (refs, cursors), [`relay`] (wake-ups),
//! [`workflow`] (the YAML the runner reads before act), [`act`] (act's CLI and JSON log),
//! [`run`] (one run end to end), [`artifacts`] (upload-artifact's uploads, zipped per artifact).

mod act;
mod artifacts;
mod config;
mod relay;
mod run;
mod watch;
mod workflow;

use std::path::PathBuf;
use std::time::{Duration, Instant};

use anyhow::{Context as _, Result};
use clap::{Parser, Subcommand};

use crate::config::{Config, PullPolicy};
use crate::watch::{parse_ls_remote, pull_events, pushes, state_path, RepoState};

/// forge-runner command line.
#[derive(Debug, Parser)]
#[command(
    name = "forge-runner",
    version,
    about = "Run Dash Forge workflows with act and report check runs"
)]
struct Cli {
    /// The runner configuration (TOML).
    #[arg(long, short = 'c', default_value = "runner.toml", global = true)]
    config: PathBuf,
    #[command(subcommand)]
    command: Cmd,
}

#[derive(Debug, Subcommand)]
enum Cmd {
    /// Watch the configured repositories and run every push (the default service).
    Watch {
        /// Poll once and exit (cron, tests).
        #[arg(long)]
        once: bool,
    },
    /// Run one commit or one pull request now, without watching (a manual re-run, or a PR the
    /// `pull_requests` policy skipped).
    Run {
        /// The repository (`owner/name`, as configured).
        repo: String,
        /// The ref it was pushed to (`refs/heads/main`).
        #[arg(long = "ref", requires = "sha", conflicts_with = "pr")]
        refname: Option<String>,
        /// The commit.
        #[arg(long, requires = "refname")]
        sha: Option<String>,
        /// A pull request: its current head runs as `pull_request` (`opened`), with the secrets
        /// only if its head is a trusted branch here and its author the owner or a maintainer.
        #[arg(long, required_unless_present = "refname")]
        pr: Option<u64>,
        /// Only the workflows that report this check, as it is named on the commit
        /// (`CI / build`, `CI / build (pull_request)`).
        #[arg(long, value_name = "NAME")]
        check: Option<String>,
    },
}

fn main() {
    let cli = Cli::parse();
    if let Err(e) = real_main(&cli) {
        eprintln!("forge-runner: {e:#}");
        std::process::exit(1);
    }
}

fn real_main(cli: &Cli) -> Result<()> {
    let cfg = Config::load(&cli.config)?;
    if std::env::var_os("DASH_FORGE_KEY").is_none() {
        eprintln!(
            "forge-runner: warning: DASH_FORGE_KEY is not set; reports use dg's default identity"
        );
    }
    if cfg.public_log {
        eprintln!(
            "forge-runner: warning: public_log has no effect any more: a private repository's \
             check run cannot carry a log, so its logs are never uploaded"
        );
    }
    match &cli.command {
        Cmd::Watch { once } => watch(&cfg, *once),
        Cmd::Run {
            repo,
            refname,
            sha,
            pr,
            check,
        } => {
            let r = cfg
                .repos
                .iter()
                .find(|r| &r.repo == repo)
                .with_context(|| format!("{repo} is not in {}", cli.config.display()))?;
            let trig = match (refname, sha, pr) {
                (Some(refname), Some(sha), _) => run::Trigger::Push(watch::Push {
                    refname: refname.clone(),
                    oid: sha.to_ascii_lowercase(),
                    before: None,
                }),
                (_, _, Some(n)) => {
                    let mut pr = run::view_pull(&cfg, r, *n)?;
                    anyhow::ensure!(pr.state == "open", "PR #{n} is {}, not open", pr.state);
                    pr.head_oid = pr.head_oid.to_ascii_lowercase();
                    let members = run::list_members(&cfg, r)?;
                    run::Trigger::Pull {
                        author: run::author_of(&members, &pr.author),
                        event: Box::new(watch::PullEvent {
                            action: "opened",
                            before: None,
                            pr,
                        }),
                    }
                }
                _ => anyhow::bail!("give --ref and --sha, or --pr"),
            };
            let opts = run::RunOpts {
                only: check.clone(),
                requested_by: None,
            };
            let ran = run_locked(&cfg, r, &trig, &opts)?;
            for (name, conclusion) in &ran.checks {
                println!("{name}\t{conclusion}");
            }
            Ok(())
        }
    }
}

/// A repository is never polled for a wake within this long of its last poll.
const WAKE_GAP: Duration = Duration::from_secs(10);

/// A woken repository is polled once more this long after the wake: the runner's DAPI node may
/// not have the block the relay saw yet.
const FOLLOW_UP: Duration = Duration::from_secs(20);

/// The polls wakes add, per repository: the wake's own poll and its follow-up, neither within
/// [`WAKE_GAP`] of the repository's last poll. Two times per repository, however many wakes.
#[derive(Debug)]
struct Schedule(Vec<RepoTimes>);

/// One repository's times in a [`Schedule`].
#[derive(Debug, Clone, Default)]
struct RepoTimes {
    /// When its last poll ended.
    last: Option<Instant>,
    /// The earliest wake not yet served.
    next: Option<Instant>,
    /// The follow-up poll of the latest wake.
    follow: Option<Instant>,
}

impl Schedule {
    fn new(repos: usize) -> Self {
        Self(vec![RepoTimes::default(); repos])
    }

    /// Repository `i` was woken at `now`.
    fn wake(&mut self, i: usize, now: Instant) {
        let r = &mut self.0[i];
        r.next = Some(r.next.map_or(now, |t| t.min(now)));
        r.follow = Some(now + FOLLOW_UP);
    }

    /// When repository `i` is due for a wake's poll, if it is.
    fn due_at(&self, i: usize) -> Option<Instant> {
        let r = &self.0[i];
        let t = r.next.into_iter().chain(r.follow).min()?;
        Some(r.last.map_or(t, |l| t.max(l + WAKE_GAP)))
    }

    /// Repository `i` was polled, ending at `now`: every wake up to then is served.
    fn polled(&mut self, i: usize, now: Instant) {
        let r = &mut self.0[i];
        r.last = Some(now);
        r.next = r.next.filter(|t| *t > now);
        r.follow = r.follow.filter(|t| *t > now);
    }
}

/// The watch loop: every repository every `interval_secs`, and, with a `[relay]`, a woken one
/// as soon as the relay says ([`Schedule`]). Without a relay, or while it is unreachable, the
/// interval alone drives the runner.
fn watch(cfg: &Config, once: bool) -> Result<()> {
    let mut wakes = match (&cfg.relay, once) {
        (Some(r), false) => {
            let secret = relay::read_secret(&r.secret_file)?;
            let (tx, rx) = std::sync::mpsc::channel();
            relay::spawn(r.url.clone(), secret, tx);
            Some(rx)
        }
        _ => None,
    };
    let n = cfg.repos.len();
    let interval = Duration::from_secs(cfg.interval_secs);
    let mut sched = Schedule::new(n);
    let mut next_all = Instant::now();
    let mut told_unmatched = false;
    let poll_one = |i: usize, sched: &mut Schedule| {
        let repo = &cfg.repos[i];
        if let Err(e) = poll(cfg, repo) {
            eprintln!("forge-runner: {}: {e:#}", repo.repo);
        }
        sched.polled(i, Instant::now());
    };
    loop {
        if Instant::now() >= next_all {
            for i in 0..n {
                poll_one(i, &mut sched);
            }
            if once {
                return Ok(());
            }
            next_all = Instant::now() + interval;
            continue;
        }
        let now = Instant::now();
        if let Some(i) = (0..n).find(|i| sched.due_at(*i).is_some_and(|t| t <= now)) {
            poll_one(i, &mut sched);
            continue;
        }
        let until = (0..n)
            .filter_map(|i| sched.due_at(i))
            .fold(next_all, Instant::min);
        let wait = until.saturating_duration_since(now);
        let Some(rx) = &wakes else {
            std::thread::sleep(wait);
            continue;
        };
        let first = match rx.recv_timeout(wait) {
            Ok(w) => w,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                wakes = None;
                continue;
            }
        };
        for w in std::iter::once(first).chain(rx.try_iter()) {
            let hit = woken(cfg, &w);
            if hit.is_empty() && !told_unmatched {
                told_unmatched = true;
                eprintln!(
                    "forge-runner: the relay woke {w:?}, none of which is a configured `repo` \
                     (spell it as the relay's [wake] repos entry or <owner id>/<name>); \
                     said once"
                );
            }
            for i in hit {
                sched.wake(i, Instant::now());
            }
        }
    }
}

/// The configured repositories (by index) a wake names.
fn woken(cfg: &Config, w: &relay::Wake) -> Vec<usize> {
    match w {
        relay::Wake::All => (0..cfg.repos.len()).collect(),
        relay::Wake::Repos(names) => cfg
            .repos
            .iter()
            .enumerate()
            .filter(|(_, r)| names.iter().flatten().any(|n| *n == r.repo))
            .map(|(i, _)| i)
            .collect(),
    }
}

/// Run one push or pull request in its own directory (`<repo dir>/runs/<n>`), holding the repo's
/// lock so two runners on one state dir never share a checkout. The run directory is removed
/// afterwards; the logs were uploaded.
fn run_locked(
    cfg: &Config,
    repo: &config::RepoConfig,
    trig: &run::Trigger,
    opts: &run::RunOpts,
) -> Result<run::Ran> {
    let dir = run::repo_dir(cfg, repo);
    std::fs::create_dir_all(&dir)?;
    let lock_path = dir.join("lock");
    let lock = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(&lock_path)
        .with_context(|| format!("opening {}", lock_path.display()))?;
    lock.try_lock().map_err(|_| {
        anyhow::anyhow!(
            "another forge-runner is running {} ({} is locked)",
            repo.repo,
            lock_path.display()
        )
    })?;
    run::reset_toolcache(cfg);
    let run_dir = dir
        .join("runs")
        .join(format!("{}-{}", std::process::id(), run::now_ms()));
    std::fs::create_dir_all(&run_dir)?;
    let result = run::run(cfg, repo, trig, opts, &run_dir);
    let _ = std::fs::remove_dir_all(&run_dir);
    drop(lock);
    result
}

/// How many of a repository's newest pull requests a poll reads (dg's page).
const PULL_LIMIT: u32 = 100;

/// How many members' open PRs that fell out of the newest [`PULL_LIMIT`] a poll still reads, one
/// read each, in turn ([`watch::RepoState::to_follow`]).
const FOLLOW_BEYOND: usize = 10;

/// One poll of one repository: list its refs, run the pushes to watched refs, then its pull
/// requests' activity (unless `pull_requests = "off"`), and save what was handled. A run that
/// could not start (fetch, checkout) is retried on the next polls, up to `attempts`; one whose
/// jobs ran is never re-run (`forge-runner run` does that by hand).
fn poll(cfg: &Config, repo: &config::RepoConfig) -> Result<()> {
    let path = state_path(&cfg.state_dir, &repo.repo);
    let mut state = RepoState::load(&path)?;
    let now = parse_ls_remote(&run::ls_remote(cfg, repo)?);
    if !state.primed {
        // The first poll records where the repository is; it does not run its history.
        eprintln!("forge-runner: watching {} ({} refs)", repo.repo, now.len());
        state.tips = now;
        state.primed = true;
        state.save(&path)?;
        let pulls = poll_pulls(cfg, repo, &mut state, &path);
        return pulls.and(poll_reruns(cfg, repo, &mut state, &path));
    }
    for push in pushes(&state.tips, &now) {
        let key = format!("{} {}", push.refname, push.oid);
        let mut done = true;
        if repo.runs(&push.refname) {
            eprintln!(
                "forge-runner: {} {} → {}",
                repo.repo,
                push.refname,
                &push.oid[..12]
            );
            let trig = run::Trigger::Push(push.clone());
            if let Err(e) = run_locked(cfg, repo, &trig, &run::RunOpts::default()) {
                let tries = state.failed.entry(key.clone()).or_insert(0);
                *tries += 1;
                eprintln!(
                    "forge-runner: {} {} (attempt {tries} of {}): {e:#}",
                    repo.repo, push.refname, cfg.attempts
                );
                done = *tries >= cfg.attempts;
            }
        }
        if done {
            state.failed.remove(&key);
            state.tips.insert(push.refname.clone(), push.oid.clone());
        }
        state.save(&path)?;
    }
    // Deleted refs leave the cursor too, and so do retries of refs that moved on.
    state.tips.retain(|r, _| now.contains_key(r));
    state.failed.retain(|k, _| {
        k.starts_with("pull/")
            || k.split_once(' ')
                .is_some_and(|(r, o)| now.get(r).is_some_and(|t| t == o))
    });
    state.save(&path)?;
    let pulls = poll_pulls(cfg, repo, &mut state, &path);
    // Re-run requests are read even when the pull requests could not be.
    let reruns = poll_reruns(cfg, repo, &mut state, &path);
    pulls.and(reruns)
}

/// The pull-request half of a poll: list the newest [`PULL_LIMIT`] PRs, and run each one that
/// was opened, reopened, marked ready or whose head moved since the last poll, as the
/// repository's `pull_requests` policy allows. The first read only records them.
///
/// The list is the newest PRs by creation, open or closed, and anyone may open PRs: members'
/// open ones that fall out of it are kept and read one by one, in turn, up to
/// [`FOLLOW_BEYOND`], so a burst of newer PRs cannot push them out of CI.
fn poll_pulls(
    cfg: &Config,
    repo: &config::RepoConfig,
    state: &mut RepoState,
    path: &std::path::Path,
) -> Result<()> {
    if repo.pull_requests == PullPolicy::Off {
        // Forget them, so turning PRs back on starts afresh rather than replaying a backlog.
        if state.pulls_primed || !state.pulls.is_empty() {
            state.pulls.clear();
            state.pulls_primed = false;
            state.failed.retain(|k, _| !k.starts_with("pull/"));
            state.save(path)?;
        }
        return Ok(());
    }
    let mut rows = run::list_pulls(cfg, repo, PULL_LIMIT)?;
    for n in state.next_to_follow(&rows, FOLLOW_BEYOND) {
        match run::view_pull(cfg, repo, n) {
            Ok(r) => rows.push(r),
            Err(e) => eprintln!("forge-runner: {} PR #{n}: {e:#}", repo.repo),
        }
    }
    if !state.pulls_primed {
        let open = rows.iter().filter(|r| r.state == "open").count();
        eprintln!(
            "forge-runner: watching {}'s pull requests ({open} open)",
            repo.repo
        );
        let members = run::list_members(cfg, repo)?;
        for r in &rows {
            let member = run::author_of(&members, &r.author) != run::Author::Stranger;
            state.saw_pull(r, Some(member));
        }
        state.pulls_primed = true;
        return state.save(path);
    }
    // Read only when some PR has activity.
    let mut members: Option<run::Members> = None;
    let pull_key = |n: u64, head: &str| format!("pull/{n} {}", head.to_ascii_lowercase());
    let mut pending = Vec::new();
    for ev in pull_events(&state.pulls, &rows) {
        let n = ev.pr.number;
        let key = pull_key(n, &ev.pr.head_oid);
        let members = match &members {
            Some(m) => m,
            None => members.insert(run::list_members(cfg, repo)?),
        };
        let author = run::author_of(members, &ev.pr.author);
        let mut done = true;
        if let Some(why) = skip_reason(repo.pull_requests, &ev.pr, author) {
            eprintln!(
                "forge-runner: {} PR #{n} by {} not run: {why}",
                repo.repo, ev.pr.author
            );
        } else {
            eprintln!(
                "forge-runner: {} PR #{n} {} → {}",
                repo.repo,
                ev.action,
                &ev.pr.head_oid[..12]
            );
            let trig = run::Trigger::Pull {
                event: Box::new(ev.clone()),
                author,
            };
            if let Err(e) = run_locked(cfg, repo, &trig, &run::RunOpts::default()) {
                let tries = state.failed.entry(key.clone()).or_insert(0);
                *tries += 1;
                eprintln!(
                    "forge-runner: {} PR #{n} (attempt {tries} of {}): {e:#}",
                    repo.repo, cfg.attempts
                );
                done = *tries >= cfg.attempts;
            }
        }
        if done {
            state.failed.remove(&key);
            state.saw_pull(&ev.pr, Some(author != run::Author::Stranger));
        } else {
            pending.push(n);
        }
        state.save(path)?;
    }
    // Everything else read is as seen (closed, merged, unchanged). A PR not read this time is
    // forgotten, unless it is a member's open one: those are followed in turn, and a failed
    // read does not drop them. Retries of heads that moved on go too.
    for r in rows.iter().filter(|r| !pending.contains(&r.number)) {
        state.saw_pull(r, None);
    }
    state
        .pulls
        .retain(|n, s| (s.open && s.member) || rows.iter().any(|r| r.number == *n));
    state.failed.retain(|k, _| {
        !k.starts_with("pull/")
            || rows
                .iter()
                .any(|r| r.state == "open" && pull_key(r.number, &r.head_oid) == *k)
    });
    state.save(path)
}

/// The CI re-run half of a poll (`reruns = true`): read the requests written since the last
/// poll (`dg ci reruns`, one query on the `addressee` index) and run each that counts, once per
/// pull request, commit and check in a poll ([`rerun_trigger`] decides what runs). The first poll
/// only records the runner's clock. A request is handled once, whatever came of it: a failed run
/// is asked for again from the web or `dg ci rerun`.
fn poll_reruns(
    cfg: &Config,
    repo: &config::RepoConfig,
    state: &mut RepoState,
    path: &std::path::Path,
) -> Result<()> {
    if !repo.reruns {
        return Ok(());
    }
    let Some(since) = state.reruns_since else {
        state.reruns_since = Some(run::now_ms());
        return state.save(path);
    };
    let fresh: Vec<run::RerunRow> = run::list_reruns(cfg, repo, since)?
        .into_iter()
        .filter(|r| {
            r.created_at > since || (r.created_at == since && !state.reruns_seen.contains(&r.id))
        })
        .collect();
    let mut members: Option<run::Members> = None;
    let mut done = std::collections::BTreeSet::new();
    for req in fresh {
        let what = format!(
            "{} PR #{} re-run of {} on {} by {}",
            repo.repo,
            req.number,
            req.check.as_deref().unwrap_or("every check"),
            req.sha.get(..12).unwrap_or(&req.sha),
            req.requester
        );
        if !req.counts {
            eprintln!("forge-runner: {what} not run: the requester is not the owner, a maintainer or a writer");
        } else if !done.insert((req.number, req.sha.to_ascii_lowercase(), req.check.clone())) {
            eprintln!("forge-runner: {what}: the same as an earlier request in this poll");
        } else {
            match rerun_triggers(cfg, repo, state, &req, &mut members) {
                Ok(triggers) => {
                    eprintln!("forge-runner: {what}");
                    let opts = run::RunOpts {
                        only: req.check.clone(),
                        requested_by: Some(req.requester.clone()),
                    };
                    for trig in &triggers {
                        if let Err(e) = run_locked(cfg, repo, trig, &opts) {
                            eprintln!("forge-runner: {what} ({}): {e:#}", trig.label());
                        }
                    }
                }
                Err(why) => eprintln!("forge-runner: {what} not run: {why}"),
            }
        }
        state.handled_rerun(&req.id, req.created_at);
        state.save(path)?;
    }
    Ok(())
}

/// What a counted re-run request runs, or why it runs nothing. Only the PR's current head
/// runs, and only what a poll would run for it:
///
/// * a check of the PR's own runs (` (pull_request)` or ` (pull_request, non-member)`): the PR as
///   `pull_request`, under the repository's `pull_requests` policy ([`skip_reason`]);
/// * any other check (a push run's): the push of the branch at that commit, the PR's own source
///   branch here first, then any watched branch of the repository that is at it;
/// * every check (no name): both, each where it applies.
fn rerun_triggers(
    cfg: &Config,
    repo: &config::RepoConfig,
    state: &RepoState,
    req: &run::RerunRow,
    members: &mut Option<run::Members>,
) -> std::result::Result<Vec<run::Trigger>, String> {
    let sha = req.sha.to_ascii_lowercase();
    let mut pr = run::view_pull(cfg, repo, req.number).map_err(|e| format!("{e:#}"))?;
    pr.head_oid = pr.head_oid.to_ascii_lowercase();
    if pr.state != "open" {
        return Err(format!("the pull request is {}", pr.state));
    }
    if pr.head_oid != sha {
        return Err(format!(
            "its head moved to {} since (the new head runs by itself)",
            &pr.head_oid[..12.min(pr.head_oid.len())]
        ));
    }
    let (pull, push) = match req.check.as_deref() {
        None => (true, true),
        Some(c) => (is_pull_check(c), !is_pull_check(c)),
    };
    let mut out = Vec::new();
    let mut why = Vec::new();
    if push {
        match branch_at(repo, state, &pr, &sha) {
            Ok(refname) => out.push(run::Trigger::Push(watch::Push {
                refname,
                oid: sha.clone(),
                before: None,
            })),
            Err(e) => why.push(e),
        }
    }
    if pull {
        match pull_rerun(cfg, repo, pr, members) {
            Ok(t) => out.push(t),
            Err(e) => why.push(e),
        }
    }
    if out.is_empty() {
        return Err(why.join("; "));
    }
    Ok(out)
}

/// The watched branch of the repository a push check on `sha` re-runs as: the PR's own source
/// branch when it is here and at `sha`, else any branch at it.
fn branch_at(
    repo: &config::RepoConfig,
    state: &RepoState,
    pr: &watch::PullRow,
    sha: &str,
) -> std::result::Result<String, String> {
    let at = |r: &str| {
        r.starts_with("refs/heads/") && state.tips.get(r).is_some_and(|t| t == sha) && repo.runs(r)
    };
    let own = pr
        .source_ref_name
        .as_deref()
        .filter(|r| !pr.is_fork() && at(r));
    own.map(str::to_string)
        .or_else(|| state.tips.keys().find(|r| at(r)).cloned())
        .ok_or_else(|| {
            format!(
                "no watched branch of this repository is at {}",
                &sha[..12.min(sha.len())]
            )
        })
}

/// The PR's re-run as `pull_request` (`opened`), when the repository's policy runs it.
fn pull_rerun(
    cfg: &Config,
    repo: &config::RepoConfig,
    pr: watch::PullRow,
    members: &mut Option<run::Members>,
) -> std::result::Result<run::Trigger, String> {
    if repo.pull_requests == PullPolicy::Off {
        return Err("this runner does not run pull requests (pull_requests = \"off\")".into());
    }
    if pr.source_ref_name.is_none() {
        return Err("the pull request names no source branch (imported)".into());
    }
    let members = match members {
        Some(m) => m,
        None => members.insert(run::list_members(cfg, repo).map_err(|e| format!("{e:#}"))?),
    };
    let author = run::author_of(members, &pr.author);
    if let Some(why) = skip_reason(repo.pull_requests, &pr, author) {
        return Err(why);
    }
    Ok(run::Trigger::Pull {
        author,
        event: Box::new(watch::PullEvent {
            action: "opened",
            before: None,
            pr,
        }),
    })
}

/// Whether a check name is a pull request run's ([`run::Trigger::check_name`]'s suffixes).
fn is_pull_check(name: &str) -> bool {
    name.ends_with(" (pull_request)") || name.ends_with(" (pull_request, non-member)")
}

/// Why a poll does not run a PR's activity, if it does not:
///
/// * `pull_requests = "members"` runs members' PRs only;
/// * a stranger's PR whose head is a branch of the repository itself never runs by itself:
///   members pushed that code and its push run tested it, and running it again would only let
///   a stranger pick the event (base, title) of a run on a member's commit.
///
/// `forge-runner run --pr` runs either by hand.
fn skip_reason(policy: PullPolicy, pr: &watch::PullRow, author: run::Author) -> Option<String> {
    let hint = format!("`forge-runner run <repo> --pr {}` runs it", pr.number);
    if author != run::Author::Stranger {
        None
    } else if policy == PullPolicy::Members {
        Some(format!(
            "not a member (pull_requests = \"members\"); {hint}, without secrets"
        ))
    } else if !pr.is_fork() {
        Some(format!(
            "not a member, and its head is a branch of this repository, which its push runs \
             test; {hint}"
        ))
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strangers_pull_requests_run_only_from_forks_and_only_when_all_are_allowed() {
        use run::Author::{Maintainer, Stranger, Writer};
        let row = |fork: bool| watch::PullRow {
            number: 4,
            title: String::new(),
            author: "A".into(),
            state: "open".into(),
            base_ref: "refs/heads/main".into(),
            retargeted_to: None,
            base_tip: None,
            head_oid: "ab".repeat(20),
            repo_id: "R".into(),
            source_repo_id: if fork { "F" } else { "R" }.into(),
            source_ref_name: Some("refs/heads/x".into()),
            draft: false,
        };
        for policy in [PullPolicy::Members, PullPolicy::All] {
            for fork in [false, true] {
                assert!(skip_reason(policy, &row(fork), Writer).is_none());
                assert!(skip_reason(policy, &row(fork), Maintainer).is_none());
            }
        }
        assert!(skip_reason(PullPolicy::Members, &row(true), Stranger).is_some());
        assert!(skip_reason(PullPolicy::All, &row(true), Stranger).is_none());
        assert!(
            skip_reason(PullPolicy::All, &row(false), Stranger).is_some(),
            "a stranger's PR from a branch here re-runs members' code under a stranger's event"
        );
    }

    #[test]
    fn pull_request_checks_are_told_from_push_checks_by_their_suffix() {
        assert!(is_pull_check("CI / build (pull_request)"));
        assert!(is_pull_check("CI / build (pull_request, non-member)"));
        assert!(!is_pull_check("CI / build"));
        assert!(!is_pull_check("CI / build (schedule)"));
    }

    #[test]
    fn a_wake_names_repositories_by_either_spelling() {
        let cfg = Config::parse(
            "state_dir = \"/s\"\n[[repo]]\nrepo = \"alice/one\"\n[[repo]]\nrepo = \"OwnerId/two\"",
        )
        .unwrap();
        let w = relay::Wake::Repos(vec![
            vec!["OwnerId/one".into(), "alice/one".into()],
            vec!["OwnerId/two".into(), "bob/two".into()],
            vec!["OwnerId/three".into()],
        ]);
        assert_eq!(woken(&cfg, &w), [0, 1]);
        assert_eq!(woken(&cfg, &relay::Wake::All), [0, 1]);
        assert!(woken(&cfg, &relay::Wake::Repos(vec![vec!["x/y".into()]])).is_empty());
    }

    #[test]
    fn wakes_poll_now_and_once_more_but_never_within_the_gap() {
        let t0 = Instant::now();
        let s = |secs: u64| t0 + Duration::from_secs(secs);
        let mut sc = Schedule::new(2);
        assert_eq!(sc.due_at(0), None, "no wake, no extra poll");
        sc.wake(0, s(0));
        assert_eq!(sc.due_at(0), Some(s(0)), "a wake is served at once");
        assert_eq!(sc.due_at(1), None);
        sc.polled(0, s(2));
        assert_eq!(sc.due_at(0), Some(s(20)), "then the follow-up");
        // A second wake right after the poll waits out the gap, and moves the follow-up.
        sc.wake(0, s(3));
        assert_eq!(
            sc.due_at(0),
            Some(s(12)),
            "not within 10 s of the last poll"
        );
        sc.polled(0, s(12));
        assert_eq!(sc.due_at(0), Some(s(23)));
        // However many wakes arrive, a repo holds two times.
        for k in 0..100 {
            sc.wake(0, s(13 + k));
        }
        sc.polled(0, s(200));
        assert_eq!(sc.due_at(0), None, "a long poll served them all");
    }
}
