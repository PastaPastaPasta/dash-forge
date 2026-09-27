//! `dg pr` — pull requests on forge-v2.
//!
//! * `create` opens a `patch` in the target repo pointing at the repo that holds the head
//!   commit (`sourceRepoId`): the target itself, or a fork. With no flags it uses the
//!   current branch, and finds where it lives: the signer's fork of the target when one
//!   exists (`forkOf`), else the target.
//! * `list` / `view` fold the PR's `event` + `authorEvent` log (§3) and count approvals from
//!   members' reviews on the current head (§6).
//! * `review` posts a `review` on the current head.
//! * `merge` does the merge locally, in a throwaway repository: fetch base and head over
//!   `dash://`, fast-forward or build a clean merge commit (`git merge-tree`), push it to the
//!   base branch (the helper routes a protected branch to `protectedRefUpdate`, which needs a
//!   maintainer), then post the `merge` event. Each step is reported; a failure names what
//!   already happened. `--event-only` just posts the event.
//! * `checkout` / `diff` fetch the head from the source repo (`dash://<repoId>`).

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde_json::json;

use forge_core::collab::v2::{approvals_over, Collab, Patch, PatchInput, PatchView};
use forge_core::collab::Verdict;
use forge_core::create::default_journal_dir;
use forge_core::rules::v2::Role;
use forge_core::rules::{EventKind, RefState};
use forge_core::scope::RepoRef as Repo;
use forge_core::user_error::{codes, UserError};

use crate::common::{number_arg, resolve, RepoRef, Session};
use crate::context::Ctx;
use crate::fmt::{cost_json, cost_line, dash_usd_price, route_text, safe, short};
use crate::git::{self, MergePlan};
use crate::{PrCommand, VerdictArg};

/// Dispatch a `pr` subcommand.
pub async fn run(ctx: &Ctx, cmd: &PrCommand) -> Result<()> {
    match cmd {
        PrCommand::Create(args) => create(ctx, args).await,
        PrCommand::List { repo, limit, state } => list(ctx, repo, *limit, *state).await,
        PrCommand::View { repo, number } => view(ctx, repo, *number).await,
        PrCommand::Checkout { repo, number } => checkout(ctx, repo, *number).await,
        PrCommand::Review {
            repo,
            number,
            verdict,
            approve,
            request_changes,
            comment,
            body,
        } => {
            let v = pick_verdict(*verdict, *approve, *request_changes, *comment)?;
            review(ctx, repo, *number, v, body).await
        }
        PrCommand::Merge {
            repo,
            number,
            event_only,
            merge_oid,
            override_policy,
        } => {
            Box::pin(merge(
                ctx,
                repo,
                *number,
                *event_only,
                merge_oid.as_deref(),
                *override_policy,
            ))
            .await
        }
        PrCommand::Close { repo, number } => set_open(ctx, repo, *number, true).await,
        PrCommand::Reopen { repo, number } => set_open(ctx, repo, *number, false).await,
        PrCommand::Diff { repo, number } => diff(ctx, repo, *number).await,
    }
}

/// `--verdict X` or exactly one of `--approve` / `--request-changes` / `--comment`.
fn pick_verdict(
    verdict: Option<VerdictArg>,
    approve: bool,
    request_changes: bool,
    comment: bool,
) -> Result<VerdictArg> {
    let flags: Vec<VerdictArg> = [
        (approve, VerdictArg::Approve),
        (request_changes, VerdictArg::RequestChanges),
        (comment, VerdictArg::Comment),
    ]
    .into_iter()
    .filter_map(|(on, v)| on.then_some(v))
    .chain(verdict)
    .collect();
    match flags.as_slice() {
        [one] => Ok(*one),
        _ => Err(crate::errors::usage(
            "pass exactly one of --approve, --request-changes or --comment",
        )),
    }
}

fn not_found(repo: &str, number: u64) -> anyhow::Error {
    crate::errors::not_found(
        format!("pull request #{number} not found in {repo}"),
        format!("`dg pr list {repo} --state all` lists its pull requests"),
    )
}

/// The v2 PR `number` of `handle`, or E102.
async fn patch(collab: &Collab<'_>, handle: &Repo, repo: &str, number: u64) -> Result<Patch> {
    collab
        .patch(handle, number_arg(number)?)
        .await?
        .ok_or_else(|| not_found(repo, number))
}

fn state_label(v: &PatchView) -> &'static str {
    if v.state.merged {
        "merged"
    } else if v.state.open {
        "open"
    } else {
        "closed"
    }
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

async fn create(ctx: &Ctx, args: &crate::PrCreateArgs) -> Result<()> {
    let s = Session::open_for_write(ctx, &args.repo, "pull request not created").await?;
    let handle = &s.repo;
    let forge = handle.forge();
    let cwd = std::env::current_dir().context("reading the current directory")?;

    // Where the branch may live: --head-repo, else the signer's forks of the target, then the
    // target itself. The first that has the branch is the source.
    let candidates = if let Some(r) = &args.head_repo {
        vec![resolve(&s.client, &s.identity, &RepoRef::parse(r)?).await?]
    } else {
        let mut c =
            forge_core::resolve::find_forks(&s.client, forge, handle.id(), Some(&s.identity.id()))
                .await?;
        c.push(handle.clone());
        c
    };
    let svc = forge_core::repo::RepoService::new(&s.client, &s.identity, &s.bridge);
    let PrHead {
        source,
        source_refs,
        ref_name: head_ref,
        oid: head_oid,
    } = resolve_head(args, &cwd, &svc, candidates).await?;
    // The base branch: --base, else the target's default branch. It must be a branch of the
    // target now (D-501): a merge counts only into a base that existed when the PR was opened.
    let base = if let Some(b) = &args.base {
        git::full_ref(b)
    } else {
        let d = svc
            .read_default_branch(handle)
            .await?
            .unwrap_or_else(|| "main".into());
        git::full_ref(&d)
    };
    let target_refs = if source.id() == handle.id() {
        source_refs
    } else {
        svc.read_refs(handle).await?
    };
    require_base_branch(handle, &base, &target_refs)?;
    let title = match &args.title {
        Some(t) => t.clone(),
        None => git::git(&cwd, &["log", "-1", "--format=%s", &head_oid], &[])
            .ok()
            .filter(|s| !s.is_empty())
            .ok_or_else(|| crate::errors::usage("pass --title (the head commit is not local)"))?,
    };

    let input = PatchInput {
        title: title.clone(),
        body: args.body.clone(),
        base_ref_name: base.clone(),
        source_repo_id: source.id().to_string(),
        source_ref_name: Some(head_ref.clone()),
        head_oid: hex::decode(&head_oid).context("head oid")?,
        draft: false,
        patch_manifest_hash: None,
    };
    if !ctx.json {
        println!(
            "Open PR {title:?} in {}: {} {head_ref} ({}) → {base}",
            handle.display(),
            source.display(),
            short(&head_oid)
        );
    }
    ctx.confirm_or_cancel("Open it? (one small document, ~0.0001 DASH)")?;
    let before = s.balance().await;
    let created = s
        .collab()
        .create_patch(handle, &input, &default_journal_dir()?)
        .await?;
    let spent = s.spent_since(before).await;
    let price = dash_usd_price();
    ctx.emit(
        json!({
            "status": "created",
            "number": created.number,
            "documentId": created.document_id,
            "title": title,
            "baseRef": base,
            "headRef": head_ref,
            "headOid": head_oid,
            "sourceRepoId": source.id(),
            "sourceRepo": source.display(),
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
                "✓ opened PR #{} in {}{how} · {}",
                created.number,
                handle.display(),
                cost_line(spent, price)
            );
        },
    );
    Ok(())
}

