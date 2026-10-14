//! `dg publish`: publish a members-only branch, or a members-only pull request's branch, onto a
//! public branch (mixed-visibility DESIGN §4.3 "Merging a members branch into a public one",
//! §4.4 "Merging", D10, §10 "The publish dialog").
//!
//! Two methods, never a merge commit with members-only parents:
//!
//! * **Squash** (the default): one new commit on the base, whose parent is the base's public
//!   tip and whose tree is the branch merged into it. Its author and committer are yours; its
//!   message is editable (`--message`); `Co-authored-by` lines for the branch's other authors
//!   only with `--co-authors`, which says their emails become public. The members-only
//!   commits stay members-only.
//! * **Publish with history** (`--history`): the branch's commits as they are, the base
//!   fast-forwarded to the branch (`git push -o publish-private=<tip>`, the helper's override
//!   of its publication guard). The last commit becomes visibly linked to the branch's
//!   members-only activity. It needs the word `publish` typed (or `--yes`).
//!
//! Before anything is pushed the dialog lists exactly what becomes public (how many commits,
//! by whom, how many files), scans the files that change for secrets (the push helper's rules,
//! `forge-secrets`), and warns when the commit message names the branch. After the push it
//! records the members-only tip and the public commit in `<git common dir>/dash/published`
//! (`dg branch cleanup` reads it), and repairs a local base that holds only the merge the guard
//! refused (`git reset --keep` semantics), else says how.
//!
//! `--pr N` publishes a members-only pull request's branch onto its base and records the pull
//! request merged at the public commit. `--make-public` also makes its comments and reviews
//! public (a maintainer's bundle; its own title and description stay members-only for now).

use std::fmt::Write as _;
use std::path::Path;

use anyhow::{Context as _, Result};
use serde_json::json;

use forge_core::collab::v2::Collab;
use forge_core::repo::short_branch_name;
use forge_core::rules::v2::{Audience, Visibility};
use forge_core::user_error::{codes, UserError};

use crate::branch::{record_published, Published};
use crate::common::Session;
use crate::context::Ctx;
use crate::fmt::{plural, safe, short};
use crate::git;

/// `dg publish` arguments.
#[derive(Debug, clap::Args)]
#[allow(clippy::struct_excessive_bools)] // independent flags, as clap takes them
pub struct PublishArgs {
    /// The members-only branch to publish (default: the current branch).
    #[arg(conflicts_with = "pr")]
    pub branch: Option<String>,
    /// The public branch it is published onto (default: the repository's default branch).
    #[arg(long, conflicts_with = "pr")]
    pub onto: Option<String>,
    /// Publish members-only pull request N's branch onto its base, and record it merged.
    #[arg(long, value_name = "N")]
    pub pr: Option<u64>,
    /// Squash into one commit (the default): one new commit on the base; the members-only
    /// history stays members-only.
    #[arg(long, conflicts_with = "history")]
    pub squash: bool,
    /// Publish with history: the commits are published as they are, and the last one will be
    /// visibly linked to the branch's members-only activity. Needs the word `publish` typed,
    /// or --yes.
    #[arg(long)]
    pub history: bool,
    /// The squash commit's message (default: the branch's commit messages).
    #[arg(long, short = 'm', conflicts_with = "history")]
    pub message: Option<String>,
    /// Add `Co-authored-by` lines for the branch's other authors. Their names and emails
    /// become public.
    #[arg(long, conflicts_with = "history")]
    pub co_authors: bool,
    /// With --pr: also make the pull request's comments and reviews public (maintainers).
    #[arg(long, requires = "pr")]
    pub make_public: bool,
}

/// One commit about to be published.
struct Commit {
    oid: String,
    /// A merge commit (its subject names branches: never put in a squash message).
    merge: bool,
    author: String,
    email: String,
    subject: String,
}

/// What a publish is about to make public, worked out before anything is pushed.
struct Plan {
    /// The members-only branch (`refs/heads/…`).
    branch: String,
    /// Its tip, the commit published.
    tip: String,
    /// The public branch (`refs/heads/…`).
    base: String,
    /// The base's public tip.
    base_tip: String,
    /// The commits the branch adds to the base, oldest first.
    commits: Vec<Commit>,
    /// The files that change on the base.
    files: Vec<String>,
}

impl Plan {
    /// The members-only branch's short name.
    fn branch_name(&self) -> &str {
        short_branch_name(&self.branch)
    }

    /// The public branch's short name.
    fn base_name(&self) -> &str {
        short_branch_name(&self.base)
    }
}

