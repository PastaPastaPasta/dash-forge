//! `dg collab` — collaborator (token) management: add / suspend / remove / list.

use anyhow::{bail, Context, Result};
use serde_json::json;

use forge_core::tokens::TokenService;

use crate::common::{resolve, RepoRef};
use crate::context::Ctx;
use crate::{CollabCommand, RoleArg};

/// Dispatch a `collab` subcommand.
pub async fn run(ctx: &Ctx, cmd: &CollabCommand) -> Result<()> {
    match cmd {
        CollabCommand::Add { repo, member, role } => add(ctx, repo, member, *role).await,
        CollabCommand::Suspend { repo, member, role } => suspend(ctx, repo, member, *role).await,
        CollabCommand::Remove { repo, member, role } => remove(ctx, repo, member, *role).await,
        CollabCommand::List { repo } => list(ctx, repo).await,
    }
}

async fn add(ctx: &Ctx, repo: &str, member: &str, role: RoleArg) -> Result<()> {
    let repo_ref = RepoRef::parse(repo)?;
    if !ctx.confirm(&format!(
        "Grant {role:?} to {member} on {repo}? (mints a token)"
    ))? {
        bail!("aborted");
    }
    let (client, bridge, identity) = ctx.connect_with_identity().await?;
    let handle = resolve(&client, &identity, &bridge, &repo_ref).await?;
    let svc = TokenService::new(&client, &identity, &bridge);
    svc.grant(&handle.repo_contract_id, member, role.to_core())
        .await
        .context("grant")?;

    ctx.emit(
        json!({ "status": "granted", "member": member, "role": format!("{role:?}").to_lowercase() }),
        || println!("Granted {role:?} to {member}."),
    );
    Ok(())
}

async fn suspend(ctx: &Ctx, repo: &str, member: &str, role: RoleArg) -> Result<()> {
    let repo_ref = RepoRef::parse(repo)?;
    if !ctx.confirm(&format!(
        "Suspend {role:?} for {member}? (freezes the token)"
    ))? {
        bail!("aborted");
    }
    let (client, bridge, identity) = ctx.connect_with_identity().await?;
    let handle = resolve(&client, &identity, &bridge, &repo_ref).await?;
    let svc = TokenService::new(&client, &identity, &bridge);
    svc.suspend(&handle.repo_contract_id, member, role.to_core())
        .await
        .context("suspend")?;

    ctx.emit(
        json!({ "status": "suspended", "member": member, "role": format!("{role:?}").to_lowercase() }),
        || println!("Suspended {role:?} for {member} (token frozen)."),
    );
    Ok(())
}

async fn remove(ctx: &Ctx, repo: &str, member: &str, role: RoleArg) -> Result<()> {
    let repo_ref = RepoRef::parse(repo)?;
    if !ctx.confirm(&format!(
        "Remove {member} ({role:?})? This FREEZES then DESTROYS their frozen balance"
    ))? {
        bail!("aborted");
    }
    let (client, bridge, identity) = ctx.connect_with_identity().await?;
    let handle = resolve(&client, &identity, &bridge, &repo_ref).await?;
    let svc = TokenService::new(&client, &identity, &bridge);
    svc.revoke(&handle.repo_contract_id, member, role.to_core())
        .await
        .context("revoke")?;

    ctx.emit(
        json!({ "status": "removed", "member": member, "role": format!("{role:?}").to_lowercase() }),
        || println!("Removed {member} ({role:?}) — frozen balance destroyed."),
    );
    Ok(())
}

async fn list(ctx: &Ctx, repo: &str) -> Result<()> {
    let repo_ref = RepoRef::parse(repo)?;
    let (client, bridge, identity) = ctx.connect_with_identity().await?;
    let handle = resolve(&client, &identity, &bridge, &repo_ref).await?;
    let svc = TokenService::new(&client, &identity, &bridge);
    let collaborators = svc
        .list_collaborators(&handle.repo_contract_id)
        .await
        .context("list_collaborators")?;

    let rows: Vec<_> = collaborators
        .iter()
        .map(|c| {
            json!({
                "identityId": c.identity_id,
                "write": c.holdings.write,
                "writeFrozen": c.holdings.write_frozen,
                "maintain": c.holdings.maintain,
                "maintainFrozen": c.holdings.maintain_frozen,
            })
        })
        .collect();

    ctx.emit(
        json!({ "count": rows.len(), "collaborators": rows }),
        || {
            println!("{} collaborator(s):", collaborators.len());
            for c in &collaborators {
                let mut roles = Vec::new();
                if c.holdings.write {
                    roles.push(if c.holdings.write_frozen {
                        "WRITE(frozen)"
                    } else {
                        "WRITE"
                    });
                }
                if c.holdings.maintain {
                    roles.push(if c.holdings.maintain_frozen {
                        "MAINTAIN(frozen)"
                    } else {
                        "MAINTAIN"
                    });
                }
                println!("  {}  [{}]", c.identity_id, roles.join(", "));
            }
        },
    );
    Ok(())
}
