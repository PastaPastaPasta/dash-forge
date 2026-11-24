//! Without `git-remote-dash`, `dg repo clone` says so before running git, instead of passing on
//! git's "'remote-dash' is not a git command". Offline: it stops before connecting to anything.
#![cfg(unix)]

use std::path::Path;
use std::process::{Command, Stdio};

/// A PATH with git (linked into `bin`) and `/bin`, where git finds no `git-remote-dash`.
fn path_without_helper(bin: &Path) -> String {
    let sh = |cmd: &str| {
        let out = Command::new("sh").args(["-c", cmd]).output().expect("sh");
        String::from_utf8(out.stdout).unwrap().trim().to_string()
    };
    let git = sh("command -v git");
    std::os::unix::fs::symlink(&git, bin.join("git")).unwrap();
    for dir in ["/bin".to_string(), sh("git --exec-path")] {
        let helper = Path::new(&dir).join("git-remote-dash");
        assert!(!helper.exists(), "{} would be found", helper.display());
    }
    format!("{}:/bin", bin.display())
}

fn dg(home: &Path, path: &str, cwd: &Path, args: &[&str]) -> (bool, String) {
    let out = Command::new(env!("CARGO_BIN_EXE_dg"))
        .args(args)
        .current_dir(cwd)
        .env_clear()
        .env("HOME", home)
        .env("PATH", path)
        .env("DASH_FORGE_NO_KEYCHAIN", "1")
        .stdin(Stdio::null())
        .output()
        .expect("run dg");
    let text =
        String::from_utf8_lossy(&out.stdout).into_owned() + &String::from_utf8_lossy(&out.stderr);
    (out.status.success(), text)
}

#[test]
fn repo_clone_without_the_helper_names_it() {
    let tmp = tempfile::tempdir().unwrap();
    let (home, bin) = (tmp.path().join("home"), tmp.path().join("bin"));
    std::fs::create_dir_all(&home).unwrap();
    std::fs::create_dir_all(&bin).unwrap();
    let path = path_without_helper(&bin);
    let (ok, text) = dg(
        &home,
        &path,
        tmp.path(),
        &[
            "repo",
            "clone",
            "8hJmcHWTsdvkHyCrk4UgjbyugDAmE7QfuCTQXpXAc7nB/project",
        ],
    );
    assert!(!ok, "{text}");
    assert!(text.contains("git-remote-dash is not installed"), "{text}");
    assert!(text.contains("[E206]"), "{text}");
    assert!(!text.contains("is not a git command"), "{text}");
    assert!(!tmp.path().join("project").exists());
}