/// `dg publish`.
#[allow(clippy::too_many_lines)] // one publish's steps, in the order they happen
pub async fn run(ctx: &Ctx, a: &PublishArgs) -> Result<()> {
    let cwd = std::env::current_dir().context("reading the current directory")?;
    let repo = crate::storage::clone_repo().ok_or_else(|| {
        crate::errors::usage(
            "run dg publish inside a clone of the repository (it publishes this clone's commits)",
        )
    })?;
    let remote = crate::storage::dash_remote_name().unwrap_or_else(|| "origin".into());
    let s = Session::open_for_write(ctx, &repo, "nothing was published").await?;
    if s.repo.visibility != Visibility::Public {
        return Err(UserError::new(
            codes::USAGE,
            format!(
                "{} is private: its branches are all for its members",
                s.repo.display()
            ),
        )
        .cause("dg publish makes a members-only branch of a public repository public")
        .fix("making a whole private repository public is the owner's: `dg repo make-public`")
        .into());
    }
    let collab = s.collab();
    let fold = collab
        .members_refs(&s.repo)
        .await?
        .ok_or_else(|| crate::pr::members_key_needed(&s.repo, "publish a members-only branch"))?;
    // what is published, and from where
    let (branch, tip, base, pr) = if let Some(n) = a.pr {
        let (branch, tip, base, view) =
            pr_source(ctx, &collab, &s, &cwd, &remote, n, a.history).await?;
        (branch, tip, base, Some((n, view)))
    } else {
        let (branch, tip) = branch_source(&cwd, a.branch.as_deref(), &fold)?;
        let base = if let Some(b) = &a.onto {
            git::full_ref(b)
        } else {
            let svc = forge_core::repo::RepoService::new(&s.client, &s.identity, &s.bridge);
            git::full_ref(
                &svc.read_default_branch(&s.repo)
                    .await?
                    .unwrap_or_else(|| "main".into()),
            )
        };
        (branch, tip, base, None)
    };
    let base_tip = public_base_tip(&fold, &base)?;
    ensure_local(ctx, &cwd, &remote, &base, &base_tip)?;
    // an earlier `dg publish --pr` that published this tip but could not record the merge
    if let Some((n, view)) = &pr {
        if let Some(done) = already_published(&cwd, &tip, &base, &base_tip) {
            return record_merge_only(ctx, &collab, &s, view, *n, &done, &repo).await;
        }
    }
    let plan = plan(&cwd, branch, tip, base, base_tip)?;
    let history = a.history;
    let identity = s.identity.id();
    let author = git::merge_author(&cwd, &identity);
    // the commit pushed: the squash commit, or the tip itself
    let (commit, message) = if history {
        if !git::is_ancestor(&cwd, &plan.base_tip, &plan.tip) {
            return Err(UserError::new(
                codes::USAGE,
                format!(
                    "can't publish {} with history: {} has commits it doesn't have",
                    safe(plan.branch_name()),
                    safe(plan.base_name())
                ),
            )
            .cause("publishing with history moves the public branch forward to this branch's last commit")
            .fix(format!(
                "merge {} into {} first, then publish again",
                safe(plan.base_name()),
                safe(plan.branch_name())
            ))
            .fix("or squash it into one commit (leave out --history)")
            .note("nothing was published")
            .into());
        }
        (plan.tip.clone(), None)
    } else {
        let tree = if git::is_ancestor(&cwd, &plan.base_tip, &plan.tip) {
            git::git(&cwd, &["rev-parse", &format!("{}^{{tree}}", plan.tip)], &[])?
        } else {
            git::merge_tree(&cwd, &plan.base_tip, &plan.tip)?.ok_or_else(|| {
                let files = git::conflicted_paths(&cwd, &plan.base_tip, &plan.tip);
                UserError::new(
                    codes::USAGE,
                    format!(
                        "can't publish {}: it conflicts with {}{}",
                        safe(plan.branch_name()),
                        safe(plan.base_name()),
                        if files.is_empty() {
                            String::new()
                        } else {
                            format!(" in {}", safe(&files.join(", ")))
                        }
                    ),
                )
                .fix(format!(
                    "merge {} into {}, resolve, then publish again",
                    safe(plan.base_name()),
                    safe(plan.branch_name())
                ))
                .note("nothing was published")
            })?
        };
        let message = squash_message(&plan, a.message.as_deref(), a.co_authors, &author);
        let c = git::commit_tree(&cwd, &tree, &[&plan.base_tip], &message, &author)?;
        (c, Some(message))
    };
    let findings = scan(&cwd, &plan, &commit, history);
    dialog(
        ctx,
        &plan,
        &commit,
        message.as_deref(),
        &findings,
        a,
        &author,
    );
    refuse_unseen_branch_name(ctx, &plan, message.as_deref(), a.message.is_some())?;
    if findings.iter().any(|f| f.1) {
        return Err(UserError::new(
            codes::SECRET_IN_PUSH,
            format!(
                "{} would publish a possible secret in {}",
                safe(plan.base_name()),
                safe(
                    &findings
                        .iter()
                        .filter(|f| f.1)
                        .map(|f| f.0.as_str())
                        .collect::<Vec<_>>()
                        .join(", ")
                )
            ),
        )
        .cause("nothing pushed to a public branch can be taken back")
        .fix(
            "remove it from the branch (dg env import keeps values out of git), then publish again",
        )
        .fix("if it is not a secret, list it in .forge/secret-scan-allow")
        .note("nothing was published")
        .into());
    }
    confirm(ctx, &plan, history)?;
    // the push: through the helper, whose guard lets exactly this tip through for history
    let mut argv = crate::pr::push_argv(ctx, &remote, &commit, &plan.base);
    if history {
        let at = argv
            .iter()
            .position(|x| x == "push")
            .map_or(argv.len(), |i| i + 1);
        argv.splice(
            at..at,
            [
                "--no-verify".to_string(),
                "-o".to_string(),
                format!("publish-private={}", plan.tip),
            ],
        );
    }
    let before = s.balance().await;
    crate::pr::push_to(
        &cwd,
        &argv,
        &git::dash_env_signing(ctx)?,
        "nothing was published",
    )?;
    record_published(
        &cwd,
        &Published {
            tip: plan.tip.clone(),
            commit: commit.clone(),
            base: plan.base.clone(),
            branch: plan.branch.clone(),
        },
    )?;
    let repair = repair_local_base(&cwd, &plan, &commit);
    // a pull request is recorded merged at the public commit (DESIGN §4.4)
    let merged = match &pr {
        Some((n, view)) => {
            collab.refs_changed();
            Some(
                crate::pr::post_merge_event(&collab, &s.repo, view, &commit, true, &repo)
                    .await
                    .map_err(|e| merge_not_recorded(*e, *n, &commit))?,
            )
        }
        None => None,
    };
    let spent = s.spent_since(before).await;
    let price = ctx.usd_price();
    ctx.emit(
        json!({
            "status": "published",
            "branch": plan.branch_name(),
            "onto": plan.base_name(),
            "method": if history { "history" } else { "squash" },
            "commit": commit,
            "membersOnlyTip": plan.tip,
            "commits": plan.commits.iter().map(|c| c.oid.as_str()).collect::<Vec<_>>(),
            "files": plan.files.len(),
            "pr": a.pr,
            "mergeTransitionId": merged,
            "localBase": repair.json(),
            "cost": crate::fmt::cost_json(spent, price),
        }),
        || {
            println!(
                "✓ published {} onto {} as {} · {}",
                safe(plan.branch_name()),
                safe(plan.base_name()),
                short(&commit),
                crate::fmt::cost_line(spent, price)
            );
            if let Some(n) = a.pr {
                println!("✓ PR #{n} recorded merged at {}", short(&commit));
            }
            repair.print(&plan, &commit, &remote);
            println!(
                "  clean up later with `dg branch cleanup` (deletes local branches whose content is published)"
            );
        },
    );
    if let (true, Some(n)) = (a.make_public, a.pr) {
        crate::make_public::run(ctx, &repo, &[n.to_string()], true, false)
            .await
            .map_err(|e| {
                let note = format!(
                    "the branch is published and PR #{n} is recorded merged; make its discussion public with `dg make-public {repo} {n} --thread`"
                );
                match e.downcast::<UserError>() {
                    Ok(u) => anyhow::Error::from(u.note(note)),
                    Err(e) => e.context(note),
                }
            })?;
    }
    Ok(())
}

