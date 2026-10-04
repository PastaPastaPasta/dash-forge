//! Does a recorded merge contain the pull request? The git side of the shared reader rule
//! `forge_core::rules::merge_check` (web: `merge-content.ts`): this module gathers the facts
//! from a local repository holding the base's history and the PR head, and words the verdict.
//!
//! Used by `dg pr merge --event-only` (which refuses to record a merge that does not contain the
//! PR), `dg pr view` (when the current repository already holds the commits) and `dg pr verify`
//! (which fetches them).

use std::path::Path;

use anyhow::Result;
use forge_core::collab::v2::PatchView;
use forge_core::rules::merge_check::{
    head_at, merge_content, MergeContent, MergeFacts, MergeVerdict, TreeChange,
};
use serde_json::json;

use crate::common::Reader;
use crate::context::Ctx;
use crate::fmt::short;
use crate::git;

/// `git merge-base --is-ancestor a b`: `Some(true)`/`Some(false)` from its exit code, `None` when
/// it could not answer (an object is missing).
fn ancestor(dir: &Path, a: &str, b: &str) -> Option<bool> {
    if !git::has_object(dir, a) || !git::has_object(dir, b) {
        return None;
    }
    Some(git::is_ancestor(dir, a, b))
}

/// The tree-level change `a` → `b` (`git diff-tree -r --no-renames`): each changed path and its
/// new blob, `""` when deleted. `None` when it cannot be read.
pub(crate) fn tree_change(dir: &Path, a: &str, b: &str) -> Option<TreeChange> {
    let raw = git::git_bytes(dir, &["diff-tree", "-r", "-z", "--no-renames", a, b]).ok()?;
    parse_raw_diff(&raw)
}

/// `git diff-tree -r -z` raw output: `:<mode> <mode> <old> <new> <status>\0<path>\0` per change.
fn parse_raw_diff(raw: &[u8]) -> Option<TreeChange> {
    let mut out = TreeChange::new();
    let mut fields = raw.split(|b| *b == 0).filter(|f| !f.is_empty());
    while let Some(meta) = fields.next() {
        let meta = std::str::from_utf8(meta).ok()?;
        let path = String::from_utf8(fields.next()?.to_vec()).ok()?;
        let parts: Vec<&str> = meta.trim_start_matches(':').split(' ').collect();
        let [_, _, _, new, status] = parts[..] else {
            return None;
        };
        let blob = if status.starts_with('D') || new.bytes().all(|b| b == b'0') {
            String::new()
        } else {
            new.to_string()
        };
        out.insert(path, blob);
    }
    Some(out)
}

