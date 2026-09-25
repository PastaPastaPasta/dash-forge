//! Pack creation by shelling out to the system `git` binary.
//!
//! Two entry points mirror the two producers in the push / repack flows. Both emit a
//! **locator-quality** pack: 0 `REF_DELTA`, every OFS delta base earlier in the same pack,
//! every object's delta chain contiguous. That is the invariant the `objectLocator`
//! single-span read depends on, and [`Pack::from_files`] enforces it on the way out, so no
//! pack this module produces can ever be stored un-indexable.
//!
//! - [`build_pack`] — the *push* path. Builds two locator-quality candidates for the push
//!   delta and stores the smaller; see its docs for why neither dominates.
//! - [`repack_all`] — the *repack* path. `git pack-objects --all` produces one consolidated
//!   pack over the whole reachable graph. Non-destructive (never rewrites the repo odb).
//!
//! git subcommands used, and why: `pack-objects` (delta compute), `index-pack` (`.idx`
//! generation). No `verify-pack` in the library path — see `parse.rs`.

use super::parse::ParsedPack;
use crate::error::{Error, Result};
use std::fs;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// A self-contained packfile with its parsed v2 index.
pub struct Pack {
    /// The raw packfile bytes (self-contained: every delta base is present).
    pub bytes: Vec<u8>,
    /// The raw `.idx` v2 bytes.
    pub idx_bytes: Vec<u8>,
    /// The parsed object geometry + `packHash`.
    pub parsed: ParsedPack,
}

impl Pack {
    pub(super) fn from_files(pack_path: &Path, idx_path: &Path) -> Result<Self> {
        let bytes = fs::read(pack_path).map_err(|e| Error::Io(e.to_string()))?;
        let idx_bytes = fs::read(idx_path).map_err(|e| Error::Io(e.to_string()))?;
        let parsed = ParsedPack::parse(&bytes, &idx_bytes)?;
        ensure_locator_quality(&parsed)?;
        Ok(Self {
            bytes,
            idx_bytes,
            parsed,
        })
    }
}

/// Refuse a pack the browse plane could not index.
///
/// A `REF_DELTA` object, or one whose delta chain is not a contiguous byte range, makes
/// [`ObjectLocator::build`](super::ObjectLocator::build) fail — so a pack carrying either
/// can be stored but never browsed without a full client-side clone. Every producer here
/// is supposed to emit `--delta-base-offset` packs whose bases precede their deltas; this
/// turns that expectation into a checked invariant at the one place every produced pack
/// passes through, rather than a comment that silently stops being true.
///
/// This does NOT reject packs from elsewhere: [`repack_from_packs`] absorbs arbitrary
/// stored packs (including fix-thin'd ones written by older clients) through
/// `index-pack --stdin` and only its *output* comes back through here.
fn ensure_locator_quality(parsed: &ParsedPack) -> Result<()> {
    let refs = parsed.ref_delta_count();
    let noncontig = parsed.objects.iter().filter(|o| !o.contiguous).count();
    if refs > 0 || noncontig > 0 {
        return Err(Error::Config(format!(
            "git produced a pack the browse index cannot describe \
             ({refs} REF_DELTA + {noncontig} non-contiguous objects); \
             refusing to store it"
        )));
    }
    Ok(())
}