/// The public commit an earlier publish of `tip` onto `base` made, when this clone recorded it
/// and the base holds it now (`base_tip` descends from it).
fn already_published(cwd: &Path, tip: &str, base: &str, base_tip: &str) -> Option<String> {
    let path = crate::branch::published_path(cwd).ok()?;
    let text = std::fs::read_to_string(path).ok()?;
    crate::branch::parse_published(&text)
        .into_iter()
        .rev()
        .find(|p| {
            p.tip.eq_ignore_ascii_case(tip)
                && p.base == base
                && git::has_object(cwd, &p.commit)
                && git::is_ancestor(cwd, &p.commit, base_tip)
        })
        .map(|p| p.commit)
}

/// `dg publish --pr N` again after its merge could not be recorded: the publish is done, so
/// only the merge transition is written, naming the public commit.
async fn record_merge_only(
    ctx: &Ctx,
    collab: &Collab<'_>,
    s: &Session,
    view: &forge_core::collab::v2::PatchView,
    n: u64,
    commit: &str,
    repo: &str,
) -> Result<()> {
    ctx.confirm_or_cancel(&format!(
        "PR #{n} is already published as {}. Record it merged? (one transition, {})",
        short(commit),
        crate::fmt::cost_line(crate::quote::TRANSITION, ctx.usd_price())
    ))?;
    let before = s.balance().await;
    let id = crate::pr::post_merge_event(collab, &s.repo, view, commit, true, repo)
        .await
        .map_err(|e| merge_not_recorded(*e, n, commit))?;
    let spent = s.spent_since(before).await;
    let price = ctx.usd_price();
    ctx.emit(
        json!({
            "status": "merge_recorded",
            "pr": n,
            "commit": commit,
            "mergeTransitionId": id,
            "cost": crate::fmt::cost_json(spent, price),
        }),
        || {
            println!(
                "✓ PR #{n} recorded merged at {} · {}",
                short(commit),
                crate::fmt::cost_line(spent, price)
            );
        },
    );
    Ok(())
}

