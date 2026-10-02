//! Pin the repository a `dash://<owner>/<name>` URL resolved to when the clone was made
//! (BACKLOG S2: DPNS name → repoId pinning).
//!
//! A DPNS name is a pointer, not an identity: a name can change hands, and a URL spelled
//! with one would then resolve to another identity's repository of the same name. Fetching
//! from it would mix a stranger's history into the clone, and pushing would send commits to
//! them. So the first time this helper resolves a named URL inside a repository (the clone
//! itself, or the first fetch of an existing one), it records what the URL resolved to in
//! that repository's own git config, per network:
//!
//! ```text
//! [dash "devnet-sakura:dash://alice/project"]
//!     repoId = <base58 repo document id>
//!     ownerId = <base58 owner identity id>
//! ```
//!
//! Every later fetch or push compares. A different repository is refused (E504) unless the
//! user says otherwise, once, with `git -c dash.allowRepin=true <fetch|push>` (or by setting
//! `dash.allowRepin`): then the helper warns loudly, re-pins and goes on. The same URL on
//! another network is another namespace with its own pin. An id-addressed URL
//! (`dash://<repo id>`) needs no pin: the id is the repository.
//!
//! This guards git's transport (fetch, push, clone). `dg` commands run in a clone check the
//! same pin before they read or write the repository a pinned name names (QW4-013); the
//! section and the comparison are shared ([`forge_core::repo_pin`]), and only git re-pins.

use std::path::Path;
use std::process::Command;

use anyhow::{anyhow, bail, Result};
use forge_core::user_error::{codes, UserError};

use crate::url::DashUrl;

use forge_core::repo_pin::shown;
pub use forge_core::repo_pin::{Recorded, ALLOW_REPIN_GIT_KEY};

/// What a named URL resolves to now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pin {
    /// The forge-v2 `repo` document id.
    pub repo_id: String,
    /// The repository owner's identity id.
    pub owner_id: String,
    /// The network key it was resolved on (`testnet`, `devnet-sakura`, …).
    pub network: String,
}

/// What [`guard`] found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// An id-addressed URL: nothing to pin.
    NotApplicable,
    /// Nothing was pinned yet for this URL on this network: it is now (or a warning said
    /// why it could not be recorded).
    Pinned,
    /// The URL still resolves to the pinned repository.
    Matches,
    /// The URL resolves elsewhere and `dash.allowRepin` allowed it: re-pinned.
    Repinned {
        /// The previous pin.
        was: Recorded,
    },
}

/// The git config section of `url`'s pin on `network`
/// (`dash.devnet-sakura:dash://alice/project`, [`forge_core::repo_pin::section`]), `None` for
/// an id-addressed URL.
pub fn section(url: &DashUrl, network: &str) -> Option<String> {
    let DashUrl::Named { owner, repo } = url else {
        return None;
    };
    Some(forge_core::repo_pin::section(owner, repo, network))
}

/// Check (and record) the pin of `url` in the repository at `git_dir`. `allow_repin` reads
/// `dash.allowRepin`, only when the URL moved. A moved URL without it is E504, naming both
/// repositories and the ways out; with it, a loud warning on stderr and a new pin.
///
/// Fails closed on reads (a pin that cannot be read is an error, never a skipped check) and
/// open on writes (a pin that cannot be recorded is a warning, not a failed clone).
pub fn guard(
    url: &DashUrl,
    git_dir: &Path,
    remote: Option<&str>,
    now: &Pin,
    allow_repin: impl FnOnce() -> Result<bool>,
) -> Result<Outcome> {
    let Some(section) = section(url, &now.network) else {
        return Ok(Outcome::NotApplicable);
    };
    let recorded = Recorded {
        repo_id: config_get(git_dir, &format!("{section}.repoId"))?,
        owner_id: config_get(git_dir, &format!("{section}.ownerId"))?,
    };
    if recorded.is_empty() {
        record(git_dir, &section, now);
        return Ok(Outcome::Pinned);
    }
    if recorded.matches(&now.repo_id, &now.owner_id) {
        // Complete a pin that lacks a key.
        if recorded.repo_id.is_none() || recorded.owner_id.is_none() {
            record(git_dir, &section, now);
        }
        return Ok(Outcome::Matches);
    }
    if !allow_repin()? {
        return Err(moved(url, remote, &section, &recorded, now).into());
    }
    eprintln!(
        "dash: WARNING: {} now resolves to repository {} (owner {}), not {} (owner {}) as \
         when this clone was made. {ALLOW_REPIN_GIT_KEY} is set, so it is re-pinned to the \
         new repository.",
        display(url),
        now.repo_id,
        now.owner_id,
        shown(recorded.repo_id.as_deref()),
        shown(recorded.owner_id.as_deref()),
    );
    record(git_dir, &section, now);
    Ok(Outcome::Repinned { was: recorded })
}

