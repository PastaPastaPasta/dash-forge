//! `dg collab` — repository members: add / remove / list.
//!
//! On forge-v2 a member is a `writer` or `maintainer` document the repo owner creates
//! (add) or deletes (remove); consensus refuses the removed member's next write at once.
//! There is no suspend: remove and re-add instead.
//!
//! On a **private** repository (`docs/security/private-repos.md` §5.5) add also wraps the
//! current key epoch to the new member, and is refused before anything is written when the
//! member has no encryption key; remove rotates the key after the delete (a new epoch wrapped
//! to every remaining member, you first, then its anchor). Past content stays readable to
//! the removed member: encryption can't take back what was shared.

use anyhow::{Context, Result};
use serde_json::json;

use forge_core::keyring::PrivateSigner;
use forge_core::members::{doc_type as role_name, MemberReader, MemberService};
use forge_core::rules::v2::Visibility;
use forge_core::user_error::{codes, UserError};

use crate::fmt::{cost_line, dash_usd_price};

use crate::common::{resolve, RepoRef};
use crate::context::Ctx;
use crate::{CollabCommand, RoleArg};

/// Dispatch a `collab` subcommand.
pub async fn run(ctx: &Ctx, cmd: &CollabCommand) -> Result<()> {
    match cmd {
        CollabCommand::Add { repo, member, role } => add(ctx, repo, member, *role).await,
        CollabCommand::Remove { repo, member, role } => remove(ctx, repo, member, *role).await,
        CollabCommand::List { repo } => list(ctx, repo).await,
    }
}

