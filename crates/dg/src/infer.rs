//! The repository argument a command leaves out inside a `dash://` clone (QW-041), and the
//! `-R/--repo <REPO>` option that names it explicitly.
//!
//! `gh issue edit 3 --add-label bug` in a clone of a GitHub repository edits that
//! repository's issue. `dg` commands take the repository as their first positional argument
//! (`dg issue label <REPO> 3 add bug`), so inside a clone a line clap cannot parse, whose
//! command's first positional is `repo`, is tried again with the clone's repository (its
//! `dash://` remote, `origin` first) in that slot. It is used only when the new line parses:
//! `dg issue label 3 add bug`, `dg ci status <sha>`, `dg release download v1.0` and
//! `dg label create docs` all read as the clone's.
//!
//! What the user did type keeps its meaning where it clearly names a repository: a line
//! that already parses is never changed, and the slot is left alone when it holds the clone's
//! own repository (`dg label create project` inside a clone of `alice/project` is a label
//! name left out, not a label called `project`) or an unambiguous `owner/name` (an identity
//! id, `@name` or `name.dash` as the owner). `-R <REPO>` (`--repo`) always wins: it is put in
//! the slot before anything is parsed, as with `gh -R`.

use std::ffi::OsString;
use std::sync::atomic::{AtomicBool, Ordering};

use clap::CommandFactory as _;

/// Subcommands whose repository cannot sensibly default to the current clone.
const NEVER_INFERRED: &[&str] = &["clone"];

/// Set when this run's repository came from the clone rather than the command line.
static FROM_CLONE: AtomicBool = AtomicBool::new(false);

/// Whether the repository this run acts on was taken from the current clone (the user did
/// not name one). `dg pr create` then opens the PR in the clone's parent when the clone is a
/// fork, as `gh pr create` does.
pub fn repo_from_clone() -> bool {
    FROM_CLONE.load(Ordering::Relaxed)
}

/// Record that [`with_repo`]'s line is the one this run uses.
pub fn mark_repo_from_clone() {
    FROM_CLONE.store(true, Ordering::Relaxed);
}

/// `args` with `repo()` (the clone's repository) put in the repository slot of the subcommand
/// they name, or `None` when that subcommand's first positional is not a repository, there is
/// no clone, or what is in the slot names a repository ([`names_a_repo`]). The caller parses
/// the result and keeps the original error when it does not parse.
pub fn with_repo(
    args: &[OsString],
    repo: impl FnOnce() -> Option<String>,
) -> Option<Vec<OsString>> {
    let root = built();
    let (at, given) = repo_slot(&root, args)?;
    let here = repo()?;
    if given.as_deref().is_some_and(|g| names_a_repo(g, &here)) {
        return None;
    }
    let mut out = args.to_vec();
    out.insert(at, here.into());
    Some(out)
}

/// `args` with a `-R <REPO>` / `--repo <REPO>` / `--repo=<REPO>` option moved into the
/// repository slot of the subcommand they name, or `None` when there is none, or that
/// subcommand's first positional is not a repository (`dg import --repo` is its own option).
pub fn explicit_repo(args: &[OsString]) -> Option<Vec<OsString>> {
    let mut rest = Vec::with_capacity(args.len());
    let mut value: Option<OsString> = None;
    let mut i = 0;
    while i < args.len() {
        let token = args[i].to_str();
        match token {
            Some("--") => {
                rest.extend_from_slice(&args[i..]);
                break;
            }
            Some("-R" | "--repo") if i > 0 => {
                value = Some(args.get(i + 1)?.clone());
                i += 2;
                continue;
            }
            Some(t) if i > 0 && t.starts_with("--repo=") => {
                value = Some(t["--repo=".len()..].into());
            }
            Some(t) if i > 0 && t.len() > 2 && t.starts_with("-R") => {
                value = Some(t[2..].into());
            }
            _ => rest.push(args[i].clone()),
        }
        i += 1;
    }
    let value = value.filter(|v| !v.is_empty())?;
    let root = built();
    let (at, _) = repo_slot(&root, &rest)?;
    rest.insert(at, value);
    Some(rest)
}

