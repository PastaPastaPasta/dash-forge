//! `dg issue` — issue tracking (list/view/create/edit/comment/close/reopen/label/assign).
//!
//! forge-v2 repositories go through [`forge_core::collab::v2::Collab`]: issues are numbered
//! by the `forge-v2.md` §6 rule, a create is journaled so a re-run resumes it, and close /
//! reopen pick their gate automatically (a member's `event`, else the author's
//! `authorEvent`).

use anyhow::Result;
use serde_json::json;

use forge_core::collab::v2::{Collab, IssueView, Target};
use forge_core::create::default_journal_dir;
use forge_core::rules::{EventKind, IssueState};

use crate::common::{number_arg, Session};
use crate::context::Ctx;
use crate::fmt::{cost_json, cost_line, dash_usd_price, route_text, safe};
use crate::{IssueCommand, IssueListArgs};

/// Dispatch an `issue` subcommand.
pub async fn run(ctx: &Ctx, cmd: &IssueCommand) -> Result<()> {
    match cmd {
        IssueCommand::List(args) => list(ctx, args).await,
        IssueCommand::View { repo, number } => view(ctx, repo, *number).await,
        IssueCommand::Create { repo, title, body } => create(ctx, repo, title, body).await,
        IssueCommand::Edit {
            repo,
            number,
            title,
            body,
            body_file,
        } => {
            let body = match (body, body_file) {
                (Some(b), _) => Some(b.clone()),
                (None, Some(path)) => Some(read_body_file(path)?),
                (None, None) => None,
            };
            edit(ctx, repo, *number, title.as_deref(), body.as_deref()).await
        }
        IssueCommand::Comment { repo, number, body } => comment(ctx, repo, *number, body).await,
        IssueCommand::Close { repo, number } => set_open(ctx, repo, *number, true).await,
        IssueCommand::Reopen { repo, number } => set_open(ctx, repo, *number, false).await,
        IssueCommand::Label {
            repo,
            number,
            words,
            add,
            remove,
        } => {
            let (adding, names) = label_args(words, add.as_deref(), remove.as_deref())?;
            label(ctx, repo, *number, adding, &names).await
        }
        IssueCommand::Assign { repo, number, who } => assign(ctx, repo, *number, who, true).await,
        IssueCommand::Unassign { repo, number, who } => {
            assign(ctx, repo, *number, who, false).await
        }
    }
}

/// Label names as the web writes them: trimmed (the fold compares them exactly).
fn trimmed(names: &[String]) -> Vec<String> {
    names.iter().map(|n| n.trim().to_string()).collect()
}

/// `add bug docs` / `remove bug`, or the older `--add bug` / `--remove bug`: exactly one form.
fn label_args(
    words: &[String],
    add: Option<&str>,
    remove: Option<&str>,
) -> Result<(bool, Vec<String>)> {
    let usage = || {
        crate::errors::usage(
            "use `dg issue label <repo> <n> add|remove <label>...` (or exactly one of --add / --remove)",
        )
    };
    match (words.split_first(), add, remove) {
        (None, Some(l), None) => Ok((true, trimmed(&[l.to_string()]))),
        (None, None, Some(l)) => Ok((false, trimmed(&[l.to_string()]))),
        (Some((verb, names)), None, None) if !names.is_empty() => match verb.as_str() {
            "add" => Ok((true, trimmed(names))),
            "remove" | "rm" => Ok((false, trimmed(names))),
            _ => Err(usage()),
        },
        _ => Err(usage()),
    }
}

fn not_found(repo: &str, number: u64) -> anyhow::Error {
    crate::errors::not_found(
        format!("issue #{number} not found in {repo}"),
        format!("`dg issue list {repo} --state all` lists its issues"),
    )
}

/// One listed issue: number, title, author, state.
type Row = (u64, String, String, IssueState);

fn labels_of(state: &IssueState) -> String {
    state.labels.iter().cloned().collect::<Vec<_>>().join(", ")
}

/// `me`, a DPNS name or an identity id, as a base58 identity id.
async fn identity_arg(s: &Session, who: &str) -> Result<String> {
    if who == "me" || who == "@me" {
        return Ok(s.identity.id());
    }
    Ok(forge_core::resolve::resolve_owner(&s.client, who.trim_start_matches('@')).await?)
}

