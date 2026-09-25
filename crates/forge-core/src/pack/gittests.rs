//! Integration tests that drive the system `git` binary against throwaway repos in a
//! `tempfile` scratch directory. They exercise the full pipeline end to end:
//! fix-thin self-containment, repack contiguity, locator lookup + single-span blob
//! reconstruction, and flatIndex enumeration (including a gitlink).

#![allow(clippy::cast_possible_truncation)]

use super::build::{build_pack, repack_all, repack_from_packs, Pack};
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

/// The pack the push path used to store: `pack-objects --thin` completed with
/// `index-pack --fix-thin`. Kept as a fixture, not a producer — older clients stored packs
/// built exactly this way, so the readers must keep resolving `REF_DELTA` and
/// non-contiguous objects, and [`ObjectLocator::build`] must keep refusing such a pack.
fn thin_fixed_pack(p: &Path, want: &str, base: &str) -> (Vec<u8>, super::parse::ParsedPack) {
    let revs = format!("{want}\n^{base}\n");
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
    let scratch = TempDir::new().unwrap();
    let pack_path = scratch.path().join("fixed.pack");
    let idx_path = scratch.path().join("fixed.idx");
    git_bytes(
        p,
        &[
            "index-pack",
            "--fix-thin",
            "--stdin",
            "-o",
            &idx_path.to_string_lossy(),
            &pack_path.to_string_lossy(),
        ],
        Some(&thin),
    );
    let bytes = std::fs::read(&pack_path).unwrap();
    let idx_bytes = std::fs::read(&idx_path).unwrap();
    let parsed = super::parse::ParsedPack::parse(&bytes, &idx_bytes).unwrap();
    (bytes, parsed)
}

#[test]
fn push_pack_is_locator_quality_and_no_larger_than_the_fix_thin_alternative() {
    let repo = make_repo();
    let p = repo.path();
    let head = git_str(p, &["rev-parse", "HEAD~1"]); // skip the gitlink commit
    let base = git_str(p, &["rev-parse", "HEAD~2"]);

    // A raw thin pack cannot stand alone — that much of S0.5 still holds, and is why the
    // push path may not simply store `pack-objects --thin` output.
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

    let (fixed_bytes, fixed) = thin_fixed_pack(p, &head, &base);
    assert!(
        fixed.ref_delta_count() > 0,
        "the fix-thin'd alternative carries REF_DELTA bases"
    );

    // What the push path stores: self-contained, indexable, and no bigger than the
    // fix-thin'd pack it replaces — whichever of the two candidates won.
    let pack = build_pack(p, &[&head], &[&base]).unwrap();
    assert_locator_quality(&pack, "push pack");
    assert!(pack.parsed.object_count() > 0);
    assert!(
        pack.bytes.len() <= fixed_bytes.len(),
        "push pack ({}) should be no larger than the fix-thin'd one ({})",
        pack.bytes.len(),
        fixed_bytes.len()
    );
}

/// Every assertion that makes a pack storable: it stands alone, the locator can describe it,
/// and the locator's single-span read model holds over it.
fn assert_locator_quality(pack: &Pack, what: &str) {
    assert!(is_self_contained(&pack.bytes), "{what} must stand alone");
    assert_eq!(pack.parsed.ref_delta_count(), 0, "{what}: no REF_DELTA");
    assert!(
        pack.parsed.objects.iter().all(|o| o.contiguous),
        "{what}: every delta chain must be a contiguous byte range"
    );
    ObjectLocator::build(&pack.parsed, 0).unwrap_or_else(|e| panic!("{what} not indexable: {e}"));
}

/// A deterministic high-entropy line, so deltas — not zlib — decide the pack size.
fn entropy_line(tag: &str, i: usize) -> String {
    let digest = sha2::Sha256::digest(format!("{tag}{i}").as_bytes());
    format!("{}  pkg-{i}", hex::encode(digest))
}

