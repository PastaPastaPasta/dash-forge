//! `dg issue` — issue tracking (list/view/create/comment/close/reopen/label).

use anyhow::{bail, Context, Result};
use serde_json::json;

use forge_core::collab::{IssueService, StateFilter};
use forge_core::rules::EventKind;

use crate::common::{resolve, RepoRef};
use crate::context::Ctx;
use crate::{IssueCommand, StateArg};

/// Dispatch an `issue` subcommand.
pub async fn run(ctx: &Ctx, cmd: &IssueCommand) -> Result<()> {
    match cmd {
        IssueCommand::List { repo, state, limit } => list(ctx, repo, *state, *limit).await,
        IssueCommand::View { repo, number } => view(ctx, repo, *number).await,
        IssueCommand::Create { repo, title, body } => create(ctx, repo, title, body).await,
        IssueCommand::Comment { repo, number, body } => comment(ctx, repo, *number, body).await,
        IssueCommand::Close { repo, number } => close_reopen(ctx, repo, *number, true).await,
        IssueCommand::Reopen { repo, number } => close_reopen(ctx, repo, *number, false).await,
        IssueCommand::Label {
            repo,
            number,
            add,
            remove,
        } => label(ctx, repo, *number, add.as_deref(), remove.as_deref()).await,
    }
}

fn to_filter(state: StateArg) -> StateFilter {
    match state {
        StateArg::All => StateFilter::All,
        StateArg::Open => StateFilter::Open,
        StateArg::Closed => StateFilter::Closed,
    }
}

async fn list(ctx: &Ctx, repo: &str, state: StateArg, limit: u32) -> Result<()> {
    let repo_ref = RepoRef::parse(repo)?;
    let (client, bridge, identity) = ctx.connect_with_identity().await?;
    let handle = resolve(&client, &identity, &bridge, &repo_ref).await?;
    let svc = IssueService::new(&client, &identity, &bridge);
    let issues = svc
        .list_issues(&handle.repo_contract_id, to_filter(state), limit, None)
        .await
        .context("list_issues")?;

    let rows: Vec<_> = issues
        .iter()
        .map(|iw| {
            json!({
                "number": iw.issue.number,
                "title": iw.issue.title,
                "author": iw.issue.author,
                "open": iw.state.open,
                "labels": iw.state.labels,
                "assignees": iw.state.assignees,
            })
        })
        .collect();

    ctx.emit(json!({ "count": rows.len(), "issues": rows }), || {
        for iw in &issues {
            let mark = if iw.state.open { "open" } else { "closed" };
            println!("#{:<4} [{mark}] {}", iw.issue.number, iw.issue.title);
        }
    });
    Ok(())
}

async fn view(ctx: &Ctx, repo: &str, number: u64) -> Result<()> {
    let repo_ref = RepoRef::parse(repo)?;
    let (client, bridge, identity) = ctx.connect_with_identity().await?;
    let handle = resolve(&client, &identity, &bridge, &repo_ref).await?;
    let svc = IssueService::new(&client, &identity, &bridge);
    let iw = svc
        .issue_state(&handle.repo_contract_id, number)
        .await
        .context("issue_state")?
        .ok_or_else(|| anyhow::anyhow!("issue #{number} not found"))?;

    ctx.emit(
        json!({
            "number": iw.issue.number,
            "title": iw.issue.title,
            "body": iw.issue.body,
            "author": iw.issue.author,
            "documentId": iw.issue.document_id,
            "state": serde_json::to_value(&iw.state).unwrap_or_default(),
        }),
        || {
            let mark = if iw.state.open { "open" } else { "closed" };
            println!("#{} [{mark}] {}", iw.issue.number, iw.issue.title);
            println!("author: {}", iw.issue.author);
            if !iw.state.labels.is_empty() {
                println!(
                    "labels: {}",
                    iw.state
                        .labels
                        .iter()
                        .cloned()
                        .collect::<Vec<_>>()
                        .join(", ")
                );
            }
            if !iw.issue.body.is_empty() {
                println!("\n{}", iw.issue.body);
            }
        },
    );
    Ok(())
}

