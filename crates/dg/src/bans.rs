//! `dg repo ban | unban | bans` (UPDATE-1 `ban`): a maintainer's per-repo ban of an identity.
//! Forge apps hide a banned identity's issues, pull requests, comments and reviews in the repo
//! and refuse its new ones there (E610); Platform does not stop it writing. The reader rule is
//! [`forge_core::rules::bans`].

use anyhow::Result;
use serde_json::json;

use forge_core::rules::bans::{ban_reason_code, ban_reason_label, BAN_REASONS};

use crate::common::{resolve_identity, Reader, Session};
use crate::context::Ctx;
use crate::fmt::{cost_json, cost_line, safe};

/// Estimate of one `ban`: about a `policy` (47.97M measured on sakura with the maintainer
/// reference, 2026-10-05).
const BAN_CREDITS: u64 = 50_000_000;

/// The reason code `--reason` names (`None`: none given).
fn reason_code(reason: Option<&str>) -> Result<Option<u8>> {
    let Some(r) = reason else {
        return Ok(None);
    };
    ban_reason_code(r).map(Some).ok_or_else(|| {
        crate::errors::usage(format!(
            "--reason {r:?}: use one of {}",
            BAN_REASONS
                .iter()
                .map(|(_, n)| *n)
                .collect::<Vec<_>>()
                .join(", ")
        ))
    })
}

/// `dg repo ban <repo> <who> [--reason …]`.
pub async fn ban(ctx: &Ctx, repo: &str, who: &str, reason: Option<&str>) -> Result<()> {
    let code = reason_code(reason)?;
    let s = Session::open(ctx, repo).await?;
    let id = resolve_identity(&s.client, who, "identity").await?;
    let price = ctx.usd_price();
    ctx.confirm_or_cancel(&format!(
        "Ban {} from {}? Forge apps then hide what they wrote there and refuse their new issues, pull requests, comments and reviews ({}).",
        safe(who),
        s.repo.display(),
        cost_line(BAN_CREDITS, price)
    ))?;
    let collab = s.collab();
    let before = s.balance().await;
    let doc = collab.ban(&s.repo, &id, code).await?;
    let spent = s.spent_since(before).await;
    ctx.emit(
        json!({
            "status": "banned",
            "repo": s.repo.display(),
            "identityId": id,
            "reason": ban_reason_label(code),
            "documentId": doc,
            "cost": cost_json(spent, price),
        }),
        || {
            println!(
                "✓ banned {} from {} · {}",
                safe(who),
                s.repo.display(),
                cost_line(spent, price)
            );
        },
    );
    Ok(())
}

/// `dg repo unban <repo> <who>`.
pub async fn unban(ctx: &Ctx, repo: &str, who: &str) -> Result<()> {
    let s = Session::open(ctx, repo).await?;
    let id = resolve_identity(&s.client, who, "identity").await?;
    ctx.confirm_or_cancel(&format!(
        "Lift your ban of {} from {}? (part of its storage fee is refunded)",
        safe(who),
        s.repo.display()
    ))?;
    match s.collab().unban(&s.repo, &id).await? {
        Some(doc) => ctx.emit(
            json!({"status": "lifted", "repo": s.repo.display(), "identityId": id, "documentId": doc}),
            || println!("✓ lifted your ban of {} from {}", safe(who), s.repo.display()),
        ),
        None => ctx.emit(
            json!({"status": "none", "repo": s.repo.display(), "identityId": id}),
            || {
                println!(
                    "you have no ban of {} in {}: only the maintainer who wrote a ban can lift it (`dg repo bans {}` lists who did)",
                    safe(who),
                    s.repo.display(),
                    s.repo.display()
                );
            },
        ),
    }
    Ok(())
}

/// `dg repo bans <repo>`: the standing bans (the owner's and current maintainers').
pub async fn list(ctx: &Ctx, repo: &str) -> Result<()> {
    let s = Reader::open_unsealed(ctx, repo).await?;
    let standing = s.collab().standing_bans(&s.repo).await;
    let rows: Vec<_> = standing
        .values()
        .map(|b| {
            json!({
                "identityId": b.identity,
                "by": b.by,
                "reason": ban_reason_label(b.reason),
                "createdAt": b.created_at,
                "documentId": b.id,
            })
        })
        .collect();
    ctx.emit(json!({"repo": s.repo.display(), "bans": rows}), || {
        if standing.is_empty() {
            println!("nobody is banned from {}", s.repo.display());
            return;
        }
        for b in standing.values() {
            println!(
                "{}  banned by {} on {}{}",
                b.identity,
                b.by,
                crate::cost::format_utc(b.created_at),
                ban_reason_label(b.reason).map_or_else(String::new, |r| format!(" ({r})"))
            );
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reasons_are_named() {
        assert_eq!(reason_code(None).unwrap(), None);
        assert_eq!(reason_code(Some("Spam")).unwrap(), Some(1));
        assert!(reason_code(Some("rude")).is_err());
    }
}
