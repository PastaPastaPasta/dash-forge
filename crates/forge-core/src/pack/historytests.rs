//! History index tests against real `git` repositories: the one-pass `git log` computation
//! must agree with a brute-force walk that implements the web's rule tree by tree (newest
//! first-parent commit whose `mode:oid` at the path differs from its first parent's), across
//! merges, renames, deletes, mode changes, gitlinks and directories.

use super::historyindex::{
    compute, compute_with, overlay_versions, parse_commit_meta, HistoryIndex, IndexedCommit,
    PathVersion, ResolvedList, VersionList, Versions, OID_PREFIX_LEN, SUBJECT_MAX,
    VERSIONS_PER_PATH,
};
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
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
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
    // The mode change in the index alone (every platform; `add -A` would reset it from a work
    // tree without an executable bit).
    git(p, &["update-index", "--chmod=+x", "src/deep/b.rs"]);
    commit_index(p, "chmod b", 7_000);
    // Bring the work tree to the index's mode, so a later `add -A` does not revert it (where
    // the file system has no executable bit, `core.fileMode` is off and git keeps the index's).
    git(p, &["checkout", "--", "src/deep/b.rs"]);
    let head = git(p, &["rev-parse", "HEAD"]);
    git(
        p,
        &[
            "update-index",
            "--add",
            "--cacheinfo",
            &format!("160000,{head},vendor/sub"),
        ],
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
    assert_eq!(
        ix.last_change(b"README.md").unwrap().author_time,
        1_700_003_000
    );
}