/// The PR's source repository, branch and head commit. The branch is `--head` (else the
/// current branch); the source is the first of `candidates` holding it; the head is
/// `--head-oid`, else where the branch points there now, so the PR names a commit reviewers
/// can fetch.
async fn resolve_head(
    args: &crate::PrCreateArgs,
    cwd: &Path,
    svc: &forge_core::repo::RepoService<'_>,
    candidates: Vec<Repo>,
) -> Result<PrHead> {
    let head_ref =
        match (&args.head, git::current_branch(cwd)) {
            (Some(h), _) => git::full_ref(h),
            (None, Some(b)) => git::full_ref(&b),
            (None, None) => return Err(crate::errors::usage(
                "no --head given and not on a branch: pass --head <branch> (in the source repo)",
            )),
        };
    let mut found = None;
    for repo in &candidates {
        let refs = svc.read_refs(repo).await?;
        if let Some(tip) = refs
            .iter()
            .find(|(n, _)| *n == head_ref)
            .and_then(|(_, st)| forge_core::rules::tip_of(st))
        {
            found = Some((repo.clone(), refs, tip));
            break;
        }
    }
    let Some((source, source_refs, remote_tip)) = found else {
        let first = &candidates[0];
        return Err(UserError::new(
            codes::NOT_FOUND,
            format!(
                "pull request not created: {head_ref} is not in {}",
                candidates
                    .iter()
                    .map(Repo::display)
                    .collect::<Vec<_>>()
                    .join(" or ")
            ),
        )
        .cause("the PR must name a commit reviewers can fetch from the source repository")
        .fix(format!(
            "push it first: `git push {} {head_ref}`",
            first.remote_url()
        ))
        .into());
    };
    let head_oid = match &args.head_oid {
        Some(o) => o.to_ascii_lowercase(),
        None => remote_tip.clone(),
    };
    if !git::is_oid(&head_oid) {
        return Err(crate::errors::usage(
            "--head-oid must be a full hex commit id",
        ));
    }
    if !head_oid.eq_ignore_ascii_case(&remote_tip) {
        eprintln!(
            "warning: {head_ref} in {} is at {}, not {head_oid}; the PR names {head_oid}",
            source.display(),
            short(&remote_tip)
        );
    }
    Ok(PrHead {
        source,
        source_refs,
        ref_name: head_ref,
        oid: head_oid,
    })
}

/// Where a new PR's head lives ([`resolve_head`]).
struct PrHead {
    /// The repository holding the branch.
    source: Repo,
    /// Every ref of `source`, as read to find the branch (reused to check the base when the
    /// source is the target).
    source_refs: Vec<(String, RefState)>,
    /// The branch, `refs/heads/<name>`.
    ref_name: String,
    /// The commit the PR names (hex).
    oid: String,
}

/// Refuse a PR base that is not a branch of `target` (never pushed, a typo, or deleted): a
/// merge event into it would never count (`pr_base_tips`), and `dg pr merge` would create the
/// branch (D-501). `refs` are the target's refs as `read_refs` returns them.
fn require_base_branch(target: &Repo, base: &str, refs: &[(String, RefState)]) -> Result<()> {
    git::require_branch_ref(base)?;
    let mut live = refs
        .iter()
        .filter(|(_, st)| !matches!(st, RefState::Unborn))
        .map(|(n, _)| n.as_str());
    if live.clone().any(|n| n == base) {
        return Ok(());
    }
    let mut branches: Vec<&str> = live
        .by_ref()
        .filter_map(|n| n.strip_prefix("refs/heads/"))
        .collect();
    branches.sort_unstable();
    let known = if branches.is_empty() {
        "it has no branches yet".to_string()
    } else {
        format!("its branches: {}", safe(&branches.join(", ")))
    };
    Err(UserError::new(
        codes::NOT_FOUND,
        format!(
            "pull request not created: {} is not a branch of {}",
            safe(base),
            target.display()
        ),
    )
    .cause(format!(
        "a PR merges into an existing branch, and a merge into a branch created later never counts ({known})"
    ))
    .fix("pass --base <branch> naming one of them, or push the base branch first")
    .note("nothing was written")
    .into())
}

// ---------------------------------------------------------------------------
// list / view
// ---------------------------------------------------------------------------

async fn list(ctx: &Ctx, repo: &str, limit: u32, state: crate::StateArg) -> Result<()> {
    let s = Session::open(ctx, repo).await?;
    let handle = &s.repo;
    let collab = s.collab();
    let page = collab.list_patches(handle, limit).await?;
    let (hidden, more) = (page.hidden, page.more);
    let oracle = collab.member_oracle(handle).await?;
    let mut rows = Vec::new();
    for p in page.rows {
        let v = collab.patch_view(handle, p).await?;
        if !state.matches(v.state.open) {
            continue;
        }
        let (approvals, _) = collab.approvals_with(handle, &v, &oracle).await?;
        rows.push((v, approvals));
    }
    let json_rows: Vec<_> = rows
        .iter()
        .map(|(v, a)| {
            json!({
                "number": v.patch.number,
                "title": v.patch.title,
                "author": v.patch.author,
                "state": state_label(v),
                "baseRef": v.patch.base_ref_name,
                "headOid": v.head,
                "sourceRepoId": v.patch.source_repo_id,
                "draft": v.state.draft,
                "approvals": a.approvers.len(),
                "changesRequested": a.changes_requested.len(),
            })
        })
        .collect();
    ctx.emit(
        json!({ "count": rows.len(), "prs": json_rows, "hidden": hidden, "truncated": more }),
        || {
            if rows.is_empty() {
                println!("no pull requests");
            }
            for (v, a) in &rows {
                let count = |mark: &str, n: usize| {
                    if n == 0 {
                        String::new()
                    } else {
                        format!("  {mark}{n}")
                    }
                };
                let extra = count("✓", a.approvers.len()) + &count("✗", a.changes_requested.len());
                println!(
                    "#{:<4} {:<6} {}  ({}){extra}",
                    v.patch.number,
                    state_label(v),
                    safe(&v.patch.title),
                    short(&v.head)
                );
            }
            if hidden > 0 {
                println!("{}", crate::fmt::hidden_note(handle, hidden));
            }
            if more {
                println!(
                    "(the newest pull requests only; older ones exist: raise --limit, up to 100)"
                );
            }
        },
    );
    Ok(())
}