/// The error when the code is published and the merge transition was not written.
fn merge_not_recorded(e: UserError, n: u64, commit: &str) -> anyhow::Error {
    e.note(format!(
        "the branch is published as {}; run `dg publish --pr {n}` again to record PR #{n} merged",
        short(commit)
    ))
    .into()
}

/// Refuse a branch name git would read as something else (a refspec, a glob, a range).
fn require_branch_name(full: &str) -> Result<()> {
    if git::is_plain_branch_ref(full) {
        Ok(())
    } else {
        Err(crate::errors::usage(format!(
            "{} is not a plain branch name",
            safe(short_branch_name(full))
        )))
    }
}

/// The branch `dg publish <branch>` publishes and its local tip: a members-only branch on Forge,
/// or a local branch started members-only (`dg branch new --members`). A public branch is
/// refused: it is published already.
fn branch_source(
    cwd: &Path,
    branch: Option<&str>,
    fold: &forge_core::repo::MembersRefs,
) -> Result<(String, String)> {
    let name = match branch {
        Some(b) => b.to_string(),
        None => git::current_branch(cwd).ok_or_else(|| {
            crate::errors::usage(
                "not on a branch: name the branch to publish, `dg publish <branch> --onto main`",
            )
        })?,
    };
    let full = git::full_ref(&name);
    require_branch_name(&full)?;
    let tip = git::git(
        cwd,
        &["rev-parse", "--verify", "-q", &format!("{full}^{{commit}}")],
        &[],
    )
    .map_err(|_| {
        crate::errors::not_found(
            format!("{} is not a branch in this clone", safe(&name)),
            format!("fetch it first: `git fetch origin {}`", safe(&name)),
        )
    })?;
    let on_forge = fold.get(&full);
    let members = on_forge.is_some_and(|r| r.members_only)
        || crate::branch::recorded_audience(cwd, short_branch_name(&full))
            == Some(Audience::Members);
    if on_forge.is_some_and(|r| !r.members_only && forge_core::rules::tip_of(&r.state).is_some()) {
        return Err(
            UserError::new(codes::USAGE, format!("{} is already public", safe(&name)))
                .cause(
                    "dg publish publishes a members-only branch; this one everyone can already see",
                )
                .fix(format!(
                    "push it as usual: `git push origin {}`",
                    safe(&name)
                ))
                .into(),
        );
    }
    if !members {
        return Err(UserError::new(
            codes::USAGE,
            format!("{} isn't a members-only branch", safe(&name)),
        )
        .cause("dg publish publishes a branch only members can see")
        .fix(format!(
            "a public branch is pushed as usual: `git push origin {}`",
            safe(&name)
        ))
        .into());
    }
    if let Some(remote_tip) = on_forge.and_then(|r| forge_core::rules::tip_of(&r.state)) {
        if !remote_tip.eq_ignore_ascii_case(&tip) {
            eprintln!(
                "note: publishing {} as it is in this clone ({}); on Forge it is at {}",
                safe(&name),
                short(&tip),
                short(&remote_tip)
            );
        }
    }
    Ok((full, tip))
}

/// A members-only pull request's branch, its real head, its base, and its view (for the merge
/// transition). Its head is fetched when this clone does not hold it.
async fn pr_source(
    ctx: &Ctx,
    collab: &Collab<'_>,
    s: &Session,
    cwd: &Path,
    remote: &str,
    n: u64,
    history: bool,
) -> Result<(String, String, String, forge_core::collab::v2::PatchView)> {
    let number = u32::try_from(n).map_err(|_| crate::errors::usage("no such pull request"))?;
    let p = collab.patch(&s.repo, number).await?.ok_or_else(|| {
        crate::errors::not_found(
            format!("pull request #{n} not found in {}", s.repo.display()),
            format!(
                "`dg pr list {} --audience members` lists them",
                s.repo.display()
            ),
        )
    })?;
    let view = collab.patch_view(&s.repo, p).await?;
    if !view.patch.from_members_only_branch() {
        return Err(UserError::new(
            codes::USAGE,
            format!("PR #{n} isn't from a members-only branch"),
        )
        .cause("dg publish --pr publishes a members-only pull request's branch")
        .fix(format!(
            "merge it as usual: `dg pr merge {} {n}`",
            s.repo.display()
        ))
        .into());
    }
    if view.state.merged {
        return Err(
            UserError::new(codes::USAGE, format!("PR #{n} is already merged"))
                .note("nothing was published")
                .into(),
        );
    }
    // what `dg pr merge` checks before anything is built: open and ready, a base that was a
    // branch when it was opened, the merger's role, the branch policy's approvals and checks
    // and its merge methods (a squash, or a fast-forward with history)
    crate::pr::refuse_unmergeable(&view, n)?;
    crate::pr::refuse_missing_base(&view, n, false)?;
    let method = if history {
        crate::pr::METHOD_FF
    } else {
        crate::pr::METHOD_SQUASH
    };
    let rights = crate::pr::require_merge_rights(ctx, s, &s.repo, &view, Some(method), false)
        .await
        .map_err(|e| as_publish(e, n))?;
    let not_passing =
        crate::pr::head_checks_not_passing(collab, &s.repo, &view, rights.policy.as_ref()).await;
    if !not_passing.is_empty() && !ctx.json {
        eprintln!(
            "warning: some checks were not successful: {}",
            safe(&not_passing.join(", "))
        );
    }
    let branch = view.patch.source_ref_name.clone().unwrap_or_default();
    git::require_branch_ref(&branch)?;
    let tip = collab.real_head(&s.repo, &view).await;
    if !git::is_oid(&tip) || tip.eq_ignore_ascii_case(&view.head) {
        return Err(crate::pr::members_key_needed(
            &s.repo,
            "publish a members-only pull request",
        ));
    }
    ensure_local(ctx, cwd, remote, &branch, &tip)?;
    let base = view.merge_base.ref_name.clone();
    git::require_branch_ref(&base)?;
    Ok((branch, tip, base, view))
}

