//! `dg milestone` — a repository's milestones (forge-collab `milestone`, maintainer- or
//! writer-gated, newest definition per title wins). Putting an issue in one is
//! `dg issue milestone` (a member `event`, kind 17).

use anyhow::{bail, Result};
use serde_json::json;

use crate::common::{Reader, Session};
use crate::context::Ctx;
use crate::fmt::{cost_json, cost_line};
use crate::MilestoneCommand;
use forge_core::rules::v2::{fold_thread_meta_v2, MilestoneItem};

/// Dispatch a `milestone` subcommand.
pub async fn run(ctx: &Ctx, cmd: &MilestoneCommand) -> Result<()> {
    match cmd {
        MilestoneCommand::List { repo } => list(ctx, repo).await,
        MilestoneCommand::Create {
            repo,
            title,
            description,
            due,
        } => {
            let due_on = due.as_deref().map(parse_day).transpose()?;
            define(ctx, repo, title, description, due_on, false).await
        }
        MilestoneCommand::Close {
            repo,
            title,
            reopen,
        } => close(ctx, repo, title, !reopen).await,
    }
}

/// `YYYY-MM-DD` as ms since the epoch at UTC midnight.
fn parse_day(s: &str) -> Result<u64> {
    let parts: Vec<&str> = s.split('-').collect();
    let [y, m, d] = parts.as_slice() else {
        bail!("a due date is YYYY-MM-DD, got {s:?}");
    };
    let (y, m, d): (i64, i64, i64) = (y.parse()?, m.parse()?, d.parse()?);
    let leap = y % 4 == 0 && (y % 100 != 0 || y % 400 == 0);
    let month_days = match m {
        2 if leap => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    };
    if !(1..=12).contains(&m) || !(1..=month_days).contains(&d) || y < 1970 {
        bail!("a due date is a real YYYY-MM-DD day, got {s:?}");
    }
    // Days from the civil date (Howard Hinnant's algorithm), exact for the proleptic Gregorian
    // calendar.
    let y2 = if m <= 2 { y - 1 } else { y };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Ok(u64::try_from(days)? * 86_400_000)
}

async fn list(ctx: &Ctx, repo: &str) -> Result<()> {
    // a member counts the members-only issues they can read
    let r = Reader::open_discussion(ctx, repo).await?;
    let collab = r.collab();
    // Each issue's open state and milestone, for the progress counts: one walk of the issues
    // and one read of the repo feed, folded per issue.
    let (issues, _) = collab.issues_with_state(&r.repo).await?;
    let items: Vec<MilestoneItem> = issues
        .iter()
        .map(|v| MilestoneItem {
            open: v.state.open,
            milestone: fold_thread_meta_v2(&v.log.events).milestone,
        })
        .collect();
    let milestones = collab.milestones(&r.repo, &items).await?;
    ctx.emit(
        json!({
            "count": milestones.len(),
            "milestones": milestones.iter().map(|m| json!({
                "title": m.title,
                "description": m.description,
                "dueOn": m.due_on,
                "closed": m.closed,
                "open": m.open,
                "closedItems": m.closed_items,
            })).collect::<Vec<_>>(),
        }),
        || {
            if milestones.is_empty() {
                println!("no milestones");
            }
            for m in &milestones {
                let state = if m.closed { "closed" } else { "open" };
                println!(
                    "{:<30} {state:<6} {} open, {} closed  {}",
                    m.title, m.open, m.closed_items, m.description
                );
            }
        },
    );
    Ok(())
}

async fn define(
    ctx: &Ctx,
    repo: &str,
    title: &str,
    description: &str,
    due_on: Option<u64>,
    closed: bool,
) -> Result<()> {
    let s = Session::open_for_write(ctx, repo, "milestone not changed").await?;
    let price = ctx.usd_price();
    let quote = crate::quote::milestone_definition((title.len() + description.len()) as u64);
    ctx.confirm_or_cancel(&format!(
        "Define milestone {title:?} in {}? (one document, {}; maintainers, writers and triage members)",
        s.repo.display(),
        cost_line(quote, price)
    ))?;
    let collab = s.collab();
    let (id, spent) = s
        .metered(|| collab.define_milestone(&s.repo, title, description, due_on, closed))
        .await?;
    ctx.emit(
        json!({
            "status": "defined",
            "title": title,
            "closed": closed,
            "documentId": id,
            "id": id,
            "cost": cost_json(spent, price),
        }),
        || {
            println!(
                "✓ milestone {title} {} · {}",
                if closed { "closed" } else { "defined" },
                cost_line(spent, price)
            );
        },
    );
    Ok(())
}

/// Close (or reopen) milestone `title`: a new definition carrying the current one's
/// description and due date, with `closed` set.
async fn close(ctx: &Ctx, repo: &str, title: &str, closed: bool) -> Result<()> {
    let r = Reader::open(ctx, repo).await?;
    let current = r
        .collab()
        .milestones(&r.repo, &[])
        .await?
        .into_iter()
        .find(|m| m.title == title);
    let Some(m) = current else {
        return Err(crate::errors::not_found(
            format!("no milestone {title:?} in {}", r.repo.display()),
            format!("`dg milestone list {repo}` lists its milestones"),
        ));
    };
    define(ctx, repo, title, &m.description, m.due_on, closed).await
}

#[cfg(test)]
mod tests {
    use super::parse_day;

    #[test]
    fn due_dates_are_utc_midnight() {
        assert_eq!(parse_day("1970-01-01").unwrap(), 0);
        assert_eq!(parse_day("2026-12-01").unwrap(), 1_796_083_200_000);
        assert_eq!(parse_day("2024-02-29").unwrap(), 1_709_164_800_000);
        assert!(parse_day("2026-13-01").is_err());
        assert!(parse_day("2026-02-31").is_err(), "no 31 February");
        assert!(parse_day("2025-02-29").is_err(), "2025 is not a leap year");
        assert!(parse_day("2026-04-31").is_err());
        assert!(parse_day("26-1-1x").is_err());
    }
}