#[test]
fn push_pack_stays_locator_quality_on_the_shape_that_favors_completion() {
    // The counter-shape to the sequential push: N branch tips off one base, each rewriting a
    // different region of the same large file. Every new blob deltas cheaply against the SAME
    // boundary blob at the same path but they are mutually distant, so the
    // completed-then-reordered candidate wins by a wide margin and the direct one is much
    // bigger. Both the choice and the invariant are asserted, because a build that only ever
    // produced the direct pack would still pass the test above.
    let repo = TempDir::new().unwrap();
    let p = repo.path();
    git_bytes(p, &["init", "-q"], None);
    let lines: Vec<String> = (0..8000).map(|i| entropy_line("", i)).collect();
    std::fs::write(p.join("lock.txt"), lines.join("\n")).unwrap();
    git_bytes(p, &["add", "-A"], None);
    git_bytes(p, &["commit", "-q", "-m", "base"], None);
    let base = git_str(p, &["rev-parse", "HEAD"]);

    let mut tips = Vec::new();
    for b in 0..20usize {
        git_bytes(p, &["checkout", "-q", "-b", &format!("b{b}"), &base], None);
        let mut edited = lines.clone();
        for (j, row) in edited.iter_mut().enumerate().skip(b * 300).take(300) {
            *row = entropy_line("rewritten", j);
        }
        std::fs::write(p.join("lock.txt"), edited.join("\n")).unwrap();
        git_bytes(p, &["commit", "-q", "-am", &format!("b{b}")], None);
        tips.push(git_str(p, &["rev-parse", "HEAD"]));
    }
    let want: Vec<&str> = tips.iter().map(String::as_str).collect();

    let pack = build_pack(p, &want, &[&base]).unwrap();
    assert_locator_quality(&pack, "multi-branch push pack");

    // The direct candidate alone: what `build_pack` would store if it did not try both.
    let mut revs = String::new();
    for t in &tips {
        revs.push_str(t);
        revs.push('\n');
    }
    revs.push('^');
    revs.push_str(&base);
    revs.push('\n');
    let direct = git_bytes(
        p,
        &["pack-objects", "--revs", "--stdout", "--delta-base-offset"],
        Some(revs.as_bytes()),
    );
    assert!(
        pack.bytes.len() < direct.len(),
        "on this shape the completed-then-reordered candidate must win: \
         stored {} vs direct-only {}",
        pack.bytes.len(),
        direct.len()
    );
}

#[test]
fn a_pack_the_browse_index_cannot_describe_is_refused_rather_than_stored() {
    // The invariant `Pack::from_files` enforces, exercised through the one shape that
    // violates it. `repack_from_packs` must still ABSORB such a pack (older clients stored
    // them) — only producing one is refused.
    let repo = make_repo();
    let p = repo.path();
    let head = git_str(p, &["rev-parse", "HEAD~1"]);
    let base = git_str(p, &["rev-parse", "HEAD~2"]);
    let (fixed_bytes, fixed) = thin_fixed_pack(p, &head, &base);
    assert!(fixed.ref_delta_count() > 0);

    let scratch = TempDir::new().unwrap();
    let out_pack = scratch.path().join("out.pack");
    let out_idx = scratch.path().join("out.idx");
    git_bytes(
        p,
        &[
            "index-pack",
            "--stdin",
            "-o",
            &out_idx.to_string_lossy(),
            &out_pack.to_string_lossy(),
        ],
        Some(&fixed_bytes),
    );
    let Err(err) = Pack::from_files(&out_pack, &out_idx) else {
        panic!("a fix-thin'd pack must not be storable")
    };
    assert!(
        format!("{err}").contains("browse index cannot describe"),
        "unexpected error: {err}"
    );

    // ...but it is still absorbable: a repack over it (plus the pack holding the history it
    // deltas against) yields a storable pack. That path is how an old repo gets an index.
    let history = build_pack(p, &[&base], &[]).unwrap().bytes;
    let consolidated = repack_from_packs(&[history, fixed_bytes], &[&head]).unwrap();
    assert_locator_quality(&consolidated, "repack over a fix-thin'd pack");
}