/// A refusal `dg pr merge`'s checks gave, worded for `dg publish --pr n`.
fn as_publish(e: anyhow::Error, n: u64) -> anyhow::Error {
    match e.downcast::<UserError>() {
        Ok(mut u) => {
            u.message = u.message.replacen("merge failed", "not published", 1);
            for f in &mut u.fix {
                *f = f.replace("`dg pr merge`", &format!("`dg publish --pr {n}`"));
            }
            if let Some(note) = &mut u.note {
                *note = note.replace("no merge event was posted", "nothing was published");
            }
            u.into()
        }
        Err(e) => e,
    }
}

/// The public tip of `base`, or a refusal: it must be a live public branch.
fn public_base_tip(fold: &forge_core::repo::MembersRefs, base: &str) -> Result<String> {
    require_branch_name(base)?;
    let tip = match fold.get(base) {
        Some(r) if !r.members_only => forge_core::rules::tip_of(&r.state),
        Some(_) => {
            return Err(UserError::new(
                codes::USAGE,
                format!("{} is members-only", safe(short_branch_name(base))),
            )
            .cause("dg publish publishes onto a public branch")
            .fix("merge into a members-only branch as usual (git merge, git push)")
            .into())
        }
        None => None,
    };
    tip.ok_or_else(|| {
        crate::errors::not_found(
            format!(
                "{} is not a public branch of this repository",
                safe(short_branch_name(base))
            ),
            "pass --onto <branch> naming one (`dg branch` lists them)",
        )
    })
}

/// Fetch `name` from `remote` when this clone does not hold `oid`.
fn ensure_local(ctx: &Ctx, cwd: &Path, remote: &str, name: &str, oid: &str) -> Result<()> {
    if git::has_object(cwd, oid) {
        return Ok(());
    }
    git::git_dash(
        cwd,
        &["fetch", "-q", remote, name],
        &git::dash_env_signing(ctx)?,
    )
    .with_context(|| format!("fetching {} from {remote}", short_branch_name(name)))?;
    if git::has_object(cwd, oid) {
        Ok(())
    } else {
        Err(crate::errors::not_found(
            format!(
                "{} is not in this clone after fetching {}",
                short(oid),
                short_branch_name(name)
            ),
            format!("`git fetch {remote}` and try again"),
        ))
    }
}

/// The commits and files `tip` adds to `base_tip`.
fn plan(cwd: &Path, branch: String, tip: String, base: String, base_tip: String) -> Result<Plan> {
    let log = git::git(
        cwd,
        &[
            "log",
            "--reverse",
            "--format=%H%x00%P%x00%an%x00%ae%x00%s",
            &format!("{base_tip}..{tip}"),
            "--",
        ],
        &[],
    )?;
    let commits: Vec<Commit> = log
        .lines()
        .filter_map(|l| {
            let mut f = l.split('\0');
            Some(Commit {
                oid: f.next()?.to_string(),
                merge: f.next()?.split_whitespace().count() > 1,
                author: f.next()?.to_string(),
                email: f.next()?.to_string(),
                subject: f.next().unwrap_or_default().to_string(),
            })
        })
        .collect();
    if commits.is_empty() {
        return Err(UserError::new(
            codes::USAGE,
            format!(
                "nothing to publish: {} has no commits {} doesn't have",
                safe(short_branch_name(&branch)),
                safe(short_branch_name(&base))
            ),
        )
        .into());
    }
    let files = git::git(
        cwd,
        &[
            "diff",
            "--name-only",
            "--no-renames",
            &format!("{base_tip}...{tip}"),
            "--",
        ],
        &[],
    )?
    .lines()
    .map(str::to_string)
    .collect();
    Ok(Plan {
        branch,
        tip,
        base,
        base_tip,
        commits,
        files,
    })
}

