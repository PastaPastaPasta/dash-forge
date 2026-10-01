//! Pin the repository a `dash://<owner>/<name>` URL resolved to when the clone was made
//! (BACKLOG S2: DPNS name → repoId pinning).
//!
//! A DPNS name is a pointer, not an identity: a name can change hands, and a URL spelled
//! with one would then resolve to another identity's repository of the same name. Fetching
//! from it would mix a stranger's history into the clone, and pushing would send commits to
//! them. So the first time this helper resolves a named URL inside a repository (the clone
//! itself, or the first fetch of an existing one), it records what the URL resolved to in
//! that repository's own git config:
//!
//! ```text
//! [dash "dash://alice/project"]
//!     repoId = <base58 repo document id>
//!     ownerId = <base58 owner identity id>
//!     network = devnet-bonsia
//! ```
//!
//! Every later fetch or push compares. A different repository is refused (E504) unless the
//! user says otherwise, once, with `git -c dash.allowRepin=true <fetch|push>` (or by setting
//! `dash.allowRepin`): then the helper warns loudly, re-pins and goes on. The pin is per
//! network: the same URL on another network is another namespace, so it is pinned afresh
//! there. An id-addressed URL (`dash://<repo id>`) needs no pin: the id is the repository.

use std::path::Path;
use std::process::Command;

use anyhow::{anyhow, bail, Result};
use forge_core::storage::policy::parse_git_bool;
use forge_core::user_error::{codes, UserError};

use crate::url::DashUrl;

/// The git config key that lets one fetch or push accept a re-pointed URL (and re-pin it).
pub const ALLOW_REPIN_GIT_KEY: &str = "dash.allowRepin";

/// What a named URL resolved to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pin {
    /// The forge-v2 `repo` document id.
    pub repo_id: String,
    /// The repository owner's identity id.
    pub owner_id: String,
    /// The network key it was resolved on (`testnet`, `devnet-bonsia`, …).
    pub network: String,
}

/// What [`guard`] did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// An id-addressed URL, or no repository to record a pin in.
    NotApplicable,
    /// Nothing was pinned yet for this URL on this network: it is now.
    Pinned,
    /// The URL still resolves to the pinned repository.
    Matches,
    /// The URL resolves elsewhere and `dash.allowRepin` allowed it: re-pinned.
    Repinned {
        /// The previous pin.
        was: Pin,
    },
}

/// The git config section of `url`'s pin (`dash.dash://alice/project`), `None` for an
/// id-addressed URL. A DPNS owner is keyed as DPNS compares it (case-insensitive, without
/// `@` or `.dash`), and the repo name as the resolver does (lowercase), so the spellings that
/// resolve alike share one pin.
pub fn section(url: &DashUrl) -> Option<String> {
    let DashUrl::Named { owner, repo } = url else {
        return None;
    };
    let owner = owner.strip_prefix('@').unwrap_or(owner);
    let owner = match forge_core::resolve::dpns_label(owner) {
        Some(label) if !forge_core::resolve::looks_like_identity_id(owner) => {
            label.to_ascii_lowercase()
        }
        _ => owner.to_string(),
    };
    Some(format!("dash.dash://{owner}/{}", repo.to_ascii_lowercase()))
}

/// Compare a recorded pin with what the URL resolves to now: `Ok(None)` when nothing is
/// recorded for this network, `Ok(Some(()))` on a match, `Err(was)` when it moved.
fn compare(recorded: &RecordedPin, now: &Pin) -> std::result::Result<Option<()>, Pin> {
    let on_this_network = recorded.network.as_deref().is_none_or(|n| n == now.network);
    if !on_this_network || (recorded.repo_id.is_none() && recorded.owner_id.is_none()) {
        return Ok(None);
    }
    let same = |v: &Option<String>, now: &str| v.as_deref().is_none_or(|v| v == now);
    if same(&recorded.repo_id, &now.repo_id) && same(&recorded.owner_id, &now.owner_id) {
        Ok(Some(()))
    } else {
        Err(Pin {
            repo_id: recorded.repo_id.clone().unwrap_or_default(),
            owner_id: recorded.owner_id.clone().unwrap_or_default(),
            network: now.network.clone(),
        })
    }
}

/// The pin keys as recorded (each may be missing).
#[derive(Debug, Default)]
struct RecordedPin {
    repo_id: Option<String>,
    owner_id: Option<String>,
    network: Option<String>,
}

