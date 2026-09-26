//! Local `git` plumbing for `dg pr` (merge, checkout, diff) and the pure merge planner.
//!
//! Every call runs the `git` on PATH with explicit arguments (never a shell), in an explicit
//! directory. `dash://` fetches and pushes reach `git-remote-dash`, which gets the identity
//! and network this `dg` invocation resolved through the environment ([`dash_env`]).

use std::path::Path;
use std::process::Command;

use anyhow::{bail, Context, Result};

use crate::context::Ctx;

/// The environment a `dash://` fetch / push needs: the identity file and the network.
pub fn dash_env(ctx: &Ctx) -> Vec<(String, String)> {
    let mut env: Vec<(String, String)> = ctx
        .target
        .env_vars()
        .into_iter()
        .map(|(k, v)| (k.to_string(), v))
        .collect();
    if let Some(p) = &ctx.identity_path {
        env.push(("DASH_FORGE_KEY".into(), p.to_string_lossy().into_owned()));
    }
    env
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

/// Build the merge commit of `base` and `head` in `dir`: `Ok(Some(oid))`, or `Ok(None)` when
/// the merge has conflicts (nothing is written to any ref).
pub fn merge_commit(
    dir: &Path,
    base: &str,
    head: &str,
    message: &str,
    author: &[(String, String)],
) -> Result<Option<String>> {
    let out = Command::new("git")
        .current_dir(dir)
        .args(["merge-tree", "--write-tree", base, head])
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
    let commit = git(
        dir,
        &["commit-tree", &tree, "-p", base, "-p", head, "-m", message],
        author,
    )?;
    Ok(Some(commit))
}

/// Author / committer for a merge commit: the user's git identity, else one naming the
/// signing identity (a commit needs some author; this says who made it).
pub fn merge_author(cwd: &Path, identity_id: &str) -> Vec<(String, String)> {
    let get = |key: &str| {
        git(cwd, &["config", "--get", key], &[])
            .ok()
            .filter(|v| !v.is_empty())
    };
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

/// The `-c dash.*` storage settings of the repository at `cwd`, so a push from a scratch
/// repository stores packs where the user's own pushes would.
pub fn storage_overrides(cwd: &Path) -> Vec<String> {
    ["dash.storage", "dash.replicas", "dash.platformFallback"]
        .iter()
        .filter_map(|key| {
            git(cwd, &["config", "--get", key], &[])
                .ok()
                .filter(|v| !v.is_empty())
                .map(|v| format!("{key}={v}"))
        })
        .collect()
}

/// The current branch of the repository at `cwd` (`None` when detached or not a repo).
pub fn current_branch(cwd: &Path) -> Option<String> {
    git(cwd, &["symbolic-ref", "--quiet", "--short", "HEAD"], &[])
        .ok()
        .filter(|b| !b.is_empty())
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
