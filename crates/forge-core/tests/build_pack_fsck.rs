//! A push is checked as a clone checks a fetch (`forge_core::pack::fsck`): history with the
//! malformed author lines real repositories carry (psf/requests' `+051800` time zone, an ident
//! with no space before the date) builds a pack, and history no clone would take — a `.git`
//! look-alike, a `.gitmodules` whose URL is an option — is refused as E511 before anything is
//! stored.

use std::path::Path;
use std::process::{Command, Stdio};

use std::io::Write as _;

use forge_core::user_error::codes;

fn git(dir: &Path, args: &[&str], stdin: Option<&[u8]>) -> String {
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
    child
        .stdin
        .take()
        .unwrap()
        .write_all(stdin.unwrap_or_default())
        .unwrap();
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
        Some(body),
    )
}

fn entry(mode: &str, name: &str, oid: &str) -> Vec<u8> {
    let mut e = format!("{mode} {name}\0").into_bytes();
    e.extend(hex::decode(oid).unwrap());
    e
}

/// A repo whose `main` is `base` (well-formed) then one commit with `tree_entries` and `ident`
/// as its author; returns (repo, base, head).
fn history(
    tree_entries: impl Fn(&Path) -> Vec<u8>,
    ident: &str,
) -> (tempfile::TempDir, String, String) {
    let tmp = tempfile::tempdir().unwrap();
    let d = tmp.path();
    git(d, &["init", "-q", "--bare"], None);
    let ok = "A <a@b> 1313584730 +0000";
    let t0 = put(
        d,
        "tree",
        &entry("100644", "a.txt", &put(d, "blob", b"a\n")),
    );
    let base = put(
        d,
        "commit",
        format!("tree {t0}\nauthor {ok}\ncommitter {ok}\n\nbase\n").as_bytes(),
    );
    let t1 = put(d, "tree", &tree_entries(d));
    let head = put(
        d,
        "commit",
        format!("tree {t1}\nparent {base}\nauthor {ident}\ncommitter {ok}\n\nhead\n").as_bytes(),
    );
    git(d, &["update-ref", "refs/heads/main", &head], None);
    (tmp, base, head)
}

fn file(d: &Path) -> Vec<u8> {
    entry("100644", "a.txt", &put(d, "blob", b"b\n"))
}

#[test]
fn malformed_author_lines_push() {
    for ident in [
        "Shrikant <s@k> 1313584730 +051800",
        "A <a@b>1313584730 +0000",
        "A <a@b> 01313584730 +0000",
    ] {
        let (tmp, base, head) = history(file, ident);
        // Whole history, and the delta over a base the remote has (both candidates built).
        for bases in [vec![], vec![base.as_str()]] {
            forge_core::pack::build_pack(tmp.path(), &[&head], &bases)
                .unwrap_or_else(|e| panic!("{ident} ({} bases): {e}", bases.len()));
        }
    }
}

#[test]
fn history_no_clone_takes_is_refused_before_it_is_stored() {
    let dot_git = |d: &Path| entry("100644", ".GIT", &put(d, "blob", b"x\n"));
    let gitmodules = |d: &Path| {
        let body = b"[submodule \"x\"]\n\tpath = x\n\turl = --upload-pack=touch /tmp/pwn\n";
        entry("100644", ".gitmodules", &put(d, "blob", body))
    };
    let ok = "A <a@b> 1313584730 +0000";
    for (label, check, tree) in [
        (
            "a .git look-alike",
            "hasDotgit",
            &dot_git as &dyn Fn(&Path) -> Vec<u8>,
        ),
        (
            "a .gitmodules url that is an option",
            "gitmodulesUrl",
            &gitmodules,
        ),
    ] {
        let (tmp, base, head) = history(tree, ok);
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
