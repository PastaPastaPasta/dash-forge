//! Regression: `build_pack` under `git push` runs with `GIT_DIR` exported (git sets it for
//! remote helpers). The completed-then-reordered candidate initialises a scratch bare odb
//! with `git -C <scratch> init --bare`; git honours `GIT_DIR` over `-C`, so without clearing
//! it that command re-initialised the USER's repository as `core.bare = true`, silently
//! breaking every later `git add`/`commit` in their worktree ("this operation must be run
//! in a work tree"). Found by the live storage-byo e2e.
//!
//! Its own test binary: it sets a process-wide environment variable.

use std::path::Path;
use std::process::Command;

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_AUTHOR_NAME", "t")
        .env("GIT_AUTHOR_EMAIL", "t@e.x")
        .env("GIT_COMMITTER_NAME", "t")
        .env("GIT_COMMITTER_EMAIL", "t@e.x")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .expect("spawn git");
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

#[test]
fn build_pack_never_touches_the_repo_named_by_git_dir() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path();
    git(repo, &["init", "-q", "-b", "main"]);
    for (i, name) in ["a.txt", "b.txt"].iter().enumerate() {
        std::fs::write(repo.join(name), format!("content {i}\n").repeat(200)).unwrap();
        git(repo, &["add", "-A"]);
        git(repo, &["commit", "-q", "-m", name]);
    }
    let base = git(repo, &["rev-parse", "HEAD~1"]);
    let head = git(repo, &["rev-parse", "HEAD"]);

    // Exactly what git does for a remote helper.
    let git_dir = std::fs::canonicalize(repo.join(".git")).unwrap();
    std::env::set_var("GIT_DIR", &git_dir);
    // A have-base forces the second (scratch-odb) candidate to be built.
    let pack = forge_core::pack::build_pack(&git_dir, &[&head], &[&base]).unwrap();
    std::env::remove_var("GIT_DIR");

    assert!(pack.parsed.object_count() > 0);
    assert_eq!(
        git(repo, &["config", "--get", "core.bare"]),
        "false",
        "build_pack re-initialised the user's repository as bare"
    );
    // The worktree still works.
    std::fs::write(repo.join("c.txt"), "more\n").unwrap();
    git(repo, &["add", "-A"]);
    git(repo, &["commit", "-q", "-m", "c"]);
}
