//! Thin wrappers over the system `git` binary for the helper's local-repo side.
//!
//! Two environments are used, and keeping them apart is load-bearing:
//!
//! - **Local repo** ops (`rev-parse`, `cat-file`, `merge-base`, `index-pack` into the odb)
//!   inherit the environment git set when it spawned the helper — in particular `GIT_DIR`,
//!   which points at the repository being cloned/pushed. These write to / read from that
//!   repo.
//! - **Scratch repo** ops (a temporary bare repo used to re-filter a pack for partial
//!   clone) must **not** see `GIT_DIR`/`GIT_WORK_TREE`, or they would operate on the wrong
//!   store; those are always run with the inherited pointers cleared and an explicit `-C`.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use anyhow::{anyhow, bail, Result};
use std::io::Write as _;

/// Run `git <args>`, optionally in `cwd`, optionally with the ambient `GIT_DIR`/
/// `GIT_WORK_TREE` cleared, optionally feeding `stdin`. Returns captured stdout on a zero
/// exit; a non-zero exit is an error carrying git's stderr.
fn run_git(
    args: &[&str],
    cwd: Option<&Path>,
    clear_git_dir: bool,
    stdin: Option<&[u8]>,
) -> Result<Vec<u8>> {
    let mut cmd = Command::new("git");
    // Use the OS process cwd rather than `git -C` to avoid arg-ordering pitfalls.
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    cmd.args(args);
    if clear_git_dir {
        cmd.env_remove("GIT_DIR");
        cmd.env_remove("GIT_WORK_TREE");
    }
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    cmd.stdin(if stdin.is_some() {
        Stdio::piped()
    } else {
        Stdio::null()
    });

    let mut child = cmd.spawn().map_err(|e| anyhow!("spawn git: {e}"))?;
    if let Some(data) = stdin {
        child
            .stdin
            .take()
            .ok_or_else(|| anyhow!("git stdin unavailable"))?
            .write_all(data)
            .map_err(|e| anyhow!("write git stdin: {e}"))?;
    }
    let out = child
        .wait_with_output()
        .map_err(|e| anyhow!("wait git: {e}"))?;
    if !out.status.success() {
        bail!(
            "git {} failed: {}",
            args.first().copied().unwrap_or_default(),
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    Ok(out.stdout)
}

/// Run a git command whose exit *status* is the answer (0 → true, non-zero → false),
/// never an error. Used for the boolean predicates `cat-file -e` / `merge-base
/// --is-ancestor`.
fn run_git_status(args: &[&str]) -> bool {
    Command::new("git")
        .args(args)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .stdin(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// The local repository the helper reads objects from and writes fetched packs into. All
/// methods operate on the repo `GIT_DIR` points at (inherited from git).
pub struct LocalRepo;

impl LocalRepo {
    /// Resolve `rev` (a ref name or oid) to a 40-hex object id, or `None` if it does not
    /// resolve. Does **not** peel — a ref pointing at an annotated tag resolves to the tag
    /// object (so the tag itself is packed on push).
    pub fn rev_parse(rev: &str) -> Option<String> {
        let out = run_git(&["rev-parse", "--verify", "-q", rev], None, false, None).ok()?;
        let s = String::from_utf8_lossy(&out).trim().to_string();
        if s.is_empty() {
            None
        } else {
            Some(s)
        }
    }

    /// Whether object `oid` is present in the local odb.
    pub fn object_exists(oid: &str) -> bool {
        run_git_status(&["cat-file", "-e", oid])
    }

    /// Whether commit `ancestor` is an ancestor of (or equal to) commit `descendant`.
    /// `false` if either object is missing locally (cannot prove a fast-forward).
    pub fn is_ancestor(ancestor: &str, descendant: &str) -> bool {
        if !Self::object_exists(ancestor) || !Self::object_exists(descendant) {
            return false;
        }
        run_git_status(&["merge-base", "--is-ancestor", ancestor, descendant])
    }

    /// Index a self-contained pack into the local odb, returning the pack's sha. Feeds the
    /// bytes to `git index-pack --stdin --fix-thin` (our stored packs are already
    /// self-contained, so `--fix-thin` is a no-op safety net).
    pub fn index_pack(pack_bytes: &[u8]) -> Result<String> {
        let out = run_git(
            &["index-pack", "--stdin", "--fix-thin"],
            None,
            false,
            Some(pack_bytes),
        )?;
        let s = String::from_utf8_lossy(&out);
        s.split_whitespace()
            .last()
            .map(str::to_string)
            .ok_or_else(|| anyhow!("index-pack produced no pack sha"))
    }

    /// The local `GIT_DIR`, canonicalized to an absolute path. Falls back to `.git` under
    /// the current directory when the env var is unset (manual invocation).
    pub fn git_dir() -> Result<PathBuf> {
        let raw = std::env::var_os("GIT_DIR").map_or_else(|| PathBuf::from(".git"), PathBuf::from);
        std::fs::canonicalize(&raw).map_err(|e| anyhow!("resolving GIT_DIR {}: {e}", raw.display()))
    }

    /// Write the empty `.promisor` marker beside a fetched promisor pack so git tolerates
    /// the objects a partial-clone filter omitted (S0.9).
    pub fn write_promisor_marker(pack_sha: &str) -> Result<()> {
        let dir = Self::git_dir()?;
        let path = dir
            .join("objects")
            .join("pack")
            .join(format!("pack-{pack_sha}.promisor"));
        std::fs::write(&path, b"").map_err(|e| anyhow!("writing {}: {e}", path.display()))?;
        Ok(())
    }
}

/// A throwaway bare repo used to re-filter downloaded packs for a partial clone. The
/// downloaded (full) packs are indexed in, then `pack-objects --revs --filter` produces
/// exactly the filtered subset git asked for. Removed on drop.
pub struct ScratchRepo {
    dir: PathBuf,
}

impl ScratchRepo {
    /// Create and `git init --bare` a fresh scratch repo.
    pub fn init() -> Result<Self> {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir =
            std::env::temp_dir().join(format!("git-remote-dash-{}-{}", std::process::id(), nanos));
        std::fs::create_dir_all(&dir).map_err(|e| anyhow!("mkdir scratch: {e}"))?;
        run_git(&["init", "--bare", "-q"], Some(&dir), true, None)?;
        Ok(Self { dir })
    }

    /// Index a self-contained pack into the scratch odb.
    pub fn index_pack(&self, pack_bytes: &[u8]) -> Result<()> {
        run_git(
            &["index-pack", "--stdin", "--fix-thin"],
            Some(&self.dir),
            true,
            Some(pack_bytes),
        )?;
        Ok(())
    }

    /// Produce a self-contained pack of the objects reachable from `want_oids`, applying an
    /// optional `filter` (e.g. `blob:none`). A bare blob/tree oid named as a want survives
    /// the filter and is returned alone; a commit want walks history with the filter
    /// applied — the single code path S0.9 validated for both initial and lazy fetches.
    pub fn pack_filtered(&self, want_oids: &[String], filter: Option<&str>) -> Result<Vec<u8>> {
        let mut revs = String::new();
        for oid in want_oids {
            revs.push_str(oid);
            revs.push('\n');
        }
        let filter_arg = filter.map(|f| format!("--filter={f}"));
        let mut args: Vec<&str> = vec!["pack-objects", "--revs", "--stdout", "--delta-base-offset"];
        if let Some(fa) = &filter_arg {
            args.push(fa);
        }
        run_git(&args, Some(&self.dir), true, Some(revs.as_bytes()))
    }
}

impl Drop for ScratchRepo {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}