/// The people who wrote `plan`'s commits (distinct names, in order).
fn authors(plan: &Plan) -> Vec<&str> {
    let mut out: Vec<&str> = Vec::new();
    for c in &plan.commits {
        if !out.contains(&c.author.as_str()) {
            out.push(&c.author);
        }
    }
    out
}

/// The other authors' `Name <email>`, distinct, for co-author lines (the publisher's own email
/// is left out).
fn co_authors(plan: &Plan, me: &[(String, String)]) -> Vec<String> {
    let my_email = me
        .iter()
        .find(|(k, _)| k == "GIT_AUTHOR_EMAIL")
        .map(|(_, v)| v.as_str());
    let mut out: Vec<String> = Vec::new();
    for c in &plan.commits {
        let line = format!("{} <{}>", c.author, c.email);
        if Some(c.email.as_str()) != my_email && !out.contains(&line) {
            out.push(line);
        }
    }
    out
}

/// The squash commit's message: `--message`, else the one commit's subject, else the newest
/// subject over a list of every subject; co-author lines only when asked.
fn squash_message(plan: &Plan, message: Option<&str>, co: bool, me: &[(String, String)]) -> String {
    // merge commits' subjects name branches ("Merge branch 'main' into sec/fix"): left out
    let subjects: Vec<&str> = plan
        .commits
        .iter()
        .filter(|c| !c.merge)
        .map(|c| c.subject.as_str())
        .collect();
    let mut m = match (message, subjects.as_slice()) {
        (Some(m), _) => m.trim_end().to_string(),
        (None, []) => "Publish".to_string(),
        (None, [one]) => (*one).to_string(),
        (None, [.., last]) => {
            let mut m = (*last).to_string();
            m.push_str("\n\n");
            for subject in &subjects {
                let _ = writeln!(m, "* {subject}");
            }
            m.trim_end().to_string()
        }
    };
    let trailers = if co { co_authors(plan, me) } else { Vec::new() };
    if !trailers.is_empty() {
        m.push_str("\n\n");
        for t in trailers {
            let _ = writeln!(m, "Co-authored-by: {t}");
        }
        m = m.trim_end().to_string();
    }
    m
}

/// Possible secrets in what a publish makes public, by the push helper's rules: `(location,
/// refuses)` per finding. A squash publishes one tree (the files that change between
/// `base_tip` and `commit`); publishing with history publishes every commit, so each commit's
/// added and changed files are scanned (a secret added and later removed is still published).
fn scan(cwd: &Path, plan: &Plan, commit: &str, history: bool) -> Vec<(String, bool)> {
    let mut out: Vec<(String, bool)> = Vec::new();
    let mut seen = std::collections::BTreeSet::new();
    let changes: Vec<(String, Vec<String>)> = if history {
        plan.commits
            .iter()
            .filter(|c| !c.merge)
            .map(|c| {
                (
                    c.oid.clone(),
                    changed_files(cwd, &format!("{}^", c.oid), &c.oid),
                )
            })
            .collect()
    } else {
        vec![(
            commit.to_string(),
            changed_files(cwd, &plan.base_tip, commit),
        )]
    };
    for (at, paths) in changes {
        for path in paths {
            for f in scan_blob(cwd, &at, &path) {
                if seen.insert(f.0.clone()) {
                    out.push(f);
                }
            }
        }
    }
    out
}

/// The files added or changed from `from` to `to`.
fn changed_files(cwd: &Path, from: &str, to: &str) -> Vec<String> {
    git::git(
        cwd,
        &[
            "diff",
            "--name-only",
            "--no-renames",
            "--diff-filter=AM",
            from,
            to,
            "--",
        ],
        &[],
    )
    .map(|o| o.lines().map(str::to_string).collect())
    .unwrap_or_default()
}

/// The findings in file `path` of commit `commit`.
fn scan_blob(cwd: &Path, commit: &str, path: &str) -> Vec<(String, bool)> {
    let Ok(bytes) = git::git_bytes(cwd, &["cat-file", "blob", &format!("{commit}:{path}")]) else {
        return Vec::new();
    };
    let readable =
        bytes.len() <= forge_secrets::MAX_SCAN_BYTES && forge_secrets::is_scannable(&bytes);
    let findings = if readable {
        forge_secrets::scan_file(path, &bytes)
    } else {
        forge_secrets::scan_unread(path, &forge_secrets::git_blob_id(&bytes))
    };
    findings
        .iter()
        .map(|f| {
            let refuses =
                forge_secrets::verdict(f, false).severity == forge_secrets::Severity::Refuse;
            (f.location(), refuses)
        })
        .collect()
}

