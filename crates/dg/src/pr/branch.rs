//! Commits to a PR's source branch: `dg pr suggestion apply` (R5, C13), `dg pr update-branch`
//! (M6, C12), and `dg pr merge --delete-branch` (M7, C11).
//!
//! Each builds its commit in a throwaway repository (base and head fetched over `dash://`),
//! pushes it to the source branch in the **source** repository — which needs write access
//! there (forge-core's `refUpdate` gate on that repo, so usually the PR author's fork) — then
//! moves the PR head with a `headUpdate`. The helper's own auto-sync is turned off for that
//! push (`dash.prAutoSync=false`), so the head moves exactly once. The PR's `sourceRefName` is
//! a document field anyone could have written: it must be a plain branch before it becomes a
//! push destination.
//!
//! Applied suggestions are recorded as commit trailers, as the web does (review-parity §4.5):
//! `Forge-Suggestion: <comment id>` per comment and `Co-authored-by:` per reviewer.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use anyhow::{Context, Result};
use serde_json::json;

use forge_core::collab::v2::{kind_route, Comment, EventPayload, PatchView, StateRoute};
use forge_core::rules::v2::{
    anchor_of, apply_suggestion, parse_suggestions, Role, SuggestionError,
};
use forge_core::rules::EventKind;
use forge_core::scope::RepoRef as Repo;
use forge_core::user_error::{codes, UserError};

use super::{open_pr, push_argv, push_to, scratch_with_pr, Pr, Steps, REF_UPDATE_CREDITS};
use crate::common::Session;
use crate::context::Ctx;
use crate::fmt::{cost_line, safe, short};
use crate::git;

/// The trailer naming an applied suggestion's comment.
pub const SUGGESTION_TRAILER: &str = "Forge-Suggestion";

/// The PR's source branch and repository, checked writable by the signer.
pub struct SourceBranch {
    /// The source repository.
    pub repo: Repo,
    /// `owner/name` of it, for messages.
    pub repo_display: String,
    /// The branch (`refs/heads/…`), checked plain.
    pub ref_name: String,
    /// `dash://<id>`.
    pub url: String,
}

/// The source branch of `view`, refusing (E601, naming the source repository) when the signer
/// cannot write to it, and (E201) when it is not a plain branch.
pub async fn writable_source(
    s: &Session,
    view: &PatchView,
    number: u64,
    action: &str,
) -> Result<SourceBranch> {
    let Some(ref_name) = view.patch.source_ref_name.clone() else {
        return Err(crate::errors::usage(format!(
            "PR #{number} names no source branch, so there is nothing to {action}"
        )));
    };
    git::require_branch_ref(&ref_name)?;
    let repo = forge_core::resolve::resolve_id(&s.client, &view.patch.source_repo_id)
        .await
        .context("resolving the PR's source repository")?;
    let repo_display = repo.display();
    let skip = std::env::var(forge_core::collab::v2::SKIP_PRECHECK_ENV)
        .is_ok_and(|v| !v.is_empty() && v != "0");
    if !skip {
        let role = s.collab().signer_role(&repo).await?;
        let protected = forge_core::repo::RepoService::new(&s.client, &s.identity, &s.bridge)
            .protected_patterns(&repo)
            .await
            .is_ok_and(|p| forge_core::rules::matches_protected(&ref_name, &p));
        let ok = match role {
            Some(Role::Maintainer) => true,
            Some(Role::Writer) => !protected,
            // RC2 member roles: triage and readers cannot push (`r` 1 only).
            Some(Role::Triage | Role::Reader) | None => false,
        };
        if !ok {
            return Err(UserError::new(
                codes::NOT_A_WRITER,
                format!(
                    "cannot {action}: you are not a {} of the PR's source repository {repo_display}",
                    if protected { "maintainer" } else { "writer" }
                ),
            )
            .cause(
                role.and_then(|r| forge_core::members::role_limits(r, &repo))
                    .unwrap_or_else(|| {
                        format!(
                            "the PR's branch {} lives in {repo_display}; only its writers and \
                             maintainers can push to it",
                            safe(&ref_name)
                        )
                    }),
            )
            .fix("ask the PR's author to do it (the branch is usually in their fork)")
            .fix(forge_core::user_error::join_fix(
                &repo_display,
                "<your identity id>",
                "writer",
            ))
            .note("checked before anything was built or paid; nothing was written")
            .into());
        }
    }
    Ok(SourceBranch {
        url: format!("dash://{}", repo.id()),
        repo,
        repo_display,
        ref_name,
    })
}

