//! Where `dg` may put a secret it generated (QW2-001).
//!
//! A secret is shown on screen only to a person: the stream it goes to and stdin are both
//! terminals, `--json` is off, and no CI environment is detected. Anywhere else (a pipe, a
//! log, a CI runner, a `--json` consumer) it is written only to a file the user named with a
//! flag, created 0600 and never over an existing file, and only the file's path is printed.
//! When neither applies the command refuses before it creates anything.
//!
//! This covers recovery words (`dg auth new`) and generated webhook secrets (`dg webhook add`).
//! Keys go only to a file (`dg ci runner new -o`, `dg auth export -o`); the one exception is
//! `dg auth export --format dfk1 --reveal-secrets -o -`, which asks for stdout explicitly and is
//! refused with `--json` and in CI.

use std::io::IsTerminal as _;
use std::path::Path;

use anyhow::Result;

/// Environment variables CI systems set (kept in step with `tests/no_secrets_on_pipes.rs`). `CI` covers GitHub Actions, GitLab, CircleCI,
/// Travis, Buildkite, Bitbucket, Drone and Woodpecker; the rest are the ones that do not set it.
const CI_MARKERS: &[&str] = &[
    "CI",
    "GITHUB_ACTIONS",
    "GITLAB_CI",
    "TF_BUILD",
    "JENKINS_URL",
    "TEAMCITY_VERSION",
    "BUILDKITE",
    "CODEBUILD_BUILD_ID",
];

/// The stream a secret would be printed on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stream {
    Stdout,
    Stderr,
}

/// Whether a CI marker is set (to anything but empty, `0` or `false`).
fn marker_set(value: Option<&str>) -> bool {
    value.is_some_and(|v| {
        let v = v.trim();
        !(v.is_empty() || v == "0" || v.eq_ignore_ascii_case("false"))
    })
}

/// Whether this looks like a CI run, from the environment.
pub fn in_ci() -> bool {
    CI_MARKERS
        .iter()
        .any(|m| marker_set(std::env::var(m).ok().as_deref()))
}

/// The CI marker that is set, for error messages.
fn ci_marker() -> Option<&'static str> {
    CI_MARKERS
        .iter()
        .copied()
        .find(|m| marker_set(std::env::var(m).ok().as_deref()))
}

/// What decides whether a secret may be shown, gathered once so the rule is testable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Surroundings {
    /// `--json`: the output is for a program.
    pub json: bool,
    /// The stream the secret goes to and stdin are both terminals.
    pub terminal: bool,
    /// A CI marker is set ([`in_ci`]).
    pub ci: bool,
}

impl Surroundings {
    /// The real process's surroundings for a secret printed on `stream`.
    pub fn detect(json: bool, stream: Stream) -> Self {
        let stream_tty = match stream {
            Stream::Stdout => std::io::stdout().is_terminal(),
            Stream::Stderr => std::io::stderr().is_terminal(),
        };
        Self {
            json,
            terminal: stream_tty && std::io::stdin().is_terminal(),
            ci: in_ci(),
        }
    }

    /// Whether a person, and only a person, would read what is printed.
    pub fn may_show(self) -> bool {
        !self.json && self.terminal && !self.ci
    }

    /// Why a secret may not be shown here (`None` when it may), for error causes.
    pub fn why_not(self) -> Option<String> {
        if self.json {
            Some("--json output is for programs".into())
        } else if self.ci {
            Some(format!(
                "this looks like a CI run ({} is set)",
                ci_marker().unwrap_or("CI")
            ))
        } else if !self.terminal {
            Some("the output or input is not a terminal (a pipe, a log or a script)".into())
        } else {
            None
        }
    }
}

/// Write `bytes` to a new file at `path`: 0600 on Unix, refusing a file (or a symlink)
/// already there.
pub fn write_new_file(path: &Path, bytes: &[u8]) -> Result<()> {
    if path.symlink_metadata().is_ok() {
        return Err(crate::errors::usage(format!(
            "{} exists; name a new file (it is never overwritten)",
            path.display()
        )));
    }
    forge_core::keystore::create_private_file(path, bytes)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(json: bool, terminal: bool, ci: bool) -> Surroundings {
        Surroundings { json, terminal, ci }
    }

    #[test]
    fn only_a_person_at_a_terminal_sees_a_secret() {
        assert!(s(false, true, false).may_show());
        assert_eq!(s(false, true, false).why_not(), None);
        for (json, terminal, ci) in [
            (true, true, false),   // --json
            (false, false, false), // piped, logged or scripted
            (false, true, true),   // a CI runner with a pty
            (true, false, true),
        ] {
            let x = s(json, terminal, ci);
            assert!(!x.may_show(), "{x:?}");
            assert!(x.why_not().is_some(), "{x:?}");
        }
    }

    #[test]
    fn the_pipe_test_clears_every_ci_marker() {
        let test = include_str!("../tests/no_secrets_on_pipes.rs");
        for m in CI_MARKERS {
            assert!(
                test.contains(&format!("\"{m}\",")),
                "{m} is missing from CI_MARKERS there"
            );
        }
    }

    #[test]
    fn ci_markers_count_unless_empty_or_false() {
        assert!(marker_set(Some("true")));
        assert!(marker_set(Some("1")));
        assert!(marker_set(Some("yes")));
        assert!(!marker_set(None));
        assert!(!marker_set(Some("")));
        assert!(!marker_set(Some("0")));
        assert!(!marker_set(Some("false")));
        assert!(!marker_set(Some("FALSE")));
    }

    #[test]
    fn a_secret_file_is_new_and_private() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("secret.txt");
        write_new_file(&p, b"s3cr3t").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let mode = std::fs::metadata(&p).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        let err = write_new_file(&p, b"other").unwrap_err().to_string();
        assert!(err.contains("exists"), "{err}");
        assert_eq!(std::fs::read(&p).unwrap(), b"s3cr3t");
    }
}