/// Build a self-contained, **locator-quality** pack carrying the objects reachable from
/// `want_tips` but not from `have_bases` — the push delta.
///
/// `want_tips` / `have_bases` are revision names (OIDs or refs) understood by git.
///
/// ## Two candidates, store the smaller
///
/// Locator-quality means `--delta-base-offset` with every delta base inside the pack and
/// earlier than the deltas that use it. There are two ways to get there from a push delta,
/// and neither dominates:
///
/// * **direct** — `pack-objects --revs` without `--thin`. The pack holds only the new
///   objects; nothing external is delta'd against, so nothing has to be materialized.
/// * **completed-then-reordered** — `pack-objects --thin` (deltas allowed against objects
///   the remote already has), `index-pack --fix-thin` to materialize those bases, then
///   re-emit the resulting object set non-thin so the bases land *before* their deltas.
///   Pays for the base objects, but its deltas are the cheap external ones.
///
/// Which wins depends on the shape of the push, by a lot, so this builds both and keeps the
/// smaller. CPU is free here and bytes are not: a push is bounded by one state transition
/// per ~14 KiB chunk, so a second `pack-objects` run costs nothing against the round trips
/// it may save. With no `have_bases` the two are the same pack and only the direct one is
/// built. Measured, stored bytes ÷ the old `--fix-thin` pack:
///
/// | push shape                                   | direct | completed+reordered |
/// |----------------------------------------------|--------|---------------------|
/// | first push (whole history)                   | 1.000  | 1.000               |
/// | 1 / 5 / 20 sequential commits                | 0.849 / 0.879 / 0.882 | 0.996 / 0.996 / 0.995 |
/// | 20 branch tips off one base, each editing one large file | 1.373 | 0.999 |
///
/// The last row is why "just drop `--thin`" is wrong: one push of N branches off a shared
/// base sends N blobs that each delta cheaply against the SAME boundary blob at the same
/// path but are mutually distant, so the direct pack pays ~2 internal deltas where the
/// completed one pays one full base plus N cheap ones. Past N≈3 the direct pack is bigger
/// and the gap grows with N.
///
/// ## Why the old pipeline could not simply be kept
///
/// This path used to store the `--fix-thin` pack itself. `index-pack --fix-thin` appends the
/// materialized bases at the END of the pack, *after* the deltas that reference them, so the
/// result carries `REF_DELTA` and non-contiguous objects that
/// [`ObjectLocator::build`](super::ObjectLocator::build) must refuse — a stored pack the
/// browse plane could never index. Re-emitting the same object set non-thin fixes the order
/// at no measured cost (0.995–1.000 of it above).
///
/// The previously published "fix-thin premium: 0.9–4.4%" (S0.5 §1) is
/// `(fixed − thin) / thin`, a ratio against the thin pack, which is never stored. On that
/// spike's 2.85 GiB corpus the thin baseline is 0.16–5.3 MB against 2–234 materialized
/// bases, so the appended bytes read small; it was never a measurement of the completed pack
/// against the alternative that would otherwise be stored.
pub fn build_pack(repo: &Path, want_tips: &[&str], have_bases: &[&str]) -> Result<Pack> {
    if want_tips.is_empty() {
        return Err(Error::Config("build_pack: no want tips".into()));
    }
    let mut revs = String::new();
    for t in want_tips {
        ensure_safe_rev(t)?;
        revs.push_str(t);
        revs.push('\n');
    }
    for b in have_bases {
        ensure_safe_rev(b)?;
        revs.push('^');
        revs.push_str(b);
        revs.push('\n');
    }

    let direct = build_direct(repo, &revs)?;
    if have_bases.is_empty() {
        // Nothing external to delta against: `--thin` is a no-op and both candidates are
        // the same pack. Skip the second build rather than pay for an identical answer.
        return Ok(direct);
    }

    match build_completed_reordered(repo, &revs) {
        Ok(alt) if alt.bytes.len() < direct.bytes.len() => Ok(alt),
        Ok(_) => Ok(direct),
        Err(e) => {
            // The direct candidate is always available and always correct; the second one is
            // an optimization. Never fail a push because it could not be built — but say so
            // at `warn`, not `debug`: a systematic failure here (an old git, a constrained
            // temp dir) is invisible otherwise and costs up to ~37% more stored bytes on a
            // multi-branch push, which is real money.
            tracing::warn!(
                error = %e,
                "could not build the completed-then-reordered pack candidate; storing the \
                 non-thin one, which may be larger"
            );
            Ok(direct)
        }
    }
}

/// Candidate 1: the push delta packed non-thin, so no external base is ever referenced.
fn build_direct(repo: &Path, revs: &str) -> Result<Pack> {
    let bytes = git_capture(
        repo,
        &["pack-objects", "--revs", "--stdout", "--delta-base-offset"],
        Some(revs.as_bytes()),
    )?;
    index_pack_bytes(repo, &bytes)
}

