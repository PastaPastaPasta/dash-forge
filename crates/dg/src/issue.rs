//! `dg issue` — issue tracking (list/view/create/comment/close/reopen/label).
//!
//! forge-v2 repositories go through [`forge_core::collab::v2::Collab`]: issues are numbered
//! by the `forge-v2.md` §6 rule, a create is journaled so a re-run resumes it, and close /
//! reopen pick their gate automatically (a member's `event`, else the author's
//! `authorEvent`). v1 repositories are read only: `list` and `view` still read them, every
//! write is refused (E605) before anything is signed.

use anyhow::{Context, Result};
use serde_json::json;

use forge_core::collab::v2::{Collab, StateRoute};
use forge_core::collab::{IssueService, StateFilter};
use forge_core::create::default_journal_dir;
use forge_core::rules::{EventKind, IssueState};
use forge_core::scope::RepoRef as Repo;

use crate::common::{number_arg, resolve, RepoRef};
use crate::context::Ctx;
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

fn keep(state: StateArg, open: bool) -> bool {
    match state {
        StateArg::All => true,
        StateArg::Open => open,
        StateArg::Closed => !open,
    }
}

fn not_found(repo: &str, number: u64) -> anyhow::Error {
    crate::errors::not_found(
        format!("issue #{number} not found in {repo}"),
        format!("`dg issue list {repo} --state all` lists its issues"),
    )
}

fn state_json(state: &IssueState) -> serde_json::Value {
    json!({
        "open": state.open,
        "labels": state.labels,
        "assignees": state.assignees,
    })
}

