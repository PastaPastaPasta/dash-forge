//! `dg collab` — repository members: add / remove / list.
//!
//! On forge-v2 a member is a `writer` or `maintainer` document the repo owner creates
//! (add) or deletes (remove); consensus refuses the removed member's next write at once.
//! There is no suspend: remove and re-add instead. v1 repositories are read only; their
//! token-based collaborator list can still be listed.

use anyhow::{Context, Result};
use serde_json::json;

use forge_core::members::{doc_type as role_name, MemberReader, MemberService};
use forge_core::tokens::TokenService;
use forge_core::user_error::{codes, UserError};

use crate::common::{resolve, RepoRef};
use crate::context::Ctx;
use crate::{CollabCommand, RoleArg};

/// Dispatch a `collab` subcommand.
pub async fn run(ctx: &Ctx, cmd: &CollabCommand) -> Result<()> {
    match cmd {
        CollabCommand::Add { repo, member, role } => add(ctx, repo, member, *role).await,
        CollabCommand::Suspend { .. } | CollabCommand::Unsuspend { .. } => Err(UserError::new(
            codes::NOT_IMPLEMENTED,
            "suspend/unsuspend are not supported on forge-v2",
        )
        .cause("forge-v2 has no freeze: membership is a document the owner creates or deletes")
        .fix("`dg collab remove <owner>/<repo> <member>` revokes access immediately")
        .fix("`dg collab add <owner>/<repo> <member> --role writer` restores it")
        .into()),
        CollabCommand::Remove { repo, member, role } => remove(ctx, repo, member, *role).await,
        CollabCommand::List { repo } => list(ctx, repo).await,
    }
}

async fn add(ctx: &Ctx, repo: &str, member: &str, role: RoleArg) -> Result<()> {
    let repo_ref = RepoRef::parse(repo)?;
    let role = role.to_core();
    if !ctx.confirm(&format!(
        "Add {member} as a {} of {repo}? (one small document)",
        role_name(role)
    ))? {
        return Err(crate::errors::cancelled());
    }
    let (client, bridge, identity) = ctx.connect_with_identity().await?;
    let handle = resolve(&client, &identity, &repo_ref).await?;
    let granted = MemberService::new(&client, &identity, &bridge)
        .grant(&handle, member, role)
        .await
        .context("adding the member")?;
    ctx.emit(
        json!({
            "status": "granted",
            "member": member,
            "role": role_name(role),
            "documentId": granted.document_id,
            "repo": handle.display(),
        }),
        || {
            println!(
                "{member} is a {} of {} (document {}).",
                role_name(role),
                handle.display(),
                granted.document_id
            );
        },
    );
    Ok(())
}

async fn remove(ctx: &Ctx, repo: &str, member: &str, role: RoleArg) -> Result<()> {
    let repo_ref = RepoRef::parse(repo)?;
    let role = role.to_core();
    if !ctx.confirm(&format!(
        "Remove {member} as a {} of {repo}? Their next push is refused at once",
        role_name(role)
    ))? {
        return Err(crate::errors::cancelled());
    }
    let (client, bridge, identity) = ctx.connect_with_identity().await?;
    let handle = resolve(&client, &identity, &repo_ref).await?;
    let removed = MemberService::new(&client, &identity, &bridge)
        .revoke(&handle, member, role)
        .await
        .context("removing the member")?;
    ctx.emit(
        json!({
            "status": if removed { "removed" } else { "not_a_member" },
            "member": member,
            "role": role_name(role),
            "repo": handle.display(),
        }),
        || {
            if removed {
                println!(
                    "Removed {member} ({}) from {}.",
                    role_name(role),
                    handle.display()
                );
            } else {
                println!(
                    "{member} is not a {} of {}; nothing to remove.",
                    role_name(role),
                    handle.display()
                );
            }
        },
    );
    Ok(())
}

async fn list(ctx: &Ctx, repo: &str) -> Result<()> {
    let repo_ref = RepoRef::parse(repo)?;
    let (client, _bridge, identity) = ctx.connect_with_identity().await?;
    let handle = resolve(&client, &identity, &repo_ref).await?;

    if let Ok(contract_id) = handle.v1_contract_id() {
        // v1 (read only): the token balances are the collaborator list.
        let collaborators = TokenService::new(&client)
            .list_collaborators(contract_id)
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
            json!({ "generation": "v1", "count": rows.len(), "collaborators": rows }),
            || {
                println!(
                    "{} collaborator(s) (v1 repo, read only):",
                    collaborators.len()
                );
                for c in &collaborators {
                    println!(
                        "  {}  write={} maintain={}",
                        c.identity_id, c.holdings.write, c.holdings.maintain
                    );
                }
            },
        );
        return Ok(());
    }

    let members = MemberReader::new(&client)
        .list(&handle)
        .await
        .context("listing members")?;
    let rows: Vec<_> = members
        .iter()
        .map(|m| {
            json!({
                "identityId": m.identity_id,
                "role": role_name(m.role),
                "documentId": m.document_id,
                "since": m.created_at,
            })
        })
        .collect();
    ctx.emit(
        json!({ "generation": "v2", "count": rows.len(), "members": rows }),
        || {
            println!("{} member(s) of {}:", members.len(), handle.display());
            for m in &members {
                println!("  {}  {}", m.identity_id, role_name(m.role));
            }
        },
    );
    Ok(())
}
