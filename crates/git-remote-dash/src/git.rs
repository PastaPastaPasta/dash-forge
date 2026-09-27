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
use forge_core::pack::ensure_safe_rev;
use std::io::Write as _;

/// How every downloaded pack is checked as it is indexed: git's own object checks (the ones
/// `git fsck --strict` and `index-pack --strict` run — tree order, `.git` look-alikes,
/// `.gitmodules` URLs and paths, idents and dates, ...), so a hostile pack is refused
/// before any of it lands in the odb, even with `transfer.fsckObjects` off.
///
/// Not `--strict`: that also requires every object a pack's commits and trees name to be in
/// this pack or already in the odb, and a repo's history is split across packs indexed one
/// at a time in no guaranteed order, so a valid multi-pack fetch would fail. Connectivity is
/// checked by git itself once the fetch completes.
pub(crate) const INDEX_PACK_CHECKS: &str = "--fsck-objects";

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

/// `git config --get <key>` in the helper's environment (the repo git spawned it for, then
/// global/system config, plus any `git -c key=value` the user passed, which git forwards
/// to the helper). `None` when the key is unset or git fails.
pub fn config_get(key: &str) -> Option<String> {
    let out = run_git(&["config", "--get", key], None, false, None).ok()?;
    let value = String::from_utf8(out).ok()?.trim().to_string();
    (!value.is_empty()).then_some(value)
}

