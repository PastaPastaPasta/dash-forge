//! The repository argument a command leaves out inside a `dash://` clone (QW-041).
//!
//! `gh issue list` in a clone of a GitHub repository lists that repository's issues. `dg`
//! commands take the repository as their first positional argument (`dg issue list <REPO>`),
//! so when clap says a required argument is missing, and the command's first positional is
//! `repo`, the clone's repository (its `dash://` remote, `origin` first) is put in that slot
//! and the line parsed again. What the user did type keeps its meaning: the slot is filled
//! only when it is empty or holds an issue / PR number (`dg issue view 3`). Anything else
//! there may be a repository (a bare name is one of your own), and shifting it into the next
//! argument could write to the wrong repository, so the usage error stands.

use std::ffi::OsString;

use clap::CommandFactory as _;

/// Subcommands whose repository cannot sensibly default to the current clone.
const NEVER_INFERRED: &[&str] = &["clone"];

/// `args` with `repo` put in the repository slot of the subcommand they name, or `None` when
/// that subcommand's first positional is not a repository, or the slot holds something other
/// than a number.
pub fn with_repo(
    args: &[OsString],
    repo: impl FnOnce() -> Option<String>,
) -> Option<Vec<OsString>> {
    let mut root = crate::Cli::command();
    root.build();
    let (at, given) = repo_slot(&root, args)?;
    if given.as_deref().is_some_and(|g| !is_number(g)) {
        return None;
    }
    let mut out = args.to_vec();
    out.insert(at, repo()?.into());
    Some(out)
}

/// An issue or PR number (`3`).
fn is_number(arg: &str) -> bool {
    !arg.is_empty() && arg.bytes().all(|b| b.is_ascii_digit())
}

/// Where the repository goes in `args` (just after the leaf subcommand's name) and the
/// argument now in that slot, if any. `None` unless the leaf's first positional is `repo`.
fn repo_slot(root: &clap::Command, args: &[OsString]) -> Option<(usize, Option<String>)> {
    let mut cmd = root;
    let mut i = 1;
    let mut at = None;
    while i < args.len() {
        let token = args[i].to_str()?;
        if token == "--" {
            break;
        }
        if token.starts_with('-') {
            i += if takes_separate_value(cmd, token) {
                2
            } else {
                1
            };
            continue;
        }
        match cmd.find_subcommand(token) {
            Some(sub) => {
                cmd = sub;
                i += 1;
                at = Some(i);
            }
            None => break,
        }
    }
    let at = at?;
    if cmd.has_subcommands() || NEVER_INFERRED.contains(&cmd.get_name()) {
        return None;
    }
    let first = cmd.get_positionals().next()?;
    if first.get_id().as_str() != "repo" {
        return None;
    }
    // The first positional argument after the subcommand's name, options skipped.
    let mut j = at;
    let mut given = None;
    while j < args.len() {
        let token = args[j].to_str()?;
        if token == "--" {
            given = args.get(j + 1).and_then(|a| a.to_str()).map(str::to_string);
            break;
        }
        if token.starts_with('-') && token.len() > 1 {
            j += if takes_separate_value(cmd, token) {
                2
            } else {
                1
            };
            continue;
        }
        given = Some(token.to_string());
        break;
    }
    Some((at, given))
}

/// Whether option `token` (`--name`, `-n`) takes its value as the next argument (not
/// `--name=value` or `-nvalue`).
fn takes_separate_value(cmd: &clap::Command, token: &str) -> bool {
    let arg = if let Some(long) = token.strip_prefix("--") {
        if long.contains('=') {
            return false;
        }
        cmd.get_arguments().find(|a| a.get_long() == Some(long))
    } else {
        let mut chars = token.chars().skip(1);
        let (Some(c), None) = (chars.next(), chars.next()) else {
            return false;
        };
        cmd.get_arguments().find(|a| a.get_short() == Some(c))
    };
    arg.is_some_and(|a| a.get_action().takes_values())
}

#[cfg(test)]
mod tests {
    use super::*;

    const HERE: &str = "8hJmcHWTsdvkHyCrk4UgjbyugDAmE7QfuCTQXpXAc7nB/project";

    fn run(line: &str) -> Option<String> {
        let args: Vec<OsString> = line.split(' ').map(OsString::from).collect();
        with_repo(&args, || Some(HERE.into())).map(|a| {
            a.iter()
                .map(|s| s.to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join(" ")
        })
    }

    #[test]
    fn a_missing_repository_is_the_clones() {
        assert_eq!(
            run("dg issue list").unwrap(),
            format!("dg issue list {HERE}")
        );
        assert_eq!(
            run("dg issue view 3").unwrap(),
            format!("dg issue view {HERE} 3")
        );
        assert_eq!(
            run("dg issue create --title x --yes").unwrap(),
            format!("dg issue create {HERE} --title x --yes")
        );
        // global options before the command, with separate values
        assert_eq!(
            run("dg --network devnet --json pr list").unwrap(),
            format!("dg --network devnet --json pr list {HERE}")
        );
        // nested subcommands
        assert_eq!(
            run("dg ci runner list").unwrap(),
            format!("dg ci runner list {HERE}")
        );
        // every result parses
        for line in [
            "dg issue list",
            "dg issue view 3",
            "dg pr view 5 --comments",
            "dg ci runner list",
        ] {
            let args: Vec<String> = run(line).unwrap().split(' ').map(String::from).collect();
            assert!(
                <crate::Cli as clap::Parser>::try_parse_from(&args).is_ok(),
                "{line}"
            );
        }
    }

    #[test]
    fn what_was_typed_keeps_its_meaning() {
        // a repository is already there (the error is something else missing)
        assert_eq!(run("dg issue view alice/project"), None);
        assert_eq!(
            run("dg issue view 8hJmcHWTsdvkHyCrk4UgjbyugDAmE7QfuCTQXpXAc7nB"),
            None
        );
        // a bare word may be one of your own repositories: never shifted into the next slot,
        // where it would name a runner, a label or a branch of the clone's repository
        assert_eq!(run("dg ci runner add myrepo --yes"), None);
        assert_eq!(run("dg label create bug"), None);
        assert_eq!(run("dg repo protect add release/*"), None);
        // not a repository slot, or a command that takes none
        assert_eq!(run("dg repo create"), None);
        assert_eq!(run("dg repo clone"), None);
        assert_eq!(run("dg auth status"), None);
        // outside a clone: nothing to put there
        let args: Vec<OsString> = ["dg", "issue", "list"].map(OsString::from).to_vec();
        assert_eq!(with_repo(&args, || None), None);
    }
}