#[test]
fn counts_every_commit_and_the_first_parent_chain() {
    let d = fixture();
    let p = d.path();
    let ix = compute(p, "HEAD", None).unwrap().unwrap();
    assert_eq!(
        ix.commit_count,
        git(p, &["rev-list", "--count", "HEAD"])
            .parse::<u64>()
            .unwrap()
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
    // A later version's extension section is skipped; a torn one is refused.
    let mut extended = body.clone();
    extended[4] = 2;
    extended.extend_from_slice(&[7, 3, 0xaa, 0xbb, 0xcc]);
    assert_eq!(HistoryIndex::parse(&gz(&extended)).unwrap(), ix);
    let mut torn = body.clone();
    torn.extend_from_slice(&[7, 3, 0xaa]);
    assert!(HistoryIndex::parse(&gz(&torn)).is_err());
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
    let m = parse_commit_meta(b"tree x\nauthor A B <a@b> 1700000000 +0000\n\n  Fix it  \nmore\n");
    assert_eq!(
        (m.author_time, m.subject.as_str(), m.author.as_str()),
        (1_700_000_000, "Fix it", "A B")
    );
    let long = format!("tree x\nauthor A <a@b> 5 +0000\n\n{}", "é".repeat(150));
    let s = parse_commit_meta(long.as_bytes()).subject;
    assert!(s.len() <= SUBJECT_MAX && s.chars().all(|c| c == 'é'));
    // No author date: 0 (unknown), as the web reads it.
    assert_eq!(
        parse_commit_meta(b"tree x\nauthor A <a@b>\n\nm").author_time,
        0
    );
    // The name as the web's `parseIdent` reads it: the whole line when there is no `<…>`.
    assert_eq!(
        parse_commit_meta(b"tree x\nauthor Nobody\n\nm").author,
        "Nobody"
    );
    assert_eq!(parse_commit_meta(b"tree x\nauthor A <>\n\nm").author, "A");
    assert_eq!(parse_commit_meta(b"tree x\nauthor A <\n\nm").author, "A <");
}

#[test]
fn an_option_like_tip_is_refused() {
    let d = fixture();
    assert!(compute(d.path(), "--all", None).is_err());
    assert!(compute(d.path(), "HEAD", Some("-x")).is_err());
}

/// The shared fixture forge-web's decoder reads (`forge-web/lib/browse/history-index.test.ts`):
/// a hand-built index with a delta base, a multi-byte subject and front-coded paths. The bytes
/// are the body before gzip (gzip output is not byte-stable across implementations).
/// `FORGE_BLESS=1` rewrites it.
#[test]
fn the_shared_decoder_fixture_matches() {
    let ix = HistoryIndex {
        tip: [0xab; 20],
        base: Some([0x5c; 32]),
        commit_count: 33_553,
        first_parent_count: 7_979,
        root_time: 1_325_376_000,
        tip_time: 1_790_000_000,
        commits: vec![
            IndexedCommit {
                oid: [0x01; 20],
                author_time: 1_700_000_000,
                subject: "Merge #1234: refactor: tidy the wallet".into(),
                author: String::new(),
            },
            IndexedCommit {
                oid: [0x02; 20],
                author_time: 1_600_000_000,
                subject: "docs: naïve résumé ✓".into(),
                author: String::new(),
            },
        ],
        paths: [
            (b"src".to_vec(), 0),
            (b"src/wallet".to_vec(), 0),
            (b"src/wallet/db.cpp".to_vec(), 0),
            (b"src/walletx.h".to_vec(), 1),
            (b"README.md".to_vec(), 1),
        ]
        .into_iter()
        .collect(),
        versions: None,
    };
    bless_or_check("history-index.hex", &body_of(&ix));
    assert_eq!(
        HistoryIndex::parse(&ix.to_compressed().unwrap()).unwrap(),
        ix
    );
}

/// Size and price of a real repository's history index (docs/guides/costs.md): run with
/// `HISTORY_MEASURE_REPO=<git dir> HISTORY_MEASURE_TIP=<rev> cargo test -p forge-core --lib
/// measure_a_real_repository -- --ignored --nocapture`.
#[test]
#[ignore = "measures a local repository named in the environment"]
fn measure_a_real_repository() {
    let repo = std::env::var("HISTORY_MEASURE_REPO").expect("HISTORY_MEASURE_REPO");
    let tip = std::env::var("HISTORY_MEASURE_TIP").unwrap_or_else(|_| "HEAD".into());
    let t = std::time::Instant::now();
    let ix = compute(Path::new(&repo), &tip, None).unwrap().unwrap();
    let elapsed = t.elapsed();
    let bytes = ix.to_compressed().unwrap();
    let credits = crate::cost::push_fees::history_index(bytes.len() as u64, false, 0, true, true);
    let byo = crate::cost::push_fees::history_index(bytes.len() as u64, false, 1, false, true);
    println!(
        "MEASURE repo={repo} tip={} paths={} commits={} (first-parent {}) referenced={} \
         gz_bytes={} chunks={} platform_credits={credits} byo_credits={byo} compute_ms={}",
        hex::encode(ix.tip),
        ix.paths.len(),
        ix.commit_count,
        ix.first_parent_count,
        ix.commits.len(),
        bytes.len(),
        crate::pack::split(&bytes).len(),
        elapsed.as_millis()
    );
}

/// A delta's size on a real repository: the index of `HISTORY_MEASURE_TIP` over a full index of
/// `HISTORY_MEASURE_BASE` (a first-parent ancestor).
#[test]
#[ignore = "measures a local repository named in the environment"]
fn measure_a_real_delta() {
    let repo = std::env::var("HISTORY_MEASURE_REPO").expect("HISTORY_MEASURE_REPO");
    let tip = std::env::var("HISTORY_MEASURE_TIP").unwrap_or_else(|_| "HEAD".into());
    let base = std::env::var("HISTORY_MEASURE_BASE").expect("HISTORY_MEASURE_BASE");
    let d = compute(Path::new(&repo), &tip, Some(&base))
        .unwrap()
        .unwrap();
    let bytes = d.to_compressed().unwrap();
    println!(
        "MEASURE delta base={base} paths={} gz_bytes={} platform_credits={}",
        d.paths.len(),
        bytes.len(),
        crate::cost::push_fees::history_index(bytes.len() as u64, false, 0, true, false)
    );
}

/// Review M5: a shallow clone's history stops at its boundary: refused, not indexed wrong.
#[test]
fn a_shallow_clone_is_refused() {
    let d = fixture();
    let shallow = TempDir::new().unwrap();
    let src = format!("file://{}", d.path().display());
    let out = Command::new("git")
        .args(["clone", "-q", "--depth", "2", &src])
        .arg(shallow.path().join("s"))
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let err = compute(&shallow.path().join("s"), "HEAD", None).unwrap_err();
    assert!(format!("{err}").contains("shallow"), "{err}");
}

/// Review M5: a replace ref does not change what the index describes: it reads the real
/// object graph, the one the pushed packs hold.
#[test]
fn replace_refs_are_ignored() {
    let d = fixture();
    let p = d.path();
    let before = compute(p, "HEAD", None).unwrap().unwrap();
    // Replace the tip's parent with the root commit: `git log` would skip most of history.
    let parent = git(p, &["rev-parse", "HEAD~1"]);
    let root = git(p, &["rev-list", "--max-parents=0", "HEAD"]);
    git(p, &["replace", &parent, &root]);
    let after = compute(p, "HEAD", None).unwrap().unwrap();
    assert_eq!(after, before);
}

/// Review N4: an `info/grafts` file rewrites parents as a shallow boundary does: refused.
#[test]
fn a_grafted_repository_is_refused() {
    let d = fixture();
    let p = d.path();
    let head = git(p, &["rev-parse", "HEAD"]);
    std::fs::create_dir_all(p.join(".git/info")).unwrap();
    std::fs::write(p.join(".git/info/grafts"), format!("{head}\n")).unwrap();
    let err = compute(p, "HEAD", None).unwrap_err();
    assert!(format!("{err}").contains("grafts"), "{err}");
}

/// Review L1: the log is read as it streams and git is stopped once every path is settled; a
/// long history of commits that touch nothing the tip has left does not change the answer.
#[test]
fn a_long_tail_of_old_history_is_not_read_to_its_end() {
    let d = TempDir::new().unwrap();
    let p = d.path();
    git(p, &["init", "-q", "-b", "main"]);
    for i in 0..300 {
        write(p, "old.txt", &format!("{i}"));
        commit(p, &format!("old {i}"), i);
    }
    std::fs::remove_file(p.join("old.txt")).unwrap();
    write(p, "new.txt", "n");
    commit(p, "replace old with new", 1_000);
    let ix = compute(p, "HEAD", None).unwrap().unwrap();
    assert_eq!(as_map(&ix), reference(p, "HEAD"));
    assert_eq!(ix.commit_count, 301);
}

/// Review L2 / L4: a gzip bomb stops at the size cap; a varint past 64 bits is refused.
#[test]
fn hostile_bytes_are_bounded() {
    let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::best());
    std::io::Write::write_all(&mut e, &[0u8; 4097]).unwrap();
    let bomb = e.finish().unwrap();
    let err = HistoryIndex::parse_bounded(&bomb, 4096).unwrap_err();
    assert!(format!("{err}").contains("size limit"), "{err}");
    assert_eq!(super::historyindex::MAX_INFLATED, 64 * 1024 * 1024);
    // "DFHI" v1, a tip, a zero base, then a commitCount varint of 11 continuation bytes.
    let mut body = b"DFHI\x01".to_vec();
    body.extend_from_slice(&[0; 52]);
    body.extend_from_slice(&[0xff; 9]);
    body.push(0x02);
    let err = HistoryIndex::parse(&gz(&body)).unwrap_err();
    assert!(format!("{err}").contains("overflow"), "{err}");
}

