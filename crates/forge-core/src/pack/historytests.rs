//! History index tests against real `git` repositories: the one-pass `git log` computation
//! must agree with a brute-force walk that implements the web's rule tree by tree (newest
//! first-parent commit whose `mode:oid` at the path differs from its first parent's), across
//! merges, renames, deletes, mode changes, gitlinks and directories.

use super::historyindex::{compute, parse_commit_meta, HistoryIndex, SUBJECT_MAX};
use std::collections::BTreeMap;
use std::path::Path;
use std::process::{Command, Stdio};
use tempfile::TempDir;

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
        .stdin(Stdio::null())
        .output()
        .expect("spawn git");
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

/// Commit everything with author date 1_700_000_000 + `when` (seconds).
fn commit(dir: &Path, msg: &str, when: u64) {
    git(dir, &["add", "-A"]);
    commit_index(dir, msg, when);
}

/// Commit the index as it stands (a gitlink added with `update-index` has no work tree entry,
/// so `add -A` would drop it).
fn commit_index(dir: &Path, msg: &str, when: u64) {
    let date = format!("@{} +0000", 1_700_000_000 + when);
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(["commit", "-q", "--allow-empty", "-m", msg])
        .env("GIT_AUTHOR_NAME", "t")
        .env("GIT_AUTHOR_EMAIL", "t@e.x")
        .env("GIT_COMMITTER_NAME", "t")
        .env("GIT_COMMITTER_EMAIL", "t@e.x")
        .env("GIT_AUTHOR_DATE", &date)
        .env("GIT_COMMITTER_DATE", &date)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
}

fn write(dir: &Path, path: &str, body: &str) {
    let p = dir.join(path);
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, body).unwrap();
}

/// A history with every shape the column has to get right.
fn fixture() -> TempDir {
    let d = TempDir::new().unwrap();
    let p = d.path();
    git(p, &["init", "-q", "-b", "main"]);
    write(p, "README.md", "hi");
    write(p, "src/a.rs", "1");
    write(p, "src/deep/b.rs", "1");
    write(p, "docs/old.md", "old");
    write(p, "untouched.txt", "same");
    commit(p, "initial\n\nbody line", 1_000);
    // A side branch merged with --no-ff: the merge brings src/deep/c.rs in.
    git(p, &["checkout", "-q", "-b", "side"]);
    write(p, "src/deep/c.rs", "side");
    commit(p, "side: add c", 2_000);
    git(p, &["checkout", "-q", "main"]);
    write(p, "README.md", "hello");
    commit(p, "edit readme", 3_000);
    let out = Command::new("git")
        .arg("-C")
        .arg(p)
        .args(["merge", "-q", "--no-ff", "side", "-m", "Merge side"])
        .env("GIT_AUTHOR_NAME", "t")
        .env("GIT_AUTHOR_EMAIL", "t@e.x")
        .env("GIT_COMMITTER_NAME", "t")
        .env("GIT_COMMITTER_EMAIL", "t@e.x")
        .env("GIT_AUTHOR_DATE", "@1700004000 +0000")
        .env("GIT_COMMITTER_DATE", "@1700004000 +0000")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .output()
        .unwrap();
    assert!(out.status.success());
    // A rename (delete + add), a delete, a mode change and a gitlink.
    git(p, &["mv", "docs/old.md", "docs/new.md"]);
    commit(p, "rename old to new", 5_000);
    std::fs::remove_file(p.join("src/a.rs")).unwrap();
    commit(p, "delete a", 6_000);
    {
        use std::os::unix::fs::PermissionsExt as _;
        let perms = std::fs::Permissions::from_mode(0o755);
        std::fs::set_permissions(p.join("src/deep/b.rs"), perms).unwrap();
    }
    commit(p, "chmod b", 7_000);
    let head = git(p, &["rev-parse", "HEAD"]);
    git(
        p,
        &["update-index", "--add", "--cacheinfo", &format!("160000,{head},vendor/sub")],
    );
    commit_index(p, "add gitlink", 8_000);
    commit_index(p, "empty commit", 9_000);
    d
}

/// `path → mode:oid` of every entry (files, gitlinks, directories) of a commit's tree.
fn tree_entries(dir: &Path, rev: &str) -> BTreeMap<String, String> {
    git(dir, &["ls-tree", "-r", "-t", rev])
        .lines()
        .filter(|l| !l.is_empty())
        .map(|l| {
            let (meta, path) = l.split_once('\t').unwrap();
            let mut f = meta.split(' ');
            let (mode, _, oid) = (f.next().unwrap(), f.next(), f.next().unwrap());
            (path.to_string(), format!("{mode}:{oid}"))
        })
        .collect()
}

/// The web's rule, brute force: walk first-parent, compare each path's `mode:oid`.
fn reference(dir: &Path, tip: &str) -> BTreeMap<String, String> {
    let chain: Vec<String> = git(dir, &["rev-list", "--first-parent", tip])
        .lines()
        .map(str::to_string)
        .collect();
    let paths = tree_entries(dir, tip);
    let mut out = BTreeMap::new();
    for (i, c) in chain.iter().enumerate() {
        let here = tree_entries(dir, c);
        let there = chain
            .get(i + 1)
            .map(|p| tree_entries(dir, p))
            .unwrap_or_default();
        for path in paths.keys() {
            if !out.contains_key(path) && here.get(path) != there.get(path) {
                out.insert(path.clone(), c.clone());
            }
        }
    }
    out
}

fn as_map(ix: &HistoryIndex) -> BTreeMap<String, String> {
    ix.paths
        .iter()
        .map(|(p, &c)| {
            (
                String::from_utf8(p.clone()).unwrap(),
                hex::encode(ix.commits[c as usize].oid),
            )
        })
        .collect()
}