fn built() -> clap::Command {
    let mut root = crate::Cli::command();
    root.build();
    root
}

/// An issue or PR number (`3`).
fn is_number(arg: &str) -> bool {
    !arg.is_empty() && arg.bytes().all(|b| b.is_ascii_digit())
}

/// Whether `given`, typed where the repository goes, names one, so it must not be shifted
/// into the next argument: the clone's own repository `here` (as `owner/name`, its bare name,
/// or its id), or an `owner/name` whose owner is an identity id, `@name` or `name.dash`. A
/// number never is (`dg issue view 3`); `docs`, `feat/x` or `release/*` are what the next
/// argument holds (a label, a branch, a pattern).
fn names_a_repo(given: &str, here: &str) -> bool {
    if is_number(given) {
        return false;
    }
    let here_name = here.split_once('/').map(|(_, n)| n);
    if given == here || here_name.is_some_and(|n| given.eq_ignore_ascii_case(n)) {
        return true;
    }
    match given.split_once('/') {
        Some((owner, name)) if !name.is_empty() && !name.contains('/') => {
            // `alice.dash`: the label is shorter than what was typed
            let dash_suffixed =
                forge_core::resolve::dpns_label(owner).is_some_and(|l| l.len() < owner.len());
            (owner.starts_with('@')
                || dash_suffixed
                || forge_core::resolve::looks_like_identity_id(owner))
                && forge_core::rules::v2::normalize_repo_name(name).is_some()
        }
        _ => false,
    }
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
    const ID: &str = "DYXPkp8gdKUjUzMUtGGjWGP2tP1dtrBPyDq3vLgu5Cx6";

    fn split(line: &str) -> Vec<OsString> {
        line.split(' ').map(OsString::from).collect()
    }

    fn join(args: &[OsString]) -> String {
        args.iter()
            .map(|s| s.to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join(" ")
    }

    fn parses(args: &[OsString]) -> bool {
        <crate::Cli as clap::Parser>::try_parse_from(args).is_ok()
    }

    /// What `main` does: the line as typed when it parses, else the clone's repository put in
    /// its slot when that parses; `None` when neither does.
    fn run_in(line: &str, here: &str) -> Option<String> {
        let args = split(line);
        if parses(&args) {
            return Some(join(&args));
        }
        with_repo(&args, || Some(here.into()))
            .filter(|a| parses(a))
            .map(|a| join(&a))
    }

    fn run(line: &str) -> Option<String> {
        run_in(line, HERE)
    }

    #[test]
    fn a_missing_repository_is_the_clones() {
        for (typed, meant) in [
            ("dg issue list", format!("dg issue list {HERE}")),
            ("dg issue view 3", format!("dg issue view {HERE} 3")),
            (
                "dg issue create --title x --yes",
                format!("dg issue create {HERE} --title x --yes"),
            ),
            // global options before the command, with separate values
            (
                "dg --network devnet --json pr list",
                format!("dg --network devnet --json pr list {HERE}"),
            ),
            // nested subcommands
            ("dg ci runner list", format!("dg ci runner list {HERE}")),
            (
                "dg pr view 5 --comments",
                format!("dg pr view {HERE} 5 --comments"),
            ),
        ] {
            assert_eq!(run(typed).as_deref(), Some(meant.as_str()), "{typed}");
        }
    }

    /// QW-041: commands with two or more positionals (the wave-2 matrix).
    #[test]
    fn commands_with_more_positionals_take_the_clones_repository() {
        for (typed, rest) in [
            ("dg issue label 3 add bug", "3 add bug"),
            ("dg issue assign 3 me", "3 me"),
            ("dg issue unassign 3 me", "3 me"),
            ("dg issue milestone 3 v1.0", "3 v1.0"),
            ("dg pr request-review 4 @qacli2dx7", "4 @qacli2dx7"),
            ("dg pr resolve 4 abc", "4 abc"),
            ("dg label create docs --color 00ff00", "docs --color 00ff00"),
            ("dg label create area/cli", "area/cli"),
            ("dg milestone create v1.0", "v1.0"),
            (
                &format!("dg collab add {ID} --role writer"),
                &format!("{ID} --role writer"),
            ),
            (
                "dg ci status 556ec1132b8e0e216276d9154edb0d267f390e1d",
                "556ec1132b8e0e216276d9154edb0d267f390e1d",
            ),
            ("dg ci runner add @alice", "@alice"),
            ("dg release unpublish v0.1.0", "v0.1.0"),
            ("dg release download v0.1.0", "v0.1.0"),
            ("dg repo protect add release/*", "release/*"),
            ("dg webhook remove 2e23322371cf", "2e23322371cf"),
        ] {
            let (head, _) = typed.split_at(typed.len() - rest.len() - 1);
            assert_eq!(
                run(typed).as_deref(),
                Some(format!("{head} {HERE} {rest}").as_str()),
                "{typed}"
            );
        }
    }

    #[test]
    fn what_was_typed_keeps_its_meaning() {
        // a full line is never changed
        assert_eq!(
            run("dg issue label alice/project 3 add bug").as_deref(),
            Some("dg issue label alice/project 3 add bug")
        );
        // a repository is already there (the error is something else missing or wrong)
        assert_eq!(run("dg issue view alice/project"), None);
        assert_eq!(run("dg issue view alice/project abc"), None);
        assert_eq!(run("dg issue assign otherrepo 3"), None);
        assert_eq!(run(&format!("dg issue view {ID}")), None);
        // the clone's own repository, however it is spelt, is never shifted into the next
        // slot, where it would name a label, a member or a tag
        assert_eq!(run("dg label create project"), None);
        assert_eq!(run(&format!("dg label create {HERE}")), None);
        assert_eq!(run("dg release download PROJECT"), None);
        // nor an owner/name that can only be a repository
        assert_eq!(run(&format!("dg label create {ID}/other")), None);
        assert_eq!(run("dg collab add @alice/other"), None);
        assert_eq!(run("dg collab add alice.dash/other"), None);
        // a repo addressed by its id in the clone's remote
        assert_eq!(run_in(&format!("dg label create {ID}"), ID), None);
        // not a repository slot, or a command that takes none
        for line in ["dg repo create", "dg repo clone", "dg auth status"] {
            assert_eq!(
                with_repo(&split(line), || Some(HERE.into())),
                None,
                "{line}"
            );
        }
        // outside a clone: nothing to put there
        assert_eq!(with_repo(&split("dg issue list"), || None), None);
    }

    #[test]
    fn dash_r_names_the_repository() {
        for (typed, meant) in [
            (
                "dg pr create -R alice/project --title x",
                "dg pr create alice/project --title x",
            ),
            (
                "dg pr create --title x --repo alice/project",
                "dg pr create alice/project --title x",
            ),
            (
                "dg issue label --repo=alice/project 3 add bug",
                "dg issue label alice/project 3 add bug",
            ),
            (
                "dg -Ralice/project ci runner list",
                "dg ci runner list alice/project",
            ),
            (
                "dg --json issue view 3 -R alice/project",
                "dg --json issue view alice/project 3",
            ),
        ] {
            let out = explicit_repo(&split(typed)).map(|a| join(&a));
            assert_eq!(out.as_deref(), Some(meant), "{typed}");
            assert!(parses(&split(meant)), "{meant}");
        }
        // no -R, or a command whose own --repo is something else
        assert_eq!(explicit_repo(&split("dg issue list")), None);
        assert_eq!(
            explicit_repo(&split("dg import github.com/a/b --repo mine")),
            None
        );
        assert_eq!(explicit_repo(&split("dg auth status -R x")), None);
        // after `--` it is an argument, not an option
        assert_eq!(
            explicit_repo(&split("dg issue comment x 3 --body -- -R")),
            None
        );
    }
}
