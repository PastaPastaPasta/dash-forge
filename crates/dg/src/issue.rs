//! `dg issue` — issue tracking (list/view/create/edit/comment/close/reopen/label/assign).
//!
//! forge-v2 repositories go through [`forge_core::collab::v2::Collab`]: issues take the dense
//! next number (`forge-v2.md` §6), a create is journaled so a re-run resumes it, and close /
//! reopen are one `transition` each, written as a member or as the issue's author.

use anyhow::{Context as _, Result};
use serde_json::json;

use forge_core::collab::v2::{Comment, IssueView, Target};
use forge_core::create::default_journal_dir;
use forge_core::rules::v2::{status_of_code, StateAction, Transition};
use forge_core::rules::{Event, EventKind, IssueState};
use forge_core::user_error::{codes, UserError};

use crate::common::{number_arg, Reader, Session};
use crate::context::Ctx;
use crate::fmt::{cost_json, cost_line, safe, transition_phrase, transition_route_text, with_name};
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
        IssueCommand::EditComment {
            repo,
            comment_id,
            body,
            body_file,
        } => {
            // clap requires exactly one of --body and --body-file
            let body = match body {
                Some(b) => b.clone(),
                None => read_body_file(body_file.as_deref().unwrap_or(std::path::Path::new("-")))?,
            };
            edit_comment(ctx, repo, comment_id, &body).await
        }
        IssueCommand::DeleteComment { repo, comment_id } => {
            delete_comment(ctx, repo, comment_id).await
        }
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
        IssueCommand::Milestone {
            repo,
            number,
            title,
            clear,
        } => {
            milestone(
                ctx,
                repo,
                *number,
                if *clear { None } else { title.as_deref() },
            )
            .await
        }
        IssueCommand::Pin { repo, number, off } => {
            thread_flag(ctx, repo, *number, Flag::Pin, !off).await
        }
        IssueCommand::Lock { repo, number, off } => {
            thread_flag(ctx, repo, *number, Flag::Lock, !off).await
        }
    }
}

/// Put issue `number` in milestone `title` (`None`: take it out).
async fn milestone(ctx: &Ctx, repo: &str, number: u64, title: Option<&str>) -> Result<()> {
    let s = Session::open_for_write(ctx, repo, "milestone not changed").await?;
    let target = target(&s, repo, number).await?;
    // Only an open milestone the repo defines: the fold would otherwise show a title that
    // exists nowhere (the web picker offers the same list).
    if let Some(t) = title {
        // Members only (E601 first, as for a clear): then the title must name an open one.
        s.collab()
            .require_role(
                &s.repo,
                forge_core::rules::v2::Role::Writer,
                &format!("put issue #{number} in a milestone"),
            )
            .await?;
        let defined = s.collab().milestones(&s.repo, &[]).await?;
        match defined.iter().find(|m| m.title == t) {
            Some(m) if !m.closed => {}
            Some(_) => {
                return Err(crate::errors::usage(format!(
                    "milestone {t:?} is closed: reopen it first (`dg milestone close {repo} {t:?} --reopen`)"
                )))
            }
            None => {
                return Err(crate::errors::not_found(
                    format!("no milestone {t:?} in {}", s.repo.display()),
                    format!("`dg milestone list {repo}` lists them; `dg milestone create` defines one"),
                ))
            }
        }
    }
    let what = title.map_or_else(
        || format!("Take issue #{number} out of its milestone"),
        |t| format!("Put issue #{number} in milestone {t:?}"),
    );
    ctx.confirm_or_cancel(&format!("{what}? (one small document; members only)"))?;
    let id = s.collab().set_milestone(&s.repo, &target, title).await?;
    ctx.emit(
        json!({ "status": if title.is_some() { "set" } else { "cleared" }, "issue": number, "milestone": title, "eventId": id }),
        || match title {
            Some(t) => println!("✓ issue #{number} is in milestone {t}"),
            None => println!("✓ issue #{number} has no milestone"),
        },
    );
    Ok(())
}

/// Which thread flag [`thread_flag`] sets.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Flag {
    Pin,
    Lock,
}

