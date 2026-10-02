//! The repository argument a command leaves out inside a `dash://` clone (QW-041), and the
//! `-R/--repo <REPO>` option that names it explicitly.
//!
//! `gh issue edit 3 --add-label bug` in a clone of a GitHub repository edits that
//! repository's issue. `dg` commands take the repository as their first positional argument
//! (`dg issue label <REPO> 3 add bug`), so inside a clone a line clap cannot parse, whose
//! command's first positional is `repo`, is tried again with the clone's repository (its
//! `dash://` remote, `origin` first) in that slot. It is used only when the new line parses:
//! `dg issue label 3 add bug`, `dg ci report --sha <sha>`, `dg release download v1.0` and
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

/// Record that the repository this run acts on came from the clone ([`parse`]'s flag).
pub fn mark_repo_from_clone() {
    FROM_CLONE.store(true, Ordering::Relaxed);
}

/// Parse `dg`'s command line: `-R <REPO>` moved into its slot first ([`explicit_repo`]);
/// then, inside a clone (`clone()` names its repository), a line that does not parse is tried
/// again with the clone's repository in the slot ([`with_repo`]). Returns the parsed line and
/// whether its repository came from the clone; the error is clap's for the line as typed.
pub fn parse(
    args: Vec<OsString>,
    clone: impl FnOnce() -> Option<String>,
) -> Result<(crate::Cli, bool), clap::Error> {
    use clap::Parser as _;
    let (args, explicit) = match explicit_repo(&args) {
        Some(a) => (a, true),
        None => (args, false),
    };
    match crate::Cli::try_parse_from(&args) {
        Ok(cli) => Ok((cli, false)),
        Err(e) if explicit || is_help_or_version(&e) => Err(e),
        Err(e) => match with_repo(&args, clone).map(crate::Cli::try_parse_from) {
            Some(Ok(cli)) => Ok((cli, true)),
            // `dg issue view abc` in a clone: as typed, `abc` was the repository and the
            // number was missing; with the clone's repository, `abc` is a bad number. That
            // is the error to show (QW3-069), not "<NUMBER> was not provided".
            Some(Err(retried)) if is_missing_argument(&e) && is_bad_value(&retried) => Err(retried),
            _ => Err(e),
        },
    }
}

/// Whether clap refused the line for a required argument it did not get.
fn is_missing_argument(e: &clap::Error) -> bool {
    e.kind() == clap::error::ErrorKind::MissingRequiredArgument
}

/// Whether clap refused a value it did get (`abc` for a number).
fn is_bad_value(e: &clap::Error) -> bool {
    use clap::error::ErrorKind;
    matches!(
        e.kind(),
        ErrorKind::ValueValidation | ErrorKind::InvalidValue
    )
}

/// Whether clap's "error" is a `--help` / `--version` page (or the help a bare `dg issue`
/// prints), not a usage error.
pub fn is_help_or_version(e: &clap::Error) -> bool {
    use clap::error::ErrorKind;
    matches!(
        e.kind(),
        ErrorKind::DisplayHelp
            | ErrorKind::DisplayVersion
            | ErrorKind::DisplayHelpOnMissingArgumentOrSubcommand
    )
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
    let root = built();
    let mut cmd = &root;
    let mut rest = Vec::with_capacity(args.len());
    rest.extend(args.first().cloned());
    let mut value: Option<OsString> = None;
    let mut i = 1;
    while i < args.len() {
        let Some(token) = args[i].to_str() else {
            rest.push(args[i].clone());
            i += 1;
            continue;
        };
        match token {
            "--" => {
                rest.extend_from_slice(&args[i..]);
                break;
            }
            "-R" | "--repo" => {
                value = Some(args.get(i + 1)?.clone());
                i += 2;
                continue;
            }
            t if t.starts_with("--repo=") => value = Some(t["--repo=".len()..].into()),
            t if t.len() > 2 && t.starts_with("-R") => value = Some(t[2..].into()),
            // another option's value is never taken for `-R` (`--body -R`)
            t if t.starts_with('-') && takes_separate_value(cmd, t) => {
                rest.extend(args[i..].iter().take(2).cloned());
                i += 2;
                continue;
            }
            t => {
                if let Some(sub) = cmd.find_subcommand(t) {
                    cmd = sub;
                }
                rest.push(args[i].clone());
            }
        }
        i += 1;
    }
    let value = value.filter(|v| !v.is_empty())?;
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
/// into the next argument: the clone's own repository `here` (its id, its bare name, or any
/// `<owner>/<name>` with its name, the owner spelt as an id or a DPNS name), or an
/// `owner/name` whose owner is an identity id, `@name` or `name.dash`. A number never is
/// (`dg issue view 3`); `docs`, `feat/x` or `release/*` are what the next argument holds (a
/// label, a branch, a pattern).
pub(crate) fn names_a_repo(given: &str, here: &str) -> bool {
    if is_number(given) {
        return false;
    }
    let name_of = |r: &str| r.split_once('/').map(|(_, n)| n.to_ascii_lowercase());
    let here_name = name_of(here);
    let given_name = name_of(given).unwrap_or_else(|| given.to_ascii_lowercase());
    if given == here || here_name.is_some_and(|n| n == given_name) {
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

/// The subcommand `args` name, deepest first found (`dg pr merge 4 --x` → `pr merge`).
fn leaf<'c>(root: &'c clap::Command, args: &[OsString]) -> Option<&'c clap::Command> {
    let mut cmd = root;
    let mut found = false;
    let mut i = 1;
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
                found = true;
                i += 1;
            }
            None => break,
        }
    }
    found.then_some(cmd)
}

