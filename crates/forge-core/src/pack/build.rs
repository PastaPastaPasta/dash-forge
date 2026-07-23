//! Pack creation by shelling out to the system `git` binary.
//!
//! Two entry points mirror the two producers in the push / repack flows:
//!
//! - [`build_pack`] — the *push* path. `git pack-objects --thin` computes a thin pack
//!   (deltas allowed against objects the receiver already has), then
//!   `git index-pack --fix-thin` materializes those external bases so the **stored
//!   pack is self-contained** (data-contracts §2.3). The thin/fixed byte delta is the
//!   measurable *fix-thin premium*.
//! - [`repack_all`] — the *repack* path. `git pack-objects --all` (non-thin, with
//!   `--delta-base-offset`) produces one consolidated pack with **0 `REF_DELTA`** and
//!   every OFS base earlier in the same pack — the invariant the `objectLocator`
//!   single-span read depends on. It is non-destructive (never rewrites the repo odb).
//!
//! git subcommands used, and why: `pack-objects` (delta compute), `index-pack`
//! (`--fix-thin` completion + `.idx` generation). No `verify-pack` in the library
//! path — see `parse.rs`.

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
        Ok(Self {
            bytes,
            idx_bytes,
            parsed,
        })
    }
}

/// The result of [`build_pack`]: the self-contained pack plus the thin/fixed sizes
/// that quantify the fix-thin premium.
pub struct BuildReport {
    /// The completed, self-contained pack.
    pub pack: Pack,
    /// Bytes of the raw thin pack from `pack-objects` (before completion).
    pub thin_size: usize,
    /// Bytes of the completed pack after `index-pack --fix-thin`.
    pub fixed_size: usize,
}

impl BuildReport {
    /// The fix-thin premium: fraction of extra bytes materialized to make the pack
    /// self-contained (`(fixed - thin) / thin`). S0.5 measured 0.9–4.4% for normal
    /// pushes. `0.0` when the thin pack was already self-contained.
    #[allow(clippy::cast_precision_loss)] // ratio of byte counts; f64 precision ample
    pub fn premium_ratio(&self) -> f64 {
        if self.thin_size == 0 {
            return 0.0;
        }
        let extra = self.fixed_size.saturating_sub(self.thin_size);
        extra as f64 / self.thin_size as f64
    }
}

/// Build a self-contained pack carrying the objects reachable from `want_tips` but
/// not from `have_bases` (the push delta). The pack is thin on the wire and completed
/// locally via `index-pack --fix-thin`, exactly as a git server does on receive.
///
/// `want_tips` / `have_bases` are revision names (OIDs or refs) understood by git.
pub fn build_pack(repo: &Path, want_tips: &[&str], have_bases: &[&str]) -> Result<BuildReport> {
    if want_tips.is_empty() {
        return Err(Error::Config("build_pack: no want tips".into()));
    }
    let mut revs = String::new();
    for t in want_tips {
        revs.push_str(t);
        revs.push('\n');
    }
    for b in have_bases {
        revs.push('^');
        revs.push_str(b);
        revs.push('\n');
    }

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

    let scratch = Scratch::new()?;
    let pack_path = scratch.dir.join("out.pack");
    let idx_path = scratch.dir.join("out.idx");
    // --fix-thin resolves external bases against the source repo's odb.
    git_capture(
        repo,
        &[
            "index-pack",
            "--fix-thin",
            "--stdin",
            "-o",
            &idx_path.to_string_lossy(),
            &pack_path.to_string_lossy(),
        ],
        Some(&thin),
    )?;

    let pack = Pack::from_files(&pack_path, &idx_path)?;
    let fixed_size = pack.bytes.len();
    Ok(BuildReport {
        pack,
        thin_size: thin.len(),
        fixed_size,
    })
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
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("forge-pack-{}-{}", std::process::id(), nanos));
        fs::create_dir_all(&dir).map_err(|e| Error::Io(e.to_string()))?;
        Ok(Self { dir })
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}
