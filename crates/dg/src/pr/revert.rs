//! `dg pr revert`: GitHub's Revert button for a merged pull request.
//!
//! Like `dg pr merge`, the git work happens in a throwaway repository (the base branch fetched
//! over `dash://`), so the user's clone and working tree are never touched and nothing is left
//! half-done when it stops. The recorded merge is classified by the shared reader rule
//! (`forge_core::rules::merge_check`, as `dg pr verify` reads it), and only a merge that
//! contains the PR, or is a squash or a rebase of it, is reverted:
//!
//! - a merge commit (the PR's head on its second side): `git revert -m 1`, the merge against its
//!   first parent;
//! - a squash commit: `git revert` of that commit;
//! - a rebase: the commits it added on the base's previous tip, newest first, as one commit;
//! - a fast-forward: the PR's own commits (those since it forked from the base's previous tip).
//!
//! Each is one three-way merge (`git merge-tree --merge-base`) onto the base's current tip:
//! what `git revert` computes, without a working tree. A conflict stops before anything is
//! pushed. The result is pushed to a new branch, `revert-<n>-<head branch>`, and a PR
//! `Revert "<title>"` is opened into the same base.

use std::path::Path;
use std::process::Command;

use anyhow::{Context, Result};
use serde_json::json;

use forge_core::collab::v2::{PatchInput, PatchView};
use forge_core::create::default_journal_dir;
use forge_core::rules::merge_check::{head_at, merge_content, MergeFacts, MergeVerdict};
use forge_core::rules::v2::{Audience, Role, Visibility};
use forge_core::user_error::{codes, UserError};

use super::{patch, push_argv, push_to, verify, Steps};
use crate::common::Session;
use crate::context::Ctx;
use crate::fmt::{cost_json, cost_line, safe, short};
use crate::git;

/// The longest pull request title (characters), as `dg pr create` checks it.
const TITLE_MAX: usize = 256;

/// How the recorded merge brought the PR into the base, which decides what is undone.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Landed {
    /// A merge commit with the PR's head on its second side.
    MergeCommit,
    /// One commit on the base's previous tip making the PR's changes.
    Squash,
    /// Commits on the base's previous tip that together make the PR's changes.
    Rebase,
    /// The base moved to the PR's head (or a commit after it) without a merge commit.
    FastForward,
}

impl Landed {
    /// For `--json` (`landed`).
    fn as_str(self) -> &'static str {
        match self {
            Landed::MergeCommit => "merge-commit",
            Landed::Squash => "squash",
            Landed::Rebase => "rebase",
            Landed::FastForward => "fast-forward",
        }
    }

    /// What is reverted, for people.
    fn words(self, merge_oid: &str) -> String {
        match self {
            Landed::MergeCommit => {
                format!("merge commit {} against its first parent", short(merge_oid))
            }
            Landed::Squash => format!("squash commit {}", short(merge_oid)),
            Landed::Rebase => format!("the rebased commits up to {}", short(merge_oid)),
            Landed::FastForward => "the PR's commits".to_string(),
        }
    }
}

/// What undoing a merge means as one three-way merge onto the base's tip: the change from
/// `from` back to `to` (`git revert` of commit C is the merge of C's parent with C as the
/// merge base).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Inverse {
    pub(crate) landed: Landed,
    /// The merge base: the state the merge produced.
    pub(crate) from: String,
    /// The state before it.
    pub(crate) to: String,
}