// ---- v2: per-path version lists ---------------------------------------------------------

/// `path → (commit, mode, oid)` of each change, newest first, and whether the list reached the
/// commit that added the path: the web's rule brute force, tree by tree over the first-parent
/// chain, at most `limit` changes.
type RefLists = BTreeMap<String, (Vec<(String, String, String)>, bool)>;

fn reference_lists(dir: &Path, tip: &str, limit: usize) -> RefLists {
    let chain: Vec<String> = git(dir, &["rev-list", "--first-parent", tip])
        .lines()
        .map(str::to_string)
        .collect();
    let trees: Vec<BTreeMap<String, String>> = chain.iter().map(|c| tree_entries(dir, c)).collect();
    let mut out = RefLists::new();
    for path in trees[0].keys() {
        let mut list = Vec::new();
        let mut complete = false;
        for (i, c) in chain.iter().enumerate() {
            let here = trees[i].get(path);
            let there = trees.get(i + 1).and_then(|t| t.get(path));
            if here == there {
                continue;
            }
            let (mode, oid) = here
                .expect("a listed path is present")
                .split_once(':')
                .unwrap();
            list.push((c.clone(), mode.to_string(), oid.to_string()));
            if there.is_none() {
                complete = true;
                break;
            }
            if list.len() == limit {
                break;
            }
        }
        out.insert(path.clone(), (list, complete));
    }
    out
}

/// The index's lists in the reference's shape (oids as the stored prefixes).
fn lists_of(ix: &HistoryIndex) -> RefLists {
    resolved_as_ref(&ix.resolved_versions().expect("a v2 index"))
}

fn resolved_as_ref(r: &BTreeMap<Vec<u8>, ResolvedList>) -> RefLists {
    r.iter()
        .map(|(p, l)| {
            let versions = l
                .versions
                .iter()
                .map(|(c, mode, oid)| (hex::encode(c), format!("{mode:06o}"), hex::encode(oid)))
                .collect();
            (
                String::from_utf8(p.clone()).unwrap(),
                (versions, l.complete),
            )
        })
        .collect()
}