/// Whether `title` (or `#number`) holds every word of `search`, case-insensitively.
fn title_matches(search: &str, number: u32, title: &str) -> bool {
    let title = title.to_lowercase();
    search
        .split_whitespace()
        .all(|w| match w.strip_prefix('#') {
            Some(n) if !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()) => {
                n.parse() == Ok(number)
            }
            _ => title.contains(&w.to_lowercase()),
        })
}

/// Whether a folded issue passes `dg issue list`'s filters (`assignee`: `Some(None)` = nobody).
fn issue_matches(
    args: &IssueListArgs,
    author: Option<&str>,
    assignee: Option<&Option<String>>,
    v: &IssueView,
) -> bool {
    args.state.matches(v.state.open)
        && args.labels.iter().all(|l| v.state.labels.contains(l))
        && author.is_none_or(|a| v.issue.author == a)
        && match assignee {
            None => true,
            Some(None) => v.state.assignees.is_empty(),
            Some(Some(a)) => v.state.assignees.contains(a),
        }
        && args
            .search
            .as_deref()
            .is_none_or(|q| title_matches(q, v.issue.number, &v.issue.title))
}

async fn list(ctx: &Ctx, args: &IssueListArgs) -> Result<()> {
    if args.limit == 0 || args.limit > 100 {
        return Err(crate::errors::usage("--limit is 1-100"));
    }
    if args.page == 0 {
        return Err(crate::errors::usage("--page starts at 1"));
    }
    let s = Session::open(ctx, &args.repo).await?;
    let author = match &args.author {
        Some(a) => Some(identity_arg(&s, a).await?),
        None => None,
    };
    let assignee = match args.assignee.as_deref() {
        Some("none") => Some(None),
        Some(a) => Some(Some(identity_arg(&s, a).await?)),
        None => None,
    };
    // Every issue and the whole feed, folded once: the filters see the whole repo, not the
    // newest page (SR-04), and there is no per-row read.
    let (all, hidden) = Collab::reader(&s.client).issues_with_state(&s.repo).await?;
    let matching: Vec<Row> = all
        .into_iter()
        .filter(|v| issue_matches(args, author.as_deref(), assignee.as_ref(), v))
        .map(|v| {
            (
                u64::from(v.issue.number),
                v.issue.title,
                v.issue.author,
                v.state,
            )
        })
        .collect();
    let total = matching.len();
    let per = args.limit as usize;
    let pages = total.div_ceil(per).max(1);
    let start = (args.page as usize - 1) * per;
    let rows: Vec<&Row> = matching.iter().skip(start).take(per).collect();

    let json_rows: Vec<_> = rows
        .iter()
        .map(|(n, title, author, st)| {
            json!({
                "number": n,
                "title": title,
                "author": author,
                "open": st.open,
                "labels": st.labels,
                "assignees": st.assignees,
            })
        })
        .collect();
    ctx.emit(
        json!({
            "count": rows.len(),
            "total": total,
            "page": args.page,
            "pages": pages,
            "issues": json_rows,
            "hidden": hidden,
            "truncated": args.page as usize * per < total,
        }),
        || {
            if rows.is_empty() {
                println!("no issues");
            }
            for (n, title, _, st) in &rows {
                let mark = if st.open { "open" } else { "closed" };
                let labels = if st.labels.is_empty() {
                    String::new()
                } else {
                    format!("  [{}]", labels_of(st))
                };
                let who = if st.assignees.is_empty() {
                    String::new()
                } else {
                    format!("  ({} assigned)", st.assignees.len())
                };
                println!("#{n:<4} {mark:<6} {}{}{who}", safe(title), safe(&labels));
            }
            if pages > 1 {
                println!(
                    "(page {} of {pages}, {total} matching; --page {} for more)",
                    args.page,
                    args.page + 1
                );
            }
            if hidden > 0 {
                println!("{}", crate::fmt::hidden_note(&s.repo, hidden));
            }
        },
    );
    Ok(())
}