/// A PR's reviews for `dg pr view --json`: stale when not on the current head, dismissed when
/// a `reviewDismiss` names it.
fn reviews_json(
    reviews: &[forge_core::collab::v2::Review],
    head: &str,
    dismissed: &std::collections::BTreeSet<String>,
) -> Vec<serde_json::Value> {
    reviews
        .iter()
        .map(|r| {
            json!({
                "id": r.document_id,
                "reviewer": r.reviewer,
                "verdict": r.verdict.code(),
                "verdictLabel": r.verdict.label(),
                "commitOid": r.commit_oid,
                "stale": r.commit_oid != head,
                "dismissed": dismissed.contains(&r.document_id),
                "commentCount": r.comment_count,
                "body": r.body,
                "createdAt": r.created_at,
            })
        })
        .collect()
}

/// A PR's comments for `dg pr view --json`: thread, review and anchor (`anchor_of`: null for
/// a general or malformed-anchor comment).
fn comments_json(comments: &[forge_core::collab::v2::Comment]) -> Vec<serde_json::Value> {
    comments
        .iter()
        .map(|c| {
            json!({
                "id": c.document_id,
                "author": c.author,
                "body": c.body,
                "replyTo": c.reply_to,
                "reviewId": c.review_id,
                "anchor": forge_core::rules::v2::anchor_of(&c.anchor),
            })
        })
        .collect()
}

