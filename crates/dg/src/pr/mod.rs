//! `dg pr` — pull requests on forge-v2.
//!
//! * `create` opens a `patch` in the target repo pointing at the repo that holds the head
//!   commit (`sourceRepoId`): the target itself, or a fork. With no flags it uses the
//!   current branch, and finds where it lives: the signer's fork of the target when one
//!   exists (`forkOf`), else the target.
//! * `list` / `view` fold the PR's `event` + `authorEvent` log (§3) and count approvals from
//!   members' reviews on the current head (§6).
//! * `view --comments` adds the conversations: inline threads under their file and line,
//!   outdated and resolved marked, suggestions, and general comments ([`threads`]).
//! * `review` / `comment` ([`review`]): a verdict plus inline comments (single lines, ranges,
//!   file-level, suggestions) as one review and N comments, resumably, or held as a pending
//!   review; a single comment or reply.
//! * `edit`, `sync`, `ready` / `draft`, `resolve` / `unresolve`, `request-review`,
//!   `dismiss-review`, `checks`, `commits` ([`state`]).
//! * `merge` does the merge locally, in a throwaway repository: fetch base and head over
//!   `dash://`, fast-forward, a clean merge commit (`git merge-tree`) or a squash, push it to
//!   the base branch (the helper routes a protected branch to `protectedRefUpdate`, which
//!   needs a maintainer), then post the `merge` event. The branch policy is checked first
//!   (E804). Each step is reported; a failure names what already happened. `--event-only`
//!   just posts the event.
//! * `update-branch` and `suggestion apply` commit to the PR's source branch and move its
//!   head ([`branch`]).
//! * `checkout` / `diff` fetch the head from the source repo (`dash://<repoId>`).
//!
//! Review-parity spec (docs/design/review-parity-spec.md) §2.5 C1–C13.

pub mod branch;
pub mod inline;
pub mod review;
pub mod state;
pub mod threads;

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde_json::json;

use forge_core::collab::v2::{approvals_over, Collab, Patch, PatchInput, PatchView};
use forge_core::create::default_journal_dir;
use forge_core::rules::v2::{Role, StateAction};
use forge_core::rules::RefState;
use forge_core::scope::RepoRef as Repo;
use forge_core::user_error::{codes, UserError};

use crate::common::{number_arg, resolve, Reader, RepoRef, Session};
use crate::context::Ctx;
use crate::fmt::{cost_json, cost_line, dash_usd_price, safe, short, transition_route_text};
use crate::git::{self, MergePlan};
use crate::PrCommand;

/// Dispatch a `pr` subcommand.
pub async fn run(ctx: &Ctx, cmd: &PrCommand) -> Result<()> {
    use crate::PrSuggestionCommand as Sg;
    match cmd {
        PrCommand::Create(args) => create(ctx, args).await,
        PrCommand::List { repo, limit, state } => list(ctx, repo, *limit, *state).await,
        PrCommand::View {
            repo,
            number,
            comments,
        } => view(ctx, repo, *number, *comments).await,
        PrCommand::Checkout { repo, number } => checkout(ctx, repo, *number).await,
        PrCommand::Review(a) => review::review(ctx, a).await,
        PrCommand::Comment(a) => review::comment(ctx, a).await,
        PrCommand::Edit {
            repo,
            number,
            title,
            body,
            body_file,
        } => {
            state::edit(
                ctx,
                repo,
                *number,
                title.as_deref(),
                body.as_deref(),
                body_file.as_deref(),
            )
            .await
        }
        PrCommand::Sync { repo, number, head } => {
            state::sync(ctx, repo, *number, head.as_deref()).await
        }
        PrCommand::Ready { repo, number } => state::set_draft(ctx, repo, *number, false).await,
        PrCommand::Draft { repo, number } => state::set_draft(ctx, repo, *number, true).await,
        PrCommand::Resolve {
            repo,
            number,
            comment_id,
        } => state::resolve(ctx, repo, *number, comment_id, true).await,
        PrCommand::Unresolve {
            repo,
            number,
            comment_id,
        } => state::resolve(ctx, repo, *number, comment_id, false).await,
        PrCommand::RequestReview {
            repo,
            number,
            reviewers,
            remove,
        } => state::request_review(ctx, repo, *number, reviewers, !*remove).await,
        PrCommand::UnrequestReview {
            repo,
            number,
            reviewers,
        } => state::request_review(ctx, repo, *number, reviewers, false).await,
        PrCommand::DismissReview {
            repo,
            number,
            review_id,
            reason,
        } => state::dismiss(ctx, repo, *number, review_id, reason).await,
        PrCommand::Checks { repo, number } => state::checks(ctx, repo, *number).await,
        PrCommand::Commits {
            repo,
            number,
            limit,
        } => state::commits(ctx, repo, *number, *limit).await,
        PrCommand::Merge(a) => Box::pin(merge(ctx, a)).await,
        PrCommand::UpdateBranch { repo, number } => {
            Box::pin(branch::update_branch(ctx, repo, *number)).await
        }
        PrCommand::Suggestion(Sg::Apply {
            repo,
            number,
            comment_ids,
            all,
        }) => {
            Box::pin(branch::apply_suggestions(
                ctx,
                repo,
                *number,
                comment_ids,
                *all,
            ))
            .await
        }
        PrCommand::Close { repo, number } => set_open(ctx, repo, *number, true).await,
        PrCommand::Reopen { repo, number } => set_open(ctx, repo, *number, false).await,
        PrCommand::Diff { repo, number } => diff(ctx, repo, *number).await,
    }
}

/// What a write is estimated from (review-parity §6, measured on moutai; steady state). A
/// target's first comment or event also creates its index subtrees: allow 10–25M more.
#[derive(Debug, Clone, Copy)]
pub enum Est {
    /// A `comment`: 47.3M + 27.5k per text byte.
    Comment,
    /// A `review`: 34.9M + 27.5k per text byte.
    Review,
    /// A member `event`, with its `refId`/`oid`/`value`: 65M + 27.5k per value byte.
    Event,
    /// An `authorEvent`: 72M + 27.5k per value byte.
    AuthorEvent,
    /// A `patch` replace: 17M + 27.5k per changed byte.
    Replace,
}

/// A `refUpdate` (plus its small manifest share) a push to the PR branch pays, steady state.
pub const REF_UPDATE_CREDITS: u64 = 45_000_000;