/// The reference with each blob oid cut to the stored prefix (and none for trees and gitlinks).
fn as_stored(mut r: RefLists) -> RefLists {
    for (list, _) in r.values_mut() {
        for (_, mode, oid) in list.iter_mut() {
            *oid = if mode == "040000" || mode == "160000" {
                String::new()
            } else {
                oid[..usize::from(OID_PREFIX_LEN) * 2].to_string()
            };
        }
    }
    r
}

/// The fixture, then a delete and re-add, a file that becomes a directory, and a run of edits
/// to one file.
fn fixture_v2() -> TempDir {
    let d = fixture();
    let p = d.path();
    git(p, &["rm", "-q", "docs/new.md"]);
    commit_index(p, "drop new", 10_000);
    write(p, "docs/new.md", "back again");
    commit_paths(p, &["docs/new.md"], "bring new back", 11_000);
    write(p, "kind", "a file");
    commit_paths(p, &["kind"], "kind is a file", 12_000);
    git(p, &["rm", "-q", "kind"]);
    write(p, "kind/inner.txt", "now a directory");
    commit_paths(p, &["kind/inner.txt"], "kind is a directory", 13_000);
    for i in 0..6 {
        write(p, "hot.txt", &format!("edit {i}"));
        commit_paths(p, &["hot.txt"], &format!("hot {i}"), 14_000 + i);
    }
    d
}

/// Stage `paths` alone and commit (`add -A` would drop the fixture's gitlink, which has no work
/// tree directory).
fn commit_paths(dir: &Path, paths: &[&str], msg: &str, when: u64) {
    let mut args = vec!["add", "--"];
    args.extend_from_slice(paths);
    git(dir, &args);
    commit_index(dir, msg, when);
}

#[test]
fn version_lists_match_the_tree_by_tree_rule_and_git_log_first_parent() {
    let d = fixture_v2();
    let p = d.path();
    let ix = compute(p, "HEAD", None).unwrap().unwrap();
    assert_eq!(ix.version(), 2);
    let want = reference_lists(p, "HEAD", VERSIONS_PER_PATH as usize);
    assert_eq!(lists_of(&ix), as_stored(want.clone()));
    // `git log --first-parent -- <path>` names the same commits, up to the one that added the
    // path (git's log goes on past a delete and re-add; History stops at the newest add).
    for (path, (list, complete)) in &want {
        let log: Vec<String> = git(
            p,
            &["log", "--first-parent", "--format=%H", "HEAD", "--", path],
        )
        .lines()
        .map(str::to_string)
        .collect();
        let ours: Vec<String> = list.iter().map(|v| v.0.clone()).collect();
        assert!(
            *complete,
            "{path}: every list is whole under the default limit"
        );
        assert_eq!(log[..ours.len()], ours[..], "{path}");
    }
    // What the lists mean, spelled out.
    let subjects = |path: &str| -> Vec<String> {
        ix.versions.as_ref().unwrap().lists[path.as_bytes()]
            .versions
            .iter()
            .map(|v| ix.commits[v.commit as usize].subject.clone())
            .collect()
    };
    // The merge brought c.rs in (first parent), and the list ends there.
    assert_eq!(subjects("src/deep/c.rs"), ["Merge side"]);
    assert_eq!(subjects("README.md"), ["edit readme", "initial"]);
    // Deleted and added again: History stops at the newest add.
    assert_eq!(subjects("docs/new.md"), ["bring new back"]);
    // A path that was a file and is now a directory: the type change is one change.
    assert_eq!(subjects("kind"), ["kind is a directory", "kind is a file"]);
    let kind = &ix.versions.as_ref().unwrap().lists[b"kind".as_slice()];
    assert_eq!(kind.versions[0].mode, 0o40000);
    assert!(kind.versions[0].oid.is_empty(), "no oid for a tree");
    assert_eq!(kind.versions[1].oid.len(), usize::from(OID_PREFIX_LEN));
    // A mode change is a version; the gitlink's list carries no oid.
    assert_eq!(subjects("src/deep/b.rs"), ["chmod b", "initial"]);
    let sub = &ix.versions.as_ref().unwrap().lists[b"vendor/sub".as_slice()];
    assert_eq!(
        (sub.versions[0].mode, sub.versions[0].oid.len()),
        (0o160_000, 0)
    );
    // Each version's prefix is its blob's oid.
    let readme = &ix.versions.as_ref().unwrap().lists[b"README.md".as_slice()];
    let first = hex::encode(ix.commits[readme.versions[0].commit as usize].oid);
    let blob = git(p, &["rev-parse", &format!("{first}:README.md")]);
    assert!(blob.starts_with(&hex::encode(&readme.versions[0].oid)));
    // Authors come with the commits.
    assert!(ix.commits.iter().all(|c| c.author == "t"));
    // The column is each list's head.
    for (path, &c) in &ix.paths {
        let list = &ix.versions.as_ref().unwrap().lists[path];
        assert_eq!(list.versions[0].commit, c);
    }
    assert_eq!(
        HistoryIndex::parse(&ix.to_compressed().unwrap()).unwrap(),
        ix
    );
}