async fn view(ctx: &Ctx, repo: &str, number: u64) -> Result<()> {
    let s = Session::open(ctx, repo).await?;
    let (client, handle) = (&s.client, &s.repo);
    let collab = s.collab();
    let p = patch(&collab, handle, repo, number).await?;
    let v = collab.patch_view(handle, p).await?;
    let doc_id = &v.patch.document_id;
    let (reviews, hidden_reviews) = collab.reviews_counted(handle, doc_id).await?;
    let approvals = approvals_over(&reviews, &v, &collab.member_oracle(handle).await?);
    let (comments, hidden_comments) = collab.comments_counted(handle, doc_id).await?;
    let review_state = v.review_with_threads(&comments);
    let dismissed = v.dismissed();
    let source = forge_core::resolve::resolve_id(client, &v.patch.source_repo_id)
        .await
        .map_or_else(|_| v.patch.source_repo_id.clone(), |r| r.display());

    let reviews_json = reviews_json(&reviews, &v.head, &dismissed);
    ctx.emit(
        json!({
            "number": v.patch.number,
            "title": v.patch.title,
            "body": v.patch.body,
            "author": v.patch.author,
            "state": state_label(&v),
            "fold": serde_json::to_value(&v.state).unwrap_or_default(),
            "baseRef": v.patch.base_ref_name,
            "baseTip": v.base_tip,
            "headOid": v.head,
            "initialHeadOid": v.patch.head_oid,
            "headOnBase": v.head_on_base,
            "review": serde_json::to_value(&review_state).unwrap_or_default(),
            "sourceRepoId": v.patch.source_repo_id,
            "sourceRepo": source,
            "sourceRefName": v.patch.source_ref_name,
            "approvedBy": approvals.approvers,
            "changesRequestedBy": approvals.changes_requested,
            "reviews": reviews_json,
            "comments": comments_json(&comments),
            "hiddenComments": hidden_comments,
            "hiddenReviews": hidden_reviews,
        }),
        || {
            println!(
                "#{} [{}] {}",
                v.patch.number,
                state_label(&v),
                safe(&v.patch.title)
            );
            println!("author: {}", v.patch.author);
            println!(
                "{} {} ({}) → {}",
                source,
                safe(v.patch.source_ref_name.as_deref().unwrap_or("(no branch)")),
                short(&v.head),
                safe(&v.patch.base_ref_name)
            );
            if v.state.draft {
                println!("draft");
            }
            if !approvals.approvers.is_empty() {
                let who: Vec<_> = approvals.approvers.iter().cloned().collect();
                println!(
                    "approved by {} on {}: {}",
                    who.len(),
                    short(&v.head),
                    who.join(", ")
                );
            }
            if !approvals.changes_requested.is_empty() {
                let who: Vec<_> = approvals.changes_requested.iter().cloned().collect();
                println!("changes requested by {}", who.join(", "));
            }
            if !v.patch.body.is_empty() {
                println!("\n{}", safe(&v.patch.body));
            }
            for r in &reviews {
                let stale = if dismissed.contains(&r.document_id) {
                    " (dismissed)"
                } else if r.commit_oid == v.head {
                    ""
                } else {
                    " (stale — new commits since)"
                };
                println!("\n{} — {}{stale}", r.verdict.label(), r.reviewer);
                if !r.body.is_empty() {
                    println!("  {}", safe(&r.body));
                }
            }
            for c in &comments {
                println!("\n— {}:\n{}", c.author, safe(&c.body));
            }
            if hidden_comments + hidden_reviews > 0 {
                println!(
                    "\n{}",
                    crate::fmt::hidden_note(handle, hidden_comments + hidden_reviews)
                );
            }
        },
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// review / close / reopen
// ---------------------------------------------------------------------------

async fn review(ctx: &Ctx, repo: &str, number: u64, verdict: VerdictArg, body: &str) -> Result<()> {
    let s = Session::open_for_write(ctx, repo, "review not posted").await?;
    let (handle, collab) = (&s.repo, s.collab());
    let p = patch(&collab, handle, repo, number).await?;
    // Review the PR's current head (the newest headUpdate), which is what approvals count on.
    let view = collab.patch_view(handle, p).await?;
    let (p, head_hex) = (&view.patch, view.head.clone());
    let v = Verdict::from_code(verdict.code());
    ctx.confirm_or_cancel(&format!(
        "Post a {} review on PR #{number} at {}? (one small document)",
        v.label(),
        short(&head_hex)
    ))?;
    let head = hex::decode(&head_hex).context("PR head oid")?;
    let id = collab
        .review(handle, &p.document_id, v, &head, body, None, None)
        .await?;
    let counts = collab.signer_role(handle).await?.is_some();
    ctx.emit(
        json!({
            "status": "reviewed",
            "pr": number,
            "verdict": verdict.code(),
            "commitOid": head_hex,
            "reviewId": id,
            "counts": counts,
        }),
        || {
            println!("✓ {} PR #{number} at {}", v.label(), short(&head_hex));
            if !counts && verdict != VerdictArg::Comment {
                println!("  note: you are not a member of {}, so this review does not count toward approvals", handle.display());
            }
        },
    );
    Ok(())
}

async fn set_open(ctx: &Ctx, repo: &str, number: u64, close: bool) -> Result<()> {
    let s = Session::open_for_write(ctx, repo, "state not changed").await?;
    let collab = s.collab();
    let p = patch(&collab, &s.repo, repo, number).await?;
    let verb = if close { "Close" } else { "Reopen" };
    ctx.confirm_or_cancel(&format!("{verb} PR #{number}? (one small document)"))?;
    let (route, id) = collab.set_open(&s.repo, &p.target(), close).await?;
    ctx.emit(
        json!({
            "status": if close { "closed" } else { "reopened" },
            "pr": number,
            "via": route,
            "eventId": id,
        }),
        || {
            println!(
                "✓ {}d PR #{number} {}",
                verb.to_lowercase(),
                route_text(route)
            );
        },
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// merge
// ---------------------------------------------------------------------------

/// One reported step of a merge.
struct Steps {
    json: bool,
    done: Vec<serde_json::Value>,
}

impl Steps {
    fn ok(&mut self, step: &str, detail: impl Into<String>) {
        let detail = detail.into();
        if !self.json {
            eprintln!("  ✓ {step:<9} {detail}");
        }
        self.done
            .push(json!({ "step": step, "ok": true, "detail": detail }));
    }
}

async fn merge(
    ctx: &Ctx,
    repo: &str,
    number: u64,
    event_only: bool,
    merge_oid: Option<&str>,
    override_policy: bool,
) -> Result<()> {
    let s = Session::open_for_write(ctx, repo, "merge").await?;
    let (handle, collab) = (&s.repo, s.collab());
    let p = patch(&collab, handle, repo, number).await?;
    let view = collab.patch_view(handle, p).await?;
    if view.state.merged {
        ctx.emit(
            json!({ "status": "already_merged", "pr": number, "merged": true }),
            || println!("PR #{number} is already merged; nothing to do"),
        );
        return Ok(());
    }
    refuse_retargeted(&view, number)?;
    refuse_missing_base(&view, number, event_only)?;
    let merge_oid = event_only
        .then(|| event_only_oid(&view, merge_oid, number))
        .transpose()?;
    let policy =
        require_merge_rights(&s, handle, &view, !event_only, None, override_policy).await?;
    let mut steps = Steps {
        json: ctx.json,
        done: Vec::new(),
    };
    if !ctx.json {
        eprintln!(
            "Merging PR #{number} of {} into {}",
            handle.display(),
            view.patch.base_ref_name
        );
    }
    ctx.confirm_or_cancel(&format!(
        "Merge PR #{number}? ({}; ~0.0003 DASH plus the pack if new objects are stored)",
        if event_only {
            "posts the merge event only"
        } else {
            "pushes to the base branch, then posts the merge event"
        }
    ))?;

    let merge_oid = if let Some(oid) = merge_oid {
        steps.ok("plan", format!("event only, naming {}", short(&oid)));
        oid
    } else {
        match push_merge(
            ctx,
            handle,
            &view,
            &s.identity.id(),
            policy.as_ref(),
            &mut steps,
        ) {
            Ok(oid) => oid,
            Err(e) => {
                return Err(crate::errors::reported(
                    merge_failure(&e, number, repo),
                    json!({ "status": "failed", "pr": number, "steps": steps.done }),
                ))
            }
        }
    };

    let event_id = post_merge_event(&collab, handle, &view, &merge_oid, event_only, repo)
        .await
        .map_err(|u| {
            crate::errors::reported(
                *u,
                json!({ "status": "pushed_no_event", "pr": number, "mergeOid": merge_oid, "steps": steps.done }),
            )
        })?;
    steps.ok("event", format!("merge event {}", short(&event_id)));

    // Re-read the fold: "merged" is what readers will say, not what we hoped. The push above
    // moved the base branch, so the ref history is read again.
    collab.refs_changed();
    let merged = match collab.patch(handle, view.patch.number).await? {
        Some(p) => collab
            .patch_view(handle, p)
            .await
            .is_ok_and(|v| v.state.merged),
        None => false,
    };
    ctx.emit(
        json!({
            "status": if merged { "merged" } else { "merge_event_posted" },
            "pr": number,
            "mergeOid": merge_oid,
            "eventId": event_id,
            "merged": merged,
            "steps": steps.done,
        }),
        || {
            if merged {
                println!("✓ merged PR #{number} ({})", short(&merge_oid));
            } else {
                println!(
                    "Posted the merge event for PR #{number}, but it does not read as merged: \
                     {} is not (yet) a tip of {}.",
                    short(&merge_oid),
                    view.patch.base_ref_name
                );
            }
        },
    );
    Ok(())
}

/// Post the `merge` event naming `merge_oid`; on failure, the user error saying what
/// already happened.
async fn post_merge_event(
    collab: &Collab<'_>,
    handle: &Repo,
    view: &PatchView,
    merge_oid: &str,
    event_only: bool,
    repo: &str,
) -> std::result::Result<String, Box<UserError>> {
    let posted = async {
        let oid = hex::decode(merge_oid).context("merge oid")?;
        Ok::<_, anyhow::Error>(
            collab
                .post_event(
                    handle,
                    &view.patch.target(),
                    EventKind::Merge,
                    None,
                    Some(&oid),
                )
                .await?,
        )
    }
    .await;
    posted.map_err(|e| {
        Box::new(
            forge_core::user_error::classify(
                e.chain(),
                &forge_core::user_error::ErrorContext {
                    goal: Some("merge event not posted"),
                    repo: Some(repo),
                    ..Default::default()
                },
            )
            .note(if event_only {
                "nothing else was written".to_string()
            } else {
                format!(
                "the base branch already holds {}; re-run with `--event-only` to record the merge",
                short(merge_oid)
            )
            }),
        )
    })
}

/// A retarget event moves the PR's base; `dg pr merge` merges only into the base the PR was
/// opened against, so it refuses rather than merge into a branch the PR no longer names.
fn refuse_retargeted(view: &PatchView, number: u64) -> Result<()> {
    let Some(retargeted) = view
        .state
        .base_ref
        .as_deref()
        .filter(|b| *b != view.patch.base_ref_name)
    else {
        return Ok(());
    };
    Err(UserError::new(
        codes::USAGE,
        format!(
            "merge not attempted: PR #{number} was retargeted to {}",
            safe(retargeted)
        ),
    )
    .cause(format!(
        "it was opened against {}, and a merge counts only into that base, so a merge into the new one would never show",
        view.patch.base_ref_name
    ))
    .fix(format!(
        "close PR #{number} and open a new one against {} (`dg pr create --base <branch>`)",
        safe(retargeted)
    ))
    .into())
}

/// `dg pr merge` merges into an existing base branch only (D-501). A base that was no branch
/// when the PR was opened has no tips (`pr_base_tips`), so no merge into it would count; and
/// pushing a merge to a base that does not exist now would create it. `--event-only` may still
/// record a merge into a base deleted since: its tips keep counting.
fn refuse_missing_base(view: &PatchView, number: u64, event_only: bool) -> Result<()> {
    let base = safe(&view.patch.base_ref_name);
    let (headline, cause) = if view.base_tips.is_empty() {
        (
            format!("{base} was not a branch when PR #{number} was opened"),
            "a merge counts only into a branch that existed when the PR was opened, so this PR can never show as merged",
        )
    } else if view.base_tip.is_none() && !event_only {
        (
            format!("the base branch {base} has been deleted"),
            "merging would push to it and re-create it",
        )
    } else {
        return Ok(());
    };
    Err(UserError::new(codes::NOT_FOUND, format!("merge not attempted: {headline}"))
        .cause(cause)
        .fix(format!(
            "close PR #{number} and open a new one against an existing branch (`dg pr create --base <branch>`)"
        ))
        .note("nothing was written")
        .into())
}

/// The commit a `--event-only` merge event names: `--merge-oid`, else the PR head. Either
/// must already have been a tip of the base branch: a merge event is permanent, and one
/// naming a commit the base never held would not count now and would flip the PR to merged
/// the day that commit is pushed.
fn event_only_oid(view: &PatchView, given: Option<&str>, number: u64) -> Result<String> {
    let oid = given.map_or_else(|| view.head.clone(), str::to_ascii_lowercase);
    if !git::is_oid(&oid) {
        return Err(crate::errors::usage(
            "--merge-oid must be a full hex commit id",
        ));
    }
    if !view.base_tips.contains(&oid) {
        return Err(UserError::new(
            codes::USAGE,
            format!(
                "merge event not posted: {} has never been a tip of {}",
                short(&oid),
                view.patch.base_ref_name
            ),
        )
        .cause("a merge event counts only for a commit the base branch has held, and it cannot be deleted")
        .fix(format!(
            "push the merge to {} first, or run `dg pr merge` without --event-only to merge PR #{number}",
            view.patch.base_ref_name
        ))
        .note("nothing was written")
        .into());
    }
    Ok(oid)
}

/// The E-coded error for a failed merge step (conflicts are E105; the rest classify).
/// The checks before any git work, all E601/E804 with nothing paid. Only members can merge
/// (the merge event is member-gated at consensus). Unless a maintainer passes
/// `override_policy`, the branch policy (a client rule every Forge client applies; consensus does
/// not enforce it) must be met: its approvals, and `method` (a merge-method bit) when known; an
/// unreadable policy fails closed for a writer. When the merge `pushes` to the base, a writer
/// cannot move a protected one (only a maintainer's `protectedRefUpdate` can). Returns the policy
/// in force (unless overridden), so the caller can check the method once the merge is planned.
async fn require_merge_rights(
    s: &Session,
    handle: &Repo,
    view: &PatchView,
    pushes: bool,
    method: Option<u8>,
    override_policy: bool,
) -> Result<Option<forge_core::rules::review::Policy>> {
    let number = u64::from(view.patch.number);
    let collab = s.collab();
    collab
        .require_role(
            handle,
            Role::Writer,
            &format!("merge pull request #{number}"),
        )
        .await?;
    // `require_role` just read it; a failure here is transient, and guessing "writer" would
    // wrongly refuse a maintainer, so surface it.
    let maintainer = collab.signer_role(handle).await? == Some(Role::Maintainer);
    if override_policy && !maintainer {
        return Err(UserError::new(
            codes::NOT_A_WRITER,
            format!(
                "merge refused: only maintainers of {} can override the branch policy",
                handle.display()
            ),
        )
        .cause("--override-policy was given by a writer")
        .fix("drop --override-policy, or ask a maintainer to merge")
        .note("checked before fetching or paying for anything; no merge event was posted")
        .into());
    }
    // The branch policy (a client rule): its approvals now; its method once the merge is planned.
    // Unreadable policy or approvals fail closed for a writer.
    let policy = if override_policy {
        None
    } else {
        let read = async {
            let Some(policy) = collab.policy(handle).await? else {
                return Ok::<_, anyhow::Error>(None);
            };
            let oracle = collab.member_oracle(handle).await?;
            let (approvals, _) = collab.approvals_with(handle, view, &oracle).await?;
            Ok(Some((
                policy.clone(),
                forge_core::rules::review::meets_policy(&approvals, &oracle, &policy),
            )))
        };
        match read.await {
            Ok(Some((policy, status))) => {
                if let Some(u) = policy_refusal(&policy, &status, method, &handle.display(), number)
                {
                    return Err(u.into());
                }
                Some(policy)
            }
            Err(e) if !maintainer => {
                return Err(UserError::new(
                    codes::POLICY_NOT_MET,
                    format!(
                        "merge refused: couldn't read the branch policy of {}",
                        handle.display()
                    ),
                )
                .cause(format!("{e:#}"))
                .fix("retry; a maintainer can merge with `--override-policy`")
                .into());
            }
            // No policy, or a maintainer (who may merge whatever it says) could not read it.
            Ok(None) | Err(_) => None,
        }
    };
    // DASH_FORGE_SKIP_WRITE_PRECHECK skips only the consensus-backed protected-branch check (so
    // consensus can be seen refusing it); the policy is a client rule nothing else enforces.
    if maintainer || !pushes || !forge_core::collab::v2::precheck_enabled() {
        return Ok(policy);
    }
    let base = view.patch.base_ref_name.as_str();
    let svc = forge_core::repo::RepoService::new(&s.client, &s.identity, &s.bridge);
    let Ok(patterns) = svc.protected_patterns(handle).await else {
        return Ok(policy);
    };
    if !forge_core::rules::matches_protected(base, &patterns) {
        return Ok(policy);
    }
    Err(UserError::new(
        codes::NOT_A_WRITER,
        format!(
            "merge failed: only maintainers of {} can update {base}",
            handle.display()
        ),
    )
    .cause("the base branch matches the repo's protected patterns, and you are a writer")
    .fix("ask a maintainer to merge it (`dg pr merge` as a maintainer)")
    .note("checked before fetching or paying for anything; no merge event was posted")
    .into())
}

/// The `git` argv of a merge's push to the base: the storage overrides as `-c`, no second cost
/// prompt under `--yes` (the helper has no terminal here and would refuse with E801), and the
/// helper's `allow-archived` push option under `--allow-archived` (else it refuses with E606).
fn merge_push_argv(
    overrides: Vec<String>,
    yes: bool,
    allow_archived: bool,
    remote: &str,
    refspec: &str,
) -> Vec<String> {
    let mut argv: Vec<String> = Vec::new();
    for kv in overrides {
        argv.push("-c".into());
        argv.push(kv);
    }
    if yes {
        argv.extend(["-c".into(), "dash.confirm=never".into()]);
    }
    argv.extend(["push".into(), "-q".into()]);
    if allow_archived {
        argv.extend(["-o".into(), "allow-archived".into()]);
    }
    argv.extend([remote.to_string(), refspec.to_string()]);
    argv
}

/// Merge-method bits of `policy.mergeMethods` (review-parity spec §3.6): 1 fast-forward,
/// 2 merge commit, 4 squash, 8 rebase; 0 allows any.
pub const METHOD_FF: u8 = 1;
/// A merge commit.
pub const METHOD_MERGE: u8 = 2;

/// E804 when the branch policy is not met: too few counted approvals, or a merge method it does
/// not allow (`method` is the bit the merge would use; `None` checks approvals only). The policy
/// is a client rule every Forge client applies; consensus does not enforce it.
fn policy_refusal(
    policy: &forge_core::rules::review::Policy,
    status: &forge_core::rules::review::PolicyStatus,
    method: Option<u8>,
    repo: &str,
    number: u64,
) -> Option<UserError> {
    let method_ok =
        method.is_none_or(|m| policy.merge_methods == 0 || policy.merge_methods & m != 0);
    if status.met && method_ok {
        return None;
    }
    let cause = if status.met {
        "the branch policy does not allow this merge method".to_string()
    } else {
        format!(
            "{} of {} required approval(s){}",
            status.have,
            status.need,
            if policy.approver_role == 1 {
                " from maintainers"
            } else {
                ""
            }
        )
    };
    Some(
        UserError::new(
            codes::POLICY_NOT_MET,
            format!("merge refused: PR #{number} does not meet the branch policy of {repo}"),
        )
        .cause(cause)
        .fix(if status.met {
            format!(
                "choose an allowed merge method (`dg repo policy show {repo}` lists them)"
            )
        } else {
            format!("get the missing approvals (`dg pr review {repo} {number} --approve` by a member)")
        })
        .fix("a maintainer can merge anyway with `--override-policy`")
        .note("the policy is a client rule every Forge client applies; consensus does not enforce it. Nothing was pushed and no merge event was posted"),
    )
}

fn merge_failure(e: &anyhow::Error, number: u64, repo: &str) -> UserError {
    if let Some(u) = e.downcast_ref::<UserError>() {
        return u.clone();
    }
    forge_core::user_error::classify(
        e.chain(),
        &forge_core::user_error::ErrorContext {
            goal: Some("merge failed"),
            repo: Some(repo),
            ..Default::default()
        },
    )
    .note(format!("no merge event was posted for PR #{number}"))
}

/// Do the git side of a merge in a throwaway repository and push the result to the base
/// branch. Returns the oid the merge event names.
fn push_merge(
    ctx: &Ctx,
    handle: &Repo,
    view: &PatchView,
    signer: &str,
    policy: Option<&forge_core::rules::review::Policy>,
    steps: &mut Steps,
) -> Result<String> {
    // The base ref and head are PR document fields anyone could have written; they become a
    // refspec and a push destination below.
    git::require_branch_ref(&view.patch.base_ref_name)?;
    if !git::is_oid(&view.head) {
        anyhow::bail!("the PR names a malformed head commit");
    }
    let env = git::dash_env(ctx);
    let scratch = tempfile::tempdir().context("creating a scratch directory")?;
    let dir = scratch.path();
    git::git(dir, &["init", "-q", "--bare"], &[])?;
    let base_ref = &view.patch.base_ref_name;
    let head = &view.head;

    // Fetch base (its whole history) and head (from the source repo).
    let base_url = format!("dash://{}", handle.id());
    let base_tip = view.base_tip.clone();
    if base_tip.is_some() {
        git::git(
            dir,
            &[
                "fetch",
                "-q",
                &base_url,
                &format!("+{base_ref}:refs/remotes/base/tip"),
            ],
            &env,
        )
        .context("fetching the base branch")?;
    }
    if !git::has_object(dir, head) {
        let source_url = format!("dash://{}", view.patch.source_repo_id);
        // Refspec fixed by us: the PR's `sourceRefName` is attacker-chosen and never used
        // as a refspec. The helper downloads the repo's packs whatever is asked for.
        git::git(
            dir,
            &[
                "fetch",
                "-q",
                &source_url,
                "+refs/heads/*:refs/remotes/source/*",
            ],
            &env,
        )
        .context("fetching the PR head from its source repository")?;
    }
    if !git::has_object(dir, head) {
        anyhow::bail!(
            "the PR head {} is not in its source repository (it may have been force-pushed away)",
            short(head)
        );
    }
    steps.ok(
        "fetch",
        format!(
            "base {} · head {}",
            base_tip.as_deref().map_or("(empty)", short),
            short(head)
        ),
    );

    let Some(target) = build_merge(dir, handle, view, signer, policy, steps)? else {
        return Ok(base_tip.unwrap_or_default());
    };

    // Push to the base. The helper refuses a writer's push to a protected ref before paying
    // (E601 naming maintainer) and routes a maintainer's to `protectedRefUpdate`.
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let argv = merge_push_argv(
        git::storage_overrides(&cwd),
        ctx.yes,
        ctx.allow_archived,
        &base_url,
        &format!("{target}:{base_ref}"),
    );
    push_to(dir, &argv, &env)?;
    steps.ok("push", format!("{base_ref} → {}", short(&target)));
    Ok(target)
}

/// Decide and build the merge in `dir` (holding base and head): the commit to push to the
/// base, or `None` when the head is already in the base (nothing to push).
fn build_merge(
    dir: &Path,
    handle: &Repo,
    view: &PatchView,
    signer: &str,
    policy: Option<&forge_core::rules::review::Policy>,
    steps: &mut Steps,
) -> Result<Option<String>> {
    let base_ref = &view.patch.base_ref_name;
    let head = &view.head;
    let base_tip = view.base_tip.as_deref();
    let plan = git::plan_merge(
        base_tip,
        head,
        base_tip.is_some_and(|b| git::is_ancestor(dir, head, b)),
        base_tip.is_some_and(|b| git::is_ancestor(dir, b, head)),
    );
    let method = match &plan {
        MergePlan::AlreadyMerged { .. } => None,
        MergePlan::FastForward { .. } => Some(METHOD_FF),
        MergePlan::MergeCommit { .. } => Some(METHOD_MERGE),
    };
    if let (Some(policy), Some(m)) = (policy, method) {
        let met = forge_core::rules::review::PolicyStatus {
            met: true,
            have: 0,
            need: 0,
        };
        if let Some(u) = policy_refusal(
            policy,
            &met,
            Some(m),
            &handle.display(),
            u64::from(view.patch.number),
        ) {
            return Err(u.into());
        }
    }
    Ok(Some(match &plan {
        MergePlan::AlreadyMerged { .. } => {
            steps.ok("merge", format!("already in {base_ref}; nothing to push"));
            return Ok(None);
        }
        MergePlan::FastForward { oid } => {
            steps.ok("merge", format!("fast-forward to {}", short(oid)));
            oid.clone()
        }
        MergePlan::MergeCommit { base, head } => {
            let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
            let message = format!(
                "Merge pull request #{} from {}\n\n{}",
                view.patch.number,
                view.patch.source_ref_name.as_deref().unwrap_or(head),
                view.patch.title
            );
            let author = git::merge_author(&cwd, signer);
            let Some(c) = git::merge_commit(dir, base, head, &message, &author)? else {
                return Err(UserError::new(
                    codes::MERGE_CONFLICT,
                    format!(
                        "merge failed: PR #{} conflicts with {base_ref}",
                        view.patch.number
                    ),
                )
                .cause(format!(
                    "a three-way merge of {} into {} has conflicts",
                    short(head),
                    short(base)
                ))
                .fix(format!(
                    "`dg pr checkout {} {}`, merge {base_ref} into it and resolve, push the result to {base_ref}, then run `dg pr merge` again (it sees the head is in {base_ref} and records the merge)",
                    handle.display(),
                    view.patch.number
                ))
                .note("nothing was pushed and no merge event was posted")
                .into());
            };
            steps.ok("merge", format!("merge commit {}", short(&c)));
            c
        }
    }))
}

/// Run the push, surfacing the helper's own E-coded error when it refused.
fn push_to(dir: &Path, argv: &[String], env: &[(String, String)]) -> Result<()> {
    let out = std::process::Command::new("git")
        .current_dir(dir)
        .args(argv)
        .envs(env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
        .stdin(std::process::Stdio::null())
        .output()
        .context("running git push")?;
    if out.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&out.stderr);
    // The helper prints `dash: error: … [E601]` blocks; keep the code for the classifier.
    let mut lines: Vec<&str> = stderr
        .lines()
        .filter(|l| l.starts_with("dash: ") || l.starts_with("error:") || l.contains(" ! "))
        .collect();
    if lines.is_empty() {
        lines = stderr.lines().rev().take(4).collect::<Vec<_>>();
        lines.reverse();
    }
    let text = lines.join("\n");
    if let Some(code) = text
        .split(['[', ']'])
        .find(|t| t.len() == 4 && t.starts_with('E') && t[1..].bytes().all(|b| b.is_ascii_digit()))
    {
        let headline = text
            .lines()
            .find(|l| l.contains(code))
            .map_or("push to the base branch rejected", |l| {
                l.trim_start_matches("dash: ").trim_start_matches("error: ")
            })
            .replace(&format!("[{code}]"), "")
            .trim()
            .to_string();
        let code: &'static str = forge_core::user_error::CATALOGUE
            .iter()
            .find(|(c, _)| *c == code)
            .map_or(codes::REJECTED, |(c, _)| c);
        return Err(UserError::new(code, format!("merge failed: {headline}"))
            .cause(text.replace("dash: ", ""))
            .note("no merge event was posted")
            .into());
    }
    anyhow::bail!("git push to the base branch failed: {text}")
}

// ---------------------------------------------------------------------------
// checkout / diff
// ---------------------------------------------------------------------------

/// Where a PR's pieces are: the source repo id, the head oid, the base ref, and the target
/// repo's id.
struct Located {
    source: String,
    head: String,
    base_ref: String,
    target: String,
}

async fn locate(ctx: &Ctx, repo: &str, number: u64) -> Result<Located> {
    let s = Session::open(ctx, repo).await?;
    let target = s.repo.id().to_string();
    let collab = s.collab();
    let p = patch(&collab, &s.repo, repo, number).await?;
    // The PR's current head: its newest headUpdate, else the head it was opened with.
    let view = collab.patch_view(&s.repo, p).await?;
    let (source, head, base_ref) = (
        view.patch.source_repo_id,
        view.head,
        view.patch.base_ref_name,
    );
    // Every field came from a document anyone could have written: check the shapes before
    // any of them reaches git.
    if !git::is_oid(&head) {
        anyhow::bail!("PR #{number} names a malformed head commit {head:?}");
    }
    Ok(Located {
        source,
        head,
        base_ref,
        target,
    })
}

/// Fetch a PR head into the repository at `cwd` from `dash://<source>` (fixed refspec —
/// the PR's own `sourceRefName` is attacker-chosen and never used as one).
fn fetch_head(ctx: &Ctx, cwd: &Path, source: &str, head: &str) -> Result<bool> {
    if source.is_empty() || git::has_object(cwd, head) {
        return Ok(false);
    }
    let url = format!("dash://{source}");
    git::git(
        cwd,
        &[
            "fetch",
            "-q",
            &url,
            &format!("+refs/heads/*:refs/remotes/dash-pr/{source}/*"),
        ],
        &git::dash_env(ctx),
    )
    .context("fetching the PR head from its source repository")?;
    Ok(true)
}

async fn checkout(ctx: &Ctx, repo: &str, number: u64) -> Result<()> {
    let Located { source, head, .. } = locate(ctx, repo, number).await?;
    let cwd = std::env::current_dir()?;
    let fetched = fetch_head(ctx, &cwd, &source, &head)?;
    if !git::has_object(&cwd, &head) {
        return Err(crate::errors::not_found(
            format!(
                "PR #{number} head {} is not in its source repository",
                short(&head)
            ),
            format!("try `git fetch dash://{source}` by hand"),
        ));
    }
    let branch = format!("pr/{number}");
    git::git(&cwd, &["branch", "-f", &branch, &head], &[])
        .with_context(|| format!("creating branch {branch} (is it checked out?)"))?;
    ctx.emit(
        json!({
            "pr": number,
            "headOid": head,
            "branch": branch,
            "sourceRepoId": source,
            "fetched": fetched,
            "branchCreated": true,
        }),
        || {
            println!(
                "✓ branch {branch} at {} (git switch {branch})",
                short(&head)
            );
        },
    );
    Ok(())
}

async fn diff(ctx: &Ctx, repo: &str, number: u64) -> Result<()> {
    let Located {
        source,
        head,
        base_ref,
        target,
    } = locate(ctx, repo, number).await?;
    git::require_branch_ref(&base_ref)?;
    let cwd = std::env::current_dir()?;
    fetch_head(ctx, &cwd, &source, &head)?;
    // The base as the target repo has it now, fetched fresh.
    let base_local = format!("refs/remotes/dash-pr/base-{number}");
    git::git(
        &cwd,
        &[
            "fetch",
            "-q",
            &format!("dash://{target}"),
            &format!("+{base_ref}:{base_local}"),
        ],
        &git::dash_env(ctx),
    )
    .context("fetching the base branch")?;
    let range = format!("{base_local}...{head}");
    let text = git::git(&cwd, &["--no-pager", "diff", &range], &[])?;
    ctx.emit(
        json!({ "pr": number, "range": range, "diffAvailable": true, "diff": text }),
        || println!("{text}"),
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy(need: u32, maintainers: bool, methods: u8) -> forge_core::rules::review::Policy {
        forge_core::rules::review::Policy {
            required_approvals: need,
            approver_role: u8::from(maintainers),
            require_checks: false,
            merge_methods: methods,
        }
    }

    fn status(have: u32, need: u32) -> forge_core::rules::review::PolicyStatus {
        forge_core::rules::review::PolicyStatus {
            met: have >= need,
            have,
            need,
        }
    }

    #[test]
    fn an_unmet_policy_refuses_the_merge_with_e804() {
        let u = policy_refusal(&policy(2, true, 0), &status(1, 2), None, "o/r", 7).unwrap();
        assert_eq!((u.code, u.exit_code()), ("E804", 8));
        let text = u.to_json().to_string();
        assert!(
            text.contains("1 of 2 required approval(s) from maintainers"),
            "{text}"
        );
        assert!(text.contains("--override-policy"), "{text}");
        assert!(text.contains("consensus does not enforce it"), "{text}");
        assert!(policy_refusal(&policy(2, false, 0), &status(2, 2), None, "o/r", 7).is_none());
    }

    #[test]
    fn a_disallowed_merge_method_refuses_with_e804() {
        // squash only: a fast-forward and a merge commit are refused, 0 allows any.
        let squash = policy(0, false, 4);
        assert!(policy_refusal(&squash, &status(0, 0), Some(METHOD_FF), "o/r", 1).is_some());
        assert!(policy_refusal(&squash, &status(0, 0), Some(METHOD_MERGE), "o/r", 1).is_some());
        assert!(policy_refusal(&squash, &status(0, 0), Some(4), "o/r", 1).is_none());
        assert!(policy_refusal(
            &policy(0, false, 0),
            &status(0, 0),
            Some(METHOD_MERGE),
            "o/r",
            1
        )
        .is_none());
        assert!(policy_refusal(
            &policy(0, false, METHOD_FF),
            &status(0, 0),
            Some(METHOD_FF),
            "o/r",
            1
        )
        .is_none());
    }

    #[test]
    fn the_e804_fix_follows_what_is_missing() {
        let method = policy_refusal(
            &policy(0, false, 4),
            &status(0, 0),
            Some(METHOD_FF),
            "o/r",
            1,
        )
        .unwrap();
        let text = method.to_json().to_string();
        assert!(
            text.contains("choose an allowed merge method") && !text.contains("missing approvals"),
            "{text}"
        );
        let approvals =
            policy_refusal(&policy(1, false, 0), &status(0, 1), None, "o/r", 1).unwrap();
        assert!(approvals
            .to_json()
            .to_string()
            .contains("missing approvals"));
    }

    #[test]
    fn a_merge_push_passes_allow_archived_through_to_the_helper() {
        let argv = merge_push_argv(
            vec!["dash.storage=platform".into()],
            true,
            true,
            "dash://R",
            "abc:refs/heads/main",
        );
        assert_eq!(
            argv,
            [
                "-c",
                "dash.storage=platform",
                "-c",
                "dash.confirm=never",
                "push",
                "-q",
                "-o",
                "allow-archived",
                "dash://R",
                "abc:refs/heads/main"
            ]
        );
        let plain = merge_push_argv(Vec::new(), false, false, "dash://R", "abc:refs/heads/main");
        assert_eq!(plain, ["push", "-q", "dash://R", "abc:refs/heads/main"]);
    }

    #[test]
    fn an_archived_repo_refuses_writes_with_e606() {
        let u = crate::common::archived_refusal("o/r", "issue not created");
        assert_eq!((u.code, u.exit_code()), ("E606", 6));
        let text = u.to_json().to_string();
        assert!(
            text.contains("--allow-archived") && text.contains("dg repo unarchive o/r"),
            "{text}"
        );
    }

    #[test]
    fn exactly_one_verdict() {
        assert_eq!(
            pick_verdict(None, true, false, false).unwrap(),
            VerdictArg::Approve
        );
        assert_eq!(
            pick_verdict(Some(VerdictArg::Comment), false, false, false).unwrap(),
            VerdictArg::Comment
        );
        assert!(pick_verdict(None, false, false, false).is_err());
        assert!(pick_verdict(None, true, true, false).is_err());
        assert!(pick_verdict(Some(VerdictArg::Approve), true, false, false).is_err());
    }
}
