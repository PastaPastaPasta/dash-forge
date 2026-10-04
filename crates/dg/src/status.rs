//! `dg pr status` and `dg issue status`: gh's summaries of what in one repository concerns you.
//!
//! * PRs: the one from your current branch (in a clone), the open ones you opened, and the
//!   open ones that request your review, each with its draft state and review decision. One
//!   read of the newest 100 PRs with their state and approvals (`dg pr list`'s).
//! * Issues: the open ones assigned to you, the open ones that mention you (`@name` or your
//!   identity id in the body, the web's mention rule), and the open ones you opened. One read
//!   of every issue and the event feed (`dg issue list`'s).

use anyhow::Result;
use serde_json::json;

use forge_core::collab::v2::{IssueView, PatchView};
use forge_core::rules::v2::Approvals;

use crate::common::Reader;
use crate::context::Ctx;
use crate::fmt::safe;

/// A PR's review decision, as gh words it.
fn decision(v: &PatchView, a: &Approvals) -> &'static str {
    if v.state.draft {
        "draft"
    } else if !a.changes_requested.is_empty() {
        "changes requested"
    } else if !a.approvers.is_empty() {
        "approved"
    } else {
        "review required"
    }
}

/// One PR row as `dg pr status` prints it.
fn pr_line(v: &PatchView, a: &Approvals) -> String {
    let branch = v
        .patch
        .source_ref_name
        .as_deref()
        .map_or("?", |b| b.trim_start_matches("refs/heads/"));
    format!(
        "  #{:<5} {}  [{}]  {}",
        v.patch.number,
        safe(&v.patch.title),
        safe(branch),
        decision(v, a)
    )
}

fn pr_json(v: &PatchView, a: &Approvals) -> serde_json::Value {
    json!({
        "number": v.patch.number,
        "title": v.patch.title,
        "author": v.patch.author,
        "state": crate::pr::state_field(v),
        "draft": v.state.draft,
        "headRefName": v.patch.source_ref_name,
        "baseRefName": v.merge_base.ref_name,
        "reviewDecision": decision(v, a),
        "approvals": a.approvers.len(),
        "changesRequested": a.changes_requested.len(),
    })
}

fn section<T>(title: &str, rows: &[T], line: impl Fn(&T) -> String, none: &str) {
    println!();
    println!("{title}");
    if rows.is_empty() {
        println!("  {none}");
    }
    for r in rows {
        println!("{}", line(r));
    }
}

/// `dg pr status`.
pub async fn pr_status(ctx: &Ctx, repo: &str) -> Result<()> {
    let s = Reader::open(ctx, repo).await?;
    let me = s.me(ctx)?;
    let page = s.collab().list_patch_views(&s.repo, 100).await?;
    let open: Vec<&(PatchView, Approvals)> =
        page.rows.iter().filter(|(v, _)| v.state.open).collect();
    // The PR from the branch checked out here, of this repo or of a fork (gh's "Current
    // branch"): an open one first, else the newest.
    let branch = std::env::current_dir()
        .ok()
        .and_then(|d| crate::git::current_branch(&d));
    let current = branch.as_deref().and_then(|b| {
        let full = crate::git::full_ref(b);
        // From this branch of this repository, or of a fork of yours (gh matches the head
        // repository's owner too): someone else's fork branch of the same name is not it.
        let mine = |(v, _): &&(PatchView, Approvals)| {
            v.patch.source_ref_name.as_deref() == Some(full.as_str())
                && (v.patch.source_repo_id == s.repo.id() || v.patch.author == me)
        };
        page.rows
            .iter()
            .filter(mine)
            .find(|(v, _)| v.state.open)
            .or_else(|| page.rows.iter().find(mine))
    });
    let created: Vec<&(PatchView, Approvals)> = open
        .iter()
        .copied()
        .filter(|(v, _)| v.patch.author == me)
        .collect();
    let requested: Vec<&(PatchView, Approvals)> = open
        .iter()
        .copied()
        .filter(|(v, _)| {
            v.review
                .requested_reviewers
                .iter()
                .any(|r| r.identity == me)
        })
        .collect();
    ctx.emit(
        json!({
            "repo": s.repo.display(),
            "currentBranch": branch.as_ref().map(|b| json!({
                "name": b,
                "pr": current.map(|(v, a)| pr_json(v, a)),
            })),
            "createdBy": created.iter().map(|(v, a)| pr_json(v, a)).collect::<Vec<_>>(),
            "needsReview": requested.iter().map(|(v, a)| pr_json(v, a)).collect::<Vec<_>>(),
            "searchedNewest": page.rows.len(),
            "truncated": page.more,
        }),
        || {
            println!("Relevant pull requests in {}", s.repo.display());
            if let Some(b) = &branch {
                println!();
                println!("Current branch");
                match current {
                    Some((v, a)) => {
                        let state = if v.state.open {
                            String::new()
                        } else {
                            format!(" ({})", crate::pr::state_label(v))
                        };
                        println!("{}{state}", pr_line(v, a));
                    }
                    None => println!("  There is no pull request associated with [{}]", safe(b)),
                }
            }
            section(
                "Created by you",
                &created,
                |(v, a)| pr_line(v, a),
                "You have no open pull requests",
            );
            section(
                "Requesting a code review from you",
                &requested,
                |(v, a)| pr_line(v, a),
                "You have no pull requests to review",
            );
            if page.more {
                println!();
                println!("(read the newest {} pull requests)", page.rows.len());
            }
        },
    );
    Ok(())
}

