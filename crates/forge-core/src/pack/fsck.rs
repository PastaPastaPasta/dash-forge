//! Which of git's object checks (`git help fsck-msgids`) refuse history, everywhere Dash Forge
//! checks objects: the helper's `index-pack` on clone and fetch, and the web's browser merge
//! (`forge-web/lib/view/git-objects.ts`, `RELAXED_FSCK_IDS`, which must list the same ids).
//!
//! The rule: **refuse what git refuses when it checks a fetch, except the author/committer-line
//! checks.** git's `transfer.fsckObjects=true` runs `index-pack --strict`, where every ERROR
//! and WARN id is fatal: `.git` look-alikes (`hasDotgit`, `hasDot`, `hasDotdot`), `.gitmodules`
//! URLs, paths, names and symlinks, `.gitattributes` size and symlinks, tree corruption
//! (`badTree`, `duplicateEntries`, `treeNotSorted`, `nullSha1`, `zeroPaddedFilemode`,
//! `fullPathname`, `emptyName`, `largePathname`), header corruption (`nulInHeader`,
//! `unterminatedHeader`, `nulInCommit`, `badTreeSha1`, `badParentSha1`, `missingTree`,
//! `missingAuthor`, `missingCommitter`, `multipleAuthors`) and tag corruption. All of those
//! stay fatal here: each either changes what a checkout writes (a path git itself treats as
//! the repository, a submodule URL that runs a command) or means git and another reader could
//! disagree on what an object names.
//!
//! [`RELAXED`] are the checks of the text of an `author`, `committer` or `tagger` line (the
//! name, email, date and time zone). They are demoted to warnings because:
//!
//! - Real, widely cloned histories fail them. psf/requests' commit 5e6ecdad has the time zone
//!   `+051800` (`badTimezone`); older tools wrote `A <a@b>1313584730` (`missingSpaceBeforeDate`),
//!   empty or bracket-less emails, and zero-padded or overflowing dates. A plain `git clone`
//!   (`transfer.fsckObjects` off, git's default) accepts all of them.
//! - They cannot change a checkout: the line is display metadata. git reads it leniently
//!   (`parse_commit_date` takes the digits after the last `>`), never as a path, URL or
//!   command, and the fields a reader could be misled on (`tree`, `parent`, `object`, `type`)
//!   keep their own fatal checks. A malformed line still has to exist where git expects it
//!   (`missingAuthor`, `missingCommitter`, `multipleAuthors` stay fatal).
//! - Demoting them keeps memory safety: git's `fsck_ident` has already moved past the line
//!   when it reports, and `verify_headers` (which is fatal and cannot be demoted) guarantees
//!   every header line ends before the buffer does.
//!
//! `badFilemode` (a `100664` mode) is only a warning in git's own `index-pack` checks and stays
//! so here; the web refuses it (it is stricter than git in places, never looser).

use crate::user_error::{codes, UserError};

/// The author/committer/tagger-line checks demoted to `warn` (see the module docs), as git
/// spells their msg-ids. Every other check keeps git's severity.
pub const RELAXED: &[&str] = &[
    "badDate",
    "badDateOverflow",
    "badEmail",
    "badName",
    "badTimezone",
    "missingEmail",
    "missingNameBeforeEmail",
    "missingSpaceBeforeDate",
    "missingSpaceBeforeEmail",
    "zeroPaddedDate",
];

/// The `index-pack` argument that checks every object with [`RELAXED`] demoted to warnings
/// (`--fsck-objects=<id>=<severity>,…`, git ≥ 2.44). Spelled out so it can be a `const`; a
/// test pins it to [`RELAXED`].
pub const INDEX_PACK_FSCK: &str = "--fsck-objects=badDate=warn,badDateOverflow=warn,\
badEmail=warn,badName=warn,badTimezone=warn,missingEmail=warn,missingNameBeforeEmail=warn,\
missingSpaceBeforeDate=warn,missingSpaceBeforeEmail=warn,zeroPaddedDate=warn";

/// The first git version whose `index-pack` takes severities after `--fsck-objects`.
pub const MIN_GIT_FOR_SEVERITIES: (u32, u32) = (2, 44);

/// The `index-pack` object-check argument for the `git` on PATH ([`index_pack_checks_for`]
/// its `git version`), asked once per process.
pub fn index_pack_checks() -> &'static str {
    static CHECKS: std::sync::OnceLock<&'static str> = std::sync::OnceLock::new();
    CHECKS.get_or_init(|| {
        let version = std::process::Command::new("git")
            .arg("version")
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
            .unwrap_or_default();
        index_pack_checks_for(&version)
    })
}

/// The object checks a push's pack gets before anything is stored: [`INDEX_PACK_FSCK`], the
/// same classification a clone applies, so what a push stores every reader can clone. `None`
/// on a git older than 2.44, which could only check with the author-line ids fatal and so
/// would refuse histories a clone accepts; readers still check what they fetch.
pub fn push_checks() -> Option<&'static str> {
    let checks = index_pack_checks();
    (checks == INDEX_PACK_FSCK).then_some(checks)
}

