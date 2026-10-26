//! Check reports a run could not deliver after its jobs ran, kept for the next polls to resend.
//!
//! A job that ran is never run again just to report it: its steps may deploy, use secrets or
//! pay for writes. The report is kept instead, as the `dg ci report` arguments of its result
//! without artifacts, with its log copied out of the run's directory (a later run of the same
//! push replaces that directory). Each poll of the repository resends what is kept
//! ([`resend`]) before it reads new pushes. Both run under the repository's lock, so a report
//! kept by one runner is never dropped by another's save.

use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{Context as _, Result};
use serde::{Deserialize, Serialize};

use crate::config::Config;
use crate::run::{output, report_args, with_network, Report};

/// How many polls resend a kept report before the runner gives up on it and says how to send it
/// by hand.
pub const MAX_TRIES: u32 = 48;

/// One kept report.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Pending {
    pub repo: String,
    pub name: String,
    /// The `dg` arguments (the network flags come from the environment, as for every report).
    pub args: Vec<String>,
    /// The copied log, removed once the report lands or is given up on.
    #[serde(default)]
    pub log: Option<PathBuf>,
    /// How many polls tried it.
    #[serde(default)]
    pub tries: u32,
}

/// Where `repo`'s kept reports live, beside its watch state.
pub fn path(state_dir: &Path, repo: &str) -> PathBuf {
    state_dir
        .join("repos")
        .join(format!("{}.pending.json", repo.replace('/', "__")))
}

/// How many reports `repo` has kept (a hand run says so: nothing may resend them).
pub fn count(state_dir: &Path, repo: &str) -> usize {
    load(&path(state_dir, repo)).map_or(0, |all| all.len())
}

/// The kept reports; a file that does not parse is moved aside (and said), not retried forever.
fn load(p: &Path) -> Result<Vec<Pending>> {
    let bytes = match std::fs::read(p) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e).with_context(|| format!("reading {}", p.display())),
    };
    match serde_json::from_slice(&bytes) {
        Ok(all) => Ok(all),
        Err(e) => {
            let aside = p.with_extension(format!("json.corrupt-{}", crate::run::now_ms()));
            eprintln!(
                "forge-runner: {} does not parse ({e}); moved to {}, its reports are not resent",
                p.display(),
                aside.display()
            );
            std::fs::rename(p, &aside).with_context(|| format!("moving {} aside", p.display()))?;
            Ok(Vec::new())
        }
    }
}

/// Readable by the runner's user only: a members-only run's log is members-only content.
fn private(p: &Path, mode: u32) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let _ = std::fs::set_permissions(p, std::fs::Permissions::from_mode(mode));
    }
    #[cfg(not(unix))]
    let _ = (p, mode);
}

fn save(p: &Path, all: &[Pending]) -> Result<()> {
    if all.is_empty() {
        return match std::fs::remove_file(p) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.into()),
            _ => Ok(()),
        };
    }
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = p.with_extension(format!("json.{}.tmp", std::process::id()));
    {
        use std::io::Write as _;
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(&serde_json::to_vec_pretty(all)?)?;
        f.sync_all()?;
    }
    private(&tmp, 0o600);
    std::fs::rename(&tmp, p).with_context(|| format!("writing {}", p.display()))
}

/// Keep `r`, a completed report that could not be delivered, for the next polls: its result
/// without artifacts (their upload is what may have failed), its log copied to the state
/// directory.
pub fn keep(cfg: &Config, r: &Report<'_>) -> Result<()> {
    let mut bare = r.clone();
    if !bare.artifacts.is_empty() {
        bare.artifacts.clear();
        bare.summary = bare
            .summary
            .map(|s| format!("{s}; artifacts not recorded: their upload failed"));
    }
    if let Some(log) = &r.log {
        use sha2::{Digest as _, Sha256};
        let dir = cfg.state_dir.join("pending-logs");
        std::fs::create_dir_all(&dir)?;
        private(&dir, 0o700);
        let id = hex::encode(Sha256::digest(format!("{}\n{}", r.external_id, r.name)));
        let copy = dir.join(format!("{id}.log"));
        std::fs::copy(log, &copy).with_context(|| format!("keeping {}", log.display()))?;
        private(&copy, 0o600);
        bare.log = Some(copy);
    }
    let entry = Pending {
        repo: r.repo.to_string(),
        name: r.name.clone(),
        args: report_args(cfg, &bare),
        log: bare.log.clone(),
        tries: 0,
    };
    let p = path(&cfg.state_dir, r.repo);
    let mut all = load(&p)?;
    all.retain(|e| e.args != entry.args);
    all.push(entry);
    save(&p, &all)
}

/// The `dg` arguments that send `r` by hand once the run's directory is gone: its result,
/// without the log and artifacts that lived there.
pub fn hand_args(cfg: &Config, r: &Report<'_>) -> Vec<String> {
    let mut bare = r.clone();
    bare.log = None;
    bare.artifacts.clear();
    report_args(cfg, &bare)
}

/// Resend `repo`'s kept reports once each (the caller holds the repository's lock): drop those
/// that land, and give up on those tried [`MAX_TRIES`] times, saying how to send them by hand
/// (their log copy stays for that).
pub fn resend(cfg: &Config, repo: &str) -> Result<()> {
    resend_with(cfg, repo, |args| {
        let mut cmd = with_network(Command::new(&cfg.bin.dg), cfg);
        cmd.args(args);
        output(&mut cmd, "dg ci report")
            .map(|_| ())
            .map_err(|e| format!("{e:#}"))
    })
}

