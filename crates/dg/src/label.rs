//! `dg label` — a repository's label definitions (forge-core `label`, member-gated,
//! newest definition per name wins). Applying a label to an issue or PR is
//! `dg issue label` (a member `event`).

use anyhow::Result;
use serde_json::json;

use crate::common::Session;
use crate::context::Ctx;
use crate::LabelCommand;
use forge_core::rules::v2::Visibility;

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
        LabelCommand::Delete { repo, name } => delete(ctx, repo, name).await,
    }
}

/// Delete label `name` (forge-core `Collab::delete_label`): the signer's definition documents
/// are deleted; when another member also defined it, a retirement is written first so readers
/// stop offering it. Labels already applied to issues stay in their history.
async fn delete(ctx: &Ctx, repo: &str, name: &str) -> Result<()> {
    let s = Session::open(ctx, repo).await?;
    ctx.confirm_or_cancel(&format!(
        "Delete label {name:?} from {}? (deletes your definitions of it; retires it if others defined it too)",
        s.repo.display()
    ))?;
    let (retired, deleted) = s.collab().delete_label(&s.repo, name).await?;
    if !retired && deleted == 0 {
        return Err(crate::errors::not_found(
            format!("no label {name:?} in {}", s.repo.display()),
            format!("`dg label list {repo}` lists its labels"),
        ));
    }
    ctx.emit(
        json!({
            "status": "deleted",
            "name": name,
            "retired": retired,
            "deletedDocuments": deleted,
        }),
        || {
            let note = if retired {
                " and retired it (another member's definition remains)"
            } else {
                ""
            };
            println!("✓ deleted label {name}: {deleted} definition document(s) removed{note}");
        },
    );
    Ok(())
}

async fn list(ctx: &Ctx, repo: &str, all: bool) -> Result<()> {
    let s = Session::open(ctx, repo).await?;
    let labels = s.collab().labels(&s.repo).await?;
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
    let s = Session::open_for_write(ctx, repo, "label not changed").await?;
    let verb = if retired { "Retire" } else { "Define" };
    // docs/security/private-repos.md §7: a label definition (name, colour, description) stays
    // plaintext; the labels put on issues are sealed
    let plaintext = if s.repo.visibility == Visibility::Private {
        "; note: label definitions (names and descriptions) are not encrypted in this release"
    } else {
        ""
    };
    ctx.confirm_or_cancel(&format!(
        "{verb} label {name:?} in {}? (one small document; members only{plaintext})",
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
