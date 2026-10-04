//! Local `git` plumbing for `dg pr` (merge, checkout, diff) and the pure merge planner.
//!
//! Every call runs the `git` on PATH with explicit arguments (never a shell), in an explicit
//! directory. `dash://` fetches and pushes reach `git-remote-dash`, which gets the network and
//! identity source this `dg` invocation resolved through the environment, and the key `dg`
//! already unlocked through an inherited pipe ([`DashEnv`]).

use std::path::Path;
use std::process::Command;

use anyhow::{bail, Context, Result};
use forge_core::keystore::Secret;
use forge_core::network::{NetworkSettings, GIT_NETWORK_KEYS};
use forge_core::platform::Network;
use forge_core::user_error::{codes, UserError};

use crate::context::Ctx;

/// What a `dash://` git command needs from this `dg`: the network and identity-source
/// variables, and the key this run already unlocked. The key goes over a pipe only `git` (and
/// the helper it runs) inherits, never the environment or argv ([`forge_core::key_handoff`]),
/// so a sealed key's passphrase is asked once per `dg` command.
#[derive(Default)]
pub struct DashEnv<'a> {
    vars: Vec<(String, String)>,
    key: Option<&'a Secret>,
}

impl<'a> DashEnv<'a> {
    fn with_key(mut self, key: Option<&'a Secret>) -> Self {
        self.key = key;
        self
    }

    /// A new `git` command with the variables set and the key attached. Built here, never
    /// applied to an existing command: attaching twice would leave a second inheritable pipe
    /// holding the key.
    pub fn git_command(&self) -> Result<Command> {
        self.command("git")
    }

    fn command(&self, program: &str) -> Result<Command> {
        let mut cmd = Command::new(program);
        cmd.envs(self.vars.iter().map(|(k, v)| (k.as_str(), v.as_str())));
        if let Some(key) = self.key {
            forge_core::key_handoff::attach(&mut cmd, key)?;
        }
        Ok(cmd)
    }
}

/// The [`DashEnv`] for `ctx` without the key: the network and the identity source. For a
/// fetch or clone of a public repository, which needs no key, so none is handed over.
pub fn dash_env(ctx: &Ctx) -> DashEnv<'_> {
    let mut vars: Vec<(String, String)> = ctx
        .target
        .env_vars()
        .into_iter()
        .map(|(k, v)| (k.to_string(), v))
        .collect();
    // A file path is made absolute: git runs the helper from another directory (a scratch
    // repo, or the repository root), where a relative path names nothing. A `keychain:` or
    // inline `dfk1:` source is not a path and passes through as it is (an inline key is
    // already in this process's environment or argv, where the user put it).
    if let Some(p) = &ctx.identity_path {
        let value = if forge_core::keystore::is_file_source(p) {
            std::path::absolute(p).unwrap_or_else(|_| p.clone())
        } else {
            p.clone()
        };
        vars.push((
            "DASH_FORGE_KEY".into(),
            value.to_string_lossy().into_owned(),
        ));
    }
    // A `dg` that must not prompt (`--json`) keeps the helper from prompting too.
    if !forge_core::sealed::prompts_allowed() {
        vars.push(("GIT_TERMINAL_PROMPT".into(), "0".into()));
    }
    DashEnv { vars, key: None }
}

/// [`dash_env`] plus the key this run unlocked, for a `dash://` git command that signs (a
/// push) or opens a private repository. The key is handed over only once this run's
/// [`check_helper_key`] has passed: a `git-remote-dash` that would not read it (an older
/// release) never gets it, and asks for the passphrase itself instead.
pub fn dash_env_signing(ctx: &Ctx) -> Result<DashEnv<'_>> {
    let mut env = dash_env(ctx);
    if let Some(key) = ctx.unlocked_key() {
        let identity_id =
            forge_core::keystore::BridgeIdentity::from_source_text(key.expose())?.identity_id;
        if ctx.helper_checked(|| check_helper_key(ctx, &identity_id).is_ok()) {
            env.key = Some(key);
        }
    }
    Ok(env)
}