/// Candidate 2: thin pack → `--fix-thin` completion → re-emit the completed object set
/// non-thin, which puts the materialized bases ahead of the deltas that use them.
fn build_completed_reordered(repo: &Path, revs: &str) -> Result<Pack> {
    let thin = git_capture(
        repo,
        &[
            "pack-objects",
            "--thin",
            "--revs",
            "--stdout",
            "--delta-base-offset",
        ],
        Some(revs.as_bytes()),
    )?;

    // Complete it against the source odb. Parsed directly rather than through
    // `Pack::from_files`, which would (correctly) refuse this shape — it is an intermediate,
    // never a stored pack.
    let scratch = Scratch::new()?;
    let fixed_pack = scratch.dir.join("fixed.pack");
    let fixed_idx = scratch.dir.join("fixed.idx");
    git_capture(
        repo,
        &[
            "index-pack",
            "--fix-thin",
            "--stdin",
            "-o",
            &fixed_idx.to_string_lossy(),
            &fixed_pack.to_string_lossy(),
        ],
        Some(&thin),
    )?;
    let fixed_bytes = fs::read(&fixed_pack).map_err(|e| Error::Io(e.to_string()))?;
    let fixed_idx_bytes = fs::read(&fixed_idx).map_err(|e| Error::Io(e.to_string()))?;
    let parsed = ParsedPack::parse(&fixed_bytes, &fixed_idx_bytes)?;

    // Re-emit exactly that object set from a scratch odb. `pack-objects` reading object
    // names on stdin (no `--revs`) packs those objects and nothing else, and without
    // `--thin` every delta base it picks is one of them — so the output is self-contained
    // and ordered bases-first.
    let odb = scratch.dir.join("odb.git");
    fs::create_dir_all(&odb).map_err(|e| Error::Io(e.to_string()))?;
    git_capture(&odb, &["init", "--bare", "-q"], None)?;
    git_capture(&odb, &["index-pack", "--stdin"], Some(&fixed_bytes))?;
    let mut oids = String::with_capacity(parsed.objects.len() * 41);
    for o in &parsed.objects {
        oids.push_str(&hex::encode(o.oid));
        oids.push('\n');
    }
    let bytes = git_capture(
        &odb,
        &["pack-objects", "--stdout", "--delta-base-offset"],
        Some(oids.as_bytes()),
    )?;
    index_pack_bytes(&odb, &bytes)
}

/// Index a packfile into a scratch `.pack`/`.idx` pair and parse it. `repo` is only the cwd
/// `index-pack` needs for the object-format config; the repo's odb is untouched.
fn index_pack_bytes(repo: &Path, bytes: &[u8]) -> Result<Pack> {
    let scratch = Scratch::new()?;
    let pack_path = scratch.dir.join("out.pack");
    let idx_path = scratch.dir.join("out.idx");
    git_capture(
        repo,
        &[
            "index-pack",
            "--stdin",
            "-o",
            &idx_path.to_string_lossy(),
            &pack_path.to_string_lossy(),
        ],
        Some(bytes),
    )?;
    Pack::from_files(&pack_path, &idx_path)
}

/// Consolidate every object reachable from all refs into one optimized,
/// self-contained pack (the `git repack -adf` equivalent). Non-destructive: the
/// repo's object store is untouched. The result has 0 `REF_DELTA` and all OFS bases
/// earlier in the pack.
pub fn repack_all(repo: &Path) -> Result<Pack> {
    let consolidated = git_capture(
        repo,
        &[
            "pack-objects",
            "--all",
            "--stdout",
            "--delta-base-offset",
            "--window=50",
        ],
        None,
    )?;

    // Index the (already self-contained) pack to get a matching .idx. Written to a
    // scratch path; `index-pack --stdin` requires a repository as its cwd (for the
    // object-format config) but with an explicit -o/pack path the repo odb is untouched.
    let scratch = Scratch::new()?;
    let pack_path = scratch.dir.join("repack.pack");
    let idx_path = scratch.dir.join("repack.idx");
    git_capture(
        repo,
        &[
            "index-pack",
            "--stdin",
            "-o",
            &idx_path.to_string_lossy(),
            &pack_path.to_string_lossy(),
        ],
        Some(&consolidated),
    )?;

    Pack::from_files(&pack_path, &idx_path)
}

/// Materialize a set of self-contained packs into a fresh scratch repo, point refs at
/// `tips`, and consolidate everything reachable into one optimized pack (repack/GC).
///
/// This is the repack path when the objects live *off the local disk* — on Platform
/// `chunk` docs or an external backend. Each blob in `packs` is a complete packfile
/// (`index-pack`'d into the scratch odb); `tips` are the hex OIDs the repo's refs resolve
/// to, planted under `refs/repack/N` so `pack-objects --all` walks exactly the reachable
/// graph (unreachable objects are dropped — true GC). The scratch repo is
/// removed on return; the caller's repositories are never touched.
pub fn repack_from_packs(packs: &[Vec<u8>], tips: &[&str]) -> Result<Pack> {
    if packs.is_empty() {
        return Err(Error::Config("repack_from_packs: no input packs".into()));
    }
    let scratch = Scratch::new()?;
    let repo = scratch.dir.join("repo.git");
    fs::create_dir_all(&repo).map_err(|e| Error::Io(e.to_string()))?;
    git_capture(&repo, &["init", "--bare", "-q"], None)?;

    // Absorb every source pack into the scratch odb. `index-pack --stdin` (no `-o`, no
    // explicit pack path) writes pack-<hash>.pack + its .idx straight into objects/pack, so
    // `update-ref` and `pack-objects --all` can resolve the objects. Inputs are
    // self-contained, so no `--fix-thin` is needed.
    for bytes in packs {
        git_capture(&repo, &["index-pack", "--stdin"], Some(bytes))?;
    }

    // Plant a ref per resolved tip so `pack-objects --all` sees the reachable graph. The
    // generic `refs/repack/*` namespace (not `refs/heads/*`) holds tips of *any* object
    // type — a `refUpdate` tip can be an annotated-tag object, which a branch ref rejects
    // ("non-commit object to branch"); `pack-objects --all` still walks every ref under
    // `refs/`, peeling tags to their commits.
    for (i, tip) in tips.iter().enumerate() {
        ensure_safe_rev(tip)?;
        git_capture(
            &repo,
            &["update-ref", &format!("refs/repack/{i}"), tip],
            None,
        )?;
    }

    repack_all(&repo)
}