/// The facts [`merge_content`] needs about `merge_oid` as a merge of `head` built on
/// `tip_before`, from `dir`'s repository. Whatever cannot be read is `None`.
pub(crate) fn merge_facts(dir: &Path, head: &str, merge_oid: &str, tip_before: &str) -> MergeFacts {
    let merge_parents = git::git(dir, &["rev-list", "--parents", "-n", "1", merge_oid], &[])
        .map(|line| {
            line.split_whitespace()
                .skip(1)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    let mut f = MergeFacts {
        head_oid: head.to_string(),
        merge_oid: merge_oid.to_string(),
        tip_before: tip_before.to_string(),
        merge_parents,
        head_in_merge: ancestor(dir, head, merge_oid),
        ..MergeFacts::default()
    };
    if tip_before.is_empty() || f.head_in_merge == Some(true) {
        return f;
    }
    f.tip_before_in_merge = ancestor(dir, tip_before, merge_oid);
    f.merge_change = tree_change(dir, tip_before, merge_oid);
    if let Ok(mb) = git::git(dir, &["merge-base", head, tip_before], &[]) {
        f.pr_change = tree_change(dir, &mb, head);
        f.base_change = tree_change(dir, &mb, tip_before);
    }
    f
}

/// The verdict on `view`'s recorded merge (`None` when it is not merged or names no commit),
/// from `dir`'s repository: the head as it was at the merge, the base tip the merge built on.
pub(crate) fn merged_content(dir: &Path, view: &PatchView) -> Option<MergeContent> {
    let merge_oid = view.merge_oid()?;
    let head = head_at(&view.review, &view.patch.head_oid, view.merged_at()?);
    let facts = merge_facts(dir, &head, &merge_oid, &view.tip_before(&merge_oid));
    Some(merge_content(&facts))
}

/// Whether `dir` is a git repository holding both the merge commit and the head: then
/// [`merged_content`] needs no fetch.
pub(crate) fn has_merge_objects(dir: &Path, view: &PatchView) -> bool {
    let Some(merge_oid) = view.merge_oid() else {
        return false;
    };
    git::has_object(dir, &merge_oid) && git::has_object(dir, &view.head)
}

/// `dg pr verify`: fetch the base's history and the PR head into a scratch repository and say
/// whether the recorded merge contains the PR. A read: nothing is written or paid for.
pub(crate) async fn run(ctx: &Ctx, repo: &str, number: u64) -> Result<()> {
    let s = Reader::open(ctx, repo).await?;
    let (handle, collab) = (&s.repo, s.collab());
    let p = super::patch(&collab, handle, repo, number).await?;
    let view = collab.patch_view(handle, p).await?;
    let Some(merge_oid) = view.merge_oid().filter(|_| view.state.merged) else {
        ctx.emit(
            json!({ "pr": number, "merged": false, "mergeContent": null }),
            || println!("PR #{number} is not merged; there is no merge to check"),
        );
        return Ok(());
    };
    if !ctx.json {
        eprintln!(
            "Fetching {} and the PR head to check the merge {}…",
            view.merge_base.ref_name,
            short(&merge_oid)
        );
    }
    let scratch = super::scratch_with_pr(ctx, handle, &view)?;
    let content = merged_content(scratch.path(), &view).unwrap_or(MergeContent {
        verdict: MergeVerdict::Unknown,
        combined: Vec::new(),
    });
    ctx.emit(
        json!({ "pr": number, "merged": true, "mergeContent": content_json(&merge_oid, &content) }),
        || println!("{}", merge_line(&merge_oid, &content)),
    );
    Ok(())
}

/// `mergeContent` in `dg pr view --json` and `dg pr verify --json`.
pub(crate) fn content_json(merge_oid: &str, c: &MergeContent) -> serde_json::Value {
    json!({ "oid": merge_oid, "verdict": verdict_name(c), "combined": c.combined })
}

/// The printed line: `merged as abc1234: contains this PR's commits`, `!` first when the merge
/// does not contain the PR.
pub(crate) fn merge_line(merge_oid: &str, c: &MergeContent) -> String {
    let mark = if c.verdict == MergeVerdict::Missing {
        "! "
    } else {
        ""
    };
    format!("{mark}merged as {}: {}", short(merge_oid), verdict_words(c))
}

/// The verdict for people: "contains this PR's commits", "squash of this PR", ….
pub(crate) fn verdict_words(c: &MergeContent) -> String {
    let combined = if c.combined.is_empty() {
        String::new()
    } else {
        format!(
            ", combined with base changes in {} file{}",
            c.combined.len(),
            if c.combined.len() == 1 { "" } else { "s" }
        )
    };
    match c.verdict {
        MergeVerdict::Contains => "contains this PR's commits".to_string(),
        MergeVerdict::Squash => format!("is a squash of this PR{combined}"),
        MergeVerdict::Rebase => format!("is a rebase of this PR{combined}"),
        MergeVerdict::Missing => "does not contain this PR's commits".to_string(),
        MergeVerdict::Unknown => "could not be checked: its commits could not be read".to_string(),
    }
}

/// The verdict's JSON name (`contains`, `squash`, `rebase`, `missing`, `unknown`).
pub(crate) fn verdict_name(c: &MergeContent) -> &'static str {
    match c.verdict {
        MergeVerdict::Contains => "contains",
        MergeVerdict::Squash => "squash",
        MergeVerdict::Rebase => "rebase",
        MergeVerdict::Missing => "missing",
        MergeVerdict::Unknown => "unknown",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(dir: &Path, args: &[&str]) -> String {
        git::git(
            dir,
            args,
            &[
                ("GIT_AUTHOR_NAME".into(), "t".into()),
                ("GIT_AUTHOR_EMAIL".into(), "t@t".into()),
                ("GIT_COMMITTER_NAME".into(), "t".into()),
                ("GIT_COMMITTER_EMAIL".into(), "t@t".into()),
            ],
        )
        .unwrap()
    }

    fn commit(dir: &Path, file: &str, text: &str, msg: &str) -> String {
        std::fs::write(dir.join(file), text).unwrap();
        run(dir, &["add", file]);
        run(dir, &["commit", "-q", "-m", msg]);
        run(dir, &["rev-parse", "HEAD"])
    }

    /// A base with two commits, a PR branch off the first, and three merges of it: a real merge
    /// commit, a squash, and an unrelated commit naming an old tip.
    #[test]
    fn facts_from_git_label_real_squashed_and_fake_merges() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        run(dir, &["init", "-q", "-b", "main"]);
        let root = commit(dir, "a.txt", "a\n", "root");
        let base1 = commit(dir, "b.txt", "b\n", "base change");
        run(dir, &["checkout", "-q", "-b", "pr", &root]);
        let head = commit(dir, "c.txt", "c\n", "the PR");

        // A merge commit of the PR on base1.
        run(dir, &["checkout", "-q", "main"]);
        run(dir, &["merge", "-q", "--no-ff", "-m", "merge", "pr"]);
        let merged = run(dir, &["rev-parse", "HEAD"]);
        let c = merge_content(&merge_facts(dir, &head, &merged, &base1));
        assert_eq!(c.verdict, MergeVerdict::Contains);

        // A squash of it on base1.
        run(dir, &["reset", "-q", "--hard", &base1]);
        run(dir, &["merge", "-q", "--squash", "pr"]);
        run(dir, &["commit", "-q", "-m", "squash"]);
        let squashed = run(dir, &["rev-parse", "HEAD"]);
        let c = merge_content(&merge_facts(dir, &head, &squashed, &base1));
        assert_eq!(c.verdict, MergeVerdict::Squash);
        assert!(c.combined.is_empty());

        // Something else entirely, recorded as the merge.
        run(dir, &["reset", "-q", "--hard", &base1]);
        let other = commit(dir, "z.txt", "z\n", "unrelated");
        let c = merge_content(&merge_facts(dir, &head, &other, &base1));
        assert_eq!(c.verdict, MergeVerdict::Missing);

        // An old tip that predates the PR.
        let c = merge_content(&merge_facts(dir, &head, &base1, &root));
        assert_eq!(c.verdict, MergeVerdict::Missing);

        // A commit that is not in the repository: unknown, never missing.
        let c = merge_content(&merge_facts(dir, &"e".repeat(40), &squashed, &base1));
        assert_eq!(c.verdict, MergeVerdict::Unknown);
    }

    #[test]
    fn raw_diff_parsing_keeps_deletions_as_empty_blobs() {
        let raw = b":100644 100644 aaaa bbbb M\0src/a.rs\0:100644 000000 cccc 0000 D\0gone.txt\0";
        let got = parse_raw_diff(raw).unwrap();
        assert_eq!(got.get("src/a.rs").map(String::as_str), Some("bbbb"));
        assert_eq!(got.get("gone.txt").map(String::as_str), Some(""));
    }
}