/// Credits for one write of `kind` carrying `text_bytes` of text.
pub fn estimate(kind: Est, text_bytes: usize) -> u64 {
    let base: u64 = match kind {
        Est::Comment => 47_300_000,
        Est::Review => 34_900_000,
        Est::Event => 65_000_000,
        Est::AuthorEvent => 72_000_000,
        Est::Replace => 17_000_000,
    };
    base + 27_500 * u64::try_from(text_bytes).unwrap_or(u64::MAX / 27_500)
}

/// The estimate for an event of `route` with a `value` of `value_bytes`.
pub fn event_estimate(route: forge_core::collab::v2::StateRoute, value_bytes: usize) -> u64 {
    match route {
        forge_core::collab::v2::StateRoute::Member => estimate(Est::Event, value_bytes),
        forge_core::collab::v2::StateRoute::Author => estimate(Est::AuthorEvent, value_bytes),
    }
}

fn not_found(repo: &str, number: u64) -> anyhow::Error {
    crate::errors::not_found(
        format!("pull request #{number} not found in {repo}"),
        format!("`dg pr list {repo} --state all` lists its pull requests"),
    )
}

/// The v2 PR `number` of `handle`, or E102.
pub(crate) async fn patch(
    collab: &Collab<'_>,
    handle: &Repo,
    repo: &str,
    number: u64,
) -> Result<Patch> {
    collab
        .patch(handle, number_arg(number)?)
        .await?
        .ok_or_else(|| not_found(repo, number))
}

/// A PR and the connection it was read over: a signing [`Session`] for a command that writes,
/// a [`Reader`] (no key for a public repository, L-12) for one that only reads.
pub(crate) struct Pr<S = Session> {
    pub(crate) s: S,
    pub(crate) view: PatchView,
}

/// Open `repo` to read (an archived repository is readable; a public one needs no identity)
/// and read PR `number`'s view.
pub(crate) async fn open_pr_read(ctx: &Ctx, repo: &str, number: u64) -> Result<Pr<Reader>> {
    let s = Reader::open(ctx, repo).await?;
    let collab = s.collab();
    let p = patch(&collab, &s.repo, repo, number).await?;
    let view = collab.patch_view(&s.repo, p).await?;
    Ok(Pr { s, view })
}

/// Open a session on `repo` to write (`action` names what is refused when it is archived,
/// E606) and read PR `number`'s view.
pub(crate) async fn open_pr(ctx: &Ctx, repo: &str, number: u64, action: &str) -> Result<Pr> {
    let s = Session::open_for_write(ctx, repo, action).await?;
    let collab = s.collab();
    let p = patch(&collab, &s.repo, repo, number).await?;
    let view = collab.patch_view(&s.repo, p).await?;
    Ok(Pr { s, view })
}

pub(crate) fn state_label(v: &PatchView) -> &'static str {
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

#[allow(clippy::too_many_lines)]
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
        draft: args.draft,
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
    ctx.confirm_or_cancel(if args.draft {
        "Open it as a draft? (the PR and a draft transition: two small documents, ~0.0002 DASH)"
    } else {
        "Open it? (one small document, ~0.0001 DASH)"
    })?;
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
            "draft": args.draft,
            "draftTransitionId": created.draft_transition,
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
                "✓ opened {}PR #{} in {}{how} · {}",
                if args.draft { "draft " } else { "" },
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
    let s = Reader::open(ctx, repo).await?;
    let handle = &s.repo;
    let collab = s.collab();
    // A fixed number of requests for the whole page (D-500: it was about 9 per PR).
    let page = collab.list_patch_views(handle, limit).await?;
    let (hidden, more) = (page.hidden, page.more);
    let rows: Vec<_> = page
        .rows
        .into_iter()
        .filter(|(v, _)| state.matches(v.state.open))
        .collect();
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
/// a `reviewDismiss` names it, with how many of its announced comments have landed.
fn reviews_json(
    reviews: &[forge_core::collab::v2::Review],
    comments: &[forge_core::collab::v2::Comment],
    head: &str,
    dismissed: &std::collections::BTreeMap<String, String>,
) -> Vec<serde_json::Value> {
    let flat: Vec<forge_core::rules::v2::ReviewComment> = comments
        .iter()
        .map(|c| forge_core::rules::v2::ReviewComment {
            id: c.document_id.clone(),
            owner: c.author.clone(),
            review_id: c.review_id.clone(),
            created_at: c.created_at,
        })
        .collect();
    reviews
        .iter()
        .map(|r| {
            let group = forge_core::rules::v2::group_review_comments(
                &r.document_id,
                &r.reviewer,
                r.comment_count,
                &flat,
            );
            json!({
                "id": r.document_id,
                "reviewer": r.reviewer,
                "verdict": r.verdict.code(),
                "verdictLabel": r.verdict.label(),
                "commitOid": r.commit_oid,
                "stale": r.commit_oid != head,
                "dismissed": dismissed.contains_key(&r.document_id),
                "dismissReason": dismissed.get(&r.document_id),
                "commentCount": r.comment_count,
                "commentsLanded": group.landed,
                "commentIds": group.comments,
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
                "createdAt": c.created_at,
            })
        })
        .collect()
}