/// The inverse of the merge `facts` describes, read from `dir` (which holds the base's history
/// and the merged head), when the verdict says it brought the PR in. `None` for a merge that
/// does not contain the PR, or whose commits could not be read well enough to tell what to
/// undo.
pub(crate) fn inverse(dir: &Path, facts: &MergeFacts, verdict: MergeVerdict) -> Option<Inverse> {
    let (head, merge, before) = (&facts.head_oid, &facts.merge_oid, &facts.tip_before);
    let first_parent = facts.merge_parents.first();
    match verdict {
        MergeVerdict::Squash => Some(Inverse {
            landed: Landed::Squash,
            from: merge.clone(),
            to: first_parent?.clone(),
        }),
        MergeVerdict::Rebase => (!before.is_empty()).then(|| Inverse {
            landed: Landed::Rebase,
            from: merge.clone(),
            to: before.clone(),
        }),
        MergeVerdict::Contains => {
            // A merge commit whose second side brought the head in (and whose first did not):
            // `git revert -m 1`.
            let first = first_parent?;
            let second_side = facts.merge_parents[1..]
                .iter()
                .any(|p| p == head || git::is_ancestor(dir, head, p));
            if second_side && !git::is_ancestor(dir, head, first) {
                return Some(Inverse {
                    landed: Landed::MergeCommit,
                    from: merge.clone(),
                    to: first.clone(),
                });
            }
            // A fast-forward: the PR's own commits, those the head has and the base's previous
            // tip does not. Nothing to undo when the base already held the head.
            if before.is_empty() || git::is_ancestor(dir, head, before) {
                return None;
            }
            let fork = git::git(dir, &["merge-base", head, before], &[]).ok()?;
            git::is_oid(&fork).then(|| Inverse {
                landed: Landed::FastForward,
                from: head.clone(),
                to: fork,
            })
        }
        MergeVerdict::Missing | MergeVerdict::Unknown => None,
    }
}

