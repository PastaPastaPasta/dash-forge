//! `dg issue` — issue tracking (list/view/create/edit/comment/close/reopen/label/assign).
//!
//! forge-v2 repositories go through [`forge_core::collab::v2::Collab`]: issues take the dense
//! next number (`forge-v2.md` §6), a create is journaled so a re-run resumes it, and close /
//! reopen are one `transition` each, written as a member or as the issue's author.

use anyhow::{Context as _, Result};
use serde_json::json;

use forge_core::collab::v2::{
    Comment, IssueView, MembersOnly, SealedIssue, Target, TargetKind, TargetRead,
};
use forge_core::create::default_journal_dir;
use forge_core::rules::v2::{
    close_reason_of, current_close_reason, status_of_code, CloseReason, ClosedAs, StateAction,
    Transition,
};
use forge_core::rules::{Event, EventKind, IssueState};

use crate::common::{number_arg, Reader, Session};
use crate::context::Ctx;
use crate::fmt::{cost_json, cost_line, safe, transition_phrase, transition_route_text, with_name};
use crate::meta::{
    changes, defined_labels, identity_arg, label_list, spelt_as_on as spelt_as_on_issue, trimmed,
};
use crate::{CloseReasonArg, HideReasonArg, IssueCommand, IssueListArgs};