#[test]
fn repack_from_packs_consolidates_offdisk_packs_over_tips() {
    // The repack/GC path when objects live off-disk (Platform chunks / external backend):
    // split history into two incremental packs, then rebuild ONE consolidated pack from
    // just those pack bytes + the resolved tip — exactly what RepoService::repack does
    // after fetching each stored pack. The result must equal an on-disk `repack_all`.
    let repo = make_repo();
    let p = repo.path();
    let tip = git_str(p, &["rev-parse", "HEAD"]);
    let mid = git_str(p, &["rev-parse", "HEAD~3"]);

    // Two packs whose union covers the whole graph: [root..mid] and (mid..tip].
    let pack_a = build_pack(p, &[&mid], &[]).unwrap().bytes;
    let pack_b = build_pack(p, &[&tip], &[&mid]).unwrap().bytes;

    let consolidated = repack_from_packs(&[pack_a, pack_b], &[&tip]).unwrap();
    // 0 REF_DELTA, self-contained, every OID verifies.
    assert_eq!(consolidated.parsed.ref_delta_count(), 0);
    assert!(is_self_contained(&consolidated.bytes));
    assert_eq!(
        consolidated.parsed.verify_all_oids().unwrap(),
        consolidated.parsed.object_count()
    );
    // The tip commit is present, and the object set matches a direct on-disk repack.
    let tip_bytes = hex::decode(&tip).unwrap();
    assert!(consolidated.parsed.object(&tip_bytes).is_some());
    let direct = repack_all(p).unwrap();
    assert_eq!(
        consolidated.parsed.object_count(),
        direct.parsed.object_count(),
        "off-disk repack must cover the same reachable objects as an on-disk repack"
    );

    // No inputs → a clear error, not a panic.
    assert!(repack_from_packs(&[], &[&tip]).is_err());
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
fn locator_merge_folds_fragments_and_keeps_every_pack_address() {
    // The index-consolidation shape: pack A is indexed at packRef 0 by one fragment and
    // pack B at packRef 1 by another. Merging must cover both, keep A's rows where they are,
    // and — the part a naive OID-keyed fold destroys — keep B's OWN row for every object B
    // also stores, because that row is the only record of B's address for it.
    let repo = make_repo();
    let p = repo.path();
    let tip = git_str(p, &["rev-parse", "HEAD"]);
    let mid = git_str(p, &["rev-parse", "HEAD~3"]);
    let pack_a = build_pack(p, &[&mid], &[]).unwrap();
    // Deliberately NOT `^mid`: a pusher whose clone lacks the remote tip sends history an
    // earlier pack already holds, so the two packs overlap. That is the case that matters.
    let pack_b = build_pack(p, &[&tip], &[]).unwrap();

    let a_only = ObjectLocator::build(&pack_a.parsed, 0).unwrap();
    let b_only = ObjectLocator::build(&pack_b.parsed, 1).unwrap();
    let both = ObjectLocator::merge(&[&a_only, &b_only]);
    let shared = pack_b
        .parsed
        .objects
        .iter()
        .filter(|o| a_only.lookup(&o.oid).is_some())
        .count();
    assert!(shared > 0, "fixture must overlap for this to test anything");

    // Serialized form is well-formed (fanout consistent with the row count).
    let reparsed = ObjectLocator::parse(both.as_bytes()).unwrap();
    assert_eq!(reparsed.object_count(), both.object_count());
    assert_eq!(both.max_pack_ref(), Some(1));
    // Every row of both fragments survives; nothing is collapsed away. That is what keeps
    // a (packRef, offset) address for every object in EVERY pack that stores it — the
    // record a reader's OFS-delta base walk resolves against. The end-to-end proof of that
    // walk is in forge-web `lib/browse/locator.test.ts`, where the reader lives.
    assert_eq!(
        both.object_count(),
        a_only.object_count() + b_only.object_count()
    );

    // Merging is idempotent and order-stable: folding in a part already covered changes
    // nothing, so a re-run after a partially-observed publish cannot corrupt the index.
    assert_eq!(
        ObjectLocator::merge(&[&both, &a_only]).as_bytes(),
        both.as_bytes()
    );

    // Every object of A keeps its exact row, at packRef 0 — a lookup never moves.
    for o in &pack_a.parsed.objects {
        let before = a_only.lookup(&o.oid).expect("A object indexed before");
        let after = both.lookup(&o.oid).expect("A object still indexed");
        assert_eq!(before, after, "merge moved an already-indexed object");
        assert_eq!(after.pack_ref, 0);
    }

    // ...and the offsets B's rows carry really do address B's bytes: reconstruct one through
    // the single-span read the locator advertises.
    let obj = pack_b
        .parsed
        .objects
        .iter()
        .find(|o| a_only.lookup(&o.oid).is_none() && o.contiguous)
        .expect("a new contiguous object in B");
    let e = both.lookup(&obj.oid).unwrap();
    assert_eq!(e.pack_ref, 1);
    assert!(
        e.single_read_advised(),
        "a small blob should be single-read"
    );
    // Exactly the range a browse reader would request, computed from the locator row alone.
    let end = e.offset + u64::from(e.length);
    let span = &pack_b.bytes[(end - u64::from(e.delta_chain_span)) as usize..end as usize];
    let (ty, bytes) = pack_b.parsed.reconstruct_from_span(obj, span).unwrap();
    assert_eq!(super::parse::git_oid(ty, &bytes), obj.oid);
}

#[test]
fn locator_fragment_refuses_a_pack_it_cannot_describe() {
    // Compatibility guard: a fix-thin'd pack (what older clients stored) must never get an
    // index fragment — its rows would advertise a span that misses the base.
    let repo = make_repo();
    let p = repo.path();
    let head = git_str(p, &["rev-parse", "HEAD~1"]);
    let base = git_str(p, &["rev-parse", "HEAD~2"]);
    let (_, fixed) = thin_fixed_pack(p, &head, &base);
    let err = ObjectLocator::build(&fixed, 1).unwrap_err();
    assert!(
        format!("{err}").contains("self-contained repacked pack"),
        "unexpected error: {err}"
    );
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
    let (_, fixed) = thin_fixed_pack(p, &head, &base);
    assert!(
        fixed.ref_delta_count() > 0,
        "expected the fix-thin'd pack to carry REF_DELTA bases"
    );
    let err = ObjectLocator::build(&fixed, 0).unwrap_err();
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
    let (fixed_bytes, fixed) = thin_fixed_pack(p, &head, &base);

    let obj = fixed
        .objects
        .iter()
        .find(|o| !o.contiguous)
        .expect("fix-thin'd pack has a non-contiguous object")
        .clone();

    // The single-span read must refuse a non-contiguous object outright.
    let err = fixed.reconstruct_from_span(&obj, &fixed_bytes).unwrap_err();
    assert!(format!("{err}").contains("not contiguous"), "{err}");

    // But the REF-aware full-pack reconstruction still recovers it correctly,
    // exercising decode_at's allow_ref path — the compatibility path for packs older
    // clients stored before the push pipeline dropped `--fix-thin`.
    let (ty, bytes) = fixed.object_bytes(&obj.oid).unwrap();
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
