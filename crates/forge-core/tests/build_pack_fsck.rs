//! A push is checked as a clone checks a fetch (`forge_core::pack::fsck`): history with the
//! malformed author lines real repositories carry (psf/requests' `+051800` time zone, an ident
//! with no space before the date) builds a pack, and history no clone would take — a `.git`
//! look-alike, a `.gitmodules` whose URL is an option — is refused as E511 before anything is
//! stored.

use std::io::Write as _;
use std::path::Path;
use std::process::{Command, Stdio};

use forge_core::user_error::codes;

const OK_IDENT: &str = "A <a@b> 1313584730 +0000";

fn git(dir: &Path, args: &[&str], stdin: &[u8]) -> String {
    let mut child = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .env_remove("GIT_DIR")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn git");
    child.stdin.take().unwrap().write_all(stdin).unwrap();
    let out = child.wait_with_output().unwrap();
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

/// Write an object without git's checks.
fn put(repo: &Path, kind: &str, body: &[u8]) -> String {
    git(
        repo,
        &["hash-object", "--literally", "-w", "-t", kind, "--stdin"],
        body,
    )
}

/// A tree of one file `name` holding `body`.
fn one_file_tree(repo: &Path, name: &str, body: &[u8]) -> String {
    let mut e = format!("100644 {name}\0").into_bytes();
    e.extend(hex::decode(put(repo, "blob", body)).unwrap());
    put(repo, "tree", &e)
}

/// A repo whose `main` is a well-formed `base`, then one commit whose tree is the one file
/// `name` = `body` and whose author line is `ident`; returns (repo, base, head).
fn history(name: &str, body: &[u8], ident: &str) -> (tempfile::TempDir, String, String) {
    let tmp = tempfile::tempdir().unwrap();
    let d = tmp.path();
    git(d, &["init", "-q", "--bare"], b"");
    let t0 = one_file_tree(d, "a.txt", b"a\n");
    let base = format!("tree {t0}\nauthor {OK_IDENT}\ncommitter {OK_IDENT}\n\nbase\n");
    let base = put(d, "commit", base.as_bytes());
    let t1 = one_file_tree(d, name, body);
    let head = format!("tree {t1}\nparent {base}\nauthor {ident}\ncommitter {OK_IDENT}\n\nhead\n");
    let head = put(d, "commit", head.as_bytes());
    git(d, &["update-ref", "refs/heads/main", &head], b"");
    (tmp, base, head)
}

#[test]
fn many_malformed_author_lines_push_without_hanging() {
    // Every malformed line is a line on index-pack's stderr unless the check is ignored; with
    // stdin written before stderr is drained, ~560 of them filled the pipe and hung the push.
    let tmp = tempfile::tempdir().unwrap();
    let d = tmp.path();
    git(d, &["init", "-q", "--bare"], b"");
    let tree = one_file_tree(d, "a.txt", b"a\n");
    let mut tip = String::new();
    for i in 0..1500 {
        let parent = if tip.is_empty() {
            String::new()
        } else {
            format!("parent {tip}\n")
        };
        let text = format!(
            "tree {tree}\n{parent}author S <s@k> {i} +051800\ncommitter S <s@k>{i} +051800\n\nc{i}\n"
        );
        tip = put(d, "commit", text.as_bytes());
    }
    let repo = d.to_path_buf();
    let (tx, rx) = std::sync::mpsc::channel();
    let head = tip.clone();
    std::thread::spawn(move || {
        let _ = tx.send(
            forge_core::pack::build_pack(&repo, &[&head], &[]).map(|p| p.parsed.object_count()),
        );
    });
    let built = rx
        .recv_timeout(std::time::Duration::from_secs(60))
        .expect("build_pack hung on a history with many malformed author lines");
    assert!(built.unwrap() >= 1500);
}

#[test]
fn malformed_author_lines_push() {
    for ident in [
        "Shrikant <s@k> 1313584730 +051800",
        "A <a@b>1313584730 +0000",
        "A <a@b> 01313584730 +0000",
    ] {
        let (tmp, base, head) = history("a.txt", b"b\n", ident);
        // Whole history, and the delta over a base the remote has (both candidates built).
        for bases in [vec![], vec![base.as_str()]] {
            forge_core::pack::build_pack(tmp.path(), &[&head], &bases)
                .unwrap_or_else(|e| panic!("{ident} ({} bases): {e}", bases.len()));
        }
    }
}

#[test]
fn history_no_clone_takes_is_refused_before_it_is_stored() {
    let gitmodules: &[u8] =
        b"[submodule \"x\"]\n\tpath = x\n\turl = --upload-pack=touch /tmp/pwn\n";
    for (label, check, name, body) in [
        ("a .git look-alike", "hasDotgit", ".GIT", &b"x\n"[..]),
        (
            "a .gitmodules url that is an option",
            "gitmodulesUrl",
            ".gitmodules",
            gitmodules,
        ),
    ] {
        let (tmp, base, head) = history(name, body, OK_IDENT);
        for bases in [vec![], vec![base.as_str()]] {
            let Err(err) = forge_core::pack::build_pack(tmp.path(), &[&head], &bases) else {
                panic!("{label} was packed");
            };
            let forge_core::Error::User(u) = &err else {
                panic!("{label}: not a user error: {err}");
            };
            assert_eq!(u.code, codes::OBJECT_REFUSED, "{label}");
            assert!(u.to_string().contains(check), "{label}: {u}");
        }
    }
}