/// Before anything is paid for: check that the `git-remote-dash` a `git push` will run gets
/// the key and reads it as `identity_id`. On Unix `dg` hands it the key it unlocked (an
/// older helper, or none on PATH, fails here); on Windows there is no handoff, and the helper
/// must be able to ask for a sealed key's passphrase on the console. Otherwise the push would
/// only fail after the create was paid for.
pub fn check_helper_key(ctx: &Ctx, identity_id: &str) -> Result<()> {
    let refuse = |cause: String| -> anyhow::Error {
        UserError::new(
            codes::IDENTITY_UNREADABLE,
            "not published: `git push` could not use your key",
        )
        .cause(cause)
        .fix("install dg and git-remote-dash from the same release (docs/INSTALL.md); `dg doctor` compares their versions")
        .fix("`dg auth status` shows which key source dg uses")
        .note("checked before anything was paid for; nothing was written")
        .into()
    };
    if !cfg!(unix) {
        // No handoff: the helper opens the key source itself, and a sealed file needs its
        // passphrase from the environment or the console.
        let sealed = ctx
            .identity_path
            .as_deref()
            .is_some_and(forge_core::keystore::is_sealed_file);
        return match no_handoff_blocker(sealed, forge_core::sealed::passphrase_available()) {
            Some(cause) => Err(refuse(cause.into())),
            None => Ok(()),
        };
    }
    let out = dash_env(ctx)
        .with_key(ctx.unlocked_key())
        .git_command()?
        .args(["remote-dash", "--check-key"])
        .stdin(std::process::Stdio::null())
        .output()
        .context("running git remote-dash --check-key")?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(refuse(format!(
            "`git remote-dash --check-key` failed: {}",
            last_lines(&stderr, 3)
        )));
    }
    let report = serde_json::from_slice::<serde_json::Value>(&out.stdout).unwrap_or_default();
    match report["identityId"].as_str() {
        Some(id) if id == identity_id => Ok(()),
        Some(id) => Err(refuse(format!(
            "git-remote-dash read identity {id}, and this repository is created for {identity_id}"
        ))),
        None => Err(refuse(
            "git-remote-dash did not report the identity it would push as".into(),
        )),
    }
}

/// Where there is no handoff (Windows): why the helper could not open the key, if it could
/// not. A `sealed` key needs a passphrase the helper can get (`passphrase_available`: the
/// variable, or a console).
fn no_handoff_blocker(sealed: bool, passphrase_available: bool) -> Option<&'static str> {
    (sealed && !passphrase_available).then_some(
        "your key is passphrase-sealed, and git-remote-dash will have no console to ask for \
         the passphrase on (and DASH_FORGE_PASSPHRASE is not set)",
    )
}

/// Pin `dg`'s network in the repository at `root` (its own git config) unless its git config
/// already resolves it. A `dash://` repository lives on one network, so its clone keeps
/// using that network in a shell without `DASH_FORGE_NETWORK` and after `dg auth` saves
/// another default. Only the repository's own (`--local`) config counts as pinned: a global
/// `dash.network` (what the E702 and doctor fixes suggest) can change later. Returns what it
/// set, as `key=value` (the DAPI list as its key only).
pub fn pin_network(ctx: &Ctx, root: &Path) -> Result<Vec<String>> {
    pin_network_with(ctx, root, &[])
}

/// [`pin_network`] with extra environment for every `git` it runs (tests: an isolated global
/// config).
fn pin_network_with(ctx: &Ctx, root: &Path, env: &[(String, String)]) -> Result<Vec<String>> {
    let set = |k: &str, v: &str| git(root, &["config", "--local", k, v], env).map(drop);
    let want = ctx.network();
    let local = || {
        NetworkSettings::from_git_config(|k| {
            git(root, &["config", "--local", "--get", k], env)
                .ok()
                .filter(|v| !v.is_empty())
        })
    };
    let pinned = || local().resolve().is_ok_and(|t| t.network == *want);
    let mut out = Vec::new();
    if !pinned() {
        for (k, v) in want.selection(GIT_NETWORK_KEYS) {
            set(k, &v)?;
            out.push(format!("{k}={v}"));
        }
        // A devnet whose addresses differ from its deployment file needs them too.
        if !pinned() {
            if let Network::Devnet {
                dapi_addresses,
                quorum_base_url,
                ..
            } = want
            {
                set("dash.dapiAddresses", &dapi_addresses.join(","))?;
                out.push("dash.dapiAddresses".into());
                if let Some(q) = quorum_base_url {
                    set("dash.quorumUrl", q)?;
                    out.push(format!("dash.quorumUrl={q}"));
                }
            }
        }
    }
    let helper = NetworkSettings::from_env().overlay(local());
    if !helper.resolve().is_ok_and(|t| t.network == *want) {
        tracing::warn!(
            "git may still resolve another network: DASH_FORGE_NETWORK and friends in the environment override git config"
        );
    }
    Ok(out)
}

