//! `forge-runner` — a self-hosted CI runner for Dash Forge, built on nektos/act.
//!
//! It watches repositories (`git ls-remote dash://…` every `interval_secs`, and at once when the
//! owner's own relay wakes it, [`relay`]; cursors in the state dir), and on a push it checks the
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
//! `.env`, `.secrets`, `.vars` or `.input`; no cache server is shared between runs. The runner
//! runs pushes to the repository's own refs only, so a pull request from a fork never runs. It
//! does NOT isolate jobs from the Docker daemon it drives: give it a daemon of its own.
//!
//! Module map: [`config`] (runner.toml), [`watch`] (refs, cursors), [`relay`] (wake-ups),
//! [`workflow`] (the YAML the runner reads before act), [`act`] (act's CLI and JSON log),
//! [`run`] (one push end to end).

mod act;
mod config;
mod relay;
mod run;
mod watch;
mod workflow;

use std::path::PathBuf;
use std::time::{Duration, Instant};

use anyhow::{Context as _, Result};
use clap::{Parser, Subcommand};

use crate::config::Config;
use crate::watch::{parse_ls_remote, pushes, state_path, RepoState};

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
    /// Run one commit now, without watching (a manual re-run).
    Run {
        /// The repository (`owner/name`, as configured).
        repo: String,
        /// The ref it was pushed to (`refs/heads/main`).
        #[arg(long = "ref")]
        refname: String,
        /// The commit.
        #[arg(long)]
        sha: String,
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
        Cmd::Run { repo, refname, sha } => {
            let r = cfg
                .repos
                .iter()
                .find(|r| &r.repo == repo)
                .with_context(|| format!("{repo} is not in {}", cli.config.display()))?;
            let push = watch::Push {
                refname: refname.clone(),
                oid: sha.to_ascii_lowercase(),
                before: None,
            };
            let ran = run_locked(&cfg, r, &push)?;
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

/// Run one push in its own directory (`<repo dir>/runs/<n>`), holding the repo's lock so two
/// runners on one state dir never share a checkout. The run directory is removed afterwards;
/// the logs were uploaded.
fn run_locked(cfg: &Config, repo: &config::RepoConfig, push: &watch::Push) -> Result<run::Ran> {
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
    let run_dir = dir.join("runs").join(format!(
        "{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_millis())
    ));
    std::fs::create_dir_all(&run_dir)?;
    let result = run::run_push(cfg, repo, push, &run_dir);
    let _ = std::fs::remove_dir_all(&run_dir);
    drop(lock);
    result
}

/// One poll of one repository: list its refs, run the pushes to watched refs, save the tips.
/// A push whose run could not start (fetch, checkout) is retried on the next polls, up to
/// `attempts`; one whose jobs ran is never re-run (`forge-runner run` does that by hand).
fn poll(cfg: &Config, repo: &config::RepoConfig) -> Result<()> {
    let path = state_path(&cfg.state_dir, &repo.repo);
    let mut state = RepoState::load(&path)?;
    let now = parse_ls_remote(&run::ls_remote(cfg, repo)?);
    if !state.primed {
        // The first poll records where the repository is; it does not run its history.
        eprintln!("forge-runner: watching {} ({} refs)", repo.repo, now.len());
        state.tips = now;
        state.primed = true;
        return state.save(&path);
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
            if let Err(e) = run_locked(cfg, repo, &push) {
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
        k.split_once(' ')
            .is_some_and(|(r, o)| now.get(r).is_some_and(|t| t == o))
    });
    state.save(&path)
}

#[cfg(test)]
mod tests {
    use super::*;

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