/// `dg pr view`: the PR's state, reviewers, approvals, reviews and (with `--comments`, or
/// always in `--json`) its conversations. Works signed out for a public repo; with an identity
/// it adds "new commits since your review", and opens a private repo's sealed documents.
#[allow(clippy::too_many_lines)]
async fn view(ctx: &Ctx, repo: &str, number: u64, show_comments: bool) -> Result<()> {
    // A public PR is read without opening any key (a sealed one would ask for its
    // passphrase); a private repo's sealed documents open with the identity's keys. The
    // viewer ("new commits since your review") is named when the key source says who it is.
    let s = Reader::open(ctx, repo).await?;
    let (client, handle, collab) = (&s.client, &s.repo, s.collab());
    let p = patch(&collab, handle, repo, number).await?;
    let v = collab.patch_view(handle, p).await?;
    let oracle = collab.member_oracle(handle).await?;
    let doc_id = &v.patch.document_id;
    let (reviews, hidden_reviews) = collab.reviews_counted(handle, doc_id).await?;
    let approvals = approvals_over(&reviews, &v, &oracle);
    let (comments, hidden_comments) = collab.comments_counted(handle, doc_id).await?;
    let review_state = v.review_with_threads(&comments);
    let conv = threads::threads(&comments, &v.head, &review_state.resolved_threads);
    let rows = threads::reviewer_rows(&reviews, &review_state, &approvals, &oracle, &v.head);
    let since = s
        .viewer()
        .and_then(|me| threads::since_your_review(&reviews, &review_state, me));
    let policy = collab.policy(handle).await?;
    let policy_status = policy
        .as_ref()
        .map(|p| forge_core::rules::v2::meets_policy(&approvals, &oracle, p));
    let dismissed: std::collections::BTreeMap<String, String> = review_state
        .dismissed_reviews
        .iter()
        .map(|d| (d.review_id.clone(), d.reason.clone()))
        .collect();
    let source = if v.patch.source_repo_id == handle.id() {
        handle.display()
    } else {
        forge_core::resolve::resolve_id(client, &v.patch.source_repo_id)
            .await
            .map_or_else(|_| v.patch.source_repo_id.clone(), |r| r.display())
    };

    let reviews_json = reviews_json(&reviews, &comments, &v.head, &dismissed);
    let unresolved = conv.threads.iter().filter(|t| !t.resolved).count();
    ctx.emit(
        json!({
            "number": v.patch.number,
            "id": v.patch.document_id,
            "title": v.patch.title,
            "body": v.patch.body,
            "author": v.patch.author,
            "state": state_label(&v),
            "draft": v.state.draft,
            "labels": v.state.labels,
            "assignees": v.state.assignees,
            "retargetedTo": v.state.base_ref,
            "baseRef": v.patch.base_ref_name,
            "baseTip": v.base_tip,
            "headOid": v.head,
            "initialHeadOid": v.patch.head_oid,
            "headOnBase": v.head_on_base,
            "headUpdates": review_state.head_updates.iter().map(|h| json!({
                "oid": h.oid, "actor": h.actor, "createdAt": h.created_at, "id": h.id,
            })).collect::<Vec<_>>(),
            "resolvedThreads": review_state.resolved_threads,
            "milestone": review_state.milestone,
            "sourceRepoId": v.patch.source_repo_id,
            "sourceRepo": source,
            "sourceRefName": v.patch.source_ref_name,
            "approvedBy": approvals.approvers,
            "changesRequestedBy": approvals.changes_requested,
            "reviewers": rows,
            "requestedReviewers": review_state.requested_reviewers,
            "dismissedReviews": review_state.dismissed_reviews,
            "sinceYourReview": since,
            "policy": policy,
            "policyStatus": policy_status,
            "reviews": reviews_json,
            "threads": conv.threads,
            "generalComments": conv.general,
            "comments": comments_json(&comments),
            "hiddenComments": hidden_comments,
            "hiddenReviews": hidden_reviews,
            "hiddenEventValues": v.log.hidden_values,
            "plaintextEventValues": v.log.plaintext_values,
        }),
        || {
            println!(
                "#{} [{}{}] {}",
                v.patch.number,
                state_label(&v),
                if v.state.draft && v.state.open { ", draft" } else { "" },
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
            if let Some(m) = &since {
                println!(
                    "! new commits since your review: you reviewed {}, the PR is at {} ({} head update{} since) — re-review with `dg pr review {repo} {number}`",
                    short(&m.reviewed_oid),
                    short(&m.head_oid),
                    m.head_updates,
                    if m.head_updates == 1 { "" } else { "s" }
                );
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
            if let (Some(p), Some(st)) = (&policy, &policy_status) {
                println!(
                    "policy: {} of {} required approval{}{} — {}",
                    st.have,
                    st.need,
                    if st.need == 1 { "" } else { "s" },
                    if p.approver_role == 1 { " (maintainers)" } else { "" },
                    if st.met { "met" } else { "not met" }
                );
            }
            if !rows.is_empty() {
                println!("\nReviewers");
                for r in &rows {
                    let extra = match (&r.dismiss_reason, r.re_requested, &r.reviewed_oid) {
                        (Some(reason), _, _) if !reason.is_empty() => format!(": {}", safe(reason)),
                        (_, true, _) => " (re-requested)".into(),
                        (_, _, Some(oid)) if r.state == threads::Standing::Stale => {
                            format!(" (reviewed {})", short(oid))
                        }
                        _ => String::new(),
                    };
                    println!("  {}  {}{extra}", r.identity, r.state.label());
                }
            }
            if !v.patch.body.is_empty() {
                println!("\n{}", safe(&v.patch.body));
            }
            for r in &reviews {
                let tag = if dismissed.contains_key(&r.document_id) {
                    " (dismissed)"
                } else if r.commit_oid == v.head {
                    ""
                } else {
                    " (stale — new commits since)"
                };
                println!(
                    "\n{} — {} on {}{tag}  [{}]",
                    r.verdict.label(),
                    r.reviewer,
                    short(&r.commit_oid),
                    short(&r.document_id)
                );
                if !r.body.is_empty() {
                    println!("  {}", safe(&r.body));
                }
            }
            if show_comments {
                print_conversations(&conv);
            } else if !comments.is_empty() {
                println!(
                    "\n{} comment(s) in {} thread(s) ({unresolved} unresolved) — `--comments` shows them",
                    comments.len(),
                    conv.threads.len() + conv.general.len()
                );
            }
            if hidden_comments + hidden_reviews > 0 {
                println!(
                    "\n{}",
                    crate::fmt::hidden_note(handle, hidden_comments + hidden_reviews)
                );
            }
            if let Some(n) =
                crate::fmt::event_values_note(v.log.hidden_values, v.log.plaintext_values)
            {
                println!("\n{n}");
            }
        },
    );
    Ok(())
}

/// The threads under their file and line, then the general comments.
fn print_conversations(conv: &threads::Conversations) {
    let mut last_path = "";
    for t in &conv.threads {
        if t.anchor.path != last_path {
            println!("\n{}", safe(&t.anchor.path));
            last_path = &t.anchor.path;
        }
        let mut tags = Vec::new();
        if t.outdated {
            tags.push(format!("outdated, on {}", short(&t.anchor.commit_oid)));
        }
        if t.resolved {
            tags.push("resolved".to_string());
        }
        let tags = if tags.is_empty() {
            String::new()
        } else {
            format!(" [{}]", tags.join(", "))
        };
        println!("  ▸ {}{tags}  (thread {})", safe(&t.location), short(&t.id));
        for c in &t.comments {
            println!("    — {} [{}]:", c.author, short(&c.id));
            for line in safe(&c.body).lines() {
                println!("      {line}");
            }
            for s in &c.suggestions {
                println!("      suggested change:");
                for line in safe(s).lines() {
                    println!("      + {line}");
                }
            }
        }
    }
    if !conv.general.is_empty() {
        println!("\nConversation");
        for c in &conv.general {
            println!("  — {} [{}]:", c.author, short(&c.id));
            for line in safe(&c.body).lines() {
                println!("    {line}");
            }
        }
    }
}

// ---------------------------------------------------------------------------
// close / reopen
// ---------------------------------------------------------------------------

async fn set_open(ctx: &Ctx, repo: &str, number: u64, close: bool) -> Result<()> {
    let s = Session::open_for_write(ctx, repo, "state not changed").await?;
    let collab = s.collab();
    let p = patch(&collab, &s.repo, repo, number).await?;
    let verb = if close { "Close" } else { "Reopen" };
    ctx.confirm_or_cancel(&format!("{verb} PR #{number}? (one small document)"))?;
    let action = if close {
        StateAction::Close
    } else {
        StateAction::Reopen
    };
    let change = collab.set_state(&s.repo, &p.target(), action, None).await?;
    ctx.emit(
        json!({
            "status": if close { "closed" } else { "reopened" },
            "pr": number,
            "via": change.route,
            "transitionId": change.transition_id,
            "kind": change.kind,
            // a closed draft stays a draft (kind 16/17)
            "draft": forge_core::rules::v2::status_of_code(change.after).draft,
        }),
        || {
            println!(
                "✓ {} PR #{number} {}",
                if close { "closed" } else { "reopened" },
                transition_route_text(change.route)
            );
        },
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// merge
// ---------------------------------------------------------------------------

/// One reported step of a merge (or of a commit to the PR branch).
pub(crate) struct Steps {
    pub(crate) json: bool,
    pub(crate) done: Vec<serde_json::Value>,
}

impl Steps {
    pub(crate) fn new(json: bool) -> Self {
        Self {
            json,
            done: Vec::new(),
        }
    }

    pub(crate) fn ok(&mut self, step: &str, detail: impl Into<String>) {
        let detail = detail.into();
        if !self.json {
            eprintln!("  ✓ {step:<9} {detail}");
        }
        self.done
            .push(json!({ "step": step, "ok": true, "detail": detail }));
    }
}

/// How the head is brought into the base.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Method {
    /// Fast-forward when the base is behind the head, else a merge commit.
    Merge,
    /// One new commit on the base with the merged tree.
    Squash,
}

impl Method {
    /// `merge` / `squash` (`--json`'s `method`).
    fn as_str(self) -> &'static str {
        match self {
            Method::Merge => "merge",
            Method::Squash => "squash",
        }
    }
}

#[allow(clippy::too_many_lines)]
async fn merge(ctx: &Ctx, a: &crate::PrMergeArgs) -> Result<()> {
    let (repo, number, event_only) = (a.repo.as_str(), a.number, a.event_only);
    let method = if a.squash {
        Method::Squash
    } else {
        Method::Merge
    };
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
    refuse_unmergeable(&view, number)?;
    refuse_retargeted(&view, number)?;
    refuse_missing_base(&view, number, event_only)?;
    let merge_oid = event_only
        .then(|| event_only_oid(&view, a.merge_oid.as_deref(), number))
        .transpose()?;
    // A squash's method is known now; a merge's (fast-forward or merge commit) once planned.
    let squash_bit = (method == Method::Squash).then_some(METHOD_SQUASH);
    let policy = require_merge_rights(
        &s,
        handle,
        &view,
        !event_only,
        squash_bit,
        a.override_policy,
    )
    .await?;
    // `--delete-branch` needs write access to the source repo: refuse before merging rather
    // than after.
    let delete = if a.delete_branch {
        Some(branch::deletable_source(&s, &view, number).await?)
    } else {
        None
    };
    let mut steps = Steps::new(ctx.json);
    if !ctx.json {
        eprintln!(
            "Merging PR #{number} of {} into {}{}",
            handle.display(),
            view.patch.base_ref_name,
            if method == Method::Squash {
                " (squash)"
            } else {
                ""
            }
        );
    }
    ctx.confirm_or_cancel(&format!(
        "Merge PR #{number}? ({}{}; ~0.0003 DASH plus the pack if new objects are stored)",
        if event_only {
            "records the merge only"
        } else {
            "pushes to the base branch, then records the merge"
        },
        if delete.is_some() {
            ", then deletes the source branch"
        } else {
            ""
        }
    ))?;

    let merge_oid = if let Some(oid) = merge_oid {
        steps.ok("plan", format!("record only, naming {}", short(&oid)));
        oid
    } else {
        let how = MergeHow {
            method,
            message: a.message.as_deref(),
            signer: &s.identity.id(),
            policy: policy.as_ref(),
        };
        match push_merge(ctx, handle, &view, &how, &mut steps) {
            Ok(oid) => oid,
            Err(e) => {
                return Err(crate::errors::reported(
                    merge_failure(&e, number, repo),
                    json!({ "status": "failed", "pr": number, "steps": steps.done }),
                ))
            }
        }
    };

    let transition_id = post_merge_event(&collab, handle, &view, &merge_oid, event_only, repo)
        .await
        .map_err(|u| {
            crate::errors::reported(
                *u,
                json!({ "status": "pushed_no_event", "pr": number, "mergeOid": merge_oid, "steps": steps.done }),
            )
        })?;
    steps.ok(
        "record",
        format!("merge transition {}", short(&transition_id)),
    );

    let mut branch_deleted = false;
    if let Some(d) = &delete {
        match branch::delete_source_branch(ctx, d) {
            Ok(()) => {
                branch_deleted = true;
                steps.ok("delete", format!("{} in {}", d.ref_name, d.repo_display));
            }
            Err(e) => {
                // The merge stands; say what did not happen.
                if !ctx.json {
                    eprintln!("  ✗ delete    {e:#}");
                }
                steps
                    .done
                    .push(json!({ "step": "delete", "ok": false, "detail": format!("{e:#}") }));
            }
        }
    }

    // Re-read: "merged" is the chain fact (the transition landed); whether its commit is on
    // the base is what readers label. The push above moved the base branch, so the ref
    // history is read again.
    collab.refs_changed();
    let after = match collab.patch(handle, view.patch.number).await? {
        Some(p) => collab.patch_view(handle, p).await.ok(),
        None => None,
    };
    let merged = after.as_ref().is_some_and(|v| v.state.merged);
    let on_base = after.as_ref().and_then(|v| v.state.merge_on_base);
    ctx.emit(
        json!({
            "status": if merged { "merged" } else { "merge_recorded" },
            "pr": number,
            "method": method.as_str(),
            "mergeOid": merge_oid,
            "transitionId": transition_id,
            "merged": merged,
            "mergeOnBase": on_base,
            "branchDeleted": branch_deleted,
            "steps": steps.done,
        }),
        || {
            if !merged {
                println!(
                    "Recorded the merge of PR #{number} ({}); it does not read as merged yet \
                     (the read may lag a block).",
                    short(&merge_oid)
                );
            } else if on_base == Some(false) {
                println!(
                    "✓ merged PR #{number} ({}); note: {} is not (yet) a tip of {}, so \
                     readers label the merge commit as not found on the base",
                    short(&merge_oid),
                    short(&merge_oid),
                    view.patch.base_ref_name
                );
            } else {
                println!("✓ merged PR #{number} ({})", short(&merge_oid));
            }
        },
    );
    Ok(())
}

/// What a merge builds.
struct MergeHow<'a> {
    method: Method,
    /// `--message` (a squash's commit message).
    message: Option<&'a str>,
    /// The signing identity (the commit author when git has no `user.name`).
    signer: &'a str,
    /// The branch policy in force (unless overridden): its merge methods are checked once the
    /// merge is planned.
    policy: Option<&'a forge_core::rules::review::Policy>,
}

/// Record the merge: a merge `transition` (kind 13, a member's) naming `merge_oid`; on
/// failure, the user error saying what already happened.
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
                .set_state(handle, &view.patch.target(), StateAction::Merge, Some(&oid))
                .await?
                .transition_id,
        )
    }
    .await;
    posted.map_err(|e| {
        Box::new(
            forge_core::user_error::classify(
                e.chain(),
                &forge_core::user_error::ErrorContext {
                    goal: Some("merge not recorded"),
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

/// A merge is legal only from an open, ready PR (the contract's `c3_mergedAfter`: the sum
/// after it is 2, so 0 before): a draft is marked ready first, a closed PR reopened. Refused
/// before anything is pushed, so the base never takes a merge the chain would refuse.
fn refuse_unmergeable(view: &PatchView, number: u64) -> Result<()> {
    let (why, fix) = match (view.state.open, view.state.draft) {
        (true, false) => return Ok(()),
        (true, true) => (
            "it is a draft",
            format!("`dg pr ready <owner>/<repo> {number}` marks it ready for review"),
        ),
        (false, _) => (
            "it is closed",
            format!("`dg pr reopen <owner>/<repo> {number}` reopens it"),
        ),
    };
    Err(UserError::new(
        codes::REJECTED,
        format!("merge not attempted: PR #{number} cannot be merged, {why}"),
    )
    .cause("a merge is recorded only from an open PR that is ready for review")
    .fix(fix)
    .note("nothing was pushed or written")
    .into())
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
            let checks = required_checks(&collab, handle, view, &oracle, &policy).await?;
            Ok(Some((
                policy.clone(),
                forge_core::rules::review::meets_policy(&approvals, &oracle, &policy),
                checks,
            )))
        };
        match read.await {
            Ok(Some((policy, status, checks))) => {
                if let Some(u) = policy_refusal(&policy, &status, method, &handle.display(), number)
                {
                    return Err(u.into());
                }
                if let Some(u) = checks
                    .as_ref()
                    .and_then(|c| checks_refusal(c, &handle.display(), number))
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
/// A squash.
pub const METHOD_SQUASH: u8 = 4;

/// When `policy` requires checks, where the head's checks stand: the newest trusted run per name
/// decides (`checks_state`, the web merge box's rule too).
async fn required_checks(
    collab: &forge_core::collab::v2::Collab<'_>,
    handle: &Repo,
    view: &PatchView,
    oracle: &forge_core::rules::v2::RoleOracle,
    policy: &forge_core::rules::review::Policy,
) -> Result<Option<forge_core::rules::v2::ChecksState>> {
    if !policy.require_checks {
        return Ok(None);
    }
    let rules = forge_core::rules::v2::ChecksPolicy {
        require_checks: true,
        required_checks: Vec::new(),
    };
    Ok(Some(
        collab
            .head_checks(handle, &view.head, oracle, &rules)
            .await?,
    ))
}

/// E804 when the branch policy requires checks and the head's newest trusted runs do not all
/// pass (or none is reported). `None` when they are met.
fn checks_refusal(
    checks: &forge_core::rules::v2::ChecksState,
    repo: &str,
    number: u64,
) -> Option<UserError> {
    use forge_core::rules::v2::CheckState;
    if checks.met {
        return None;
    }
    let not_passing: Vec<String> = checks
        .required
        .iter()
        .filter(|c| c.state != CheckState::Passed)
        .map(|c| {
            let state = match c.state {
                CheckState::Failing => "failing",
                CheckState::Pending => "pending",
                CheckState::Missing => "missing",
                CheckState::Passed => "passed",
            };
            format!("{} {state}", c.name)
        })
        .collect();
    let cause = if checks.required.is_empty() {
        "the branch policy requires checks, and no member or runner reported any on the head"
            .to_string()
    } else {
        format!("required checks not passing: {}", not_passing.join(", "))
    };
    Some(
        UserError::new(
            codes::POLICY_NOT_MET,
            format!("merge refused: PR #{number} does not meet the branch policy of {repo}"),
        )
        .cause(cause)
        .fix(format!("`dg pr checks {repo} {number}` shows the runs; a maintainer can merge with `--override-policy`"))
        .note("checked before fetching or paying for anything; no merge event was posted"),
    )
}

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

/// The E-coded error for a failed merge step (conflicts are E105; the rest classify).
pub(crate) fn merge_failure(e: &anyhow::Error, number: u64, repo: &str) -> UserError {
    step_failure(e, number, repo, "merge failed", "no merge event was posted")
}

/// The E-coded error for a failed step of `goal` on PR `number`; `nothing` says what did not
/// happen (added to a helper's own error when it has no note of its own).
pub(crate) fn step_failure(
    e: &anyhow::Error,
    number: u64,
    repo: &str,
    goal: &str,
    nothing: &str,
) -> UserError {
    if let Some(u) = e.downcast_ref::<UserError>() {
        let u = u.clone();
        return if u.note.is_none() {
            u.note(format!("{nothing} for PR #{number}"))
        } else {
            u
        };
    }
    forge_core::user_error::classify(
        e.chain(),
        &forge_core::user_error::ErrorContext {
            goal: Some(goal),
            repo: Some(repo),
            ..Default::default()
        },
    )
    .note(format!("{nothing} for PR #{number}"))
}

/// Do the git side of a merge in a throwaway repository and push the result to the base
/// branch. Returns the oid the merge event names.
fn push_merge(
    ctx: &Ctx,
    handle: &Repo,
    view: &PatchView,
    how: &MergeHow<'_>,
    steps: &mut Steps,
) -> Result<String> {
    let scratch = scratch_with_pr(ctx, handle, view)?;
    let dir = scratch.path();
    let base_ref = &view.patch.base_ref_name;
    let base_url = format!("dash://{}", handle.id());
    steps.ok(
        "fetch",
        format!(
            "base {} · head {}",
            view.base_tip.as_deref().map_or("(empty)", short),
            short(&view.head)
        ),
    );

    let Some(target) = build_merge(dir, handle, view, how, steps)? else {
        return Ok(view.base_tip.clone().unwrap_or_default());
    };

    // Push to the base. The helper refuses a writer's push to a protected ref before paying
    // (E601 naming maintainer) and routes a maintainer's to `protectedRefUpdate`.
    push_to(
        dir,
        &push_argv(ctx, &base_url, &target, base_ref),
        &git::dash_env_signing(ctx)?,
        "merge failed",
    )?;
    steps.ok("push", format!("{base_ref} → {}", short(&target)));
    Ok(target)
}

/// Refuse a PR whose base ref or head could not safely reach git: the base must be a plain
/// branch (it becomes a refspec and a push destination), the head a hex commit id. Both are
/// document fields anyone could have written.
pub(crate) fn require_git_safe(view: &PatchView) -> Result<()> {
    git::require_branch_ref(&view.patch.base_ref_name)?;
    if !git::is_oid(&view.head) {
        anyhow::bail!(
            "the PR names a malformed head commit {:?}",
            safe(&view.head)
        );
    }
    Ok(())
}

/// A throwaway bare repository (removed when dropped).
pub(crate) fn scratch_repo() -> Result<tempfile::TempDir> {
    let scratch = tempfile::tempdir().context("creating a scratch directory")?;
    git::git(scratch.path(), &["init", "-q", "--bare"], &[])?;
    Ok(scratch)
}

/// The environment for fetching from a repository: the key is handed over only when it is
/// `private`, whose content needs it (a private repository cannot be forked, so a PR's source
/// repository is as private as its target). A public fetch never gets the key.
fn read_env(ctx: &Ctx, private: bool) -> Result<git::DashEnv<'_>> {
    if private {
        git::dash_env_signing(ctx)
    } else {
        Ok(git::dash_env(ctx))
    }
}

/// A scratch repository holding the PR's base branch and head ([`fetch_base_and_head`]).
pub(crate) fn scratch_with_pr(
    ctx: &Ctx,
    handle: &Repo,
    view: &PatchView,
) -> Result<tempfile::TempDir> {
    let scratch = scratch_repo()?;
    let private = handle.visibility == forge_core::rules::v2::Visibility::Private;
    fetch_base_and_head(scratch.path(), handle, view, &read_env(ctx, private)?)?;
    Ok(scratch)
}

/// Fetch the base branch (its whole history) and the PR head (from its source repository)
/// into the bare repository `dir`. The base ref and head are PR document fields anyone could
/// have written, and become a refspec here (and a push destination later): both are checked
/// first.
pub(crate) fn fetch_base_and_head(
    dir: &Path,
    handle: &Repo,
    view: &PatchView,
    env: &git::DashEnv<'_>,
) -> Result<()> {
    require_git_safe(view)?;
    let base_ref = &view.patch.base_ref_name;
    let head = &view.head;
    if view.base_tip.is_some() {
        git::git_dash(
            dir,
            &[
                "fetch",
                "-q",
                &format!("dash://{}", handle.id()),
                &format!("+{base_ref}:refs/remotes/base/tip"),
            ],
            env,
        )
        .context("fetching the base branch")?;
    }
    if !git::has_object(dir, head) {
        let source_url = format!("dash://{}", view.patch.source_repo_id);
        // Refspec fixed by us: the PR's `sourceRefName` is attacker-chosen and never used
        // as a refspec. The helper downloads the repo's packs whatever is asked for.
        git::git_dash(
            dir,
            &[
                "fetch",
                "-q",
                &source_url,
                "+refs/heads/*:refs/remotes/source/*",
            ],
            env,
        )
        .context("fetching the PR head from its source repository")?;
    }
    if !git::has_object(dir, head) {
        anyhow::bail!(
            "the PR head {} is not in its source repository (it may have been force-pushed away)",
            short(head)
        );
    }
    Ok(())
}

/// `git [-c storage…] [-c dash.confirm=never] push -q <url> <oid>:<ref>`: the user's storage
/// settings, and `--yes` passed on so the helper's cost guard does not ask again (it has no
/// terminal here and would refuse with E801).
pub(crate) fn push_argv(ctx: &Ctx, url: &str, oid: &str, dst: &str) -> Vec<String> {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    merge_push_argv(
        git::storage_overrides(&cwd),
        ctx.yes,
        ctx.allow_archived,
        url,
        &format!("{oid}:{dst}"),
    )
}

/// The E105 for a merge of `head` into `base` that has conflicts, naming the files.
pub(crate) fn conflict_error(
    dir: &Path,
    handle: &Repo,
    number: u32,
    base_ref: &str,
    base: &str,
    head: &str,
) -> anyhow::Error {
    let files = git::conflicted_paths(dir, base, head);
    let mut cause = format!(
        "a three-way merge of {} into {} has conflicts",
        short(head),
        short(base)
    );
    if !files.is_empty() {
        cause.push_str(" in ");
        cause.push_str(&files.join(", "));
    }
    UserError::new(
        codes::MERGE_CONFLICT,
        format!("merge failed: PR #{number} conflicts with {base_ref}"),
    )
    .cause(cause)
    .fix(format!(
        "`dg pr update-branch {} {number}` merges {base_ref} into the PR branch when it is clean; otherwise `dg pr checkout {} {number}`, merge {base_ref} into it and resolve, push it to the PR's branch, then `dg pr sync`",
        handle.display(),
        handle.display(),
    ))
    .note("nothing was pushed and no merge event was posted")
    .into()
}

/// Decide and build the merge in `dir` (holding base and head): the commit to push to the
/// base, or `None` when the head is already in the base (nothing to push).
fn build_merge(
    dir: &Path,
    handle: &Repo,
    view: &PatchView,
    how: &MergeHow<'_>,
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
    let method = match (&plan, how.method) {
        (MergePlan::AlreadyMerged { .. }, _) => None,
        (_, Method::Squash) => Some(METHOD_SQUASH),
        (MergePlan::FastForward { .. }, Method::Merge) => Some(METHOD_FF),
        (MergePlan::MergeCommit { .. }, Method::Merge) => Some(METHOD_MERGE),
    };
    if let (Some(policy), Some(m)) = (how.policy, method) {
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
    let conflict = |base: &str, head: &str| {
        conflict_error(dir, handle, view.patch.number, base_ref, base, head)
    };
    let author = || git::merge_author_here(how.signer);
    let (commit, detail) = match (&plan, how.method) {
        (MergePlan::AlreadyMerged { .. }, _) => {
            steps.ok("merge", format!("already in {base_ref}; nothing to push"));
            return Ok(None);
        }
        // Squash: one commit on the base tip whose tree is the merged tree (the head's own
        // tree when the base is behind it).
        (plan, Method::Squash) => {
            let tree = match plan {
                MergePlan::MergeCommit { base, head } => {
                    git::merge_tree(dir, base, head)?.ok_or_else(|| conflict(base, head))?
                }
                _ => git::git(dir, &["rev-parse", &format!("{head}^{{tree}}")], &[])?,
            };
            let author = author();
            let message = match how.message {
                Some(m) => m.to_string(),
                None => squash_message(
                    &view.patch.title,
                    &view.patch.body,
                    view.patch.number,
                    &git::authors(dir, base_tip, head).unwrap_or_default(),
                    &author_line(&author),
                ),
            };
            let parents: Vec<&str> = base_tip.into_iter().collect();
            let c = git::commit_tree(dir, &tree, &parents, &message, &author)?;
            (c, "squash commit")
        }
        (MergePlan::FastForward { oid }, Method::Merge) => (oid.clone(), "fast-forward to"),
        (MergePlan::MergeCommit { base, head }, Method::Merge) => {
            let message = format!(
                "Merge pull request #{} from {}\n\n{}",
                view.patch.number,
                view.patch.source_ref_name.as_deref().unwrap_or(head),
                view.patch.title
            );
            let c = git::merge_commit(dir, base, head, &message, &author())?
                .ok_or_else(|| conflict(base, head))?;
            (c, "merge commit")
        }
    };
    steps.ok("merge", format!("{detail} {}", short(&commit)));
    Ok(Some(commit))
}

/// `Name <email>` of a [`git::merge_author`] environment.
fn author_line(env: &[(String, String)]) -> String {
    let get = |k: &str| {
        env.iter()
            .find(|(key, _)| key == k)
            .map_or("", |(_, v)| v.as_str())
    };
    format!("{} <{}>", get("GIT_AUTHOR_NAME"), get("GIT_AUTHOR_EMAIL"))
}

/// A squash commit's message (review-parity M1): the PR title with its number, the body, and
/// a `Co-authored-by` trailer for each commit author other than the committer.
pub(crate) fn squash_message(
    title: &str,
    body: &str,
    number: u32,
    authors: &[String],
    committer: &str,
) -> String {
    let mut m = format!("{title} (#{number})");
    if !body.trim().is_empty() {
        m.push_str("\n\n");
        m.push_str(body.trim_end());
    }
    let co: Vec<&String> = authors.iter().filter(|a| *a != committer).collect();
    if !co.is_empty() {
        m.push_str("\n\n");
        for a in co {
            m.push_str("Co-authored-by: ");
            m.push_str(a);
            m.push('\n');
        }
        m.truncate(m.trim_end().len());
    }
    m
}

/// Run `git push` (`argv`) in `dir` for `goal` ("merge failed", "suggestions not applied"),
/// surfacing the helper's own E-coded error when it refused.
pub(crate) fn push_to(
    dir: &Path,
    argv: &[String],
    env: &git::DashEnv<'_>,
    goal: &str,
) -> Result<()> {
    let out = env
        .git_command()?
        .current_dir(dir)
        .args(argv)
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
            .map_or("the push was rejected", |l| {
                l.trim_start_matches("dash: ").trim_start_matches("error: ")
            })
            .replace(&format!("[{code}]"), "")
            .trim()
            .to_string();
        let code = forge_core::user_error::catalogued(code).unwrap_or(codes::REJECTED);
        return Err(UserError::new(code, format!("{goal}: {headline}"))
            .cause(text.replace("dash: ", ""))
            .into());
    }
    anyhow::bail!("{goal}: git push failed: {text}")
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
    /// Whether the target repository is private (its fetches need the key).
    private: bool,
}

async fn locate(ctx: &Ctx, repo: &str, number: u64) -> Result<Located> {
    let s = Reader::open(ctx, repo).await?;
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
        private: s.repo.visibility == forge_core::rules::v2::Visibility::Private,
    })
}

/// Fetch a PR head into the repository at `cwd` from `dash://<source>` (fixed refspec —
/// the PR's own `sourceRefName` is attacker-chosen and never used as one).
fn fetch_head(ctx: &Ctx, cwd: &Path, source: &str, head: &str, private: bool) -> Result<bool> {
    if source.is_empty() || git::has_object(cwd, head) {
        return Ok(false);
    }
    let url = format!("dash://{source}");
    git::git_dash(
        cwd,
        &[
            "fetch",
            "-q",
            &url,
            &format!("+refs/heads/*:refs/remotes/dash-pr/{source}/*"),
        ],
        &read_env(ctx, private)?,
    )
    .context("fetching the PR head from its source repository")?;
    Ok(true)
}

async fn checkout(ctx: &Ctx, repo: &str, number: u64) -> Result<()> {
    let Located {
        source,
        head,
        private,
        ..
    } = locate(ctx, repo, number).await?;
    let cwd = std::env::current_dir()?;
    let fetched = fetch_head(ctx, &cwd, &source, &head, private)?;
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
        private,
    } = locate(ctx, repo, number).await?;
    git::require_branch_ref(&base_ref)?;
    let cwd = std::env::current_dir()?;
    fetch_head(ctx, &cwd, &source, &head, private)?;
    // The base as the target repo has it now, fetched fresh.
    let base_local = format!("refs/remotes/dash-pr/base-{number}");
    git::git_dash(
        &cwd,
        &[
            "fetch",
            "-q",
            &format!("dash://{target}"),
            &format!("+{base_ref}:{base_local}"),
        ],
        &read_env(ctx, private)?,
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

    fn view_with(base: &str, head: &str) -> PatchView {
        let patch = Patch {
            number: 1,
            document_id: "d".into(),
            repo_id: "r".into(),
            author: "a".into(),
            title: "t".into(),
            body: String::new(),
            base_ref_name: base.into(),
            source_repo_id: "s".into(),
            source_ref_name: Some("refs/heads/f".into()),
            head_oid: head.into(),
            patch_manifest_hash: None,
            created_at: 0,
            imported: None,
            upstream_number: None,
        };
        PatchView {
            state: forge_core::rules::PrState::default(),
            head: head.into(),
            review: forge_core::rules::v2::fold_pr_review_v2(
                &[],
                &[],
                "a",
                head,
                &std::collections::BTreeSet::new(),
            ),
            base_tip: Some("1".repeat(40)),
            head_on_base: false,
            base_tips: std::collections::BTreeSet::new(),
            log: forge_core::collab::v2::TargetLog::default(),
            patch,
        }
    }

    /// A merge is recorded only from an open, ready PR (`c3_mergedAfter`): a draft or closed
    /// PR is refused before anything is pushed to the base.
    #[test]
    fn only_an_open_ready_pr_is_merged() {
        let ok = "2".repeat(40);
        let with = |open: bool, draft: bool| {
            let mut v = view_with("refs/heads/main", &ok);
            v.state.open = open;
            v.state.draft = draft;
            v
        };
        assert!(refuse_unmergeable(&with(true, false), 3).is_ok());
        let draft = refuse_unmergeable(&with(true, true), 3).unwrap_err();
        assert!(format!("{draft:#}").contains("it is a draft"), "{draft:#}");
        let closed = refuse_unmergeable(&with(false, false), 3).unwrap_err();
        assert!(format!("{closed:#}").contains("it is closed"), "{closed:#}");
        assert!(refuse_unmergeable(&with(false, true), 3).is_err());
    }

    /// `update-branch`, `suggestion apply`, `merge` and `commits` all fetch through
    /// `fetch_base_and_head`: a malformed base or head is refused before any git runs.
    #[test]
    fn a_malformed_base_or_head_never_reaches_git() {
        let ok = "2".repeat(40);
        assert!(require_git_safe(&view_with("refs/heads/main", &ok)).is_ok());
        for bad in [
            "+refs/heads/x:refs/heads/main",
            "refs/heads/*",
            "refs/tags/v1",
            "main",
            "refs/heads/-x --upload-pack=evil",
            "refs/heads/a\nb",
        ] {
            assert!(require_git_safe(&view_with(bad, &ok)).is_err(), "{bad:?}");
            let dir = tempfile::tempdir().unwrap();
            let err = fetch_base_and_head(
                dir.path(),
                &dummy_repo(),
                &view_with(bad, &ok),
                &git::DashEnv::default(),
            )
            .unwrap_err();
            assert!(
                format!("{err:#}").contains("not a plain branch"),
                "{bad:?}: {err:#}"
            );
        }
        assert!(require_git_safe(&view_with("refs/heads/main", "HEAD~1")).is_err());
    }

    fn dummy_repo() -> Repo {
        Repo {
            forge: forge_core::network::ForgeIds::test_forge(),
            repo_id: "r".into(),
            owner_id: "o".into(),
            name: "n".into(),
            visibility: forge_core::rules::v2::Visibility::Public,
        }
    }

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
    fn required_checks_that_do_not_all_pass_refuse_the_merge_with_e804() {
        use forge_core::rules::v2::{
            checks_state, CheckRunRow, ChecksPolicy, Membership, Role, RoleOracle,
        };
        let head = "ab".repeat(20);
        let run =
            |id: &str, by: &str, at: u64, status: &str, conclusion: Option<&str>| CheckRunRow {
                id: id.into(),
                head_oid: head.clone(),
                name: "build".into(),
                status: status.into(),
                conclusion: conclusion.map(Into::into),
                reporter: by.into(),
                created_at: at,
            };
        let oracle = RoleOracle::new(vec![Membership {
            identity: "m".into(),
            role: Role::Writer,
            created_at: 0,
        }]);
        let runners = std::collections::BTreeSet::from(["r".to_string()]);
        let policy = ChecksPolicy {
            require_checks: true,
            required_checks: vec![],
        };
        // The runner's newer failing run decides it, over the writer's older passing one.
        let runs = [
            run("1", "m", 1, "completed", Some("success")),
            run("2", "r", 2, "completed", Some("failure")),
        ];
        let state = checks_state(&runs, &head, &oracle, &runners, &policy);
        let u = checks_refusal(&state, "o/r", 7).unwrap();
        assert_eq!(u.code, "E804");
        assert!(u.to_json().to_string().contains("build failing"), "{u:?}");
        // A stranger's newer passing run changes nothing.
        let runs = [
            run("2", "r", 2, "completed", Some("failure")),
            run("3", "x", 3, "completed", Some("success")),
        ];
        assert!(checks_refusal(
            &checks_state(&runs, &head, &oracle, &runners, &policy),
            "o/r",
            7
        )
        .is_some());
        // No run at all: refused.
        assert!(checks_refusal(
            &checks_state(&[], &head, &oracle, &runners, &policy),
            "o/r",
            7
        )
        .is_some_and(|u| u
            .cause
            .as_deref()
            .is_some_and(|c| c.contains("no member or runner"))));
        // Passing: merge allowed.
        let runs = [run("4", "r", 4, "completed", Some("success"))];
        assert!(checks_refusal(
            &checks_state(&runs, &head, &oracle, &runners, &policy),
            "o/r",
            7
        )
        .is_none());
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
    fn a_squash_message_credits_every_other_author() {
        let m = squash_message(
            "Add x",
            "Body\n",
            7,
            &["A <a@x>".into(), "Me <me@x>".into(), "B <b@x>".into()],
            "Me <me@x>",
        );
        assert_eq!(
            m,
            "Add x (#7)\n\nBody\n\nCo-authored-by: A <a@x>\nCo-authored-by: B <b@x>"
        );
        assert_eq!(squash_message("T", "", 1, &[], "Me <m>"), "T (#1)");
    }

    #[test]
    fn estimates_follow_the_measured_model() {
        assert_eq!(estimate(Est::Comment, 0), 47_300_000);
        assert_eq!(estimate(Est::Review, 300), 34_900_000 + 300 * 27_500);
        // Review-parity §4.1: a 300-byte summary and 6 × 150-byte comments ≈ 0.0035 DASH.
        let total = estimate(Est::Review, 300) + 6 * estimate(Est::Comment, 150);
        assert!((340_000_000..360_000_000).contains(&total), "{total}");
    }
}
