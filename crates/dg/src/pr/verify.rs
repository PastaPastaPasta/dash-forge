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
use forge_core::scope::RepoRef as Repo;
use serde_json::json;

use crate::common::Reader;
use crate::context::Ctx;
use crate::fmt::{short, short_identity};
use crate::git;
use forge_core::rules::merge_audit::{AuditVerdict, MergeAudit, UncountedBypass};
use forge_core::rules::v2::CheckState;

/// `git merge-base --is-ancestor a b`: `Some(true)` (exit 0) or `Some(false)` (exit 1), `None`
/// when it could not answer: an object is missing, the walk failed, or the repository is shallow
/// (a walk that stops at the shallow boundary would say "no" for a commit it never reached).
fn ancestor(dir: &Path, a: &str, b: &str) -> Option<bool> {
    if !git::has_object(dir, a) || !git::has_object(dir, b) {
        return None;
    }
    let code = std::process::Command::new("git")
        .current_dir(dir)
        .args(["merge-base", "--is-ancestor", a, b])
        .output()
        .ok()?
        .status
        .code();
    match code {
        Some(0) => Some(true),
        Some(1) if !shallow(dir) => Some(false),
        _ => None,
    }
}

/// Whether `dir` is a shallow clone.
fn shallow(dir: &Path) -> bool {
    git::git(dir, &["rev-parse", "--is-shallow-repository"], &[])
        .map_or(true, |o| o.trim() != "false")
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
    if f.tip_before_in_merge == Some(false) {
        // Not built on the base: no tree comparison can make it a squash or a rebase.
        return f;
    }
    f.merge_change = tree_change(dir, tip_before, merge_oid);
    if let Ok(mb) = git::git(dir, &["merge-base", head, tip_before], &[]) {
        f.pr_change = tree_change(dir, &mb, head);
        f.base_change = tree_change(dir, &mb, tip_before);
    }
    f
}

/// The PR head when it was merged, when it is merged.
fn merged_head(view: &PatchView) -> Option<String> {
    Some(head_at(
        &view.review,
        &view.patch.head_oid,
        view.merged_at()?,
    ))
}

/// The merge `view` records, when there is one to check: merged, naming a commit, and that commit
/// a tip the base held (one that never was is labelled "merge commit not found on the base"
/// instead, as the web does).
pub(crate) fn checkable_merge(view: &PatchView) -> Option<String> {
    view.merge_oid()
        .filter(|_| view.state.merged && view.state.merge_on_base != Some(false))
}

/// The verdict on `view`'s recorded merge (`None` when there is none to check), from `dir`'s
/// repository: the head as it was at the merge, the base tip the merge built on.
pub(crate) fn merged_content(dir: &Path, view: &PatchView) -> Option<MergeContent> {
    let merge_oid = checkable_merge(view)?;
    let head = merged_head(view)?;
    let facts = merge_facts(dir, &head, &merge_oid, &view.tip_before(&merge_oid));
    Some(merge_content(&facts))
}

/// Whether `dir` is a git repository holding both the merge commit and the merged head: then
/// [`merged_content`] needs no fetch.
pub(crate) fn has_merge_objects(dir: &Path, view: &PatchView) -> bool {
    match (checkable_merge(view), merged_head(view)) {
        (Some(merge_oid), Some(head)) => {
            git::has_object(dir, &merge_oid) && git::has_object(dir, &head)
        }
        _ => false,
    }
}