#[test]
fn a_list_stops_at_its_limit_and_says_it_is_not_whole() {
    let d = fixture_v2();
    let p = d.path();
    let ix = compute_with(p, "HEAD", None, 3).unwrap().unwrap();
    assert_eq!(lists_of(&ix), as_stored(reference_lists(p, "HEAD", 3)));
    let hot = &ix.versions.as_ref().unwrap().lists[b"hot.txt".as_slice()];
    assert_eq!((hot.versions.len(), hot.complete), (3, false));
    let readme = &ix.versions.as_ref().unwrap().lists[b"README.md".as_slice()];
    assert_eq!((readme.versions.len(), readme.complete), (2, true));
    assert_eq!(ix.versions.as_ref().unwrap().limit, 3);
}

/// The merge rule for a delta over its full base (the web's `overlayHistory`), against git: the
/// base's lists overlaid with the delta's equal a full index of the delta's tip. Writes the three
/// bodies the web's overlay test reads (`FORGE_BLESS=1` rewrites them).
#[test]
fn a_delta_overlaid_on_its_base_equals_a_full_index_and_the_web_fixtures_match() {
    let d = fixture_v2();
    let p = d.path();
    let base_tip = git(p, &["rev-parse", "HEAD"]);
    write(p, "README.md", "third");
    commit_paths(p, &["README.md"], "readme again", 20_000);
    write(p, "README.md", "fourth");
    commit_paths(p, &["README.md"], "and again", 21_000);
    git(p, &["rm", "-q", "docs/new.md"]);
    commit_index(p, "drop new once more", 22_000);
    write(p, "docs/new.md", "and back");
    commit_paths(p, &["docs/new.md"], "bring new back once more", 23_000);
    write(p, "fresh.txt", "new");
    commit_paths(p, &["fresh.txt"], "add fresh", 24_000);
    git(p, &["rm", "-q", "untouched.txt"]);
    commit_index(p, "drop untouched", 25_000);
    let limit = 3;
    let base = compute_with(p, &base_tip, None, limit).unwrap().unwrap();
    let mut delta = compute_with(p, "HEAD", Some(&base_tip), limit)
        .unwrap()
        .unwrap();
    delta.base = Some([0x5c; 32]);
    let full = compute_with(p, "HEAD", None, limit).unwrap().unwrap();
    let merged = overlay_versions(&base, &delta).unwrap();
    // A path the tip no longer has keeps its base list (the reader only asks for tip paths).
    let mut merged = resolved_as_ref(&merged);
    assert!(merged.contains_key("untouched.txt"));
    merged.retain(|k, _| full.paths.contains_key(k.as_bytes()));
    assert_eq!(merged, lists_of(&full));
    // README: two new edits over the base's two, cut to 3, so no longer whole.
    assert_eq!(merged["README.md"].0.len(), 3);
    assert!(!merged["README.md"].1);
    // docs/new.md was re-added in the delta: its list is the delta's alone.
    assert_eq!(merged["docs/new.md"].0.len(), 1);

    for (name, ix) in [("base", &base), ("delta", &delta), ("tip", &full)] {
        bless_or_check(&format!("history-index-v2-{name}.hex"), &body_of(ix));
    }
}

