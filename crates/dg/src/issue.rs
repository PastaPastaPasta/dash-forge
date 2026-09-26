//! `dg issue` — issue tracking (list/view/create/comment/close/reopen/label).
//!
//! forge-v2 repositories go through [`forge_core::collab::v2::Collab`]: issues are numbered
//! by the `forge-v2.md` §6 rule, a create is journaled so a re-run resumes it, and close /
//! reopen pick their gate automatically (a member's `event`, else the author's
//! `authorEvent`). v1 repositories are read only: `list` and `view` still read them, every
//! write is refused (E605) before anything is signed.

use anyhow::{Context, Result};
use serde_json::json;

use forge_core::collab::v2::{Collab, Target};
use forge_core::collab::IssueService;
use forge_core::create::default_journal_dir;
use forge_core::rules::{EventKind, IssueState};

use crate::common::{number_arg, Session};
use crate::context::Ctx;
use crate::fmt::{cost_json, cost_line, dash_usd_price, route_text};
use crate::{IssueCommand, StateArg};

/// Dispatch an `issue` subcommand.
pub async fn run(ctx: &Ctx, cmd: &IssueCommand) -> Result<()> {
    match cmd {
        IssueCommand::List { repo, state, limit } => list(ctx, repo, *state, *limit).await,
        IssueCommand::View { repo, number } => view(ctx, repo, *number).await,
        IssueCommand::Create { repo, title, body } => create(ctx, repo, title, body).await,
        IssueCommand::Comment { repo, number, body } => comment(ctx, repo, *number, body).await,
        IssueCommand::Close { repo, number } => set_open(ctx, repo, *number, true).await,
        IssueCommand::Reopen { repo, number } => set_open(ctx, repo, *number, false).await,
        IssueCommand::Label {
            repo,
            number,
            add,
            remove,
        } => label(ctx, repo, *number, add.as_deref(), remove.as_deref()).await,
    }
}

fn not_found(repo: &str, number: u64) -> anyhow::Error {
    crate::errors::not_found(
        format!("issue #{number} not found in {repo}"),
        format!("`dg issue list {repo} --state all` lists its issues"),
    )
}

fn labels_of(state: &IssueState) -> String {
    state.labels.iter().cloned().collect::<Vec<_>>().join(", ")
}

async fn list(ctx: &Ctx, repo: &str, state: StateArg, limit: u32) -> Result<()> {
    let s = Session::open(ctx, repo).await?;

    // (number, title, author, state)
    let (rows, hidden): (Vec<(u64, String, String, IssueState)>, usize) = if s.repo.is_v1() {
        let issues = IssueService::new(&s.client, &s.identity, &s.bridge)
            .list_issues(s.repo.v1_contract_id()?, state.into(), limit, None)
            .await
            .context("list_issues")?;
        let rows = issues
            .into_iter()
            .map(|iw| (iw.issue.number, iw.issue.title, iw.issue.author, iw.state))
            .collect();
        (rows, 0)
    } else {
        let collab = Collab::reader(&s.client);
        let (issues, hidden) = collab.list_issues(&s.repo, limit).await?;
        let mut rows = Vec::new();
        for issue in issues {
            let st = collab.issue_state(&s.repo, &issue).await?;
            if state.matches(st.open) {
                rows.push((u64::from(issue.number), issue.title, issue.author, st));
            }
        }
        (rows, hidden)
    };

    let json_rows: Vec<_> = rows
        .iter()
        .map(|(n, title, author, st)| {
            json!({
                "number": n,
                "title": title,
                "author": author,
                "open": st.open,
                "labels": st.labels,
                "assignees": st.assignees,
            })
        })
        .collect();
    ctx.emit(
        json!({ "count": rows.len(), "issues": json_rows, "hidden": hidden }),
        || {
            if rows.is_empty() {
                println!("no issues");
            }
            for (n, title, _, st) in &rows {
                let mark = if st.open { "open" } else { "closed" };
                let labels = if st.labels.is_empty() {
                    String::new()
                } else {
                    format!("  [{}]", labels_of(st))
                };
                println!("#{n:<4} {mark:<6} {title}{labels}");
            }
            if hidden > 0 {
                println!("({hidden} malformed document(s) hidden)");
            }
        },
    );
    Ok(())
}