async fn add(ctx: &Ctx, repo: &str, member: &str, role: RoleArg) -> Result<()> {
    let repo_ref = RepoRef::parse(repo)?;
    let role = role.to_core();
    let (client, bridge, identity) = ctx.connect_with_identity().await?;
    let handle = resolve(&client, &identity, &repo_ref).await?;
    let private = handle.visibility == Visibility::Private;
    if private {
        // Checked before anything is written: a member with no encryption key could be
        // granted a role but never read the repository (§5.5, ux-dx-spec §9).
        if !crate::keys::member_can_receive(&client, &handle, member).await? {
            return Err(UserError::new(
                codes::NO_ENCRYPTION_KEY,
                format!("{member} has no encryption key yet"),
            )
            .cause(format!(
                "{} is private: its key is wrapped to each member's encryption key",
                handle.display()
            ))
            .fix(format!(
                "send them this: `dg auth keys add --encryption`, or Settings → Keys → Enable private repos (one master-key signature); then run `dg collab add {repo} {member}` again"
            ))
            .note("nothing was written")
            .into());
        }
        // The key must be wrappable by us now (our own key, and an epoch we can write).
        let signer = PrivateSigner {
            client: &client,
            identity: &identity,
            bridge: &bridge,
        };
        signer.keyring(&handle).await?.writer(&handle)?;
    }
    let what = if private {
        "a membership document + a key wrap, ~0.0006 DASH"
    } else {
        "one small document"
    };
    if !ctx.confirm(&format!(
        "Add {member} as a {} of {repo}? ({what})",
        role_name(role)
    ))? {
        return Err(crate::errors::cancelled());
    }
    let granted = MemberService::new(&client, &identity, &bridge)
        .grant(&handle, member, role)
        .await
        .context("adding the member")?;
    if private {
        let signer = PrivateSigner {
            client: &client,
            identity: &identity,
            bridge: &bridge,
        };
        forge_core::keyring::add_member_wrap(&signer, &handle, member)
            .await
            .context("wrapping the repository key to the new member (re-run `dg collab add` to finish: the membership stands)")?;
    }
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
    let (client, bridge, identity) = ctx.connect_with_identity().await?;
    let handle = resolve(&client, &identity, &repo_ref).await?;
    let private = handle.visibility == Visibility::Private;
    let prompt = if private {
        let members = MemberReader::new(&client).list(&handle).await?;
        // After the removal: everyone else (the rotator included) gets a wrap, plus an anchor.
        let remaining = members
            .iter()
            .filter(|m| m.identity_id != member)
            .map(|m| m.identity_id.as_str())
            .collect::<std::collections::BTreeSet<_>>()
            .len();
        let (est, what) = crate::keys::rotation_estimate(remaining);
        format!(
            "Removing {member} rotates the repo key. New pushes, issues and comments will be \
             unreadable to {member}. Everything {member} could already read stays readable to \
             {member} — encryption can't take back what was shared.\n\
             Remove {member} as a {} of {repo}? (1 delete + {what}, {})",
            role_name(role),
            cost_line(est + 20_000_000, dash_usd_price())
        )
    } else {
        format!(
            "Remove {member} as a {} of {repo}? Their next push is refused at once",
            role_name(role)
        )
    };
    if !ctx.confirm(&prompt)? {
        return Err(crate::errors::cancelled());
    }
    let removed = MemberService::new(&client, &identity, &bridge)
        .revoke(&handle, member, role)
        .await
        .context("removing the member")?;
    // Nothing was deleted (not a member): nothing to rotate. A leftover wrap to a non-member
    // is what `dg repo keys repair` finds and rotates away.
    let rotation = if private && removed {
        Some(rotate_after_removal(&client, &identity, &bridge, &handle, member, role).await?)
    } else {
        None
    };
    ctx.emit(
        json!({
            "status": if removed { "removed" } else { "not_a_member" },
            "member": member,
            "role": role_name(role),
            "repo": handle.display(),
            "rotation": rotation.as_ref().map(crate::keys::rotation_json),
        }),
        || {
            if let Some(r) = &rotation {
                crate::keys::print_rotation(&handle, r);
            }
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

/// The rotation a removal from a private repository runs (§5.5). The member's deletion must
/// be visible first: a wrap for the new epoch to them would hand back what the removal took
/// (they are excluded explicitly too, whatever a lagging read says). A member still holding
/// another role keeps it, so they stay a member and are wrapped like the rest.
async fn rotate_after_removal(
    client: &forge_core::platform::PlatformClient,
    identity: &forge_core::platform::LoadedIdentity,
    bridge: &forge_core::keystore::BridgeIdentity,
    repo: &forge_core::scope::RepoRef,
    member: &str,
    removed_role: forge_core::rules::v2::Role,
) -> Result<forge_core::keyring::Rotation> {
    // Wait until the deleted role document is gone from a proved read (a lagging node would
    // otherwise list them, and the rotation must not wrap to them). `rotate` excludes them
    // explicitly as well, unless they still hold the other role.
    let reader = MemberReader::new(client);
    let mut roles = reader.roles_of(repo, member).await?;
    for _ in 0..12 {
        if !roles.iter().any(|m| m.role == removed_role) {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
        roles = reader.roles_of(repo, member).await?;
    }
    let exclude: Vec<String> = if roles.iter().all(|m| m.role == removed_role) {
        vec![member.to_string()]
    } else {
        Vec::new()
    };
    let signer = PrivateSigner {
        client,
        identity,
        bridge,
    };
    forge_core::keyring::rotate(&signer, repo, &exclude)
        .await
        .context(
        "rotating the repository key after the removal (run `dg repo keys repair` to finish it)",
    )
}

async fn list(ctx: &Ctx, repo: &str) -> Result<()> {
    let repo_ref = RepoRef::parse(repo)?;
    let (client, _bridge, identity) = ctx.connect_with_identity().await?;
    let handle = resolve(&client, &identity, &repo_ref).await?;

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
    ctx.emit(json!({ "count": rows.len(), "members": rows }), || {
        println!("{} member(s) of {}:", members.len(), handle.display());
        for m in &members {
            println!("  {}  {}", m.identity_id, role_name(m.role));
        }
    });
    Ok(())
}
