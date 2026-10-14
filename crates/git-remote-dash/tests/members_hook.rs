//! The `pre-push` hook against real git (mixed-visibility DESIGN §4.3 "Pre-push hook (C1)", E810):
//! a clone whose ledger records a members-only commit cannot `git push --mirror` it to a local
//! bare repository, nor push a public branch merging it to another remote, while public branches
//! still push; `--no-verify` is the documented escape. Offline: no Platform involved.

use std::fmt::Write as _;
use std::path::Path;
use std::process::{Command, Output, Stdio};

const HELPER: &str = env!("CARGO_BIN_EXE_git-remote-dash");

/// git in `dir` with no user or system config (nor any a caller's environment injects), the
/// built helper first on `PATH`.
fn git(dir: &Path, args: &[&str]) -> Output {
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
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_COUNT", "0")
        .env("GIT_AUTHOR_NAME", "t")
        .env("GIT_AUTHOR_EMAIL", "t@e.x")
        .env("GIT_COMMITTER_NAME", "t")
        .env("GIT_COMMITTER_EMAIL", "t@e.x")
        .env("PATH", path)
        .stdin(Stdio::null())
        .output()
        .unwrap()
}

fn ok(dir: &Path, args: &[&str]) -> String {
    let out = git(dir, args);
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_owned()
}

fn commit(dir: &Path, file: &str, body: &str) -> String {
    std::fs::write(dir.join(file), body).unwrap();
    ok(dir, &["add", file]);
    ok(dir, &["commit", "-q", "-m", body]);
    ok(dir, &["rev-parse", "HEAD"])
}

fn helper(dir: &Path, args: &[&str]) -> Output {
    Command::new(HELPER)
        .current_dir(dir)
        .args(args)
        .env_remove("GIT_DIR")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_COUNT", "0")
        .output()
        .unwrap()
}

#[test]
fn the_hook_refuses_members_only_commits_to_other_remotes_and_lets_public_ones_through() {
    let t = tempfile::TempDir::new().unwrap();
    let clone = t.path().join("clone");
    let backup = t.path().join("backup.git");
    std::fs::create_dir_all(&clone).unwrap();
    ok(&clone, &["init", "-q", "-b", "main"]);
    ok(
        t.path(),
        &["init", "-q", "--bare", backup.to_str().unwrap()],
    );
    let public = commit(&clone, "pub.txt", "public");
    ok(&clone, &["checkout", "-q", "-b", "sec/fix"]);
    let members_only = commit(&clone, "secret.txt", "members-only fix");
    ok(&clone, &["checkout", "-q", "main"]);

    // a clone that fetched sec/fix from a dash remote: its ledger records the members-only tip
    // and its public tips are known
    let init = helper(&clone, &["--init-ledger"]);
    assert!(init.status.success(), "{init:?}");
    let ledger = clone.join(".git/dash/sealed-ledger");
    let mut text = std::fs::read_to_string(&ledger).unwrap();
    writeln!(text, "commit {members_only}").unwrap();
    std::fs::write(&ledger, text).unwrap();
    std::fs::write(clone.join(".git/dash/public-tips"), format!("{public}\n")).unwrap();
    let install = helper(&clone, &["--install-hook"]);
    assert!(install.status.success(), "{install:?}");
    assert!(clone.join(".git/hooks/pre-push").exists());

    // a remote that fetches from dash and pushes elsewhere (`pushurl`): its remote-tracking refs
    // hold the members-only branch under its real name, and still the push is refused
    ok(&clone, &["remote", "add", "origin", "dash://o/r"]);
    ok(
        &clone,
        &[
            "remote",
            "set-url",
            "--push",
            "origin",
            backup.to_str().unwrap(),
        ],
    );
    ok(
        &clone,
        &["update-ref", "refs/remotes/origin/sec/fix", &members_only],
    );
    let pushurl = git(&clone, &["push", "origin", "sec/fix"]);
    assert!(!pushurl.status.success(), "{pushurl:?}");
    assert!(String::from_utf8_lossy(&pushurl.stderr).contains("E810"));

    // the public branch pushes
    ok(&clone, &["push", "-q", backup.to_str().unwrap(), "main"]);
    // --mirror sends sec/fix too: refused, nothing written for the members-only ref
    let mirror = git(&clone, &["push", "--mirror", backup.to_str().unwrap()]);
    assert!(!mirror.status.success(), "{mirror:?}");
    let err = String::from_utf8_lossy(&mirror.stderr);
    assert!(
        err.contains("E810") && err.contains("refs/heads/sec/fix"),
        "{err}"
    );
    assert!(err.contains("members-only fix"), "names the commit: {err}");
    assert!(err.contains("--no-verify"), "{err}");
    let listed = ok(&backup, &["for-each-ref", "--format=%(refname)"]);
    assert!(!listed.contains("sec/fix"), "{listed}");
    // a public branch merging it is refused as well
    ok(
        &clone,
        &["merge", "-q", "--no-ff", "-m", "merge sec", "sec/fix"],
    );
    let merged = git(&clone, &["push", backup.to_str().unwrap(), "main"]);
    assert!(!merged.status.success(), "{merged:?}");
    // the documented escape: --no-verify publishes it
    ok(
        &clone,
        &[
            "push",
            "-q",
            "--no-verify",
            backup.to_str().unwrap(),
            "main",
        ],
    );

    // a pre-push hook the user already had keeps running, after the check
    let chained = t.path().join("chained.log");
    std::fs::write(
        clone.join(".git/hooks/pre-push"),
        format!("#!/bin/sh\necho ran >> '{}'\n", chained.display()),
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(
            clone.join(".git/hooks/pre-push"),
            std::fs::Permissions::from_mode(0o755),
        )
        .unwrap();
    }
    assert!(helper(&clone, &["--install-hook"]).status.success());
    assert!(clone.join(".git/hooks/pre-push.dash-chained").exists());
    let side = commit(&clone, "pub2.txt", "public two");
    let _ = side;
    ok(&clone, &["push", "-q", backup.to_str().unwrap(), "main"]);
    assert_eq!(std::fs::read_to_string(&chained).unwrap(), "ran\n");
}

#[test]
fn a_clone_that_never_held_members_only_commits_pushes_anywhere() {
    let t = tempfile::TempDir::new().unwrap();
    let clone = t.path().join("clone");
    let backup = t.path().join("backup.git");
    std::fs::create_dir_all(&clone).unwrap();
    ok(&clone, &["init", "-q", "-b", "main"]);
    ok(
        t.path(),
        &["init", "-q", "--bare", backup.to_str().unwrap()],
    );
    commit(&clone, "a.txt", "one");
    assert!(helper(&clone, &["--init-ledger"]).status.success());
    assert!(helper(&clone, &["--install-hook"]).status.success());
    ok(
        &clone,
        &["push", "-q", "--mirror", backup.to_str().unwrap()],
    );
    // an unreadable ledger fails closed
    std::fs::write(
        clone.join(".git/dash/sealed-ledger"),
        "# dash sealed-object ledger v2\n",
    )
    .unwrap();
    commit(&clone, "a.txt", "two");
    let out = git(&clone, &["push", backup.to_str().unwrap(), "main"]);
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("E806"));
}
