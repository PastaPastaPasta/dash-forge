//! The rights acknowledgement (LEG-10): what a mirror run says about the content it is about to
//! publish, and the explicit "I may publish this" it needs before it writes anything.
//!
//! A mirror copies other people's words onto Dash Platform for good: commit authors' names and
//! emails travel in the pack objects, and issues, pull requests, comments and reviews carry their
//! authors' logins and text. Platform cannot delete any of it, and an author's later edit or
//! deletion at the source is not carried over. So a real run (a dry run only prices) needs
//! `--i-have-the-rights`, or a yes typed at a terminal, after it has shown the source's licence
//! (as the source's API reports it) and whether the source belongs to the account in use.

use std::io::{BufRead, IsTerminal as _, Write};

use anyhow::{bail, Result};

use crate::source::{License, SourceMeta};

/// The flag that acknowledges it, for the messages.
pub const FLAG: &str = "--i-have-the-rights";

/// The environment variable that names the account the run acts as, when `gh` or the GitLab
/// token cannot tell (the Mirror Action sets it to the workflow's repository owner).
pub const ACCOUNT_ENV: &str = "FORGE_IMPORT_ACCOUNT";

/// What the run knows about its right to publish the source.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Assessment {
    /// The source (`github.com/o/r`).
    pub source: String,
    /// The licence as one line: `MIT`, `none detected`, `not reported by the source`.
    pub licence: String,
    /// Things to weigh before publishing, one line each (they also become summary warnings).
    pub warnings: Vec<String>,
    /// The account that owns the source, when the source says.
    pub owner: Option<String>,
    /// The account the run acts as, when known.
    pub account: Option<String>,
}

