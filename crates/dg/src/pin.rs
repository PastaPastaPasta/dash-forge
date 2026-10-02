//! `dg` honours the clone's repository-id pin (QW4-013).
//!
//! `git-remote-dash` records, in a clone's own git config, the repository a named
//! `dash://<owner>/<name>` URL resolved to when the clone was made, and refuses a fetch or push
//! once the name resolves elsewhere (E504; `forge_core::repo_pin`). A DPNS name can change hands,
//! so without the same check here `dg issue create` / `pr create` / `issue list` in that clone
//! would read and write a stranger's repository of the same name. So before a command acts on a
//! named repository, [`check`] compares what the name resolves to now with the pin the current
//! clone holds for it on this network, and refuses a moved name the same way git does. Only git
//! re-pins: `git -c dash.allowRepin=true fetch` once, or `dash.allowRepin` set, lets `dg` go on
//! with a warning.

use std::process::Command;

use anyhow::{anyhow, bail, Result};
use forge_core::repo_pin::{self, Recorded, ALLOW_REPIN_GIT_KEY};
use forge_core::scope::RepoRef as Repo;
use forge_core::user_error::{codes, UserError};

/// E504 when `owner/name` (as typed, or as the clone's remote names it) resolved to `repo` on
/// `network`, and the clone in the current directory pinned that name to another repository.
/// Nothing to check outside a `dash://` clone, or for a name it holds no pin for.
pub fn check(owner: &str, name: &str, network: &str, repo: &Repo) -> Result<()> {
    if crate::storage::dash_remote_name().is_none() {
        return Ok(());
    }
    let section = repo_pin::section(owner, name, network);
    let recorded = Recorded {
        repo_id: config_get(&format!("{section}.repoId"))?,
        owner_id: config_get(&format!("{section}.ownerId"))?,
    };
    let now = (repo.id(), repo.owner_id());
    match verdict(&recorded, now, allow_repin) {
        Verdict::Ok => Ok(()),
        Verdict::Allowed => {
            eprintln!(
                "warning: {owner}/{name} now resolves to repository {} (owner {}), not the {} \
                 (owner {}) this clone pinned; {ALLOW_REPIN_GIT_KEY} is set, so dg goes on with \
                 the new one (a `git fetch` re-pins the clone)",
                repo.id(),
                repo.owner_id(),
                repo_pin::shown(recorded.repo_id.as_deref()),
                repo_pin::shown(recorded.owner_id.as_deref()),
            );
            Ok(())
        }
        Verdict::Moved => Err(moved(owner, name, network, &section, &recorded, now).into()),
    }
}

/// What [`check`] decides.
#[derive(Debug, PartialEq, Eq)]
enum Verdict {
    /// No pin, or the pinned repository.
    Ok,
    /// Moved, and `dash.allowRepin` lets it go on.
    Allowed,
    /// Moved: refused.
    Moved,
}

/// [`check`]'s rule for the repository `(id, owner)` the name resolves to now: `allow_repin` is
/// read only when the name moved.
fn verdict(recorded: &Recorded, now: (&str, &str), allow_repin: impl FnOnce() -> bool) -> Verdict {
    if recorded.is_empty() || recorded.matches(now.0, now.1) {
        Verdict::Ok
    } else if allow_repin() {
        Verdict::Allowed
    } else {
        Verdict::Moved
    }
}

/// E504: the name moved since the clone pinned it.
fn moved(
    owner: &str,
    name: &str,
    network: &str,
    section: &str,
    was: &Recorded,
    (now_id, now_owner): (&str, &str),
) -> UserError {
    let keep = was.repo_id.as_deref().map_or_else(String::new, |id| {
        format!("keep using the pinned repository: name it by its id (`-R {id}`, or `{id}` where the command takes `<owner>/<name>`); or, ")
    });
    UserError::new(
        codes::INTEGRITY,
        format!("{owner}/{name} now names a different repository than the one this clone pinned"),
    )
    .cause(format!(
        "pinned on {network}: repository {} (owner {}); now: repository {} (owner {}). The owner's DPNS name may have changed hands, or the network was reset: reading it could show someone else's repository, and writing would send your issue, comment or pull request to them",
        repo_pin::shown(was.repo_id.as_deref()),
        repo_pin::shown(was.owner_id.as_deref()),
        now_id,
        now_owner
    ))
    .fix(format!(
        "{keep}if you trust the change, run `git -c {ALLOW_REPIN_GIT_KEY}=true fetch` once, which re-pins this clone (or drop the pin: `git config --remove-section '{section}'`)"
    ))
    .note("checked before anything was read from it or signed; nothing was written or paid")
}

/// The current repository's local value of `key`, `None` when unset. Fails closed: a pin that
/// can't be read is an error, never a skipped check.
fn config_get(key: &str) -> Result<Option<String>> {
    let out = Command::new("git")
        .args(["config", "--local", "--get", key])
        .output()
        .map_err(|e| anyhow!("running git config: {e}"))?;
    match out.status.code() {
        Some(0) => {
            let v = String::from_utf8_lossy(&out.stdout).trim().to_string();
            Ok((!v.is_empty()).then_some(v))
        }
        Some(1) => Ok(None),
        _ => bail!(
            "reading the repository pin ({key}) failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ),
    }
}

/// `dash.allowRepin` as git resolves it; an unreadable or non-boolean value is `false`.
fn allow_repin() -> bool {
    Command::new("git")
        .args(["config", "--type=bool", "--get", ALLOW_REPIN_GIT_KEY])
        .output()
        .is_ok_and(|o| o.status.success() && String::from_utf8_lossy(&o.stdout).trim() == "true")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_moved_name_is_refused_unless_repinning_is_allowed() {
        let pinned = Recorded {
            repo_id: Some("R1".into()),
            owner_id: Some("O1".into()),
        };
        assert_eq!(
            verdict(&pinned, ("R1", "O1"), || panic!("not read")),
            Verdict::Ok
        );
        assert_eq!(
            verdict(&Recorded::default(), ("R2", "O2"), || panic!("not read")),
            Verdict::Ok
        );
        assert_eq!(verdict(&pinned, ("R2", "O2"), || false), Verdict::Moved);
        assert_eq!(verdict(&pinned, ("R2", "O2"), || true), Verdict::Allowed);
        // The same repository under a new owner is moved too.
        assert_eq!(verdict(&pinned, ("R1", "O2"), || false), Verdict::Moved);
    }

    #[test]
    fn the_refusal_names_both_repositories_and_the_ways_out() {
        let pinned = Recorded {
            repo_id: Some("R1".into()),
            owner_id: Some("O1".into()),
        };
        let u = moved(
            "alice",
            "project",
            "devnet-sakura",
            "dash.devnet-sakura:dash://alice/project",
            &pinned,
            ("R2", "O2"),
        );
        assert_eq!((u.code, u.exit_code()), ("E504", 5));
        let cause = u.cause.as_deref().unwrap();
        assert!(cause.contains("repository R1 (owner O1)"), "{cause}");
        assert!(cause.contains("now: repository R2 (owner O2)"), "{cause}");
        assert!(u.fix[0].contains("`-R R1`"), "{u:?}");
        assert!(u.fix[0].contains("dash.allowRepin=true fetch"), "{u:?}");
        assert!(u.note.as_deref().unwrap().contains("nothing was written"));
    }
}