/// Check (and record) the pin of `url` in the repository at `git_dir`. `allow_repin` is
/// `dash.allowRepin`. A moved URL without it is E504, naming both repositories and the ways
/// out; with it, a loud warning on stderr and a new pin.
pub fn guard(
    url: &DashUrl,
    git_dir: &Path,
    remote: Option<&str>,
    now: &Pin,
    allow_repin: bool,
) -> Result<Outcome> {
    let Some(section) = section(url) else {
        return Ok(Outcome::NotApplicable);
    };
    let recorded = RecordedPin {
        repo_id: config_get(git_dir, &format!("{section}.repoId"))?,
        owner_id: config_get(git_dir, &format!("{section}.ownerId"))?,
        network: config_get(git_dir, &format!("{section}.network"))?,
    };
    match compare(&recorded, now) {
        Ok(Some(())) => {
            // Fill in a key an older or hand-written pin lacks.
            if recorded.repo_id.is_none()
                || recorded.owner_id.is_none()
                || recorded.network.is_none()
            {
                write(git_dir, &section, now)?;
            }
            Ok(Outcome::Matches)
        }
        Ok(None) => {
            write(git_dir, &section, now)?;
            Ok(Outcome::Pinned)
        }
        Err(was) if allow_repin => {
            eprintln!(
                "dash: WARNING: {url_s} now resolves to repository {new_repo} (owner {new_owner}), \
                 not {old_repo} (owner {old_owner}) as when this clone was made. \
                 {ALLOW_REPIN_GIT_KEY} is set, so it is re-pinned to the new repository.",
                url_s = display(url),
                new_repo = now.repo_id,
                new_owner = now.owner_id,
                old_repo = was.repo_id,
                old_owner = was.owner_id,
            );
            write(git_dir, &section, now)?;
            Ok(Outcome::Repinned { was })
        }
        Err(was) => Err(moved(url, remote, &was, now).into()),
    }
}

/// E504: the URL names another repository than the pinned one.
fn moved(url: &DashUrl, remote: Option<&str>, was: &Pin, now: &Pin) -> UserError {
    let remote = remote.unwrap_or("<remote>");
    UserError::new(
        codes::INTEGRITY,
        format!(
            "{} now names a different repository than the one this clone was made from",
            display(url)
        ),
    )
    .cause(format!(
        "pinned: repository {} (owner {}); now: repository {} (owner {}). The owner's DPNS \
         name may have changed hands, or the network was reset: fetching could mix in someone \
         else's history, and pushing would send your commits to them",
        was.repo_id, was.owner_id, now.repo_id, now.owner_id
    ))
    .fix(format!(
        "keep using the pinned repository: `git remote set-url {remote} dash://{}`; or, if you \
         trust the change, re-pin once with `git -c {ALLOW_REPIN_GIT_KEY}=true fetch`",
        was.repo_id
    ))
}

/// `dash://owner/repo`, for messages.
fn display(url: &DashUrl) -> String {
    format!("{}://{url}", crate::url::SCHEME)
}

/// Record `pin` under `section` in the repository's local config.
fn write(git_dir: &Path, section: &str, pin: &Pin) -> Result<()> {
    for (key, value) in [
        ("repoId", &pin.repo_id),
        ("ownerId", &pin.owner_id),
        ("network", &pin.network),
    ] {
        git_config(git_dir, &[&format!("{section}.{key}"), value])?;
    }
    Ok(())
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
            "git config --get {key} failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ),
    }
}