/// A scratch repository for checking a merge of `view` naming `merge_oid` into its base: the
/// base's history (every branch of the repository when the base has been deleted since; packs
/// are whole, so the old tips come with them) and `head` from the PR's source repository. A head
/// that cannot be fetched (its branch deleted or force-pushed away) is left out: a merge that
/// contains it brings it with the base, and otherwise the check says it could not be read.
pub(crate) fn scratch_for_check(
    ctx: &Ctx,
    handle: &Repo,
    view: &PatchView,
    head: &str,
) -> Result<tempfile::TempDir> {
    super::require_git_safe(view)?;
    let scratch = super::scratch_repo()?;
    let dir = scratch.path();
    let private = handle.visibility == forge_core::rules::v2::Visibility::Private;
    let env = super::read_env(ctx, private)?;
    if view.base_tip.is_some() {
        super::fetch_base(dir, handle, &view.merge_base.ref_name, &env)?;
    } else {
        // Best effort: a repository with no branch left has nothing to fetch.
        let _ = git::git_dash(
            dir,
            &[
                "fetch",
                "-q",
                &format!("dash://{}", handle.id()),
                "+refs/heads/*:refs/remotes/target/*",
            ],
            &env,
        );
    }
    if git::is_oid(head) && !git::has_object(dir, head) {
        let _ = super::fetch_pr_head(dir, &view.patch.source_repo_id, head, &env);
    }
    Ok(scratch)
}