/// E504: the URL names another repository than the pinned one.
fn moved(
    url: &DashUrl,
    remote: Option<&str>,
    section: &str,
    was: &Recorded,
    now: &Pin,
) -> UserError {
    let keep = match (remote, &was.repo_id) {
        (Some(r), Some(id)) => {
            format!("keep using the pinned repository: `git remote set-url {r} dash://{id}`; or, ")
        }
        _ => String::new(),
    };
    UserError::new(
        codes::INTEGRITY,
        format!(
            "{} now names a different repository than the one this clone was made from",
            display(url)
        ),
    )
    .cause(format!(
        "pinned on {}: repository {} (owner {}); now: repository {} (owner {}). The owner's \
         DPNS name may have changed hands, or the network was reset: fetching could mix in \
         someone else's history, and pushing would send your commits to them",
        now.network,
        shown(was.repo_id.as_deref()),
        shown(was.owner_id.as_deref()),
        now.repo_id,
        now.owner_id
    ))
    .fix(format!(
        "{keep}if you trust the change, run the same git command once with \
         `git -c {ALLOW_REPIN_GIT_KEY}=true …`, which re-pins it (or drop the pin: \
         `git config --remove-section '{section}'`)"
    ))
}

/// `dash://owner/repo`, for messages.
fn display(url: &DashUrl) -> String {
    format!("{}://{url}", crate::url::SCHEME)
}

/// Record `pin` under `section` in the repository's local config. Best effort: a pin that
/// cannot be written is reported, and the fetch or push goes on unpinned.
fn record(git_dir: &Path, section: &str, pin: &Pin) {
    let written = config_set(git_dir, &format!("{section}.repoId"), &pin.repo_id)
        .and_then(|()| config_set(git_dir, &format!("{section}.ownerId"), &pin.owner_id));
    if let Err(e) = written {
        eprintln!(
            "dash: warning: could not record which repository this URL names ({e:#}); \
             a later change of owner will not be detected"
        );
    }
}