#[test]
fn matches_the_tree_by_tree_rule_across_merges_renames_deletes_and_directories() {
    let d = fixture();
    let p = d.path();
    let ix = compute(p, "HEAD", None).unwrap().unwrap();
    let want = reference(p, "HEAD");
    assert_eq!(as_map(&ix), want);
    // Spot checks that say what the rule means.
    let subject = |path: &str| {
        ix.last_change(path.as_bytes())
            .map(|c| c.subject.clone())
            .unwrap()
    };
    assert_eq!(subject("README.md"), "edit readme");
    // The merge is what brought c.rs into main (first-parent), not the side commit.
    assert_eq!(subject("src/deep/c.rs"), "Merge side");
    // A directory's commit is its newest change anywhere below it.
    assert_eq!(subject("src/deep"), "chmod b");
    assert_eq!(subject("src"), "chmod b");
    assert_eq!(subject("docs/new.md"), "rename old to new");
    assert_eq!(subject("vendor/sub"), "add gitlink");
    assert_eq!(subject("untouched.txt"), "initial");
    // Deleted paths are not in the tip, so not in the index.
    assert!(ix.last_change(b"src/a.rs").is_none());
    assert!(ix.last_change(b"docs/old.md").is_none());
    // The author time comes with the commit, in seconds.
    assert_eq!(ix.last_change(b"README.md").unwrap().author_time, 1_700_003_000);
}

#[test]
fn counts_every_commit_and_the_first_parent_chain() {
    let d = fixture();
    let p = d.path();
    let ix = compute(p, "HEAD", None).unwrap().unwrap();
    assert_eq!(
        ix.commit_count,
        git(p, &["rev-list", "--count", "HEAD"]).parse::<u64>().unwrap()
    );
    assert_eq!(
        ix.first_parent_count,
        git(p, &["rev-list", "--first-parent", "--count", "HEAD"])
            .parse::<u64>()
            .unwrap()
    );
    // 9 commits in all; the side commit is not on the first-parent chain.
    assert_eq!((ix.commit_count, ix.first_parent_count), (9, 8));
    assert_eq!((ix.root_time, ix.tip_time), (1_700_001_000, 1_700_009_000));
}

#[test]
fn round_trips_and_refuses_damaged_bytes() {
    let d = fixture();
    let ix = compute(d.path(), "HEAD", None).unwrap().unwrap();
    let bytes = ix.to_compressed().unwrap();
    assert_eq!(HistoryIndex::parse(&bytes).unwrap(), ix);
    // Truncated or trailing bytes, inside the gzip.
    let mut body = Vec::new();
    std::io::Read::read_to_end(&mut flate2::read::GzDecoder::new(&bytes[..]), &mut body).unwrap();
    let gz = |b: &[u8]| {
        let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        std::io::Write::write_all(&mut e, b).unwrap();
        e.finish().unwrap()
    };
    assert!(HistoryIndex::parse(&gz(&body[..body.len() - 1])).is_err());
    let mut longer = body.clone();
    longer.push(0);
    assert!(HistoryIndex::parse(&gz(&longer)).is_err());
    let mut wrong = body;
    wrong[0] = b'X';
    assert!(HistoryIndex::parse(&gz(&wrong)).is_err());
}

#[test]
fn a_delta_lists_only_what_changed_since_its_base_and_agrees_with_a_full_index() {
    let d = fixture();
    let p = d.path();
    let base_tip = git(p, &["rev-parse", "HEAD"]);
    write(p, "README.md", "again");
    write(p, "src/deep/new.rs", "n");
    commit(p, "second round", 10_000);
    let delta = compute(p, "HEAD", Some(&base_tip)).unwrap().unwrap();
    let got: Vec<String> = as_map(&delta).into_keys().collect();
    assert_eq!(got, ["README.md", "src", "src/deep", "src/deep/new.rs"]);
    // Base overlaid with the delta answers every path of the new tip as a full index does.
    let base = compute(p, &base_tip, None).unwrap().unwrap();
    let full = compute(p, "HEAD", None).unwrap().unwrap();
    let mut merged = as_map(&base);
    merged.extend(as_map(&delta));
    merged.retain(|k, _| full.paths.contains_key(k.as_bytes()));
    assert_eq!(merged, as_map(&full));
    assert_eq!(delta.commit_count, full.commit_count);
}

#[test]
fn a_base_off_the_first_parent_chain_gives_no_delta() {
    let d = fixture();
    let p = d.path();
    let side = git(p, &["rev-parse", "side"]);
    // `side` is an ancestor of HEAD, but through the merge's second parent.
    assert!(compute(p, "HEAD", Some(&side)).unwrap().is_none());
}

#[test]
fn subjects_are_the_first_trimmed_line_clipped_at_a_char_boundary() {
    let (t, s) = parse_commit_meta(b"tree x\nauthor A <a@b> 1700000000 +0000\n\n  Fix it  \nmore\n");
    assert_eq!((t, s.as_str()), (1_700_000_000, "Fix it"));
    let long = format!("tree x\nauthor A <a@b> 5 +0000\n\n{}", "é".repeat(150));
    let (_, s) = parse_commit_meta(long.as_bytes());
    assert!(s.len() <= SUBJECT_MAX && s.chars().all(|c| c == 'é'));
    // No author date: 0 (unknown), as the web reads it.
    assert_eq!(parse_commit_meta(b"tree x\nauthor A <a@b>\n\nm").0, 0);
}

#[test]
fn an_option_like_tip_is_refused() {
    let d = fixture();
    assert!(compute(d.path(), "--all", None).is_err());
    assert!(compute(d.path(), "HEAD", Some("-x")).is_err());
}