/// The `Usage:` line of the subcommand `args` name, for a usage error (QW3-069 / QW4-066 /
/// QW4-065): clap's own lists the options used and the one it suggests as if required
/// (`dg pr merge --override-policy --merge-oid <MERGE_OID> <REPO> <NUMBER>`), and a repository
/// as required where a clone supplies it. This is the command's plain usage, with the
/// repository optional (`[REPO]`) where it can be left out: inside a clone (`in_clone`).
pub fn usage_line(args: &[OsString], in_clone: bool) -> Option<String> {
    let root = built();
    let cmd = leaf(&root, args)?;
    if cmd.has_subcommands() {
        return None;
    }
    let mut usage = cmd.clone().render_usage().to_string();
    let inferable = in_clone
        && !NEVER_INFERRED.contains(&cmd.get_name())
        && cmd
            .get_positionals()
            .next()
            .is_some_and(|p| p.get_id().as_str() == "repo");
    if inferable {
        usage = usage.replacen(" <REPO>", " [REPO]", 1);
    }
    Some(usage.trim().to_string())
}

/// A pointer for an option `dg` spells another way than `gh` (QW4-066: `--method squash` was
/// pointed at `--merge-oid`), when `unknown` is one, for the subcommand `args` name.
pub fn flag_tip(args: &[OsString], unknown: &str) -> Option<&'static str> {
    let root = built();
    let cmd = leaf(&root, args)?;
    let path = cmd.get_bin_name().unwrap_or_default();
    match (path.ends_with(" pr merge"), unknown) {
        (true, "--method") => Some("the merge method is a flag: `--squash` for a squash, or none for a merge (fast-forward or merge commit)"),
        (true, "--rebase") => Some("a rebase merge is not supported: use `--squash`, or none for a merge (fast-forward or merge commit)"),
        _ => None,
    }
}

