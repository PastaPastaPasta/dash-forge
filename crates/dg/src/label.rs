//! `dg label` — a repository's label definitions (forge-core `label`, member-gated,
//! newest definition per name wins). Applying a label to an issue or PR is
//! `dg issue label` (a member `event`).

use anyhow::{Context, Result};
use serde_json::json;

use forge_core::collab::v2::Collab;
use forge_core::collab::LabelService;

use crate::common::Session;
use crate::context::Ctx;
use crate::LabelCommand;

/// Dispatch a `label` subcommand.
pub async fn run(ctx: &Ctx, cmd: &LabelCommand) -> Result<()> {
    match cmd {
        LabelCommand::List { repo, all } => list(ctx, repo, *all).await,
        LabelCommand::Create {
            repo,
            name,
            color,
            description,
        } => define(ctx, repo, name, color, description, false).await,
        LabelCommand::Retire { repo, name } => define(ctx, repo, name, "", "", true).await,
    }
}

async fn list(ctx: &Ctx, repo: &str, all: bool) -> Result<()> {
    let s = Session::open(ctx, repo).await?;
    let labels = if s.repo.is_v1() {
        LabelService::new(&s.client, &s.identity, &s.bridge)
            .list_labels(s.repo.v1_contract_id()?)
            .await
            .context("list_labels")?
    } else {
        Collab::reader(&s.client).labels(&s.repo).await?
    };
    let shown: Vec<_> = labels.iter().filter(|l| all || !l.retired).collect();
    ctx.emit(
        json!({
            "count": shown.len(),
            "labels": shown.iter().map(|l| json!({
                "name": l.name,
                "color": l.color,
                "description": l.description,
                "retired": l.retired,
            })).collect::<Vec<_>>(),
        }),
        || {
            if shown.is_empty() {
                println!("no labels");
            }
            for l in &shown {
                let retired = if l.retired { " (retired)" } else { "" };
                println!("{:<30} {:<8} {}{retired}", l.name, l.color, l.description);
            }
        },
    );
    Ok(())
}

async fn define(
    ctx: &Ctx,
    repo: &str,
    name: &str,
    color: &str,
    description: &str,
    retired: bool,
) -> Result<()> {
    let s = Session::open_v2(ctx, repo).await?;
    let verb = if retired { "Retire" } else { "Define" };
    ctx.confirm_or_cancel(&format!(
        "{verb} label {name:?} in {}? (one small document; members only)",
        s.repo.display()
    ))?;
    let id = s
        .collab()
        .create_label(&s.repo, name, color, description, retired)
        .await?;
    ctx.emit(
        json!({
            "status": if retired { "retired" } else { "defined" },
            "name": name,
            "documentId": id,
        }),
        || println!("✓ {}d label {name}", verb.to_lowercase()),
    );
    Ok(())
}