async fn view(ctx: &Ctx, repo: &str, number: u64) -> Result<()> {
    let s = Session::open(ctx, repo).await?;

    let collab = s.collab();
    let view = collab
        .issue_view(&s.repo, number_arg(number)?)
        .await?
        .ok_or_else(|| not_found(repo, number))?;
    // [(author, body)]
    let (comments, hidden) = collab
        .comments_counted(&s.repo, &view.issue.document_id)
        .await?;
    let comments = comments
        .into_iter()
        .map(|c| (c.author, c.body))
        .collect::<Vec<_>>();
    let state = view.state;
    let i = view.issue;
    let (id, title, body, author) = (i.document_id, i.title, i.body, i.author);

    ctx.emit(
        json!({
            "number": number,
            "title": title,
            "body": body,
            "author": author,
            "documentId": id,
            "state": { "open": state.open, "labels": state.labels, "assignees": state.assignees },
            "comments": comments.iter().map(|(a, b)| json!({"author": a, "body": b})).collect::<Vec<_>>(),
            "hiddenComments": hidden,
        }),
        || {
            let mark = if state.open { "open" } else { "closed" };
            println!("#{number} [{mark}] {}", safe(&title));
            println!("author: {author}");
            if !state.labels.is_empty() {
                println!("labels: {}", safe(&labels_of(&state)));
            }
            if !body.is_empty() {
                println!("\n{}", safe(&body));
            }
            for (a, b) in &comments {
                println!("\n— {a}:\n{}", safe(b));
            }
            if hidden > 0 {
                println!("\n{}", crate::fmt::hidden_note(&s.repo, hidden));
            }
        },
    );
    Ok(())
}

async fn create(ctx: &Ctx, repo: &str, title: &str, body: &str) -> Result<()> {
    let s = Session::open(ctx, repo).await?;
    ctx.confirm_or_cancel(&format!(
        "Open issue {title:?} in {}? (one small document, ~0.0001 DASH)",
        s.repo.display()
    ))?;
    let before = s.balance().await;
    let created = s
        .collab()
        .create_issue(&s.repo, title, body, &default_journal_dir()?)
        .await?;
    let spent = s.spent_since(before).await;
    let price = dash_usd_price();

    ctx.emit(
        json!({
            "status": "created",
            "number": created.number,
            "documentId": created.document_id,
            "title": title,
            "resumed": created.resumed,
            "cost": cost_json(spent, price),
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
                s.repo.display(),
                cost_line(spent, price)
            );
        },
    );
    Ok(())
}

/// Resolve a v2 issue as an event target.
async fn target(s: &Session, repo: &str, number: u64) -> Result<Target> {
    Ok(s.collab()
        .issue(&s.repo, number_arg(number)?)
        .await?
        .ok_or_else(|| not_found(repo, number))?
        .target())
}

/// A body from a file, or stdin for `-`.
fn read_body_file(path: &std::path::Path) -> Result<String> {
    use std::io::Read as _;
    if path.as_os_str() == "-" {
        let mut s = String::new();
        std::io::stdin().read_to_string(&mut s)?;
        return Ok(s);
    }
    std::fs::read_to_string(path)
        .map_err(|e| anyhow::anyhow!("reading the body from {}: {e}", path.display()))
}

async fn edit(
    ctx: &Ctx,
    repo: &str,
    number: u64,
    title: Option<&str>,
    body: Option<&str>,
) -> Result<()> {
    if title.is_none() && body.is_none() {
        return Err(crate::errors::usage(
            "pass --title, --body or --body-file (or several)",
        ));
    }
    let s = Session::open(ctx, repo).await?;
    let target = target(&s, repo, number).await?;
    ctx.confirm_or_cancel(&format!(
        "Edit issue #{number}? (replaces your issue document; you pay only for the changed bytes)"
    ))?;
    let before = s.balance().await;
    let edited = s
        .collab()
        .update_target(&s.repo, &target, title, body)
        .await?;
    let spent = s.spent_since(before).await;
    let price = dash_usd_price();
    ctx.emit(
        json!({
            "status": if edited { "edited" } else { "unchanged" },
            "issue": number,
            "title": title,
            "bodyChanged": body.is_some(),
            "cost": cost_json(spent, price),
        }),
        || {
            if edited {
                println!("✓ edited issue #{number} · {}", cost_line(spent, price));
            } else {
                println!("issue #{number} already reads that way; nothing was written");
            }
        },
    );
    Ok(())
}

async fn comment(ctx: &Ctx, repo: &str, number: u64, body: &str) -> Result<()> {
    let s = Session::open(ctx, repo).await?;
    let target = target(&s, repo, number).await?;
    ctx.confirm_or_cancel(&format!("Comment on issue #{number}? (one small document)"))?;
    let id = s
        .collab()
        .comment(&s.repo, &target.id, body, None, None)
        .await?;
    ctx.emit(
        json!({ "status": "commented", "issue": number, "commentId": id }),
        || println!("✓ commented on issue #{number}"),
    );
    Ok(())
}

