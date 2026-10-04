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
use crate::fmt::{cost_json, cost_line, safe, short, transition_route_text};
use crate::git::{self, MergePlan};
use crate::PrCommand;

/// Where a PR comment's id is listed, for a refused comment id.
const PR_COMMENT_IDS: &str = "`dg pr view <repo> <n> --comments --json`";

/// Refuse a comment or review id argument that cannot be a document id, before any read
/// (QW2-076).
fn check_id_args(cmd: &PrCommand) -> Result<()> {
    use crate::common::document_id_arg;
    match cmd {
        PrCommand::Resolve { comment_id, .. } | PrCommand::Unresolve { comment_id, .. } => {
            document_id_arg(comment_id, "comment id", PR_COMMENT_IDS)
        }
        PrCommand::DismissReview { review_id, .. } => document_id_arg(
            review_id,
            "review id",
            "`dg pr view <repo> <n> --json` (`reviews[].id`)",
        ),
        PrCommand::Suggestion(crate::PrSuggestionCommand::Apply { comment_ids, .. }) => comment_ids
            .iter()
            .try_for_each(|id| document_id_arg(id, "comment id", PR_COMMENT_IDS)),
        _ => Ok(()),
    }
}

/// Dispatch a `pr` subcommand.
#[allow(clippy::too_many_lines)] // one arm per subcommand
pub async fn run(ctx: &Ctx, cmd: &PrCommand) -> Result<()> {
    use crate::PrSuggestionCommand as Sg;
    check_id_args(cmd)?;
    match cmd {
        PrCommand::Create(args) => create(ctx, args).await,
        PrCommand::List {
            repo,
            limit,
            state,
            include_hidden,
        } => list(ctx, repo, *limit, *state, *include_hidden).await,
        PrCommand::View {
            repo,
            number,
            comments,
            show_hidden,
        } => view(ctx, repo, *number, *comments, *show_hidden).await,
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
        PrCommand::Lock { repo, number, off } => state::set_locked(ctx, repo, *number, !off).await,
        PrCommand::Hide {
            repo,
            number,
            comment,
            review,
            reason,
            off,
        } => {
            let item = match (comment, review) {
                (Some(c), _) => Some(("comment", c.as_str())),
                (None, Some(r)) => Some(("review", r.as_str())),
                (None, None) => None,
            };
            state::hide(
                ctx,
                repo,
                *number,
                item,
                reason.map(crate::HideReasonArg::as_str),
                !off,
            )
            .await
        }
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

/// A `refUpdate` a push to the PR branch pays, priced as `git push` prices one (a ref's first
/// update, the upper bound): bonsia charged 56.8M-92M (QW2-020; this was a steady 45M).
pub const REF_UPDATE_CREDITS: u64 = forge_core::cost::push_fees::REF_FIRST;

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

/// The stable three-value `"state"` field in JSON output: `merged`, `closed` or `open`. Draft is
/// already its own boolean field (`"draft"`), so unlike [`state_label`] this never returns
/// `"draft"` — a consumer filtering on `state=="open"` (as `gh`'s `state: OPEN` / `isDraft` split
/// encourages) must keep seeing open drafts as `open`.
pub(crate) fn state_field(v: &PatchView) -> &'static str {
    if v.state.merged {
        "merged"
    } else if !v.state.open {
        "closed"
    } else {
        "open"
    }
}

/// The label `dg pr list` / `dg pr view` print for a PR's state in plain text: `merged`
/// (terminal), `closed` (state code 1 or 9 — closed takes precedence over draft, as the web's
/// `pullStatus` does), `draft` (open, state code 8) or `open`. JSON output uses [`state_field`]
/// instead, since it already carries a separate `"draft"` boolean.
pub(crate) fn state_label(v: &PatchView) -> &'static str {
    if v.state.merged {
        "merged"
    } else if !v.state.open {
        "closed"
    } else if v.state.draft {
        "draft"
    } else {
        "open"
    }
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

#[allow(clippy::too_many_lines)]
async fn create(ctx: &Ctx, args: &crate::PrCreateArgs) -> Result<()> {
    let mut s = Session::open(ctx, &args.repo).await?;
    // In a clone of a fork with no repository named, the PR goes to the fork's parent, with
    // the fork as its source, as `gh pr create` does (QW2-014). Naming the fork opens it
    // there.
    let fork = if crate::infer::repo_from_clone() {
        into_fork_parent(&mut s).await?
    } else {
        None
    };
    s.refuse_if_archived(ctx, "pull request not created")
        .await?;
    let handle = &s.repo;
    let forge = handle.forge();
    let cwd = std::env::current_dir().context("reading the current directory")?;

    // Where the branch may live: --head-repo, else (in a fork's clone) that fork, else the
    // signer's forks of the target, then the target itself. The first that has the branch is
    // the source.
    let candidates = if let Some(r) = &args.head_repo {
        vec![resolve(&s.client, &s.identity, &RepoRef::parse(r)?).await?]
    } else if let Some(fork) = fork {
        vec![fork, handle.clone()]
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
    let journal = default_journal_dir()?;
    // An interrupted create of this same PR resumes (it is not a second PR).
    if !s.collab().patch_create_pending(handle, &input, &journal)? {
        refuse_duplicate(&s, handle, &source, &head_ref, &base, args.draft).await?;
    }
    if !ctx.json {
        println!(
            "Open PR {title:?} in {}: {} {head_ref} ({}) → {base}",
            handle.display(),
            source.display(),
            short(&head_oid)
        );
    }
    // The PR's title, body and ref names are its text (QW2-020: this was a fixed "~0.0001").
    let text = input.title.len()
        + input.body.len()
        + input.base_ref_name.len()
        + input.source_ref_name.as_deref().map_or(0, str::len);
    let pr_quote = crate::quote::target_create(text as u64);
    let price = ctx.usd_price();
    ctx.confirm_or_cancel(&if args.draft {
        format!(
            "Open it as a draft? (the PR and a draft transition: two documents, {})",
            cost_line(pr_quote + crate::quote::TRANSITION, price)
        )
    } else {
        format!("Open it? (one document, {})", cost_line(pr_quote, price))
    })?;
    let before = s.balance().await;
    let created = s.collab().create_patch(handle, &input, &journal).await?;
    let spent = s.spent_since(before).await;
    ctx.emit(
        json!({
            "status": "created",
            "number": created.number,
            "documentId": created.document_id,
            "id": created.document_id,
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

/// When the session's repository is a fork, point the session at the fork's parent and
/// return the fork; `None` (the session unchanged) when it is not one, or its parent is gone.
async fn into_fork_parent(s: &mut Session) -> Result<Option<Repo>> {
    let Some(parent_id) = forge_core::resolve::fork_parent(&s.client, &s.repo)
        .await
        .context("reading whether this clone's repository is a fork")?
    else {
        return Ok(None);
    };
    let parent = match forge_core::resolve::resolve_id(&s.client, &parent_id).await {
        Ok(p) => p,
        Err(forge_core::Error::NotFound) => {
            eprintln!(
                "note: {} is a fork of {parent_id}, which no longer exists; the PR goes to the fork",
                s.repo.display()
            );
            return Ok(None);
        }
        Err(e) => return Err(e).context("resolving the fork's parent"),
    };
    let fork = std::mem::replace(&mut s.repo, parent);
    // stderr, with --json too: where the PR goes is worth saying either way
    eprintln!(
        "{} is a fork of {}: the PR goes there (`dg pr create {} …` opens it in the fork)",
        fork.display(),
        s.repo.display(),
        fork.display()
    );
    Ok(Some(fork))
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

/// How many of the target's newest PRs a private repository's duplicate check reads (its
/// patches are sealed, so the branch index cannot find them).
const DUPLICATE_SCAN: u32 = 100;

/// At most this many of your PRs from the branch are read in full by the duplicate check.
const DUPLICATE_READS: usize = 20;

/// Refuse a PR when you already have an open one from the same head branch into the same base
/// (E603), as GitHub does: PRs cannot be deleted, so a duplicate is paid for and stays
/// (QW-036). Only your own PRs count, so nobody can block your branch by opening a PR from it
/// first. A public source is found through the `sourceRef` index, whatever the PR's age; a
/// private repository's newest [`DUPLICATE_SCAN`] PRs are read instead. A PR that cannot be
/// read is skipped: the check is advisory, like the role pre-checks.
async fn refuse_duplicate(
    s: &Session,
    target: &Repo,
    source: &Repo,
    head_ref: &str,
    base: &str,
    draft: bool,
) -> Result<()> {
    let collab = s.collab();
    let me = s.identity.id();
    let open: Vec<PatchView> = if target.visibility == forge_core::rules::v2::Visibility::Public
        && source.visibility == forge_core::rules::v2::Visibility::Public
    {
        let mine: Vec<Patch> = collab
            .patches_from_branch(target.forge(), source.id(), head_ref)
            .await?
            .into_iter()
            .filter(|p| p.repo_id == target.id() && p.author == me)
            .take(DUPLICATE_READS)
            .collect();
        let mut views = Vec::new();
        for p in mine {
            // The index saw the raw document; the reader rule (§5) is per repo.
            let read = async {
                match collab.patch(target, p.number).await? {
                    Some(p) => collab.patch_view(target, p).await.map(Some),
                    None => Ok(None),
                }
            };
            match read.await {
                Ok(Some(v)) => views.push(v),
                Ok(None) => {}
                Err(e) => {
                    tracing::warn!(pr = p.number, error = %e, "duplicate check: skipping a pull request that cannot be read");
                }
            }
        }
        views
    } else {
        collab
            .list_patch_views(target, DUPLICATE_SCAN)
            .await?
            .rows
            .into_iter()
            .map(|(v, _)| v)
            .filter(|v| v.patch.author == me)
            .collect()
    };
    let Some(existing) = open
        .iter()
        .find(|v| same_head_and_base(v, source.id(), head_ref, base))
    else {
        return Ok(());
    };
    let n = existing.patch.number;
    let repo = target.display();
    let u = UserError::new(
        codes::ALREADY_EXISTS,
        format!(
            "pull request not created: your #{n} is already open for {} → {}",
            safe(head_ref.trim_start_matches("refs/heads/")),
            safe(base.trim_start_matches("refs/heads/"))
        ),
    )
    .cause(format!(
        "you have an open pull request from this branch into the same base of {repo}; a second one could not be deleted"
    ))
    .fix(format!(
        "push to the branch to update #{n} (`dg pr sync {repo} {n}` moves its head if the push did not)"
    ));
    let u = if draft && !existing.state.draft {
        u.fix(format!("`dg pr draft {repo} {n}` makes it a draft"))
    } else {
        u.fix(format!("`dg pr view {repo} {n}` shows it"))
    };
    Err(u
        .note("checked before anything was signed; nothing was written or paid")
        .into())
}

/// Whether `v` is an open PR from `head_ref` in `source_id` into `base` (after retargets).
fn same_head_and_base(v: &PatchView, source_id: &str, head_ref: &str, base: &str) -> bool {
    v.state.open
        && v.patch.source_repo_id == source_id
        && v.patch.source_ref_name.as_deref() == Some(head_ref)
        && git::full_ref(
            v.state
                .base_ref
                .as_deref()
                .unwrap_or(&v.patch.base_ref_name),
        ) == base
}

// ---------------------------------------------------------------------------
// list / view
// ---------------------------------------------------------------------------

async fn list(
    ctx: &Ctx,
    repo: &str,
    limit: u32,
    state: crate::PrStateArg,
    include_hidden: bool,
) -> Result<()> {
    let s = Reader::open(ctx, repo).await?;
    let handle = &s.repo;
    let collab = s.collab();
    // A fixed number of requests for the whole page (D-500: it was about 9 per PR).
    let page = collab.list_patch_views(handle, limit).await?;
    let (hidden, more) = (page.hidden, page.more);
    let read = page.rows.len();
    let rows: Vec<_> = page
        .rows
        .into_iter()
        .filter(|(v, _)| state.matches(v.state.open, v.state.merged))
        .collect();
    // The PRs the state filter left out, for the empty list's hint.
    let others = read - rows.len();
    // RC2 MOD: the PRs a maintainer hid, from the events already read (the feed).
    let threads: Vec<(forge_core::collab::v2::Target, &[forge_core::rules::Event])> = rows
        .iter()
        .map(|(v, _)| (v.patch.target(), v.log.events.as_slice()))
        .collect();
    let hides = collab.hidden_threads(handle, &threads).await;
    let (rows, omitted) = crate::fmt::split_hidden(
        rows,
        &hides,
        |(v, _)| v.patch.document_id.as_str(),
        include_hidden,
    );
    let names =
        crate::common::hider_names(ctx, &s.client, rows.iter().filter_map(|(_, h)| *h)).await;
    let who = |id: &str| crate::fmt::with_name(id, &names);
    let json_rows: Vec<_> = rows
        .iter()
        .map(|((v, a), h)| {
            crate::fmt::with_hidden_by(
                json!({
                    "number": v.patch.number,
                    "title": v.patch.title,
                    "author": v.patch.author,
                    "state": state_field(v),
                    "baseRef": v.patch.base_ref_name,
                    "baseTip": v.base_tip,
                    "retargetedTo": v.state.base_ref,
                    "headOid": v.head,
                    "repoId": v.patch.repo_id,
                    "sourceRepoId": v.patch.source_repo_id,
                    "sourceRefName": v.patch.source_ref_name,
                    "draft": v.state.draft,
                    "approvals": a.approvers.len(),
                    "changesRequested": a.changes_requested.len(),
                }),
                *h,
            )
        })
        .collect();
    ctx.emit(
        json!({
            "count": rows.len(),
            "prs": json_rows,
            "hidden": hidden,
            "hiddenOmitted": omitted,
            "truncated": more,
            "otherStates": others,
        }),
        || {
            if rows.is_empty() && omitted == 0 {
                // Only the newest `--limit` were read: say so rather than "none".
                let among = if more {
                    format!(" among the newest {read}")
                } else {
                    String::new()
                };
                println!("{}{among}", state.empty("pull requests"));
                if let (true, Some(other)) = (others > 0, state.others()) {
                    println!(
                        "({others} {other}: `--state all` lists {})",
                        if others == 1 { "it" } else { "them" }
                    );
                }
            }
            for ((v, a), h) in &rows {
                let hid = h.map(|h| crate::fmt::hidden_row_mark(h, &who));
                println!("{}", pr_line(v, a, &hid.unwrap_or_default()));
            }
            if let Some(note) = crate::fmt::hidden_rows_note(omitted) {
                println!("{note}");
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

/// One `dg pr list` row: number, state, title, head, approvals and change requests, and `hid`,
/// a hidden PR's mark (`--include-hidden`).
fn pr_line(v: &PatchView, a: &forge_core::rules::v2::Approvals, hid: &str) -> String {
    let count = |mark: &str, n: usize| {
        if n == 0 {
            String::new()
        } else {
            format!("  {mark}{n}")
        }
    };
    let extra = count("✓", a.approvers.len()) + &count("✗", a.changes_requested.len());
    format!(
        "#{:<4} {:<6} {}  ({}){extra}{}",
        v.patch.number,
        state_label(v),
        safe(&v.patch.title),
        short(&v.head),
        safe(hid)
    )
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
async fn view(
    ctx: &Ctx,
    repo: &str,
    number: u64,
    show_comments: bool,
    show_hidden: bool,
) -> Result<()> {
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
    // RC2 MOD: what maintainers hid. Collapsed in the human view unless --show-hidden; a hidden
    // review's verdict still counts (only a dismissal stops it), so approvals are unchanged.
    let moderation = collab
        .hidden_items(handle, &v.patch.target(), &v.log, &comments, &reviews)
        .await?;
    let trusted = |who: &str| {
        who == handle.owner_id()
            || oracle.current_role(who) == Some(forge_core::rules::v2::Role::Maintainer)
    };
    let mut conv = threads::threads(&comments, &v.head, &review_state.resolved_threads);
    // A mirrored hunk shows only from a signer who may mirror (the web's trust set: the owner
    // and the current maintainers), as the web shows it.
    threads::drop_untrusted_hunks(&mut conv, trusted);
    // The conversations as printed: a hidden comment's body is its one "hidden by" line.
    let printed_conv = if show_hidden || moderation.items.is_empty() {
        None
    } else {
        let shown: Vec<_> = comments
            .iter()
            .map(|c| match moderation.item(&c.document_id) {
                Some(h) => forge_core::collab::v2::Comment {
                    body: crate::fmt::hidden_line("comment", h, &|id: &str| id.to_string(), false),
                    ..c.clone()
                },
                None => c.clone(),
            })
            .collect();
        let mut printed = threads::threads(&shown, &v.head, &review_state.resolved_threads);
        threads::drop_untrusted_hunks(&mut printed, trusted);
        Some(printed)
    };
    let rows = threads::reviewer_rows(
        &reviews,
        &review_state,
        &approvals,
        &oracle,
        &v.head,
        &v.patch.author,
    );
    let since = s
        .viewer()
        .and_then(|me| threads::since_your_review(&reviews, &review_state, me));
    let policy = collab.policy(handle).await?;
    let policy_status = policy
        .as_ref()
        .map(|p| forge_core::rules::v2::meets_policy(&approvals, &oracle, p));
    // The policy's required checks on the head, as `dg pr merge` and the web merge box judge
    // them (QW2-011: the approvals alone were shown as "met" while a required check failed).
    // `Err`: they could not be read, which the merge treats as not met.
    // Judged on an open PR only, as the web's merge box: a merged or closed PR has no merge
    // to gate (a later run on its head says nothing about how it was merged).
    let judged = v.state.open;
    let checks = match &policy {
        Some(p) if judged => required_checks(&collab, handle, &v, &oracle, p)
            .await
            .map_err(|e| format!("{e:#}")),
        _ => Ok(None),
    };
    let unmet = if let (Some(p), Some(st), true) = (&policy, &policy_status, judged) {
        let mut u = unmet_rules(p, st, checks.as_ref().ok().and_then(Option::as_ref));
        if checks.is_err() {
            u.push("required checks: could not be read".to_string());
        }
        u
    } else {
        Vec::new()
    };
    let bypasses = policy_bypasses(&v);
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
    let standing = json!({
        // Each required check's run on the head (the names are `policy.requiredChecks`).
        "requiredCheckRuns": checks.as_ref().ok().cloned().flatten(),
        "requiredCheckRunsError": checks.as_ref().err(),
        // The whole policy (approvals and checks), judged on an open PR only; `approvals` is
        // the count alone (QW4-060: `policyStatus.met` and `policyMet` said different things).
        "policyMet": policy.as_ref().filter(|_| judged).map(|_| unmet.is_empty()),
        "unmetRules": unmet,
        "policyBypasses": bypasses.iter().map(|b| json!({
            "id": b.id, "actor": b.actor, "rules": b.value, "mergeOid": b.oid, "createdAt": b.created_at,
            "namesThisMerge": merged_at(&v, b.oid.as_deref().unwrap_or_default()),
        })).collect::<Vec<_>>(),
    });
    let mut out = json!({
            "number": v.patch.number,
            "id": v.patch.document_id,
            "repoId": v.patch.repo_id,
            "title": v.patch.title,
            "body": v.patch.body,
            "author": v.patch.author,
            "state": state_field(&v),
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
            // The shape `dg repo policy show --json` prints (QW4-060: raw integers here).
            "policy": policy.as_ref().map(crate::repo_settings::policy_json),
            "approvals": policy_status.as_ref().map(|s| json!({ "have": s.have, "need": s.need })),
            "reviews": reviews_json,
            "threads": conv.threads,
            "generalComments": conv.general,
            "comments": comments_json(&comments),
            "hiddenComments": hidden_comments,
            "hiddenReviews": hidden_reviews,
            "moderation": moderation,
            "hiddenEventValues": v.log.hidden_values,
            "plaintextEventValues": v.log.plaintext_values,
    });
    if let (Some(o), serde_json::Value::Object(extra)) = (out.as_object_mut(), standing) {
        o.extend(extra);
    }
    // DPNS names for the human view, as `dg issue view` shows them (QW3-070), read together;
    // a failed read shows the bare id.
    let names = if ctx.json {
        std::collections::BTreeMap::default()
    } else {
        let ids = std::iter::once(v.patch.author.as_str())
            .chain(v.state.assignees.iter().map(String::as_str))
            .chain(approvals.approvers.iter().map(String::as_str))
            .chain(approvals.changes_requested.iter().map(String::as_str))
            .chain(rows.iter().map(|r| r.identity.as_str()))
            .chain(reviews.iter().map(|r| r.reviewer.as_str()))
            .chain(bypasses.iter().map(|b| b.actor.as_str()))
            // who hid the thread or a review, for its "hidden by" line
            .chain(moderation.thread.iter().map(|h| h.by.as_str()))
            .chain(moderation.items.values().map(|h| h.by.as_str()));
        client.dpns_first_names(ids).await
    };
    let who = |id: &str| crate::fmt::with_name(id, &names);
    ctx.emit(
        out,
        || {
            println!(
                "#{} [{}] {}",
                v.patch.number,
                state_label(&v),
                safe(&v.patch.title)
            );
            println!("author: {}", who(&v.patch.author));
            if let Some(h) = &moderation.thread {
                println!("{}", crate::fmt::hidden_line("this pull request", h, &who, show_hidden));
                if !show_hidden {
                    return;
                }
            }
            println!(
                "{} {} ({}) → {}",
                source,
                safe(v.patch.source_ref_name.as_deref().unwrap_or("(no branch)")),
                short(&v.head),
                safe(&v.patch.base_ref_name)
            );
            let labels: Vec<&str> = v.state.labels.iter().map(String::as_str).collect();
            let assignees: Vec<String> = v.state.assignees.iter().map(|a| who(a)).collect();
            let milestone = review_state.milestone.as_deref();
            for line in crate::fmt::triage_lines(&labels, &assignees, milestone) {
                println!("{line}");
            }
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
                let by: Vec<_> = approvals.approvers.iter().map(|a| who(a)).collect();
                println!(
                    "approved by {} on {}: {}",
                    by.len(),
                    short(&v.head),
                    by.join(", ")
                );
            }
            if !approvals.changes_requested.is_empty() {
                let by: Vec<_> = approvals.changes_requested.iter().map(|a| who(a)).collect();
                println!("changes requested by {}", by.join(", "));
            }
            if let (Some(p), Some(st)) = (&policy, &policy_status) {
                let approvals = format!(
                    "{} of {} required approval{}{}",
                    st.have,
                    st.need,
                    if st.need == 1 { "" } else { "s" },
                    if p.approver_role == 1 { " (maintainers)" } else { "" },
                );
                if !judged {
                    println!("policy: {approvals}");
                } else if unmet.is_empty() {
                    println!("policy: met ({approvals})");
                } else {
                    // Rule text carries check names reported by members and runners.
                    println!("policy: not met: {}", safe(&unmet.join("; ")));
                }
                if let Some(line) = checks_words(&checks) {
                    println!("required checks: {line}");
                }
            }
            for b in &bypasses {
                let rules = safe(b.value.as_deref().unwrap_or("rules not readable here"));
                let oid = b.oid.as_deref().unwrap_or_default();
                if merged_at(&v, oid) {
                    println!(
                        "! merged by bypassing the branch rules ({rules}), by {} at {}",
                        who(&b.actor),
                        short(oid)
                    );
                } else {
                    // Any member can write the event: one that names no merge of this PR
                    // records a claim, not a merge.
                    println!(
                        "! {} recorded a branch-rules bypass ({rules}) naming {}, which is not this PR's merge",
                        who(&b.actor),
                        short(oid)
                    );
                }
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
                    println!("  {}  {}{extra}", who(&r.identity), r.state.label());
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
                    who(&r.reviewer),
                    short(&r.commit_oid),
                    short(&r.document_id)
                );
                if let Some(h) = moderation.item(&r.document_id) {
                    // Still counted: hiding is display only (dismiss to stop it counting).
                    println!(
                        "  {} (its verdict still counts unless dismissed)",
                        crate::fmt::hidden_line("review", h, &who, show_hidden)
                    );
                    if !show_hidden {
                        continue;
                    }
                }
                if !r.body.is_empty() {
                    println!("  {}", safe(&r.body));
                }
            }
            if show_comments {
                print_conversations(printed_conv.as_ref().unwrap_or(&conv));
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

/// The PR's policy-bypass events (kind 23): the record of each merge that bypassed the branch
/// rules, oldest first.
fn policy_bypasses(v: &PatchView) -> Vec<&forge_core::rules::Event> {
    let mut out: Vec<_> = v
        .log
        .events
        .iter()
        .filter(|e| e.kind == forge_core::rules::EventKind::PolicyBypass)
        .collect();
    out.sort_by(|a, b| (a.created_at, &a.id).cmp(&(b.created_at, &b.id)));
    out
}

/// Whether a merge `transition` of the PR names `oid` (a policy-bypass event is shown as the
/// merge's only when it names that merge).
fn merged_at(v: &PatchView, oid: &str) -> bool {
    !oid.is_empty()
        && v.log.transitions.iter().any(|t| {
            t.kind == forge_core::rules::transition::PR_MERGE
                && t.oid
                    .as_deref()
                    .is_some_and(|o| o.eq_ignore_ascii_case(oid))
        })
}

/// `dg pr view`'s line for the policy's required checks: "build passed, lint failing"; `None`
/// when none are judged.
fn checks_words(
    checks: &std::result::Result<Option<forge_core::rules::v2::ChecksState>, String>,
) -> Option<String> {
    match checks {
        Err(_) => Some("could not be read".to_string()),
        Ok(None) => None,
        Ok(Some(c)) if c.required.is_empty() => Some("none reported on the head".to_string()),
        Ok(Some(c)) => Some(
            c.required
                .iter()
                .map(|r| format!("{} {}", safe(&r.name), check_word(r.state)))
                .collect::<Vec<_>>()
                .join(", "),
        ),
    }
}

/// A required check's state in `dg`'s words ("passed", "failing", "pending", "missing").
fn check_word(state: forge_core::rules::v2::CheckState) -> &'static str {
    use forge_core::rules::v2::CheckState;
    match state {
        CheckState::Passed => "passed",
        CheckState::Failing => "failing",
        CheckState::Pending => "pending",
        CheckState::Missing => "missing",
    }
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
        if let Some(h) = &t.diff_hunk {
            for line in safe(h).lines() {
                println!("    │ {line}");
            }
        }
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
    let price = ctx.usd_price();
    ctx.confirm_or_cancel(&format!(
        "{verb} PR #{number}? (one transition, {})",
        cost_line(crate::quote::TRANSITION, price)
    ))?;
    let action = if close {
        StateAction::Close
    } else {
        StateAction::Reopen
    };
    let target = p.target();
    let (change, spent) = s
        .metered(|| collab.set_state(&s.repo, &target, action, None))
        .await?;
    ctx.emit(
        json!({
            "status": if close { "closed" } else { "reopened" },
            "pr": number,
            "via": change.route,
            "transitionId": change.transition_id,
            "kind": change.kind,
            // a closed draft stays a draft (kind 16/17)
            "draft": forge_core::rules::v2::status_of_code(change.after).draft,
            "cost": cost_json(spent, price),
        }),
        || {
            println!(
                "✓ {} PR #{number} {} · {}",
                if close { "closed" } else { "reopened" },
                transition_route_text(change.route),
                cost_line(spent, price)
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
    /// The PR's commits replayed on the base (`git rebase --merge`), then a fast-forward.
    Rebase,
}

impl Method {
    /// `merge` / `squash` (`--json`'s `method`).
    fn as_str(self) -> &'static str {
        match self {
            Method::Merge => "merge",
            Method::Squash => "squash",
            Method::Rebase => "rebase",
        }
    }
}

#[allow(clippy::too_many_lines)]
async fn merge(ctx: &Ctx, a: &crate::PrMergeArgs) -> Result<()> {
    let (repo, number, event_only) = (a.repo.as_str(), a.number, a.event_only);
    let method = if a.squash {
        Method::Squash
    } else if a.rebase {
        Method::Rebase
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
    // A squash's or a rebase's method is known now; a merge's (fast-forward or merge commit)
    // once planned.
    let method_bit = match method {
        Method::Squash => Some(METHOD_SQUASH),
        Method::Rebase => Some(METHOD_REBASE),
        Method::Merge => None,
    };
    let MergeRights { policy, bypassed } = require_merge_rights(
        &s,
        handle,
        &view,
        !event_only,
        method_bit,
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
    // GitHub's "Some checks were not successful": checks on the head that are not passing, and
    // that the branch policy did not already refuse (it requires none, or none of these), are a
    // warning, never a refusal (QW-083: `dg pr merge` merged over a failing lint run silently).
    let not_passing = if bypassed.is_empty() {
        head_checks_not_passing(&collab, handle, &view, policy.as_ref()).await
    } else {
        Vec::new()
    };
    // The push publishes a history index only into the default branch (an unread default
    // counts as it, the dearer case).
    let push = if event_only {
        None
    } else {
        let default = default_branch_of(&s, handle).await;
        Some(crate::quote::MergePush {
            history_index: default.is_none_or(|d| git::full_ref(&d) == view.patch.base_ref_name),
            platform_bytes: merge_stores_on_platform(),
            // A pull request from a fork: its commits go into the base as a new pack. A squash
            // writes a new commit, uploaded the same way (QW4-046: it was left out). A merge
            // commit is known only once planned: the prompt says new objects come on top.
            // --no-ff writes a merge commit whatever the plan; a rebase writes new commits
            // unless the head is already on the base tip.
            uploads_pack: view.patch.source_repo_id != handle.id()
                || method != Method::Merge
                || a.no_ff,
        })
    };
    // QW3-021: the open issues the description closes ("Fixes #12"), closed after the merge as
    // the web's merge box does (`--keep-linked-open` leaves them).
    let Linked {
        open: linked,
        omitted,
        imported,
    } = if a.keep_linked_open {
        Linked::default()
    } else {
        linked_open_issues(&collab, handle, &view).await
    };
    if !ctx.json && omitted > 0 {
        eprintln!(
            "note: the description closes {omitted} more issue(s) than a merge closes ({LINKED_ISSUES_MAX}); close them from their pages"
        );
    }
    if !ctx.json && imported {
        eprintln!(
            "note: this PR was imported: its `Fixes #n` are the source forge's numbers, so no issue here is closed by the merge (the web's merge box maps them)"
        );
    }
    // A bypass is recorded as one more event naming the rules it bypassed (QW4-046: the quote
    // left it out, and a squash with `--override-policy` charged 13 % over it).
    let bypass_quote = if bypassed.is_empty() {
        0
    } else {
        crate::quote::event(bypass_value(&bypassed).len() as u64, false)
    };
    let merge_quote = crate::quote::merge(push, delete.is_some())
        + crate::quote::TRANSITION * linked.len() as u64
        + bypass_quote;
    let mut steps = Steps::new(ctx.json);
    if !ctx.json && !not_passing.is_empty() {
        eprintln!(
            "warning: some checks on the head are not passing: {} (`dg pr checks {repo} {number}` shows the runs)",
            not_passing.join(", ")
        );
    }
    if !ctx.json {
        eprintln!(
            "Merging PR #{number} of {} into {}{}",
            handle.display(),
            view.patch.base_ref_name,
            match method {
                Method::Squash => " (squash)",
                Method::Rebase => " (rebase)",
                Method::Merge => "",
            }
        );
    }
    ctx.confirm_or_cancel(&format!(
        "Merge PR #{number}{}? ({}{}{}{}; {}, plus Platform storage for any new objects)",
        if not_passing.is_empty() {
            String::new()
        } else {
            format!(" although {} not passing", plural_checks(not_passing.len()))
        },
        if event_only {
            "records the merge only"
        } else {
            "pushes to the base branch, then records the merge"
        },
        bypass_clause(&bypassed),
        if delete.is_some() {
            ", then deletes the source branch"
        } else {
            ""
        },
        closes_phrase(&linked),
        cost_line(merge_quote, ctx.usd_price())
    ))?;

    // What the merge costs: the push (the helper pays from this identity) and the events.
    let before = s.balance().await;
    let merge_oid = if let Some(oid) = merge_oid {
        steps.ok("plan", format!("record only, naming {}", short(&oid)));
        oid
    } else {
        let how = MergeHow {
            method,
            message: a.message.as_deref(),
            no_ff: a.no_ff,
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

    // A maintainer's bypass is recorded on the PR as a policy-bypass `event` (kind 23), where
    // every reader sees it: GitHub's bypass is a timeline event the actor cannot delete, and an
    // `event` is immutable and non-deletable (a comment was neither). The merge stands if this
    // fails; say so.
    if !bypassed.is_empty() {
        let value = bypass_value(&bypassed);
        let posted = async {
            let oid = hex::decode(&merge_oid).context("merge oid")?;
            Ok::<_, anyhow::Error>(
                collab
                    .post_event(
                        handle,
                        &view.patch.target(),
                        forge_core::rules::EventKind::PolicyBypass,
                        Some(&value),
                        Some(&oid),
                    )
                    .await?,
            )
        }
        .await;
        match posted {
            Ok(id) => steps.ok(
                "bypass",
                format!("recorded ({}) in event {}", bypassed.join("; "), short(&id)),
            ),
            Err(e) => {
                if !ctx.json {
                    eprintln!("  ✗ bypass    the merge stands; recording the bypass failed: {e:#}");
                }
                steps
                    .done
                    .push(json!({ "step": "bypass", "ok": false, "detail": format!("{e:#}") }));
            }
        }
    }

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

    // The linked issues, once the merge is recorded. The merge stands if one fails; say so.
    let mut closed_issues = Vec::new();
    for (n, target) in &linked {
        match collab
            .set_state(handle, target, StateAction::Close, None)
            .await
        {
            Ok(_) => {
                closed_issues.push(*n);
                steps.ok("close", format!("issue #{n}"));
            }
            Err(e) => {
                if !ctx.json {
                    eprintln!("  ✗ close     the merge stands; closing issue #{n} failed: {e:#}");
                }
                steps.done.push(
                    json!({ "step": "close", "issue": n, "ok": false, "detail": format!("{e:#}") }),
                );
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
    let spent = s.spent_since(before).await;
    let price = ctx.usd_price();
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
            "bypassedRules": bypassed,
            "checksNotPassing": not_passing,
            "closedIssues": closed_issues,
            "linkedIssuesOmitted": omitted,
            "linkedIssuesImported": imported,
            "cost": cost_json(spent, price),
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
            println!("  cost: {}", cost_line(spent, price));
        },
    );
    Ok(())
}

/// The most linked issues a merge closes, as the web's merge box offers (`LINKED_ISSUES_MAX`).
const LINKED_ISSUES_MAX: usize = 10;

/// What a merge does to the issues its description closes ([`linked_open_issues`]).
#[derive(Default)]
struct Linked {
    /// The open ones it closes, with their targets.
    open: Vec<(u32, forge_core::collab::v2::Target)>,
    /// Numbers past [`LINKED_ISSUES_MAX`], left alone (and said).
    omitted: usize,
    /// The PR was imported: its `#n` are the source forge's numbers, so none is closed.
    imported: bool,
}

/// The open issues `view`'s description closes ("Fixes #12", [`linked_issues`]), never the PR
/// itself (issues and PRs share one numbering), at most [`LINKED_ISSUES_MAX`], read together.
/// An imported PR's `#n` are the source forge's numbers, not this repository's: none (the web's
/// merge box maps them through the mirror). One that cannot be read is left out (the merge does
/// not wait on it).
async fn linked_open_issues(collab: &Collab<'_>, handle: &Repo, view: &PatchView) -> Linked {
    let numbers: Vec<u32> = forge_core::rules::review::linked_issues(&view.patch.body)
        .into_iter()
        .filter(|n| *n != view.patch.number)
        .collect();
    if view.patch.imported.is_some() {
        return Linked {
            imported: !numbers.is_empty(),
            ..Linked::default()
        };
    }
    let omitted = numbers.len().saturating_sub(LINKED_ISSUES_MAX);
    let reads = numbers
        .into_iter()
        .take(LINKED_ISSUES_MAX)
        .map(|n| async move {
            let issue = collab.issue(handle, n).await.ok().flatten()?;
            let target = issue.target();
            let code = collab.state_sum(handle, &target.id).await.ok()?;
            forge_core::rules::v2::status_of_code(code)
                .open
                .then_some((n, target))
        });
    Linked {
        open: futures::future::join_all(reads)
            .await
            .into_iter()
            .flatten()
            .collect(),
        omitted,
        imported: false,
    }
}

/// `, then closes issues #1, #3` for the merge prompt (empty when none).
fn closes_phrase(linked: &[(u32, forge_core::collab::v2::Target)]) -> String {
    match linked {
        [] => String::new(),
        [(n, _)] => format!(", then closes issue #{n}"),
        many => format!(
            ", then closes issues {}",
            many.iter()
                .map(|(n, _)| format!("#{n}"))
                .collect::<Vec<_>>()
                .join(", ")
        ),
    }
}

/// "1 check is" / "2 checks are".
fn plural_checks(n: usize) -> String {
    if n == 1 {
        "1 check is".to_string()
    } else {
        format!("{n} checks are")
    }
}

/// The checks on the PR head whose newest trusted run is not passing ("lint failing"), that
/// the branch policy did not already judge: the policy refuses (or a bypass records) a required
/// check that is not passing, so those are left out. Best effort: empty when unreadable.
async fn head_checks_not_passing(
    collab: &Collab<'_>,
    handle: &Repo,
    view: &PatchView,
    policy: Option<&forge_core::rules::review::Policy>,
) -> Vec<String> {
    let judged: std::collections::BTreeSet<&str> = match policy {
        Some(p) if checks_judged(p) && p.required_checks.is_empty() => return Vec::new(),
        Some(p) => p.required_checks.iter().map(String::as_str).collect(),
        None => std::collections::BTreeSet::new(),
    };
    let Ok(oracle) = collab.member_oracle(handle).await else {
        return Vec::new();
    };
    let every = forge_core::rules::v2::ChecksPolicy {
        require_checks: true,
        required_checks: Vec::new(),
        required_check_sources: Vec::new(),
    };
    match collab
        .head_checks(handle, &view.head, &oracle, &every)
        .await
    {
        Ok(state) => not_passing_words(&state, &judged),
        Err(_) => Vec::new(),
    }
}

/// `name state` for each check of `state` that is not passing and not in `judged`.
fn not_passing_words(
    state: &forge_core::rules::v2::ChecksState,
    judged: &std::collections::BTreeSet<&str>,
) -> Vec<String> {
    use forge_core::rules::v2::CheckState;
    state
        .required
        .iter()
        .filter(|c| c.state != CheckState::Passed && !judged.contains(c.name.as_str()))
        .map(|c| format!("{} {}", safe(&c.name), check_word(c.state)))
        .collect()
}

/// What a merge builds.
struct MergeHow<'a> {
    method: Method,
    /// `--message`: the merge or squash commit's message (review-parity M2).
    message: Option<&'a str>,
    /// `--no-ff`: a merge commit even where the base could fast-forward.
    no_ff: bool,
    /// The signing identity (the commit author when git has no `user.name`).
    signer: &'a str,
    /// The branch policy in force (also under `--override-policy`): its merge methods are
    /// checked once the merge is planned.
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

/// What [`require_merge_rights`] found: the policy in force (its merge methods are checked once
/// the merge is planned) and, under a maintainer's `--override-policy`, the rules the merge
/// bypasses (empty: none, the policy is met or there is none).
struct MergeRights {
    policy: Option<forge_core::rules::review::Policy>,
    bypassed: Vec<String>,
}

/// The checks before any git work, all E601/E804 with nothing paid. Only members can merge
/// (the merge event is member-gated at consensus). The branch policy (a client rule every Forge
/// client applies; consensus does not enforce it) must be met: its approvals (the PR author's own
/// never count) and required checks, and `method` (a merge-method bit) when known; an unreadable
/// policy fails closed. A maintainer's `override_policy` is the explicit bypass (GitHub's "bypass
/// rules"): the unmet rules are returned, to be recorded on the PR, and the allowed merge methods
/// still apply. When the merge `pushes` to the base, a writer cannot move a protected one (only a
/// maintainer's `protectedRefUpdate` can).
async fn require_merge_rights(
    s: &Session,
    handle: &Repo,
    view: &PatchView,
    pushes: bool,
    method: Option<u8>,
    override_policy: bool,
) -> Result<MergeRights> {
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
    // The branch policy (a client rule): its approvals and checks now; its method once the merge
    // is planned. Read under an override too: the bypass names what it bypasses.
    // The policy document first, then where the PR stands against it: an override keeps the
    // policy's merge methods even when its approvals or checks cannot be read.
    let read = match collab.policy(handle).await {
        Ok(Some(policy)) => {
            let standing = async {
                let oracle = collab.member_oracle(handle).await?;
                let (approvals, _) = collab.approvals_with(handle, view, &oracle).await?;
                let checks = required_checks(&collab, handle, view, &oracle, &policy).await?;
                Ok::<_, anyhow::Error>((
                    forge_core::rules::review::meets_policy(&approvals, &oracle, &policy),
                    checks,
                ))
            }
            .await;
            Ok(Some((policy, standing)))
        }
        Ok(None) => Ok(None),
        Err(e) => Err(anyhow::Error::from(e)),
    };
    let rights = judge_policy(read, override_policy, method, &handle.display(), number)?;
    // DASH_FORGE_SKIP_WRITE_PRECHECK skips only the consensus-backed protected-branch check (so
    // consensus can be seen refusing it); the policy is a client rule nothing else enforces.
    if maintainer || !pushes || !forge_core::collab::v2::precheck_enabled() {
        return Ok(rights);
    }
    let base = view.patch.base_ref_name.as_str();
    let svc = forge_core::repo::RepoService::new(&s.client, &s.identity, &s.bridge);
    let Ok(patterns) = svc.protected_patterns(handle).await else {
        return Ok(rights);
    };
    if !forge_core::rules::matches_protected(base, &patterns) {
        return Ok(rights);
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
/// A rebase.
pub const METHOD_REBASE: u8 = 8;

/// When `policy` requires checks, where the head's checks stand: the newest trusted run per name
/// decides (`checks_state`, the web merge box's rule too).
async fn required_checks(
    collab: &forge_core::collab::v2::Collab<'_>,
    handle: &Repo,
    view: &PatchView,
    oracle: &forge_core::rules::v2::RoleOracle,
    policy: &forge_core::rules::review::Policy,
) -> Result<Option<forge_core::rules::v2::ChecksState>> {
    // Checks are judged when `requireChecks` is set or the policy names required checks (the
    // web merge box's gate, and `checks_state`'s own rule: named checks must each pass); then the
    // named checks and their pinned sources, when the policy has them, decide.
    if !checks_judged(policy) {
        return Ok(None);
    }
    let rules = policy.checks_policy();
    Ok(Some(
        collab
            .head_checks(handle, &view.head, oracle, &rules)
            .await?,
    ))
}

/// Whether `policy` requires checks at all: `requireChecks`, or named `requiredChecks` (which
/// `checks_state` requires by themselves). The web merge box's `checksRequired`.
fn checks_judged(policy: &forge_core::rules::review::Policy) -> bool {
    policy.require_checks || !policy.required_checks.is_empty()
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
        .map(|c| format!("{} {}", c.name, check_word(c.state)))
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
    let u = UserError::new(
        codes::POLICY_NOT_MET,
        format!("merge refused: PR #{number} does not meet the branch policy of {repo}"),
    )
    .cause(cause);
    // `--override-policy` lifts the approvals, never the allowed merge methods.
    let u = if status.met {
        u.fix(format!(
            "choose an allowed merge method (`dg repo policy show {repo}` lists them); `--override-policy` does not lift it"
        ))
    } else {
        u.fix(format!("get the missing approvals (`dg pr review {repo} {number} --approve` by a member other than the PR author)"))
            .fix("a maintainer can merge anyway with `--override-policy` (recorded on the PR)")
    };
    Some(
        u.note("the policy is a client rule every Forge client applies; consensus does not enforce it. Nothing was pushed and no merge event was posted"),
    )
}

/// The PR's standing against a read policy: its approvals status and its required checks.
type PolicyStanding = (
    forge_core::rules::review::PolicyStatus,
    Option<forge_core::rules::v2::ChecksState>,
);

/// What the read branch policy allows (`read`: the policy and the PR's standing against it,
/// `None` without a policy). Without `override_policy`, unmet approvals or checks, a disallowed
/// `method`, or a policy or standing that cannot be read refuse the merge (E804). A maintainer's
/// `override_policy` bypasses the approvals and checks (returned, to be recorded) but never the
/// allowed merge methods of a policy it could read.
fn judge_policy(
    read: Result<Option<(forge_core::rules::review::Policy, Result<PolicyStanding>)>>,
    override_policy: bool,
    method: Option<u8>,
    repo: &str,
    number: u64,
) -> Result<MergeRights> {
    let unread = |e: &anyhow::Error, what: &str| -> anyhow::Error {
        UserError::new(
            codes::POLICY_NOT_MET,
            format!("merge refused: couldn't read the branch policy{what} of {repo}"),
        )
        .cause(format!("{e:#}"))
        .fix("retry; a maintainer can merge with `--override-policy` (recorded on the PR)")
        .into()
    };
    match read {
        Ok(Some((policy, standing))) if override_policy => {
            // The bypass lifts approvals and checks; the allowed merge methods still apply (as
            // GitHub's repository merge settings do).
            let met = forge_core::rules::review::PolicyStatus {
                met: true,
                have: 0,
                need: 0,
            };
            if let Some(u) = policy_refusal(&policy, &met, method, repo, number) {
                return Err(u.into());
            }
            let bypassed = match standing {
                Ok((status, checks)) => unmet_rules(&policy, &status, checks.as_ref()),
                Err(_) => vec![STANDING_UNREAD.to_string()],
            };
            Ok(MergeRights {
                policy: Some(policy),
                bypassed,
            })
        }
        Ok(Some((_, Err(e)))) => Err(unread(&e, "'s approvals or checks")),
        Ok(Some((policy, Ok((status, checks))))) => {
            if let Some(u) = policy_refusal(&policy, &status, method, repo, number) {
                return Err(name_every_unmet_rule(
                    u,
                    &policy,
                    &status,
                    checks.as_ref(),
                    repo,
                    number,
                )
                .into());
            }
            if let Some(u) = checks
                .as_ref()
                .and_then(|c| checks_refusal(c, repo, number))
            {
                return Err(u.into());
            }
            Ok(MergeRights {
                policy: Some(policy),
                bypassed: Vec::new(),
            })
        }
        Ok(None) => Ok(MergeRights {
            policy: None,
            bypassed: Vec::new(),
        }),
        Err(_) if override_policy => Ok(MergeRights {
            policy: None,
            bypassed: vec![POLICY_UNREAD.to_string()],
        }),
        Err(e) => Err(unread(&e, "")),
    }
}

/// QW4-048: an approvals refusal (E804) whose required checks are unmet too names every unmet
/// rule in its cause, as the bypass record and `dg pr view` do, not the approvals alone, and
/// points at the runs.
fn name_every_unmet_rule(
    u: UserError,
    policy: &forge_core::rules::review::Policy,
    status: &forge_core::rules::review::PolicyStatus,
    checks: Option<&forge_core::rules::v2::ChecksState>,
    repo: &str,
    number: u64,
) -> UserError {
    if status.met || checks.is_none_or(|c| c.met) {
        return u;
    }
    u.cause(unmet_rules(policy, status, checks).join("; "))
        .fix(format!(
            "`dg pr checks {repo} {number}` shows the required checks"
        ))
}

/// The confirmation's clause for a merge that bypasses the branch policy (QW4-048): the bypass
/// is recorded on the PR as an event nobody can delete, and names what it bypasses.
fn bypass_clause(bypassed: &[String]) -> String {
    if bypassed.is_empty() {
        return String::new();
    }
    format!(
        ", then records a policy bypass on the PR that nobody can delete ({})",
        bypassed.join("; ")
    )
}

/// The bypass record's line for a policy read whose approvals or checks could not be.
const STANDING_UNREAD: &str = "required approvals and checks: could not be read";

/// The bypass record's line for a policy that could not be read.
const POLICY_UNREAD: &str = "the branch policy could not be read";

/// The branch rules `status` and `checks` leave unmet, one line each ("required approvals: 0 of
/// 1 (maintainers only)", "required check `build`: missing"); empty when all are met. The web
/// merge box names the same rules (`unmetRules`).
fn unmet_rules(
    policy: &forge_core::rules::review::Policy,
    status: &forge_core::rules::review::PolicyStatus,
    checks: Option<&forge_core::rules::v2::ChecksState>,
) -> Vec<String> {
    use forge_core::rules::v2::CheckState;
    let mut out = Vec::new();
    if !status.met {
        out.push(format!(
            "required approvals: {} of {}{}",
            status.have,
            status.need,
            if policy.approver_role == 1 {
                " (maintainers only)"
            } else {
                ""
            }
        ));
    }
    if let Some(c) = checks.filter(|c| !c.met) {
        if c.required.is_empty() {
            out.push("required checks: none reported on the head".to_string());
        }
        for r in c.required.iter().filter(|r| r.state != CheckState::Passed) {
            out.push(format!(
                "required check `{}`: {}",
                r.name,
                check_word(r.state)
            ));
        }
    }
    out
}

/// The `value` of the policy-bypass event a maintainer's bypass records: the rules not met,
/// `; `-joined, within the event's 120 characters (whole rules only; those that do not fit are
/// counted, "(+2 more)"). The web writes the same (`bypassValue`).
fn bypass_value(rules: &[String]) -> String {
    // forge-community `event.value`: `maxLength` 120 (and 480 bytes, which 120 chars never pass).
    const MAX: usize = 120;
    let mut out = String::new();
    for (i, r) in rules.iter().enumerate() {
        let rest = rules.len() - i - 1;
        let sep = if out.is_empty() { "" } else { "; " };
        let more = if rest == 0 {
            String::new()
        } else {
            format!(" (+{rest} more)")
        };
        let fits = out.chars().count() + sep.len() + r.chars().count() + more.chars().count();
        if fits > MAX {
            if out.is_empty() {
                // The first rule alone is too long: its start, cut, then what follows it.
                let keep = MAX - more.chars().count() - 1;
                return r.chars().take(keep).collect::<String>() + "…" + &more;
            }
            return format!("{out} (+{} more)", rest + 1);
        }
        out.push_str(sep);
        out.push_str(r);
    }
    if out.is_empty() {
        out.push_str("the branch rules");
    }
    out
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

/// The repository's default branch, `None` when it cannot be read (or is not set).
async fn default_branch_of(s: &Session, handle: &Repo) -> Option<String> {
    forge_core::repo::RepoService::new(&s.client, &s.identity, &s.bridge)
        .read_default_branch(handle)
        .await
        .ok()
        .flatten()
}

/// Whether a merge's push from here stores its bytes on Platform, as [`push_argv`]'s push
/// resolves its storage: the current repository's `dash.storage` resolved against the storage
/// profiles (Platform when nothing is set), or a Platform fallback. A policy that cannot be read
/// or resolved counts as Platform, the dearer case.
fn merge_stores_on_platform() -> bool {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let Ok(policy) = crate::storage::push_policy_in(&cwd) else {
        return true;
    };
    let resolved = forge_core::storage::StorageProfiles::load()
        .ok()
        .and_then(|profiles| policy.resolve(&profiles).ok());
    policy.platform_fallback || resolved.is_none_or(|r| r.platform)
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

/// `git rebase` of the PR head onto `base` in `dir`: the tip to push and how it was reached, or
/// `None` when every commit's change is already in the base (nothing to push).
fn build_rebase(
    dir: &Path,
    handle: &Repo,
    view: &PatchView,
    base: &str,
    committer: &[(String, String)],
    steps: &mut Steps,
) -> Result<Option<(String, &'static str)>> {
    let base_ref = &view.patch.base_ref_name;
    match git::rebase(dir, base, &view.head, committer)? {
        git::Rebased::Tip(tip) if tip == view.head => Ok(Some((tip, "fast-forward to"))),
        git::Rebased::Tip(tip) if tip == base => {
            steps.ok(
                "merge",
                format!("every commit's change is already in {base_ref}; nothing to push"),
            );
            Ok(None)
        }
        git::Rebased::Tip(tip) => Ok(Some((tip, "rebased; new tip"))),
        git::Rebased::Stopped { commit, paths } => Err(rebase_conflict_error(
            handle,
            view.patch.number,
            base_ref,
            &commit,
            &paths,
        )),
    }
}

/// The E105 for a rebase that stops at `commit` (conflicting in `paths`).
fn rebase_conflict_error(
    handle: &Repo,
    number: u32,
    base_ref: &str,
    commit: &str,
    paths: &[String],
) -> anyhow::Error {
    let mut cause = format!("commit {} does not apply cleanly", short(commit));
    if !paths.is_empty() {
        cause.push_str(" (conflicts in ");
        cause.push_str(&paths.join(", "));
        cause.push(')');
    }
    UserError::new(
        codes::MERGE_CONFLICT,
        format!("merge failed: PR #{number} does not rebase cleanly onto {base_ref}"),
    )
    .cause(cause)
    .fix(format!(
        "merge it without --rebase (a merge commit or --squash may still be clean), or `dg pr checkout {} {number}`, rebase it onto {base_ref} and resolve, push it to the PR's branch, then `dg pr sync`",
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
    // --no-ff writes a merge commit (the merge-commit method), except onto an empty base, which
    // has nothing to merge into: the head becomes the branch.
    let no_ff = how.no_ff && base_tip.is_some();
    let method = match (&plan, how.method) {
        (MergePlan::AlreadyMerged { .. }, _) => None,
        (_, Method::Squash) => Some(METHOD_SQUASH),
        (_, Method::Rebase) => Some(METHOD_REBASE),
        (MergePlan::FastForward { .. }, Method::Merge) if no_ff => Some(METHOD_MERGE),
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
            // The PR's author (its oldest commit's) authors the squash, the merger commits it,
            // as GitHub credits a squash (QW4-008); the browser merge does the same.
            let authors = git::authors(dir, base_tip, head).unwrap_or_default();
            let author = squash_identity(&authors, author());
            let message = match how.message {
                Some(m) => m.to_string(),
                None => squash_message(
                    &view.patch.title,
                    &view.patch.body,
                    view.patch.number,
                    &authors,
                    &author_line(&author),
                ),
            };
            let parents: Vec<&str> = base_tip.into_iter().collect();
            let c = git::commit_tree(dir, &tree, &parents, &message, &author)?;
            (c, "squash commit")
        }
        // Rebase: `git rebase --merge` of the head onto the base tip, as the browser replays it
        // (forge-web `lib/merge/rebase.ts`, held to git by its parity suite).
        (_, Method::Rebase) => match base_tip {
            // An empty base: the head becomes the branch.
            None => (head.clone(), "fast-forward to"),
            Some(base) => {
                let Some(built) = build_rebase(dir, handle, view, base, &author(), steps)? else {
                    return Ok(None);
                };
                built
            }
        },
        (MergePlan::FastForward { oid }, Method::Merge) if !no_ff => {
            if how.message.is_some() {
                return Err(crate::errors::usage(format!(
                    "PR #{} fast-forwards {base_ref}: no commit is written, so --message has nothing to set (add --no-ff to write a merge commit)",
                    view.patch.number
                )));
            }
            (oid.clone(), "fast-forward to")
        }
        // --no-ff onto a base the head descends from: the head's tree, parents base tip then head.
        (MergePlan::FastForward { oid }, Method::Merge) => {
            let base = base_tip.unwrap_or_default();
            let tree = git::git(dir, &["rev-parse", &format!("{oid}^{{tree}}")], &[])?;
            let message = merge_commit_message(view, how.message);
            let c = git::commit_tree(dir, &tree, &[base, oid], &message, &author())?;
            (c, "merge commit (--no-ff)")
        }
        (MergePlan::MergeCommit { base, head }, Method::Merge) => {
            let message = merge_commit_message(view, how.message);
            let c = git::merge_commit(dir, base, head, &message, &author())?
                .ok_or_else(|| conflict(base, head))?;
            (c, "merge commit")
        }
    };
    steps.ok("merge", format!("{detail} {}", short(&commit)));
    Ok(Some(commit))
}

/// The merge commit's message: `--message` as typed (review-parity M2), else the subject naming
/// the PR's source branch by its short name (`feature/x`, not `refs/heads/feature/x`), matching
/// the browser merge's format (`forge-web` `lib/merge/engine.ts` `mergeMessage`) and closer to
/// GitHub's `owner/branch` (Forge has no login to put before the branch), and the PR title.
fn merge_commit_message(view: &PatchView, message: Option<&str>) -> String {
    if let Some(m) = message {
        return m.to_string();
    }
    let source = view
        .patch
        .source_ref_name
        .as_deref()
        .map_or(view.head.as_str(), forge_core::repo::short_branch_name);
    format!(
        "Merge pull request #{} from {}\n\n{}",
        view.patch.number, source, view.patch.title
    )
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

/// The squash commit's identity environment (QW4-008): the first of `authors` (`Name <email>`,
/// oldest first: the PR's author) as `GIT_AUTHOR_*`, the merger (`merger`, a
/// [`git::merge_author`] environment) as `GIT_COMMITTER_*`; the merger as both when there is no
/// author or it is not an ident git accepts. Parity: forge-web `squashAuthor`.
pub(crate) fn squash_identity(
    authors: &[String],
    merger: Vec<(String, String)>,
) -> Vec<(String, String)> {
    let Some((name, email)) = authors.first().and_then(|a| parse_ident(a)) else {
        return merger;
    };
    merger
        .into_iter()
        .map(|(k, v)| match k.as_str() {
            "GIT_AUTHOR_NAME" => (k, name.clone()),
            "GIT_AUTHOR_EMAIL" => (k, email.clone()),
            _ => (k, v),
        })
        .collect()
}

/// git's `crud()` (ident.c; `.` is not one): what `strbuf_addstr_without_crud` strips from both
/// ends of an ident's name and email.
fn crud(c: char) -> bool {
    c <= ' ' || matches!(c, ',' | ':' | ';' | '<' | '>' | '"' | '\\' | '\'')
}

/// `Name <email>` as git writes it into a commit (crud stripped from both ends of each part), or
/// `None` when git would refuse it: a stray `<`, `>` or newline, or a part left empty. Parity:
/// forge-web `parseIdent`, so the CLI and the browser write the same author.
fn parse_ident(line: &str) -> Option<(String, String)> {
    let (name, rest) = line.split_once(" <")?;
    let email = rest.strip_suffix('>')?;
    if [name, email].iter().any(|v| v.contains(['<', '>', '\n'])) {
        return None;
    }
    let (name, email) = (name.trim_matches(crud), email.trim_matches(crud));
    (!name.is_empty() && !email.is_empty()).then(|| (name.to_string(), email.to_string()))
}

/// An author line in the form git writes it, for comparing two of them (the raw line when
/// unparsable).
fn canonical_ident(line: &str) -> String {
    parse_ident(line).map_or_else(|| line.to_string(), |(n, e)| format!("{n} <{e}>"))
}

/// A squash commit's message (review-parity M1): the PR title with its number, the body, and
/// a `Co-authored-by` trailer for each commit author other than the squash commit's own author
/// (`author`: [`squash_identity`]'s, compared as git writes both).
pub(crate) fn squash_message(
    title: &str,
    body: &str,
    number: u32,
    authors: &[String],
    author: &str,
) -> String {
    let mut m = format!("{title} (#{number})");
    if !body.trim().is_empty() {
        m.push_str("\n\n");
        m.push_str(body.trim_end());
    }
    let own = canonical_ident(author);
    let co: Vec<&String> = authors
        .iter()
        .filter(|a| canonical_ident(a) != own)
        .collect();
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
    let step = place_pr_branch(&cwd, &branch, &head)?;
    let switched = !matches!(step, CheckoutStep::CreateOnly(_));
    ctx.emit(
        json!({
            "pr": number,
            "headOid": head,
            "branch": branch,
            "sourceRepoId": source,
            "fetched": fetched,
            "branchCreated": step != CheckoutStep::FastForward,
            "switched": switched,
        }),
        || match step {
            CheckoutStep::CreateAndSwitch => {
                println!("✓ switched to branch {branch} at {}", short(&head));
            }
            CheckoutStep::FastForward => {
                println!("✓ branch {branch} (checked out) at {}", short(&head));
            }
            CheckoutStep::CreateOnly(why) => {
                println!(
                    "✓ branch {branch} at {} (git switch {branch})",
                    short(&head)
                );
                println!("  not switched: {why}");
            }
        },
    );
    Ok(())
}

/// Point `branch` (`pr/<n>`) at `head` in the repository at `cwd` and switch to it when that
/// loses nothing ([`checkout_step`]).
fn place_pr_branch(cwd: &Path, branch: &str, head: &str) -> Result<CheckoutStep> {
    // A `pr/<n>` holding commits the PR head does not is left alone (as `gh pr checkout`
    // refuses a non-fast-forward): moving it would leave them only in the reflog.
    let local = format!("refs/heads/{branch}");
    if git::git_ok(cwd, &["rev-parse", "--verify", "-q", &local])
        && !git::is_ancestor(cwd, &local, head)
    {
        return Err(UserError::new(
            codes::GIT_REPO,
            format!(
                "branch {branch} has commits the PR head {} does not",
                short(head)
            ),
        )
        .cause("moving it to the PR head would drop them; nothing was changed")
        .fix(format!(
            "keep them under another name (`git branch -m {branch} {branch}-old`) or drop them \
             (`git branch -D {branch}`, from another branch), then run it again"
        ))
        .into());
    }
    // Tracked changes only: git refuses a switch that would overwrite an untracked file.
    let clean = git::git(cwd, &["status", "--porcelain", "--untracked-files=no"], &[])
        .is_ok_and(|out| out.is_empty());
    let current = git::current_branch(cwd);
    // A detached HEAD no ref holds would be left only in the reflog by a switch.
    let a_ref_holds_head = || {
        git::git(
            cwd,
            &[
                "for-each-ref",
                "--count=1",
                "--contains",
                "HEAD",
                "refs/heads",
                "refs/tags",
                "refs/remotes",
            ],
            &[],
        )
        .is_ok_and(|out| !out.is_empty())
    };
    let stay = if !clean {
        Some("the working tree has uncommitted changes")
    } else if current.is_none() && !a_ref_holds_head() {
        Some("HEAD is detached at a commit no branch or tag holds")
    } else if ignored_overwritten_by(cwd, head) {
        // git replaces an ignored file (a local `.env`, …) silently when a switch brings a
        // tracked file to its path.
        Some("the PR head tracks a path that is an ignored file here, which a switch would overwrite")
    } else {
        None
    };
    let step = checkout_step(current.as_deref(), branch, stay);
    if step == CheckoutStep::FastForward {
        // Never a real merge: the check above made the branch an ancestor of the head. An
        // ignored file in the way stops it instead of being overwritten.
        git::git(
            cwd,
            &["merge", "--ff-only", "--no-overwrite-ignore", "-q", head],
            &[],
        )
        .with_context(|| format!("moving {branch} (checked out) to the PR head"))?;
    } else {
        git::git(cwd, &["branch", "-f", branch, head], &[])
            .with_context(|| format!("creating branch {branch}"))?;
    }
    if step == CheckoutStep::CreateAndSwitch {
        git::git(cwd, &["switch", "-q", branch], &[]).with_context(|| {
            format!("switching to {branch} (it is created: git switch {branch})")
        })?;
    }
    Ok(step)
}

/// Whether checking out `head` would overwrite an ignored, untracked file of the working tree
/// at `cwd` (a path, or a directory holding one, that `head` tracks). `true` when either
/// listing fails: the caller then stays put.
fn ignored_overwritten_by(cwd: &Path, head: &str) -> bool {
    let listing = |args: &[&str]| -> Option<Vec<String>> {
        let out = git::git(cwd, args, &[]).ok()?;
        Some(
            out.split('\0')
                .filter(|p| !p.is_empty())
                .map(str::to_owned)
                .collect(),
        )
    };
    let (Some(ignored), Some(tracked)) = (
        listing(&[
            "ls-files",
            "-z",
            "--others",
            "--ignored",
            "--exclude-standard",
            "--directory",
        ]),
        listing(&["ls-tree", "-r", "-z", "--name-only", head]),
    ) else {
        return true;
    };
    overlaps(&ignored, &tracked)
}

/// Whether a path in `tracked` is, or lies under, an entry of `ignored` (a directory entry
/// ends in `/`), or an ignored file sits where `tracked` has a directory.
fn overlaps(ignored: &[String], tracked: &[String]) -> bool {
    // Sorted, so the paths under `dir/` are one range: a build tree's thousands of ignored
    // files cost a lookup each, not a scan of the tree.
    let tracked: std::collections::BTreeSet<&str> = tracked.iter().map(String::as_str).collect();
    ignored.iter().any(|i| {
        let dir = i.trim_end_matches('/');
        let under = format!("{dir}/");
        tracked.contains(dir)
            || tracked
                .range(under.as_str()..)
                .next()
                .is_some_and(|t| t.starts_with(&under))
    })
}

/// What `dg pr checkout` does with branch `pr/<n>`, as `gh pr checkout` does, never losing
/// work.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CheckoutStep {
    /// Point the branch at the head and switch to it.
    CreateAndSwitch,
    /// Point the branch at the head, stay put, for this reason (uncommitted changes, …).
    CreateOnly(&'static str),
    /// The branch is checked out: fast-forward it (git refuses what would lose work).
    FastForward,
}

/// `stay`: why switching away from where the user is could lose work, if it could.
fn checkout_step(current: Option<&str>, branch: &str, stay: Option<&'static str>) -> CheckoutStep {
    match stay {
        _ if current == Some(branch) => CheckoutStep::FastForward,
        Some(why) => CheckoutStep::CreateOnly(why),
        None => CheckoutStep::CreateAndSwitch,
    }
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

    /// QW-036: an open PR from the same source branch into the same base (after a retarget)
    /// is a duplicate; a closed one, another branch, source or base is not.
    #[test]
    fn a_duplicate_is_an_open_pr_from_the_same_branch_into_the_same_base() {
        let head = "a".repeat(40);
        let v = view_with("refs/heads/main", &head);
        assert!(v.state.open, "a fresh PrState is open");
        assert!(same_head_and_base(
            &v,
            "s",
            "refs/heads/f",
            "refs/heads/main"
        ));
        assert!(!same_head_and_base(
            &v,
            "s",
            "refs/heads/g",
            "refs/heads/main"
        ));
        assert!(!same_head_and_base(
            &v,
            "fork",
            "refs/heads/f",
            "refs/heads/main"
        ));
        assert!(!same_head_and_base(
            &v,
            "s",
            "refs/heads/f",
            "refs/heads/dev"
        ));
        let mut retargeted = view_with("refs/heads/main", &head);
        retargeted.state.base_ref = Some("dev".into());
        assert!(same_head_and_base(
            &retargeted,
            "s",
            "refs/heads/f",
            "refs/heads/dev"
        ));
        assert!(!same_head_and_base(
            &retargeted,
            "s",
            "refs/heads/f",
            "refs/heads/main"
        ));
        let mut closed = view_with("refs/heads/main", &head);
        closed.state.open = false;
        assert!(!same_head_and_base(
            &closed,
            "s",
            "refs/heads/f",
            "refs/heads/main"
        ));
    }

    /// QW3-021: the merge prompt names the linked issues it closes.
    #[test]
    fn the_merge_prompt_names_the_issues_it_closes() {
        let t = |n: u32| {
            (
                n,
                forge_core::collab::v2::Target {
                    kind: forge_core::collab::v2::TargetKind::Issue,
                    id: format!("issue-{n}"),
                    number: n,
                    author: String::new(),
                },
            )
        };
        assert_eq!(closes_phrase(&[]), "");
        assert_eq!(closes_phrase(&[t(1)]), ", then closes issue #1");
        assert_eq!(closes_phrase(&[t(1), t(3)]), ", then closes issues #1, #3");
    }

    /// `dg pr list` / `dg pr view` show an open draft (state code 8) as `draft`, not `open`
    /// (it used to fall through to the `open` branch and read as a plain open PR). A closed
    /// draft (code 9) still reads as `closed`, matching the web's `pullStatus` precedence.
    #[test]
    fn state_label_shows_an_open_draft_as_draft() {
        let ok = "2".repeat(40);
        let with = |merged: bool, open: bool, draft: bool| {
            let mut v = view_with("refs/heads/main", &ok);
            v.state.merged = merged;
            v.state.open = open;
            v.state.draft = draft;
            v
        };
        assert_eq!(state_label(&with(false, true, false)), "open");
        assert_eq!(state_label(&with(false, true, true)), "draft");
        assert_eq!(state_label(&with(false, false, true)), "closed");
        assert_eq!(state_label(&with(false, false, false)), "closed");
        assert_eq!(state_label(&with(true, false, false)), "merged");
    }

    /// Run git in `dir` for a test fixture (no signing, fixed identity), returning stdout.
    fn fixture_git(dir: &Path, args: &[&str]) -> String {
        let out = std::process::Command::new("git")
            .current_dir(dir)
            .args(["-c", "user.name=t", "-c", "user.email=t@example.org"])
            .args([
                "-c",
                "commit.gpgsign=false",
                "-c",
                "init.defaultBranch=main",
            ])
            .args(args)
            .output()
            .expect("git");
        assert!(out.status.success(), "git {args:?}: {out:?}");
        String::from_utf8(out.stdout).unwrap().trim().to_owned()
    }

    /// A repository on `main` (one commit) with a PR head one commit ahead of it that adds
    /// `pr.txt`; returns the repository and the head oid.
    fn checkout_fixture() -> (tempfile::TempDir, String) {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        fixture_git(d, &["init", "-q"]);
        std::fs::write(d.join("a.txt"), "a\n").unwrap();
        fixture_git(d, &["add", "a.txt"]);
        fixture_git(d, &["commit", "-q", "-m", "base"]);
        fixture_git(d, &["switch", "-q", "-c", "work"]);
        std::fs::write(d.join("pr.txt"), "from the PR\n").unwrap();
        fixture_git(d, &["add", "pr.txt"]);
        fixture_git(d, &["commit", "-q", "-m", "head"]);
        let head = fixture_git(d, &["rev-parse", "HEAD"]);
        fixture_git(d, &["switch", "-q", "main"]);
        fixture_git(d, &["branch", "-q", "-D", "work"]);
        (dir, head)
    }

    /// The real git work of `dg pr checkout`, against temp repositories: it switches from a
    /// clean tree, and never loses uncommitted changes, ignored files, extra commits on
    /// `pr/<n>` or an unheld detached HEAD.
    #[test]
    fn place_pr_branch_never_loses_work() {
        let at = |d: &Path, r: &str| fixture_git(d, &["rev-parse", r]);
        // Clean: created and switched to.
        let (dir, head) = checkout_fixture();
        let d = dir.path();
        assert_eq!(
            place_pr_branch(d, "pr/7", &head).unwrap(),
            CheckoutStep::CreateAndSwitch
        );
        assert_eq!(git::current_branch(d).as_deref(), Some("pr/7"));
        assert_eq!(at(d, "pr/7"), head);

        // Already on pr/7, behind the head: fast-forwarded.
        fixture_git(d, &["reset", "-q", "--hard", "HEAD~1"]);
        assert_eq!(
            place_pr_branch(d, "pr/7", &head).unwrap(),
            CheckoutStep::FastForward
        );
        assert_eq!(at(d, "HEAD"), head);

        // Uncommitted tracked change: the branch is placed, the tree and branch stay.
        let (dir, head) = checkout_fixture();
        let d = dir.path();
        std::fs::write(d.join("a.txt"), "edited\n").unwrap();
        assert!(matches!(
            place_pr_branch(d, "pr/7", &head).unwrap(),
            CheckoutStep::CreateOnly(_)
        ));
        assert_eq!(git::current_branch(d).as_deref(), Some("main"));
        assert_eq!(
            std::fs::read_to_string(d.join("a.txt")).unwrap(),
            "edited\n"
        );
        assert_eq!(at(d, "pr/7"), head);

        // An ignored file at a path the head tracks: not switched, the file is kept.
        let (dir, head) = checkout_fixture();
        let d = dir.path();
        std::fs::write(d.join(".git/info/exclude"), "pr.txt\n").unwrap();
        std::fs::write(d.join("pr.txt"), "my local secret\n").unwrap();
        assert!(matches!(
            place_pr_branch(d, "pr/7", &head).unwrap(),
            CheckoutStep::CreateOnly(_)
        ));
        assert_eq!(git::current_branch(d).as_deref(), Some("main"));
        assert_eq!(
            std::fs::read_to_string(d.join("pr.txt")).unwrap(),
            "my local secret\n"
        );

        // pr/7 holds a commit the head does not: refused, nothing moves.
        let (dir, head) = checkout_fixture();
        let d = dir.path();
        fixture_git(d, &["switch", "-q", "-c", "pr/7"]);
        std::fs::write(d.join("mine.txt"), "mine\n").unwrap();
        fixture_git(d, &["add", "mine.txt"]);
        fixture_git(d, &["commit", "-q", "-m", "mine"]);
        let mine = at(d, "pr/7");
        fixture_git(d, &["switch", "-q", "main"]);
        assert!(place_pr_branch(d, "pr/7", &head).is_err());
        assert_eq!(at(d, "pr/7"), mine);

        // A detached HEAD at a commit no ref holds: not switched away from.
        let (dir, head) = checkout_fixture();
        let d = dir.path();
        fixture_git(d, &["switch", "-q", "--detach"]);
        std::fs::write(d.join("loose.txt"), "loose\n").unwrap();
        fixture_git(d, &["add", "loose.txt"]);
        fixture_git(d, &["commit", "-q", "-m", "loose"]);
        let loose = at(d, "HEAD");
        assert!(matches!(
            place_pr_branch(d, "pr/7", &head).unwrap(),
            CheckoutStep::CreateOnly(_)
        ));
        assert_eq!(at(d, "HEAD"), loose);
    }

    #[test]
    fn an_ignored_path_overlaps_a_tracked_file_or_directory() {
        let s = |v: &[&str]| v.iter().map(ToString::to_string).collect::<Vec<_>>();
        let tracked = s(&["src/main.rs", "config/app.toml", "README.md"]);
        assert!(overlaps(&s(&["README.md"]), &tracked));
        assert!(overlaps(&s(&["config/"]), &tracked));
        assert!(overlaps(&s(&["src"]), &tracked)); // an ignored file where the head has a dir
        assert!(!overlaps(&s(&["target/", "src.bak", "READ"]), &tracked));
    }

    /// QW-083: `dg pr checkout` switches to `pr/<n>` as `gh pr checkout` does, but only from
    /// a clean working tree; already on it, it fast-forwards instead of failing.
    #[test]
    fn checkout_switches_only_from_a_clean_tree() {
        let dirty = Some("the working tree has uncommitted changes");
        assert_eq!(
            checkout_step(Some("main"), "pr/7", None),
            CheckoutStep::CreateAndSwitch
        );
        assert_eq!(
            checkout_step(None, "pr/7", None),
            CheckoutStep::CreateAndSwitch
        );
        assert_eq!(
            checkout_step(Some("main"), "pr/7", dirty),
            CheckoutStep::CreateOnly("the working tree has uncommitted changes")
        );
        assert_eq!(
            checkout_step(Some("pr/7"), "pr/7", dirty),
            CheckoutStep::FastForward
        );
        assert_eq!(
            checkout_step(Some("pr/71"), "pr/7", None),
            CheckoutStep::CreateAndSwitch
        );
    }

    /// JSON's `"state"` field stays a stable three-value enum (`open`/`closed`/`merged`) even
    /// for a draft, since `"draft"` is already its own boolean field: an open draft must keep
    /// matching `dg pr list --state open --json | jq 'select(.state=="open")'`, unlike the
    /// plain-text label which collapses it to `draft` ([`state_label_shows_an_open_draft_as_draft`]).
    #[test]
    fn state_field_never_reports_draft() {
        let ok = "2".repeat(40);
        let with = |merged: bool, open: bool, draft: bool| {
            let mut v = view_with("refs/heads/main", &ok);
            v.state.merged = merged;
            v.state.open = open;
            v.state.draft = draft;
            v
        };
        assert_eq!(state_field(&with(false, true, false)), "open");
        assert_eq!(state_field(&with(false, true, true)), "open");
        assert_eq!(state_field(&with(false, false, true)), "closed");
        assert_eq!(state_field(&with(false, false, false)), "closed");
        assert_eq!(state_field(&with(true, false, false)), "merged");
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
            ..Default::default()
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
    fn unmet_rules_refuse_everyone_and_a_bypass_names_them_but_keeps_the_methods() {
        let unmet = || {
            Ok(Some((
                policy(1, true, METHOD_SQUASH),
                Ok((status(0, 1), None)),
            )))
        };
        // No override: refused (a maintainer too; QW-001).
        let e = judge_policy(unmet(), false, None, "o/r", 7).err().unwrap();
        assert!(format!("{e:#}").contains("0 of 1 required approval(s) from maintainers"));
        // The override bypasses the approvals, and names them for the record.
        let r = judge_policy(unmet(), true, None, "o/r", 7).unwrap();
        assert_eq!(
            r.bypassed,
            ["required approvals: 0 of 1 (maintainers only)"]
        );
        assert!(r.policy.is_some());
        // …but not the allowed merge methods, and does not claim it would.
        let e = judge_policy(unmet(), true, Some(METHOD_FF), "o/r", 7)
            .err()
            .unwrap();
        let u = e.downcast_ref::<UserError>().unwrap().to_json().to_string();
        assert!(u.contains("does not allow this merge method"), "{u}");
        assert!(u.contains("does not lift it"), "{u}");
        assert!(!u.contains("can merge anyway"), "{u}");
        // A met policy is no bypass, override or not.
        let met = || Ok(Some((policy(1, false, 0), Ok((status(1, 1), None)))));
        assert!(judge_policy(met(), true, None, "o/r", 7)
            .unwrap()
            .bypassed
            .is_empty());
        // The policy read but not its approvals or checks: refused without the override; with
        // it, the method rule still holds and the record says what could not be read.
        let blind = || {
            Ok(Some((
                policy(1, false, METHOD_SQUASH),
                Err(anyhow::anyhow!("down")),
            )))
        };
        assert!(judge_policy(blind(), false, None, "o/r", 7).is_err());
        assert!(judge_policy(blind(), true, Some(METHOD_MERGE), "o/r", 7).is_err());
        let r = judge_policy(blind(), true, Some(METHOD_SQUASH), "o/r", 7).unwrap();
        assert_eq!(r.bypassed, [STANDING_UNREAD]);
        // An unreadable policy refuses without the override (a maintainer too), and is named with it.
        assert!(judge_policy(Err(anyhow::anyhow!("down")), false, None, "o/r", 7).is_err());
        let r = judge_policy(Err(anyhow::anyhow!("down")), true, None, "o/r", 7).unwrap();
        assert_eq!(r.bypassed, [POLICY_UNREAD]);
    }

    #[test]
    fn named_required_checks_are_judged_without_require_checks() {
        // Parity with the web merge box and `checks_state`: a named required check must pass
        // even when `requireChecks` is off.
        let mut p = policy(0, false, 0);
        assert!(!checks_judged(&p));
        p.required_checks = vec!["build".into()];
        assert!(checks_judged(&p));
        let p = forge_core::rules::review::Policy {
            require_checks: true,
            ..policy(0, false, 0)
        };
        assert!(checks_judged(&p));
    }

    #[test]
    fn a_bypass_names_every_unmet_rule_as_the_web_does() {
        use forge_core::rules::v2::{CheckState, ChecksState, RequiredCheck};
        let checks = ChecksState {
            required: vec![
                RequiredCheck {
                    name: "build".into(),
                    state: CheckState::Missing,
                    run_id: None,
                },
                RequiredCheck {
                    name: "lint".into(),
                    state: CheckState::Passed,
                    run_id: Some("x".into()),
                },
            ],
            met: false,
            untrusted: 0,
        };
        assert_eq!(
            unmet_rules(&policy(1, true, 0), &status(0, 1), Some(&checks)),
            [
                "required approvals: 0 of 1 (maintainers only)",
                "required check `build`: missing"
            ]
        );
        assert!(unmet_rules(&policy(1, false, 0), &status(1, 1), None).is_empty());
        let no_runs = ChecksState {
            required: vec![],
            met: false,
            untrusted: 0,
        };
        assert_eq!(
            unmet_rules(&policy(0, false, 0), &status(0, 0), Some(&no_runs)),
            ["required checks: none reported on the head"]
        );
        // The bypass event's value: the rules, `; `-joined (the web's `bypassValue`).
        assert_eq!(
            bypass_value(&[
                "required approvals: 0 of 1".to_string(),
                "required check `lint`: failing".to_string()
            ]),
            "required approvals: 0 of 1; required check `lint`: failing"
        );
    }

    #[test]
    fn merge_warns_of_checks_not_passing_that_the_policy_did_not_judge() {
        use forge_core::rules::v2::{CheckState, ChecksState, RequiredCheck};
        let check = |name: &str, state| RequiredCheck {
            name: name.into(),
            state,
            run_id: Some("r".into()),
        };
        let state = ChecksState {
            required: vec![
                check("build", CheckState::Passed),
                check("e2e", CheckState::Pending),
                check("lint", CheckState::Failing),
            ],
            met: false,
            untrusted: 0,
        };
        let none = std::collections::BTreeSet::new();
        assert_eq!(
            not_passing_words(&state, &none),
            ["e2e pending", "lint failing"]
        );
        // a required check is the policy's to refuse (or a bypass's to record)
        let judged = std::collections::BTreeSet::from(["lint"]);
        assert_eq!(not_passing_words(&state, &judged), ["e2e pending"]);
        assert_eq!(plural_checks(1), "1 check is");
        assert_eq!(plural_checks(2), "2 checks are");
    }

    #[test]
    fn view_names_each_required_check_after_the_approvals() {
        use forge_core::rules::v2::{CheckState, ChecksState, RequiredCheck};
        let state = ChecksState {
            required: vec![
                RequiredCheck {
                    name: "build".into(),
                    state: CheckState::Passed,
                    run_id: None,
                },
                RequiredCheck {
                    name: "lint".into(),
                    state: CheckState::Failing,
                    run_id: None,
                },
            ],
            met: false,
            untrusted: 0,
        };
        assert_eq!(
            checks_words(&Ok(Some(state))).as_deref(),
            Some("build passed, lint failing")
        );
        assert_eq!(checks_words(&Ok(None)), None);
        assert_eq!(
            checks_words(&Err("x".into())).as_deref(),
            Some("could not be read")
        );
    }

    #[test]
    fn a_bypass_value_fits_the_event_and_counts_what_does_not() {
        let rules: Vec<String> = (0..10)
            .map(|i| format!("required check `check-number-{i}`: missing"))
            .collect();
        let v = bypass_value(&rules);
        assert!(v.chars().count() <= 120, "{v}");
        assert!(
            v.starts_with("required check `check-number-0`: missing; "),
            "{v}"
        );
        assert!(v.ends_with(" (+8 more)"), "{v}");
        // one rule longer than the value: cut, and still counted
        let long = vec!["x".repeat(200)];
        let v = bypass_value(&long);
        assert!(v.chars().count() == 120 && v.ends_with('…'), "{v}");
        assert_eq!(bypass_value(&[]), "the branch rules");
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
            ..ChecksPolicy::default()
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
        // QW-082: it read "issue not created refused: …"
        assert_eq!(u.message, "issue not created: o/r is archived");
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
    fn a_bypass_is_named_in_the_merge_confirmation() {
        assert_eq!(bypass_clause(&[]), "");
        let c = bypass_clause(&[
            "required approvals: 0 of 1".to_string(),
            "required check `build`: missing".to_string(),
        ]);
        assert!(
            c.contains("records a policy bypass on the PR that nobody can delete"),
            "{c}"
        );
        assert!(
            c.contains("(required approvals: 0 of 1; required check `build`: missing)"),
            "{c}"
        );
    }

    /// QW4-048: E804 for missing approvals names the unmet required checks too.
    #[test]
    fn an_approvals_refusal_names_the_unmet_checks_too() {
        use forge_core::rules::v2::{CheckState, ChecksState, RequiredCheck};
        let policy = forge_core::rules::review::Policy {
            required_approvals: 1,
            require_checks: true,
            required_checks: vec!["build".into()],
            ..Default::default()
        };
        let status = forge_core::rules::review::PolicyStatus {
            met: false,
            have: 0,
            need: 1,
        };
        let checks = ChecksState {
            required: vec![RequiredCheck {
                name: "build".into(),
                state: CheckState::Missing,
                run_id: None,
            }],
            met: false,
            untrusted: 0,
        };
        let u = policy_refusal(&policy, &status, None, "o/r", 4).unwrap();
        let u = name_every_unmet_rule(u, &policy, &status, Some(&checks), "o/r", 4);
        assert_eq!(
            u.cause.as_deref(),
            Some("required approvals: 0 of 1; required check `build`: missing")
        );
        assert!(
            u.fix.iter().any(|f| f.contains("dg pr checks o/r 4")),
            "{u:?}"
        );
        // Checks met: the approvals alone, as before.
        let met = ChecksState {
            met: true,
            ..checks
        };
        let u = policy_refusal(&policy, &status, None, "o/r", 4).unwrap();
        let u = name_every_unmet_rule(u, &policy, &status, Some(&met), "o/r", 4);
        assert_eq!(u.cause.as_deref(), Some("0 of 1 required approval(s)"));
    }

    #[test]
    fn a_squash_is_authored_by_the_pr_author_and_committed_by_the_merger() {
        let merger = || {
            [
                ("GIT_AUTHOR_NAME", "Me"),
                ("GIT_AUTHOR_EMAIL", "me@x"),
                ("GIT_COMMITTER_NAME", "Me"),
                ("GIT_COMMITTER_EMAIL", "me@x"),
            ]
            .iter()
            .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
            .collect::<Vec<_>>()
        };
        let env = squash_identity(&["A Person <a@x>".into(), "B <b@x>".into()], merger());
        assert_eq!(author_line(&env), "A Person <a@x>");
        assert!(env.contains(&("GIT_COMMITTER_NAME".into(), "Me".into())));
        assert!(env.contains(&("GIT_COMMITTER_EMAIL".into(), "me@x".into())));
        // No author, or one git would refuse: the merger is both.
        assert_eq!(squash_identity(&[], merger()), merger());
        assert_eq!(
            squash_identity(&["Bad <x> <b@x>".into()], merger()),
            merger()
        );
        assert_eq!(squash_identity(&[" <b@x>".into()], merger()), merger());
        assert_eq!(squash_identity(&[",; <b@x>".into()], merger()), merger());
        // As git writes it (crud stripped from both ends), so dg and the browser agree.
        let env = squash_identity(&[" John Doe, <\"j@x\">".into()], merger());
        assert_eq!(author_line(&env), "John Doe <j@x>");
        let env = squash_identity(&["A Jr. <j@x>".into()], merger());
        assert_eq!(author_line(&env), "A Jr. <j@x>");
        // The author is not listed again as a co-author, whatever spacing their line has.
        assert_eq!(
            squash_message(
                "T",
                "",
                1,
                &["A  <a@x>".into(), "B <b@x>".into()],
                "A <a@x>"
            ),
            "T (#1)\n\nCo-authored-by: B <b@x>"
        );
    }

    /// A bare scratch repository with commits written by plumbing: `commit(files, parents)`
    /// returns the oid of a commit whose tree holds `files` (`path`, `content`).
    struct Scratch(tempfile::TempDir);

    impl Scratch {
        fn new() -> Self {
            Self(scratch_repo().unwrap())
        }
        fn dir(&self) -> &Path {
            self.0.path()
        }
        fn commit(&self, files: &[(&str, &str)], parents: &[&str]) -> String {
            let index = tempfile::NamedTempFile::new().unwrap();
            let env = [(
                "GIT_INDEX_FILE".to_string(),
                index.path().to_string_lossy().into_owned(),
            )];
            git::git(self.dir(), &["read-tree", "--empty"], &env).unwrap();
            for (path, content) in files {
                let oid = git::hash_blob(self.dir(), content.as_bytes()).unwrap();
                git::git(
                    self.dir(),
                    &[
                        "update-index",
                        "--add",
                        "--cacheinfo",
                        &format!("100644,{oid},{path}"),
                    ],
                    &env,
                )
                .unwrap();
            }
            let tree = git::git(self.dir(), &["write-tree"], &env).unwrap();
            let who = [
                ("GIT_AUTHOR_NAME", "A"),
                ("GIT_AUTHOR_EMAIL", "a@x"),
                ("GIT_AUTHOR_DATE", "@1700000000 +0000"),
                ("GIT_COMMITTER_NAME", "A"),
                ("GIT_COMMITTER_EMAIL", "a@x"),
                ("GIT_COMMITTER_DATE", "@1700000000 +0000"),
            ]
            .map(|(k, v)| (k.to_string(), v.to_string()));
            git::commit_tree(self.dir(), &tree, parents, "c", &who).unwrap()
        }
        fn show(&self, rev: &str, format: &str) -> String {
            git::git(
                self.dir(),
                &["log", "-1", &format!("--format={format}"), rev],
                &[],
            )
            .unwrap()
        }
    }

    fn build(s: &Scratch, base: &str, head: &str, how: &MergeHow<'_>) -> Result<Option<String>> {
        let mut view = view_with("refs/heads/main", head);
        view.base_tip = Some(base.to_string());
        build_merge(s.dir(), &dummy_repo(), &view, how, &mut Steps::new(true))
    }

    /// Review-parity M1 (P1-2): `--rebase` replays the PR's commits on the base with `git rebase`
    /// (authors and messages kept), fast-forwards a linear head already on the base, skips a
    /// commit whose change the base already has, refuses a conflict naming the commit and paths,
    /// and is the rebase method a branch policy is checked against.
    #[test]
    fn a_rebase_replays_the_commits_and_refuses_a_conflict() {
        if !git::git_ok(Path::new("."), &["--version"]) {
            return;
        }
        let s = Scratch::new();
        let root = s.commit(&[("a.txt", "a\n"), ("b.txt", "b\n")], &[]);
        let base = s.commit(&[("a.txt", "A\n"), ("b.txt", "b\n")], &[&root]);
        let one = s.commit(&[("a.txt", "a\n"), ("b.txt", "B\n")], &[&root]);
        let two = s.commit(
            &[("a.txt", "a\n"), ("b.txt", "B\n"), ("c.txt", "c\n")],
            &[&one],
        );
        let how = MergeHow {
            method: Method::Rebase,
            message: None,
            no_ff: false,
            signer: "signer-identity-id",
            policy: None,
        };
        let tip = build(&s, &base, &two, &how).unwrap().unwrap();
        assert_ne!(tip, two);
        assert_eq!(s.show(&format!("{tip}~2"), "%H"), base);
        assert_eq!(s.show(&tip, "%an <%ae> %B"), "A <a@x> c");
        let files = git::git(s.dir(), &["ls-tree", "--name-only", &tip], &[]).unwrap();
        assert_eq!(files, "a.txt\nb.txt\nc.txt");
        assert_eq!(
            git::git(s.dir(), &["show", &format!("{tip}:a.txt")], &[]).unwrap(),
            "A"
        );

        // A linear head already on the base tip: fast-forwarded unchanged.
        let ahead = s.commit(&[("a.txt", "A\n"), ("b.txt", "B\n")], &[&base]);
        assert_eq!(build(&s, &base, &ahead, &how).unwrap(), Some(ahead.clone()));

        // The base already made the same change: git skips that commit (by patch-id).
        let other = s.commit(&[("a.txt", "a\n"), ("b.txt", "b\n"), ("e", "")], &[&root]);
        let dup = s.commit(&[("a.txt", "A\n"), ("b.txt", "b\n"), ("e", "")], &[&other]);
        let tip = build(&s, &base, &dup, &how).unwrap().unwrap();
        assert_eq!(s.show(&format!("{tip}~1"), "%H"), base);

        // A conflict: refused, naming the commit and the path.
        let clash = s.commit(&[("a.txt", "x\n"), ("b.txt", "b\n")], &[&root]);
        let err = format!("{:#}", build(&s, &base, &clash, &how).unwrap_err());
        assert!(err.contains("does not rebase cleanly"), "{err}");
        let cause = format!("{:?}", build(&s, &base, &clash, &how).unwrap_err());
        assert!(
            cause.contains("a.txt") && cause.contains(&clash[..7]),
            "{cause}"
        );

        // The rebase method (8): a policy allowing merge commits only refuses it.
        let merges_only = policy(0, false, METHOD_MERGE);
        let refused = build(
            &s,
            &base,
            &two,
            &MergeHow {
                policy: Some(&merges_only),
                ..how
            },
        )
        .unwrap_err();
        assert!(
            format!("{refused:#}").contains("merge method"),
            "{refused:#}"
        );
    }

    /// Review-parity M2: `--message` sets the merge commit's message (as the browser's merge box
    /// does), `--no-ff` writes a merge commit where the base could fast-forward, and `--message`
    /// on a fast-forward (which writes no commit) is refused rather than dropped.
    #[test]
    fn the_merge_commit_message_is_editable_and_no_ff_writes_one() {
        if !git::git_ok(Path::new("."), &["--version"]) {
            return;
        }
        let s = Scratch::new();
        let root = s.commit(&[("a.txt", "a\n"), ("b.txt", "b\n")], &[]);
        let base = s.commit(&[("a.txt", "A\n"), ("b.txt", "b\n")], &[&root]);
        let head = s.commit(&[("a.txt", "a\n"), ("b.txt", "B\n")], &[&root]);
        let how = |message, no_ff| MergeHow {
            method: Method::Merge,
            message,
            no_ff,
            signer: "signer-identity-id",
            policy: None,
        };
        let c = build(&s, &base, &head, &how(None, false)).unwrap().unwrap();
        assert_eq!(s.show(&c, "%B"), "Merge pull request #1 from f\n\nt");
        let c = build(
            &s,
            &base,
            &head,
            &how(Some("Ship it\n\nwith a body"), false),
        )
        .unwrap()
        .unwrap();
        assert_eq!(s.show(&c, "%B"), "Ship it\n\nwith a body");
        assert_eq!(s.show(&c, "%P"), format!("{base} {head}"));

        // A head that descends from the base: a fast-forward, unless --no-ff.
        let ahead = s.commit(&[("a.txt", "A\n"), ("b.txt", "B\n")], &[&base]);
        assert_eq!(
            build(&s, &base, &ahead, &how(None, false)).unwrap(),
            Some(ahead.clone())
        );
        let err = build(&s, &base, &ahead, &how(Some("m"), false)).unwrap_err();
        assert!(format!("{err:#}").contains("--no-ff"), "{err:#}");
        let c = build(&s, &base, &ahead, &how(Some("m"), true))
            .unwrap()
            .unwrap();
        assert_eq!(s.show(&c, "%P"), format!("{base} {ahead}"));
        assert_eq!(s.show(&c, "%T"), s.show(&ahead, "%T"));
        assert_eq!(s.show(&c, "%B"), "m");
        // --no-ff is the merge-commit method: a policy allowing fast-forwards only refuses it.
        let ff_only = policy(0, false, METHOD_FF);
        let refused = build(
            &s,
            &base,
            &ahead,
            &MergeHow {
                policy: Some(&ff_only),
                ..how(None, true)
            },
        )
        .unwrap_err();
        assert!(
            format!("{refused:#}").contains("merge method"),
            "{refused:#}"
        );
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
