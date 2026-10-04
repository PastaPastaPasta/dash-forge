//! PR state commands: `edit` (P5), `sync` (R14, C6), `ready` / `draft` (P6, C7), `resolve` /
//! `unresolve` (R7, C8), `request-review` (R9, C9), `dismiss-review` (R11, C10), `checks`
//! (P3, C4), `commits` (P2, C5). `ready` / `draft` are one `transition` each (a member's, or
//! the author's), through `Collab::set_state`; the review kinds are one `event` (a member) or
//! `authorEvent` (the PR author, for the author kinds), through `Collab::post_target_event`.
//! Both refuse before signing what consensus would refuse (E601, E604).

use anyhow::{Context, Result};
use serde_json::json;

use forge_core::collab::v2::{kind_route, Collab, EventPayload, PatchView, StateRoute};
use forge_core::rules::v2::StateAction;
use forge_core::rules::EventKind;
use forge_core::scope::RepoRef as Repo;
use forge_core::user_error::{codes, UserError};

use super::{estimate, event_estimate, open_pr, open_pr_read, Est, Pr};
use crate::common::{resolve_identity, Session};
use crate::context::Ctx;
use crate::fmt::{cost_json, cost_line, route_text, safe, short, transition_route_text};
use crate::git;

/// The route an event of `kind` by the signer takes, or E601 before anything is signed.
async fn route_for(
    collab: &Collab<'_>,
    repo: &Repo,
    view: &PatchView,
    kind: EventKind,
) -> Result<StateRoute> {
    let me = collab.signer_id()?;
    let role = collab.signer_role(repo).await?;
    if let Some(r) = kind_route(role, &me, &view.patch.target(), kind) {
        return Ok(r);
    }
    // `post_target_event` refuses the same way; asking here keeps the confirmation prompt
    // from offering a write that cannot land.
    Err(forge_core::collab::v2::kind_refusal(
        role,
        repo,
        &view.patch.target(),
        kind,
        format!("{} pull request #{}", verb(kind), view.patch.number),
    )
    .into())
}

fn verb(kind: EventKind) -> &'static str {
    match kind {
        EventKind::ThreadResolve => "resolve a conversation on",
        EventKind::ThreadUnresolve => "unresolve a conversation on",
        EventKind::ReviewRequest => "request a review on",
        EventKind::ReviewRequestRemove => "remove a review request on",
        EventKind::ReviewDismiss => "dismiss a review on",
        EventKind::HeadUpdate => "move the head of",
        _ => "change",
    }
}

/// Confirm and post one event of `kind` on the PR; returns its route, its id and what it paid.
async fn post(
    ctx: &Ctx,
    pr: &Pr,
    kind: EventKind,
    payload: &EventPayload<'_>,
    what: &str,
) -> Result<(StateRoute, String, u64)> {
    let collab = pr.s.collab();
    let route = route_for(&collab, &pr.s.repo, &pr.view, kind).await?;
    // An event naming a reviewer, a thread or a review in `refId` also writes its `addressee`
    // index entry (QW4-039: a review request and a resolve were quoted ~20M under).
    let addressee = payload.ref_id.map_or(0, |_| crate::quote::ADDRESSEE_EXTRA);
    let est = event_estimate(route, payload.value.map_or(0, str::len)) + addressee;
    ctx.confirm_or_cancel(&format!(
        "{what}? (one {}, {})",
        match route {
            StateRoute::Member => "event",
            StateRoute::Author => "authorEvent",
        },
        cost_line(est, ctx.usd_price())
    ))?;
    let target = pr.view.patch.target();
    let ((route, id), spent) =
        pr.s.metered(|| collab.post_target_event(&pr.s.repo, &target, kind, payload))
            .await?;
    Ok((route, id, spent))
}

/// Print a no-op and emit its JSON.
fn unchanged(ctx: &Ctx, status: &str, number: u64, text: &str, extra: serde_json::Value) {
    let mut body = json!({ "status": status, "pr": number, "written": false });
    if let (Some(b), serde_json::Value::Object(e)) = (body.as_object_mut(), extra) {
        b.extend(e);
    }
    ctx.emit(body, || println!("{text}; nothing written"));
}

// ---------------------------------------------------------------------------
// edit
// ---------------------------------------------------------------------------