/// A v1 base or a v1 delta: what can be known is kept, what cannot is dropped.
#[test]
fn mixed_v1_and_v2_indexes_overlay_to_what_is_known() {
    let d = fixture_v2();
    let p = d.path();
    let base_tip = git(p, &["rev-parse", "HEAD"]);
    write(p, "README.md", "third");
    write(p, "fresh.txt", "new");
    commit_paths(p, &["README.md", "fresh.txt"], "edit and add", 20_000);
    let base = compute_with(p, &base_tip, None, 3).unwrap().unwrap();
    let delta = compute_with(p, "HEAD", Some(&base_tip), 3)
        .unwrap()
        .unwrap();
    let as_v1 = |ix: &HistoryIndex| HistoryIndex {
        versions: None,
        ..ix.clone()
    };
    // A v2 base under a v1 delta (an older writer's): the delta's paths changed, lists unknown.
    let got = overlay_versions(&base, &as_v1(&delta)).unwrap();
    assert!(delta.paths.keys().all(|p| !got.contains_key(p)));
    assert!(
        got.contains_key(b"docs/new.md".as_slice()),
        "unchanged: the base's list stands"
    );
    // A v1 base under a v2 delta: only the delta's lists, each as far as it goes.
    let got = overlay_versions(&as_v1(&base), &delta).unwrap();
    assert_eq!(got.len(), delta.paths.len());
    assert!(got[b"fresh.txt".as_slice()].complete);
    assert!(!got[b"README.md".as_slice()].complete);
    // Two v1 indexes: nothing.
    assert!(overlay_versions(&as_v1(&base), &as_v1(&delta)).is_none());
    // A v2 index read as v1 (its section dropped) keeps the column and the counts.
    let mut v1 = base.clone();
    v1.versions = None;
    for c in &mut v1.commits {
        c.author.clear();
    }
    let parsed = HistoryIndex::parse(&v1.to_compressed().unwrap()).unwrap();
    assert_eq!(parsed.version(), 1);
    assert_eq!(parsed, v1);
}

/// The hand-built v2 decoder fixture forge-web reads (`history-index.test.ts`): the v1 fixture's
/// index plus authors (one multi-byte) and lists with a directory, a whole list and a cut one.
#[test]
fn the_shared_v2_decoder_fixture_matches() {
    let commit = |b: u8, t: u64, subject: &str, author: &str| IndexedCommit {
        oid: [b; 20],
        author_time: t,
        subject: subject.into(),
        author: author.into(),
    };
    let v = |commit: u32, mode: u32, oid: &[u8]| PathVersion {
        commit,
        mode,
        oid: oid.to_vec(),
    };
    let ix = HistoryIndex {
        tip: [0xab; 20],
        base: None,
        commit_count: 33_553,
        first_parent_count: 7_979,
        root_time: 1_325_376_000,
        tip_time: 1_790_000_000,
        commits: vec![
            commit(
                0x01,
                1_700_000_000,
                "Merge #1234: refactor: tidy the wallet",
                "Wladimir J. van der Laan",
            ),
            commit(0x02, 1_600_000_000, "docs: naïve résumé ✓", "Zoë Ångström"),
            commit(0x03, 1_500_000_000, "init", "Wladimir J. van der Laan"),
        ],
        paths: [
            (b"README.md".to_vec(), 1),
            (b"src".to_vec(), 0),
            (b"src/wallet.cpp".to_vec(), 0),
        ]
        .into_iter()
        .collect(),
        versions: Some(Versions {
            limit: 2,
            oid_len: 6,
            lists: [
                (
                    b"README.md".to_vec(),
                    VersionList {
                        versions: vec![
                            v(1, 0o100_644, &[1, 2, 3, 4, 5, 6]),
                            v(2, 0o100_755, &[7; 6]),
                        ],
                        complete: true,
                    },
                ),
                (
                    b"src".to_vec(),
                    VersionList {
                        versions: vec![v(0, 0o40000, &[]), v(2, 0o40000, &[])],
                        complete: false,
                    },
                ),
                (
                    b"src/wallet.cpp".to_vec(),
                    VersionList {
                        versions: vec![v(0, 0o120_000, &[0xfe; 6])],
                        complete: false,
                    },
                ),
            ]
            .into_iter()
            .collect(),
        }),
    };
    bless_or_check("history-index-v2.hex", &body_of(&ix));
    assert_eq!(
        HistoryIndex::parse(&ix.to_compressed().unwrap()).unwrap(),
        ix
    );
}

/// An index's body before gzip (gzip output is not byte-stable across implementations).
fn body_of(ix: &HistoryIndex) -> Vec<u8> {
    let mut out = Vec::new();
    std::io::Read::read_to_end(
        &mut flate2::read::GzDecoder::new(&ix.to_compressed().unwrap()[..]),
        &mut out,
    )
    .unwrap();
    out
}

