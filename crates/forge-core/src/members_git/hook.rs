//! The clone's `pre-push` hook (DESIGN §4.3 "Pre-push hook (C1)", E810).
//!
//! The git helper runs the publication guard on every push to a dash remote, but nothing it does
//! can see a push to another remote (`git push github`, `git push --mirror /backup.git`). So on the
//! first fetch of members-only branches it installs a `pre-push` hook, which git runs for every
//! remote and every helper version. The hook hands git's arguments and its stdin to
//! `git-remote-dash --pre-push`, which reads the clone's sealed-object ledger and refuses to push a
//! members-only commit to any remote that is not a dash remote whose helper runs the guard. `git
//! push --no-verify` skips it, and the docs say so.
//!
//! **Where.** `git rev-parse --git-path hooks`: `<common dir>/hooks`, or the `core.hooksPath`
//! directory when one is set. The helper installs it only in the repository's own hooks
//! directory: a `core.hooksPath` directory is often shared by every repository or kept in the
//! work tree, so the helper refuses to fetch members-only branches until `dg doctor
//! --install-hook` installs it there, with the user's go-ahead.
//!
//! **Chaining.** A `pre-push` hook that is not this one is kept: it is renamed to
//! [`CHAINED`] and the installed hook runs it after its own check, with the same arguments and
//! input. An install never overwrites a foreign hook it would lose.

use std::io::Write as _;
use std::path::{Path, PathBuf};

/// The line every hook this module writes carries, then ` v<version>`.
pub const MARKER: &str = "# dash-forge pre-push hook";
/// The version of the script [`script`] writes; a hook of an older version is rewritten.
pub const VERSION: u32 = 1;
/// The name a foreign `pre-push` hook is kept under, run after the check.
pub const CHAINED: &str = "pre-push.dash-chained";

/// The hook script, running `helper` (absolute; `git-remote-dash` on `PATH` when it is gone).
#[must_use]
pub fn script(helper: &Path) -> String {
    let quoted = helper.display().to_string().replace('\'', r"'\''");
    format!(
        "#!/bin/sh\n\
         {MARKER} v{VERSION}\n\
         # Refuses to push members-only commits of a Dash Forge repository to another remote, or to\n\
         # a public branch (E810). Installed by git-remote-dash; `dg doctor --install-hook` installs\n\
         # it again. `git push --no-verify` skips it, and publishes those commits.\n\
         helper='{quoted}'\n\
         [ -x \"$helper\" ] || helper=git-remote-dash\n\
         input=$(cat)\n\
         printf '%s\\n' \"$input\" | \"$helper\" --pre-push \"$@\" || exit $?\n\
         chained=\"$(dirname \"$0\")/{CHAINED}\"\n\
         if [ -x \"$chained\" ]; then\n\
         \x20 printf '%s\\n' \"$input\" | \"$chained\" \"$@\" || exit $?\n\
         fi\n\
         exit 0\n"
    )
}

/// What a hooks directory holds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Status {
    /// No `pre-push` hook.
    Missing,
    /// This module's hook; `current` when it is this version and runs `helper`.
    Ours {
        /// Up to date.
        current: bool,
    },
    /// Another hook.
    Foreign,
}

/// The `pre-push` hook in `dir`, judged against the hook [`script`] would write for `helper`.
#[must_use]
pub fn status(dir: &Path, helper: &Path) -> Status {
    let hook = dir.join("pre-push");
    let Ok(text) = std::fs::read_to_string(&hook) else {
        return if hook.exists() {
            Status::Foreign
        } else {
            Status::Missing
        };
    };
    if !text.lines().any(|l| l.starts_with(MARKER)) {
        return Status::Foreign;
    }
    Status::Ours {
        current: text == script(helper) && executable(&hook),
    }
}

#[cfg(unix)]
fn executable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt as _;
    std::fs::metadata(p).is_ok_and(|m| m.permissions().mode() & 0o111 != 0)
}

#[cfg(not(unix))]
fn executable(p: &Path) -> bool {
    p.exists()
}

/// What [`install`] did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Installed {
    /// The current hook was already there.
    Already,
    /// Written where there was none, or over an older version of this hook.
    Written,
    /// Written, and the foreign hook that was there kept as [`CHAINED`].
    Chained,
}