/// `git config --local <args>` in the repository at `git_dir`.
fn git_config(git_dir: &Path, args: &[&str]) -> Result<()> {
    let out = git(git_dir)
        .args(["config", "--local"])
        .args(args)
        .output()
        .map_err(|e| anyhow!("running git config: {e}"))?;
    if !out.status.success() {
        bail!(
            "git config {} failed: {}",
            args.first().copied().unwrap_or_default(),
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

/// `dash.allowRepin` as git resolves it (repository, global, or a one-off `git -c`).
pub fn allow_repin() -> Result<bool> {
    crate::git::config_get(ALLOW_REPIN_GIT_KEY)
        .map(|v| parse_git_bool(ALLOW_REPIN_GIT_KEY, &v))
        .transpose()
        .map(Option::unwrap_or_default)
        .map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use super::*;

    const OWNER_A: &str = "8hJmcHWTsdvkHyCrk4UgjbyugDAmE7QfuCTQXpXAc7nB";
    const OWNER_B: &str = "5rrwgjjVUqMghnessfiXPXubpiM2QLNNXH142Hv4PDyX";

    fn pin(repo: &str, owner: &str) -> Pin {
        Pin {
            repo_id: repo.into(),
            owner_id: owner.into(),
            network: "devnet-bonsia".into(),
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

    #[test]
    fn spellings_that_resolve_alike_share_a_pin() {
        let s = |u: &str| section(&url(u));
        let alice = Some("dash.dash://alice/project".to_string());
        assert_eq!(s("dash://alice/project"), alice);
        assert_eq!(s("dash://Alice.dash/Project.git"), alice);
        assert_eq!(s("dash://@alice/project"), alice);
        // An identity id keeps its case (base58 is case-sensitive).
        assert_eq!(
            s(&format!("dash://{OWNER_A}/project")),
            Some(format!("dash.dash://{OWNER_A}/project"))
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
            guard(&u, &git_dir, Some("origin"), &now, false).unwrap(),
            Outcome::Pinned
        );
        assert_eq!(
            config_get(&git_dir, "dash.dash://alice/project.repoId").unwrap(),
            Some("R1".into())
        );
        assert_eq!(
            config_get(&git_dir, "dash.dash://alice/project.ownerId").unwrap(),
            Some(OWNER_A.into())
        );
        assert_eq!(
            guard(&u, &git_dir, Some("origin"), &now, false).unwrap(),
            Outcome::Matches
        );
    }

    /// The S2 case: the DPNS name now points at another identity with a repo of the same
    /// name. Refused, naming both, and nothing is re-pinned.
    #[test]
    fn a_name_that_now_resolves_elsewhere_is_refused() {
        let (_d, git_dir) = repo();
        let u = url("dash://alice/project");
        guard(&u, &git_dir, Some("origin"), &pin("R1", OWNER_A), false).unwrap();
        let err = guard(&u, &git_dir, Some("origin"), &pin("R2", OWNER_B), false).unwrap_err();
        let user = err.downcast_ref::<UserError>().expect("a UserError");
        assert_eq!(user.code, codes::INTEGRITY);
        let text = format!("{user} {:?}", user.fix);
        for want in [
            "R1",
            "R2",
            OWNER_A,
            OWNER_B,
            "git remote set-url origin dash://R1",
        ] {
            assert!(text.contains(want), "{want} missing from: {text}");
        }
        assert!(text.contains(ALLOW_REPIN_GIT_KEY), "{text}");
        assert_eq!(
            config_get(&git_dir, "dash.dash://alice/project.repoId").unwrap(),
            Some("R1".into()),
            "a refusal keeps the pin"
        );
        // Another spelling of the same name is the same pin.
        assert!(guard(
            &url("dash://Alice.dash/project"),
            &git_dir,
            None,
            &pin("R2", OWNER_B),
            false
        )
        .is_err());
    }

    #[test]
    fn allow_repin_accepts_the_change_and_re_pins() {
        let (_d, git_dir) = repo();
        let u = url("dash://alice/project");
        guard(&u, &git_dir, None, &pin("R1", OWNER_A), false).unwrap();
        let out = guard(&u, &git_dir, None, &pin("R2", OWNER_B), true).unwrap();
        assert_eq!(
            out,
            Outcome::Repinned {
                was: pin("R1", OWNER_A)
            }
        );
        assert_eq!(
            guard(&u, &git_dir, None, &pin("R2", OWNER_B), false).unwrap(),
            Outcome::Matches
        );
    }

    #[test]
    fn another_network_is_pinned_afresh() {
        let (_d, git_dir) = repo();
        let u = url("dash://alice/project");
        guard(&u, &git_dir, None, &pin("R1", OWNER_A), false).unwrap();
        let testnet = Pin {
            network: "testnet".into(),
            ..pin("T1", OWNER_B)
        };
        assert_eq!(
            guard(&u, &git_dir, None, &testnet, false).unwrap(),
            Outcome::Pinned
        );
    }

    #[test]
    fn a_partial_pin_is_compared_and_completed() {
        let (_d, git_dir) = repo();
        let u = url("dash://alice/project");
        git_config(&git_dir, &["dash.dash://alice/project.repoId", "R1"]).unwrap();
        assert!(guard(&u, &git_dir, None, &pin("R2", OWNER_A), false).is_err());
        assert_eq!(
            guard(&u, &git_dir, None, &pin("R1", OWNER_A), false).unwrap(),
            Outcome::Matches
        );
        assert_eq!(
            config_get(&git_dir, "dash.dash://alice/project.ownerId").unwrap(),
            Some(OWNER_A.into())
        );
    }

    #[test]
    fn an_id_addressed_url_is_not_pinned() {
        let (_d, git_dir) = repo();
        let u = url(&format!("dash://{OWNER_B}"));
        assert_eq!(
            guard(&u, &git_dir, None, &pin("R1", OWNER_A), false).unwrap(),
            Outcome::NotApplicable
        );
    }
}