/// The route the head update after a push takes, or E601 before anything is built.
async fn head_route(s: &Session, view: &PatchView, action: &str) -> Result<StateRoute> {
    let collab = s.collab();
    let role = collab.signer_role(&s.repo).await?;
    kind_route(
        role,
        &collab.signer_id()?,
        &view.patch.target(),
        EventKind::HeadUpdate,
    )
    .ok_or_else(|| {
        // A triage member or reader who is not the author is told what the role allows.
        if let Some(e) = role.and_then(|_| {
            forge_core::collab::v2::role_refusal(
                role,
                forge_core::members::event_needs(EventKind::HeadUpdate),
                &s.repo,
                action,
            )
        }) {
            return e.into();
        }
        forge_core::Error::NotPermitted {
            action: action.to_string(),
            reason: format!(
                "moving the PR head needs its author or a maintainer or writer of {}",
                s.repo.display()
            ),
            needs: "author".into(),
        }
        .into()
    })
}

/// Where `ref_name` points in `repo` now, or `None` when it is gone.
pub(crate) async fn branch_tip(s: &Session, repo: &Repo, ref_name: &str) -> Result<Option<String>> {
    let svc = forge_core::repo::RepoService::new(&s.client, &s.identity, &s.bridge);
    Ok(svc
        .read_refs(repo)
        .await?
        .iter()
        .find(|(n, _)| n == ref_name)
        .and_then(|(_, st)| forge_core::rules::tip_of(st)))
}

/// Refuse when the source branch is not at the PR head (it moved: sync first).
async fn require_branch_at_head(
    s: &Session,
    src: &SourceBranch,
    view: &PatchView,
    repo: &str,
    number: u64,
) -> Result<()> {
    match branch_tip(s, &src.repo, &src.ref_name).await? {
        Some(t) if t.eq_ignore_ascii_case(&view.head) => Ok(()),
        Some(t) => Err(UserError::new(
            codes::USAGE,
            format!(
                "the PR's branch is at {}, not at the PR head {}",
                short(&t),
                short(&view.head)
            ),
        )
        .fix(format!(
            "run `dg pr sync {repo} {number}` first, then try again"
        ))
        .note("nothing was written")
        .into()),
        None => Err(crate::errors::not_found(
            format!(
                "{} is no longer in {}",
                safe(&src.ref_name),
                src.repo_display
            ),
            "the PR's branch was deleted",
        )),
    }
}

/// Push `commit` to the source branch (fast-forward only) with the helper's PR auto-sync off,
/// then post the `headUpdate`. A failure is reported with the steps that ran.
async fn commit_push_move(
    ctx: &Ctx,
    pr: &Pr,
    src: &SourceBranch,
    dir: &Path,
    commit: &str,
    steps: &mut Steps,
    repo: &str,
) -> Result<String> {
    let moved = async {
        let mut argv = vec!["-c".to_string(), "dash.prAutoSync=false".to_string()];
        argv.extend(push_argv(ctx, &src.url, commit, &src.ref_name));
        push_to(
            dir,
            &argv,
            &git::dash_env_signing(ctx)?,
            "push to the PR branch failed",
        )
        .with_context(|| format!("pushing to {} in {}", src.ref_name, src.repo_display))?;
        steps.ok("push", format!("{} → {}", src.ref_name, short(commit)));
        let oid = hex::decode(commit).context("commit oid")?;
        let (_, id) =
            pr.s.collab()
                .post_target_event(
                    &pr.s.repo,
                    &pr.view.patch.target(),
                    EventKind::HeadUpdate,
                    &EventPayload {
                        oid: Some(&oid),
                        ..EventPayload::default()
                    },
                )
                .await
                .map_err(|e| {
                    anyhow::Error::from(e).context(format!(
                        "{} holds {}, but the PR head was not moved; run `dg pr sync` to move it",
                        src.ref_name,
                        short(commit)
                    ))
                })?;
        steps.ok(
            "head",
            format!("PR head → {} ({})", short(commit), short(&id)),
        );
        Ok::<_, anyhow::Error>(id)
    }
    .await;
    let number = u64::from(pr.view.patch.number);
    moved.map_err(|e| {
        crate::errors::reported(
            super::step_failure(
                &e,
                number,
                repo,
                "PR branch not updated",
                "the PR head was not moved",
            ),
            json!({ "status": "failed", "pr": number, "steps": steps.done }),
        )
    })
}