/// Check `body` against the hex fixture `name` forge-web also reads; `FORGE_BLESS=1` rewrites it.
fn bless_or_check(name: &str, body: &[u8]) {
    let path = format!(
        "{}/../../forge-contracts/fixtures/{name}",
        env!("CARGO_MANIFEST_DIR")
    );
    let hex_body = format!("{}\n", hex::encode(body));
    if std::env::var_os("FORGE_BLESS").is_some() {
        std::fs::write(&path, &hex_body).unwrap();
    }
    assert_eq!(
        std::fs::read_to_string(&path).unwrap_or_default(),
        hex_body,
        "{name}: run with FORGE_BLESS=1"
    );
}

fn gz(b: &[u8]) -> Vec<u8> {
    let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    std::io::Write::write_all(&mut e, b).unwrap();
    e.finish().unwrap()
}

/// Decode bounds of the versions section: every count, index and length is checked before it
/// is trusted, and nothing is allocated from a count that was not.
#[test]
fn hostile_version_sections_are_refused() {
    // A minimal v2 body: one commit, one path "a", then the section.
    let head = |section: &[u8]| {
        let mut b = b"DFHI\x02".to_vec();
        b.extend_from_slice(&[0; 52]);
        b.extend_from_slice(&[1, 1, 0, 0, 1]); // counts, times, nCommits = 1
        b.extend_from_slice(&[9; 20]);
        b.extend_from_slice(&[0, 0]); // authorTime, empty subject
        b.extend_from_slice(&[1, 0, 1, b'a', 0]); // nPaths = 1: "a" → commit 0
        b.push(1); // tag
        b.push(u8::try_from(section.len()).unwrap());
        b.extend_from_slice(section);
        b
    };
    // limit 4 | oidLen 6 | 1 author "x" | commit 0 → author 0 | "a": 1 version, whole, blob
    let good = [
        4, 6, 1, 1, b'x', 0, 3, 0, 0xa4, 0x83, 0x02, 1, 2, 3, 4, 5, 6,
    ];
    let ok = HistoryIndex::parse(&gz(&head(&good))).unwrap();
    let v = ok.versions.as_ref().unwrap();
    assert_eq!(v.lists[b"a".as_slice()].versions[0].mode, 0o100_644);
    assert_eq!(ok.commits[0].author, "x");
    let refused = |section: &[u8], why: &str| {
        let err = HistoryIndex::parse(&gz(&head(section))).unwrap_err();
        assert!(format!("{err}").contains(why), "{why}: {err}");
    };
    let with = |at: usize, byte: u8| {
        let mut s = good.to_vec();
        s[at] = byte;
        s
    };
    refused(&with(0, 0), "limit is out of range");
    refused(
        &[
            0x81, 0x40, 6, 1, 1, b'x', 0, 3, 0, 0xa4, 0x83, 0x02, 1, 2, 3, 4, 5, 6,
        ],
        "limit is out of range",
    );
    refused(&with(1, 3), "prefix length is out of range");
    refused(&with(1, 21), "prefix length is out of range");
    refused(&with(5, 1), "names an author");
    refused(&with(6, 11), "longer than its limit");
    refused(&with(7, 1), "names a commit");
    refused(&good[..good.len() - 1], "truncated");
    let mut trailing = good.to_vec();
    trailing.push(0);
    refused(&trailing, "trailing bytes");
    // A row count past MAX_ROWS (4,000,001 authors) is refused before anything is read.
    refused(&[4, 6, 0x81, 0x92, 0xf4, 0x01], "too many rows");
    // The section twice.
    let mut twice = head(&good);
    twice.push(1);
    twice.push(u8::try_from(good.len()).unwrap());
    twice.extend_from_slice(&good);
    let err = HistoryIndex::parse(&gz(&twice)).unwrap_err();
    assert!(format!("{err}").contains("twice"), "{err}");
    // And the inflate cap still holds for a v2 body.
    assert!(HistoryIndex::parse_bounded(&gz(&head(&good)), 64).is_err());
}