/// The repository-local value of `key` (`git config --local --get`), `None` when unset.
fn config_get(git_dir: &Path, key: &str) -> Result<Option<String>> {
    let out = git(git_dir)
        .args(["config", "--local", "--get", key])
        .output()
        .map_err(|e| anyhow!("running git config: {e}"))?;
    match out.status.code() {
        Some(0) => {
            let v = String::from_utf8_lossy(&out.stdout).trim().to_string();
            Ok((!v.is_empty()).then_some(v))
        }
        // 1: the key is not set.
        Some(1) => Ok(None),
        _ => bail!(
            "reading the repository pin ({key}) failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ),
    }
}

/// `git config --local <key> <value>` in the repository at `git_dir`.
fn config_set(git_dir: &Path, key: &str, value: &str) -> Result<()> {
    let out = git(git_dir)
        .args(["config", "--local", key, value])
        .output()
        .map_err(|e| anyhow!("running git config: {e}"))?;
    if !out.status.success() {
        bail!(
            "git config {key} failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    Ok(())
}

/// `git --git-dir <git_dir>`: the repository's own config (its common dir for a worktree),
/// whatever the ambient `GIT_DIR`.
fn git(git_dir: &Path) -> Command {
    let mut cmd = Command::new("git");
    cmd.env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .arg("--git-dir")
        .arg(git_dir);
    cmd
}

/// `dash.allowRepin` as git resolves it (repository, global, or a one-off `git -c`, where a
/// bare `-c dash.allowRepin` means true).
pub fn allow_repin() -> Result<bool> {
    let out = Command::new("git")
        .args(["config", "--type=bool", "--get", ALLOW_REPIN_GIT_KEY])
        .output()
        .map_err(|e| anyhow!("running git config: {e}"))?;
    match out.status.code() {
        Some(0) => Ok(String::from_utf8_lossy(&out.stdout).trim() == "true"),
        Some(1) => Ok(false),
        _ => bail!(
            "{ALLOW_REPIN_GIT_KEY} must be a boolean (true/false): {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const OWNER_A: &str = "8hJmcHWTsdvkHyCrk4UgjbyugDAmE7QfuCTQXpXAc7nB";
    const OWNER_B: &str = "5rrwgjjVUqMghnessfiXPXubpiM2QLNNXH142Hv4PDyX";
    const SECTION: &str = "dash.devnet-sakura:dash://alice/project";

    fn pin(repo: &str, owner: &str) -> Pin {
        Pin {
            repo_id: repo.into(),
            owner_id: owner.into(),
            network: "devnet-sakura".into(),
        }
    }

    fn recorded(repo: &str, owner: &str) -> Recorded {
        Recorded {
            repo_id: Some(repo.into()),
            owner_id: Some(owner.into()),
        }
    }

    fn repo() -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let ok = Command::new("git")
            .env_remove("GIT_DIR")
            .env_remove("GIT_WORK_TREE")
            .args(["init", "-q"])
            .arg(dir.path())
            .status()
            .unwrap()
            .success();
        assert!(ok, "git init");
        let git_dir = dir.path().join(".git");
        (dir, git_dir)
    }

    fn url(s: &str) -> DashUrl {
        DashUrl::parse(s).unwrap()
    }

    #[allow(clippy::unnecessary_wraps)]
    fn no() -> Result<bool> {
        Ok(false)
    }

    #[allow(clippy::unnecessary_wraps)]
    fn yes() -> Result<bool> {
        Ok(true)
    }

    fn get(git_dir: &Path, key: &str) -> Option<String> {
        config_get(git_dir, &format!("{SECTION}.{key}")).unwrap()
    }

    #[test]
    fn spellings_that_resolve_alike_share_a_pin() {
        let s = |u: &str| section(&url(u), "devnet-sakura");
        let alice = Some(SECTION.to_string());
        assert_eq!(s("dash://alice/project"), alice);
        assert_eq!(s("dash://Alice.dash/Project.git"), alice);
        assert_eq!(s("dash://@alice/project"), alice);
        // An identity id keeps its case (base58 is case-sensitive).
        assert_eq!(
            s(&format!("dash://{OWNER_A}/project")),
            Some(format!("dash.devnet-sakura:dash://{OWNER_A}/project"))
        );
        // An id-addressed URL is the repository already.
        assert_eq!(s(&format!("dash://{OWNER_B}")), None);
    }

    #[test]
    fn the_first_resolution_is_pinned_and_a_later_match_passes() {
        let (_d, git_dir) = repo();
        let u = url("dash://alice/project");
        let now = pin("R1", OWNER_A);
        assert_eq!(
            guard(&u, &git_dir, Some("origin"), &now, no).unwrap(),
            Outcome::Pinned
        );
        assert_eq!(get(&git_dir, "repoId"), Some("R1".into()));
        assert_eq!(get(&git_dir, "ownerId"), Some(OWNER_A.into()));
        // A matching resolution never asks about dash.allowRepin.
        let never = || -> Result<bool> { panic!("asked about a re-pin") };
        assert_eq!(
            guard(&u, &git_dir, Some("origin"), &now, never).unwrap(),
            Outcome::Matches
        );
    }

    /// The S2 case: the DPNS name now points at another identity with a repo of the same
    /// name. Refused, naming both, and nothing is re-pinned.
    #[test]
    fn a_name_that_now_resolves_elsewhere_is_refused() {
        let (_d, git_dir) = repo();
        let u = url("dash://alice/project");
        guard(&u, &git_dir, Some("origin"), &pin("R1", OWNER_A), no).unwrap();
        let err = guard(&u, &git_dir, Some("origin"), &pin("R2", OWNER_B), no).unwrap_err();
        let user = err.downcast_ref::<UserError>().expect("a UserError");
        assert_eq!(user.code, codes::INTEGRITY);
        let text = format!("{user} {:?}", user.fix);
        for want in [
            "R1",
            "R2",
            OWNER_A,
            OWNER_B,
            "git remote set-url origin dash://R1",
            ALLOW_REPIN_GIT_KEY,
        ] {
            assert!(text.contains(want), "{want} missing from: {text}");
        }
        assert_eq!(
            get(&git_dir, "repoId"),
            Some("R1".into()),
            "a refusal keeps the pin"
        );
        // Another spelling of the same name is the same pin.
        assert!(guard(
            &url("dash://Alice.dash/project"),
            &git_dir,
            None,
            &pin("R2", OWNER_B),
            no
        )
        .is_err());
    }

    /// Without a remote name (a fetch by URL, forge-import's mirror), the fix does not name
    /// a remote to re-point.
    #[test]
    fn a_refusal_by_url_offers_the_re_pin_and_the_unset() {
        let (_d, git_dir) = repo();
        let u = url("dash://alice/project");
        guard(&u, &git_dir, None, &pin("R1", OWNER_A), no).unwrap();
        let err = guard(&u, &git_dir, None, &pin("R2", OWNER_B), no).unwrap_err();
        let fix = format!("{:?}", err.downcast_ref::<UserError>().unwrap().fix);
        assert!(!fix.contains("set-url"), "{fix}");
        assert!(fix.contains("--remove-section"), "{fix}");
    }

    #[test]
    fn allow_repin_accepts_the_change_and_re_pins() {
        let (_d, git_dir) = repo();
        let u = url("dash://alice/project");
        guard(&u, &git_dir, None, &pin("R1", OWNER_A), no).unwrap();
        let out = guard(&u, &git_dir, None, &pin("R2", OWNER_B), yes).unwrap();
        assert_eq!(
            out,
            Outcome::Repinned {
                was: recorded("R1", OWNER_A)
            }
        );
        assert_eq!(
            guard(&u, &git_dir, None, &pin("R2", OWNER_B), no).unwrap(),
            Outcome::Matches
        );
    }

    /// Each network keeps its own pin: a fetch on testnet neither trips nor replaces the
    /// devnet one.
    #[test]
    fn each_network_has_its_own_pin() {
        let (_d, git_dir) = repo();
        let u = url("dash://alice/project");
        guard(&u, &git_dir, None, &pin("R1", OWNER_A), no).unwrap();
        let testnet = Pin {
            network: "testnet".into(),
            ..pin("T1", OWNER_B)
        };
        assert_eq!(
            guard(&u, &git_dir, None, &testnet, no).unwrap(),
            Outcome::Pinned
        );
        assert_eq!(
            guard(&u, &git_dir, None, &testnet, no).unwrap(),
            Outcome::Matches
        );
        assert!(guard(&u, &git_dir, None, &pin("R2", OWNER_B), no).is_err());
        assert_eq!(
            guard(&u, &git_dir, None, &pin("R1", OWNER_A), no).unwrap(),
            Outcome::Matches
        );
    }

    #[test]
    fn a_partial_pin_is_compared_and_completed() {
        let (_d, git_dir) = repo();
        let u = url("dash://alice/project");
        config_set(&git_dir, &format!("{SECTION}.repoId"), "R1").unwrap();
        assert!(guard(&u, &git_dir, None, &pin("R2", OWNER_A), no).is_err());
        assert_eq!(
            guard(&u, &git_dir, None, &pin("R1", OWNER_A), no).unwrap(),
            Outcome::Matches
        );
        assert_eq!(get(&git_dir, "ownerId"), Some(OWNER_A.into()));
    }

    /// A pin that cannot be read fails the operation rather than skipping the check.
    #[test]
    fn an_unreadable_pin_fails_closed() {
        let (_d, git_dir) = repo();
        std::fs::write(git_dir.join("config"), "[core\nbroken").unwrap();
        let u = url("dash://alice/project");
        assert!(guard(&u, &git_dir, None, &pin("R1", OWNER_A), no).is_err());
    }

    #[test]
    fn an_id_addressed_url_is_not_pinned() {
        let (_d, git_dir) = repo();
        let u = url(&format!("dash://{OWNER_B}"));
        assert_eq!(
            guard(&u, &git_dir, None, &pin("R1", OWNER_A), no).unwrap(),
            Outcome::NotApplicable
        );
    }
}