async fn create(ctx: &Ctx, repo: &str, title: &str, body: &str) -> Result<()> {
    let repo_ref = RepoRef::parse(repo)?;
    if !ctx.confirm(&format!("Create issue {title:?}? (a small ungated write)"))? {
        bail!("aborted");
    }
    let (client, bridge, identity) = ctx.connect_with_identity().await?;
    let handle = resolve(&client, &identity, &bridge, &repo_ref).await?;
    let svc = IssueService::new(&client, &identity, &bridge);
    let issue = svc
        .create_issue(&handle.repo_contract_id, title, body)
        .await
        .context("create_issue")?;

    ctx.emit(
        json!({
            "status": "created",
            "number": issue.number,
            "documentId": issue.document_id,
            "title": issue.title,
        }),
        || println!("Created issue #{}: {}", issue.number, issue.title),
    );
    Ok(())
}

async fn comment(ctx: &Ctx, repo: &str, number: u64, body: &str) -> Result<()> {
    let repo_ref = RepoRef::parse(repo)?;
    if !ctx.confirm("Post comment? (a small ungated write)")? {
        bail!("aborted");
    }
    let (client, bridge, identity) = ctx.connect_with_identity().await?;
    let handle = resolve(&client, &identity, &bridge, &repo_ref).await?;
    let svc = IssueService::new(&client, &identity, &bridge);
    let issue = svc
        .get_issue(&handle.repo_contract_id, number)
        .await?
        .ok_or_else(|| anyhow::anyhow!("issue #{number} not found"))?;
    let doc_id = svc
        .comment(&handle.repo_contract_id, &issue.document_id, body, None)
        .await
        .context("comment")?;

    ctx.emit(
        json!({ "status": "commented", "issue": number, "commentId": doc_id }),
        || println!("Commented on issue #{number} (comment {doc_id})."),
    );
    Ok(())
}

async fn close_reopen(ctx: &Ctx, repo: &str, number: u64, close: bool) -> Result<()> {
    let repo_ref = RepoRef::parse(repo)?;
    let verb = if close { "Close" } else { "Reopen" };
    if !ctx.confirm(&format!("{verb} issue #{number}? (a small ungated event)"))? {
        bail!("aborted");
    }
    let (client, bridge, identity) = ctx.connect_with_identity().await?;
    let handle = resolve(&client, &identity, &bridge, &repo_ref).await?;
    let svc = IssueService::new(&client, &identity, &bridge);
    let issue = svc
        .get_issue(&handle.repo_contract_id, number)
        .await?
        .ok_or_else(|| anyhow::anyhow!("issue #{number} not found"))?;
    let event_id = if close {
        svc.close(&handle.repo_contract_id, &issue.document_id)
            .await?
    } else {
        svc.reopen(&handle.repo_contract_id, &issue.document_id)
            .await?
    };

    ctx.emit(
        json!({
            "status": if close { "closed" } else { "reopened" },
            "issue": number,
            "eventId": event_id,
        }),
        || println!("{verb}d issue #{number} (event {event_id})."),
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
        (Some(l), None) => (EventKind::LabelAdd, l.to_string()),
        (None, Some(l)) => (EventKind::LabelRemove, l.to_string()),
        _ => bail!("pass exactly one of --add <label> or --remove <label>"),
    };
    let repo_ref = RepoRef::parse(repo)?;
    if !ctx.confirm(&format!(
        "Label issue #{number} ({value})? (a small ungated event)"
    ))? {
        bail!("aborted");
    }
    let (client, bridge, identity) = ctx.connect_with_identity().await?;
    let handle = resolve(&client, &identity, &bridge, &repo_ref).await?;
    let svc = IssueService::new(&client, &identity, &bridge);
    let issue = svc
        .get_issue(&handle.repo_contract_id, number)
        .await?
        .ok_or_else(|| anyhow::anyhow!("issue #{number} not found"))?;
    let event_id = svc
        .add_event(
            &handle.repo_contract_id,
            &issue.document_id,
            kind,
            Some(&value),
            None,
        )
        .await
        .context("label event")?;

    ctx.emit(
        json!({
            "status": "labeled",
            "issue": number,
            "label": value,
            "action": if add.is_some() { "add" } else { "remove" },
            "eventId": event_id,
        }),
        || println!("Labeled issue #{number}: {value} (event {event_id})."),
    );
    Ok(())
}