/// The publish dialog in CLI form (§10): the exact list, the scan line, the method, the
/// co-author line, and a branch-name warning.
fn dialog(
    ctx: &Ctx,
    plan: &Plan,
    commit: &str,
    message: Option<&str>,
    findings: &[(String, bool)],
    a: &PublishArgs,
    me: &[(String, String)],
) {
    if ctx.json {
        return;
    }
    // with history the commits' author emails become public too
    let names: Vec<String> = if a.history {
        let mut out: Vec<String> = Vec::new();
        for c in &plan.commits {
            let who = format!("{} <{}>", c.author, c.email);
            if !out.contains(&who) {
                out.push(who);
            }
        }
        out
    } else {
        authors(plan).into_iter().map(str::to_string).collect()
    };
    let by = match names.as_slice() {
        [] => String::new(),
        [one] => format!(" by {}", safe(one)),
        [rest @ .., last] => format!(" by {} and {}", safe(&rest.join(", ")), safe(last)),
    };
    println!("Publish to everyone? This can't be undone. Anything published stays public forever, even if you delete it later.");
    println!(
        "  {}{by} · {}",
        plural(plan.commits.len(), "commit"),
        plural(plan.files.len(), "file")
    );
    if findings.is_empty() {
        println!("  No secrets found.");
    } else {
        for (at, _) in findings {
            println!("  Possible secret in {}", safe(at));
        }
    }
    let base = plan.base_name();
    if a.history {
        if plan.commits.len() == 1 {
            println!(
                "  Publish with history: the commit is published as it is. It will be visibly linked to this branch's members-only activity."
            );
        } else {
            println!(
                "  Publish with history: the {} are published as they are. The last one will be visibly linked to this branch's members-only activity.",
                plural(plan.commits.len(), "commit")
            );
        }
    } else {
        println!(
            "  Squash into one commit: one new commit on {} ({}); the members-only history stays members-only.",
            safe(base),
            short(commit)
        );
        if let Some(m) = message {
            println!("  Message:");
            for line in m.lines() {
                println!("    {}", safe(line));
            }
        }
        let co = co_authors(plan, me);
        if !co.is_empty() && !a.co_authors {
            println!(
                "  Add co-author lines for {} with --co-authors (these emails become public)",
                safe(&co.join(", "))
            );
        }
    }
    let branch = plan.branch_name();
    let names_branch = |text: &str| !branch.is_empty() && text.contains(branch);
    if message.is_some_and(names_branch)
        || (a.history && plan.commits.iter().any(|c| names_branch(&c.subject)))
    {
        println!(
            "  Warning: the message names the members-only branch {}; that name becomes public",
            safe(branch)
        );
    }
}

/// A squash message that names the members-only branch, chosen by nobody (no `-m`) and with
/// no terminal to show it on: refused, so a script never publishes the name unseen.
fn refuse_unseen_branch_name(
    ctx: &Ctx,
    plan: &Plan,
    message: Option<&str>,
    given: bool,
) -> Result<()> {
    let branch = plan.branch_name();
    let named = message.is_some_and(|m| !branch.is_empty() && m.contains(branch));
    if !named || given || ctx.interactive() {
        return Ok(());
    }
    Err(UserError::new(
        codes::USAGE,
        format!(
            "the squash commit's message would name the members-only branch {}",
            safe(branch)
        ),
    )
    .cause("the message is public once published, and the branch's name is members-only")
    .fix("pass the message yourself: -m \"…\"")
    .note("nothing was published")
    .into())
}

/// The confirmation: a yes for a squash; the word `publish` typed for history (or --yes).
fn confirm(ctx: &Ctx, plan: &Plan, history: bool) -> Result<()> {
    let what = format!(
        "Publish {} onto {}?",
        safe(plan.branch_name()),
        safe(plan.base_name())
    );
    if !history || ctx.yes {
        return ctx.confirm_or_cancel(&what);
    }
    if !ctx.interactive() {
        return Err(UserError::new(
            codes::CONFIRMATION_REQUIRED,
            "publishing with history needs the word `publish` typed",
        )
        .fix("run it in a terminal, or pass --yes")
        .note("nothing was published")
        .into());
    }
    eprint!("{what} Type publish to publish these commits as they are: ");
    let mut line = String::new();
    std::io::stdin()
        .read_line(&mut line)
        .context("reading confirmation")?;
    if line.trim() == "publish" {
        Ok(())
    } else {
        Err(crate::errors::cancelled())
    }
}

/// What happened to the local base branch after a publish.
enum Repair {
    /// Nothing to do: no local base, or it does not hold the branch.
    Untouched,
    /// It held only the refused merge: moved to the published commit.
    Moved,
    /// It holds the branch and more: the command that repairs it.
    Hint,
}