/// Whether the history reachable from `oids` provably lacks an object, not counting history
/// the repository's refs already reach: git's own post-fetch connectivity check
/// (`rev-list --objects --stdin --not --all`) failing on a missing or bad object. Anything
/// else (git not runnable, an unsafe rev, another error) is `false`: git's own check after
/// the fetch then decides, rather than a pack being blamed for it. Like git's own check, it
/// takes the history local refs already reach as complete. `partial`: allow objects a
/// promisor remote promised (`--missing=allow-promisor`). `repo`: that repository's
/// directory (tests), else the one git spawned the helper for. A missing object is never
/// fetched: a lazy fetch here would re-enter this helper.
fn objects_missing(oids: &[String], repo: Option<&Path>, partial: bool) -> bool {
    if oids.iter().any(|oid| ensure_safe_rev(oid).is_err()) {
        return false;
    }
    let input = oids.iter().fold(String::new(), |mut s, oid| {
        s.push_str(oid);
        s.push('\n');
        s
    });
    let mut cmd = Command::new("git");
    if let Some(dir) = repo {
        cmd.current_dir(dir)
            .env_remove("GIT_DIR")
            .env_remove("GIT_WORK_TREE");
    }
    cmd.args(["rev-list", "--objects", "--quiet"]);
    if partial {
        cmd.arg("--missing=allow-promisor");
    }
    let child = cmd
        .args(["--stdin", "--not", "--all"])
        .env("GIT_NO_LAZY_FETCH", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn();
    let Ok(mut child) = child else { return false };
    // rev-list reads all of stdin before it walks, so writing first cannot deadlock.
    if let Some(mut stdin) = child.stdin.take() {
        if stdin.write_all(input.as_bytes()).is_err() {
            let _ = child.wait();
            return false;
        }
    }
    let Ok(out) = child.wait_with_output() else {
        return false;
    };
    // `fatal: missing blob object …`, `fatal: bad tree object …`, `fatal: bad object …`.
    let stderr = String::from_utf8_lossy(&out.stderr);
    !out.status.success()
        && (stderr.contains("missing ") || stderr.contains("bad ") && stderr.contains("object"))
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
        .is_ok_and(|s| s.success())
}

/// The local repository the helper reads objects from and writes fetched packs into. All
/// methods operate on the repo `GIT_DIR` points at (inherited from git).
pub struct LocalRepo;

impl LocalRepo {
    /// Resolve `rev` (a ref name or oid) to a 40-hex object id, or `None` if it does not
    /// resolve. Does **not** peel — a ref pointing at an annotated tag resolves to the tag
    /// object (so the tag itself is packed on push).
    pub fn rev_parse(rev: &str) -> Option<String> {
        // Defense-in-depth: never let a rev that git's CLI could misparse (leading `-`,
        // embedded control char) reach `git` as an argument.
        ensure_safe_rev(rev).ok()?;
        let out = run_git(&["rev-parse", "--verify", "-q", rev], None, false, None).ok()?;
        let s = String::from_utf8_lossy(&out).trim().to_string();
        if s.is_empty() {
            None
        } else {
            Some(s)
        }
    }

    /// `git config --show-scope --get <key>` for the repo being pushed (inheriting
    /// `GIT_DIR`, so repo-local, global and `-c` values all apply): `(scope, value)` where
    /// scope is `local`,
    /// `worktree`, `global`, `system` or `command` (`-c`). `None` when unset.
    ///
    /// On a git without `--show-scope` (< 2.26) the value is still read, via plain
    /// `--get` (see [`forge_core::storage::policy::git_config_scoped`]) — never dropped.
    pub fn config_get_scoped(key: &str) -> Option<(String, String)> {
        forge_core::storage::policy::git_config_scoped(key)
    }

    /// Whether object `oid` is present in the local odb.
    pub fn object_exists(oid: &str) -> bool {
        if ensure_safe_rev(oid).is_err() {
            return false;
        }
        run_git_status(&["cat-file", "-e", oid])
    }

    /// Whether the local odb provably lacks an object reachable from `oids`: git's own
    /// post-fetch connectivity check, run first so a gap can be explained
    /// ([`objects_missing`]). In a partial clone, objects its filter left out are missing by
    /// design, so only an object nothing promised counts (`--missing=allow-promisor`).
    pub fn history_has_gaps(oids: &[String]) -> bool {
        let partial = config_get("extensions.partialclone").is_some();
        objects_missing(oids, None, partial)
    }

    /// Whether commit `ancestor` is an ancestor of (or equal to) commit `descendant`.
    /// `false` if either object is missing locally (cannot prove a fast-forward).
    pub fn is_ancestor(ancestor: &str, descendant: &str) -> bool {
        if ensure_safe_rev(ancestor).is_err() || ensure_safe_rev(descendant).is_err() {
            return false;
        }
        if !Self::object_exists(ancestor) || !Self::object_exists(descendant) {
            return false;
        }
        run_git_status(&["merge-base", "--is-ancestor", ancestor, descendant])
    }

    /// Index a self-contained pack into the local odb, returning the pack's sha. Feeds the
    /// bytes to `git index-pack --stdin --fix-thin` with [`INDEX_PACK_CHECKS`] (our stored
    /// packs are already self-contained, so `--fix-thin` is a no-op safety net).
    pub fn index_pack(pack_bytes: &[u8]) -> Result<String> {
        let out = run_git(
            &["index-pack", "--stdin", "--fix-thin", INDEX_PACK_CHECKS],
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
            .map_or(0, |d| d.as_nanos());
        let dir =
            std::env::temp_dir().join(format!("git-remote-dash-{}-{}", std::process::id(), nanos));
        std::fs::create_dir_all(&dir).map_err(|e| anyhow!("mkdir scratch: {e}"))?;
        run_git(&["init", "--bare", "-q"], Some(&dir), true, None)?;
        Ok(Self { dir })
    }

    /// Index a self-contained pack into the scratch odb, with [`INDEX_PACK_CHECKS`].
    pub fn index_pack(&self, pack_bytes: &[u8]) -> Result<()> {
        run_git(
            &["index-pack", "--stdin", "--fix-thin", INDEX_PACK_CHECKS],
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

#[cfg(test)]
mod tests {
    use super::{objects_missing, run_git, ScratchRepo};
    use std::path::Path;

    /// Write `body` into `repo` as a loose object of `kind`, without git's checks.
    fn put(repo: &Path, kind: &str, body: &[u8]) -> String {
        let out = run_git(
            &["hash-object", "--literally", "-w", "-t", kind, "--stdin"],
            Some(repo),
            true,
            Some(body),
        )
        .unwrap();
        String::from_utf8(out).unwrap().trim().to_string()
    }

    fn entry(mode: &str, name: &str, oid: &str) -> Vec<u8> {
        let mut e = format!("{mode} {name}\0").into_bytes();
        e.extend(hex::decode(oid).unwrap());
        e
    }

    fn commit_text(tree: &str, parent: Option<&str>, when: u32) -> String {
        let parent = parent.map_or(String::new(), |p| format!("parent {p}\n"));
        format!("tree {tree}\n{parent}author A <a@b> {when} +0000\ncommitter A <a@b> {when} +0000\n\nm\n")
    }

    /// `git pack-objects --revs` of `revs` in `repo` (it does not check objects).
    fn pack(repo: &Path, revs: &str) -> Vec<u8> {
        run_git(
            &["pack-objects", "--revs", "--stdout"],
            Some(repo),
            true,
            Some(revs.as_bytes()),
        )
        .unwrap()
    }

    /// Builds a tree's entry bytes, writing the objects they name into the given repo.
    type TreeEntries = dyn Fn(&Path) -> Vec<u8>;

    /// A self-contained pack of one commit whose root tree is `entries`.
    fn pack_with(entries: &TreeEntries) -> Vec<u8> {
        let dir = tempfile::tempdir().unwrap();
        run_git(&["init", "-q", "--bare"], Some(dir.path()), true, None).unwrap();
        let tree = put(dir.path(), "tree", &entries(dir.path()));
        let commit = put(dir.path(), "commit", commit_text(&tree, None, 1).as_bytes());
        pack(dir.path(), &format!("{commit}\n"))
    }

    #[test]
    fn a_well_formed_pack_indexes() {
        let pack = pack_with(&|d| entry("100644", "a.txt", &put(d, "blob", b"a\n")));
        ScratchRepo::init().unwrap().index_pack(&pack).unwrap();
    }

    #[test]
    fn hostile_packs_are_refused_before_they_land() {
        let gitmodules = |d: &Path| {
            let url = b"[submodule \"x\"]\n\tpath = x\n\turl = --upload-pack=touch /tmp/pwn\n";
            entry("100644", ".gitmodules", &put(d, "blob", url))
        };
        let dot_git = |d: &Path| entry("100644", ".GIT", &put(d, "blob", b"a\n"));
        let ntfs_symlink = |d: &Path| entry("120000", "gi7eba~1", &put(d, "blob", b"x"));
        let unsorted = |d: &Path| {
            let b = put(d, "blob", b"a\n");
            [entry("100644", "b", &b), entry("100644", "a", &b)].concat()
        };
        let cases: [(&str, &TreeEntries); 4] = [
            ("a .gitmodules whose url is an option", &gitmodules),
            ("a .git look-alike", &dot_git),
            (
                "a .gitmodules symlink under its NTFS short name",
                &ntfs_symlink,
            ),
            ("an unsorted tree", &unsorted),
        ];
        for (label, entries) in cases {
            let indexed = ScratchRepo::init().unwrap().index_pack(&pack_with(entries));
            assert!(indexed.is_err(), "{label} was indexed");
        }
    }

    #[test]
    fn packs_split_across_a_fetch_index_in_any_order() {
        // History is split over packs indexed one at a time: a pack whose commit names a
        // parent in a pack not yet indexed must still index (connectivity is git's check
        // after the fetch), or valid multi-pack fetches would fail.
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        run_git(&["init", "-q", "--bare"], Some(d), true, None).unwrap();
        let t1 = put(d, "tree", &entry("100644", "a", &put(d, "blob", b"1\n")));
        let c1 = put(d, "commit", commit_text(&t1, None, 1).as_bytes());
        let t2 = put(d, "tree", &entry("100644", "a", &put(d, "blob", b"2\n")));
        let c2 = put(d, "commit", commit_text(&t2, Some(&c1), 2).as_bytes());
        let first = pack(d, &format!("{c1}\n"));
        let second = pack(d, &format!("{c2}\n^{c1}\n"));
        let scratch = ScratchRepo::init().unwrap();
        scratch.index_pack(&second).unwrap();
        scratch.index_pack(&first).unwrap();
    }

    fn git(dir: &std::path::Path, args: &[&str]) -> String {
        let out = std::process::Command::new("git")
            .current_dir(dir)
            .env_remove("GIT_DIR")
            .env_remove("GIT_WORK_TREE")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .args(args)
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}: {out:?}");
        String::from_utf8(out.stdout).unwrap().trim().to_string()
    }

    #[test]
    fn a_missing_object_in_the_wanted_history_is_detected() {
        // The check the helper runs before git's own, so a gap is reported as E503 (D-403).
        let t = tempfile::tempdir().unwrap();
        let d = t.path();
        git(d, &["init", "-q", "-b", "main"]);
        std::fs::write(d.join("a.txt"), "alpha\n").unwrap();
        git(d, &["add", "a.txt"]);
        git(
            d,
            &[
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@t",
                "commit",
                "-q",
                "-m",
                "one",
            ],
        );
        let tip = git(d, &["rev-parse", "HEAD"]);
        let blob = git(d, &["rev-parse", "HEAD:a.txt"]);
        // Unreferenced, as a fetched commit is before git writes the ref.
        git(d, &["update-ref", "-d", "refs/heads/main"]);
        assert!(!objects_missing(std::slice::from_ref(&tip), Some(d), false));
        let obj = d.join(".git/objects").join(&blob[..2]).join(&blob[2..]);
        std::fs::remove_file(obj).unwrap();
        assert!(
            objects_missing(std::slice::from_ref(&tip), Some(d), false),
            "the blob is gone"
        );
        // In partial-clone mode an object no promisor promised is still a gap.
        assert!(
            objects_missing(std::slice::from_ref(&tip), Some(d), true),
            "not promised"
        );
        assert!(
            !objects_missing(&["-bad".to_string()], Some(d), false),
            "an unsafe rev is not reported as a missing object"
        );
        let not_a_repo = tempfile::tempdir().unwrap();
        assert!(
            !objects_missing(&[blob], Some(not_a_repo.path()), false),
            "a git failure that is not a missing object is left to git's own check"
        );
    }
}