/// The estimate of a commit to the PR branch: the ref update, the head update (by `route`),
/// and the pack's storage on top.
fn branch_commit_estimate(route: StateRoute) -> u64 {
    super::event_estimate(route, 0) + REF_UPDATE_CREDITS
}

// ---------------------------------------------------------------------------
// suggestion apply
// ---------------------------------------------------------------------------

/// One suggestion to apply.
#[derive(Debug, Clone)]
pub struct Planned {
    /// The comment carrying it.
    pub comment_id: String,
    /// Its author (a `Co-authored-by`).
    pub reviewer: String,
    /// The file.
    pub path: String,
    /// First and last line (1-based, inclusive) on the new side.
    pub start: u64,
    /// Last line.
    pub end: u64,
    /// The replacement.
    pub text: String,
}

fn e107(message: String) -> Box<UserError> {
    Box::new(UserError::new(codes::SUGGESTION, message).note("nothing was committed or pushed"))
}

/// Why a comment's suggestion cannot be applied on `head`, or its plan.
pub fn plan_suggestion(c: &Comment, head: &str) -> Result<Planned, Box<UserError>> {
    let id = short(&c.document_id).to_string();
    let Some(a) = anchor_of(&c.anchor) else {
        return Err(e107(format!("comment {id} is not on a line of the diff")));
    };
    let (Some(end), Some(side)) = (a.line, a.side) else {
        return Err(e107(format!(
            "comment {id} is on a whole file, not on lines"
        )));
    };
    if side != 1 {
        return Err(e107(format!(
            "comment {id} is on the old side of the diff; a suggestion replaces new lines"
        )));
    }
    if !a.commit_oid.eq_ignore_ascii_case(head) {
        let mut e = e107(format!(
            "comment {id} was made on {}, not on the PR head {}",
            short(&a.commit_oid),
            short(head)
        ));
        *e = e.fix("ask the reviewer to suggest it again on the current head, or edit by hand");
        return Err(e);
    }
    let mut s = parse_suggestions(&c.body);
    if s.is_empty() {
        return Err(e107(format!("comment {id} has no ```suggestion block")));
    }
    if s.len() > 1 {
        return Err(e107(format!(
            "comment {id} has {} suggestion blocks; apply it by hand",
            s.len()
        )));
    }
    Ok(Planned {
        comment_id: c.document_id.clone(),
        reviewer: c.author.clone(),
        path: a.path,
        start: a.start_line.unwrap_or(end),
        end,
        text: s.remove(0).text,
    })
}

/// Apply `plans` to `files` (path → content): per file, bottom-up, refusing overlaps (E107).
pub fn apply_all(
    plans: &[Planned],
    files: &BTreeMap<String, String>,
) -> Result<BTreeMap<String, String>, Box<UserError>> {
    let mut by_file: BTreeMap<&str, Vec<&Planned>> = BTreeMap::new();
    for p in plans {
        by_file.entry(p.path.as_str()).or_default().push(p);
    }
    let mut out = BTreeMap::new();
    for (path, mut ps) in by_file {
        ps.sort_by_key(|p| (p.start, p.end));
        for w in ps.windows(2) {
            if w[1].start <= w[0].end {
                let mut e = e107(format!(
                    "the suggestions {} and {} overlap in {} (lines {}-{} and {}-{})",
                    short(&w[0].comment_id),
                    short(&w[1].comment_id),
                    safe(path),
                    w[0].start,
                    w[0].end,
                    w[1].start,
                    w[1].end
                ));
                *e = e.fix("apply one of them, then ask the reviewer to suggest the other again");
                return Err(e);
            }
        }
        let Some(mut text) = files.get(path).cloned() else {
            return Err(e107(format!("{} is not in the PR head", safe(path))));
        };
        for p in ps.iter().rev() {
            text = apply_suggestion(&text, p.start, p.end, &p.text).map_err(|e| {
                e107(match e {
                    SuggestionError::BadRange => {
                        format!("comment {} names an empty line range", short(&p.comment_id))
                    }
                    SuggestionError::OutOfRange => format!(
                        "comment {} names lines {}-{} but {} has fewer lines at the head",
                        short(&p.comment_id),
                        p.start,
                        p.end,
                        safe(path)
                    ),
                })
            })?;
        }
        out.insert(path.to_string(), text);
    }
    Ok(out)
}