/// Pin / unpin or lock / unlock issue `number`.
async fn thread_flag(ctx: &Ctx, repo: &str, number: u64, flag: Flag, on: bool) -> Result<()> {
    let s = Session::open_for_write(ctx, repo, "issue not changed").await?;
    let target = target(&s, repo, number).await?;
    let (verb, done) = match (flag, on) {
        (Flag::Pin, true) => ("Pin", "pinned"),
        (Flag::Pin, false) => ("Unpin", "unpinned"),
        (Flag::Lock, true) => ("Lock", "locked"),
        (Flag::Lock, false) => ("Unlock", "unlocked"),
    };
    let note = match (flag, on) {
        (Flag::Lock, true) => "; then only members can comment",
        _ => "",
    };
    let collab = s.collab();
    // Already locked (or unlocked): nothing to write, as `dg pr lock` says.
    if flag == Flag::Lock
        && status_of_code(collab.state_sum(&s.repo, &target.id).await?).locked == on
    {
        ctx.emit(
            json!({ "status": done, "issue": number, "written": false }),
            || println!("issue #{number} is already {done}; nothing written"),
        );
        return Ok(());
    }
    ctx.confirm_or_cancel(&format!(
        "{verb} issue #{number}? (one small document; members only{note})"
    ))?;
    // A pin is an event; a lock or unlock is a transition (RC1 kinds 3 / 4).
    let (key, id) = match flag {
        Flag::Pin => ("eventId", collab.set_pinned(&s.repo, &target, on).await?),
        Flag::Lock => (
            "transitionId",
            collab.set_locked(&s.repo, &target, on).await?,
        ),
    };
    ctx.emit(json!({ "status": done, "issue": number, key: id }), || {
        println!("✓ {done} issue #{number}");
    });
    Ok(())
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
type Row = (u64, String, String, IssueState, bool);

fn labels_of(state: &IssueState) -> String {
    state.labels.iter().cloned().collect::<Vec<_>>().join(", ")
}

/// `me`, a DPNS name or an identity id (`who`), as a base58 identity id. The `me` closure
/// gives the caller's own id; it is called only when `who` is `me`, so a read that names
/// nobody never opens the key.
async fn identity_arg(
    client: &forge_core::platform::PlatformClient,
    me: impl FnOnce() -> Result<String>,
    who: &str,
) -> Result<String> {
    if who == "me" || who == "@me" {
        return me();
    }
    Ok(forge_core::resolve::resolve_owner(client, who.trim_start_matches('@')).await?)
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
    let s = Reader::open(ctx, &args.repo).await?;
    let author = match &args.author {
        Some(a) => Some(identity_arg(&s.client, || s.me(ctx), a).await?),
        None => None,
    };
    let assignee = match args.assignee.as_deref() {
        Some("none") => Some(None),
        Some(a) => Some(Some(identity_arg(&s.client, || s.me(ctx), a).await?)),
        None => None,
    };
    // Every issue and the whole feed, folded once: the filters see the whole repo, not the
    // newest page (SR-04), and there is no per-row read. A private repo's issues open with
    // the reader's keys.
    let (all, hidden) = s.collab().issues_with_state(&s.repo).await?;
    let mut matching: Vec<Row> = all
        .into_iter()
        .filter(|v| issue_matches(args, author.as_deref(), assignee.as_ref(), v))
        .map(|v| {
            let pinned = forge_core::rules::v2::fold_thread_meta_v2(&v.log.events).pinned;
            (
                u64::from(v.issue.number),
                v.issue.title,
                v.issue.author,
                v.state,
                pinned,
            )
        })
        .collect();
    // Pinned issues first (a member's pin, kinds 19/20), each group newest first as read.
    matching.sort_by_key(|r| !r.4);
    let total = matching.len();
    let per = args.limit as usize;
    let pages = total.div_ceil(per).max(1);
    let start = (args.page as usize - 1) * per;
    let rows: Vec<&Row> = matching.iter().skip(start).take(per).collect();

    let json_rows: Vec<_> = rows
        .iter()
        .map(|(n, title, author, st, pinned)| {
            json!({
                "number": n,
                "title": title,
                "author": author,
                "open": st.open,
                "state": state_word(st.open),
                "labels": st.labels,
                "assignees": st.assignees,
                "pinned": pinned,
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
                println!("{}", empty_issues_line(args, total, pages));
            }
            for (n, title, _, st, pinned) in &rows {
                let mark = state_word(st.open);
                let mark = if *pinned {
                    format!("{mark}, pinned")
                } else {
                    mark.to_string()
                };
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

#[allow(clippy::too_many_lines)] // one view: the reads, then its JSON and its human rendering
async fn view(ctx: &Ctx, repo: &str, number: u64) -> Result<()> {
    let s = Reader::open(ctx, repo).await?;

    let collab = s.collab();
    let view = collab
        .issue_view(&s.repo, number_arg(number)?)
        .await?
        .ok_or_else(|| not_found(repo, number))?;
    let (comments, hidden) = collab
        .comments_counted(&s.repo, &view.issue.document_id)
        .await?;
    let values_note = crate::fmt::event_values_note(view.hidden_values, view.plaintext_values);
    let (hidden_values, plaintext_values) = (view.hidden_values, view.plaintext_values);
    let events: Vec<Event> = view.events().into_iter().cloned().collect();
    let transitions = view.log.transitions.clone();
    let timeline = timeline(&comments, &events, &transitions);
    // Milestone and pin: the member events folded (kinds 17-20). Lock: the transitions'
    // sum (16 or more is locked).
    let meta = forge_core::rules::v2::fold_thread_meta_v2(&view.log.events);
    let locked = view.log.locked();
    let state = view.state;
    let i = view.issue;
    let (id, title, body, author) = (i.document_id, i.title, i.body, i.author);
    // DPNS names for the human view only, read together; a failed read shows the bare id.
    let names = if ctx.json {
        std::collections::BTreeMap::default()
    } else {
        let actors = comments.iter().map(|c| c.author.as_str());
        let actors = actors.chain(events.iter().map(|e| e.actor.as_str()));
        let actors = actors.chain(transitions.iter().map(|t| t.actor.as_str()));
        let actors = actors.chain(state.assignees.iter().map(String::as_str));
        // whom an (un)assign event names (QW3-070: event targets were bare ids)
        let actors = actors.chain(
            events
                .iter()
                .filter(|e| matches!(e.kind, EventKind::Assign | EventKind::Unassign))
                .filter_map(|e| e.value.as_deref()),
        );
        s.client
            .dpns_first_names(std::iter::once(author.as_str()).chain(actors))
            .await
    };
    let who = |id: &str| with_name(id, &names);

    ctx.emit(
        json!({
            "number": number,
            "title": title,
            "body": body,
            "author": author,
            "documentId": id,
            "id": id,
            "state": { "open": state.open, "labels": state.labels, "assignees": state.assignees },
            "milestone": meta.milestone,
            "pinned": meta.pinned,
            "locked": locked,
            "comments": comments.iter().map(|c| json!({"id": c.document_id, "author": c.author, "body": c.body})).collect::<Vec<_>>(),
            "events": events.iter().map(|e| json!({
                "id": e.id,
                "kind": e.kind,
                "actor": e.actor,
                "value": e.value,
                "createdAt": e.created_at,
            })).collect::<Vec<_>>(),
            "transitions": transitions.iter().map(|t| json!({
                "id": t.id,
                "kind": t.kind,
                "actor": t.actor,
                "asAuthor": t.as_author,
                "createdAt": t.created_at,
            })).collect::<Vec<_>>(),
            "hiddenComments": hidden,
            "hiddenEventValues": hidden_values,
            "plaintextEventValues": plaintext_values,
        }),
        || {
            let mark = state_word(state.open);
            println!("#{number} [{mark}] {}", safe(&title));
            println!("author: {}", who(&author));
            let labels: Vec<&str> = state.labels.iter().map(String::as_str).collect();
            let assignees: Vec<String> = state.assignees.iter().map(|a| who(a)).collect();
            for line in crate::fmt::triage_lines(&labels, &assignees, meta.milestone.as_deref()) {
                println!("{line}");
            }
            if !body.is_empty() {
                println!("\n{}", safe(&body));
            }
            for item in &timeline {
                match item {
                    Item::Comment(c) => {
                        let author = who(&c.author);
                        println!("\n— {author} ({}):\n{}", c.document_id, safe(&c.body));
                    }
                    Item::Event(e) => println!(
                        "\n· {} {}",
                        who(&e.actor),
                        safe(&event_phrase_with(e, &who))
                    ),
                    Item::Transition(t) => {
                        println!("\n· {} {}", who(&t.actor), transition_phrase(t.kind));
                    }
                }
            }
            if hidden > 0 {
                println!("\n{}", crate::fmt::hidden_note(&s.repo, hidden));
            }
            if let Some(n) = &values_note {
                println!("\n{n}");
            }
        },
    );
    Ok(())
}

/// One entry of an issue's timeline.
enum Item<'a> {
    Comment(&'a Comment),
    Event(&'a Event),
    Transition(&'a Transition),
}

/// Comments, events and state changes in one `(createdAt, id)` order, as the web's issue
/// timeline has them.
fn timeline<'a>(
    comments: &'a [Comment],
    events: &'a [Event],
    transitions: &'a [Transition],
) -> Vec<Item<'a>> {
    let mut items: Vec<(u64, &str, Item<'a>)> = comments
        .iter()
        .map(|c| (c.created_at, c.document_id.as_str(), Item::Comment(c)))
        .chain(
            events
                .iter()
                .map(|e| (e.created_at, e.id.as_str(), Item::Event(e))),
        )
        .chain(
            transitions
                .iter()
                .map(|t| (t.created_at, t.id.as_str(), Item::Transition(t))),
        )
        .collect();
    items.sort_by_key(|&(at, id, _)| (at, id));
    items.into_iter().map(|(_, _, i)| i).collect()
}

/// What an empty `dg issue list` page says: a page past the last one of `total` matching
/// issues, or the state filter named ("no open issues") and whether other filters narrowed it.
fn empty_issues_line(args: &IssueListArgs, total: usize, pages: usize) -> String {
    if total > 0 {
        return format!(
            "page {} is past the last page ({pages}) of {total} issue(s)",
            args.page
        );
    }
    let filtered = !args.labels.is_empty()
        || args.author.is_some()
        || args.assignee.is_some()
        || args.search.is_some();
    format!(
        "{}{}",
        args.state.empty("issues"),
        if filtered { " match the filters" } else { "" }
    )
}

/// What an issue event did, in the web timeline's words (identities as bare ids).
#[cfg(test)]
fn event_phrase(e: &Event) -> String {
    event_phrase_with(e, &str::to_string)
}

/// What an issue event did, in the web timeline's words, with the identity an (un)assign
/// event names shown by `who` (its DPNS name beside the id).
fn event_phrase_with(e: &Event, who: &dyn Fn(&str) -> String) -> String {
    let value = e.value.as_deref().unwrap_or("");
    match e.kind {
        // A private repo's value this reader cannot open is absent: say what happened.
        EventKind::LabelAdd if value.is_empty() => "added a label (hidden)".into(),
        EventKind::LabelAdd => format!("added the {value} label"),
        EventKind::LabelRemove if value.is_empty() => "removed a label (hidden)".into(),
        EventKind::LabelRemove => format!("removed the {value} label"),
        EventKind::Assign if value.is_empty() => "assigned this".into(),
        EventKind::Assign => format!("assigned {}", who(value)),
        EventKind::Unassign if value.is_empty() => "unassigned this".into(),
        EventKind::Unassign => format!("unassigned {}", who(value)),
        EventKind::MilestoneSet if value.is_empty() => "set the milestone (hidden)".into(),
        EventKind::MilestoneSet => format!("set the milestone to {value}"),
        EventKind::MilestoneClear => "cleared the milestone".into(),
        EventKind::Pin => "pinned this".into(),
        EventKind::Unpin => "unpinned this".into(),
        EventKind::Lock => "locked the conversation".into(),
        EventKind::Unlock => "unlocked the conversation".into(),
        // PR-only kinds do nothing to an issue; name them as the contract does.
        other => serde_json::to_value(other)
            .ok()
            .and_then(|v| v.as_str().map(str::to_string))
            .unwrap_or_default(),
    }
}

/// Where a comment's id is listed, for a refused comment id.
const COMMENT_IDS: &str =
    "`dg issue view <repo> <n> --json` (or `dg pr view <repo> <n> --comments --json`)";

/// Edit one of the signer's comments (issue or PR): its body, re-sealed in a private repo.
async fn edit_comment(ctx: &Ctx, repo: &str, comment_id: &str, body: &str) -> Result<()> {
    crate::common::document_id_arg(comment_id, "comment id", COMMENT_IDS)?;
    let s = Session::open_for_write(ctx, repo, "comment not edited").await?;
    ctx.confirm_or_cancel(&format!(
        "Edit comment {comment_id}? (one document replace)"
    ))?;
    let before = s.balance().await;
    let edited = s.collab().update_comment(&s.repo, comment_id, body).await?;
    let spent = s.spent_since(before).await;
    let price = ctx.usd_price();
    ctx.emit(
        json!({
            "status": if edited { "edited" } else { "unchanged" },
            "comment": comment_id,
            "cost": cost_json(spent, price),
        }),
        || {
            if edited {
                println!(
                    "✓ edited comment {comment_id} · {}",
                    cost_line(spent, price)
                );
            } else {
                println!("comment {comment_id} already reads that way; nothing was written");
            }
        },
    );
    Ok(())
}

/// Delete one of the signer's comments (QW-016): an owner-only document delete, refused before
/// signing for someone else's comment.
async fn delete_comment(ctx: &Ctx, repo: &str, comment_id: &str) -> Result<()> {
    crate::common::document_id_arg(comment_id, "comment id", COMMENT_IDS)?;
    let s = Session::open_for_write(ctx, repo, "comment not deleted").await?;
    // Someone else's comment (or another repo's) is refused before the prompt, not after it.
    let there = s.collab().deletable_comment(&s.repo, comment_id).await?;
    if there {
        ctx.confirm_or_cancel(&format!(
            "Delete comment {comment_id}? (a document delete; replies to it stay)"
        ))?;
    }
    let before = s.balance().await;
    let deleted = there && s.collab().delete_comment(&s.repo, comment_id).await?;
    let spent = s.spent_since(before).await;
    let price = ctx.usd_price();
    ctx.emit(
        json!({
            "status": if deleted { "deleted" } else { "absent" },
            "comment": comment_id,
            "cost": cost_json(spent, price),
        }),
        || {
            if deleted {
                println!(
                    "✓ deleted comment {comment_id} · {}",
                    cost_line(spent, price)
                );
            } else {
                println!(
                    "comment {comment_id} is not there (already deleted?); nothing was written"
                );
            }
        },
    );
    Ok(())
}

async fn create(ctx: &Ctx, repo: &str, title: &str, body: &str) -> Result<()> {
    let s = Session::open_for_write(ctx, repo, "issue not created").await?;
    ctx.confirm_or_cancel(&format!(
        "Open issue {title:?} in {}? (one document, {})",
        s.repo.display(),
        cost_line(
            crate::quote::target_create((title.len() + body.len()) as u64),
            ctx.usd_price()
        )
    ))?;
    let before = s.balance().await;
    let created = s
        .collab()
        .create_issue(&s.repo, title, body, &default_journal_dir()?)
        .await?;
    let spent = s.spent_since(before).await;
    let price = ctx.usd_price();

    ctx.emit(
        json!({
            "status": "created",
            "number": created.number,
            "documentId": created.document_id,
            "id": created.document_id,
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
    ctx.confirm_or_cancel(&format!("Edit issue #{number}? (one document replace)"))?;
    let before = s.balance().await;
    let edited = s
        .collab()
        .update_target(&s.repo, &target, title, body)
        .await?;
    let spent = s.spent_since(before).await;
    let price = ctx.usd_price();
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
    let s = Session::open_for_write(ctx, repo, "comment not posted").await?;
    let target = target(&s, repo, number).await?;
    refuse_if_locked(&s, number, &target.id).await?;
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

/// A locked thread takes comments from members only: consensus refuses a new comment on it
/// without `asMember` (`lockGate`), so a non-member is refused here first, before anything is
/// signed, with the reason.
async fn refuse_if_locked(s: &Session, number: u64, target_id: &str) -> Result<()> {
    let collab = s.collab();
    if !status_of_code(collab.state_sum(&s.repo, target_id).await?).locked {
        return Ok(());
    }
    if collab.signer_role(&s.repo).await?.is_some() {
        return Ok(());
    }
    Err(forge_core::user_error::UserError::new(
        forge_core::user_error::codes::NOT_A_WRITER,
        format!("comment not posted: issue #{number} is locked to members"),
    )
    .cause("a maintainer or writer locked the conversation")
    .fix("ask a maintainer to unlock it")
    .note("checked before anything was signed; nothing was written or paid")
    .into())
}

/// The `"state"` of an issue in JSON, `"open"` or `"closed"`, as `dg pr`'s: emitted beside
/// the older `"open": bool`, which stays for the consumers that read it (QW-081).
fn state_word(open: bool) -> &'static str {
    if open {
        "open"
    } else {
        "closed"
    }
}

/// `(past tense, prompt verb)` of a close or a reopen ("reopend" was L-35).
fn open_words(close: bool) -> (&'static str, &'static str) {
    if close {
        ("closed", "Close")
    } else {
        ("reopened", "Reopen")
    }
}

async fn set_open(ctx: &Ctx, repo: &str, number: u64, close: bool) -> Result<()> {
    let s = Session::open_for_write(ctx, repo, "state not changed").await?;
    let target = target(&s, repo, number).await?;
    let (done, prompt) = open_words(close);
    let collab = s.collab();
    // Closing a closed issue (or reopening an open one) is not an error: nothing to write, as
    // `gh issue close` says (QW-042: it stopped with E604, a code for consensus refusals). The
    // state is the one the write would be judged against (its transition sum), read the same
    // way `set_state` reads it.
    let open = status_of_code(collab.state_sum(&s.repo, &target.id).await?).open;
    if open != close {
        let state = state_word(open);
        ctx.emit(
            json!({ "status": "unchanged", "issue": number, "open": open, "state": state, "written": false }),
            || println!("issue #{number} is already {state}; nothing written"),
        );
        return Ok(());
    }
    ctx.confirm_or_cancel(&format!("{prompt} issue #{number}? (one small document)"))?;
    let action = if close {
        StateAction::Close
    } else {
        StateAction::Reopen
    };
    let change = collab.set_state(&s.repo, &target, action, None).await?;
    let open_now = collab
        .issue_view(&s.repo, target.number)
        .await?
        .map(|v| v.state.open);
    ctx.emit(
        json!({
            "status": done,
            "issue": number,
            "via": change.route,
            "transitionId": change.transition_id,
            "kind": change.kind,
            "open": open_now,
            "state": open_now.map(state_word),
        }),
        || {
            println!(
                "✓ {done} issue #{number} {}",
                transition_route_text(change.route)
            );
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
    let s = Session::open_for_write(ctx, repo, "label not changed").await?;
    let collab = s.collab();
    // Only a label the repository defines is put on an issue, spelt as defined (QW2-015:
    // a typo was written as a permanent, paid event). Taking one off is never refused.
    let names = if add {
        let defined = collab
            .labels(&s.repo)
            .await
            .context("reading the repository's labels")?;
        defined_labels(names, &defined, &s.repo.display())?
    } else {
        names.to_vec()
    };
    // A label already on (or already off) the issue is not written again: it would be paid
    // for and show twice in the timeline (QW-035). One the issue carries in another case is
    // the same label, as the web's picker treats it.
    let (target, current) = target_and_state(&s, repo, number).await?;
    let labels = current.as_ref().map(|c| &c.labels);
    let names = spelt_as_on_issue(&names, labels);
    let (names, unchanged) = changes(&names, labels, add);
    if names.is_empty() {
        let already = if add { "already has" } else { "does not have" };
        ctx.emit(
            json!({
                "status": "unchanged",
                "issue": number,
                "labels": unchanged,
                "action": if add { "add" } else { "remove" },
                "written": false,
            }),
            || {
                println!(
                    "issue #{number} {already} {}; nothing written",
                    label_list(&unchanged)
                );
            },
        );
        return Ok(());
    }
    if !unchanged.is_empty() && !ctx.json {
        let already = if add { "already on" } else { "not on" };
        println!(
            "{} {already} issue #{number}; skipped",
            label_list(&unchanged)
        );
    }
    // a private repo seals the label name into the event's `enc` (private-repos.md §7)
    ctx.confirm_or_cancel(&format!(
        "{} label(s) {} on issue #{number}? (one small document each; members only)",
        if add { "Add" } else { "Remove" },
        names.join(", ")
    ))?;
    let before = s.balance().await;
    let mut ids = Vec::new();
    for name in &names {
        ids.push(
            collab
                .post_event(&s.repo, &target, kind, Some(name), None)
                .await?,
        );
    }
    let spent = s.spent_since(before).await;
    let price = ctx.usd_price();
    ctx.emit(
        json!({
            "cost": cost_json(spent, price),
            "status": "labeled",
            "issue": number,
            "label": names.first(),
            "labels": names,
            "action": if add { "add" } else { "remove" },
            "eventId": ids.first(),
            "eventIds": ids,
            "unchanged": unchanged,
        }),
        || {
            let verb = if add { "added" } else { "removed" };
            println!(
                "✓ {verb} label {} on issue #{number} · {}",
                safe(&names.join(", ")),
                cost_line(spent, price)
            );
        },
    );
    Ok(())
}

/// Issue `number` as an event target, with its labels and assignees when every value in its
/// log could be read (a private repository's sealed values need the member's key); `None`
/// when some could not, so nothing is assumed about them. The state is as fresh as the node
/// answering: a change made a moment ago may not show yet.
async fn target_and_state(
    s: &Session,
    repo: &str,
    number: u64,
) -> Result<(Target, Option<IssueState>)> {
    let view = s
        .collab()
        .issue_view(&s.repo, number_arg(number)?)
        .await?
        .ok_or_else(|| not_found(repo, number))?;
    let state = (view.hidden_values == 0).then_some(view.state);
    Ok((view.issue.target(), state))
}

/// Split the `wanted` labels or assignees into those an add (or a removal) would change and
/// those it would not, given what the issue has now (`current`; `None`: unknown, so every
/// one is written). A name given twice is written once.
fn changes(
    wanted: &[String],
    current: Option<&std::collections::BTreeSet<String>>,
    add: bool,
) -> (Vec<String>, Vec<String>) {
    let mut write = Vec::new();
    let mut unchanged = Vec::new();
    for w in wanted {
        if write.contains(w) || unchanged.contains(w) {
            continue;
        }
        if current.is_some_and(|c| c.contains(w) == add) {
            unchanged.push(w.clone());
        } else {
            write.push(w.clone());
        }
    }
    (write, unchanged)
}

/// `wanted` as the repository's live (not retired) label definitions spell them, matched
/// without regard to case as the web's picker does; E102 naming the ones it lacks, and the
/// labels it has, before anything is signed (QW2-015; `gh issue edit --add-label` refuses a
/// label that does not exist the same way).
fn defined_labels(
    wanted: &[String],
    defined: &[forge_core::collab::Label],
    repo: &str,
) -> Result<Vec<String>> {
    let live: Vec<&str> = defined
        .iter()
        .filter(|l| !l.retired)
        .map(|l| l.name.as_str())
        .collect();
    let mut out = Vec::with_capacity(wanted.len());
    let mut missing = Vec::new();
    for w in wanted {
        match live.iter().find(|d| d.eq_ignore_ascii_case(w)) {
            Some(d) => out.push((*d).to_string()),
            None => missing.push(w.clone()),
        }
    }
    if missing.is_empty() {
        return Ok(out);
    }
    let have = if live.is_empty() {
        "it defines no labels".to_string()
    } else {
        format!("its labels: {}", safe(&live.join(", ")))
    };
    let first = crate::storage_wizard::shell_word(missing.first().map_or("", String::as_str));
    Err(UserError::new(
        codes::NOT_FOUND,
        format!(
            "label not changed: {} {} not defined in {repo}",
            label_list(&missing),
            if missing.len() == 1 { "is" } else { "are" }
        ),
    )
    .cause(have)
    .fix(format!(
        "define it first: `dg label create {repo} {}`",
        safe(&first)
    ))
    .note("checked before anything was signed; nothing was written or paid")
    .into())
}

/// `names` spelt as the issue's `current` labels spell them, where one matches without
/// regard to case (`None`: unknown, left as they are).
fn spelt_as_on_issue(
    names: &[String],
    current: Option<&std::collections::BTreeSet<String>>,
) -> Vec<String> {
    names
        .iter()
        .map(|n| {
            current
                .and_then(|c| c.iter().find(|l| l.eq_ignore_ascii_case(n)))
                .unwrap_or(n)
                .clone()
        })
        .collect()
}

/// `bug` or `bug, docs` for a message, terminal-safe.
fn label_list(names: &[String]) -> String {
    safe(&names.join(", ")).to_string()
}

async fn assign(ctx: &Ctx, repo: &str, number: u64, who: &[String], add: bool) -> Result<()> {
    let s = Session::open(ctx, repo).await?;
    // An assignee already on (or already off) the issue is not written again (QW-035).
    let (target, current) = target_and_state(&s, repo, number).await?;
    let mut wanted = Vec::new();
    for w in who {
        wanted.push(identity_arg(&s.client, || Ok(s.identity.id()), w).await?);
    }
    let (ids, unchanged) = changes(&wanted, current.as_ref().map(|c| &c.assignees), add);
    if ids.is_empty() {
        let already = if add {
            "already assigned"
        } else {
            "not assigned"
        };
        ctx.emit(
            json!({
                "status": "unchanged",
                "issue": number,
                "assignees": unchanged,
                "written": false,
            }),
            || {
                println!(
                    "{} {already} on issue #{number}; nothing written",
                    unchanged.join(", ")
                );
            },
        );
        return Ok(());
    }
    if !unchanged.is_empty() && !ctx.json {
        let already = if add {
            "already assigned"
        } else {
            "not assigned"
        };
        println!(
            "{} {already} on issue #{number}; skipped",
            unchanged.join(", ")
        );
    }
    ctx.confirm_or_cancel(&format!(
        "{} {} on issue #{number}? (one small document each; members only)",
        if add { "Assign" } else { "Unassign" },
        ids.join(", ")
    ))?;
    let collab = s.collab();
    let before = s.balance().await;
    let mut events = Vec::new();
    for id in &ids {
        events.push(collab.set_assignee(&s.repo, &target, id, add).await?);
    }
    let spent = s.spent_since(before).await;
    let price = ctx.usd_price();
    ctx.emit(
        json!({
            "cost": cost_json(spent, price),
            "status": if add { "assigned" } else { "unassigned" },
            "issue": number,
            "assignees": ids,
            "eventIds": events,
            "unchanged": unchanged,
        }),
        || {
            let verb = if add { "assigned" } else { "unassigned" };
            println!(
                "✓ {verb} {} on issue #{number} · {}",
                ids.join(", "),
                cost_line(spent, price)
            );
        },
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        changes, event_phrase, label_args, open_words, state_word, timeline, title_matches, Item,
    };

    /// QW-081: an issue's JSON `"state"` uses the words `dg pr`'s does.
    #[test]
    fn an_issue_state_is_the_word_a_pr_state_uses() {
        assert_eq!(state_word(true), "open");
        assert_eq!(state_word(false), "closed");
    }

    /// QW-035: a label (or assignee) already on the issue is not written again, one already
    /// off is not removed again, and a name given twice is written once. An unreadable state
    /// assumes nothing.
    #[test]
    fn only_what_would_change_is_written() {
        let names = |v: &[&str]| v.iter().map(|s| (*s).to_string()).collect::<Vec<_>>();
        let on: std::collections::BTreeSet<String> = ["bug".to_string()].into();
        assert_eq!(
            changes(&names(&["bug", "docs", "docs"]), Some(&on), true),
            (names(&["docs"]), names(&["bug"]))
        );
        assert_eq!(
            changes(&names(&["bug"]), Some(&on), true),
            (vec![], names(&["bug"]))
        );
        assert_eq!(
            changes(&names(&["bug", "docs"]), Some(&on), false),
            (names(&["bug"]), names(&["docs"]))
        );
        assert_eq!(
            changes(&names(&["bug"]), None, true),
            (names(&["bug"]), vec![])
        );
    }

    /// QW2-015: only a defined, live label is put on an issue, spelt as defined; anything
    /// else is refused (E102) with the labels the repository has, before anything is signed.
    #[test]
    fn only_a_defined_label_is_added() {
        use super::defined_labels;
        let def = |name: &str, retired: bool| forge_core::collab::Label {
            document_id: String::new(),
            name: name.into(),
            color: "#d73a4a".into(),
            description: String::new(),
            retired,
            created_at: 0,
        };
        let defs = [def("bug", false), def("Docs", false), def("old", true)];
        let w = |v: &[&str]| v.iter().map(|s| (*s).to_string()).collect::<Vec<_>>();
        assert_eq!(
            defined_labels(&w(&["bug", "docs"]), &defs, "a/p").unwrap(),
            w(&["bug", "Docs"])
        );
        for wanted in [&["nosuchlabel"][..], &["bug", "nosuchlabel"], &["old"]] {
            let err = defined_labels(&w(wanted), &defs, "a/p").unwrap_err();
            let u = err
                .downcast_ref::<forge_core::user_error::UserError>()
                .expect("a phrased error");
            assert_eq!(u.code, "E102");
            assert!(u.message.contains("not defined in a/p"), "{}", u.message);
            assert!(!u.message.contains("bug,"), "{}", u.message);
            assert_eq!(u.cause.as_deref(), Some("its labels: bug, Docs"));
        }
        let err = defined_labels(&w(&["good first issue"]), &[], "a/p").unwrap_err();
        let u = err
            .downcast_ref::<forge_core::user_error::UserError>()
            .unwrap();
        assert_eq!(u.cause.as_deref(), Some("it defines no labels"));
        // the fix is a command that can be pasted
        assert!(
            u.fix[0].contains("`dg label create a/p 'good first issue'`"),
            "{:?}",
            u.fix
        );
        // an issue already carrying the label in another case has it
        let on: std::collections::BTreeSet<String> = ["docs".to_string()].into();
        assert_eq!(
            super::spelt_as_on_issue(&w(&["Docs", "bug"]), Some(&on)),
            w(&["docs", "bug"])
        );
        assert_eq!(super::spelt_as_on_issue(&w(&["Docs"]), None), w(&["Docs"]));
    }
    use crate::fmt::transition_phrase;
    use forge_core::collab::v2::Comment;
    use forge_core::rules::v2::Transition;
    use forge_core::rules::{Event, EventKind};

    #[test]
    fn close_and_reopen_read_as_english() {
        assert_eq!(open_words(true), ("closed", "Close"));
        assert_eq!(open_words(false), ("reopened", "Reopen"));
    }

    fn event(id: &str, at: u64, kind: EventKind, value: Option<&str>) -> Event {
        Event {
            id: id.into(),
            target_id: "t".into(),
            kind,
            actor: "A".into(),
            value: value.map(str::to_string),
            oid: None,
            ref_id: None,
            created_at: at,
        }
    }

    fn comment(id: &str, at: u64) -> Comment {
        Comment {
            document_id: id.into(),
            author: "B".into(),
            body: "hi".into(),
            reply_to: None,
            review_id: None,
            anchor: forge_core::rules::v2::AnchorFields::default(),
            created_at: at,
            imported: None,
        }
    }

    /// L-35: `dg issue view` shows label and close events among the comments, in time order,
    /// in the web timeline's words.
    #[test]
    fn issue_view_interleaves_events_with_comments() {
        let events = [event("e1", 10, EventKind::LabelAdd, Some("bug"))];
        let transition = |id: &str, at: u64, kind: u8| Transition {
            id: id.into(),
            kind,
            actor: "M".into(),
            oid: None,
            as_author: 0,
            created_at: at,
        };
        let transitions = [transition("t3", 30, 1), transition("t4", 40, 2)];
        let comments = [comment("c2", 20)];
        let order: Vec<String> = timeline(&comments, &events, &transitions)
            .iter()
            .map(|i| match i {
                Item::Comment(c) => c.document_id.clone(),
                Item::Event(e) => event_phrase(e),
                Item::Transition(t) => transition_phrase(t.kind).to_string(),
            })
            .collect();
        assert_eq!(
            order,
            ["added the bug label", "c2", "closed this", "reopened this"]
        );
        assert_eq!(
            event_phrase(&event("e", 1, EventKind::LabelRemove, Some("docs"))),
            "removed the docs label"
        );
        assert_eq!(
            event_phrase(&event("e", 1, EventKind::Assign, Some("X"))),
            "assigned X"
        );
        // A sealed value this reader cannot open.
        assert_eq!(
            event_phrase(&event("e", 1, EventKind::LabelAdd, None)),
            "added a label (hidden)"
        );
    }

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