fn issue_line(v: &IssueView) -> String {
    format!(
        "  #{:<5} {}{}",
        v.issue.number,
        safe(&v.issue.title),
        crate::search::labels_suffix(&v.state.labels)
    )
}

fn issue_json(v: &IssueView) -> serde_json::Value {
    json!({
        "number": v.issue.number,
        "title": v.issue.title,
        "author": v.issue.author,
        "labels": v.state.labels,
        "assignees": v.state.assignees,
        "createdAt": v.issue.created_at,
    })
}

/// `dg issue status`.
pub async fn issue_status(ctx: &Ctx, repo: &str) -> Result<()> {
    let s = Reader::open(ctx, repo).await?;
    let me = s.me(ctx)?;
    let name = s.client.dpns_first_names([me.as_str()]).await.remove(&me);
    let (mut all, hidden) = s.collab().issues_with_state(&s.repo).await?;
    all.retain(|v| v.state.open);
    all.sort_by_key(|v| std::cmp::Reverse(v.issue.created_at));
    let assigned: Vec<&IssueView> = all
        .iter()
        .filter(|v| v.state.assignees.contains(&me))
        .collect();
    let mentioning: Vec<&IssueView> = all
        .iter()
        .filter(|v| v.issue.author != me)
        .filter(|v| forge_core::rules::search::mentions(&v.issue.body, &me, name.as_deref()))
        .collect();
    let opened: Vec<&IssueView> = all.iter().filter(|v| v.issue.author == me).collect();
    ctx.emit(
        json!({
            "repo": s.repo.display(),
            "assigned": assigned.iter().map(|v| issue_json(v)).collect::<Vec<_>>(),
            "mentioned": mentioning.iter().map(|v| issue_json(v)).collect::<Vec<_>>(),
            "authored": opened.iter().map(|v| issue_json(v)).collect::<Vec<_>>(),
            "hidden": hidden,
        }),
        || {
            println!("Relevant issues in {}", s.repo.display());
            section(
                "Issues assigned to you",
                &assigned,
                |v| issue_line(v),
                "There are no issues assigned to you",
            );
            section(
                "Issues mentioning you",
                &mentioning,
                |v| issue_line(v),
                "There are no issues mentioning you",
            );
            section(
                "Issues opened by you",
                &opened,
                |v| issue_line(v),
                "There are no issues opened by you",
            );
        },
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::decision;
    use forge_core::rules::v2::Approvals;

    /// gh's review decision: a draft first, then changes requested over approvals.
    #[test]
    fn the_review_decision_is_ghs() {
        let v = crate::pr::tests::view_with("refs/heads/main", &"a".repeat(40));
        let mut a = Approvals::default();
        assert_eq!(decision(&v, &a), "review required");
        a.approvers.insert("x".into());
        assert_eq!(decision(&v, &a), "approved");
        a.changes_requested.insert("y".into());
        assert_eq!(decision(&v, &a), "changes requested");
        let mut d = v.clone();
        d.state.draft = true;
        assert_eq!(decision(&d, &a), "draft");
    }
}