/// `git config --get <key>` in `dir`: `None` when unset or empty.
pub fn config_get(dir: &Path, key: &str) -> Option<String> {
    git(dir, &["config", "--get", key], &[])
        .ok()
        .filter(|v| !v.is_empty())
}

/// `git <args>` in `dir`, returning trimmed stdout; stderr goes into the error.
pub fn git(dir: &Path, args: &[&str], env: &[(String, String)]) -> Result<String> {
    let mut cmd = Command::new("git");
    cmd.envs(env.iter().map(|(k, v)| (k.as_str(), v.as_str())));
    run_git(cmd, dir, args)
}

/// [`git`] for a command that reaches `dash://` (a fetch or a push), with [`DashEnv`].
pub fn git_dash(dir: &Path, args: &[&str], env: &DashEnv<'_>) -> Result<String> {
    run_git(env.git_command()?, dir, args)
}

fn run_git(mut cmd: Command, dir: &Path, args: &[&str]) -> Result<String> {
    let out = cmd
        .current_dir(dir)
        .args(args)
        .output()
        .with_context(|| format!("running git {}", args.first().unwrap_or(&"")))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        bail!(
            "git {} failed: {}",
            args.first().unwrap_or(&""),
            last_lines(&stderr, 6)
        );
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// `git <args>` in `dir`, returning stdout exactly (a file's content: not trimmed), as UTF-8.
pub fn git_raw(dir: &Path, args: &[&str]) -> Result<String> {
    let out = Command::new("git")
        .current_dir(dir)
        .args(args)
        .output()
        .with_context(|| format!("running git {}", args.first().unwrap_or(&"")))?;
    if !out.status.success() {
        bail!(
            "git {} failed: {}",
            args.first().unwrap_or(&""),
            last_lines(&String::from_utf8_lossy(&out.stderr), 6)
        );
    }
    String::from_utf8(out.stdout).context("the file is not UTF-8 text")
}

/// The text of `path` at `commit`, when it is a regular file (mode 100644 or 100755): not a
/// directory, symlink or submodule, whose `git show` output is not file content.
pub fn regular_file(dir: &Path, commit: &str, path: &str) -> Result<String> {
    let entry = git(dir, &["ls-tree", commit, "--", path], &[])?;
    let mut fields = entry.split_whitespace();
    let (mode, kind, oid) = (fields.next(), fields.next(), fields.next());
    match (mode, kind, oid) {
        (Some("100644" | "100755"), Some("blob"), Some(oid)) if is_oid(oid) => {
            git_raw(dir, &["cat-file", "blob", oid])
        }
        _ => bail!("{path} is not a regular file at {commit}"),
    }
}

/// The tree of `commit` with each `path → content` of `files` replaced (the paths exist; file
/// modes are kept), written to `dir`'s object store through a temporary index.
pub fn tree_with(
    dir: &Path,
    commit: &str,
    files: &std::collections::BTreeMap<String, String>,
) -> Result<String> {
    let index = tempfile::NamedTempFile::new().context("creating a temporary index")?;
    let env = [(
        "GIT_INDEX_FILE".to_string(),
        index.path().to_string_lossy().into_owned(),
    )];
    git(dir, &["read-tree", commit], &env)?;
    for (path, content) in files {
        let entry = git(dir, &["ls-files", "-s", "--", path], &env)?;
        let mode = entry
            .split_whitespace()
            .next()
            .unwrap_or("100644")
            .to_string();
        let blob = hash_blob(dir, content.as_bytes())?;
        git(
            dir,
            &[
                "update-index",
                "--cacheinfo",
                &format!("{mode},{blob},{path}"),
            ],
            &env,
        )?;
    }
    git(dir, &["write-tree"], &env)
}

/// Write `bytes` as a blob in `dir`, returning its id.
pub(crate) fn hash_blob(dir: &Path, bytes: &[u8]) -> Result<String> {
    use std::io::Write as _;
    let mut child = Command::new("git")
        .current_dir(dir)
        .args(["hash-object", "-w", "--stdin"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .context("running git hash-object")?;
    child
        .stdin
        .take()
        .context("git hash-object stdin")?
        .write_all(bytes)?;
    let out = child.wait_with_output()?;
    if !out.status.success() {
        bail!(
            "git hash-object failed: {}",
            last_lines(&String::from_utf8_lossy(&out.stderr), 4)
        );
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// `git <args>` in `dir`: whether it exited 0 (for predicates).
pub fn git_ok(dir: &Path, args: &[&str]) -> bool {
    Command::new("git")
        .current_dir(dir)
        .args(args)
        .output()
        .is_ok_and(|o| o.status.success())
}

/// The last `n` non-empty lines of `s`, joined (a helper's final error, not its progress).
fn last_lines(s: &str, n: usize) -> String {
    let lines: Vec<&str> = s.lines().filter(|l| !l.trim().is_empty()).collect();
    lines[lines.len().saturating_sub(n)..].join(" | ")
}

/// Whether `oid` is an object in `dir`'s repository.
pub fn has_object(dir: &Path, oid: &str) -> bool {
    git_ok(dir, &["cat-file", "-e", &format!("{oid}^{{commit}}")])
}

/// A repository's objects as `git count-objects -v` reports them: how many, loose and packed,
/// and their size on disk (an upper bound on the pack a first push of them uploads: a loose
/// object is compressed alone, not deltified).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ObjectCount {
    /// Loose (`count`) plus packed (`in-pack`) objects.
    pub objects: u64,
    /// Loose (`size`) plus packed (`size-pack`) bytes.
    pub bytes: u64,
}

impl ObjectCount {
    /// `git count-objects -v` in `dir`, or `None` when it is not a repository.
    pub fn of(dir: &Path) -> Option<Self> {
        git(dir, &["count-objects", "-v"], &[])
            .ok()
            .map(|out| Self::parse(&out))
    }

    /// The pack a first push of `rev` uploads: every object reachable from it, packed as git
    /// packs them (`git pack-objects --revs --stdout`), streamed and counted, never held in
    /// memory. Its header carries the object count. A packed object stored as a delta against
    /// one `rev` does not reach is sent whole, which this counts (an on-disk size would not).
    pub fn pack_of(dir: &Path, rev: &str) -> Option<Self> {
        use std::io::{Read, Write};
        use std::process::Stdio;
        let mut child = Command::new("git")
            .current_dir(dir)
            .args(["pack-objects", "--revs", "--stdout", "-q"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .ok()?;
        // One rev, then EOF: pack-objects reads its whole input before it writes.
        let fed = child
            .stdin
            .take()
            .is_some_and(|mut stdin| stdin.write_all(format!("{rev}\n").as_bytes()).is_ok());
        let mut header = [0u8; 12];
        let read = child.stdout.take().and_then(|mut out| {
            out.read_exact(&mut header).ok()?;
            std::io::copy(&mut out, &mut std::io::sink()).ok()
        });
        let ok = child.wait().is_ok_and(|s| s.success());
        let rest = read.filter(|_| fed && ok && header.starts_with(b"PACK"))?;
        let count: [u8; 4] = header[8..12].try_into().ok()?;
        Some(Self {
            objects: u64::from(u32::from_be_bytes(count)),
            bytes: 12 + rest,
        })
    }

    /// Parse `git count-objects -v` output (its sizes are in KiB).
    pub fn parse(out: &str) -> Self {
        let mut c = Self::default();
        for (key, value) in out.lines().filter_map(|l| l.split_once(": ")) {
            let Ok(n) = value.trim().parse::<u64>() else {
                continue;
            };
            match key {
                "count" | "in-pack" => c.objects += n,
                "size" | "size-pack" => c.bytes += n * 1024,
                _ => {}
            }
        }
        c
    }
}

/// Whether `a` is an ancestor of (or equal to) `b` in `dir`'s repository.
pub fn is_ancestor(dir: &Path, a: &str, b: &str) -> bool {
    git_ok(dir, &["merge-base", "--is-ancestor", a, b])
}

/// A 40- or 64-hex object id.
pub fn is_oid(s: &str) -> bool {
    matches!(s.len(), 40 | 64) && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// What `dg pr merge` will do to the base ref, decided from the commit graph.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MergePlan {
    /// The head is already in the base's history: nothing to push. The merge event names
    /// the base tip, which is a tip of the base ref and so counts.
    AlreadyMerged {
        /// The base tip.
        oid: String,
    },
    /// The base is an ancestor of the head (or has no commits yet): move it to the head.
    FastForward {
        /// The head.
        oid: String,
    },
    /// Diverged: create a merge commit of base and head (clean 3-way, or conflicts).
    MergeCommit {
        /// The base tip (first parent).
        base: String,
        /// The head (second parent).
        head: String,
    },
}

/// Plan a merge of `head` into a base ref at `base` (`None`: the base ref has no commits).
/// `head_in_base` / `base_in_head` are the two ancestry answers.
pub fn plan_merge(
    base: Option<&str>,
    head: &str,
    head_in_base: bool,
    base_in_head: bool,
) -> MergePlan {
    match base {
        None => MergePlan::FastForward { oid: head.into() },
        Some(b) if head_in_base => MergePlan::AlreadyMerged { oid: b.into() },
        Some(_) if base_in_head => MergePlan::FastForward { oid: head.into() },
        Some(b) => MergePlan::MergeCommit {
            base: b.into(),
            head: head.into(),
        },
    }
}

/// The tree of a clean three-way merge of `a` and `b` in `dir`: `Ok(Some(tree))`, or
/// `Ok(None)` when the merge has conflicts (nothing is written to any ref).
pub fn merge_tree(dir: &Path, a: &str, b: &str) -> Result<Option<String>> {
    let out = Command::new("git")
        .current_dir(dir)
        .args(["merge-tree", "--write-tree", a, b])
        .output()
        .context("running git merge-tree (needs git 2.38 or newer)")?;
    match out.status.code() {
        Some(0) => {}
        Some(1) => return Ok(None),
        _ => bail!(
            "git merge-tree failed: {}",
            last_lines(&String::from_utf8_lossy(&out.stderr), 4)
        ),
    }
    let tree = String::from_utf8_lossy(&out.stdout)
        .lines()
        .next()
        .unwrap_or_default()
        .trim()
        .to_string();
    if !is_oid(&tree) {
        bail!("git merge-tree printed no tree id");
    }
    Ok(Some(tree))
}

/// The paths a conflicting three-way merge of `a` and `b` stops on (for the E105 message).
pub fn conflicted_paths(dir: &Path, a: &str, b: &str) -> Vec<String> {
    let Ok(out) = Command::new("git")
        .current_dir(dir)
        .args([
            "merge-tree",
            "--write-tree",
            "--name-only",
            "--no-messages",
            a,
            b,
        ])
        .output()
    else {
        return Vec::new();
    };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .skip(1)
        .filter(|l| !l.trim().is_empty())
        .map(str::to_string)
        .collect()
}

/// A commit of `tree` with `parents` in `dir`, as `author` (the `GIT_AUTHOR_*` /
/// `GIT_COMMITTER_*` pairs of [`merge_author`]).
pub fn commit_tree(
    dir: &Path,
    tree: &str,
    parents: &[&str],
    message: &str,
    author: &[(String, String)],
) -> Result<String> {
    let mut args = vec!["commit-tree", tree];
    for p in parents {
        args.extend(["-p", p]);
    }
    args.extend(["-m", message]);
    git(dir, &args, author)
}

/// Build the merge commit of `base` and `head` in `dir`: `Ok(Some(oid))`, or `Ok(None)` when
/// the merge has conflicts (nothing is written to any ref).
pub fn merge_commit(
    dir: &Path,
    base: &str,
    head: &str,
    message: &str,
    author: &[(String, String)],
) -> Result<Option<String>> {
    let Some(tree) = merge_tree(dir, base, head)? else {
        return Ok(None);
    };
    commit_tree(dir, &tree, &[base, head], message, author).map(Some)
}

/// The distinct `Name <email>` authors of the commits in `base..head` (oldest first), for
/// `Co-authored-by` trailers.
pub fn authors(dir: &Path, base: Option<&str>, head: &str) -> Result<Vec<String>> {
    let range = base.map_or_else(|| head.to_string(), |b| format!("{b}..{head}"));
    let out = git(
        dir,
        &["log", "--reverse", "--format=%an <%ae>", &range, "--"],
        &[],
    )?;
    let mut seen = std::collections::BTreeSet::new();
    Ok(out
        .lines()
        .filter(|l| !l.trim().is_empty() && seen.insert(l.to_string()))
        .map(str::to_string)
        .collect())
}

/// Author / committer for a merge commit: the user's git identity, else one naming the
/// signing identity (a commit needs some author; this says who made it).
pub fn merge_author(cwd: &Path, identity_id: &str) -> Vec<(String, String)> {
    let get = |key: &str| config_get(cwd, key);
    let name = get("user.name")
        .unwrap_or_else(|| format!("dg {}", &identity_id[..8.min(identity_id.len())]));
    let email = get("user.email").unwrap_or_else(|| format!("{identity_id}@dash-forge.invalid"));
    ["AUTHOR", "COMMITTER"]
        .iter()
        .flat_map(|who| {
            [
                (format!("GIT_{who}_NAME"), name.clone()),
                (format!("GIT_{who}_EMAIL"), email.clone()),
            ]
        })
        .collect()
}

/// [`merge_author`] for the repository the command runs in.
pub fn merge_author_here(identity_id: &str) -> Vec<(String, String)> {
    let cwd = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
    merge_author(&cwd, identity_id)
}

/// The `-c dash.*` storage settings of the repository at `cwd`, so a push from a scratch
/// repository stores packs where the user's own pushes would.
pub fn storage_overrides(cwd: &Path) -> Vec<String> {
    ["dash.storage", "dash.replicas", "dash.platformFallback"]
        .iter()
        .filter_map(|key| config_get(cwd, key).map(|v| format!("{key}={v}")))
        .collect()
}

/// The current branch of the repository at `cwd` (`None` when detached or not a repo).
pub fn current_branch(cwd: &Path) -> Option<String> {
    git(cwd, &["symbolic-ref", "--quiet", "--short", "HEAD"], &[])
        .ok()
        .filter(|b| !b.is_empty())
}

/// Refuse a PR's base ref unless it is a plain branch: `refs/heads/<name>` that
/// `git check-ref-format` accepts and that holds no refspec or glob syntax. It is a document
/// field anyone could have written, and it becomes a fetch refspec and a push destination.
pub fn require_branch_ref(r: &str) -> Result<()> {
    let plain = r.strip_prefix("refs/heads/").is_some_and(|b| !b.is_empty())
        && !r
            .bytes()
            .any(|b| matches!(b, b':' | b'*' | b'?' | b'[' | b'\\' | b'^' | b'~' | b'+'))
        && crate::git::git_ok(Path::new("."), &["check-ref-format", r]);
    if plain {
        Ok(())
    } else {
        Err(crate::errors::usage(format!(
            "the pull request's base {r:?} is not a plain branch (refs/heads/<name>); refusing to use it"
        )))
    }
}

/// `refs/heads/<b>` for a bare branch name; a full ref as given.
pub fn full_ref(b: &str) -> String {
    if b.starts_with("refs/") {
        b.to_string()
    } else {
        format!("refs/heads/{b}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn count_objects_sums_loose_and_packed() {
        let out = "count: 3\nsize: 12\nin-pack: 300\npacks: 1\nsize-pack: 1200\nprune-packable: 0\ngarbage: 0\nsize-garbage: 0\n";
        let want = ObjectCount {
            objects: 303,
            bytes: 1212 * 1024,
        };
        assert_eq!(ObjectCount::parse(out), want);
        assert_eq!(ObjectCount::parse(""), ObjectCount::default());
    }

    /// Windows (no handoff): a sealed key with no passphrase source is refused before the
    /// create is paid for; anything the helper can open passes.
    #[test]
    fn without_a_handoff_a_sealed_key_needs_a_passphrase_source() {
        assert!(no_handoff_blocker(true, false).is_some_and(|c| c.contains("no console")));
        assert_eq!(no_handoff_blocker(true, true), None);
        assert_eq!(no_handoff_blocker(false, false), None);
    }

    /// The `git` a `dash://` command runs inherits exactly one open descriptor besides stdio:
    /// the one handoff pipe, holding the key once.
    #[cfg(unix)]
    #[test]
    fn a_dash_git_command_inherits_exactly_one_handoff_pipe() {
        const KEY: &str = "dfk1:devnet-moutai:8hJmcHWTsdvkHyCrk4UgjbyugDAmE7QfuCTQXpXAc7nB:5:w";
        /// `dash-forge-key/1\n`, the handoff header.
        const HEADER: usize = 17;
        let key = Secret::new(KEY);
        let with_key = DashEnv {
            vars: Vec::new(),
            key: Some(&key),
        };
        assert_eq!(with_key.git_command().unwrap().get_program(), "git");
        // The same construction with a shell in git's place: count the pipes it inherits above
        // stdio, then read the one the variable names. The baseline is the same shell with no
        // key (cargo may pass a jobserver pipe to every test process).
        let script = r#"n=0; for f in /dev/fd/*; do d=${f#/dev/fd/}; [ "$d" -gt 2 ] && [ -p "$f" ] && n=$((n+1)); done; echo "$n"; if [ -n "$DASH_FORGE_KEY_FD" ]; then cat "/dev/fd/${DASH_FORGE_KEY_FD%%:*}" | wc -c; fi"#;
        let run = |env: &DashEnv<'_>| {
            let out = env
                .command("/bin/sh")
                .unwrap()
                .args(["-c", script])
                .stdin(std::process::Stdio::null())
                .output()
                .unwrap();
            assert!(out.status.success());
            String::from_utf8_lossy(&out.stdout)
                .split_whitespace()
                .map(|w| w.parse::<usize>().unwrap())
                .collect::<Vec<_>>()
        };
        let base = run(&DashEnv::default());
        let got = run(&with_key);
        assert_eq!(got[0], base[0] + 1, "exactly one more inherited pipe");
        assert_eq!(got[1], HEADER + KEY.len(), "holding the key once");
    }

    const B: &str = "1111111111111111111111111111111111111111";
    const H: &str = "2222222222222222222222222222222222222222";

    #[test]
    fn a_clone_is_pinned_to_dgs_network_once() {
        // L-21: `dg repo clone` (and `dg init`) record the network in the repository, so a
        // later `git push` there needs neither DASH_FORGE_NETWORK nor dg's config. A global
        // dash.network (the E702 / doctor fix) must not count: it can change later.
        let dir = tempfile::tempdir().unwrap();
        let global = dir.path().join("global.gitconfig");
        std::fs::write(
            &global,
            "[dash]\n\tnetwork = devnet\n\tdevnetName = moutai\n",
        )
        .unwrap();
        let env = [
            (
                "GIT_CONFIG_GLOBAL".to_string(),
                global.display().to_string(),
            ),
            ("GIT_CONFIG_NOSYSTEM".to_string(), "1".to_string()),
        ];
        let repo = dir.path().join("repo");
        std::fs::create_dir(&repo).unwrap();
        git(&repo, &["init", "-q"], &env).unwrap();
        let ctx = Ctx::scripted(true, true, false, None); // devnet moutai
        let set = pin_network_with(&ctx, &repo, &env).unwrap();
        assert_eq!(set, ["dash.network=devnet", "dash.devnetName=moutai"]);
        let get = |k: &str| git(&repo, &["config", "--local", "--get", k], &env).unwrap();
        assert_eq!(
            (get("dash.network"), get("dash.devnetName")),
            ("devnet".into(), "moutai".into())
        );
        assert!(
            pin_network_with(&ctx, &repo, &env).unwrap().is_empty(),
            "already pinned"
        );
    }

    #[test]
    fn merge_planning_covers_every_graph_shape() {
        assert_eq!(
            plan_merge(None, H, false, false),
            MergePlan::FastForward { oid: H.into() },
            "an empty base is created at the head"
        );
        assert_eq!(
            plan_merge(Some(B), H, true, false),
            MergePlan::AlreadyMerged { oid: B.into() }
        );
        assert_eq!(
            plan_merge(Some(B), H, false, true),
            MergePlan::FastForward { oid: H.into() }
        );
        assert_eq!(
            plan_merge(Some(B), H, false, false),
            MergePlan::MergeCommit {
                base: B.into(),
                head: H.into()
            }
        );
        // Equal tips: the head is in the base.
        assert_eq!(
            plan_merge(Some(B), B, true, true),
            MergePlan::AlreadyMerged { oid: B.into() }
        );
    }

    #[test]
    fn only_plain_branches_are_accepted_as_a_pr_base() {
        assert!(require_branch_ref("refs/heads/main").is_ok());
        assert!(require_branch_ref("refs/heads/release/1.x").is_ok());
        for bad in [
            "refs/heads/x:refs/heads/main",
            "+refs/heads/main",
            "refs/heads/*",
            "refs/tags/v1",
            "main",
            "refs/heads/",
            "refs/heads/a..b",
            "refs/heads/-x\n",
            "HEAD",
        ] {
            assert!(require_branch_ref(bad).is_err(), "{bad:?} must be refused");
        }
    }

    #[test]
    fn refs_and_oids() {
        assert_eq!(full_ref("main"), "refs/heads/main");
        assert_eq!(full_ref("refs/tags/v1"), "refs/tags/v1");
        assert!(is_oid(B));
        assert!(!is_oid("main"));
        assert!(!is_oid(&"g".repeat(40)));
    }

    /// A real repository: fast-forward, a clean 3-way merge, and a conflict.
    #[test]
    fn merge_commits_are_built_from_the_graph() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        let env = vec![
            ("GIT_AUTHOR_NAME".to_string(), "t".to_string()),
            ("GIT_AUTHOR_EMAIL".to_string(), "t@t".to_string()),
            ("GIT_COMMITTER_NAME".to_string(), "t".to_string()),
            ("GIT_COMMITTER_EMAIL".to_string(), "t@t".to_string()),
        ];
        let g = |args: &[&str]| git(d, args, &env).unwrap();
        g(&["init", "-q", "-b", "main"]);
        g(&["config", "commit.gpgsign", "false"]);
        let commit = |file: &str, text: &str| {
            std::fs::write(d.join(file), text).unwrap();
            g(&["add", file]);
            g(&["commit", "-q", "-m", file]);
            g(&["rev-parse", "HEAD"])
        };
        let base = commit("a.txt", "a\n");
        g(&["checkout", "-q", "-b", "feature"]);
        let head = commit("b.txt", "b\n");
        // Fast-forward shape.
        assert!(is_ancestor(d, &base, &head));
        assert_eq!(
            plan_merge(Some(&base), &head, is_ancestor(d, &head, &base), true),
            MergePlan::FastForward { oid: head.clone() }
        );
        // Diverge main with an unrelated file: a clean merge.
        g(&["checkout", "-q", "main"]);
        let base2 = commit("c.txt", "c\n");
        let merged = merge_commit(d, &base2, &head, "merge", &env)
            .unwrap()
            .unwrap();
        let parents = g(&["rev-list", "--parents", "-n1", &merged]);
        assert_eq!(parents, format!("{merged} {base2} {head}"));
        assert!(is_ancestor(d, &head, &merged) && is_ancestor(d, &base2, &merged));
        // Both sides change the same line: a conflict, nothing built.
        let conflict_base = commit("b.txt", "main's b\n");
        assert_eq!(
            merge_commit(d, &conflict_base, &head, "merge", &env).unwrap(),
            None
        );
    }
}