async fn view(ctx: &Ctx, repo: &str, number: u64) -> Result<()> {
    let s = Session::open(ctx, repo).await?;

    // (id, title, body, author, state, comments [(author, body)])
    let (id, title, body, author, state, comments) = if s.repo.is_v1() {
        let iw = IssueService::new(&s.client, &s.identity, &s.bridge)
            .issue_state(s.repo.v1_contract_id()?, number)
            .await
            .context("issue_state")?
            .ok_or_else(|| not_found(repo, number))?;
        let i = iw.issue;
        (
            i.document_id,
            i.title,
            i.body,
            i.author,
            iw.state,
            Vec::new(),
        )
    } else {
        let collab = Collab::reader(&s.client);
        let view = collab
            .issue_view(&s.repo, number_arg(number)?)
            .await?
            .ok_or_else(|| not_found(repo, number))?;
        let comments = collab
            .comments(&s.repo, &view.issue.document_id)
            .await?
            .into_iter()
            .map(|c| (c.author, c.body))
            .collect::<Vec<_>>();
        let i = view.issue;
        (
            i.document_id,
            i.title,
            i.body,
            i.author,
            view.state,
            comments,
        )
    };

    ctx.emit(
        json!({
            "number": number,
            "title": title,
            "body": body,
            "author": author,
            "documentId": id,
            "state": { "open": state.open, "labels": state.labels, "assignees": state.assignees },
            "comments": comments.iter().map(|(a, b)| json!({"author": a, "body": b})).collect::<Vec<_>>(),
        }),
        || {
            let mark = if state.open { "open" } else { "closed" };
            println!("#{number} [{mark}] {title}");
            println!("author: {author}");
            if !state.labels.is_empty() {
                println!("labels: {}", labels_of(&state));
            }
            if !body.is_empty() {
                println!("\n{body}");
            }
            for (a, b) in &comments {
                println!("\n— {a}:\n{b}");
            }
        },
    );
    Ok(())
}

async fn create(ctx: &Ctx, repo: &str, title: &str, body: &str) -> Result<()> {
    let s = Session::open_v2(ctx, repo).await?;
    ctx.confirm_or_cancel(&format!(
        "Open issue {title:?} in {}? (one small document, ~0.0001 DASH)",
        s.repo.display()
    ))?;
    let before = s.balance().await;
    let created = s
        .collab()
        .create_issue(&s.repo, title, body, &default_journal_dir()?)
        .await?;
    let spent = s.spent_since(before).await;
    let price = dash_usd_price();

    ctx.emit(
        json!({
            "status": "created",
            "number": created.number,
            "documentId": created.document_id,
            "title": title,
            "resumed": created.resumed,
            "cost": cost_json(spent, price),
        }),
        || {
            let how = if created.resumed {
                " (finished an interrupted create; not paid twice)"
            } else {
                ""
            };
            println!(
                "✓ opened issue #{} in {}{how} · {}",
                created.number,
                s.repo.display(),
                cost_line(spent, price)
            );
        },
    );
    Ok(())
}

/// Resolve a v2 issue as an event target.
async fn target(s: &Session, repo: &str, number: u64) -> Result<Target> {
    Ok(s.collab()
        .issue(&s.repo, number_arg(number)?)
        .await?
        .ok_or_else(|| not_found(repo, number))?
        .target())
}

async fn comment(ctx: &Ctx, repo: &str, number: u64, body: &str) -> Result<()> {
    let s = Session::open_v2(ctx, repo).await?;
    let target = target(&s, repo, number).await?;
    ctx.confirm_or_cancel(&format!("Comment on issue #{number}? (one small document)"))?;
    let id = s
        .collab()
        .comment(&s.repo, &target.id, body, None, None)
        .await?;
    ctx.emit(
        json!({ "status": "commented", "issue": number, "commentId": id }),
        || println!("✓ commented on issue #{number}"),
    );
    Ok(())
}

async fn set_open(ctx: &Ctx, repo: &str, number: u64, close: bool) -> Result<()> {
    let s = Session::open_v2(ctx, repo).await?;
    let target = target(&s, repo, number).await?;
    let (verb, prompt) = if close {
        ("close", "Close")
    } else {
        ("reopen", "Reopen")
    };
    ctx.confirm_or_cancel(&format!("{prompt} issue #{number}? (one small document)"))?;
    let collab = s.collab();
    let (route, id) = collab.set_open(&s.repo, &target, close).await?;
    let open_now = collab
        .issue_view(&s.repo, target.number)
        .await?
        .map(|v| v.state.open);
    ctx.emit(
        json!({
            "status": if close { "closed" } else { "reopened" },
            "issue": number,
            "via": route,
            "eventId": id,
            "open": open_now,
        }),
        || {
            println!("✓ {verb}d issue #{number} {}", route_text(route));
            if open_now == Some(close) {
                println!(
                    "  note: it does not read as {} yet (the read may lag a block)",
                    if close { "closed" } else { "open" }
                );
            }
        },
    );
    Ok(())
}

async fn label(
    ctx: &Ctx,
    repo: &str,
    number: u64,
    add: Option<&str>,
    remove: Option<&str>,
) -> Result<()> {
    let (kind, value) = match (add, remove) {
        (Some(l), None) => (EventKind::LabelAdd, l),
        (None, Some(l)) => (EventKind::LabelRemove, l),
        _ => {
            return Err(crate::errors::usage(
                "pass exactly one of --add <label> or --remove <label>",
            ))
        }
    };
    let s = Session::open_v2(ctx, repo).await?;
    let target = target(&s, repo, number).await?;
    ctx.confirm_or_cancel(&format!(
        "Label issue #{number} ({value})? (one small document; members only)"
    ))?;
    let id = s
        .collab()
        .post_event(&s.repo, &target, kind, Some(value), None)
        .await?;
    ctx.emit(
        json!({
            "status": "labeled",
            "issue": number,
            "label": value,
            "action": if add.is_some() { "add" } else { "remove" },
            "eventId": id,
        }),
        || {
            let verb = if add.is_some() { "added" } else { "removed" };
            println!("✓ {verb} label {value} on issue #{number}");
        },
    );
    Ok(())
}