impl Repair {
    fn json(&self) -> &'static str {
        match self {
            Self::Untouched => "untouched",
            Self::Moved => "moved",
            Self::Hint => "needs-reset",
        }
    }

    fn print(&self, plan: &Plan, commit: &str, remote: &str) {
        let base = safe(plan.base_name());
        match self {
            Self::Untouched => {}
            Self::Moved => println!("✓ moved your local {base} to {}", short(commit)),
            Self::Hint => println!(
                "  your local {base} still holds the members-only commits: `git reset --keep {}/{base}`, after saving anything else on it",
                safe(remote)
            ),
        }
    }
}

/// After a publish, the local base branch that holds the merge of the members-only branch the
/// guard refused, and nothing else new, is moved to the published commit (`git reset --keep`
/// when it is checked out); one that holds more gets the command (`git reset --keep
/// origin/<base>`), never a reset that could lose work.
fn repair_local_base(cwd: &Path, plan: &Plan, commit: &str) -> Repair {
    let Ok(local) = git::git(cwd, &["rev-parse", "--verify", "-q", &plan.base], &[]) else {
        return Repair::Untouched;
    };
    if local.eq_ignore_ascii_case(commit) || !git::is_ancestor(cwd, &plan.tip, &local) {
        return Repair::Untouched;
    }
    // what the local base adds beyond the public base and the branch: merges only
    let extra = git::git(
        cwd,
        &[
            "rev-list",
            "--no-merges",
            &local,
            &format!("^{}", plan.base_tip),
            &format!("^{}", plan.tip),
        ],
        &[],
    )
    .unwrap_or_else(|_| "?".into());
    let tree = |c: &str| git::git(cwd, &["rev-parse", &format!("{c}^{{tree}}")], &[]).ok();
    let local_tree = tree(&local);
    if !extra.trim().is_empty() || local_tree.is_none() || local_tree != tree(commit) {
        return Repair::Hint;
    }
    let current = git::current_branch(cwd).map(|b| git::full_ref(&b));
    // a base checked out in another worktree is that worktree's: never moved from here
    let checked_out_here = current.as_deref() == Some(plan.base.as_str());
    let marker = format!("branch {}", plan.base);
    let elsewhere = git::git(cwd, &["worktree", "list", "--porcelain"], &[])
        .map_or(0, |o| o.lines().filter(|l| *l == marker).count())
        > usize::from(checked_out_here);
    if elsewhere {
        return Repair::Hint;
    }
    let moved = if checked_out_here {
        git::git(cwd, &["reset", "-q", "--keep", commit], &[]).is_ok()
    } else {
        git::git(cwd, &["update-ref", &plan.base, commit, &local], &[]).is_ok()
    };
    if moved {
        Repair::Moved
    } else {
        Repair::Hint
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan_of(commits: &[(&str, &str, &str)]) -> Plan {
        Plan {
            branch: "refs/heads/sec/fix".into(),
            tip: "t".repeat(40),
            base: "refs/heads/main".into(),
            base_tip: "b".repeat(40),
            commits: commits
                .iter()
                .enumerate()
                .map(|(i, (a, e, s))| Commit {
                    oid: format!("{i:040}"),
                    merge: s.starts_with("Merge "),
                    author: (*a).into(),
                    email: (*e).into(),
                    subject: (*s).into(),
                })
                .collect(),
            files: vec!["a.rs".into()],
        }
    }

    fn me() -> Vec<(String, String)> {
        vec![
            ("GIT_AUTHOR_NAME".into(), "alice".into()),
            ("GIT_AUTHOR_EMAIL".into(), "alice@x".into()),
        ]
    }

    #[test]
    fn squash_message_lists_subjects_and_adds_co_authors_only_when_asked() {
        let p = plan_of(&[
            ("alice", "alice@x", "Fix bounds check"),
            ("bob", "bob@x", "Add test"),
            ("bob", "bob@x", "Tidy"),
        ]);
        let m = squash_message(&p, None, false, &me());
        assert_eq!(m, "Tidy\n\n* Fix bounds check\n* Add test\n* Tidy");
        assert!(!m.contains("Co-authored-by"));
        let m = squash_message(&p, Some("Fix CVE"), true, &me());
        assert_eq!(m, "Fix CVE\n\nCo-authored-by: bob <bob@x>");
        let one = plan_of(&[("bob", "bob@x", "Only")]);
        assert_eq!(squash_message(&one, None, false, &me()), "Only");
        // a merge's subject names branches: left out
        let merged = plan_of(&[
            ("bob", "bob@x", "Fix"),
            ("bob", "bob@x", "Merge branch 'main' into sec/fix"),
            ("bob", "bob@x", "Test"),
        ]);
        assert_eq!(
            squash_message(&merged, None, false, &me()),
            "Test\n\n* Fix\n* Test"
        );
    }

    #[test]
    fn authors_are_distinct_in_order() {
        let p = plan_of(&[
            ("bob", "b@x", "1"),
            ("alice", "a@x", "2"),
            ("bob", "b@x", "3"),
        ]);
        assert_eq!(authors(&p), vec!["bob", "alice"]);
    }
}