/// The `index-pack` object-check argument for the git that printed `version`
/// (`git version 2.50.1 (Apple Git-155)`): [`INDEX_PACK_FSCK`] from 2.44, else plain
/// `--fsck-objects` (an older git refuses the severities as an unknown option; it then checks
/// everything at git's defaults, which is stricter, never looser).
pub fn index_pack_checks_for(version: &str) -> &'static str {
    let parsed = version.split_whitespace().nth(2).and_then(|v| {
        let mut it = v.split('.');
        Some((
            it.next()?.parse::<u32>().ok()?,
            it.next()?.parse::<u32>().ok()?,
        ))
    });
    match parsed {
        Some(v) if v < MIN_GIT_FOR_SEVERITIES => "--fsck-objects",
        _ => INDEX_PACK_FSCK,
    }
}

/// One object git's checks refused, from `index-pack`'s stderr.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refusal {
    /// The object's id.
    pub oid: String,
    /// git's msg-id (`hasDotgit`, `gitmodulesUrl`, …).
    pub msg_id: String,
    /// git's message after the msg-id.
    pub message: String,
}

/// The objects `index-pack` (or `fsck`) refused, in the order it reported them: its
/// `error: object <oid>: <msgId>: <message>` lines. Warnings are not refusals.
pub fn refusals(stderr: &str) -> Vec<Refusal> {
    stderr
        .lines()
        .filter_map(|line| {
            let rest = line.trim().strip_prefix("error: object ")?;
            let (oid, rest) = rest.split_once(": ")?;
            let (msg_id, message) = rest.split_once(": ")?;
            let ok = oid.len() >= 40 && oid.bytes().all(|b| b.is_ascii_hexdigit());
            ok.then(|| Refusal {
                oid: oid.to_string(),
                msg_id: msg_id.to_string(),
                message: message.to_string(),
            })
        })
        .collect()
}

/// E511 when git's object checks refused something (its stderr has
/// `error: object <oid>: <msgId>: …` lines), naming the objects and the checks; `None` for
/// any other failure. `pushing`: the history is the caller's own (a push or an import), so
/// the fix is to rewrite it, not to ask a maintainer.
pub fn refused(stderr: &str, pushing: bool) -> Option<UserError> {
    const SHOWN: usize = 3;
    let all = refusals(stderr);
    let first = all.first()?;
    let mut cause: Vec<String> = all
        .iter()
        .take(SHOWN)
        .map(|r| format!("object {}: {}: {}", r.oid, r.msg_id, r.message))
        .collect();
    if all.len() > SHOWN {
        cause.push(format!("and {} more", all.len() - SHOWN));
    }
    let short = &first.oid[..first.oid.len().min(12)];
    let (message, fix, note) = if pushing {
        (
            format!("push refused: git refuses object {short} ({}) in the pushed history", first.msg_id),
            "rewrite the history so no commit holds that object (a path git treats as the repository, a hostile .gitmodules, or a corrupt tree or commit), then push again",
            "nothing was stored or paid for",
        )
    } else {
        (
            format!("git refused object {short} ({}) in this repository's history", first.msg_id),
            "the history holds an object git's checks refuse (a path git treats as the repository, a hostile .gitmodules, or a corrupt tree or commit); ask a maintainer to push history without it",
            "no ref was moved to that history",
        )
    };
    Some(
        UserError::new(codes::OBJECT_REFUSED, message)
            .cause(cause.join("; "))
            .fix(fix)
            .note(note),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_index_pack_argument_is_the_relaxed_list() {
        let list = INDEX_PACK_FSCK.strip_prefix("--fsck-objects=").unwrap();
        let ids: Vec<&str> = list
            .split(',')
            .map(|e| e.strip_suffix("=warn").unwrap())
            .collect();
        assert_eq!(ids, RELAXED);
    }

    #[test]
    fn severities_only_for_a_git_that_takes_them() {
        assert_eq!(index_pack_checks_for("git version 2.52.0"), INDEX_PACK_FSCK);
        assert_eq!(
            index_pack_checks_for("git version 2.44.0.windows.1"),
            INDEX_PACK_FSCK
        );
        assert_eq!(
            index_pack_checks_for("git version 2.39.3 (Apple Git-146)"),
            "--fsck-objects"
        );
        // Unreadable: try the severities (git names the problem if it cannot take them).
        assert_eq!(index_pack_checks_for(""), INDEX_PACK_FSCK);
    }

    #[test]
    fn refusals_are_read_from_git_errors_only() {
        let stderr = "warning: object 1111111111111111111111111111111111111111: badTimezone: invalid author/committer line - bad time zone\n\
error: object 5e6ecdad9f69b1ff789a17733b8edc6fd7091bd8: hasDotgit: contains '.git'\n\
fatal: fsck error in packed object\n";
        assert_eq!(
            refusals(stderr),
            vec![Refusal {
                oid: "5e6ecdad9f69b1ff789a17733b8edc6fd7091bd8".into(),
                msg_id: "hasDotgit".into(),
                message: "contains '.git'".into(),
            }]
        );
        assert!(refusals("fatal: early EOF").is_empty());
    }
}