/// Dispatch an `issue` subcommand.
#[allow(clippy::too_many_lines)] // one arm per subcommand
pub async fn run(ctx: &Ctx, cmd: &IssueCommand) -> Result<()> {
    match cmd {
        IssueCommand::Status { repo } => crate::status::issue_status(ctx, repo).await,
        IssueCommand::List(args) => list(ctx, args).await,
        IssueCommand::View {
            repo,
            number,
            show_hidden,
        } => view(ctx, repo, *number, *show_hidden).await,
        IssueCommand::Create {
            repo,
            title,
            body,
            members,
        } => create(ctx, repo, title, body, *members).await,
        IssueCommand::Edit {
            repo,
            number,
            title,
            body,
            body_file,
            meta,
        } => {
            let body = match (body, body_file) {
                (Some(b), _) => Some(b.clone()),
                (None, Some(path)) => Some(read_body_file(path)?),
                (None, None) => None,
            };
            edit(
                ctx,
                repo,
                *number,
                title.as_deref(),
                body.as_deref(),
                &meta.edit(),
            )
            .await
        }
        IssueCommand::Comment {
            repo,
            number,
            body,
            members,
        } => comment(ctx, repo, *number, body, *members).await,
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
        IssueCommand::Close {
            repo,
            number,
            reason,
            duplicate_of,
        } => {
            let closed = closed_as(*number, *reason, *duplicate_of)?;
            set_open(ctx, repo, *number, Some(closed)).await
        }
        IssueCommand::Reopen { repo, number } => set_open(ctx, repo, *number, None).await,
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
        IssueCommand::Hide {
            repo,
            number,
            comment,
            reason,
            off,
        } => {
            hide(
                ctx,
                repo,
                *number,
                comment.as_deref(),
                reason.map(HideReasonArg::as_str),
                !off,
            )
            .await
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
        // Members only, triage included (E601 first, as for a clear): then the title must
        // name an open one.
        s.collab()
            .require_role(
                &s.repo,
                forge_core::rules::v2::Role::Triage,
                &format!("put issue #{number} in a milestone"),
            )
            .await?;
        crate::meta::require_open_milestone(&s, t).await?;
    }
    let what = title.map_or_else(
        || format!("Take issue #{number} out of its milestone"),
        |t| format!("Put issue #{number} in milestone {t:?}"),
    );
    let price = ctx.usd_price();
    let quote = crate::quote::event(title.map_or(0, str::len) as u64, false);
    ctx.confirm_or_cancel(&format!(
        "{what}? (one event, {}; members only)",
        cost_line(quote, price)
    ))?;
    let collab = s.collab();
    let (id, spent) = s
        .metered(|| collab.set_milestone(&s.repo, &target, title))
        .await?;
    ctx.emit(
        json!({
            "status": if title.is_some() { "set" } else { "cleared" },
            "issue": number,
            "milestone": title,
            "eventId": id,
            "cost": cost_json(spent, price),
        }),
        || match title {
            Some(t) => println!(
                "✓ issue #{number} is in milestone {t} · {}",
                cost_line(spent, price)
            ),
            None => println!(
                "✓ issue #{number} has no milestone · {}",
                cost_line(spent, price)
            ),
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
    // Who may make the change: a pin is a writer's, a lock triage's too (QW4-032).
    let who = match flag {
        Flag::Pin => "maintainers and writers",
        Flag::Lock => "maintainers, writers and triage members",
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
    // A pin is an event; a lock or unlock is a transition (RC1 kinds 3 / 4).
    let (doc, quote) = match flag {
        Flag::Pin => ("one event", crate::quote::event(0, false)),
        Flag::Lock => ("one transition", crate::quote::TRANSITION),
    };
    let price = ctx.usd_price();
    ctx.confirm_or_cancel(&format!(
        "{verb} issue #{number}? ({doc}, {}; {who}{note})",
        cost_line(quote, price)
    ))?;
    let ((key, id), spent) = s
        .metered(|| async {
            Ok::<_, forge_core::Error>(match flag {
                Flag::Pin => ("eventId", collab.set_pinned(&s.repo, &target, on).await?),
                Flag::Lock => (
                    "transitionId",
                    collab.set_locked(&s.repo, &target, on).await?,
                ),
            })
        })
        .await?;
    ctx.emit(
        json!({ "status": done, "issue": number, key: id, "cost": cost_json(spent, price) }),
        || println!("✓ {done} issue #{number} · {}", cost_line(spent, price)),
    );
    Ok(())
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

fn labels_of(state: &IssueState) -> String {
    state.labels.iter().cloned().collect::<Vec<_>>().join(", ")
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

#[allow(clippy::too_many_lines)] // the reads, then the JSON and the human list
async fn list(ctx: &Ctx, args: &IssueListArgs) -> Result<()> {
    if args.limit == 0 || args.limit > 100 {
        return Err(crate::errors::usage("--limit is 1-100"));
    }
    if args.page == 0 {
        return Err(crate::errors::usage("--page starts at 1"));
    }
    let s = Reader::open_discussion(ctx, &args.repo).await?;
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
    // the reader's keys; a public repo's members-only issues a reader cannot open are rows of
    // their own ("#3 · members-only issue by @alice · open", DESIGN D14).
    let mut read = s.collab().issues_with_state_read(&s.repo).await?;
    // In a private repository an issue this member cannot open (another key, written late) is
    // counted as before, not shown as a members-only row: everything there is for members.
    let private = s.repo.visibility == forge_core::rules::v2::Visibility::Private;
    let sealed = if private {
        Vec::new()
    } else {
        std::mem::take(&mut read.members_only)
    };
    let hidden = read.malformed + read.members_only.len();
    let mut all: Vec<ListRow> = read
        .rows
        .into_iter()
        .map(ListRow::Issue)
        .chain(sealed.into_iter().map(ListRow::Sealed))
        .collect();
    // newest first, as read (the two kinds interleave by creation)
    all.sort_by_key(|r| std::cmp::Reverse((r.created_at(), r.id().to_string())));
    let mut matching: Vec<(ListRow, bool)> = all
        .into_iter()
        .filter(|r| match r {
            ListRow::Issue(v) => issue_matches(args, author.as_deref(), assignee.as_ref(), v),
            ListRow::Sealed(x) => sealed_matches(args, author.as_deref(), assignee.as_ref(), x),
        })
        .map(|r| {
            let pinned = forge_core::rules::v2::fold_thread_meta_v2(r.events()).pinned;
            (r, pinned)
        })
        .collect();
    // Pinned issues first (a member's pin, kinds 19/20), each group newest first as read.
    matching.sort_by_key(|r| !r.1);
    let total = matching.len();
    let total_sealed = matching
        .iter()
        .filter(|(r, _)| matches!(r, ListRow::Sealed(_)))
        .count();
    let per = args.limit as usize;
    let pages = total.div_ceil(per).max(1);
    let start = (args.page as usize - 1) * per;
    let page: Vec<&(ListRow, bool)> = matching.iter().skip(start).take(per).collect();
    // RC2 MOD: the page's issues a maintainer hid, from the events already read (the feed).
    // Paged first, as on the web: the totals stay the consensus ones.
    let threads: Vec<(Target, &[Event])> =
        page.iter().map(|(r, _)| (r.target(), r.events())).collect();
    let hides = s.collab().hidden_threads(&s.repo, &threads).await;
    let (rows, omitted) =
        crate::fmt::split_hidden(page, &hides, |(r, _)| r.id(), args.include_hidden);
    let names = if ctx.json {
        std::collections::BTreeMap::new()
    } else {
        let moderators = rows.iter().filter_map(|(_, h)| h.map(|h| h.by.as_str()));
        let sealed = rows.iter().filter_map(|((r, _), _)| match r {
            ListRow::Sealed(x) => Some(x.placeholder.author.as_str()),
            ListRow::Issue(_) => None,
        });
        s.client.dpns_first_names(moderators.chain(sealed)).await
    };
    let who = |id: &str| with_name(id, &names);

    let json_rows: Vec<_> = rows
        .iter()
        .map(|((r, pinned), h)| match r {
            ListRow::Issue(v) => issue_row_json(v, *pinned, *h),
            ListRow::Sealed(x) => sealed_row_json(x, *pinned, *h),
        })
        .collect();
    ctx.emit(
        json!({
            "count": rows.len(),
            "total": total,
            "membersOnly": total_sealed,
            "page": args.page,
            "pages": pages,
            "issues": json_rows,
            "hidden": hidden,
            "hiddenOmitted": omitted,
            "truncated": args.page as usize * per < total,
        }),
        || {
            if rows.is_empty() && omitted == 0 {
                println!("{}", empty_issues_line(args, total, pages));
            }
            for ((r, pinned), h) in &rows {
                let hid = h.map(|h| crate::fmt::hidden_row_mark(h, &who));
                match r {
                    ListRow::Issue(v) => {
                        let mark = crate::audience::suffix(&s.repo, v.issue.audience);
                        println!("{}{mark}", issue_line(v, *pinned, &hid.unwrap_or_default()));
                    }
                    ListRow::Sealed(x) => println!(
                        "{}",
                        sealed_line(x, *pinned, &crate::audience::at_name(&x.placeholder.author, &names), &hid.unwrap_or_default())
                    ),
                }
            }
            if let Some(note) = crate::fmt::hidden_rows_note(omitted) {
                println!("{note}");
            }
            if total_sealed > 0 {
                println!(
                    "Issues {total} ({total_sealed} members-only; only members of {} can read them)",
                    s.repo.display()
                );
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

/// One row of `dg issue list`: an issue, or a members-only one this reader cannot open.
enum ListRow {
    Issue(IssueView),
    Sealed(SealedIssue),
}

impl ListRow {
    fn id(&self) -> &str {
        match self {
            ListRow::Issue(v) => &v.issue.document_id,
            ListRow::Sealed(x) => &x.placeholder.document_id,
        }
    }

    fn created_at(&self) -> u64 {
        match self {
            ListRow::Issue(v) => v.issue.created_at,
            ListRow::Sealed(x) => x.placeholder.created_at,
        }
    }

    fn events(&self) -> &[Event] {
        match self {
            ListRow::Issue(v) => &v.log.events,
            ListRow::Sealed(x) => &x.log.events,
        }
    }

    fn target(&self) -> Target {
        match self {
            ListRow::Issue(v) => v.issue.target(),
            ListRow::Sealed(x) => Target {
                kind: TargetKind::Issue,
                id: x.placeholder.document_id.clone(),
                number: x.placeholder.number.unwrap_or_default(),
                author: x.placeholder.author.clone(),
            },
        }
    }
}

/// Whether a members-only issue this reader cannot open passes the filters: its state and
/// author are public; its title, labels and assignees are not, so a filter on them leaves it
/// out (search covers no members-only issue, DESIGN D30).
fn sealed_matches(
    args: &IssueListArgs,
    author: Option<&str>,
    assignee: Option<&Option<String>>,
    x: &SealedIssue,
) -> bool {
    args.state.matches(x.state.open)
        && args.labels.is_empty()
        && assignee.is_none()
        && args.search.is_none()
        && author.is_none_or(|a| x.placeholder.author == a)
}

/// One `dg issue list --json` row of a members-only issue this reader cannot open: its number,
/// author and state, never its title.
fn sealed_row_json(
    x: &SealedIssue,
    pinned: bool,
    h: Option<&forge_core::rules::v2::Hidden>,
) -> serde_json::Value {
    let m = &x.placeholder;
    crate::fmt::with_hidden_by(
        json!({
            "number": m.number,
            "title": null,
            "author": m.author,
            "open": x.state.open,
            "state": state_word(x.state.open),
            "labels": [],
            "assignees": [],
            "pinned": pinned,
            "audience": crate::audience::json(m.audience),
            "readable": false,
        }),
        h,
    )
}

/// One `dg issue list` row of a members-only issue this reader cannot open:
/// "#3    open   · members-only issue by @alice".
fn sealed_line(x: &SealedIssue, pinned: bool, who: &str, hid: &str) -> String {
    let mark = state_word(x.state.open);
    let mark = if pinned {
        format!("{mark}, pinned")
    } else {
        mark.to_string()
    };
    format!(
        "#{:<4} {mark:<6} · {} by {who}{}",
        x.placeholder.number.unwrap_or_default(),
        crate::audience::sealed_noun(x.placeholder.audience, "issue"),
        safe(hid)
    )
}

/// One `dg issue list --json` row, with its `hiddenBy`.
fn issue_row_json(
    v: &IssueView,
    pinned: bool,
    h: Option<&forge_core::rules::v2::Hidden>,
) -> serde_json::Value {
    let st = &v.state;
    crate::fmt::with_hidden_by(
        json!({
            "number": v.issue.number,
            "title": v.issue.title,
            "author": v.issue.author,
            "open": st.open,
            "state": state_word(st.open),
            "labels": st.labels,
            "assignees": st.assignees,
            "pinned": pinned,
            "audience": crate::audience::json(v.issue.audience),
        }),
        h,
    )
}

/// One `dg issue list` row: number, state (pinned), title, labels, how many are assigned, and
/// `hid`, a hidden issue's mark (`--include-hidden`).
fn issue_line(v: &IssueView, pinned: bool, hid: &str) -> String {
    let st = &v.state;
    let mark = state_word(st.open);
    let mark = if pinned {
        format!("{mark}, pinned")
    } else {
        mark.to_string()
    };
    let labels = if st.labels.is_empty() {
        String::new()
    } else {
        format!("  [{}]", labels_of(st))
    };
    let assigned = if st.assignees.is_empty() {
        String::new()
    } else {
        format!("  ({} assigned)", st.assignees.len())
    };
    format!(
        "#{:<4} {mark:<6} {}{}{assigned}{}",
        v.issue.number,
        safe(&v.issue.title),
        safe(&labels),
        safe(hid)
    )
}

#[allow(clippy::too_many_lines)] // one view: the reads, then its JSON and its human rendering
async fn view(ctx: &Ctx, repo: &str, number: u64, show_hidden: bool) -> Result<()> {
    let s = Reader::open_discussion(ctx, repo).await?;

    let collab = s.collab();
    let num = number_arg(number)?;
    // A members-only issue this reader cannot open is its row ("#3 · members-only issue by
    // @alice · open"), exit 0: its number is public, and an outsider reading it is expected.
    match collab.target_read(&s.repo, TargetKind::Issue, num).await? {
        None => return Err(not_found(repo, number)),
        Some(TargetRead::MembersOnly(m)) => {
            return crate::audience::target_view(ctx, &s, TargetKind::Issue, num, &m).await
        }
        Some(TargetRead::Readable(_)) => {}
    }
    let view = collab
        .issue_view(&s.repo, num)
        .await?
        .ok_or_else(|| not_found(repo, number))?;
    let (mut comments, members_only, malformed) = collab
        .comments_read(&s.repo, &view.issue.document_id)
        .await?;
    let hidden = malformed + members_only.len();
    // DESIGN D14: a members-only comment this reader cannot open shows as a placeholder when it
    // carries `asMember`; every one is counted in the note under the timeline.
    let (placeholders, _) = crate::audience::shown(&s.repo, &members_only);
    let issue_audience = view.issue.audience;
    // Long bodies (forge-v2.md §6.3): the full text each field's trailer names, fetched and
    // checked; a text whose rest cannot be read keeps its first part and says why.
    let mut body = view.issue.body.clone();
    let mut why = crate::long_body::read_in_place(
        &collab,
        &s.repo,
        std::iter::once((&mut body, issue_audience))
            .chain(comments.iter_mut().map(|c| {
                let aud = c.audience;
                (&mut c.body, aud)
            }))
            .collect(),
    )
    .await
    .into_iter();
    let body_incomplete = why.next().flatten();
    let incomplete: std::collections::BTreeMap<String, String> = comments
        .iter()
        .zip(why)
        .filter_map(|(c, w)| w.map(|w| (c.document_id.clone(), w)))
        .collect();
    // RC2 MOD: what maintainers hid (collapsed below unless --show-hidden)
    let moderation = collab
        .hidden_items(&s.repo, &view.issue.target(), &view.log, &comments, &[])
        .await?;
    let values_note = crate::fmt::event_values_note(view.hidden_values, view.plaintext_values);
    let (hidden_values, plaintext_values) = (view.hidden_values, view.plaintext_values);
    // A hide or unhide readers ignore (a writer's without the contract's proof, a refId of
    // another thread) is noise, not the record: only the counted ones show.
    let events: Vec<Event> = view
        .events()
        .into_iter()
        .filter(|e| {
            !matches!(e.kind, EventKind::Hide | EventKind::Unhide)
                || moderation.counted.contains(&e.id)
        })
        .cloned()
        .collect();
    let transitions = view.log.transitions.clone();
    let timeline = timeline(&comments, &events, &transitions, &placeholders);
    let issue_number = u32::try_from(number).unwrap_or(u32::MAX);
    // "closed this as completed in #3" (QW4-065): the merged PR each close followed, as the
    // web's timeline reads it. Only closes are looked up; a failed read leaves the line bare.
    let mut closed_in = std::collections::BTreeMap::new();
    // A close recorded as not planned or a duplicate was not the merge's doing (the web
    // links neither).
    let by_merge = |t: &&Transition| {
        t.kind == forge_core::rules::transition::ISSUE_CLOSE
            && close_reason_of(t, issue_number).is_none_or(|c| c.reason == CloseReason::Completed)
    };
    for t in transitions.iter().filter(by_merge) {
        if let Ok(Some(pr)) = collab.closing_merge(&s.repo, t, issue_number).await {
            closed_in.insert(t.id.clone(), pr);
        }
    }
    let closed = current_close_reason(&transitions, issue_number);
    let (state_reason, duplicate_of) = close_reason_json(closed.as_ref());
    // Milestone and pin: the member events folded (kinds 17-20). Lock: the transitions'
    // sum (16 or more is locked).
    let meta = forge_core::rules::v2::fold_thread_meta_v2(&view.log.events);
    let locked = view.log.locked();
    let state = view.state;
    let i = view.issue;
    let (id, title, author) = (i.document_id, i.title, i.author);
    // DPNS names for the human view only, read together; a failed read shows the bare id.
    let names = if ctx.json {
        std::collections::BTreeMap::default()
    } else {
        let actors = comments.iter().map(|c| c.author.as_str());
        let actors = actors.chain(placeholders.iter().map(|m| m.author.as_str()));
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
            "bodyIncomplete": body_incomplete,
            "author": author,
            "documentId": id,
            "id": id,
            "audience": crate::audience::json(issue_audience),
            "state": { "open": state.open, "labels": state.labels, "assignees": state.assignees },
            "stateReason": state_reason,
            "duplicateOf": duplicate_of,
            "milestone": meta.milestone,
            "pinned": meta.pinned,
            "locked": locked,
            "comments": comments.iter().map(|c| json!({"id": c.document_id, "author": c.author, "body": c.body, "bodyIncomplete": incomplete.get(&c.document_id), "audience": crate::audience::json(c.audience)})).collect::<Vec<_>>(),
            // members-only comments this reader cannot open: the ones D14 shows, and how many
            "membersOnlyComments": placeholders.iter().map(|m| crate::audience::placeholder_json(m)).collect::<Vec<_>>(),
            "membersOnlyHidden": members_only.len(),
            "events": events.iter().map(|e| json!({
                "id": e.id,
                "kind": e.kind,
                "actor": e.actor,
                "value": e.value,
                "createdAt": e.created_at,
            })).collect::<Vec<_>>(),
            "transitions": transitions
                .iter()
                .map(|t| transition_json(t, closed_in.get(&t.id).copied()))
                .collect::<Vec<_>>(),
            "hiddenComments": hidden,
            "moderation": moderation,
            "hiddenEventValues": hidden_values,
            "plaintextEventValues": plaintext_values,
        }),
        || {
            let mark = match &closed {
                Some(c) if !state.open => format!("closed as {}", closed_words(c)),
                _ => state_word(state.open).to_string(),
            };
            println!("#{number} [{mark}] {}", safe(&title));
            println!("author: {}", who(&author));
            if crate::audience::marked(&s.repo, issue_audience) {
                println!("members-only: visible to members of {}", s.repo.display());
            }
            let labels: Vec<&str> = state.labels.iter().map(String::as_str).collect();
            let assignees: Vec<String> = state.assignees.iter().map(|a| who(a)).collect();
            for line in crate::fmt::triage_lines(&labels, &assignees, meta.milestone.as_deref()) {
                println!("{line}");
            }
            if let Some(h) = &moderation.thread {
                println!("{}", crate::fmt::hidden_line("this issue", h, &who, show_hidden));
                if !show_hidden {
                    return;
                }
            }
            if !body.is_empty() {
                println!("\n{}", safe(&body));
            }
            if let Some(why) = &body_incomplete {
                println!("{}", crate::long_body::partial_line(why));
            }
            for item in &timeline {
                match item {
                    Item::Placeholder(m) => println!(
                        "\n— {} ({}): [{}]",
                        who(&m.author),
                        m.document_id,
                        crate::audience::sealed_noun(m.audience, "comment")
                    ),
                    Item::Comment(c) => {
                        let author = who(&c.author);
                        // "— alice (id) · members-only:" for a members-only comment
                        let mark = if crate::audience::marked(&s.repo, c.audience) {
                            " · members-only"
                        } else {
                            ""
                        };
                        match moderation.item(&c.document_id) {
                            Some(h) if !show_hidden => println!(
                                "\n— {author} ({}){mark}: {}",
                                c.document_id,
                                crate::fmt::hidden_line("comment", h, &who, false)
                            ),
                            h => {
                                println!("\n— {author} ({}){mark}:", c.document_id);
                                if let Some(h) = h {
                                    println!("{}", crate::fmt::hidden_line("comment", h, &who, true));
                                }
                                println!("{}", safe(&c.body));
                                if let Some(why) = incomplete.get(&c.document_id) {
                                    println!("{}", crate::long_body::partial_line(why));
                                }
                            }
                        }
                    }
                    Item::Event(e) => println!(
                        "\n· {} {}",
                        who(&e.actor),
                        safe(&event_phrase_with(e, &who))
                    ),
                    Item::Transition(t) => {
                        let pr = closed_in
                            .get(&t.id)
                            .map_or(String::new(), |n| format!(" in #{n}"));
                        println!(
                            "\n· {} {}{pr}",
                            who(&t.actor),
                            transition_line(t, issue_number)
                        );
                    }
                }
            }
            let unread: Vec<_> = members_only.iter().collect();
            for note in crate::audience::hidden_notes(&s.repo, malformed, &unread, "comment") {
                println!("\n{note}");
            }
            if let Some(n) = &values_note {
                println!("\n{n}");
            }
        },
    );
    Ok(())
}

/// A transition in `dg issue view --json`; `closed_in`: the PR whose merge made a close.
fn transition_json(t: &Transition, closed_in: Option<u32>) -> serde_json::Value {
    json!({
        "id": t.id,
        "kind": t.kind,
        "actor": t.actor,
        "asAuthor": t.as_author,
        "createdAt": t.created_at,
        "reason": t.reason,
        "dupNumber": t.dup_number,
        "closedIn": closed_in,
    })
}

/// One entry of an issue's timeline.
enum Item<'a> {
    Comment(&'a Comment),
    /// A members-only comment this reader cannot open (DESIGN D14).
    Placeholder(&'a MembersOnly),
    Event(&'a Event),
    Transition(&'a Transition),
}

/// Comments (and the placeholders of members-only ones), events and state changes in one
/// `(createdAt, id)` order, as the web's issue timeline has them.
fn timeline<'a>(
    comments: &'a [Comment],
    events: &'a [Event],
    transitions: &'a [Transition],
    placeholders: &[&'a MembersOnly],
) -> Vec<Item<'a>> {
    let mut items: Vec<(u64, &str, Item<'a>)> = comments
        .iter()
        .map(|c| (c.created_at, c.document_id.as_str(), Item::Comment(c)))
        .chain(
            placeholders
                .iter()
                .map(|m| (m.created_at, m.document_id.as_str(), Item::Placeholder(m))),
        )
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
            "page {} is past the last page ({pages}) of {}",
            args.page,
            crate::fmt::plural(total, "issue")
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
        EventKind::Hide | EventKind::Unhide => crate::fmt::moderation_phrase(e),
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
    let collab = s.collab();
    // Read first (another's comment is refused here): an inline comment's path and an import's
    // provenance share a private comment's room with its body.
    let stored = collab.comment_for_edit(&s.repo, comment_id).await?;
    let planned = crate::long_body::Planned::new(
        &s.repo,
        forge_core::collab::long_body::BodyField::Comment {
            path: stored.anchor.path.as_deref(),
        },
        stored.imported.as_ref(),
        body,
        // an edit keeps the comment's audience, as read with it
        stored.audience,
    )?;
    ctx.confirm_or_cancel(&format!(
        "Edit comment {comment_id}? (one document replace{})",
        planned.clause()
    ))?;
    let before = s.balance().await;
    let body = planned
        .field_text(&collab, &s.repo, stored.imported.as_ref())
        .await?;
    let edited = collab.update_comment(&s.repo, comment_id, &body).await?;
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

async fn create(ctx: &Ctx, repo: &str, title: &str, body: &str, members: bool) -> Result<()> {
    let s = Session::open_for_write(ctx, repo, "issue not created").await?;
    // One `Collab` for the command: the audience it asks for applies to every write it makes.
    let collab = s.collab();
    let audience = crate::audience::requested(&collab, &s.repo, members, None, None).await?;
    let planned = crate::long_body::Planned::new(
        &s.repo,
        forge_core::collab::long_body::BodyField::Issue { title },
        None,
        body,
        audience,
    )?;
    ctx.confirm_or_cancel(&format!(
        "Open {}issue {title:?} in {}? (one document, {}{})",
        crate::audience::prefix(&s.repo, audience),
        s.repo.display(),
        cost_line(
            crate::quote::target_create(title.len() as u64 + planned.field_bytes())
                + planned.extra_credits(&s.repo),
            ctx.usd_price()
        ),
        planned.clause()
    ))?;
    let before = s.balance().await;
    let journal = default_journal_dir()?;
    // An interrupted create of this issue that landed is finished first, before a long body's
    // artifact would be stored (and paid for) again.
    let created = if let Some(created) = collab
        .resume_issue_create(&s.repo, title, &planned.journal_text(), &journal)
        .await?
    {
        created
    } else {
        let body = planned.field_text(&collab, &s.repo, None).await?;
        collab.create_issue(&s.repo, title, &body, &journal).await?
    };
    let spent = s.spent_since(before).await;
    let price = ctx.usd_price();

    ctx.emit(
        json!({
            "status": "created",
            "number": created.number,
            "documentId": created.document_id,
            "id": created.document_id,
            "title": title,
            "audience": audience,
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
                "✓ opened {}issue #{} in {}{how} · {}",
                crate::audience::prefix(&s.repo, audience),
                created.number,
                s.repo.display(),
                cost_line(spent, price)
            );
        },
    );
    Ok(())
}

/// Hide (`on`) or unhide comment `comment` of issue `number`, or with none the issue itself
/// (RC2 MOD: one member event, kind 24 or 25). Maintainers only, refused before signing for
/// anyone else; nothing is deleted.
async fn hide(
    ctx: &Ctx,
    repo: &str,
    number: u64,
    comment: Option<&str>,
    reason: Option<&str>,
    on: bool,
) -> Result<()> {
    if let Some(id) = comment {
        crate::common::document_id_arg(id, "comment id", COMMENT_IDS)?;
    }
    let s = Session::open_for_write(ctx, repo, "nothing hidden").await?;
    let target = target(&s, repo, number).await?;
    let what = comment.map_or_else(
        || format!("issue #{number}"),
        |id| format!("comment {id} on issue #{number}"),
    );
    let (verb, done) = if on {
        ("Hide", "hid")
    } else {
        ("Unhide", "unhid")
    };
    // The hidden comment is the event's `refId`; the 32-byte `asMaintainer` proof rides along.
    let price = ctx.usd_price();
    let quote = crate::quote::event(reason.map_or(0, str::len) as u64 + 32, comment.is_some());
    ctx.confirm_or_cancel(&format!(
        "{verb} {what}? (one event, {}; maintainers only; nothing is deleted, and readers can still expand it)",
        cost_line(quote, price)
    ))?;
    let collab = s.collab();
    let (id, spent) = s
        .metered(|| collab.set_hidden(&s.repo, &target, comment, reason, on))
        .await?;
    ctx.emit(
        json!({
            "status": if on { "hidden" } else { "unhidden" },
            "issue": number,
            "comment": comment,
            "reason": reason,
            "eventId": id,
            "cost": cost_json(spent, price),
        }),
        || println!("✓ {done} {what} · {}", cost_line(spent, price)),
    );
    Ok(())
}

/// Resolve a v2 issue as an event or transition target. A members-only issue the signer
/// cannot read is still a target (its id, number and author are public): a maintainer closes,
/// locks or labels it by number without reading it.
async fn target(s: &Session, repo: &str, number: u64) -> Result<Target> {
    let n = number_arg(number)?;
    Ok(s.collab()
        .target_read(&s.repo, forge_core::collab::v2::TargetKind::Issue, n)
        .await?
        .ok_or_else(|| not_found(repo, number))?
        .target(forge_core::collab::v2::TargetKind::Issue, n))
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

/// `dg issue edit`: the title and body (a replace, the author only) and the labels, assignees
/// and milestone (events, members down to triage), confirmed once.
async fn edit(
    ctx: &Ctx,
    repo: &str,
    number: u64,
    title: Option<&str>,
    body: Option<&str>,
    meta: &crate::meta::MetaEdit,
) -> Result<()> {
    if title.is_none() && body.is_none() && meta.is_empty() {
        return Err(crate::errors::usage(
            "pass --title, --body, --body-file, --add-label, --remove-label, --add-assignee, --remove-assignee, --milestone or --remove-milestone",
        ));
    }
    let s = Session::open_for_write(ctx, repo, "issue not edited").await?;
    let view = s
        .collab()
        .issue_view(&s.repo, number_arg(number)?)
        .await?
        .ok_or_else(|| not_found(repo, number))?;
    let current = crate::meta::Current::of(
        view.hidden_values == 0,
        &view.state.labels,
        &view.state.assignees,
        forge_core::rules::v2::fold_thread_meta_v2(&view.log.events).milestone,
    );
    let plan = crate::meta::plan(&s, meta, &current, &format!("issue #{number}")).await?;
    let issue = &view.issue;
    let field = forge_core::collab::long_body::BodyField::Issue {
        title: title.unwrap_or(&issue.title),
    };
    let long = body
        .map(|b| {
            crate::long_body::Planned::new(
                &s.repo,
                field,
                issue.imported.as_ref(),
                b,
                issue.audience,
            )
        })
        .transpose()?;
    // a longer title leaves a private long body less room: its prefix is cut again
    let refit = (title.is_some() && body.is_none())
        .then(|| {
            crate::long_body::refit_kept(
                &s.repo,
                field,
                issue.imported.as_ref(),
                &issue.body,
                issue.audience,
            )
        })
        .flatten();
    let edit = crate::meta::Edit {
        noun: "issue",
        key: "issue",
        number,
        target: issue.target(),
        title,
        body,
        long,
        refit,
        imported: issue.imported.as_ref(),
        replace_note: String::new(),
        plan,
        title_json: json!(title),
    };
    crate::meta::run_edit(ctx, &s, edit).await
}

async fn comment(ctx: &Ctx, repo: &str, number: u64, body: &str, members: bool) -> Result<()> {
    let s = Session::open_for_write(ctx, repo, "comment not posted").await?;
    let target = target(&s, repo, number).await?;
    refuse_if_locked(&s, number, &target.id).await?;
    let price = ctx.usd_price();
    // One `Collab` for the command: the audience it asks for applies to the comment it writes.
    let collab = s.collab();
    let audience =
        crate::audience::requested(&collab, &s.repo, members, Some(&target.id), None).await?;
    let planned = crate::long_body::Planned::new(
        &s.repo,
        forge_core::collab::long_body::BodyField::Comment { path: None },
        None,
        body,
        audience,
    )?;
    ctx.confirm_or_cancel(&format!(
        "Post a {}comment on issue #{number}? (one comment, {}{})",
        crate::audience::prefix(&s.repo, audience),
        cost_line(
            crate::quote::comment(planned.field_bytes()) + planned.extra_credits(&s.repo),
            price
        ),
        planned.clause()
    ))?;
    let (id, spent) = s
        .metered(|| async {
            let body = planned.field_text(&collab, &s.repo, None).await?;
            Ok::<_, anyhow::Error>(
                collab
                    .comment(&s.repo, &target.id, &body, None, None)
                    .await?,
            )
        })
        .await?;
    ctx.emit(
        json!({ "status": "commented", "issue": number, "commentId": id, "audience": audience, "cost": cost_json(spent, price) }),
        || {
            println!(
                "✓ commented on issue #{number}{} · {}",
                crate::audience::suffix(&s.repo, audience),
                cost_line(spent, price)
            );
        },
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
    .cause("a member locked the conversation: only the repository's members can comment on it now")
    .fix("ask a maintainer, writer or triage member of the repository to unlock it")
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

/// The close `--reason` / `--duplicate-of` ask for (QW-069): completed by default, as on
/// GitHub; `--duplicate-of` implies a duplicate and names another issue.
fn closed_as(
    number: u64,
    reason: Option<CloseReasonArg>,
    duplicate_of: Option<u32>,
) -> Result<ClosedAs> {
    let reason = match (reason, duplicate_of) {
        (None, Some(_)) | (Some(CloseReasonArg::Duplicate), _) => CloseReason::Duplicate,
        (Some(_), Some(_)) => {
            return Err(crate::errors::usage(
                "--duplicate-of goes only with --reason duplicate (or no --reason)",
            ))
        }
        (None | Some(CloseReasonArg::Completed), None) => CloseReason::Completed,
        (Some(CloseReasonArg::NotPlanned), None) => CloseReason::NotPlanned,
    };
    if duplicate_of.is_some_and(|d| d == 0 || u64::from(d) == number) {
        return Err(crate::errors::usage(format!(
            "issue #{number} cannot be a duplicate of #{}",
            duplicate_of.unwrap_or_default()
        )));
    }
    Ok(ClosedAs {
        reason,
        duplicate_of,
    })
}

/// A close reason in words: "completed", "not planned", "duplicate".
fn close_reason_word(reason: CloseReason) -> &'static str {
    match reason {
        CloseReason::Completed => "completed",
        CloseReason::NotPlanned => "not planned",
        CloseReason::Duplicate => "duplicate",
    }
}

/// How the timeline says why an issue was closed (the web's `closeReasonPhrase`).
fn closed_phrase(closed: &ClosedAs) -> String {
    match (closed.reason, closed.duplicate_of) {
        (CloseReason::Duplicate, Some(n)) => format!("closed this as a duplicate of #{n}"),
        (CloseReason::Duplicate, None) => "closed this as a duplicate".to_string(),
        (r, _) => format!("closed this as {}", close_reason_word(r)),
    }
}

/// A transition's line in an issue timeline: an issue close says why when it recorded it.
fn transition_line(t: &Transition, number: u32) -> String {
    close_reason_of(t, number).map_or_else(
        || transition_phrase(t.kind).to_string(),
        |c| closed_phrase(&c),
    )
}

/// The `stateReason` / `duplicateOf` of `dg issue view --json` (GitHub's names).
fn close_reason_json(closed: Option<&ClosedAs>) -> (serde_json::Value, serde_json::Value) {
    (
        json!(closed.map(|c| c.reason.as_str())),
        json!(closed.and_then(|c| c.duplicate_of)),
    )
}

/// "not planned", "a duplicate of #4": a close reason after "closed as".
fn closed_words(c: &ClosedAs) -> String {
    match (c.reason, c.duplicate_of) {
        (CloseReason::Duplicate, Some(n)) => format!("a duplicate of #{n}"),
        (CloseReason::Duplicate, None) => "a duplicate".to_string(),
        (r, _) => close_reason_word(r).to_string(),
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

/// Close (`closed`: why) or reopen (`None`) issue `number`.
async fn set_open(ctx: &Ctx, repo: &str, number: u64, closed: Option<ClosedAs>) -> Result<()> {
    let close = closed.is_some();
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
    let why = closed.map_or(String::new(), |c| format!(" as {}", closed_words(&c)));
    let price = ctx.usd_price();
    ctx.confirm_or_cancel(&format!(
        "{prompt} issue #{number}{why}? (one transition, {})",
        cost_line(crate::quote::TRANSITION, price)
    ))?;
    let (change, spent) = s
        .metered(|| async {
            match &closed {
                Some(c) => collab.close_as(&s.repo, &target, c).await,
                None => {
                    collab
                        .set_state(&s.repo, &target, StateAction::Reopen, None)
                        .await
                }
            }
        })
        .await?;
    let (state_reason, duplicate_of) = close_reason_json(change.closed_as.as_ref());
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
            "stateReason": state_reason,
            "duplicateOf": duplicate_of,
            "cost": cost_json(spent, price),
        }),
        || {
            let why = change
                .closed_as
                .map_or(String::new(), |c| format!(" as {}", closed_words(&c)));
            println!(
                "✓ {done} issue #{number}{why} {} · {}",
                transition_route_text(change.route),
                cost_line(spent, price)
            );
            if closed.is_some() && change.closed_as.is_none() {
                println!(
                    "  note: this repository's contract has no close reason (transition.reason): closed without one"
                );
            }
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
    let quote: u64 = names
        .iter()
        .map(|n| crate::quote::event(n.len() as u64, false))
        .sum();
    ctx.confirm_or_cancel(&format!(
        "{} {} {} on issue #{number}? (one event each, {}; members only)",
        if add { "Add" } else { "Remove" },
        if names.len() == 1 { "label" } else { "labels" },
        names.join(", "),
        cost_line(quote, ctx.usd_price())
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
    // An assignee is the event's `value` and its `refId` (the `addressee` index).
    let quote = ids.len() as u64 * crate::quote::event(44, true);
    ctx.confirm_or_cancel(&format!(
        "{} {} on issue #{number}? (one event each, {}; members only)",
        if add { "Assign" } else { "Unassign" },
        ids.join(", "),
        cost_line(quote, ctx.usd_price())
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
        changes, close_reason_json, closed_as, closed_words, event_phrase, label_args, open_words,
        state_word, timeline, title_matches, transition_line, CloseReason, CloseReasonArg,
        ClosedAs, Item,
    };
    use serde_json::json;

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
            diff_hunk: None,
            audience: forge_core::rules::v2::Audience::Public,
        }
    }

    /// QW-069: `--reason` / `--duplicate-of` as `gh issue close` takes them, and the timeline's
    /// words for a close that says why.
    #[test]
    fn close_reasons_read_as_gh_and_the_web_say_them() {
        let dup = |n| ClosedAs {
            reason: CloseReason::Duplicate,
            duplicate_of: n,
        };
        assert_eq!(
            closed_as(3, None, None).unwrap(),
            ClosedAs {
                reason: CloseReason::Completed,
                duplicate_of: None
            }
        );
        assert_eq!(
            closed_as(3, Some(CloseReasonArg::NotPlanned), None)
                .unwrap()
                .reason,
            CloseReason::NotPlanned
        );
        assert_eq!(closed_as(3, None, Some(1)).unwrap(), dup(Some(1)));
        assert_eq!(
            closed_as(3, Some(CloseReasonArg::Duplicate), None).unwrap(),
            dup(None)
        );
        assert!(closed_as(3, Some(CloseReasonArg::NotPlanned), Some(1)).is_err());
        assert!(
            closed_as(3, None, Some(3)).is_err(),
            "not a duplicate of itself"
        );
        let t = |reason, dup| Transition {
            id: "t".into(),
            kind: 1,
            actor: "M".into(),
            oid: None,
            as_author: 0,
            created_at: 1,
            reason,
            dup_number: dup,
        };
        assert_eq!(
            transition_line(&t(Some(3), Some(1)), 3),
            "closed this as a duplicate of #1"
        );
        assert_eq!(
            transition_line(&t(Some(2), None), 3),
            "closed this as not planned"
        );
        assert_eq!(transition_line(&t(None, None), 3), "closed this");
        assert_eq!(closed_words(&dup(Some(1))), "a duplicate of #1");
        let (reason, of) = close_reason_json(Some(&dup(Some(1))));
        assert_eq!((reason, of), (json!("duplicate"), json!(1)));
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
            reason: None,
            dup_number: None,
        };
        let transitions = [transition("t3", 30, 1), transition("t4", 40, 2)];
        let comments = [comment("c2", 20)];
        let order: Vec<String> = timeline(&comments, &events, &transitions, &[])
            .iter()
            .map(|i| match i {
                Item::Comment(c) => c.document_id.clone(),
                Item::Placeholder(m) => m.document_id.clone(),
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