/// Install the hook running `helper` in `dir` (created if missing), keeping a foreign
/// `pre-push` as [`CHAINED`]. Refused (`AlreadyExists`) when a foreign hook and an earlier
/// chained one are both there: one of them would be lost.
pub fn install(dir: &Path, helper: &Path) -> std::io::Result<Installed> {
    let hook = dir.join("pre-push");
    let chained = match status(dir, helper) {
        Status::Ours { current: true } => return Ok(Installed::Already),
        Status::Ours { current: false } | Status::Missing => false,
        Status::Foreign => {
            if dir.join(CHAINED).exists() {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::AlreadyExists,
                    format!(
                        "{} and {} both exist; merge them by hand, keep one as {CHAINED}, then try again",
                        hook.display(),
                        dir.join(CHAINED).display()
                    ),
                ));
            }
            true
        }
    };
    std::fs::create_dir_all(dir)?;
    if chained {
        std::fs::rename(&hook, dir.join(CHAINED))?;
    }
    let tmp: PathBuf = dir.join(format!("pre-push.dash-tmp-{}", std::process::id()));
    let written = (|| {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(script(helper).as_bytes())?;
        f.sync_all()?;
        set_executable(&tmp)?;
        std::fs::rename(&tmp, &hook)
    })();
    if written.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    written?;
    Ok(if chained {
        Installed::Chained
    } else {
        Installed::Written
    })
}

#[cfg(unix)]
fn set_executable(p: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt as _;
    std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o755))
}

#[cfg(not(unix))]
fn set_executable(_: &Path) -> std::io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn installed_once_chaining_a_foreign_hook_and_refreshed_when_stale() {
        let d = tempfile::TempDir::new().unwrap();
        let dir = d.path().join("hooks");
        let helper = Path::new("/opt/it's/git-remote-dash");
        assert_eq!(status(&dir, helper), Status::Missing);
        assert_eq!(install(&dir, helper).unwrap(), Installed::Written);
        assert_eq!(status(&dir, helper), Status::Ours { current: true });
        assert_eq!(install(&dir, helper).unwrap(), Installed::Already);
        let text = std::fs::read_to_string(dir.join("pre-push")).unwrap();
        assert!(
            text.contains(r"helper='/opt/it'\''s/git-remote-dash'"),
            "{text}"
        );
        // another helper path: rewritten in place, nothing chained
        let moved = Path::new("/usr/local/bin/git-remote-dash");
        assert_eq!(status(&dir, moved), Status::Ours { current: false });
        assert_eq!(install(&dir, moved).unwrap(), Installed::Written);
        assert!(!dir.join(CHAINED).exists());
        // a foreign hook is kept and chained
        std::fs::write(dir.join("pre-push"), "#!/bin/sh\necho mine\n").unwrap();
        assert_eq!(status(&dir, moved), Status::Foreign);
        assert_eq!(install(&dir, moved).unwrap(), Installed::Chained);
        assert_eq!(
            std::fs::read_to_string(dir.join(CHAINED)).unwrap(),
            "#!/bin/sh\necho mine\n"
        );
        // a second foreign hook with a chained one already there: refused, nothing lost
        std::fs::write(dir.join("pre-push"), "#!/bin/sh\necho other\n").unwrap();
        let err = install(&dir, moved).unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::AlreadyExists);
        assert!(std::fs::read_to_string(dir.join("pre-push"))
            .unwrap()
            .contains("other"));
    }

    #[cfg(unix)]
    #[test]
    fn the_hook_runs_the_check_then_the_chained_hook_with_the_same_input() {
        let d = tempfile::TempDir::new().unwrap();
        let dir = d.path().join("hooks");
        let log = d.path().join("log");
        // a stand-in helper and a chained hook that each record what they were given
        let helper = d.path().join("helper.sh");
        std::fs::write(
            &helper,
            format!(
                "#!/bin/sh\necho \"check $*\" >> '{0}'\ncat >> '{0}'\n[ \"$4\" != refuse ]\n",
                log.display()
            ),
        )
        .unwrap();
        set_executable(&helper).unwrap();
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("pre-push"),
            format!(
                "#!/bin/sh\necho \"chained $*\" >> '{0}'\ncat >> '{0}'\n",
                log.display()
            ),
        )
        .unwrap();
        set_executable(&dir.join("pre-push")).unwrap();
        install(&dir, &helper).unwrap();
        let run = |extra: &str| {
            let mut child = std::process::Command::new(dir.join("pre-push"))
                .args(["origin", "url", extra])
                .stdin(std::process::Stdio::piped())
                .spawn()
                .unwrap();
            child
                .stdin
                .take()
                .unwrap()
                .write_all(b"refs/heads/a 1 refs/heads/a 0\n")
                .unwrap();
            child.wait().unwrap().success()
        };
        assert!(run("ok"));
        let text = std::fs::read_to_string(&log).unwrap();
        assert_eq!(
            text,
            "check --pre-push origin url ok\nrefs/heads/a 1 refs/heads/a 0\n\
             chained origin url ok\nrefs/heads/a 1 refs/heads/a 0\n"
        );
        std::fs::remove_file(&log).unwrap();
        assert!(!run("refuse"), "a refusal stops the push");
        let text = std::fs::read_to_string(&log).unwrap();
        assert!(!text.contains("chained"), "{text}");
    }
}
