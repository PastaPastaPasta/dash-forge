//! Local `git` plumbing for `dg pr` (merge, checkout, diff) and the pure merge planner.
//!
//! Every call runs the `git` on PATH with explicit arguments (never a shell), in an explicit
//! directory. `dash://` fetches and pushes reach `git-remote-dash`, which gets the identity
//! and network this `dg` invocation resolved through the environment ([`dash_env`]).

use std::path::Path;
use std::process::Command;

use anyhow::{bail, Context, Result};
use forge_core::network::{NetworkSettings, GIT_NETWORK_KEYS};
use forge_core::platform::Network;

use crate::context::Ctx;

/// The environment a `dash://` fetch / push needs: the identity file and the network.
pub fn dash_env(ctx: &Ctx) -> Vec<(String, String)> {
    let mut env: Vec<(String, String)> = ctx
        .target
        .env_vars()
        .into_iter()
        .map(|(k, v)| (k.to_string(), v))
        .collect();
    // A file path is made absolute: git runs the helper from another directory (a scratch
    // repo, or the repository root), where a relative path names nothing. A `keychain:` or
    // inline `dfk1:` source is not a path and passes through as it is.
    if let Some(p) = &ctx.identity_path {
        let value = if forge_core::keystore::is_file_source(p) {
            std::path::absolute(p).unwrap_or_else(|_| p.clone())
        } else {
            p.clone()
        };
        env.push((
            "DASH_FORGE_KEY".into(),
            value.to_string_lossy().into_owned(),
        ));
    }
    env
}

/// Pin `dg`'s network in the repository at `root` (its own git config) unless its git config
/// already resolves it. A `dash://` repository lives on one network, so its clone keeps
/// using that network in a shell without `DASH_FORGE_NETWORK` and after `dg auth` saves
/// another default. Returns what it set, as `key=value` (the DAPI list as its key only).
pub fn pin_network(ctx: &Ctx, root: &Path) -> Result<Vec<String>> {
    let set = |k: &str, v: &str| git(root, &["config", k, v], &[]).map(drop);
    let want = ctx.network();
    let git_config = || NetworkSettings::from_git_config(|k| config_get(root, k));
    let pinned = || git_config().resolve().is_ok_and(|t| t.network == *want);
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
    let helper = NetworkSettings::from_env().overlay(git_config());
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
    let out = Command::new("git")
        .current_dir(dir)
        .args(args)
        .envs(env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
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
fn hash_blob(dir: &Path, bytes: &[u8]) -> Result<String> {
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

    const B: &str = "1111111111111111111111111111111111111111";
    const H: &str = "2222222222222222222222222222222222222222";

    #[test]
    fn a_clone_is_pinned_to_dgs_network_once() {
        // L-21: `dg repo clone` (and `dg init`) record the network in the repository, so a
        // later `git push` there needs neither DASH_FORGE_NETWORK nor dg's config.
        let dir = tempfile::tempdir().unwrap();
        git(dir.path(), &["init", "-q"], &[]).unwrap();
        let ctx = Ctx::scripted(true, true, false, None); // devnet moutai
        let set = pin_network(&ctx, dir.path()).unwrap();
        assert_eq!(set[..2], ["dash.network=devnet", "dash.devnetName=moutai"]);
        let get = |k: &str| git(dir.path(), &["config", "--get", k], &[]).unwrap();
        assert_eq!(
            (get("dash.network"), get("dash.devnetName")),
            ("devnet".into(), "moutai".into())
        );
        assert!(
            pin_network(&ctx, dir.path()).unwrap().is_empty(),
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
