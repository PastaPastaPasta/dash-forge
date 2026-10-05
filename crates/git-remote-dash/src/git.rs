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
use forge_core::pack::{ensure_safe_rev, fsck, run_feeding};
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
    let out = git_output(args, cwd, clear_git_dir, stdin)?;
    if !out.status.success() {
        bail!(
            "git {} failed: {}",
            args.first().copied().unwrap_or_default(),
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    Ok(out.stdout)
}

/// [`run_git`]'s run, returning git's output whether it succeeded or not. stdin is fed while
/// the output is drained ([`forge_core::pack::run_feeding`]), so a git that writes a lot
/// before reading all its input cannot deadlock; a stdin write error is only an error when
/// git itself succeeded (a git that stops reading has its own error on stderr).
fn git_output(
    args: &[&str],
    cwd: Option<&Path>,
    clear_git_dir: bool,
    stdin: Option<&[u8]>,
) -> Result<std::process::Output> {
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
    let (out, written) = run_feeding(&mut cmd, stdin).map_err(|e| anyhow!("running git: {e}"))?;
    if out.status.success() {
        written.map_err(|e| anyhow!("write git stdin: {e}"))?;
    }
    Ok(out)
}

/// `git <args>` in `repo` (with the inherited `GIT_DIR` cleared), or in the repo git spawned
/// the helper for when `None`; stdout on success, git's stderr as the error otherwise.
pub fn git_in(repo: Option<&Path>, args: &[&str], stdin: Option<&[u8]>) -> Result<Vec<u8>> {
    run_git(args, repo, repo.is_some(), stdin)
}

/// Whether `git <args>` in `repo` (as [`git_in`]) exits 0.
pub fn git_ok_in(repo: Option<&Path>, args: &[&str]) -> bool {
    git_output(args, repo, repo.is_some(), None).is_ok_and(|o| o.status.success())
}

/// What `index-pack --stdin` reported: the pack's sha (its `pack\t<sha>` or `keep\t<sha>`
/// line), and the `.gitmodules`/`.gitattributes` blobs its checks could not read (the oid
/// lines after it: blobs a tree in this pack names, held by a pack not yet indexed).
#[derive(Debug, Default)]
pub struct Indexed {
    /// The pack's sha.
    pub sha: String,
    /// Special-file blobs left to check once every pack is indexed.
    pub unchecked: Vec<String>,
}

/// `git index-pack --stdin --fix-thin` of `pack_bytes`, with the object checks
/// ([`fsck::index_pack_checks`]), in `cwd` (the repo git spawned the helper for when `None`).
/// A refused object is E511.
fn index_checked(pack_bytes: &[u8], cwd: Option<&Path>) -> Result<Indexed> {
    let args = [
        "index-pack",
        "--stdin",
        "--fix-thin",
        fsck::index_pack_checks(),
    ];
    let out = git_output(&args, cwd, cwd.is_some(), Some(pack_bytes))?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    if !out.status.success() {
        if let Some(refused) = fsck::refused(&stderr, false) {
            return Err(refused.into());
        }
        bail!("git index-pack failed: {}", stderr.trim());
    }
    let mut lines = stdout.lines();
    let sha = lines
        .find_map(|l| {
            l.strip_prefix("pack\t")
                .or_else(|| l.strip_prefix("keep\t"))
        })
        .ok_or_else(|| anyhow!("index-pack produced no pack sha"))?;
    Ok(Indexed {
        sha: sha.trim().to_string(),
        unchecked: lines
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .collect(),
    })
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
    !out.status.success() && names_missing_object(&String::from_utf8_lossy(&out.stderr))
}

/// Whether git's error text says an object is absent from the store:
/// `fatal: missing blob object …`, `fatal: bad tree object …`, `fatal: bad object …`
/// (rev-list and pack-objects word it the same way).
pub fn names_missing_object(git_error: &str) -> bool {
    git_error.contains("missing ") && git_error.contains("object")
        || git_error.contains("bad ") && git_error.contains("object")
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
    /// bytes to `git index-pack --stdin --fix-thin` (our stored packs are already
    /// self-contained, so `--fix-thin` is a no-op safety net) with git's object checks at
    /// the severities [`fsck::index_pack_checks`] gives (the classification in
    /// [`forge_core::pack::fsck`]), so a hostile pack is refused before a ref can point at it,
    /// even with `transfer.fsckObjects` off. A refusal is E511.
    ///
    /// Not `--strict`: that also requires every object a pack's commits and trees name to be
    /// in this pack or already in the odb, and a repo's history is split across packs indexed
    /// one at a time in no guaranteed order, so a valid multi-pack fetch would fail.
    /// Connectivity is checked by git itself once the fetch completes.
    ///
    /// A `.gitmodules` blob the pack's trees name but another pack holds cannot be checked
    /// yet: it is returned in [`Indexed::unchecked`] for [`Self::check_blobs`] once every pack
    /// is indexed, as git's fetch-pack does.
    pub fn index_pack(pack_bytes: &[u8]) -> Result<Indexed> {
        index_checked(pack_bytes, None)
    }

    /// Check `.gitmodules` blobs ([`Indexed::unchecked`]) now that every pack of the fetch is
    /// indexed: packed together into a scratch repo whose one tree names each as
    /// `.gitmodules`, and indexed with the object checks, so a hostile one is E511. One whose
    /// blob no pack delivered (a partial clone's filter left it out) is skipped: git fetches
    /// and checks it when it is needed.
    pub fn check_blobs(oids: &[String]) -> Result<()> {
        check_gitmodules_blobs(oids, None)
    }
}

/// [`LocalRepo::check_blobs`] against the repo in `from` (the one git spawned the helper for
/// when `None`).
fn check_gitmodules_blobs(oids: &[String], from: Option<&Path>) -> Result<()> {
    let clear = from.is_some();
    let present: Vec<&String> = oids
        .iter()
        .filter(|oid| {
            ensure_safe_rev(oid).is_ok()
                && run_git(&["cat-file", "-e", oid], from, clear, None).is_ok()
        })
        .collect();
    if present.is_empty() {
        return Ok(());
    }
    // Copied (as read from `from`) into a scratch repo, each under a tree that names it
    // `.gitmodules`, so the checking index-pack reads each as one.
    let scratch = ScratchRepo::init()?;
    let mut revs = String::new();
    for oid in present {
        let body = run_git(&["cat-file", "blob", oid], from, clear, None)?;
        let blob = scratch.put("blob", &body)?;
        let mut tree = b"100644 .gitmodules\0".to_vec();
        tree.extend(hex::decode(&blob).map_err(|e| anyhow!("blob oid {blob}: {e}"))?);
        let tree = scratch.put("tree", &tree)?;
        for oid in [&tree, &blob] {
            revs.push_str(oid);
            revs.push('\n');
        }
    }
    let pack = run_git(
        &["pack-objects", "--stdout"],
        Some(&scratch.dir),
        true,
        Some(revs.as_bytes()),
    )?;
    index_checked(&pack, Some(&ScratchRepo::init()?.dir))?;
    Ok(())
}

impl LocalRepo {
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
        // Two in the same clock tick (threads, or a check inside a fetch) must not collide.
        static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos());
        let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "git-remote-dash-{}-{nanos}-{seq}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).map_err(|e| anyhow!("mkdir scratch: {e}"))?;
        run_git(&["init", "--bare", "-q"], Some(&dir), true, None)?;
        Ok(Self { dir })
    }

    /// Index a self-contained pack into the scratch odb, checked as [`LocalRepo::index_pack`] checks.
    pub fn index_pack(&self, pack_bytes: &[u8]) -> Result<Indexed> {
        index_checked(pack_bytes, Some(&self.dir))
    }

    /// [`LocalRepo::check_blobs`] for the packs indexed into this scratch repo.
    pub fn check_blobs(&self, oids: &[String]) -> Result<()> {
        check_gitmodules_blobs(oids, Some(&self.dir))
    }

    /// Write `body` as a loose object of `kind`, unchecked; its oid.
    fn put(&self, kind: &str, body: &[u8]) -> Result<String> {
        let out = run_git(
            &["hash-object", "-w", "--literally", "-t", kind, "--stdin"],
            Some(&self.dir),
            true,
            Some(body),
        )?;
        Ok(String::from_utf8_lossy(&out).trim().to_string())
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
    use super::{names_missing_object, objects_missing, run_git, ScratchRepo};
    use forge_core::user_error::{codes, UserError};
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
    type TreeEntries<'a> = dyn Fn(&Path) -> Vec<u8> + 'a;

    /// A self-contained pack of one commit whose root tree is `entries`.
    fn pack_with(entries: &TreeEntries<'_>) -> Vec<u8> {
        let dir = tempfile::tempdir().unwrap();
        run_git(&["init", "-q", "--bare"], Some(dir.path()), true, None).unwrap();
        let tree = put(dir.path(), "tree", &entries(dir.path()));
        let commit = put(dir.path(), "commit", commit_text(&tree, None, 1).as_bytes());
        pack(dir.path(), &format!("{commit}\n"))
    }

    /// `err` is an E511 refusal; returns it.
    fn refusal(err: &anyhow::Error) -> &UserError {
        let refused = err
            .downcast_ref::<UserError>()
            .unwrap_or_else(|| panic!("not a user error: {err:#}"));
        assert_eq!(refused.code, codes::OBJECT_REFUSED, "{refused}");
        refused
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
        let cases: [(&str, &TreeEntries<'_>); 4] = [
            ("a .gitmodules whose url is an option", &gitmodules),
            ("a .git look-alike", &dot_git),
            (
                "a .gitmodules symlink under its NTFS short name",
                &ntfs_symlink,
            ),
            ("an unsorted tree", &unsorted),
        ];
        for (label, entries) in cases {
            let err = ScratchRepo::init()
                .unwrap()
                .index_pack(&pack_with(entries))
                .expect_err(label);
            let refused = refusal(&err);
            assert!(
                refused.message.starts_with("git refused object "),
                "{label}: {refused}"
            );
        }
    }

    /// A self-contained pack of one commit over a one-file tree, with this author line (its
    /// text after `author `) and a well-formed committer.
    fn pack_of_commit(author: &str) -> Vec<u8> {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        run_git(&["init", "-q", "--bare"], Some(d), true, None).unwrap();
        let tree = put(
            d,
            "tree",
            &entry("100644", "a.txt", &put(d, "blob", b"a\n")),
        );
        let text =
            format!("tree {tree}\nauthor {author}\ncommitter A <a@b> 1313584730 +0000\n\nm\n");
        let commit = put(d, "commit", text.as_bytes());
        pack(d, &format!("{commit}\n"))
    }

    #[test]
    fn real_histories_with_malformed_idents_index() {
        // psf/requests' 5e6ecdad (`+051800`), and the shapes older tools wrote. A plain
        // `git clone` accepts every one; git's `transfer.fsckObjects` refuses them.
        for (label, author) in [
            ("badTimezone", "Shrikant <s@k> 1313584730 +051800"),
            ("missingSpaceBeforeDate", "A <a@b>1313584730 +0000"),
            ("missingEmail", "A 1313584730 +0000"),
            ("badEmail", "A <a@b 1313584730 +0000"),
            ("missingSpaceBeforeEmail", "A<a@b> 1313584730 +0000"),
            ("zeroPaddedDate", "A <a@b> 01313584730 +0000"),
            ("badDate", "A <a@b> never +0000"),
            ("badDateOverflow", "A <a@b> 99999999999999999999 +0000"),
        ] {
            let pack = pack_of_commit(author);
            ScratchRepo::init()
                .unwrap()
                .index_pack(&pack)
                .unwrap_or_else(|e| panic!("{label}: {e:#}"));
        }
    }

    #[test]
    fn a_refused_object_in_a_large_pack_is_reported_not_a_broken_pipe() {
        // index-pack stops reading at the first refused object; with the rest of a large pack
        // still unwritten the write fails with EPIPE, which used to be the only error shown.
        // Incompressible, so the pack is far larger than a pipe buffer.
        let mut noise = Vec::with_capacity(4 << 20);
        let mut x: u64 = 0x9e37_79b9_7f4a_7c15;
        while noise.len() < 4 << 20 {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            noise.extend_from_slice(&x.to_le_bytes());
        }
        let pack = pack_with(&|d| entry("100644", ".git", &put(d, "blob", &noise)));
        let err = ScratchRepo::init().unwrap().index_pack(&pack).unwrap_err();
        let refused = refusal(&err);
        assert!(refused.to_string().contains("hasDotgit"), "{refused}");
    }

    #[test]
    fn many_malformed_idents_index_without_hanging() {
        // Each malformed line was a warning on index-pack's stderr; with stdin written before
        // stderr was drained, ~560 of them filled the pipe and the fetch hung for ever.
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        run_git(&["init", "-q", "--bare"], Some(d), true, None).unwrap();
        let tree = put(d, "tree", &entry("100644", "a", &put(d, "blob", b"a\n")));
        let mut tip = String::new();
        for i in 0..1500 {
            let parent = if tip.is_empty() {
                String::new()
            } else {
                format!("parent {tip}\n")
            };
            let text = format!("tree {tree}\n{parent}author S <s@k> {i} +051800\ncommitter S <s@k>{i} +051800\n\nc{i}\n");
            tip = put(d, "commit", text.as_bytes());
        }
        let bytes = pack(d, &format!("{tip}\n"));
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send(ScratchRepo::init().unwrap().index_pack(&bytes).map(|_| ()));
        });
        rx.recv_timeout(std::time::Duration::from_secs(60))
            .expect("index-pack hung on a pack with many malformed author lines")
            .unwrap();
    }

    /// A repo with a commit whose tree holds `.gitmodules` = `body`, packed as two packs: the
    /// commit and tree, then the blob alone. Returns (tree pack, blob pack, blob oid).
    fn gitmodules_split(body: &[u8]) -> (Vec<u8>, Vec<u8>, String) {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        run_git(&["init", "-q", "--bare"], Some(d), true, None).unwrap();
        let blob = put(d, "blob", body);
        let tree = put(d, "tree", &entry("100644", ".gitmodules", &blob));
        let commit = put(d, "commit", commit_text(&tree, None, 1).as_bytes());
        let objects = |oids: &[&str]| {
            let list: String = oids.iter().flat_map(|o| [*o, "\n"]).collect();
            run_git(
                &["pack-objects", "--stdout"],
                Some(d),
                true,
                Some(list.as_bytes()),
            )
            .unwrap()
        };
        (objects(&[&commit, &tree]), objects(&[&blob]), blob)
    }

    #[test]
    fn a_hostile_gitmodules_in_another_pack_than_its_tree_is_refused() {
        // The tree's pack cannot check a blob it does not hold; the blob's pack does not know
        // the blob is a .gitmodules. Checked once both are in, as git's fetch-pack does.
        let hostile = b"[submodule \"x\"]\n\tpath = x\n\turl = --upload-pack=touch /tmp/pwn\n";
        let (trees, blobs, blob) = gitmodules_split(hostile);
        let scratch = ScratchRepo::init().unwrap();
        let mut unchecked = scratch.index_pack(&trees).unwrap().unchecked;
        assert_eq!(
            unchecked,
            vec![blob.clone()],
            "the tree pack names the blob it could not check"
        );
        unchecked.extend(scratch.index_pack(&blobs).unwrap().unchecked);
        let err = scratch.check_blobs(&unchecked).unwrap_err();
        assert!(
            refusal(&err).to_string().contains("gitmodulesUrl"),
            "{err:#}"
        );
        // A benign one passes, and a blob no pack delivered (a partial clone) is skipped.
        let (trees, blobs, _) =
            gitmodules_split(b"[submodule \"x\"]\n\tpath = x\n\turl = https://e.com/x\n");
        let scratch = ScratchRepo::init().unwrap();
        let mut unchecked = scratch.index_pack(&trees).unwrap().unchecked;
        scratch.check_blobs(&unchecked).unwrap();
        unchecked.extend(scratch.index_pack(&blobs).unwrap().unchecked);
        scratch.check_blobs(&unchecked).unwrap();
    }

    #[test]
    fn the_pack_sha_is_read_from_its_line_not_the_last_word() {
        // index-pack prints `pack\t<sha>` then the .gitmodules blobs it could not check; the
        // last word is then a blob oid, and a `.promisor` marker was written for it.
        let (trees, _, blob) =
            gitmodules_split(b"[submodule \"x\"]\n\tpath = x\n\turl = https://e.com/x\n");
        let scratch = ScratchRepo::init().unwrap();
        let indexed = scratch.index_pack(&trees).unwrap();
        assert_ne!(indexed.sha, blob);
        let packs = std::fs::read_dir(scratch.dir.join("objects/pack")).unwrap();
        let names: Vec<String> = packs
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert!(
            names.contains(&format!("pack-{}.idx", indexed.sha)),
            "{names:?} vs {}",
            indexed.sha
        );
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

    #[test]
    fn a_filtered_repack_missing_a_tree_names_a_missing_object() {
        // What a set-aside pack does to a partial clone: the filtered walk cannot find a tree.
        let scratch = ScratchRepo::init().unwrap();
        let d = scratch.dir.clone();
        let tree = put(&d, "tree", &entry("100644", "a", &put(&d, "blob", b"1\n")));
        let commit = put(&d, "commit", commit_text(&tree, None, 1).as_bytes());
        std::fs::remove_file(d.join("objects").join(&tree[..2]).join(&tree[2..])).unwrap();
        let err = scratch
            .pack_filtered(&[commit], Some("blob:none"))
            .unwrap_err();
        assert!(names_missing_object(&format!("{err:#}")), "{err:#}");
        assert!(!names_missing_object(
            "fatal: unable to create temporary file"
        ));
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