async fn list(ctx: &Ctx, repo: &str, state: StateArg, limit: u32) -> Result<()> {
    let repo_ref = RepoRef::parse(repo)?;
    let (client, bridge, identity) = ctx.connect_with_identity().await?;
    let handle = resolve(&client, &identity, &repo_ref).await?;

    // (number, title, author, state)
    let (rows, hidden): (Vec<(u64, String, String, IssueState)>, usize) = if handle.is_v1() {
        let filter = match state {
            StateArg::All => StateFilter::All,
            StateArg::Open => StateFilter::Open,
            StateArg::Closed => StateFilter::Closed,
        };
        let issues = IssueService::new(&client, &identity, &bridge)
            .list_issues(handle.v1_contract_id()?, filter, limit, None)
            .await
            .context("list_issues")?;
        let rows = issues
            .into_iter()
            .map(|iw| (iw.issue.number, iw.issue.title, iw.issue.author, iw.state))
            .collect();
        (rows, 0)
    } else {
        let collab = Collab::reader(&client);
        let (issues, hidden) = collab.list_issues(&handle, limit).await?;
        let mut rows = Vec::new();
        for issue in issues {
            let s = collab.issue_state(&handle, &issue).await?;
            if keep(state, s.open) {
                rows.push((u64::from(issue.number), issue.title, issue.author, s));
            }
        }
        (rows, hidden)
    };

    let json_rows: Vec<_> = rows
        .iter()
        .map(|(n, title, author, s)| {
            json!({
                "number": n,
                "title": title,
                "author": author,
                "open": s.open,
                "labels": s.labels,
                "assignees": s.assignees,
            })
        })
        .collect();
    ctx.emit(
        json!({ "count": rows.len(), "issues": json_rows, "hidden": hidden }),
        || {
            if rows.is_empty() {
                println!("no issues");
            }
            for (n, title, _, s) in &rows {
                let mark = if s.open { "open" } else { "closed" };
                let labels = if s.labels.is_empty() {
                    String::new()
                } else {
                    format!(
                        "  [{}]",
                        s.labels.iter().cloned().collect::<Vec<_>>().join(", ")
                    )
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
    let repo_ref = RepoRef::parse(repo)?;
    let (client, bridge, identity) = ctx.connect_with_identity().await?;
    let handle = resolve(&client, &identity, &repo_ref).await?;

    // (id, title, body, author, state, comments [(author, body)])
    let (id, title, body, author, state, comments) = if handle.is_v1() {
        let iw = IssueService::new(&client, &identity, &bridge)
            .issue_state(handle.v1_contract_id()?, number)
            .await
            .context("issue_state")?
            .ok_or_else(|| not_found(repo, number))?;
        (
            iw.issue.document_id,
            iw.issue.title,
            iw.issue.body,
            iw.issue.author,
            iw.state,
            Vec::new(),
        )
    } else {
        let collab = Collab::reader(&client);
        let view = collab
            .issue_view(&handle, number_arg(number)?)
            .await?
            .ok_or_else(|| not_found(repo, number))?;
        let comments = collab
            .comments(&handle, &view.issue.document_id)
            .await?
            .into_iter()
            .map(|c| (c.author, c.body))
            .collect::<Vec<_>>();
        (
            view.issue.document_id,
            view.issue.title,
            view.issue.body,
            view.issue.author,
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
            "state": state_json(&state),
            "comments": comments.iter().map(|(a, b)| json!({"author": a, "body": b})).collect::<Vec<_>>(),
        }),
        || {
            let mark = if state.open { "open" } else { "closed" };
            println!("#{number} [{mark}] {title}");
            println!("author: {author}");
            if !state.labels.is_empty() {
                let l: Vec<_> = state.labels.iter().cloned().collect();
                println!("labels: {}", l.join(", "));
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
    let repo_ref = RepoRef::parse(repo)?;
    let (client, bridge, identity) = ctx.connect_with_identity().await?;
    let handle = resolve(&client, &identity, &repo_ref).await?;
    handle.require_v2()?;
    if !ctx.confirm(&format!(
        "Open issue {title:?} in {}? (one small document, ~0.0001 DASH)",
        handle.display()
    ))? {
        return Err(crate::errors::cancelled());
    }
    let before = client.get_balance(&identity.id()).await.unwrap_or(0);
    let created = Collab::new(&client, &identity, &bridge)
        .create_issue(&handle, title, body, &default_journal_dir()?)
        .await?;
    let spent = spent(&client, &identity.id(), before).await;

    ctx.emit(
        json!({
            "status": "created",
            "number": created.number,
            "documentId": created.document_id,
            "title": title,
            "resumed": created.resumed,
            "cost": crate::fmt::cost_json(spent, crate::fmt::dash_usd_price()),
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
                handle.display(),
                crate::fmt::cost_line(spent, crate::fmt::dash_usd_price())
            );
        },
    );
    Ok(())
}

/// Credits spent since `before` (0 when the balance cannot be read).
pub async fn spent(client: &forge_core::platform::PlatformClient, id: &str, before: u64) -> u64 {
    client
        .get_balance(id)
        .await
        .map_or(0, |after| before.saturating_sub(after))
}

/// Resolve a v2 issue as an event target.
async fn target(
    collab: &Collab<'_>,
    handle: &Repo,
    repo: &str,
    number: u64,
) -> Result<forge_core::collab::v2::Target> {
    Ok(collab
        .issue(handle, number_arg(number)?)
        .await?
        .ok_or_else(|| not_found(repo, number))?
        .target())
}

async fn comment(ctx: &Ctx, repo: &str, number: u64, body: &str) -> Result<()> {
    let repo_ref = RepoRef::parse(repo)?;
    let (client, bridge, identity) = ctx.connect_with_identity().await?;
    let handle = resolve(&client, &identity, &repo_ref).await?;
    handle.require_v2()?;
    let collab = Collab::new(&client, &identity, &bridge);
    let target = target(&collab, &handle, repo, number).await?;
    if !ctx.confirm(&format!("Comment on issue #{number}? (one small document)"))? {
        return Err(crate::errors::cancelled());
    }
    let id = collab
        .comment(&handle, &target.id, body, None, None)
        .await?;
    ctx.emit(
        json!({ "status": "commented", "issue": number, "commentId": id }),
        || println!("✓ commented on issue #{number}"),
    );
    Ok(())
}

async fn set_open(ctx: &Ctx, repo: &str, number: u64, close: bool) -> Result<()> {
    let repo_ref = RepoRef::parse(repo)?;
    let (client, bridge, identity) = ctx.connect_with_identity().await?;
    let handle = resolve(&client, &identity, &repo_ref).await?;
    handle.require_v2()?;
    let collab = Collab::new(&client, &identity, &bridge);
    let target = target(&collab, &handle, repo, number).await?;
    let verb = if close { "Close" } else { "Reopen" };
    if !ctx.confirm(&format!("{verb} issue #{number}? (one small document)"))? {
        return Err(crate::errors::cancelled());
    }
    let (route, id) = collab.set_open(&handle, &target, close).await?;
    let state = collab
        .issue_view(&handle, target.number)
        .await?
        .map(|v| v.state);
    let open_now = state.as_ref().map(|s| s.open);
    ctx.emit(
        json!({
            "status": if close { "closed" } else { "reopened" },
            "issue": number,
            "via": route,
            "eventId": id,
            "open": open_now,
        }),
        || {
            let via = match route {
                StateRoute::Member => "as a member (event)",
                StateRoute::Author => "as the author (authorEvent)",
            };
            println!("✓ {}d issue #{number} {via}", verb.to_lowercase());
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
    let repo_ref = RepoRef::parse(repo)?;
    let (client, bridge, identity) = ctx.connect_with_identity().await?;
    let handle = resolve(&client, &identity, &repo_ref).await?;
    handle.require_v2()?;
    let collab = Collab::new(&client, &identity, &bridge);
    let target = target(&collab, &handle, repo, number).await?;
    if !ctx.confirm(&format!(
        "Label issue #{number} ({value})? (one small document; members only)"
    ))? {
        return Err(crate::errors::cancelled());
    }
    let id = collab
        .post_event(&handle, &target, kind, Some(value), None)
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