/// `dg pr verify`: fetch the base's history and the PR head into a scratch repository and say
/// whether the recorded merge contains the PR. A read: nothing is written or paid for.
pub(crate) async fn run(ctx: &Ctx, repo: &str, number: u64) -> Result<()> {
    let s = Reader::open(ctx, repo).await?;
    let (handle, collab) = (&s.repo, s.collab());
    let p = super::patch(&collab, handle, repo, number).await?;
    let view = collab.patch_view(handle, p).await?;
    if !view.state.merged {
        ctx.emit(
            json!({ "pr": number, "merged": false, "mergeContent": null }),
            || println!("PR #{number} is not merged; there is no merge to check"),
        );
        return Ok(());
    }
    let (Some(merge_oid), Some(head)) = (checkable_merge(&view), merged_head(&view)) else {
        let why = if view.state.merge_on_base == Some(false) {
            "its merge commit was never a tip of the base branch"
        } else {
            "its merge names no commit"
        };
        ctx.emit(
            json!({ "pr": number, "merged": true, "mergeContent": null }),
            || println!("PR #{number} is merged, but {why}, so there is nothing to check"),
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
    let scratch = scratch_for_check(ctx, handle, &view, &head)?;
    let facts = merge_facts(
        scratch.path(),
        &head,
        &merge_oid,
        &view.tip_before(&merge_oid),
    );
    let content = merge_content(&facts);
    // The branch rules at the merge: Platform reads only (policy and config timelines, reviews,
    // members, and the runs on the merged head when the policy required checks).
    let audit = Box::pin(collab.merge_audit(handle, &view)).await;
    let base = forge_core::repo::short_branch_name(&view.merge_base.ref_name).to_string();
    let merger = forge_core::rules::v2::merge_transition(&view.log.transitions)
        .map(|t| t.actor.clone())
        .unwrap_or_default();
    let audit_json = match &audit {
        Ok(Some(a)) => serde_json::to_value(a).unwrap_or(serde_json::Value::Null),
        Ok(None) => serde_json::Value::Null,
        Err(e) => json!({ "error": e.to_string() }),
    };
    ctx.emit(
        json!({ "pr": number, "merged": true, "mergeContent": content_json(&merge_oid, &content), "rulesAtMerge": audit_json }),
        || {
            println!("{}", merge_line(&merge_oid, &content));
            match &audit {
                Ok(Some(a)) => {
                    for line in audit_lines(a, &merger, &base) {
                        println!("{line}");
                    }
                }
                Ok(None) => println!("branch rules at merge: not checked for a private repository yet"),
                Err(e) => println!("branch rules at merge: could not be read: {e}"),
            }
        },
    );
    Ok(())
}

/// The line for a bypass recorded for the merge that does not count (the web's
/// `uncountedBypassWhy`): its writer's role then can't be confirmed, or isn't maintainer.
fn uncounted_bypass_line(u: &UncountedBypass) -> String {
    format!(
        "! bypass recorded by {}{}, not counted: {}",
        short_identity(&u.event.actor),
        if u.event.value.is_empty() {
            String::new()
        } else {
            format!(" ({})", u.event.value)
        },
        u.role.map_or_else(
            || "no current membership record, so their role at the time can't be confirmed".to_string(),
            |r| format!("their current membership record shows {} at the time, and only a maintainer's bypass counts", r.noun())
        )
    )
}

/// The audit's headline (the web's `auditHeadline`).
fn audit_headline(a: &MergeAudit) -> &'static str {
    match a.verdict {
        AuditVerdict::None => "no branch rules applied",
        AuditVerdict::Met => "met the branch rules in force at the time",
        AuditVerdict::Bypassed => "a maintainer bypassed the branch rules and recorded it",
        AuditVerdict::Unmet => match &a.uncounted_bypass {
            None => "did not meet the branch rules in force at the time, and no bypass was recorded",
            Some(u) if u.role.is_none() => {
                "did not meet the branch rules in force at the time; a bypass was recorded, but its writer's role at the time can't be confirmed"
            }
            Some(_) => {
                "did not meet the branch rules in force at the time; a bypass was recorded, but no current membership record shows its writer as a maintainer then"
            }
        },
        AuditVerdict::Unknown if a.checks_unread && a.code_owners_unaudited => {
            "the required checks could not be read, and code owner approval is not audited"
        }
        AuditVerdict::Unknown if a.code_owners_unaudited => {
            "code owner approval was required, and it is not audited"
        }
        AuditVerdict::Unknown => "the required checks could not be read",
    }
}

/// `dg pr verify`'s "branch rules at merge" block: the verdict, then one line per rule (`!` first
/// when unmet). Parity with the web's `auditRows` / `auditHeadline` (`lib/view/merge-audit.ts`).
pub(crate) fn audit_lines(a: &MergeAudit, merger: &str, base: &str) -> Vec<String> {
    let headline = audit_headline(a);
    let mark = |met: bool| if met { "  " } else { "! " };
    let bang = if a.verdict == AuditVerdict::Unmet {
        "! "
    } else {
        ""
    };
    let mut out = vec![format!("{bang}branch rules at merge: {headline}")];
    out.push(format!(
        "  merged by {}{}",
        short_identity(merger),
        a.merger_role.map_or_else(
            || ", no current membership record".to_string(),
            |r| format!(", {} at the time", r.noun())
        )
    ));
    if a.protected {
        out.push(if a.protection_unmet && a.merger_role.is_none() {
            format!("! protected branch: {base} was protected, and the merger's role at the time can't be confirmed")
        } else if a.protection_unmet {
            format!("! protected branch: {base} was protected, and no current membership record shows the merger as a maintainer then")
        } else {
            format!("  protected branch: {base} was protected; a maintainer merged it")
        });
    } else {
        out.push(format!("  protected branch: {base} was not protected"));
    }
    match (&a.policy, &a.approvals) {
        (None, _) => out.push("  branch policy: none".to_string()),
        (Some(p), Some(s)) if s.need > 0 => {
            let who = if p.approver_role == 1 {
                " (maintainers only)"
            } else {
                ""
            };
            out.push(format!(
                "{}required approvals: {} of {}{who}",
                mark(s.have >= s.need),
                s.have,
                s.need
            ));
            if !s.blocked_by.is_empty() {
                let n = s.blocked_by.len();
                out.push(format!(
                    "! changes requested by {n} reviewer{}",
                    if n == 1 { "" } else { "s" }
                ));
            }
        }
        _ => out.push("  required approvals: none".to_string()),
    }
    if a.checks_unread {
        out.push("  required checks: could not be read".to_string());
    } else if let Some(c) = &a.checks {
        if c.required.is_empty() {
            out.push("! required checks: none reported on the merged head".to_string());
        }
        for r in &c.required {
            let word = match r.state {
                CheckState::Passed => "passed",
                CheckState::Failing => "failed",
                CheckState::Pending => "still running at the merge",
                CheckState::Missing => "not reported",
            };
            out.push(format!(
                "{}check {}: {word}",
                mark(r.state == CheckState::Passed),
                r.name
            ));
        }
    }
    if a.code_owners_unaudited {
        out.push("  code owners: approval required; not audited".to_string());
    }
    if let Some(b) = &a.bypass {
        out.push(format!(
            "  bypass recorded by {}{}",
            short_identity(&b.actor),
            if b.value.is_empty() {
                String::new()
            } else {
                format!(": {}", b.value)
            }
        ));
    }
    if let Some(u) = &a.uncounted_bypass {
        out.push(uncounted_bypass_line(u));
    }
    if a.rules_changed {
        out.push("! the branch rules changed less than an hour before this merge".to_string());
    }
    if a.verdict == AuditVerdict::Unmet {
        out.push(
            "  (judged by what is on Platform now: reviews and check runs can be deleted, and a removed member's approval stops counting)"
                .to_string(),
        );
    }
    out
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
        // Files both sides changed: the rule sees that, never that the merge's version holds
        // the PR's change (an unrelated push to the same file looks the same, Q5-A01).
        format!(
            ", except {} and not checked for this PR's change",
            both_sides(&c.combined)
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

/// `combined` for people: "2 files changed on both sides (a.rs, b.rs)", naming three at most.
pub(crate) fn both_sides(combined: &[String]) -> String {
    let n = combined.len();
    let more = if n > 3 {
        format!(" and {} more", n - 3)
    } else {
        String::new()
    };
    format!(
        "{n} file{} changed on both sides ({}{more})",
        if n == 1 { "" } else { "s" },
        combined
            .iter()
            .take(3)
            .cloned()
            .collect::<Vec<_>>()
            .join(", ")
    )
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
    fn audit_lines_mark_unmet_rules_and_the_caveat() {
        use forge_core::rules::merge_audit::{audit_merge, MergeAuditInput, ProtectionDoc};
        use forge_core::rules::v2::{Membership, Role};
        let input = MergeAuditInput {
            merged_at: 100,
            merger: "writ".into(),
            merge_oid: "b".repeat(40),
            merge_head: "a".repeat(40),
            pr_author: "auth".into(),
            // Protected just before the merge, after a config that did not protect it: a change
            // (a repository's first config alone is not one).
            protection: vec![
                ProtectionDoc {
                    id: "c0".into(),
                    created_at: 1,
                    protected: false,
                },
                ProtectionDoc {
                    id: "c1".into(),
                    created_at: 90,
                    protected: true,
                },
            ],
            memberships: vec![Membership {
                identity: "writ".into(),
                role: Role::Writer,
                created_at: 1,
            }],
            ..MergeAuditInput::default()
        };
        let lines = audit_lines(&audit_merge(&input), "writ", "main");
        assert_eq!(
            lines[0],
            "! branch rules at merge: did not meet the branch rules in force at the time, and no bypass was recorded"
        );
        assert!(lines.contains(&"  merged by writ, a writer at the time".to_string()));
        assert!(lines
            .iter()
            .any(|l| l.starts_with("! protected branch: main was protected")));
        assert!(lines.contains(
            &"! the branch rules changed less than an hour before this merge".to_string()
        ));
        assert!(lines
            .last()
            .unwrap()
            .contains("judged by what is on Platform now"));
    }

    /// Q5-A01: files both sides changed are never worded as a plain squash.
    #[test]
    fn combined_files_are_worded_as_unchecked() {
        let c = MergeContent {
            verdict: MergeVerdict::Squash,
            combined: vec!["CHANGELOG.md".into()],
        };
        assert_eq!(
            verdict_words(&c),
            "is a squash of this PR, except 1 file changed on both sides (CHANGELOG.md) and not checked for this PR's change"
        );
        let clean = MergeContent {
            verdict: MergeVerdict::Squash,
            combined: Vec::new(),
        };
        assert_eq!(verdict_words(&clean), "is a squash of this PR");
    }

    /// Q5-B04: a policy requiring code owners' approval is never read as fully met.
    #[test]
    fn audit_lines_say_code_owners_were_not_audited() {
        use forge_core::rules::merge_audit::{audit_merge, MergeAuditInput, PolicyDoc};
        use forge_core::rules::review::Policy;
        let input = MergeAuditInput {
            merged_at: 100,
            merger: "m".into(),
            merge_oid: "b".repeat(40),
            merge_head: "a".repeat(40),
            pr_author: "auth".into(),
            policies: vec![PolicyDoc {
                id: "p1".into(),
                created_at: 10,
                policy: Policy {
                    require_code_owners: true,
                    ..Policy::default()
                },
            }],
            ..MergeAuditInput::default()
        };
        let audit = audit_merge(&input);
        assert_eq!(audit.verdict, AuditVerdict::Unknown);
        let lines = audit_lines(&audit, "m", "main");
        assert_eq!(
            lines[0],
            "branch rules at merge: code owner approval was required, and it is not audited"
        );
        assert!(lines.contains(&"  code owners: approval required; not audited".to_string()));
        let json = serde_json::to_value(&audit).unwrap();
        assert_eq!(json["codeOwnersUnaudited"], true);
        assert_eq!(json["verdict"], "unknown");
    }

    /// Q5-A03: the maintainer who merged with a bypass was removed (or changed role) since. The
    /// bypass is shown as recorded but unconfirmed, never "no bypass was recorded", and the
    /// merger has no current record rather than "no membership at the time".
    #[test]
    fn audit_lines_report_a_bypass_whose_writer_left() {
        use forge_core::rules::merge_audit::PolicyDoc;
        use forge_core::rules::merge_audit::{audit_merge, BypassEvent, MergeAuditInput};
        use forge_core::rules::review::Policy;
        let input = MergeAuditInput {
            merged_at: 100,
            merger: "gone".into(),
            merge_oid: "b".repeat(40),
            merge_head: "a".repeat(40),
            pr_author: "auth".into(),
            policies: vec![PolicyDoc {
                id: "p1".into(),
                created_at: 10,
                policy: Policy {
                    required_approvals: 1,
                    ..Policy::default()
                },
            }],
            bypasses: vec![BypassEvent {
                id: "e1".into(),
                actor: "gone".into(),
                created_at: 101,
                oid: "b".repeat(40),
                value: "required approvals: 0 of 1".into(),
            }],
            ..MergeAuditInput::default()
        };
        let audit = audit_merge(&input);
        let lines = audit_lines(&audit, "gone", "main");
        assert_eq!(
            lines[0],
            "! branch rules at merge: did not meet the branch rules in force at the time; a bypass was recorded, but its writer's role at the time can't be confirmed"
        );
        assert!(lines.contains(&"  merged by gone, no current membership record".to_string()));
        assert!(lines.contains(&"! bypass recorded by gone (required approvals: 0 of 1), not counted: no current membership record, so their role at the time can't be confirmed".to_string()));
        let json = serde_json::to_value(&audit).unwrap();
        assert_eq!(json["uncountedBypass"]["event"]["actor"], "gone");
        assert_eq!(json["uncountedBypass"]["role"], serde_json::Value::Null);
        assert_eq!(json["bypass"], serde_json::Value::Null);
    }

    #[test]
    fn raw_diff_parsing_keeps_deletions_as_empty_blobs() {
        let raw = b":100644 100644 aaaa bbbb M\0src/a.rs\0:100644 000000 cccc 0000 D\0gone.txt\0";
        let got = parse_raw_diff(raw).unwrap();
        assert_eq!(got.get("src/a.rs").map(String::as_str), Some("bbbb"));
        assert_eq!(got.get("gone.txt").map(String::as_str), Some(""));
    }
}