/// Offline replay fixture for the web (`forge-web/lib/view/history-replay.test.ts`): the pack a push of the
/// tip builds, its object locator, and the tip's history index, written to
/// `HISTORY_REPLAY_OUT`. Run with `HISTORY_REPLAY_REPO=<git dir> HISTORY_REPLAY_TIP=<rev>
/// HISTORY_REPLAY_OUT=<dir> cargo test -p forge-core --lib export_a_replay_fixture -- --ignored`.
#[test]
#[ignore = "exports a local repository named in the environment"]
fn export_a_replay_fixture() {
    let repo = std::env::var("HISTORY_REPLAY_REPO").expect("HISTORY_REPLAY_REPO");
    let tip = std::env::var("HISTORY_REPLAY_TIP").unwrap_or_else(|_| "HEAD".into());
    let out =
        std::path::PathBuf::from(std::env::var("HISTORY_REPLAY_OUT").expect("HISTORY_REPLAY_OUT"));
    std::fs::create_dir_all(&out).unwrap();
    let repo = Path::new(&repo);
    let t = std::time::Instant::now();
    let ix = compute(repo, &tip, None).unwrap().unwrap();
    let index_ms = t.elapsed().as_millis();
    let tip_hex = hex::encode(ix.tip);
    let pack = super::build::build_pack(repo, &[&tip_hex], &[]).unwrap();
    let locator = super::ObjectLocator::build(&pack.parsed, 0).unwrap();
    let history = ix.to_compressed().unwrap();
    std::fs::write(out.join("pack.pack"), &pack.bytes).unwrap();
    std::fs::write(out.join("locator.bin"), locator.as_bytes()).unwrap();
    std::fs::write(out.join("history.gz"), &history).unwrap();
    std::fs::write(out.join("tip.txt"), &tip_hex).unwrap();
    println!(
        "REPLAY tip={tip_hex} pack={} objects={} history_gz={} index_ms={index_ms}",
        pack.bytes.len(),
        locator.object_count(),
        history.len()
    );
}

/// Review M2: an index over the readers' bounds is cut to fewer versions per path until it
/// fits, and stays v2; one that cannot fit is an error, never a v1 index.
#[test]
fn an_index_over_the_readers_bounds_is_cut_until_it_fits() {
    use super::historyindex::compute_bounded;
    let d = fixture_v2();
    let p = d.path();
    let whole = compute(p, "HEAD", None).unwrap().unwrap();
    let body = whole.body().unwrap().len() as u64;
    // A body cap just under the whole index: the lists are cut, the rest stays.
    let cut = compute_bounded(p, "HEAD", None, VERSIONS_PER_PATH, 4_000_000, body - 1)
        .unwrap()
        .unwrap();
    let v = cut.versions.as_ref().unwrap();
    assert!(v.limit < VERSIONS_PER_PATH);
    assert!((cut.body().unwrap().len() as u64) < body);
    assert_eq!(cut.paths.len(), whole.paths.len());
    assert!(HistoryIndex::parse_bounded(&cut.to_compressed().unwrap(), body - 1).is_ok());
    // hot.txt has 6 versions: cut, it no longer says it is whole.
    let hot = &v.lists[b"hot.txt".as_slice()];
    assert!(hot.versions.len() <= v.limit as usize);
    assert_eq!(hot.complete, hot.versions.len() == 6);
    // A row cap on version entries works the same way.
    let rows = compute_bounded(p, "HEAD", None, VERSIONS_PER_PATH, 40, MAX_INFLATED_TEST)
        .unwrap()
        .unwrap();
    let entries: usize = rows
        .versions
        .as_ref()
        .unwrap()
        .lists
        .values()
        .map(|l| l.versions.len())
        .sum();
    assert!(entries <= 40);
    // Nothing fits: an error.
    let err = compute_bounded(p, "HEAD", None, VERSIONS_PER_PATH, 4_000_000, 10).unwrap_err();
    assert!(format!("{err}").contains("size limits"), "{err}");
}

const MAX_INFLATED_TEST: u64 = 64 * 1024 * 1024;

/// The format lives only in the header (RC1 has no manifest field for it): a version this client
/// does not know is refused with a clear error, not read as something else.
#[test]
fn an_unknown_header_version_is_refused_clearly() {
    let d = fixture_v2();
    let ix = compute(d.path(), "HEAD", None).unwrap().unwrap();
    assert_eq!(ix.version(), 2, "every writer writes version 2");
    let mut body = body_of(&ix);
    for v in [0u8, 3, 255] {
        body[4] = v;
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        std::io::Write::write_all(&mut gz, &body).unwrap();
        let err = HistoryIndex::parse(&gz.finish().unwrap())
            .unwrap_err()
            .to_string();
        assert!(
            err.contains(&format!("format {v} is not one this client reads")),
            "{err}"
        );
    }
}
