//! Pack creation by shelling out to the system `git` binary.
//!
//! Two entry points mirror the two producers in the push / repack flows. Both emit a
//! **locator-quality** pack: 0 `REF_DELTA`, every OFS delta base earlier in the same pack,
//! every object's delta chain contiguous. That is the invariant the `objectLocator`
//! single-span read depends on, and [`Pack::from_files`] enforces it on the way out, so no
//! pack this module produces can ever be stored un-indexable.
//!
//! - [`build_pack`] — the *push* path. `git pack-objects --revs --delta-base-offset` over
//!   `want ^have` produces the push delta as a self-contained pack.
//! - [`repack_all`] — the *repack* path. `git pack-objects --all` produces one consolidated
//!   pack over the whole reachable graph. Non-destructive (never rewrites the repo odb).
//!
//! NO `--thin` / `--fix-thin` (changed, with measurements — see [`build_pack`]).
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
    fn from_files(pack_path: &Path, idx_path: &Path) -> Result<Self> {
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

/// Build a self-contained pack carrying the objects reachable from `want_tips` but not from
/// `have_bases` (the push delta), with `--delta-base-offset` so every delta base sits
/// earlier in the same pack. The result is locator-quality: it can be indexed for the
/// browse plane the moment it is stored.
///
/// `want_tips` / `have_bases` are revision names (OIDs or refs) understood by git.
///
/// ## Why no `--thin` / `--fix-thin`
///
/// This path used to mirror a git *server*: compute a thin pack (deltas allowed against
/// objects the receiver already has), then complete it with `index-pack --fix-thin` so the
/// stored pack is self-contained. That mirrors the wrong thing. A git server does it
/// because the thin pack is what crossed the network and the completion is pure local
/// repair. Here there is no wire step — the pack this function computes is byte-for-byte
/// the pack that gets chunked and paid for — so `--thin` buys nothing and `--fix-thin`
/// *appends the external delta bases in full*, duplicating objects that are already stored
/// in an earlier pack, and appends them AFTER the deltas that reference them, leaving
/// `REF_DELTA` + non-contiguous objects that [`ObjectLocator::build`](super::ObjectLocator::build)
/// must refuse.
///
/// So it cost bytes *and* forfeited the browse index. Measured stored-pack size,
/// non-thin ÷ fix-thin'd (this repo's history, and a synthetic repo for the edge cases):
///
/// | push shape                        | non-thin ÷ fix-thin'd |
/// |-----------------------------------|-----------------------|
/// | first push (whole history)        | 1.000                 |
/// | 1 commit                          | 0.844                 |
/// | 5 commits                         | 0.880                 |
/// | 20 commits                        | 0.877                 |
/// | 55 commits that only ADD files    | 1.000                 |
/// | 20 commits editing one large file | 0.980                 |
///
/// Never larger, up to 16% smaller. The two 1.000 rows are the cases with no external
/// delta base at all, where `--thin` was already a no-op — which is also why the
/// previously published "fix-thin premium: 0.9–4.4%" reads so low: it is
/// `(fixed - thin) / thin`, a ratio against a pack that is never stored, measured on
/// add-only pushes. Against the pack that would otherwise be stored, completion costs
/// 0–19%.
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

    let pack_bytes = git_capture(
        repo,
        &["pack-objects", "--revs", "--stdout", "--delta-base-offset"],
        Some(revs.as_bytes()),
    )?;

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
        Some(&pack_bytes),
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

/// Run `git -C <cwd> <args>` feeding `stdin`, returning captured stdout on success.
pub(super) fn git_capture(cwd: &Path, args: &[&str], stdin: Option<&[u8]>) -> Result<Vec<u8>> {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(cwd).args(args);
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
