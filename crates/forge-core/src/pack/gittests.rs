//! Integration tests that drive the system `git` binary against throwaway repos in a
//! `tempfile` scratch directory. They exercise the full pipeline end to end:
//! fix-thin self-containment, repack contiguity, locator lookup + single-span blob
//! reconstruction, and flatIndex enumeration (including a gitlink).

#![allow(clippy::cast_possible_truncation)]

use super::build::{build_pack, repack_all};
use super::flatindex::FlatIndex;
use super::locator::ObjectLocator;
use super::manifest::{PackManifest, KIND_GIT_PACK};
use super::{join, split};
use sha2::Digest as _;
use std::io::Write as _;
use std::path::Path;
use std::process::{Command, Stdio};
use tempfile::TempDir;

/// Run `git -C dir args` (with an isolated, deterministic identity) and return
/// captured stdout bytes, asserting success.
fn git_bytes(dir: &Path, args: &[&str], stdin: Option<&[u8]>) -> Vec<u8> {
    let mut cmd = Command::new("git");
    cmd.arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_AUTHOR_NAME", "t")
        .env("GIT_AUTHOR_EMAIL", "t@e.x")
        .env("GIT_COMMITTER_NAME", "t")
        .env("GIT_COMMITTER_EMAIL", "t@e.x")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_SYSTEM", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        });
    let mut child = cmd.spawn().expect("spawn git");
    if let Some(data) = stdin {
        child.stdin.take().unwrap().write_all(data).unwrap();
    }
    let out = child.wait_with_output().expect("wait git");
    assert!(
        out.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    out.stdout
}

fn git_str(dir: &Path, args: &[&str]) -> String {
    String::from_utf8(git_bytes(dir, args, None))
        .unwrap()
        .trim()
        .to_string()
}

/// Whether `git index-pack --stdin` accepts `pack_bytes` in an EMPTY odb — i.e. the
/// pack is self-contained. `false` when it has unresolved (external) deltas.
fn is_self_contained(pack_bytes: &[u8]) -> bool {
    let empty = TempDir::new().unwrap();
    git_bytes(empty.path(), &["init", "-q", "--bare"], None);
    let idx = empty.path().join("check.idx");
    let pack = empty.path().join("check.pack");
    let mut child = Command::new("git")
        .arg("-C")
        .arg(empty.path())
        .args([
            "index-pack",
            "--stdin",
            "-o",
            &idx.to_string_lossy(),
            &pack.to_string_lossy(),
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(pack_bytes).unwrap();
    child.wait().unwrap().success()
}

/// Deterministic pseudo-text so evolving commits produce good deltas across a push
/// boundary (making a genuinely thin pack), plus a binary file and a subdirectory.
fn make_repo() -> TempDir {
    let dir = TempDir::new().unwrap();
    let p = dir.path();
    git_bytes(p, &["init", "-q"], None);

    // Initial large text file.
    let mut lines: Vec<String> = (0..2000)
        .map(|i| format!("line {i} lorem ipsum dolor sit amet consectetur {}", i % 7))
        .collect();
    std::fs::write(p.join("doc.txt"), lines.join("\n")).unwrap();
    // A pseudo-binary blob (deterministic).
    let bin: Vec<u8> = (0..4096u32)
        .map(|i| (i.wrapping_mul(2_654_435_761) >> 13) as u8)
        .collect();
    std::fs::write(p.join("bin.dat"), &bin).unwrap();
    std::fs::create_dir(p.join("subdir")).unwrap();
    std::fs::write(p.join("subdir/r.md"), b"# readme\n").unwrap();
    git_bytes(p, &["add", "-A"], None);
    git_bytes(p, &["commit", "-q", "-m", "c1"], None);

    // Evolve doc.txt across several commits (mutate a few lines each time).
    let mut seed = 12345u64;
    for c in 2..=12 {
        for _ in 0..8 {
            seed = seed
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            let j = (seed >> 33) as usize % lines.len();
            lines[j] = format!("mutated at commit {c} row {j} xyzzy");
        }
        std::fs::write(p.join("doc.txt"), lines.join("\n")).unwrap();
        git_bytes(p, &["add", "doc.txt"], None);
        git_bytes(p, &["commit", "-q", "-m", &format!("c{c}")], None);
    }

    // Inject a gitlink (submodule) entry to exercise mode-160000 handling.
    let head = git_str(p, &["rev-parse", "HEAD"]);
    git_bytes(
        p,
        &[
            "update-index",
            "--add",
            "--cacheinfo",
            &format!("160000,{head},vendor/sub"),
        ],
        None,
    );
    git_bytes(p, &["commit", "-q", "-m", "add gitlink"], None);
    dir
}

#[test]
fn thin_pack_is_unresolvable_but_fixed_pack_is_self_contained() {
    let repo = make_repo();
    let p = repo.path();
    let head = git_str(p, &["rev-parse", "HEAD~1"]); // skip the gitlink commit
    let base = git_str(p, &["rev-parse", "HEAD~2"]);

    // Raw thin pack (mirror S0.5): must fail standalone in an empty odb.
    let revs = format!("{head}\n^{base}\n");
    let thin = git_bytes(
        p,
        &[
            "pack-objects",
            "--thin",
            "--revs",
            "--stdout",
            "--delta-base-offset",
        ],
        Some(revs.as_bytes()),
    );
    assert!(
        !is_self_contained(&thin),
        "raw thin pack should have unresolved external deltas"
    );

    // forge-core build_pack must complete it into a self-contained pack.
    let report = build_pack(p, &[&head], &[&base]).unwrap();
    assert!(
        is_self_contained(&report.pack.bytes),
        "fix-thin'd pack must be self-contained"
    );
    assert!(report.fixed_size >= report.thin_size);
    // Premium is the materialized-base overhead; positive for a genuinely thin push.
    let premium = report.premium_ratio();
    assert!(
        premium > 0.0,
        "expected a positive fix-thin premium, got {premium}"
    );
    assert!(report.pack.parsed.object_count() > 0);
}

#[test]
fn repack_all_has_zero_ref_delta_and_verifies() {
    let repo = make_repo();
    let pack = repack_all(repo.path()).unwrap();
    assert_eq!(
        pack.parsed.ref_delta_count(),
        0,
        "repack must have 0 REF_DELTA"
    );
    assert!(pack.parsed.object_count() > 5);
    // Every object reconstructs and its git OID matches the idx.
    let verified = pack.parsed.verify_all_oids().unwrap();
    assert_eq!(verified, pack.parsed.object_count());
    // The consolidated pack is self-contained.
    assert!(is_self_contained(&pack.bytes));
}

#[test]
fn packhash_is_sha256_of_pack_bytes() {
    let repo = make_repo();
    let pack = repack_all(repo.path()).unwrap();
    let expect: [u8; 32] = sha2::Sha256::digest(&pack.bytes).into();
    assert_eq!(pack.parsed.pack_hash, expect);
}

#[test]
fn locator_lookup_matches_parsed_offsets() {
    let repo = make_repo();
    let pack = repack_all(repo.path()).unwrap();
    let loc = ObjectLocator::build(&pack.parsed, 0).unwrap();
    assert_eq!(loc.object_count(), pack.parsed.object_count());

    // Every object round-trips through the fanout-slice lookup.
    for obj in &pack.parsed.objects {
        let e = loc.lookup(&obj.oid).expect("locator hit");
        assert_eq!(e.offset, obj.offset);
        assert_eq!(u64::from(e.length), obj.length);
        assert_eq!(u64::from(e.delta_chain_span), obj.delta_chain_span);
    }

    // Re-parsing the serialized bytes yields the same lookups.
    let reparsed = ObjectLocator::parse(loc.as_bytes()).unwrap();
    let known = repo_blob_oid(repo.path(), "doc.txt");
    assert_eq!(reparsed.lookup(&known), loc.lookup(&known));
}

#[test]
fn locator_lookup_absent_oid_returns_none() {
    let repo = make_repo();
    let pack = repack_all(repo.path()).unwrap();
    let loc = ObjectLocator::build(&pack.parsed, 0).unwrap();
    assert!(loc.lookup(&[0xabu8; 20]).is_none());
    assert!(
        loc.lookup(&[1, 2, 3]).is_none(),
        "wrong-length oid is a miss"
    );
}

#[test]
fn blob_reconstructs_from_delta_chain_span() {
    let repo = make_repo();
    let pack = repack_all(repo.path()).unwrap();
    let loc = ObjectLocator::build(&pack.parsed, 0).unwrap();

    let oid = repo_blob_oid(repo.path(), "doc.txt");
    let entry = loc.lookup(&oid).expect("blob in locator");
    let obj = pack.parsed.object(&oid).unwrap().clone();

    // A blob's span should advise the single contiguous read.
    assert!(
        entry.single_read_advised(),
        "blob should take the fast path"
    );

    // Simulate a ranged read of ONLY the deltaChainSpan slice.
    let start = usize::try_from(obj.end() - obj.delta_chain_span).unwrap();
    let end = usize::try_from(obj.end()).unwrap();
    let slice = &pack.bytes[start..end];

    let (ty, bytes) = pack.parsed.reconstruct_from_span(&obj, slice).unwrap();
    assert_eq!(ty, super::parse::GitObjType::Blob);

    // Must equal `git cat-file blob <oid>`.
    let expect = git_bytes(repo.path(), &["cat-file", "blob", &hex::encode(oid)], None);
    assert_eq!(bytes, expect, "span-reconstructed blob must match git");
    assert_eq!(super::parse::git_oid(ty, &bytes), oid);
}

#[test]
fn flatindex_lists_paths_including_gitlink() {
    let repo = make_repo();
    let compressed = super::flatindex::build(repo.path(), "HEAD").unwrap();
    let fi = FlatIndex::parse(&compressed).unwrap();

    let tip = git_str(repo.path(), &["rev-parse", "HEAD"]);
    assert_eq!(hex::encode(fi.tip), tip);

    let doc = fi.lookup("doc.txt").expect("doc.txt present");
    assert_eq!(doc.mode, 0o100_644);
    assert!(doc.size > 0);
    assert!(fi.lookup("subdir/r.md").is_some());
    assert!(fi.lookup("subdir").unwrap().is_tree());

    let link = fi.lookup("vendor/sub").expect("gitlink present");
    assert!(link.is_gitlink(), "vendor/sub must be mode 160000");
    assert_eq!(link.mode, super::flatindex::MODE_GITLINK);
}

#[test]
fn flatindex_list_dir_returns_immediate_children() {
    let repo = make_repo();
    let compressed = super::flatindex::build(repo.path(), "HEAD").unwrap();
    let fi = FlatIndex::parse(&compressed).unwrap();

    let root: Vec<&str> = fi.list_dir("").iter().map(|e| e.path.as_str()).collect();
    assert!(root.contains(&"doc.txt"));
    assert!(root.contains(&"subdir"));
    assert!(root.contains(&"vendor"));
    // subdir/r.md is NOT an immediate child of root.
    assert!(!root.contains(&"subdir/r.md"));

    let sub: Vec<&str> = fi
        .list_dir("subdir")
        .iter()
        .map(|e| e.path.as_str())
        .collect();
    assert_eq!(sub, vec!["subdir/r.md"]);
}

#[test]
fn chunker_roundtrips_real_pack_bytes() {
    let repo = make_repo();
    let pack = repack_all(repo.path()).unwrap();
    let chunks = split(&pack.bytes);
    assert!(!chunks.is_empty());
    assert_eq!(join(&chunks), pack.bytes);
    // Same machinery chunks the browse artifacts.
    let loc = ObjectLocator::build(&pack.parsed, 0).unwrap();
    let lchunks = split(loc.as_bytes());
    assert_eq!(join(&lchunks), loc.as_bytes());
}

#[test]
fn manifest_for_pack_has_mandatory_offset_index() {
    let repo = make_repo();
    let pack = repack_all(repo.path()).unwrap();
    let chunk_count = split(&pack.bytes).len() as u64;
    let m = PackManifest::for_pack(&pack, chunk_count);
    assert_eq!(m.kind, KIND_GIT_PACK);
    assert!(
        m.offset_index_parts >= 1,
        "kind-0 packs mandate an offset index"
    );
    assert_eq!(m.object_count, pack.parsed.object_count() as u64);
    assert_eq!(m.size_bytes, pack.bytes.len() as u64);
    assert_eq!(m.pack_hash.len(), 64, "sha256 hex");
    assert_eq!(m.chunk_count, chunk_count);
}

#[test]
fn locator_build_rejects_non_self_contained_pack() {
    // A push pack carries fix-thin'd REF_DELTA bases appended AFTER the objects that
    // reference them (non-contiguous). Building an objectLocator from it would emit
    // rows with a small deltaChainSpan that a remote reader would single-read and miss
    // the base. `build` must refuse it — the wire format can never be produced with a
    // misleading small span from a non-self-contained pack.
    let repo = make_repo();
    let p = repo.path();
    let head = git_str(p, &["rev-parse", "HEAD~1"]);
    let base = git_str(p, &["rev-parse", "HEAD~2"]);
    let report = build_pack(p, &[&head], &[&base]).unwrap();
    assert!(
        report.pack.parsed.ref_delta_count() > 0,
        "expected the push pack to carry REF_DELTA bases"
    );
    let err = ObjectLocator::build(&report.pack.parsed, 0).unwrap_err();
    assert!(
        format!("{err}").contains("self-contained repacked pack"),
        "unexpected error: {err}"
    );
}

#[test]
fn span_read_refuses_non_contiguous_object_but_full_read_works() {
    let repo = make_repo();
    let p = repo.path();
    let head = git_str(p, &["rev-parse", "HEAD~1"]);
    let base = git_str(p, &["rev-parse", "HEAD~2"]);
    let report = build_pack(p, &[&head], &[&base]).unwrap();

    let obj = report
        .pack
        .parsed
        .objects
        .iter()
        .find(|o| !o.contiguous)
        .expect("push pack has a non-contiguous object")
        .clone();

    // The single-span read must refuse a non-contiguous object outright.
    let err = report
        .pack
        .parsed
        .reconstruct_from_span(&obj, &report.pack.bytes)
        .unwrap_err();
    assert!(format!("{err}").contains("not contiguous"), "{err}");

    // But the REF-aware full-pack reconstruction still recovers it correctly,
    // exercising decode_at's allow_ref path.
    let (ty, bytes) = report.pack.parsed.object_bytes(&obj.oid).unwrap();
    assert_eq!(super::parse::git_oid(ty, &bytes), obj.oid);
}

#[test]
fn sha256_index_is_rejected_with_clear_error() {
    let dir = TempDir::new().unwrap();
    let p = dir.path();
    git_bytes(p, &["init", "-q", "--object-format=sha256"], None);
    std::fs::write(p.join("f.txt"), b"hello sha256 world\n").unwrap();
    git_bytes(p, &["add", "f.txt"], None);
    git_bytes(p, &["commit", "-q", "-m", "c1"], None);

    let pack_bytes = git_bytes(
        p,
        &["pack-objects", "--all", "--stdout", "--delta-base-offset"],
        None,
    );
    let packp = p.join("s.pack");
    std::fs::write(&packp, &pack_bytes).unwrap();
    git_bytes(p, &["index-pack", &packp.to_string_lossy()], None);
    let idx_bytes = std::fs::read(p.join("s.idx")).unwrap();

    let err = super::parse::ParsedPack::parse(&pack_bytes, &idx_bytes).unwrap_err();
    let msg = format!("{err}");
    assert!(
        msg.contains("SHA-256") || msg.contains("SHA-1 v2 layout"),
        "expected a SHA-256/layout rejection, got: {msg}"
    );
}

#[test]
fn ref_arguments_starting_with_dash_are_rejected() {
    let repo = make_repo();
    let p = repo.path();
    // An option-like want/have never reaches git's argv / rev-list stdin.
    assert!(build_pack(p, &["--all"], &[]).is_err());
    assert!(build_pack(p, &["HEAD"], &["-x"]).is_err());
    // Same guard on the flatIndex tip.
    assert!(super::flatindex::build(p, "-x").is_err());
    assert!(super::flatindex::build(p, "--output=/etc/passwd").is_err());
}

/// The blob OID at a path in HEAD.
fn repo_blob_oid(repo: &Path, path: &str) -> [u8; 20] {
    let hexs = git_str(repo, &["rev-parse", &format!("HEAD:{path}")]);
    hex::decode(hexs).unwrap().as_slice().try_into().unwrap()
}