/// `dg pr edit`: replace the PR document's title and/or body (the author only).
pub async fn edit(
    ctx: &Ctx,
    repo: &str,
    number: u64,
    title: Option<&str>,
    body: Option<&str>,
    body_file: Option<&std::path::Path>,
) -> Result<()> {
    let body = match (body, body_file) {
        (Some(b), _) => Some(b.to_string()),
        (None, Some(p)) => Some(super::inline::read_body_file(p)?),
        (None, None) => None,
    };
    if title.is_none() && body.is_none() {
        return Err(crate::errors::usage("pass --title, --body or --body-file"));
    }
    let pr = open_pr(ctx, repo, number, "pull request not edited").await?;
    let patch = &pr.view.patch;
    // only the author may edit: refused before a long body's artifact is paid for
    pr.s.collab()
        .require_author(&patch.author, &format!("edit PR #{number}"))?;
    let field = forge_core::collab::long_body::BodyField::Patch {
        title: title.unwrap_or(&patch.title),
        base_ref_name: &patch.base_ref_name,
        source_ref_name: patch.source_ref_name.as_deref().unwrap_or_default(),
    };
    let planned = body
        .as_deref()
        .map(|b| crate::long_body::Planned::new(&pr.s.repo, field, patch.imported.as_ref(), b))
        .transpose()?;
    let changed = title.map_or(0, str::len) as u64
        + planned
            .as_ref()
            .map_or(0, crate::long_body::Planned::field_bytes);
    let est = estimate(Est::Replace, usize::try_from(changed).unwrap_or(usize::MAX))
        + planned.as_ref().map_or(0, |p| p.extra_credits(&pr.s.repo));
    let stored = planned
        .as_ref()
        .map_or_else(String::new, crate::long_body::Planned::clause);
    // a private PR is re-sealed under the epoch it was opened with (private-repos.md §4.5)
    let old_epoch = match pr
        .s
        .collab()
        .pr_edit_epochs(&pr.s.repo, &pr.view.patch.document_id)
        .await?
    {
        Some((pr_epoch, now)) => format!(
            "; note: this PR is sealed under key epoch {pr_epoch} (the repo is at {now}), so the edited text stays readable to anyone who held epoch {pr_epoch}'s key, including members removed since, and if you stop being a member the edit can make the PR unreadable to everyone (private-repos.md §4.5)"
        ),
        None => String::new(),
    };
    ctx.confirm_or_cancel(&format!(
        "Edit PR #{number}? (one document replace, {}{stored}{old_epoch})",
        cost_line(est, ctx.usd_price())
    ))?;
    let collab = pr.s.collab();
    let body = match &planned {
        Some(p) => Some(
            p.field_text(&collab, &pr.s.repo, patch.imported.as_ref())
                .await?,
        ),
        // a longer title leaves a private long body less room: its prefix is cut again
        None => {
            crate::long_body::refit_kept(&pr.s.repo, field, patch.imported.as_ref(), &patch.body)
        }
    };
    let landed = collab
        .update_target(&pr.s.repo, &patch.target(), title, body.as_deref())
        .await?;
    ctx.emit(
        json!({
            "status": if landed { "edited" } else { "unchanged" },
            "pr": number,
            "written": landed,
            "title": title.unwrap_or(&pr.view.patch.title),
            "bodyChanged": planned.is_some(),
        }),
        || {
            if landed {
                println!("✓ edited PR #{number}");
            } else {
                println!("PR #{number} already reads that way; nothing written");
            }
        },
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// sync
// ---------------------------------------------------------------------------

/// Where the PR's source branch points now, or E102.
async fn source_tip(s: &Session, view: &PatchView, number: u64) -> Result<(Repo, String, String)> {
    let Some(branch) = view.patch.source_ref_name.clone() else {
        return Err(
            UserError::new(codes::USAGE, format!("PR #{number} names no source branch"))
                .fix("pass the new head: `dg pr sync <repo> <n> --head <commit>`")
                .into(),
        );
    };
    let source = forge_core::resolve::resolve_id(&s.client, &view.patch.source_repo_id)
        .await
        .context("resolving the PR's source repository")?;
    let svc = forge_core::repo::RepoService::new(&s.client, &s.identity, &s.bridge);
    let refs = svc.read_refs(&source).await?;
    let tip = refs
        .iter()
        .find(|(n, _)| *n == branch)
        .and_then(|(_, st)| forge_core::rules::tip_of(st))
        .ok_or_else(|| {
            crate::errors::not_found(
                format!("{} is no longer in {}", safe(&branch), source.display()),
                "the branch was deleted; push it again, or pass --head <commit>",
            )
        })?;
    Ok((source, branch, tip))
}

/// `dg pr sync`: post a `headUpdate` when the source branch (or `--head`) is not the PR head.
pub async fn sync(ctx: &Ctx, repo: &str, number: u64, head: Option<&str>) -> Result<()> {
    let pr = open_pr(ctx, repo, number, "pull request head not moved").await?;
    if !pr.view.state.open {
        return Err(UserError::new(
            codes::USAGE,
            format!("PR #{number} is {}", super::state_label(&pr.view)),
        )
        .fix("reopen it first: `dg pr reopen`")
        .note("nothing was written")
        .into());
    }
    let (new_head, from) = if let Some(h) = head {
        let h = h.to_ascii_lowercase();
        if !git::is_oid(&h) {
            return Err(crate::errors::usage("--head must be a full hex commit id"));
        }
        (h, "--head".to_string())
    } else {
        let (source, branch, tip) = source_tip(&pr.s, &pr.view, number).await?;
        (tip, format!("{} in {}", safe(&branch), source.display()))
    };
    if new_head.eq_ignore_ascii_case(&pr.view.head) {
        unchanged(
            ctx,
            "in_sync",
            number,
            &format!("PR #{number} is already at {} ({from})", short(&new_head)),
            json!({ "headOid": pr.view.head }),
        );
        return Ok(());
    }
    let oid = hex::decode(&new_head).context("head oid")?;
    let (route, id, spent) = post(
        ctx,
        &pr,
        EventKind::HeadUpdate,
        &EventPayload {
            oid: Some(&oid),
            ..EventPayload::default()
        },
        &format!(
            "Move PR #{number}'s head {} → {}",
            short(&pr.view.head),
            short(&new_head)
        ),
    )
    .await?;
    ctx.emit(
        json!({
            "status": "synced",
            "pr": number,
            "written": true,
            "previousHead": pr.view.head,
            "headOid": new_head,
            "via": route,
            "eventId": id,
            "cost": cost_json(spent, ctx.usd_price()),
        }),
        || {
            println!(
                "✓ PR #{number} head {} → {} {} · {}",
                short(&pr.view.head),
                short(&new_head),
                route_text(route),
                cost_line(spent, ctx.usd_price())
            );
        },
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// ready / draft
// ---------------------------------------------------------------------------

/// `dg pr ready` / `dg pr draft`: one transition (kind 14 draft, 15 ready; a closed PR takes
/// neither: reopen it first), by a member or the PR's author.
pub async fn set_draft(ctx: &Ctx, repo: &str, number: u64, draft: bool) -> Result<()> {
    let pr = open_pr(ctx, repo, number, "pull request state not changed").await?;
    let (action, word) = if draft {
        (StateAction::Draft, "a draft")
    } else {
        (StateAction::Ready, "ready for review")
    };
    if pr.view.state.draft == draft {
        unchanged(
            ctx,
            if draft { "draft" } else { "ready" },
            number,
            &format!("PR #{number} is already {word}"),
            json!({ "draft": draft }),
        );
        return Ok(());
    }
    let collab = pr.s.collab();
    let target = pr.view.patch.target();
    // A transition, whoever writes it (QW-043: it was quoted as an event, under its charge).
    let est = crate::quote::TRANSITION;
    ctx.confirm_or_cancel(&format!(
        "Mark PR #{number} {word}? (one transition, {})",
        cost_line(est, ctx.usd_price())
    ))?;
    let (change, spent) =
        pr.s.metered(|| collab.set_state(&pr.s.repo, &target, action, None))
            .await?;
    let price = ctx.usd_price();
    ctx.emit(
        json!({
            "status": if draft { "draft" } else { "ready" },
            "pr": number,
            "written": true,
            "draft": draft,
            "via": change.route,
            "transitionId": change.transition_id,
            "kind": change.kind,
            "cost": cost_json(spent, price),
        }),
        || {
            println!(
                "✓ PR #{number} is {word} {} · {}",
                transition_route_text(change.route),
                cost_line(spent, price)
            );
        },
    );
    Ok(())
}

/// `dg pr lock` (`--off`: unlock): a lock transition (kinds 18 / 19, members only). On a
/// locked PR only members can comment or review (`lockGate`).
pub async fn set_locked(ctx: &Ctx, repo: &str, number: u64, lock: bool) -> Result<()> {
    let pr = open_pr(ctx, repo, number, "lock not changed").await?;
    let (verb, done) = if lock {
        ("Lock", "locked")
    } else {
        ("Unlock", "unlocked")
    };
    if pr.view.log.locked() == lock {
        unchanged(
            ctx,
            done,
            number,
            &format!("PR #{number} is already {done}"),
            json!({ "locked": lock }),
        );
        return Ok(());
    }
    ctx.confirm_or_cancel(&format!(
        "{verb} the conversation of PR #{number}? (one transition, {}; maintainers, writers and triage members)",
        cost_line(crate::quote::TRANSITION, ctx.usd_price())
    ))?;
    let collab = pr.s.collab();
    let target = pr.view.patch.target();
    let (id, spent) =
        pr.s.metered(|| collab.set_locked(&pr.s.repo, &target, lock))
            .await?;
    let price = ctx.usd_price();
    ctx.emit(
        json!({ "status": done, "pr": number, "locked": lock, "transitionId": id, "cost": cost_json(spent, price) }),
        || println!("✓ {done} PR #{number} · {}", cost_line(spent, price)),
    );
    Ok(())
}

/// `dg pr hide`: hide (`on`) or unhide a comment or review (`item`: its kind and id) of PR
/// `number`, or with none the PR itself (RC2 MOD: one member event, kind 24 or 25).
/// Maintainers only, refused before signing for anyone else; nothing is deleted.
pub async fn hide(
    ctx: &Ctx,
    repo: &str,
    number: u64,
    item: Option<(&str, &str)>,
    reason: Option<&str>,
    on: bool,
) -> Result<()> {
    if let Some((what, id)) = item {
        crate::common::document_id_arg(
            id,
            &format!("{what} id"),
            "`dg pr view <repo> <n> --comments --json`",
        )?;
    }
    let pr = open_pr(ctx, repo, number, "nothing hidden").await?;
    let what = item.map_or_else(
        || format!("PR #{number}"),
        |(kind, id)| format!("{kind} {id} on PR #{number}"),
    );
    let (verb, done) = if on {
        ("Hide", "hid")
    } else {
        ("Unhide", "unhid")
    };
    let review_note = if on && item.is_some_and(|(k, _)| k == "review") {
        "; its verdict still counts unless dismissed"
    } else {
        ""
    };
    // The hidden item is the event's `refId`; the 32-byte `asMaintainer` proof rides along.
    let price = ctx.usd_price();
    let quote = crate::quote::event(reason.map_or(0, str::len) as u64 + 32, item.is_some());
    ctx.confirm_or_cancel(&format!(
        "{verb} {what}? (one event, {}; maintainers only; nothing is deleted{review_note})",
        cost_line(quote, price)
    ))?;
    let target = pr.view.patch.target();
    let collab = pr.s.collab();
    let (id, spent) =
        pr.s.metered(|| collab.set_hidden(&pr.s.repo, &target, item.map(|(_, id)| id), reason, on))
            .await?;
    ctx.emit(
        json!({
            "status": if on { "hidden" } else { "unhidden" },
            "pr": number,
            "item": item.map(|(_, id)| id),
            "reason": reason,
            "eventId": id,
            "cost": cost_json(spent, price),
        }),
        || println!("✓ {done} {what} · {}", cost_line(spent, price)),
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// resolve / unresolve
// ---------------------------------------------------------------------------

/// `dg pr resolve` / `unresolve`: the event names the thread's root comment.
pub async fn resolve(
    ctx: &Ctx,
    repo: &str,
    number: u64,
    comment_id: &str,
    resolve: bool,
) -> Result<()> {
    let pr = open_pr(ctx, repo, number, "conversation not changed").await?;
    let comments =
        pr.s.collab()
            .comments(&pr.s.repo, &pr.view.patch.document_id)
            .await?;
    let Some(root) = super::threads::root_id(&comments, comment_id) else {
        return Err(crate::errors::not_found(
            format!("comment {comment_id} is not on PR #{number}"),
            format!("`dg pr view {repo} {number} --comments` lists the threads and their ids"),
        ));
    };
    let state = pr.view.review_with_threads(&comments);
    let is_resolved = state.resolved_threads.contains(&root);
    let word = if resolve { "resolved" } else { "unresolved" };
    if is_resolved == resolve {
        unchanged(
            ctx,
            word,
            number,
            &format!("the conversation {} is already {word}", short(&root)),
            json!({ "threadId": root, "resolved": resolve }),
        );
        return Ok(());
    }
    let kind = if resolve {
        EventKind::ThreadResolve
    } else {
        EventKind::ThreadUnresolve
    };
    let (route, id, spent) = post(
        ctx,
        &pr,
        kind,
        &EventPayload {
            ref_id: Some(&root),
            ..EventPayload::default()
        },
        &format!(
            "{} the conversation {} on PR #{number}",
            if resolve { "Resolve" } else { "Unresolve" },
            short(&root)
        ),
    )
    .await?;
    ctx.emit(
        json!({
            "status": word,
            "pr": number,
            "written": true,
            "threadId": root,
            "resolved": resolve,
            "via": route,
            "eventId": id,
            "cost": cost_json(spent, ctx.usd_price()),
        }),
        || {
            println!(
                "✓ {word} the conversation {} {} · {}",
                short(&root),
                route_text(route),
                cost_line(spent, ctx.usd_price())
            );
        },
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// request-review / unrequest
// ---------------------------------------------------------------------------

/// `dg pr request-review` (`add`) / `unrequest-review`.
pub async fn request_review(
    ctx: &Ctx,
    repo: &str,
    number: u64,
    reviewers: &[String],
    add: bool,
) -> Result<()> {
    let pr = open_pr(ctx, repo, number, "review request not changed").await?;
    let collab = pr.s.collab();
    let reviews = collab
        .reviews(&pr.s.repo, &pr.view.patch.document_id)
        .await?;
    let mut results = Vec::new();
    let (kind, word) = if add {
        (EventKind::ReviewRequest, "requested")
    } else {
        (EventKind::ReviewRequestRemove, "removed")
    };
    for who in reviewers {
        let id = resolve_identity(&pr.s.client, who, "reviewer").await?;
        let standing = pr
            .view
            .review
            .requested_reviewers
            .iter()
            .find(|r| r.identity == id)
            .map(|r| r.requested_at);
        let reviewed_since = |at: u64| {
            reviews
                .iter()
                .any(|r| r.reviewer == id && r.created_at > at)
        };
        // Adding: a standing request with no review since is already there; after a review it
        // is a re-request. Removing: only a standing request can be removed.
        let skip = match (add, standing) {
            (true, Some(at)) => !reviewed_since(at),
            (false, None) => true,
            _ => false,
        };
        if skip {
            results.push(json!({ "reviewer": id, "input": who, "written": false,
                "status": if add { "already_requested" } else { "not_requested" } }));
            if !ctx.json {
                println!(
                    "{id}: {}; nothing written",
                    if add {
                        "already requested"
                    } else {
                        "not requested"
                    }
                );
            }
            continue;
        }
        let re = add && standing.is_some();
        let (route, ev, spent) = post(
            ctx,
            &pr,
            kind,
            &EventPayload {
                ref_id: Some(&id),
                ..EventPayload::default()
            },
            &format!(
                "{} a review from {id} on PR #{number}",
                if !add {
                    "Remove the request for"
                } else if re {
                    "Re-request"
                } else {
                    "Request"
                }
            ),
        )
        .await?;
        results.push(json!({ "reviewer": id, "input": who, "written": true,
            "status": if re { "re_requested" } else { word }, "via": route, "eventId": ev,
            "cost": cost_json(spent, ctx.usd_price()) }));
        if !ctx.json {
            println!(
                "✓ {} {id} {} · {}",
                if re { "re-requested" } else { word },
                route_text(route),
                cost_line(spent, ctx.usd_price())
            );
        }
    }
    if ctx.json {
        crate::errors::print_json(&json!({ "pr": number, "reviewers": results }));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// dismiss-review
// ---------------------------------------------------------------------------

/// `dg pr dismiss-review` (maintainers and writers).
pub async fn dismiss(
    ctx: &Ctx,
    repo: &str,
    number: u64,
    review_id: &str,
    reason: &str,
) -> Result<()> {
    let pr = open_pr(ctx, repo, number, "review not dismissed").await?;
    let reviews =
        pr.s.collab()
            .reviews(&pr.s.repo, &pr.view.patch.document_id)
            .await?;
    let Some(r) = reviews.iter().find(|r| r.document_id == review_id) else {
        return Err(crate::errors::not_found(
            format!("review {review_id} is not on PR #{number}"),
            format!("`dg pr view {repo} {number} --json` lists its reviews (`reviews[].id`)"),
        ));
    };
    if let Some(d) = pr
        .view
        .review
        .dismissed_reviews
        .iter()
        .find(|d| d.review_id == review_id)
    {
        unchanged(
            ctx,
            "already_dismissed",
            number,
            &format!("review {} is already dismissed", short(review_id)),
            json!({ "reviewId": review_id, "reason": d.reason }),
        );
        return Ok(());
    }
    let (route, id, spent) = post(
        ctx,
        &pr,
        EventKind::ReviewDismiss,
        &EventPayload {
            ref_id: Some(review_id),
            value: (!reason.is_empty()).then_some(reason),
            ..EventPayload::default()
        },
        &format!(
            "Dismiss {}'s {} review on PR #{number} (the reason is public)",
            r.reviewer,
            r.verdict.label()
        ),
    )
    .await?;
    ctx.emit(
        json!({
            "status": "dismissed",
            "pr": number,
            "written": true,
            "reviewId": review_id,
            "reviewer": r.reviewer,
            "reason": reason,
            "via": route,
            "eventId": id,
            "cost": cost_json(spent, ctx.usd_price()),
        }),
        || {
            println!(
                "✓ dismissed {}'s review {} · {}",
                r.reviewer,
                short(review_id),
                cost_line(spent, ctx.usd_price())
            );
        },
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// checks
// ---------------------------------------------------------------------------

/// `dg pr checks`: the newest run per check name on the PR head, and, on an open PR whose
/// branch policy requires checks, where each required check stands (QW4-010: a run the policy
/// pins to another source was shown and counted as the required check's pass). Like
/// `gh pr checks`, it exits 1 (E104) when a counted check or a required one fails, and 8
/// (E804) while the policy's required checks are missing or pending.
pub async fn checks(ctx: &Ctx, repo: &str, number: u64) -> Result<()> {
    let pr = open_pr_read(ctx, repo, number).await?;
    let collab = pr.s.collab();
    // Judged on an open PR only, as `dg pr view` and the web's merge box do.
    let policy = if pr.view.state.open {
        collab
            .policy(&pr.s.repo)
            .await?
            .filter(super::checks_judged)
    } else {
        None
    };
    let rules = policy
        .as_ref()
        .map(forge_core::rules::review::Policy::checks_policy);
    let (runs, state) = collab
        .head_check_report(&pr.s.repo, &pr.view.head, rules.as_ref())
        .await?;
    let pins = rules
        .as_ref()
        .map(forge_core::rules::parity::pinned_sources)
        .unwrap_or_default();
    let shown: Vec<ShownRun<'_>> = runs
        .iter()
        .map(|run| ShownRun {
            run,
            pinned_to: pinned_elsewhere(&pins, run),
        })
        .collect();
    let tally = ChecksTally::of(&shown, state.as_ref());
    let rows: Vec<serde_json::Value> = shown
        .iter()
        .map(|s| {
            let mut v = serde_json::to_value(s.run).unwrap_or_default();
            if let Some(o) = v.as_object_mut() {
                o.insert("counted".into(), json!(s.counted()));
                if let Some(to) = &s.pinned_to {
                    o.insert("notCountedPinnedTo".into(), json!(to));
                }
            }
            v
        })
        .collect();
    let body = json!({
        "pr": number,
        "headOid": pr.view.head,
        "checks": crate::fmt::with_ids(&rows),
        "passed": tally.passed,
        "failed": tally.failed,
        "pending": tally.pending,
        // The branch policy's required checks and whether they are met; `null` when it
        // requires none (or the PR is not open).
        "required": state.as_ref().map(|s| &s.required),
        "requiredMet": state.as_ref().map(|s| s.met),
    });
    let print = || print_checks(&pr.view.head, &shown, state.as_ref(), &pins, &tally);
    match tally.refusal(repo, number, state.as_ref()) {
        None => {
            ctx.emit(body, print);
            Ok(())
        }
        Some(u) => {
            if !ctx.json {
                print();
            }
            Err(crate::errors::reported(u, body))
        }
    }
}

/// One run `dg pr checks` lists, and whether the branch policy pins its check to other sources.
struct ShownRun<'a> {
    run: &'a forge_core::collab::v2::CheckRun,
    /// The sources the policy counts for this check, when the run's reporter is not one.
    pinned_to: Option<String>,
}

impl ShownRun<'_> {
    /// Whether the run counts: a current maintainer, writer or runner reported it, and the
    /// policy does not pin its check to someone else.
    fn counted(&self) -> bool {
        self.run.trusted && self.pinned_to.is_none()
    }
}

/// The sources `pins` names for `run`'s check, `" or "`-joined, when its reporter is not one.
fn pinned_elsewhere(
    pins: &std::collections::BTreeMap<&str, std::collections::BTreeSet<&str>>,
    run: &forge_core::collab::v2::CheckRun,
) -> Option<String> {
    let sources = pins.get(run.name.as_str())?;
    (!sources.contains(run.reporter.as_str()))
        .then(|| sources.iter().copied().collect::<Vec<_>>().join(" or "))
}

/// What `dg pr checks` counts: the listed runs that count, by state, and the checks behind a
/// non-zero exit.
#[derive(Debug, Default, PartialEq, Eq)]
struct ChecksTally {
    passed: usize,
    failed: usize,
    pending: usize,
    /// Failing: counted runs that failed, and required checks whose deciding run failed.
    failing: Vec<String>,
}

impl ChecksTally {
    fn of(shown: &[ShownRun<'_>], state: Option<&forge_core::rules::v2::ChecksState>) -> Self {
        use forge_core::rules::v2::{CheckState, PASSING_CONCLUSIONS};
        let mut t = Self::default();
        let mut failing_names: Vec<&str> = Vec::new();
        for s in shown.iter().filter(|s| s.counted()) {
            if s.run.status != "completed" {
                t.pending += 1;
            } else if PASSING_CONCLUSIONS.contains(&s.run.conclusion.as_str()) {
                t.passed += 1;
            } else {
                t.failed += 1;
                failing_names.push(&s.run.name);
                t.failing
                    .push(format!("{} {}", s.run.name, s.run.conclusion));
            }
        }
        for r in state
            .into_iter()
            .flat_map(|s| &s.required)
            .filter(|r| r.state == CheckState::Failing)
        {
            if !failing_names.contains(&r.name.as_str()) {
                // Decided by a run not listed (an older one from the pinned source).
                t.failed += 1;
                t.failing.push(format!("{} failing (required)", r.name));
            }
        }
        t
    }

    /// E104 (exit 1) when a check fails; else E804 (exit 8) while the required checks are not
    /// met (missing or pending); `None` otherwise. `gh pr checks` exits 1 and 8 the same way.
    fn refusal(
        &self,
        repo: &str,
        number: u64,
        state: Option<&forge_core::rules::v2::ChecksState>,
    ) -> Option<UserError> {
        use forge_core::rules::v2::CheckState;
        let unmet: Vec<String> = state
            .into_iter()
            .flat_map(|s| &s.required)
            .filter(|r| matches!(r.state, CheckState::Missing | CheckState::Pending))
            .map(|r| format!("{} {}", r.name, super::check_word(r.state)))
            .collect();
        if !self.failing.is_empty() {
            let mut cause = format!("failing: {}", self.failing.join(", "));
            if !unmet.is_empty() {
                cause = format!(
                    "{cause}; required and not passing yet: {}",
                    unmet.join(", ")
                );
            }
            return Some(
                UserError::new(
                    codes::CHECKS_FAILED,
                    format!("checks failed on PR #{number} of {repo}"),
                )
                .cause(cause)
                .fix("open each failing run's details link (`dg ci status` lists them); a new run your CI reports replaces the one shown"),
            );
        }
        let state = state.filter(|s| !s.met)?;
        let cause = if state.required.is_empty() {
            "the branch policy requires checks, and no member or runner reported any on the head"
                .to_string()
        } else {
            format!("required checks not passing yet: {}", unmet.join(", "))
        };
        Some(
            UserError::new(
                codes::POLICY_NOT_MET,
                format!("PR #{number} of {repo} does not meet the branch policy's required checks yet"),
            )
            .cause(cause)
            .fix(format!("wait for the required checks from the sources the policy names (`dg repo policy show {repo}` lists them)"))
            .fix("a maintainer can merge anyway with `dg pr merge --override-policy` (recorded on the PR)"),
        )
    }
}

/// `dg pr checks`' human output: the listed runs, then each required check no listed run
/// decides (missing, or decided by an older run from the source the policy pins).
fn print_checks(
    head: &str,
    shown: &[ShownRun<'_>],
    state: Option<&forge_core::rules::v2::ChecksState>,
    pins: &std::collections::BTreeMap<&str, std::collections::BTreeSet<&str>>,
    tally: &ChecksTally,
) {
    use forge_core::rules::v2::CheckState;
    let required = state.map_or(&[][..], |s| s.required.as_slice());
    if shown.is_empty() && required.is_empty() {
        println!("no checks reported for {}", short(head));
        return;
    }
    let ChecksTally {
        passed,
        failed,
        pending,
        ..
    } = tally;
    println!(
        "checks on {}: {passed} passed, {failed} failing, {pending} pending",
        short(head)
    );
    for s in shown {
        let r = s.run;
        let state = if r.status == "completed" {
            r.conclusion.as_str()
        } else {
            r.status.as_str()
        };
        let mark = if s.counted() {
            match state {
                "success" => "✓",
                "neutral" | "skipped" => "-",
                "queued" | "in_progress" => "…",
                _ => "✗",
            }
        } else {
            " "
        };
        let note = if !r.trusted {
            "  (reporter is no longer a member: not counted)".to_string()
        } else if let Some(to) = &s.pinned_to {
            format!("  (not counted: the branch policy counts only runs by {to})")
        } else {
            String::new()
        };
        println!(
            "  {mark} {:<24} {state}{}{note}",
            safe(&r.name),
            if r.details_url.is_empty() {
                String::new()
            } else {
                format!("  {}", safe(&r.details_url))
            },
        );
    }
    let listed = |id: &Option<String>| {
        id.as_ref().is_some_and(|id| {
            shown
                .iter()
                .any(|s| s.counted() && &s.run.document_id == id)
        })
    };
    for c in required.iter().filter(|c| !listed(&c.run_id)) {
        let from = pins
            .get(c.name.as_str())
            .map(|s| {
                format!(
                    " from {}",
                    s.iter().copied().collect::<Vec<_>>().join(" or ")
                )
            })
            .unwrap_or_default();
        let (mark, word) = match c.state {
            CheckState::Missing => ("?", "expected"),
            CheckState::Passed => ("✓", "passed"),
            CheckState::Failing => ("✗", "failing"),
            CheckState::Pending => ("…", "pending"),
        };
        println!("  {mark} {:<24} {word} (required{from})", safe(&c.name));
    }
}

// ---------------------------------------------------------------------------
// commits
// ---------------------------------------------------------------------------

/// `dg pr commits`: the commits in `base..head`, newest first, from a scratch clone.
pub async fn commits(ctx: &Ctx, repo: &str, number: u64, limit: usize) -> Result<()> {
    let Pr { s, view } = open_pr_read(ctx, repo, number).await?;
    let scratch = super::scratch_with_pr(ctx, &s.repo, &view)?;
    let dir = scratch.path();
    let range = match &view.base_tip {
        // The commits the PR adds: reachable from the head, not from the base.
        Some(b) => format!("{b}..{}", view.head),
        None => view.head.clone(),
    };
    let max = format!("--max-count={}", limit.max(1));
    let out = git::git(
        dir,
        &[
            "log",
            &max,
            "--format=%H%x1f%an%x1f%ae%x1f%aI%x1f%s",
            &range,
            "--",
        ],
        &[],
    )?;
    let total: usize = git::git(dir, &["rev-list", "--count", &range, "--"], &[])?
        .trim()
        .parse()
        .unwrap_or(0);
    let rows: Vec<serde_json::Value> = out
        .lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.split('\u{1f}').collect();
            (f.len() == 5).then(|| {
                json!({ "oid": f[0], "author": f[1], "email": f[2], "date": f[3], "subject": f[4] })
            })
        })
        .collect();
    ctx.emit(
        json!({
            "pr": number,
            "baseOid": view.base_tip,
            "headOid": view.head,
            "total": total,
            "truncated": total > rows.len(),
            "commits": rows,
        }),
        || {
            println!(
                "{total} commit{} on {} not in {}",
                if total == 1 { "" } else { "s" },
                short(&view.head),
                view.patch.base_ref_name
            );
            for r in &rows {
                println!(
                    "  {}  {}  {}",
                    short(r["oid"].as_str().unwrap_or("")),
                    safe(r["subject"].as_str().unwrap_or("")),
                    safe(r["author"].as_str().unwrap_or(""))
                );
            }
            if total > rows.len() {
                println!("  … {} more (raise --limit)", total - rows.len());
            }
        },
    );
    Ok(())
}

#[cfg(test)]
mod checks_tests {
    use super::*;
    use forge_core::collab::v2::CheckRun;
    use forge_core::rules::v2::{CheckState, ChecksState, RequiredCheck};

    fn run(id: &str, name: &str, reporter: &str, conclusion: &str) -> CheckRun {
        CheckRun {
            document_id: id.into(),
            name: name.into(),
            status: if conclusion.is_empty() {
                "in_progress".into()
            } else {
                "completed".into()
            },
            conclusion: conclusion.into(),
            reporter: reporter.into(),
            trusted: true,
            ..CheckRun::default()
        }
    }

    fn required(name: &str, state: CheckState, run_id: Option<&str>) -> RequiredCheck {
        RequiredCheck {
            name: name.into(),
            state,
            run_id: run_id.map(Into::into),
        }
    }

    fn shown_all(runs: &[CheckRun]) -> Vec<ShownRun<'_>> {
        runs.iter()
            .map(|run| ShownRun {
                run,
                pinned_to: None,
            })
            .collect()
    }

    /// QW4-010: a writer's passing `writer-check`, which the policy pins to a maintainer, is
    /// listed but not counted, and the missing required check exits 8 (E804) as
    /// `gh pr checks` does for an expected check.
    #[test]
    fn a_run_from_a_source_the_policy_does_not_count_never_passes_the_check() {
        let pins = std::collections::BTreeMap::from([(
            "writer-check",
            std::collections::BTreeSet::from(["maint"]),
        )]);
        let runs = [run("r1", "writer-check", "writer", "success")];
        let shown: Vec<ShownRun<'_>> = runs
            .iter()
            .map(|run| ShownRun {
                run,
                pinned_to: pinned_elsewhere(&pins, run),
            })
            .collect();
        assert_eq!(shown[0].pinned_to.as_deref(), Some("maint"));
        assert!(!shown[0].counted());
        let state = ChecksState {
            required: vec![required("writer-check", CheckState::Missing, None)],
            met: false,
            untrusted: 0,
        };
        let tally = ChecksTally::of(&shown, Some(&state));
        assert_eq!((tally.passed, tally.failed, tally.pending), (0, 0, 0));
        let u = tally.refusal("a/b", 3, Some(&state)).expect("not met");
        assert_eq!((u.code, u.exit_code()), ("E804", 8));
        assert!(
            u.cause.as_deref().unwrap().contains("writer-check missing"),
            "{u:?}"
        );
        // Once the pinned source's run passes, it is met and the exit is 0.
        let state = ChecksState {
            required: vec![required("writer-check", CheckState::Passed, Some("r0"))],
            met: true,
            untrusted: 0,
        };
        assert!(ChecksTally::of(&shown, Some(&state))
            .refusal("a/b", 3, Some(&state))
            .is_none());
    }

    #[test]
    fn a_failing_check_exits_1_and_a_pending_one_without_a_policy_exits_0() {
        let runs = [
            run("r1", "ci / build", "bot", "failure"),
            run("r2", "lint", "bot", ""),
        ];
        let shown = shown_all(&runs);
        let tally = ChecksTally::of(&shown, None);
        assert_eq!((tally.passed, tally.failed, tally.pending), (0, 1, 1));
        let u = tally.refusal("a/b", 3, None).expect("failing");
        assert_eq!((u.code, u.exit_code()), ("E104", 1));
        assert!(u.cause.as_deref().unwrap().contains("ci / build failure"));

        // A required check failing is named once, whether or not its run is listed.
        let state = ChecksState {
            required: vec![
                required("ci / build", CheckState::Failing, Some("r1")),
                required("deploy", CheckState::Failing, Some("r9")),
            ],
            met: false,
            untrusted: 0,
        };
        let tally = ChecksTally::of(&shown, Some(&state));
        assert_eq!(
            tally.failing,
            ["ci / build failure", "deploy failing (required)"]
        );
        // The header counts the required check decided by an unlisted run too.
        assert_eq!(tally.failed, 2);

        let pending_only = [run("r2", "lint", "bot", "")];
        let shown = shown_all(&pending_only);
        assert!(ChecksTally::of(&shown, None)
            .refusal("a/b", 3, None)
            .is_none());
    }
}
