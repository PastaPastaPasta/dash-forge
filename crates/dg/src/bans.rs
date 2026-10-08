//! `dg repo ban | unban | bans` (UPDATE-1 `ban`): a maintainer's per-repo ban of an identity.
//! Forge apps hide a banned identity's issues, pull requests, comments and reviews in the repo
//! and refuse its new ones there (E610); Platform does not stop it writing. The reader rule is
//! [`forge_core::rules::bans`].

use anyhow::Result;
use serde_json::json;

use forge_core::rules::bans::{ban_reason_code, ban_reason_label, BAN_REASONS};
use forge_core::user_error::{codes, UserError};

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
    let collab = s.collab();
    let Some(doc) = collab.unban(&s.repo, &id).await? else {
        // Q5: an error, not a plain line: nothing was lifted. Whether another ban of them counts
        // (its writer is still the owner or a maintainer) decides which; read on this path only.
        let others = collab.bans(&s.repo, Some(&id)).await?;
        let counting = if others.is_empty() {
            0
        } else {
            let scope = collab.ban_scope(&s.repo).await?;
            // As `dg repo bans` judges it: written by a moderator, of a non-moderator.
            others
                .iter()
                .filter(|b| scope.moderates(&b.by) && !scope.moderates(&b.identity))
                .count()
        };
        return Err(no_ban_of_yours(who, &s.repo.display(), counting, others.len()).into());
    };
    ctx.emit(
        json!({"status": "lifted", "repo": s.repo.display(), "identityId": id, "documentId": doc}),
        || {
            println!(
                "✓ lifted your ban of {} from {}",
                safe(who),
                s.repo.display()
            );
        },
    );
    Ok(())
}

/// The refusal of `dg repo unban` when the caller wrote no ban of `who`: E601 when another ban
/// of `who` counts (`counting`; only a ban's writer can lift it); E102 when none does, `all`
/// counting the bans that no longer count too.
fn no_ban_of_yours(who: &str, repo: &str, counting: usize, all: usize) -> UserError {
    let who = safe(who);
    let list = format!("`dg repo bans {repo}` lists who banned whom");
    if counting == 0 {
        let u = UserError::new(
            codes::NOT_FOUND,
            format!("nothing lifted: {who} is not banned from {repo}"),
        );
        let u = if all > 0 {
            u.cause("a ban of them remains but no longer counts: its writer is no longer a maintainer, or they are one now")
        } else {
            u
        };
        return u.note(list);
    }
    UserError::new(
        codes::NOT_A_WRITER,
        format!("nothing lifted: you have no ban of {who} in {repo}; someone else banned them"),
    )
    .cause("only the maintainer who wrote a ban can lift it")
    .fix(format!(
        "ask the maintainer who wrote it to run `dg repo unban {repo} {who}`; {list}"
    ))
    .note("nothing was written or paid")
}

/// `dg repo bans <repo>`: every ban, with its writer, and whether it counts (its writer is the
/// owner or a current maintainer, and it bans neither); the one that decides is marked.
pub async fn list(ctx: &Ctx, repo: &str) -> Result<()> {
    let s = Reader::open_unsealed(ctx, repo).await?;
    let collab = s.collab();
    let mut bans = collab.bans(&s.repo, None).await?;
    bans.sort_by(|a, b| {
        (&a.identity, a.created_at, &a.id).cmp(&(&b.identity, b.created_at, &b.id))
    });
    let scope = if bans.is_empty() {
        None
    } else {
        Some(collab.ban_scope(&s.repo).await?)
    };
    let standing = scope
        .as_ref()
        .map(|sc| forge_core::rules::bans::standing_bans(&bans, sc))
        .unwrap_or_default();
    let counts = |b: &forge_core::rules::bans::Ban| {
        scope
            .as_ref()
            .is_some_and(|sc| sc.moderates(&b.by) && !sc.moderates(&b.identity))
    };
    let rows: Vec<_> = bans
        .iter()
        .map(|b| {
            json!({
                "identityId": b.identity,
                "by": b.by,
                "reason": ban_reason_label(b.reason),
                "createdAt": b.created_at,
                "documentId": b.id,
                "counts": counts(b),
                "decides": standing.get(&b.identity).is_some_and(|d| d.id == b.id),
            })
        })
        .collect();
    ctx.emit(json!({"repo": s.repo.display(), "bans": rows}), || {
        if bans.is_empty() {
            println!("nobody is banned from {}", s.repo.display());
            return;
        }
        for b in &bans {
            let note = if counts(b) {
                ""
            } else {
                "  (not counted: its writer is no longer a maintainer, or it bans one)"
            };
            let decides = if standing.get(&b.identity).is_some_and(|d| d.id == b.id) {
                "  (decides)"
            } else {
                ""
            };
            println!(
                "{}  banned by {} on {}{}{decides}{note}",
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
    use clap::CommandFactory;

    /// Q5: lifting a ban you did not write is an error, with a code: E601 when someone else
    /// banned them, E102 when nobody did.
    #[test]
    fn unbanning_without_a_ban_of_yours_is_an_error() {
        let theirs = no_ban_of_yours("bob", "alice/project", 1, 1);
        assert_eq!(theirs.code, codes::NOT_A_WRITER);
        assert!(
            theirs.message.contains("someone else banned them"),
            "{theirs:?}"
        );
        assert!(theirs
            .fix
            .iter()
            .any(|f| f.contains("dg repo bans alice/project")));
        let none = no_ban_of_yours("bob", "alice/project", 0, 0);
        assert_eq!(none.code, codes::NOT_FOUND);
        assert_eq!(
            none.message,
            "nothing lifted: bob is not banned from alice/project"
        );
        assert_eq!(none.cause, None);
        // A former maintainer's ban no longer counts: not banned, and it says why.
        let stale = no_ban_of_yours("bob", "alice/project", 0, 1);
        assert_eq!(stale.code, codes::NOT_FOUND);
        assert!(stale.cause.unwrap().contains("no longer counts"));
    }

    /// `dg repo bans` lists every ban, not only those that count (Q5-B11 help text).
    #[test]
    fn the_bans_help_says_it_lists_every_ban() {
        let cmd = crate::Cli::command();
        let repo = cmd.find_subcommand("repo").expect("repo");
        let about = repo
            .find_subcommand("bans")
            .and_then(|c| c.get_about())
            .expect("about")
            .to_string();
        assert!(about.starts_with("List every ban"), "{about}");
        assert!(!about.contains("that count"), "{about}");
    }

    #[test]
    fn reasons_are_named() {
        assert_eq!(reason_code(None).unwrap(), None);
        assert_eq!(reason_code(Some("Spam")).unwrap(), Some(1));
        assert!(reason_code(Some("rude")).is_err());
    }
}