/// The commit message of applied suggestions (review-parity §4.5).
pub fn suggestion_message(plans: &[Planned], names: &BTreeMap<String, String>) -> String {
    use std::fmt::Write as _;
    let mut m = String::from("Apply suggestions from code review\n\n");
    let reviewers: BTreeSet<&str> = plans.iter().map(|p| p.reviewer.as_str()).collect();
    for r in reviewers {
        let name = names.get(r).map_or(r, String::as_str);
        let _ = writeln!(m, "Co-authored-by: {name} <{r}@users.forge.invalid>");
    }
    for p in plans {
        let _ = writeln!(m, "{SUGGESTION_TRAILER}: {}", p.comment_id);
    }
    m.truncate(m.trim_end().len());
    m
}

/// The comment ids named by `Forge-Suggestion` trailers in `log` (commit messages).
pub fn applied_ids(log: &str) -> BTreeSet<String> {
    let prefix = format!("{SUGGESTION_TRAILER}:");
    log.lines()
        .filter_map(|l| l.trim().strip_prefix(&prefix))
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty())
        .collect()
}

/// `dg pr suggestion apply`.
#[allow(clippy::too_many_lines)]
pub async fn apply_suggestions(
    ctx: &Ctx,
    repo: &str,
    number: u64,
    ids: &[String],
    all: bool,
) -> Result<()> {
    if ids.is_empty() && !all {
        return Err(crate::errors::usage(
            "name the comments whose suggestions to apply, or pass --all",
        ));
    }
    let pr = open_pr(ctx, repo, number, "suggestions not applied").await?;
    let (s, view) = (&pr.s, &pr.view);
    let collab = s.collab();
    if !view.state.open {
        return Err(crate::errors::usage(format!(
            "PR #{number} is {}; suggestions apply to open PRs",
            super::state_label(view)
        )));
    }
    let src = writable_source(s, view, number, "apply suggestions").await?;
    let route = head_route(
        s,
        view,
        &format!("apply suggestions to pull request #{number}"),
    )
    .await?;
    require_branch_at_head(s, &src, view, repo, number).await?;
    let comments = collab.comments(&s.repo, &view.patch.document_id).await?;
    let state = view.review_with_threads(&comments);

    let scratch = scratch_with_pr(ctx, &s.repo, view)?;
    let dir = scratch.path();
    let range = view
        .base_tip
        .as_deref()
        .map_or_else(|| view.head.clone(), |b| format!("{b}..{}", view.head));
    let applied = applied_ids(&git::git(dir, &["log", "--format=%B", &range, "--"], &[])?);

    let chosen: Vec<&Comment> = if all {
        // `--all` takes suggestions from the PR's author and the repo's maintainers and writers
        // only (anyone can comment, and triage members and readers cannot push); name another
        // comment to apply it. A suggestion in a resolved
        // thread (the root or a reply) is skipped.
        let resolved: BTreeSet<&str> = state.resolved_threads.iter().map(String::as_str).collect();
        let oracle = collab.member_oracle(&s.repo).await?;
        let trusted = |who: &str| who == view.patch.author || oracle.current_approver(who);
        comments
            .iter()
            .filter(|c| {
                let root = super::threads::root_id(&comments, &c.document_id).unwrap_or_default();
                !applied.contains(&c.document_id)
                    && !resolved.contains(root.as_str())
                    && trusted(&c.author)
            })
            .filter(|c| !parse_suggestions(&c.body).is_empty())
            .filter(|c| plan_suggestion(c, &view.head).is_ok())
            .collect()
    } else {
        let mut out = Vec::new();
        for id in ids {
            let Some(c) = comments.iter().find(|c| &c.document_id == id) else {
                return Err(crate::errors::not_found(
                    format!("comment {id} is not on PR #{number}"),
                    format!("`dg pr view {repo} {number} --comments` lists them"),
                ));
            };
            if applied.contains(id) {
                return Err((*e107(format!(
                    "the suggestion of comment {} is already applied",
                    short(id)
                )))
                .into());
            }
            out.push(c);
        }
        out
    };
    if chosen.is_empty() {
        ctx.emit(
            json!({ "status": "nothing_to_apply", "pr": number, "applied": [], "written": false }),
            || println!("no suggestions left to apply on {}", short(&view.head)),
        );
        return Ok(());
    }
    let plans = chosen
        .iter()
        .map(|c| plan_suggestion(c, &view.head))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| anyhow::Error::from(*e))?;
    let mut files = BTreeMap::new();
    for path in plans
        .iter()
        .map(|p| p.path.as_str())
        .collect::<BTreeSet<_>>()
    {
        let blob = git::regular_file(dir, &view.head, path).map_err(|_| {
            *e107(format!(
                "{} is not a regular text file in the PR head",
                safe(path)
            ))
        })?;
        files.insert(path.to_string(), blob);
    }
    let edited = apply_all(&plans, &files).map_err(|e| anyhow::Error::from(*e))?;

    let mut names = BTreeMap::new();
    for r in plans
        .iter()
        .map(|p| p.reviewer.clone())
        .collect::<BTreeSet<_>>()
    {
        if let Ok(n) = s.client.dpns_names_of(&r).await {
            if let Some(first) = n.into_iter().next() {
                names.insert(r, first);
            }
        }
    }
    let price = ctx.usd_price();
    let est = branch_commit_estimate(route);
    if !ctx.json {
        eprintln!(
            "Apply {} suggestion(s) to {} in {}:",
            plans.len(),
            src.ref_name,
            src.repo_display
        );
        for p in &plans {
            eprintln!(
                "  {}  {} (by {})",
                super::inline::location(&p.path, Some(p.start), Some(p.end), Some(1)),
                short(&p.comment_id),
                p.reviewer
            );
            // The text that will be committed: review it before confirming.
            for line in safe(&p.text).lines() {
                eprintln!("    + {line}");
            }
            if p.text.is_empty() {
                eprintln!("    (deletes the lines)");
            }
        }
    }
    ctx.confirm_or_cancel(&format!(
        "Commit, push and move the PR head? (a pack + ref update + head update, {} plus the pack's storage)",
        cost_line(est, price)
    ))?;

    let mut steps = Steps::new(ctx.json);
    let author = git::merge_author_here(&s.identity.id());
    let tree = git::tree_with(dir, &view.head, &edited)?;
    let commit = git::commit_tree(
        dir,
        &tree,
        &[&view.head],
        &suggestion_message(&plans, &names),
        &author,
    )?;
    steps.ok(
        "commit",
        format!("{} ({} file(s))", short(&commit), edited.len()),
    );
    let event = commit_push_move(ctx, &pr, &src, dir, &commit, &mut steps, repo).await?;
    ctx.emit(
        json!({
            "status": "applied",
            "pr": number,
            "written": true,
            "commit": commit,
            "applied": plans.iter().map(|p| &p.comment_id).collect::<Vec<_>>(),
            "headOid": commit,
            "eventId": event,
            "steps": steps.done,
        }),
        || {
            println!(
                "✓ applied {} suggestion(s) as {} on {}; PR #{number} follows it",
                plans.len(),
                short(&commit),
                src.ref_name
            );
        },
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// update-branch
// ---------------------------------------------------------------------------

/// `dg pr update-branch`: merge the base into the PR branch.
pub async fn update_branch(ctx: &Ctx, repo: &str, number: u64) -> Result<()> {
    let pr = open_pr(ctx, repo, number, "branch not updated").await?;
    let (s, view) = (&pr.s, &pr.view);
    if !view.state.open {
        return Err(crate::errors::usage(format!(
            "PR #{number} is {}; only an open PR's branch is updated",
            super::state_label(view)
        )));
    }
    let Some(base) = view.base_tip.clone() else {
        return Err(crate::errors::usage(format!(
            "{} has no commits; there is nothing to merge in",
            view.patch.base_ref_name
        )));
    };
    // The base is a refspec below (and the source branch a push destination): refuse a
    // malformed one before anything else.
    git::require_branch_ref(&view.patch.base_ref_name)?;
    let src = writable_source(s, view, number, "update the PR branch").await?;
    let route = head_route(s, view, &format!("update pull request #{number}")).await?;
    require_branch_at_head(s, &src, view, repo, number).await?;
    let scratch = scratch_with_pr(ctx, &s.repo, view)?;
    let dir = scratch.path();
    if git::is_ancestor(dir, &base, &view.head) {
        ctx.emit(
            json!({ "status": "up_to_date", "pr": number, "written": false, "headOid": view.head }),
            || {
                println!(
                    "PR #{number} already contains {} ({}); nothing written",
                    view.patch.base_ref_name,
                    short(&base)
                );
            },
        );
        return Ok(());
    }
    let Some(tree) = git::merge_tree(dir, &view.head, &base)? else {
        return Err(super::conflict_error(
            dir,
            &s.repo,
            view.patch.number,
            &view.patch.base_ref_name,
            &base,
            &view.head,
        ));
    };
    ctx.confirm_or_cancel(&format!(
        "Merge {} ({}) into {} of {} and move PR #{number}'s head? ({} plus the pack's storage)",
        view.patch.base_ref_name,
        short(&base),
        src.ref_name,
        src.repo_display,
        cost_line(branch_commit_estimate(route), ctx.usd_price())
    ))?;
    let mut steps = Steps::new(ctx.json);
    let author = git::merge_author_here(&s.identity.id());
    let short_base = view
        .patch
        .base_ref_name
        .strip_prefix("refs/heads/")
        .unwrap_or(&view.patch.base_ref_name);
    let short_src = src
        .ref_name
        .strip_prefix("refs/heads/")
        .unwrap_or(&src.ref_name);
    let message = format!("Merge branch '{short_base}' into {short_src}");
    let commit = git::commit_tree(dir, &tree, &[&view.head, &base], &message, &author)?;
    steps.ok("merge", format!("merge commit {}", short(&commit)));
    let event = commit_push_move(ctx, &pr, &src, dir, &commit, &mut steps, repo).await?;
    ctx.emit(
        json!({
            "status": "updated",
            "pr": number,
            "written": true,
            "headOid": commit,
            "baseOid": base,
            "eventId": event,
            "steps": steps.done,
        }),
        || {
            println!(
                "✓ merged {} into {}; PR #{number} is at {}",
                view.patch.base_ref_name,
                src.ref_name,
                short(&commit)
            );
        },
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// delete the source branch after a merge
// ---------------------------------------------------------------------------

/// The branch `dg pr merge --delete-branch` will delete, checked before the merge.
pub async fn deletable_source(s: &Session, view: &PatchView, number: u64) -> Result<SourceBranch> {
    let src = writable_source(s, view, number, "delete the PR branch").await?;
    if src.repo.id() == s.repo.id() && src.ref_name == view.patch.base_ref_name {
        return Err(crate::errors::usage(
            "the PR's source branch is its base branch; refusing to delete it",
        ));
    }
    let default = forge_core::repo::RepoService::new(&s.client, &s.identity, &s.bridge)
        .read_default_branch(&src.repo)
        .await
        .ok()
        .flatten()
        .map(|b| git::full_ref(&b));
    if default.as_deref() == Some(src.ref_name.as_str()) {
        return Err(crate::errors::usage(format!(
            "{} is the default branch of {}; refusing to delete it",
            src.ref_name, src.repo_display
        )));
    }
    Ok(src)
}

/// Delete the source branch (a push of `:<ref>`).
pub fn delete_source_branch(ctx: &Ctx, src: &SourceBranch) -> Result<()> {
    let scratch = super::scratch_repo()?;
    let dir = scratch.path();
    let mut argv = vec!["-c".to_string(), "dash.prAutoSync=false".to_string()];
    if ctx.yes {
        argv.extend(["-c".into(), "dash.confirm=never".into()]);
    }
    argv.extend([
        "push".into(),
        "-q".into(),
        src.url.clone(),
        format!(":{}", src.ref_name),
    ]);
    push_to(
        dir,
        &argv,
        &git::dash_env_signing(ctx)?,
        "branch not deleted",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use forge_core::rules::v2::AnchorFields;

    const HEAD: &str = "3333333333333333333333333333333333333333";

    fn comment(
        id: &str,
        start: Option<u64>,
        line: u64,
        side: u64,
        oid: &str,
        body: &str,
    ) -> Comment {
        Comment {
            document_id: id.into(),
            author: "rev".into(),
            body: body.into(),
            reply_to: None,
            review_id: None,
            anchor: AnchorFields {
                path: Some("src/a.rs".into()),
                line: Some(line),
                start_line: start,
                side: Some(side),
                commit_oid: Some(oid.into()),
            },
            created_at: 1,
            imported: None,
            diff_hunk: None,
        }
    }

    #[test]
    fn suggestions_apply_bottom_up_and_refuse_overlaps() {
        let file = "a\nb\nc\nd\ne\n".to_string();
        let files = BTreeMap::from([("src/a.rs".to_string(), file)]);
        let one = plan_suggestion(
            &comment("c1", Some(2), 3, 1, HEAD, "```suggestion\nBC\n```"),
            HEAD,
        )
        .unwrap();
        let two = plan_suggestion(
            &comment("c2", None, 5, 1, HEAD, "```suggestion\nE\nE2\n```"),
            HEAD,
        )
        .unwrap();
        let out = apply_all(&[one.clone(), two], &files).unwrap();
        assert_eq!(out["src/a.rs"], "a\nBC\nd\nE\nE2\n");
        let overlapping = plan_suggestion(
            &comment("c3", Some(3), 4, 1, HEAD, "```suggestion\nx\n```"),
            HEAD,
        )
        .unwrap();
        let err = apply_all(&[one, overlapping], &files).unwrap_err();
        assert_eq!(err.code, "E107");
        assert!(err.message.contains("overlap"), "{}", err.message);
    }

    #[test]
    fn inapplicable_suggestions_say_why() {
        let old_head = "4444444444444444444444444444444444444444";
        for (c, want) in [
            (
                comment("x", None, 1, 1, old_head, "```suggestion\ny\n```"),
                "was made on",
            ),
            (
                comment("x", None, 1, 0, HEAD, "```suggestion\ny\n```"),
                "old side",
            ),
            (
                comment("x", None, 1, 1, HEAD, "no block"),
                "no ```suggestion",
            ),
        ] {
            let e = plan_suggestion(&c, HEAD).unwrap_err();
            assert_eq!(e.code, "E107");
            assert!(e.message.contains(want), "{}", e.message);
        }
        let files = BTreeMap::from([("src/a.rs".to_string(), "one\n".to_string())]);
        let past = plan_suggestion(
            &comment("p", Some(4), 5, 1, HEAD, "```suggestion\nz\n```"),
            HEAD,
        )
        .unwrap();
        assert!(apply_all(&[past], &files)
            .unwrap_err()
            .message
            .contains("fewer lines"));
    }

    #[test]
    fn trailers_round_trip() {
        let plans = vec![Planned {
            comment_id: "C1d".into(),
            reviewer: "Rev1".into(),
            path: "a".into(),
            start: 1,
            end: 1,
            text: String::new(),
        }];
        let names = BTreeMap::from([("Rev1".to_string(), "alice.dash".to_string())]);
        let m = suggestion_message(&plans, &names);
        assert_eq!(
            m,
            "Apply suggestions from code review\n\nCo-authored-by: alice.dash <Rev1@users.forge.invalid>\nForge-Suggestion: C1d"
        );
        assert_eq!(applied_ids(&m), BTreeSet::from(["C1d".to_string()]));
    }
}