async fn set_open(ctx: &Ctx, repo: &str, number: u64, close: bool) -> Result<()> {
    let s = Session::open(ctx, repo).await?;
    let target = target(&s, repo, number).await?;
    let (verb, prompt) = if close {
        ("close", "Close")
    } else {
        ("reopen", "Reopen")
    };
    ctx.confirm_or_cancel(&format!("{prompt} issue #{number}? (one small document)"))?;
    let collab = s.collab();
    let (route, id) = collab.set_open(&s.repo, &target, close).await?;
    let open_now = collab
        .issue_view(&s.repo, target.number)
        .await?
        .map(|v| v.state.open);
    ctx.emit(
        json!({
            "status": if close { "closed" } else { "reopened" },
            "issue": number,
            "via": route,
            "eventId": id,
            "open": open_now,
        }),
        || {
            println!("✓ {verb}d issue #{number} {}", route_text(route));
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

async fn label(ctx: &Ctx, repo: &str, number: u64, add: bool, names: &[String]) -> Result<()> {
    let kind = if add {
        EventKind::LabelAdd
    } else {
        EventKind::LabelRemove
    };
    let s = Session::open(ctx, repo).await?;
    let target = target(&s, repo, number).await?;
    // docs/security/private-repos.md §7: label names are event values, never encrypted
    let plaintext = if s.repo.visibility == forge_core::rules::v2::Visibility::Private {
        "; note: label names are not encrypted in this release"
    } else {
        ""
    };
    ctx.confirm_or_cancel(&format!(
        "{} label(s) {} on issue #{number}? (one small document each; members only{plaintext})",
        if add { "Add" } else { "Remove" },
        names.join(", ")
    ))?;
    let collab = s.collab();
    let mut ids = Vec::new();
    for name in names {
        ids.push(
            collab
                .post_event(&s.repo, &target, kind, Some(name), None)
                .await?,
        );
    }
    ctx.emit(
        json!({
            "status": "labeled",
            "issue": number,
            "label": names.first(),
            "labels": names,
            "action": if add { "add" } else { "remove" },
            "eventId": ids.first(),
            "eventIds": ids,
        }),
        || {
            let verb = if add { "added" } else { "removed" };
            println!(
                "✓ {verb} label {} on issue #{number}",
                safe(&names.join(", "))
            );
        },
    );
    Ok(())
}

async fn assign(ctx: &Ctx, repo: &str, number: u64, who: &[String], add: bool) -> Result<()> {
    let s = Session::open(ctx, repo).await?;
    let target = target(&s, repo, number).await?;
    let mut ids = Vec::new();
    for w in who {
        ids.push(identity_arg(&s, w).await?);
    }
    ctx.confirm_or_cancel(&format!(
        "{} {} on issue #{number}? (one small document each; members only)",
        if add { "Assign" } else { "Unassign" },
        ids.join(", ")
    ))?;
    let collab = s.collab();
    let mut events = Vec::new();
    for id in &ids {
        events.push(collab.set_assignee(&s.repo, &target, id, add).await?);
    }
    ctx.emit(
        json!({
            "status": if add { "assigned" } else { "unassigned" },
            "issue": number,
            "assignees": ids,
            "eventIds": events,
        }),
        || {
            let verb = if add { "assigned" } else { "unassigned" };
            println!("✓ {verb} {} on issue #{number}", ids.join(", "));
        },
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{label_args, title_matches};

    #[test]
    fn label_takes_add_remove_words_or_the_old_flags() {
        let w = |v: &[&str]| v.iter().map(ToString::to_string).collect::<Vec<_>>();
        assert_eq!(
            label_args(&w(&["add", "bug", "docs"]), None, None).unwrap(),
            (true, w(&["bug", "docs"]))
        );
        assert_eq!(
            label_args(&w(&["remove", "bug"]), None, None).unwrap(),
            (false, w(&["bug"]))
        );
        assert_eq!(label_args(&[], Some("x"), None).unwrap(), (true, w(&["x"])));
        assert!(label_args(&w(&["add"]), None, None).is_err());
        assert!(label_args(&w(&["tag", "x"]), None, None).is_err());
        assert!(label_args(&w(&["add", "x"]), Some("y"), None).is_err());
        assert!(label_args(&[], Some("x"), Some("y")).is_err());
    }

    #[test]
    fn search_needs_every_word_and_reads_hash_numbers() {
        assert!(title_matches("crash CONFIG", 3, "Crash on empty config"));
        assert!(!title_matches("crash network", 3, "Crash on empty config"));
        assert!(title_matches("#3", 3, "anything"));
        assert!(!title_matches("#3", 30, "anything"));
    }
}