/// Whether option `token` (`--name`, `-n`) takes its value as the next argument (not
/// `--name=value` or `-nvalue`).
fn takes_separate_value(cmd: &clap::Command, token: &str) -> bool {
    let arg = if let Some(long) = token.strip_prefix("--") {
        if long.contains('=') {
            return false;
        }
        // Its aliases too (`release create --title` is `--name`).
        cmd.get_arguments().find(|a| {
            a.get_long() == Some(long) || a.get_all_aliases().is_some_and(|all| all.contains(&long))
        })
    } else {
        let mut chars = token.chars().skip(1);
        let (Some(c), None) = (chars.next(), chars.next()) else {
            return false;
        };
        cmd.get_arguments().find(|a| {
            a.get_short() == Some(c)
                || a.get_all_short_aliases()
                    .is_some_and(|all| all.contains(&c))
        })
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

    /// QW4-066: a parse error's usage line is the command's own, with the repository optional
    /// where a clone supplies it, and `--method` points at `--squash`, not `--merge-oid`.
    #[test]
    fn a_usage_error_shows_the_commands_usage_and_points_at_gh_spellings() {
        let line = split("dg pr merge 4 --override-policy --method squash");
        let usage = usage_line(&line, true).unwrap();
        assert_eq!(usage, "Usage: dg pr merge [OPTIONS] [REPO] <NUMBER>");
        assert!(!usage.contains("merge-oid"), "{usage}");
        assert!(flag_tip(&line, "--method").unwrap().contains("`--squash`"));
        assert_eq!(
            flag_tip(&split("dg issue close 4 --method x"), "--method"),
            None
        );
        // QW4-065: `release create` takes the repository from the clone too.
        let usage = usage_line(&split("dg release create --tag v1 --bogus"), true).unwrap();
        assert!(usage.contains("[REPO]"), "{usage}");
        // `dg repo clone` never infers its repository.
        let usage = usage_line(&split("dg repo clone --bogus"), true).unwrap();
        assert!(!usage.contains("[REPO]"), "{usage}");
        assert_eq!(usage_line(&split("dg --bogus"), true), None);
        // Outside a clone the repository is required, as clap's error says.
        let usage = usage_line(&split("dg pr merge 4 --bogus"), false).unwrap();
        assert_eq!(usage, "Usage: dg pr merge [OPTIONS] <REPO> <NUMBER>");
    }

    /// QW4-065: `gh release create --title` / `-t` is `--name` here, under either spelling.
    #[test]
    fn release_create_takes_gh_title() {
        use clap::Parser as _;
        for flag in ["--title", "-t", "--name"] {
            let cli = crate::Cli::try_parse_from([
                "dg", "release", "create", "a/b", "--tag", "v1", flag, "First",
            ])
            .unwrap_or_else(|e| panic!("{flag}: {e}"));
            let crate::Command::Release(crate::ReleaseCommand::Create(a)) = cli.command else {
                panic!("{flag}")
            };
            assert_eq!(a.name, "First");
        }
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

    /// The line `main` runs for `line` typed inside a clone of `here`: as typed when it parses,
    /// else with the clone's repository in its slot when that parses; `None` when neither
    /// does. Checked against [`parse`], which `main` calls: it must accept exactly these
    /// lines, and flag those whose repository came from the clone.
    fn run_in(line: &str, here: &str) -> Option<String> {
        let args = split(line);
        let shown = if parses(&args) {
            Some(join(&args))
        } else {
            with_repo(&args, || Some(here.into()))
                .filter(|a| parses(a))
                .map(|a| join(&a))
        };
        let parsed = parse(args, || Some(here.into()));
        assert_eq!(
            parsed.as_ref().ok().map(|(_, from_clone)| *from_clone),
            shown.as_ref().map(|s| s != line),
            "{line}"
        );
        shown
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
        assert_eq!(run("dg label create alice/project"), None);
        assert_eq!(run("dg collab add bob/Project"), None);
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

    /// QW3-069: `dg issue view abc` in a clone is a bad number, not a missing one.
    #[test]
    fn a_bad_number_in_a_clone_is_reported_as_one() {
        let e = parse(split("dg issue view abc"), || Some(HERE.into())).unwrap_err();
        assert_eq!(e.kind(), clap::error::ErrorKind::ValueValidation, "{e}");
        assert!(e.to_string().contains("'abc' for '<NUMBER>'"), "{e}");
        // outside a clone, the line as typed is what is wrong
        let e = parse(split("dg issue view abc"), || None).unwrap_err();
        assert_eq!(e.kind(), clap::error::ErrorKind::MissingRequiredArgument);
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
        // after `--`, or as another option's value, it is not the option
        assert_eq!(
            explicit_repo(&split("dg issue comment x 3 --body -- -R")),
            None
        );
        assert_eq!(
            explicit_repo(&split("dg issue comment x 3 --body -R")),
            None
        );
        assert_eq!(
            explicit_repo(&split("dg issue comment 3 --body -R -R x/y"))
                .map(|a| join(&a))
                .as_deref(),
            Some("dg issue comment x/y 3 --body -R")
        );
    }

    /// `parse`, as `main` calls it: an explicit `-R` is never second-guessed by the clone,
    /// help is help, and the flag says where the repository came from.
    #[test]
    fn parse_reports_where_the_repository_came_from() {
        let here = || Some(HERE.to_string());
        let (cli, from_clone) = parse(split("dg issue label 3 add bug"), here).unwrap();
        assert!(from_clone);
        let crate::Command::Issue(crate::IssueCommand::Label { repo, number, .. }) = cli.command
        else {
            panic!("not issue label")
        };
        assert_eq!((repo.as_str(), number), (HERE, 3));
        let (_, from_clone) = parse(split("dg issue label -R a/b 3 add bug"), here).unwrap();
        assert!(!from_clone);
        // with -R, a line that still does not parse is not retried with the clone's repository
        assert!(parse(split("dg label create -R a/b"), here).is_err());
        let e = parse(split("dg issue label --help"), here).unwrap_err();
        assert!(is_help_or_version(&e));
        let e = parse(split("dg label create project"), here).unwrap_err();
        assert_eq!(e.kind(), clap::error::ErrorKind::MissingRequiredArgument);
    }
}
