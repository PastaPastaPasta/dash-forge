//! The helper keeps state (the repository pin in git config, the sealed-object ledger and the rest
//! of `.git/dash/`, the `pre-push` hook) only in a clone of the dash remote it serves. A bare
//! `git ls-remote dash://…` or `git fetch dash://…` run in another repository (the dash-forge
//! source tree, a QA script's working directory) leaves that repository as it was: three QA runs
//! put a `pre-push` hook and a ledger in the source repository's shared `.git` that way and broke
//! every worktree's push to GitHub.
//!
//! Offline: the network is one with no forge-v2 deployment, so the helper stops at its first
//! Platform read (E702), after everything it used to write before connecting.

use std::path::Path;
use std::process::{Command, Output, Stdio};

const HELPER: &str = env!("CARGO_BIN_EXE_git-remote-dash");
const URL: &str = "dash://8hJmcHWTsdvkHyCrk4UgjbyugDAmE7QfuCTQXpXAc7nB/project";

/// git in `dir` with no user or system config, an empty HOME, the built helper first on `PATH`,
/// and a network the helper fails on before any Platform read.
fn git(dir: &Path, home: &Path, args: &[&str]) -> Output {
    let bin = Path::new(HELPER).parent().unwrap();
    let path = format!(
        "{}:{}",
        bin.display(),
        std::env::var("PATH").unwrap_or_default()
    );
    Command::new("git")
        .current_dir(dir)
        .args(args)
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env("HOME", home)
        .env("XDG_CONFIG_HOME", home.join("xdg"))
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_COUNT", "0")
        .env("GIT_AUTHOR_NAME", "t")
        .env("GIT_AUTHOR_EMAIL", "t@e.x")
        .env("GIT_COMMITTER_NAME", "t")
        .env("GIT_COMMITTER_EMAIL", "t@e.x")
        .env("DASH_FORGE_NETWORK", "mainnet")
        .env("DASH_FORGE_NO_KEYCHAIN", "1")
        .env("PATH", path)
        .stdin(Stdio::null())
        .output()
        .unwrap()
}

fn ok(dir: &Path, home: &Path, args: &[&str]) -> String {
    let out = git(dir, home, args);
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_owned()
}

/// What the helper would have left in `repo`: hooks, `.git/dash/`, `dash.*` config.
fn helper_state(repo: &Path, home: &Path) -> Vec<String> {
    let git_dir = repo.join(".git");
    let mut found = Vec::new();
    for e in std::fs::read_dir(git_dir.join("hooks")).into_iter().flatten() {
        let name = e.unwrap().file_name().to_string_lossy().into_owned();
        if !name.ends_with(".sample") {
            found.push(format!("hooks/{name}"));
        }
    }
    if git_dir.join("dash").exists() {
        found.push("dash/".into());
    }
    let config = git(repo, home, &["config", "--local", "--get-regexp", r"^dash\."]);
    found.extend(
        String::from_utf8_lossy(&config.stdout)
            .lines()
            .map(|l| format!("config {l}")),
    );
    found
}

/// A repository that is no clone of `URL` (empty, and with a commit), its origin on GitHub: a bare
/// `git ls-remote` / `git fetch` of the dash URL in it fails on the network and writes nothing.
#[test]
fn a_bare_url_listed_or_fetched_in_another_repository_leaves_it_alone() {
    let t = tempfile::TempDir::new().unwrap();
    let home = t.path().join("home");
    std::fs::create_dir_all(&home).unwrap();
    for with_commit in [false, true] {
        let repo = t.path().join(format!("source-{with_commit}"));
        std::fs::create_dir_all(&repo).unwrap();
        ok(&repo, &home, &["init", "-q", "-b", "main"]);
        ok(
            &repo,
            &home,
            &["remote", "add", "origin", "https://github.com/example/source.git"],
        );
        if with_commit {
            ok(&repo, &home, &["commit", "-q", "--allow-empty", "-m", "x"]);
        }
        for args in [&["ls-remote", URL][..], &["fetch", URL, "main"][..]] {
            let out = git(&repo, &home, args);
            assert!(!out.status.success(), "git {args:?} reached no network");
            let stderr = String::from_utf8_lossy(&out.stderr);
            assert!(stderr.contains("E702"), "git {args:?}: {stderr}");
            assert_eq!(
                helper_state(&repo, &home),
                Vec::<String>::new(),
                "git {args:?} in a repository that is not a clone of {URL}"
            );
        }
    }
}

/// A clone of `URL` (`git clone` of an empty repository leaves just this: no refs, `origin` at
/// the URL) is the helper's to keep state in. Its `list` creates the empty ledger (a clone of an
/// empty repository never sends a `fetch`), and nothing else: the pin and the `pre-push` hook wait
/// for a fetch or push that writes refs.
#[test]
fn an_empty_clone_of_the_remote_gets_its_ledger_and_nothing_else_from_a_list() {
    let t = tempfile::TempDir::new().unwrap();
    let home = t.path().join("home");
    std::fs::create_dir_all(&home).unwrap();
    let repo = t.path().join("clone");
    std::fs::create_dir_all(&repo).unwrap();
    ok(&repo, &home, &["init", "-q", "-b", "main"]);
    ok(&repo, &home, &["remote", "add", "origin", URL]);
    for args in [&["ls-remote", "origin"][..], &["ls-remote", URL][..]] {
        let out = git(&repo, &home, args);
        assert!(!out.status.success(), "git {args:?} reached no network");
        assert_eq!(
            helper_state(&repo, &home),
            vec!["dash/".to_string()],
            "git {args:?}"
        );
        assert!(repo.join(".git/dash/sealed-ledger").is_file());
    }
}