/// The account named by [`ACCOUNT_ENV`], if set.
pub fn account_from_env() -> Option<String> {
    std::env::var(ACCOUNT_ENV)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

/// Assess `meta` of `source`, run as `account` (when known).
pub fn assess(source: &str, meta: &SourceMeta, account: Option<&str>) -> Assessment {
    let mut warnings = Vec::new();
    let licence = match &meta.license {
        License::Named(name) => name.clone(),
        License::None => {
            warnings.push(format!(
                "{source} reports no licence: nothing says others may copy and republish it, \
                 and a mirror on Dash Platform cannot be taken back"
            ));
            "none detected".to_string()
        }
        License::Unreported => "not reported by the source".to_string(),
    };
    if let (Some(owner), Some(account)) = (meta.owner.as_deref(), account) {
        if !owner.eq_ignore_ascii_case(account) {
            warnings.push(format!(
                "{source} is owned by {owner}, not by the account in use ({account}): mirror it \
                 only if you are authorised to, or its licence allows it"
            ));
        }
    }
    Assessment {
        source: source.to_string(),
        licence,
        warnings,
        owner: meta.owner.clone(),
        account: account.map(str::to_string),
    }
}

impl Assessment {
    /// What the run prints before it asks, or goes on.
    pub fn notice(&self) -> String {
        let mut lines = vec![
            format!(
                "Mirroring {} publishes it on Dash Platform permanently: its commits (with \
                 their authors' names and emails) and, with issues, pull requests or releases, \
                 other people's text and logins. Platform cannot delete it, and later edits or \
                 deletions at the source are not carried over.",
                self.source
            ),
            format!("  source licence: {}", self.licence),
        ];
        match (&self.owner, &self.account) {
            (Some(o), Some(a)) => lines.push(format!("  source owner: {o}; account in use: {a}")),
            (Some(o), None) => lines.push(format!(
                "  source owner: {o}; the account in use is not known, so ownership is not checked"
            )),
            _ => {}
        }
        lines.extend(self.warnings.iter().map(|w| format!("  warning: {w}")));
        lines.join("\n") + "\n"
    }
}

/// Require the acknowledgement before a run writes: `acknowledged` (`--i-have-the-rights`), or
/// a yes typed at a terminal after the notice. Otherwise the run is refused, with the flag
/// named.
pub fn require(assessment: &Assessment, acknowledged: bool) -> Result<()> {
    let stdin = std::io::stdin();
    let interactive = stdin.is_terminal();
    require_with(
        assessment,
        acknowledged,
        interactive,
        &mut stdin.lock(),
        &mut std::io::stderr(),
    )
}

/// [`require`] over `input` and `out` (`interactive`: `input` is a person at a terminal).
pub fn require_with(
    assessment: &Assessment,
    acknowledged: bool,
    interactive: bool,
    input: &mut dyn BufRead,
    out: &mut dyn Write,
) -> Result<()> {
    if acknowledged {
        return Ok(());
    }
    if !interactive {
        bail!(
            "refusing to publish {} without your acknowledgement that you may: pass {FLAG} \
             (its licence is {}; the content stays on Dash Platform permanently)",
            assessment.source,
            assessment.licence
        );
    }
    write!(
        out,
        "Do you have the right to publish {} on Dash Platform? [y/N] ",
        assessment.source
    )?;
    out.flush()?;
    let mut line = String::new();
    input.read_line(&mut line)?;
    if matches!(line.trim().to_ascii_lowercase().as_str(), "y" | "yes") {
        Ok(())
    } else {
        bail!("cancelled: nothing was published")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta(license: License, owner: Option<&str>) -> SourceMeta {
        SourceMeta {
            license,
            owner: owner.map(str::to_string),
            ..SourceMeta::default()
        }
    }

    #[test]
    fn a_named_licence_is_shown_and_does_not_warn() {
        let a = assess(
            "github.com/o/r",
            &meta(License::Named("MIT".into()), Some("o")),
            Some("O"),
        );
        assert_eq!(a.licence, "MIT");
        assert!(a.warnings.is_empty(), "{:?}", a.warnings);
        assert!(a.notice().contains("source licence: MIT"));
        assert!(a.notice().contains("permanently"));
    }

    #[test]
    fn no_licence_and_someone_elses_repository_warn() {
        let a = assess(
            "github.com/o/r",
            &meta(License::None, Some("o")),
            Some("me"),
        );
        assert_eq!(a.licence, "none detected");
        assert_eq!(a.warnings.len(), 2, "{:?}", a.warnings);
        assert!(a.warnings[0].contains("no licence"));
        assert!(a.warnings[1].contains("owned by o, not by the account in use (me)"));
        assert!(a
            .notice()
            .contains("warning: github.com/o/r reports no licence"));
    }

    #[test]
    fn an_unknown_account_or_licence_is_said_not_guessed() {
        let a = assess(
            "gitlab.com/g/p",
            &meta(License::Unreported, Some("g")),
            None,
        );
        assert_eq!(a.licence, "not reported by the source");
        assert!(a.warnings.is_empty());
        assert!(a.notice().contains("the account in use is not known"));
        // Nothing to say about an owner the source did not name.
        let a = assess(
            "github.com/o/r",
            &meta(License::Unreported, None),
            Some("me"),
        );
        assert!(a.warnings.is_empty());
        assert!(!a.notice().contains("source owner"));
    }

    fn run(acknowledged: bool, interactive: bool, typed: &str) -> (Result<()>, String) {
        let a = assess("github.com/o/r", &meta(License::None, None), None);
        let mut out = Vec::new();
        let r = require_with(
            &a,
            acknowledged,
            interactive,
            &mut typed.as_bytes(),
            &mut out,
        );
        (r, String::from_utf8(out).unwrap())
    }

    #[test]
    fn the_flag_acknowledges_without_a_prompt() {
        let (r, out) = run(true, false, "");
        assert!(r.is_ok() && out.is_empty());
        let (r, out) = run(true, true, "n\n");
        assert!(r.is_ok() && out.is_empty(), "the flag wins; no question");
    }

    #[test]
    fn without_the_flag_a_script_is_refused_and_told_the_flag() {
        let (r, out) = run(false, false, "y\n");
        let e = format!("{:#}", r.unwrap_err());
        assert!(e.contains(FLAG) && e.contains("none detected"), "{e}");
        assert!(out.is_empty(), "a script is never asked");
    }

    #[test]
    fn a_terminal_is_asked_and_only_a_yes_goes_on() {
        for yes in ["y\n", "YES\n", " yes \n"] {
            let (r, out) = run(false, true, yes);
            assert!(r.is_ok(), "{yes:?}");
            assert!(out.contains("right to publish github.com/o/r"), "{out}");
        }
        for no in ["\n", "n\n", "no\n", "maybe\n", ""] {
            let (r, _) = run(false, true, no);
            assert!(
                format!("{:#}", r.unwrap_err()).contains("cancelled"),
                "{no:?}"
            );
        }
    }
}