/// The tree of `onto` with `inv` undone: `Ok(Ok(tree))`, or `Ok(Err(paths))` when it conflicts
/// (the conflicting paths). Nothing is written to any ref.
pub(crate) fn revert_tree(
    dir: &Path,
    onto: &str,
    inv: &Inverse,
) -> Result<std::result::Result<String, Vec<String>>> {
    let out = Command::new("git")
        .current_dir(dir)
        .args([
            "merge-tree",
            "--write-tree",
            "--name-only",
            "--no-messages",
            &format!("--merge-base={}", inv.from),
            onto,
            &inv.to,
        ])
        .output()
        .context("running git merge-tree (needs git 2.40 or newer)")?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let mut lines = stdout.lines();
    let tree = lines.next().unwrap_or_default().trim().to_string();
    match out.status.code() {
        Some(0) if git::is_oid(&tree) => Ok(Ok(tree)),
        Some(1) => Ok(Err(lines
            .filter(|l| !l.trim().is_empty())
            .map(str::to_string)
            .collect())),
        _ => anyhow::bail!(
            "git merge-tree failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ),
    }
}

/// How to make the revert by hand in a clone, for `inv` (`None`: what the merge brought in is
/// not known, so both forms are given): each kind undoes everything it landed.
pub(crate) fn manual_revert(inv: Option<&Inverse>, merge_oid: &str) -> String {
    match inv {
        Some(i) if i.landed == Landed::MergeCommit => format!("`git revert -m 1 {merge_oid}`"),
        Some(i) if i.landed == Landed::Squash => format!("`git revert {merge_oid}`"),
        Some(i) => format!(
            "`git revert --no-commit {}..{}` then `git commit`; a merge commit in that range is reverted on its own, with `git revert --no-commit -m 1 <commit>`",
            i.to, i.from
        ),
        None => format!(
            "`git revert -m 1 {merge_oid}` for a merge commit, or `git revert --no-commit <the base's commit before the merge>..{merge_oid}` then `git commit` for a squash, rebase or fast-forward (a merge commit in that range is reverted on its own, with `git revert --no-commit -m 1 <commit>`)"
        ),
    }
}

/// The revert commit's message: git's `Revert "<subject>"`, then which PR and merge it undoes.
pub(crate) fn revert_message(title: &str, number: u32, merge_oid: &str) -> String {
    format!("Revert \"{title}\"\n\nThis reverts pull request #{number}, merged as {merge_oid}.")
}

/// The revert PR's title, `Revert "<title>"`, cut to the field's length.
pub(crate) fn revert_title(title: &str) -> String {
    let full = format!("Revert \"{title}\"");
    if full.chars().count() <= TITLE_MAX {
        return full;
    }
    let keep: String = title
        .chars()
        .take(TITLE_MAX - "Revert \"…\"".chars().count())
        .collect();
    format!("Revert \"{keep}…\"")
}

/// The revert PR's description: GitHub's `Reverts #<n>`, and the merge it undoes.
/// `s` as one POSIX shell word: single-quoted, each `'` written as `'\''`, so `$(…)`, backticks
/// and `$VAR` in it stay literal when the command is pasted.
fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

pub(crate) fn revert_body(number: u32, merge_oid: &str, landed: Landed) -> String {
    format!(
        "Reverts #{number}\n\nThis undoes {} on the base branch.",
        landed.words(merge_oid)
    )
}

/// Whether `name` (`refs/heads/…`) is a branch name git and Platform accept.
fn usable_branch(name: &str) -> bool {
    name.len() <= 255
        && name
            .strip_prefix("refs/heads/")
            .is_some_and(|b| !b.is_empty())
        && git::git_ok(Path::new("."), &["check-ref-format", name])
}

/// The branch a revert of PR `number` goes to by default: GitHub's `revert-<n>-<head branch>`,
/// or `revert-<n>` when the head branch is unknown or does not make a usable name.
pub(crate) fn default_branch(number: u32, source_ref: Option<&str>) -> String {
    let named = source_ref
        .map(forge_core::repo::short_branch_name)
        .map(|b| format!("refs/heads/revert-{number}-{b}"))
        .filter(|r| usable_branch(r));
    named.unwrap_or_else(|| format!("refs/heads/revert-{number}"))
}

/// A refusal of `dg pr revert` before anything was pushed or written.
fn refusal(
    code: &'static str,
    headline: impl std::fmt::Display,
    cause: impl Into<String>,
) -> UserError {
    UserError::new(code, format!("revert not attempted: {headline}"))
        .cause(cause)
        .note("nothing was pushed or written")
}

/// Refuse a pull request whose revert would reach more people than the pull request did: the
/// revert's title, `Revert "<title>"`, and its commit message repeat the title. A members-only
/// PR of a public repository (`dg` opens public PRs there; members-only ones can't be opened from
/// `dg` yet), and a PR for specific people in any repository (`dg` can't write for specific
/// people). In a private repository everything, the revert included, is for its members.
pub(crate) fn audience_refusal(
    visibility: Visibility,
    audience: Audience,
    repo: &str,
    number: u64,
) -> Option<UserError> {
    let (who, cause) = match audience {
        Audience::SpecificPeople => (
            "is for specific people",
            "dg can't open a pull request for specific people, so its revert would reach more people than it did, and its title would go with it",
        ),
        Audience::Members if visibility == Visibility::Public => (
            "is members-only",
            "dg can't open a members-only pull request yet, so its revert would be public, and its title would become public for good",
        ),
        _ => return None,
    };
    Some(
        refusal(codes::USAGE, format!("PR #{number} {who}"), cause).fix(format!(
            "revert it by hand in a clone (`dg pr view {repo} {number}` shows the merge commit) and open its pull request for the same people"
        )),
    )
}

/// Refuse a PR that has no merge to revert: not merged, or merged naming no commit the base held.
fn require_revertable(view: &PatchView, repo: &str, number: u64) -> Result<String> {
    if !view.state.merged {
        let state = if view.state.open { "open" } else { "closed" };
        return Err(refusal(
            codes::REJECTED,
            format!("PR #{number} is not merged"),
            format!("it is {state}; only a merged pull request can be reverted"),
        )
        .fix(format!("`dg pr view {repo} {number}` shows its state"))
        .into());
    }
    verify::checkable_merge(view).ok_or_else(|| {
        let why = if view.state.merge_on_base == Some(false) {
            "its merge names a commit that was never a tip of the base branch"
        } else {
            "its merge names no commit"
        };
        refusal(
            codes::REJECTED,
            format!("PR #{number} has no merge commit to revert"),
            why,
        )
        .fix(format!(
            "`dg pr verify {repo} {number}` says what its merge recorded"
        ))
        .into()
    })
}

/// `dg pr revert <repo> <n> [--branch <name>]`.
#[allow(clippy::too_many_lines)]
pub(crate) async fn run(ctx: &Ctx, repo: &str, number: u64, branch: Option<&str>) -> Result<()> {
    let s = Session::open_for_write(ctx, repo, "revert not attempted").await?;
    // A revert opens a pull request: refused (E610) for a banned writer before anything is pushed.
    s.refuse_if_banned("revert not attempted").await?;
    let (handle, collab) = (&s.repo, s.collab());
    let p = patch(&collab, handle, repo, number).await?;
    let view = collab.patch_view(handle, p).await?;
    let merge_oid = require_revertable(&view, repo, number)?;
    if let Some(u) = audience_refusal(handle.visibility, view.patch.audience, repo, number) {
        return Err(u.into());
    }
    let base_ref = view.merge_base.ref_name.clone();
    let short_base = forge_core::repo::short_branch_name(&base_ref).to_string();
    let Some(base_tip) = view.base_tip.clone() else {
        return Err(refusal(
            codes::NOT_FOUND,
            format!("the base branch {} has been deleted", safe(&short_base)),
            "a revert is opened as a pull request into the branch the PR merged into",
        )
        .into());
    };
    // Pushing the revert branch needs write access to the repository.
    collab
        .require_role(
            handle,
            Role::Writer,
            &format!("revert pull request #{number}"),
        )
        .await?;

    let branch_ref = match branch {
        Some(b) => {
            let r = git::full_ref(b);
            if !usable_branch(&r) {
                return Err(crate::errors::usage(format!(
                    "--branch {:?} is not a usable branch name",
                    safe(b)
                )));
            }
            r
        }
        None => default_branch(view.patch.number, view.patch.source_ref_name.as_deref()),
    };
    let short_branch = forge_core::repo::short_branch_name(&branch_ref).to_string();
    let svc = forge_core::repo::RepoService::new(&s.client, &s.identity, &s.bridge);
    let refs = svc.read_refs(handle).await?;
    let live: Vec<&str> = refs
        .iter()
        .filter(|(_, st)| forge_core::rules::tip_of(st).is_some())
        .map(|(n, _)| n.as_str())
        .collect();
    let taken = if live.contains(&branch_ref.as_str()) {
        Some(format!("{} already exists", safe(&short_branch)))
    } else {
        forge_core::rules::ref_collision::ref_collision(live.iter().copied(), &branch_ref)
            .map(|e| forge_core::rules::ref_collision::collision_reason(&branch_ref, &e))
    };
    if let Some(why) = taken {
        return Err(refusal(
            codes::ALREADY_EXISTS,
            format!("the branch {} cannot be created", safe(&short_branch)),
            why,
        )
        .fix(format!(
            "name another branch: `dg pr revert {repo} {number} --branch <name>`"
        ))
        .into());
    }

    let mut steps = Steps::new(ctx.json);
    let merged_at = view.merged_at().unwrap_or(u64::MAX);
    let head = head_at(&view.review, &view.patch.head_oid, merged_at);
    if !ctx.json {
        eprintln!(
            "Reverting PR #{number} of {} ({}, merged as {})",
            handle.display(),
            safe(&view.patch.title),
            short(&merge_oid)
        );
    }
    let scratch = verify::scratch_for_check(ctx, handle, &view, &head)?;
    let dir = scratch.path();
    steps.ok(
        "fetch",
        format!("{} at {}", safe(&short_base), short(&base_tip)),
    );
    if !git::has_object(dir, &merge_oid) {
        return Err(refusal(
            codes::NOT_FOUND,
            format!(
                "the merge commit {} is not in {}'s history any more",
                short(&merge_oid),
                safe(&short_base)
            ),
            "the base branch was rewritten after the merge, so its commit could not be fetched",
        )
        .fix(format!(
            "if a clone of yours still has {merge_oid}, revert it there ({}), push a branch and open a PR with `dg pr create`",
            manual_revert(None, &merge_oid)
        ))
        .into());
    }
    if !git::is_ancestor(dir, &merge_oid, &base_tip) {
        return Err(refusal(
            codes::REJECTED,
            format!(
                "the merge {} is no longer in {}",
                short(&merge_oid),
                safe(&short_base)
            ),
            "the base branch was rewritten after the merge, so there is nothing of it to undo there",
        )
        .into());
    }
    let facts = verify::merge_facts(dir, &head, &merge_oid, &view.tip_before(&merge_oid));
    let content = merge_content(&facts);
    let Some(inv) = inverse(dir, &facts, content.verdict) else {
        let (code, cause) = match content.verdict {
            MergeVerdict::Missing => (
                codes::REJECTED,
                format!(
                    "the recorded merge {} does not contain this PR's commits, so there is nothing of the PR to undo",
                    short(&merge_oid)
                ),
            ),
            MergeVerdict::Unknown => (
                codes::NOT_FOUND,
                "the commits needed to check the merge could not be fetched".to_string(),
            ),
            _ if facts.tip_before.is_empty() || facts.merge_parents.is_empty() => (
                codes::NOT_FOUND,
                "the base's tip before the merge is unknown, so what the merge brought in can't be told".to_string(),
            ),
            _ => (
                codes::REJECTED,
                "the base already held the PR's commits before the merge, so the merge brought nothing in".to_string(),
            ),
        };
        return Err(refusal(
            code,
            format!("could not tell what the merge of PR #{number} brought in"),
            cause,
        )
        .fix(format!("`dg pr verify {repo} {number}` checks the merge"))
        .into());
    };
    let tree = match revert_tree(dir, &base_tip, &inv)? {
        Ok(tree) => tree,
        Err(paths) => {
            let mut cause = format!(
                "{} has changed since the merge, and undoing it conflicts",
                safe(&short_base)
            );
            if !paths.is_empty() {
                cause.push_str(" in ");
                cause.push_str(&paths.join(", "));
            }
            return Err(UserError::new(
                codes::MERGE_CONFLICT,
                format!("revert failed: PR #{number} does not revert cleanly onto {}", safe(&short_base)),
            )
            .cause(cause)
            .fix(format!(
                "revert it by hand in a clone: fetch {}, run {}, resolve the conflicts, push a branch and open a PR with `dg pr create`",
                safe(&short_base),
                manual_revert(Some(&inv), &merge_oid)
            ))
            .note("nothing was pushed or written")
            .into());
        }
    };
    let tip_tree = git::git(dir, &["rev-parse", &format!("{base_tip}^{{tree}}")], &[])?;
    if tree == tip_tree {
        return Err(refusal(
            codes::REJECTED,
            format!("{} no longer has PR #{number}'s changes", safe(&short_base)),
            "undoing the merge changes nothing: it was reverted or overwritten since",
        )
        .into());
    }
    let title = revert_title(&view.patch.title);
    let message = revert_message(&view.patch.title, view.patch.number, &merge_oid);
    let commit = git::commit_tree(
        dir,
        &tree,
        &[&base_tip],
        &message,
        &git::merge_author_here(&s.identity.id()),
    )?;
    steps.ok(
        "revert",
        format!(
            "{} → commit {}",
            inv.landed.words(&merge_oid),
            short(&commit)
        ),
    );

    let body = revert_body(view.patch.number, &merge_oid, inv.landed);
    let text = (title.len() + body.len() + base_ref.len() + branch_ref.len()) as u64;
    let price = ctx.usd_price();
    let quote = crate::quote::revert(super::merge_stores_on_platform(), text);
    if !ctx.json {
        eprintln!(
            "Open PR {:?} in {}: {short_branch} ({}) → {}",
            safe(&title),
            handle.display(),
            short(&commit),
            safe(&short_base)
        );
    }
    ctx.confirm_or_cancel(&format!(
        "Push {short_branch} and open the PR? (a branch push and one document, {}, plus Platform storage for the new commit)",
        cost_line(quote, price)
    ))?;

    let before = s.balance().await;
    let base_url = format!("dash://{}", handle.id());
    if let Err(e) = push_to(
        dir,
        &push_argv(ctx, &base_url, &commit, &branch_ref),
        &git::dash_env_signing(ctx)?,
        "revert failed",
    ) {
        return Err(crate::errors::reported(
            super::step_failure(
                &e,
                number,
                repo,
                "revert failed",
                "no pull request was opened",
            ),
            json!({ "status": "failed", "pr": number, "steps": steps.done }),
        ));
    }
    steps.ok("push", format!("{short_branch} → {}", short(&commit)));

    let input = PatchInput {
        title: title.clone(),
        body,
        base_ref_name: base_ref.clone(),
        source_repo_id: handle.id().to_string(),
        source_ref_name: Some(branch_ref.clone()),
        head_oid: hex::decode(&commit).context("revert commit oid")?,
        draft: false,
        patch_manifest_hash: None,
    };
    let created = async {
        let journal = default_journal_dir()?;
        if let Some(c) = collab.resume_patch_create(handle, &input, &journal).await? {
            return Ok::<_, anyhow::Error>(c);
        }
        Ok(collab.create_patch(handle, &input, &journal).await?)
    }
    .await;
    let created = match created {
        Ok(c) => c,
        Err(e) => {
            let u = super::step_failure(&e, number, repo, "pull request not opened", "")
                .note(format!(
                    "the branch {short_branch} was pushed; `dg pr create {repo} --head {short_branch} --base {} --title {} --body {}` opens the PR",
                    forge_core::repo::short_branch_name(&base_ref),
                    // The title is the PR author's text: quoted so pasting the command runs nothing.
                    sh_quote(&title),
                    // One line, so the command pastes into any shell.
                    sh_quote(&input.body.split_whitespace().collect::<Vec<_>>().join(" "))
                ));
            return Err(crate::errors::reported(
                u,
                json!({
                    "status": "pushed_no_pr",
                    "pr": number,
                    "branch": branch_ref,
                    "revertCommit": commit,
                    "steps": steps.done,
                }),
            ));
        }
    };
    steps.ok("open", format!("PR #{}", created.number));
    let spent = s.spent_since(before).await;
    ctx.emit(
        json!({
            "status": "created",
            "pr": number,
            "number": created.number,
            "documentId": created.document_id,
            "title": title,
            "baseRef": base_ref,
            "headRef": branch_ref,
            "revertCommit": commit,
            "mergeOid": merge_oid,
            "landed": inv.landed.as_str(),
            "cost": cost_json(spent, price),
            "steps": steps.done,
        }),
        || {
            println!(
                "✓ opened PR #{} in {}, reverting #{number} · {}",
                created.number,
                handle.display(),
                cost_line(spent, price)
            );
        },
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A banned writer's revert is refused (E610) before the branch is pushed and the PR opened
    /// (Q5-B08). The check needs a chain, so this guards the order in `run`'s source.
    #[test]
    fn revert_refuses_a_banned_writer_before_it_pushes_or_opens() {
        let src = include_str!("revert.rs");
        // `run` only: from its signature to the test module, so these literals cannot match.
        let start = src.find("pub(crate) async fn run(").expect("run");
        let end = src.find("#[cfg(test)]").expect("test module");
        let body = &src[start..end];
        let at = |needle: &str| {
            body.find(needle)
                .unwrap_or_else(|| panic!("missing {needle}"))
        };
        let open = at("Session::open_for_write(");
        let ban = at("s.refuse_if_banned(");
        assert!(open < ban, "the ban check follows open_for_write");
        assert!(
            ban < at("collab.create_patch("),
            "the ban check precedes the PR create"
        );
        assert!(ban < at("push_to("), "the ban check precedes the push");
    }

    fn run(dir: &Path, args: &[&str]) -> String {
        git::git(
            dir,
            args,
            &[
                ("GIT_AUTHOR_NAME".into(), "t".into()),
                ("GIT_AUTHOR_EMAIL".into(), "t@t".into()),
                ("GIT_COMMITTER_NAME".into(), "t".into()),
                ("GIT_COMMITTER_EMAIL".into(), "t@t".into()),
            ],
        )
        .unwrap()
    }

    fn commit(dir: &Path, file: &str, text: &str, msg: &str) -> String {
        std::fs::write(dir.join(file), text).unwrap();
        run(dir, &["add", file]);
        run(dir, &["commit", "-q", "-m", msg]);
        run(dir, &["rev-parse", "HEAD"])
    }

    fn tree(dir: &Path, c: &str) -> String {
        run(dir, &["rev-parse", &format!("{c}^{{tree}}")])
    }

    /// Undo `merged` (a merge of `head` built on `before`) onto `onto`: the tree, or the
    /// conflicting paths.
    fn undo(
        dir: &Path,
        head: &str,
        merged: &str,
        before: &str,
        onto: &str,
    ) -> (Landed, std::result::Result<String, Vec<String>>) {
        let facts = verify::merge_facts(dir, head, merged, before);
        let inv = inverse(dir, &facts, merge_content(&facts).verdict).expect("revertable");
        (inv.landed, revert_tree(dir, onto, &inv).unwrap())
    }

    /// A base `root → base1`, a PR of two commits off `root`, merged four ways; each revert
    /// on the merge itself gives back the base's tree before the merge, and one on a later
    /// base keeps that later change.
    #[test]
    fn each_kind_of_merge_reverts_to_the_tree_before_it() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        run(dir, &["init", "-q", "-b", "main"]);
        let root = commit(dir, "a.txt", "a\n", "root");
        let base1 = commit(dir, "b.txt", "b\n", "base change");
        run(dir, &["checkout", "-q", "-b", "pr", &root]);
        commit(dir, "c.txt", "c\n", "pr one");
        let head = commit(dir, "a.txt", "a\nmore\n", "pr two");

        // A merge commit.
        run(dir, &["checkout", "-q", "main"]);
        run(dir, &["merge", "-q", "--no-ff", "-m", "merge", "pr"]);
        let merged = run(dir, &["rev-parse", "HEAD"]);
        let (landed, got) = undo(dir, &head, &merged, &base1, &merged);
        assert_eq!(landed, Landed::MergeCommit);
        assert_eq!(got.unwrap(), tree(dir, &base1));
        // A later change on the base stays.
        let later = commit(dir, "d.txt", "d\n", "later");
        let (_, got) = undo(dir, &head, &merged, &base1, &later);
        let want = {
            run(dir, &["rm", "-q", "c.txt"]);
            std::fs::write(dir.join("a.txt"), "a\n").unwrap();
            run(dir, &["add", "a.txt"]);
            run(dir, &["write-tree"])
        };
        assert_eq!(got.unwrap(), want);

        // A squash.
        run(dir, &["reset", "-q", "--hard", &base1]);
        run(dir, &["merge", "-q", "--squash", "pr"]);
        run(dir, &["commit", "-q", "-m", "squash"]);
        let squashed = run(dir, &["rev-parse", "HEAD"]);
        let (landed, got) = undo(dir, &head, &squashed, &base1, &squashed);
        assert_eq!(landed, Landed::Squash);
        assert_eq!(got.unwrap(), tree(dir, &base1));

        // A rebase: the PR's two commits replayed on base1.
        run(dir, &["reset", "-q", "--hard", &base1]);
        run(dir, &["cherry-pick", &format!("{root}..{head}")]);
        let rebased = run(dir, &["rev-parse", "HEAD"]);
        let (landed, got) = undo(dir, &head, &rebased, &base1, &rebased);
        assert_eq!(landed, Landed::Rebase);
        assert_eq!(got.unwrap(), tree(dir, &base1));

        // A fast-forward of a base still at root.
        let (landed, got) = undo(dir, &head, &head, &root, &head);
        assert_eq!(landed, Landed::FastForward);
        assert_eq!(got.unwrap(), tree(dir, &root));

        // A later base change to the same lines conflicts, naming the file.
        run(dir, &["reset", "-q", "--hard", &squashed]);
        let clash = commit(dir, "a.txt", "a\nmore\nand more\n", "clash");
        let (_, got) = undo(dir, &head, &squashed, &base1, &clash);
        assert_eq!(got.unwrap_err(), ["a.txt"]);

        // A recorded merge that does not contain the PR has nothing to revert.
        let facts = verify::merge_facts(dir, &head, &base1, &root);
        assert_eq!(inverse(dir, &facts, merge_content(&facts).verdict), None);
    }

    #[test]
    fn manual_hints_undo_everything_each_kind_landed() {
        let m = "m".repeat(40);
        let inv = |landed, from: &str, to: &str| Inverse {
            landed,
            from: from.into(),
            to: to.into(),
        };
        assert_eq!(
            manual_revert(Some(&inv(Landed::MergeCommit, &m, "p")), &m),
            format!("`git revert -m 1 {m}`")
        );
        assert_eq!(
            manual_revert(Some(&inv(Landed::Squash, &m, "p")), &m),
            format!("`git revert {m}`")
        );
        assert_eq!(
            manual_revert(Some(&inv(Landed::Rebase, &m, "before")), &m),
            format!("`git revert --no-commit before..{m}` then `git commit`; a merge commit in that range is reverted on its own, with `git revert --no-commit -m 1 <commit>`")
        );
        assert_eq!(
            manual_revert(Some(&inv(Landed::FastForward, "head", "fork")), &m),
            "`git revert --no-commit fork..head` then `git commit`; a merge commit in that range is reverted on its own, with `git revert --no-commit -m 1 <commit>`"
        );
        let both = manual_revert(None, &m);
        assert!(both.contains("-m 1") && both.contains("--no-commit"));
    }

    #[test]
    fn a_pr_whose_revert_would_reach_more_people_is_not_reverted() {
        use Visibility::{Private, Public};
        let refused = |v, a| audience_refusal(v, a, "o/r", 3).map(|u| u.message);
        assert!(refused(Public, Audience::Members).is_some_and(|m| m.contains("members-only")));
        assert!(refused(Public, Audience::SpecificPeople)
            .is_some_and(|m| m.contains("specific people")));
        assert!(refused(Private, Audience::SpecificPeople)
            .is_some_and(|m| m.contains("specific people")));
        assert!(refused(Public, Audience::Public).is_none());
        assert!(refused(Private, Audience::Members).is_none());
        // The advice never widens the audience.
        let fix = audience_refusal(Public, Audience::Members, "o/r", 3)
            .unwrap()
            .fix
            .join(" ");
        assert!(fix.contains("for the same people") && !fix.contains("public"));
    }

    #[test]
    fn titles_bodies_and_branch_names() {
        assert_eq!(revert_title("Add parser"), "Revert \"Add parser\"");
        let long = "x".repeat(300);
        let t = revert_title(&long);
        assert_eq!(t.chars().count(), TITLE_MAX);
        assert!(t.starts_with("Revert \"x") && t.ends_with("…\""));
        assert_eq!(
            revert_message("Add parser", 12, "ab"),
            "Revert \"Add parser\"\n\nThis reverts pull request #12, merged as ab."
        );
        assert!(revert_body(12, &"a".repeat(40), Landed::Squash).starts_with("Reverts #12\n\n"));
        assert_eq!(
            sh_quote("Revert \"x `id` $(id)\""),
            "'Revert \"x `id` $(id)\"'"
        );
        assert_eq!(sh_quote("it's"), "'it'\\''s'");
        assert_eq!(
            default_branch(12, Some("refs/heads/feature/x")),
            "refs/heads/revert-12-feature/x"
        );
        assert_eq!(default_branch(12, None), "refs/heads/revert-12");
        assert_eq!(
            default_branch(12, Some("refs/heads/bad..name")),
            "refs/heads/revert-12"
        );
    }
}