/// Reject a revision/ref string that git's CLI (or `--revs` stdin) could misparse.
///
/// `refName` is an arbitrary ≤255-char Platform string that never passed
/// `git check-ref-format`, so a `refUpdate` can legally carry e.g. `-x` or `--all`.
/// As an argv token that is an option; as a `pack-objects --revs` stdin line an
/// embedded newline injects extra rev-list args. Legitimate OIDs are hex and refs may
/// not begin with `-`, so this rejects: empty, a leading `-`, or any ASCII control
/// character (including newline). Callers guard before the string reaches `Command`.
pub fn ensure_safe_rev(rev: &str) -> Result<()> {
    if rev.is_empty() {
        return Err(Error::Config("empty revision".into()));
    }
    if rev.starts_with('-') {
        return Err(Error::Config(format!(
            "unsafe revision {rev:?}: begins with '-' (would be read as a git option)"
        )));
    }
    if rev.bytes().any(|b| b < 0x20) {
        return Err(Error::Config(format!(
            "unsafe revision {rev:?}: contains a control character"
        )));
    }
    Ok(())
}

/// Repository-location variables git exports to hooks and remote helpers. Every call here
/// names its repository explicitly (`-C <cwd>`), so these must not leak into the child:
/// under `git push`, the helper inherits `GIT_DIR=<user repo>`, and git honours `GIT_DIR`
/// over `-C` — so `git -C <scratch> init --bare` re-initialised the USER's repository as
/// bare (`core.bare = true`) and the scratch-odb `index-pack`/`pack-objects` ran against it.
const REPO_LOCATION_ENV: [&str; 6] = [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_COMMON_DIR",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
];

/// `git -C <cwd> <args>` with the inherited repo-location variables cleared, so the
/// repository is exactly `cwd`.
fn git_at(cwd: &Path, args: &[&str]) -> Command {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(cwd).args(args);
    for var in REPO_LOCATION_ENV {
        cmd.env_remove(var);
    }
    cmd
}

/// Run `git -C <cwd> <args>` feeding `stdin`, returning captured stdout on success. The
/// repository is exactly `cwd` — inherited repo-location variables are cleared.
pub(super) fn git_capture(cwd: &Path, args: &[&str], stdin: Option<&[u8]>) -> Result<Vec<u8>> {
    let mut cmd = git_at(cwd, args);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    cmd.stdin(if stdin.is_some() {
        Stdio::piped()
    } else {
        Stdio::null()
    });

    let mut child = cmd
        .spawn()
        .map_err(|e| Error::Io(format!("spawn git: {e}")))?;
    if let Some(data) = stdin {
        child
            .stdin
            .take()
            .ok_or_else(|| Error::Io("git stdin unavailable".into()))?
            .write_all(data)
            .map_err(|e| Error::Io(format!("write git stdin: {e}")))?;
    }
    let out = child
        .wait_with_output()
        .map_err(|e| Error::Io(format!("wait git: {e}")))?;
    if !out.status.success() {
        return Err(Error::Io(format!(
            "git {} failed: {}",
            args.first().copied().unwrap_or_default(),
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }
    Ok(out.stdout)
}

/// A uniquely-named scratch directory removed on drop. Avoids a runtime `tempfile`
/// dependency (that crate is dev-only) for the temp files `index-pack` writes.
struct Scratch {
    dir: PathBuf,
}

impl Scratch {
    fn new() -> Result<Self> {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos());
        let dir = std::env::temp_dir().join(format!("forge-pack-{}-{}", std::process::id(), nanos));
        fs::create_dir_all(&dir).map_err(|e| Error::Io(e.to_string()))?;
        // Transient packfile bytes should not be world-readable.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))
                .map_err(|e| Error::Io(e.to_string()))?;
        }
        Ok(Self { dir })
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}