fn resend_with(
    cfg: &Config,
    repo: &str,
    mut send: impl FnMut(&[String]) -> std::result::Result<(), String>,
) -> Result<()> {
    let p = path(&cfg.state_dir, repo);
    let all = load(&p)?;
    if all.is_empty() {
        return Ok(());
    }
    let mut left = Vec::new();
    for mut e in all {
        match send(&e.args) {
            Ok(()) => {
                eprintln!(
                    "forge-runner: {} {}: the kept report landed",
                    e.repo, e.name
                );
                if let Some(log) = &e.log {
                    let _ = std::fs::remove_file(log);
                }
            }
            Err(why) => {
                e.tries += 1;
                if e.tries >= MAX_TRIES {
                    // the log copy stays: the command names it
                    eprintln!(
                        "forge-runner: {} {}: gave up on the kept report after {} polls ({why}); send it by hand, then delete {}: dg {}",
                        e.repo,
                        e.name,
                        e.tries,
                        e.log.as_deref().map_or_else(|| "nothing".into(), |l| l.display().to_string()),
                        e.args.join(" ")
                    );
                } else {
                    eprintln!(
                        "forge-runner: {} {}: the kept report is still not delivered (poll {} of {MAX_TRIES}): {why}",
                        e.repo, e.name, e.tries
                    );
                    left.push(e);
                }
            }
        }
    }
    save(&p, &left)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(state_dir: &Path) -> Config {
        Config::parse(&format!(
            "state_dir = \"{}\"\n[[repo]]\nrepo = \"alice/project\"\n",
            state_dir.display()
        ))
        .unwrap()
    }

    fn report<'a>(log: Option<PathBuf>, artifacts: Vec<PathBuf>) -> Report<'a> {
        Report {
            repo: "alice/project",
            oid: "0123456789abcdef0123456789abcdef01234567",
            name: "ci / build (push)".into(),
            external_id: "forge-runner:abc".into(),
            status: "completed",
            conclusion: Some("success"),
            summary: Some("forge-runner: success".into()),
            log,
            artifacts,
            members_branch: None,
        }
    }

    #[test]
    fn a_kept_report_is_resent_until_it_lands_and_its_log_survives_the_run() {
        let d = tempfile::tempdir().unwrap();
        let c = cfg(d.path());
        let run_log = d.path().join("run.log");
        std::fs::write(&run_log, "job output").unwrap();
        keep(
            &c,
            &report(Some(run_log.clone()), vec![d.path().join("a.zip")]),
        )
        .unwrap();
        // the run's directory goes away; the kept copy does not
        std::fs::remove_file(&run_log).unwrap();
        let kept = load(&path(d.path(), "alice/project")).unwrap();
        assert_eq!(kept.len(), 1);
        let copy = kept[0].log.clone().unwrap();
        assert_eq!(std::fs::read_to_string(&copy).unwrap(), "job output");
        assert!(
            !kept[0].args.iter().any(|a| a == "--artifact"),
            "kept without artifacts"
        );

        // a poll that cannot deliver keeps it, counting the try
        resend_with(&c, "alice/project", |_| Err("down".into())).unwrap();
        assert_eq!(load(&path(d.path(), "alice/project")).unwrap()[0].tries, 1);
        // the next one delivers it: the entry and its log are gone
        let mut sent = Vec::new();
        resend_with(&c, "alice/project", |a| {
            sent.push(a.to_vec());
            Ok(())
        })
        .unwrap();
        assert_eq!(sent.len(), 1);
        assert!(load(&path(d.path(), "alice/project")).unwrap().is_empty());
        assert!(!copy.exists());
    }

    #[test]
    fn a_report_kept_twice_is_one_entry_and_one_given_up_on_keeps_its_log() {
        let d = tempfile::tempdir().unwrap();
        let c = cfg(d.path());
        let run_log = d.path().join("run.log");
        std::fs::write(&run_log, "job output").unwrap();
        keep(&c, &report(Some(run_log.clone()), Vec::new())).unwrap();
        keep(&c, &report(Some(run_log), Vec::new())).unwrap();
        let kept = load(&path(d.path(), "alice/project")).unwrap();
        assert_eq!(kept.len(), 1);
        assert_eq!(count(d.path(), "alice/project"), 1);
        let copy = kept[0].log.clone().unwrap();
        for _ in 0..MAX_TRIES {
            resend_with(&c, "alice/project", |_| Err("down".into())).unwrap();
        }
        assert_eq!(count(d.path(), "alice/project"), 0);
        // the give-up message names the copy, so it is still there to send by hand
        assert!(copy.exists());
    }

    #[test]
    fn a_pending_file_that_does_not_parse_is_moved_aside() {
        let d = tempfile::tempdir().unwrap();
        let c = cfg(d.path());
        let p = path(d.path(), "alice/project");
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, "{not json").unwrap();
        resend_with(&c, "alice/project", |_| Ok(())).unwrap();
        assert!(!p.exists());
        // a new report can be kept again
        keep(&c, &report(None, Vec::new())).unwrap();
        assert_eq!(count(d.path(), "alice/project"), 1);
    }

    #[test]
    fn hand_args_carry_no_path_from_the_run_directory() {
        let d = tempfile::tempdir().unwrap();
        let c = cfg(d.path());
        let a = hand_args(
            &c,
            &report(Some(d.path().join("run.log")), vec![d.path().join("a.zip")]),
        );
        assert!(
            !a.iter().any(|a| a == "--log" || a == "--artifact"),
            "{a:?}"
        );
    }
}
