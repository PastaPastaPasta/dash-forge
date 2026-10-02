//! `dg repo sync` — GitHub's "Sync fork" (`gh repo sync`): fast-forward a fork's branch to its
//! parent's (`forge_core::fork::sync_fork`). The fork's default branch follows the parent's
//! default branch; another branch (`--branch`) follows the parent's branch of the same name.
//!
//! Only a fast-forward is written: the parent's packs the fork does not record yet are recorded
//! by reference (nothing uploaded), then one ref update moves the branch from its tip to the
//! parent's. A fork branch with commits of its own is never moved: when both sides moved, `dg`
//! says so (E105) and names the pull request that merges the parent's commits into the fork.
//!
//! Ancestry is git's (`merge-base --is-ancestor`): in the current repository when it already
//! holds both tips (a clone of the fork that fetched the parent), else in a scratch repository
//! that fetches the parent's branch (and the fork's, when the parent's history does not hold the
//! fork's tip).

use std::path::Path;

use anyhow::{Context, Result};
use serde_json::json;

use forge_core::fork::{plan_sync_manifests, sync_decision, sync_fork, SyncDecision};
use forge_core::repo::RepoService;
use forge_core::rules::v2::Role;
use forge_core::user_error::{codes, UserError};

use crate::common::{spent_since, Session};
use crate::context::Ctx;
use crate::fmt::{cost_json, cost_line};
use crate::git;

/// Which branches a sync pairs: the fork's `branch` (default: its default branch) and the
/// parent's branch it follows (the parent's default branch for the fork's default branch, else
/// the parent's branch of the same name), as GitHub pairs them.
#[must_use]
pub fn sync_pair(
    branch: Option<&str>,
    fork_default: &str,
    parent_default: &str,
) -> (String, String) {
    let fork_branch = branch
        .map_or(fork_default, forge_core::repo::short_branch_name)
        .to_string();
    let parent_branch = if fork_branch == fork_default {
        parent_default.to_string()
    } else {
        fork_branch.clone()
    };
    (fork_branch, parent_branch)
}

/// What a fast-forward sync writing `manifests` (each recording that many URIs) is quoted: a
/// manifest into a repository that has some, the first one dearer when the fork has none
/// (`fork_has_packs`), and the ref update as a new ref name's first, or the repository's very
/// first ref update when the fork has no refs at all (`fork_has_refs`). An upper bound.
#[must_use]
pub fn sync_estimate(manifest_uris: &[u64], fork_has_packs: bool, fork_has_refs: bool) -> u64 {
    use forge_core::cost::push_fees;
    let manifests: u64 = manifest_uris
        .iter()
        .enumerate()
        .map(|(i, uris)| {
            let base = if i == 0 && !fork_has_packs {
                push_fees::MANIFEST_FIRST
            } else {
                push_fees::MANIFEST_LATER
            };
            base + uris * push_fees::URIS_PER_TARGET
        })
        .sum();
    manifests
        + if fork_has_refs {
            push_fees::REF_NEW_NAME
        } else {
            push_fees::REF_FIRST
        }
}

/// A repository's default branch as `dg repo fork` and the web read it: its newest config's,
/// else the one its repo document names, else `main`.
async fn default_branch(
    svc: &RepoService<'_>,
    client: &forge_core::platform::PlatformClient,
    repo: &forge_core::scope::RepoRef,
) -> Result<String> {
    if let Some(b) = svc
        .read_default_branch(repo)
        .await
        .with_context(|| format!("reading {}'s default branch", repo.display()))?
        .filter(|b| !b.is_empty())
    {
        return Ok(b);
    }
    let (_, doc_branch) = forge_core::resolve::repo_fork_defaults(client, repo)
        .await
        .with_context(|| format!("reading {}'s repo document", repo.display()))?;
    Ok(doc_branch.unwrap_or_else(|| "main".into()))
}

/// `name` as a plain branch ref a refspec and a ref update may name, or a usage error.
fn branch_ref(name: &str) -> Result<String> {
    let r = git::full_ref(name);
    git::require_branch_ref(&r).map_err(|_| {
        crate::errors::usage(format!(
            "{name:?} is not a plain branch name; sync a branch (refs/heads/<name>)"
        ))
    })?;
    Ok(r)
}

/// Whether ancestry can be read in `dir`: it holds both tips and all their history (not a
/// shallow clone, where `merge-base` cannot see past the cut and would call a fast-forward
/// diverged).
fn holds_history(dir: &Path, tips: &[&str]) -> bool {
    tips.iter().all(|t| git::has_object(dir, t))
        && git::git(dir, &["rev-parse", "--is-shallow-repository"], &[])
            .is_ok_and(|o| o.trim() == "false")
}

/// The two ancestry answers a decision needs, in `dir` (holding both tips, or as many of them
/// as it fetched): whether the fork's tip is in the parent's history, and the other way.
fn ancestry(dir: &Path, fork_tip: &str, parent_tip: &str) -> (bool, bool) {
    if !git::has_object(dir, fork_tip) {
        return (false, false);
    }
    let fork_in_parent = git::is_ancestor(dir, fork_tip, parent_tip);
    let parent_in_fork = !fork_in_parent && git::is_ancestor(dir, parent_tip, fork_tip);
    (fork_in_parent, parent_in_fork)
}

/// `n` commits between `from` and `to` (`git rev-list --count from..to`), when `dir` can say.
fn commits_between(dir: &Path, from: &str, to: &str) -> Option<u64> {
    git::git(dir, &["rev-list", "--count", &format!("{from}..{to}")], &[])
        .ok()?
        .trim()
        .parse()
        .ok()
}

/// `dg repo sync <fork> [--branch <name>]`.
#[allow(clippy::too_many_lines)]
pub async fn sync(ctx: &Ctx, repo: &str, branch: Option<&str>) -> Result<()> {
    let s = Session::open_for_write(ctx, repo, "fork not synced").await?;
    let fork = &s.repo;
    let Some(parent_id) = forge_core::resolve::fork_parent(&s.client, fork)
        .await
        .context("reading the repository document")?
    else {
        return Err(crate::errors::usage(format!(
            "{} is not a fork: only a fork syncs with the repository it was forked from",
            fork.display()
        )));
    };
    let parent = forge_core::resolve::resolve_id(&s.client, &parent_id)
        .await
        .context("resolving the parent repository")?;
    // Forks and their parents are public (RC1 `forkIsPublic`).
    fork.require_public("syncing a fork")?;
    parent.require_public("syncing a fork")?;
    let svc = RepoService::new(&s.client, &s.identity, &s.bridge);
    let (fork_default, parent_default) = tokio::join!(
        Box::pin(default_branch(&svc, &s.client, fork)),
        Box::pin(default_branch(&svc, &s.client, &parent))
    );
    let (fork_branch, parent_branch) = sync_pair(branch, &fork_default?, &parent_default?);
    // Both become refspecs below, and the fork's a ref update.
    let fork_ref = branch_ref(&fork_branch)?;
    let parent_ref = branch_ref(&parent_branch)?;

    // Who may move the branch, before anything is read from storage or paid for. Unreadable
    // patterns stop here: a writer's sync of a branch they protect would pay for the manifests
    // and then be refused its ref update.
    let collab = s.collab();
    let (role, patterns) = tokio::join!(
        Box::pin(collab.signer_role(fork)),
        Box::pin(svc.protected_patterns(fork))
    );
    let role = role?;
    let protected = forge_core::rules::matches_protected(
        &fork_ref,
        &patterns.context("reading the fork's protected branches")?,
    );
    let may = match role {
        Some(Role::Maintainer) => true,
        Some(Role::Writer) => !protected,
        Some(Role::Triage | Role::Reader) | None => false,
    };
    if !may {
        return Err(UserError::new(
            codes::NOT_A_WRITER,
            format!(
                "fork not synced: you are not a {} of {}",
                if protected { "maintainer" } else { "writer" },
                fork.display()
            ),
        )
        .cause(
            role.and_then(|r| forge_core::members::role_limits(r, fork))
                .unwrap_or_else(|| {
                    if protected {
                        format!("{fork_branch} is protected there: only its maintainers move it")
                    } else {
                        "only a fork's maintainers and writers can move its branches".to_string()
                    }
                }),
        )
        .fix(format!(
            "ask a maintainer of {} to run `dg repo sync {}`",
            fork.display(),
            fork.display()
        ))
        .note("checked before anything was read or paid; nothing was written")
        .into());
    }

    let (fork_refs, parent_refs) = tokio::join!(
        Box::pin(svc.read_refs(fork)),
        Box::pin(svc.read_refs(&parent))
    );
    let tip_in = |refs: &[(String, forge_core::rules::RefState)], name: &str| {
        refs.iter()
            .find(|(n, _)| n == name)
            .and_then(|(_, st)| forge_core::rules::tip_of(st))
    };
    let fork_refs = fork_refs.context("reading the fork's branches")?;
    let fork_tip = tip_in(&fork_refs, &fork_ref);
    let parent_tip = tip_in(
        &parent_refs.context("reading the parent's branches")?,
        &parent_ref,
    );
    let target = format!("{}:{parent_branch}", parent.display());
    let Some(parent_tip) = parent_tip else {
        return Err(crate::errors::not_found(
            format!("fork not synced: {target} has no commits (never pushed, or deleted)"),
            format!(
                "sync another branch with `--branch`, or `dg repo view {}` to see its branches",
                parent.display()
            ),
        ));
    };
    let base = json!({
        "fork": fork.display(),
        "parent": parent.display(),
        "branch": fork_branch,
        "parentBranch": parent_branch,
        "from": fork_tip,
        "parentTip": parent_tip,
    });
    let emit = |status: &str, extra: serde_json::Value, human: &dyn Fn()| {
        let mut body = base.clone();
        body["status"] = json!(status);
        if let (Some(b), Some(e)) = (body.as_object_mut(), extra.as_object()) {
            b.extend(e.clone());
        }
        ctx.emit(body, human);
    };
    if fork_tip
        .as_deref()
        .is_some_and(|t| t.eq_ignore_ascii_case(&parent_tip))
    {
        emit("up_to_date", json!({ "written": false }), &|| {
            println!(
                "{}:{fork_branch} is up to date with {target} ({}); nothing written",
                fork.display(),
                &parent_tip[..parent_tip.len().min(12)]
            );
        });
        return Ok(());
    }

    // Ancestry: here, when this repository holds both tips; else a scratch fetch.
    let cwd = std::env::current_dir().unwrap_or_else(|_| ".".into());
    let here = holds_history(
        &cwd,
        &[fork_tip.as_deref().unwrap_or(&parent_tip), &parent_tip],
    );
    let scratch = if here {
        None
    } else {
        let scratch = crate::pr::scratch_repo()?;
        let env = git::dash_env(ctx);
        if !ctx.json {
            eprintln!("Fetching {target} to compare histories…");
        }
        git::git_dash(
            scratch.path(),
            &[
                "fetch",
                "-q",
                &format!("dash://{}", parent.id()),
                &format!("+{parent_ref}:refs/remotes/parent/tip"),
            ],
            &env,
        )
        .context("fetching the parent's branch")?;
        if let Some(t) = fork_tip
            .as_deref()
            .filter(|t| !git::has_object(scratch.path(), t))
        {
            // Not in the parent's history: the fork has commits of its own. Fetch them to tell
            // "ahead" from "diverged".
            git::git_dash(
                scratch.path(),
                &[
                    "fetch",
                    "-q",
                    &format!("dash://{}", fork.id()),
                    &format!("+{fork_ref}:refs/remotes/fork/tip"),
                ],
                &env,
            )
            .context("fetching the fork's branch")?;
            if !git::has_object(scratch.path(), t) {
                anyhow::bail!(
                    "the fork's tip {t} could not be fetched from {}",
                    fork.display()
                );
            }
        }
        Some(scratch)
    };
    let dir = scratch.as_ref().map_or(cwd.as_path(), |s| s.path());
    let (fork_in_parent, parent_in_fork) = fork_tip
        .as_deref()
        .map_or((true, false), |t| ancestry(dir, t, &parent_tip));
    let decision = sync_decision(
        fork_tip.as_deref(),
        Some(&parent_tip),
        fork_in_parent,
        parent_in_fork,
    );
    let short = |o: &str| o[..o.len().min(12)].to_string();
    match decision {
        SyncDecision::ParentEmpty | SyncDecision::UpToDate => unreachable!("decided above"),
        SyncDecision::Ahead => {
            let ahead = fork_tip
                .as_deref()
                .and_then(|t| commits_between(dir, &parent_tip, t));
            emit(
                "ahead",
                json!({ "written": false, "ahead": ahead }),
                &|| {
                    println!(
                        "{}:{fork_branch} already has {target} ({}) and {} of its own; nothing to sync",
                        fork.display(),
                        short(&parent_tip),
                        ahead.map_or_else(|| "commits".into(), |n| format!("{n} commit(s)"))
                    );
                    println!(
                        "  propose them: dg pr create {} --head {fork_branch} --head-repo {}",
                        parent.display(),
                        fork.display()
                    );
                },
            );
            return Ok(());
        }
        SyncDecision::Diverged => {
            let fork_tip = fork_tip.as_deref().unwrap_or_default();
            let behind = commits_between(dir, fork_tip, &parent_tip);
            let ahead = commits_between(dir, &parent_tip, fork_tip);
            let counts = match (ahead, behind) {
                (Some(a), Some(b)) => format!(" ({a} commit(s) ahead, {b} behind)"),
                _ => String::new(),
            };
            return Err(crate::errors::reported(
                UserError::new(
                    codes::MERGE_CONFLICT,
                    format!(
                        "fork not synced: {}:{fork_branch} and {target} have both moved{counts}",
                        fork.display()
                    ),
                )
                .cause(
                    "a sync only fast-forwards; it never drops the fork's own commits",
                )
                .fix(format!(
                    "merge the parent's commits with a pull request into the fork: `dg pr create {} --base {fork_branch} --head {parent_branch} --head-repo {} --title \"Merge {target}\"`",
                    fork.display(),
                    parent.display()
                ))
                .fix(format!(
                    "or locally: `git pull dash://{} {parent_branch}` on {fork_branch}, then push it",
                    parent.id()
                ))
                .note("nothing was written"),
                {
                    let mut b = base.clone();
                    b["status"] = json!("diverged");
                    b["ahead"] = json!(ahead);
                    b["behind"] = json!(behind);
                    b
                },
            ));
        }
        SyncDecision::FastForward => {}
    }

    // The parent's packs the fork does not record yet, by reference.
    let (parent_packs, fork_packs, roles, fork_roles) = tokio::join!(
        Box::pin(svc.read_pack_manifests(&parent)),
        Box::pin(svc.read_pack_manifests(fork)),
        Box::pin(svc.copy_roles(&parent)),
        Box::pin(svc.copy_roles(fork))
    );
    let fork_packs = fork_packs.context("reading the fork's packs")?;
    let fork_has_packs = !fork_packs.is_empty();
    let plan = plan_sync_manifests(
        &parent,
        &parent_packs.context("reading the parent's packs")?,
        &roles.unwrap_or_default(),
        &fork_packs,
        &fork_roles.context("reading the fork's members")?,
    )?;
    if !plan.unreferenceable.is_empty() {
        return Err(UserError::new(
            codes::PACKS_UNREADABLE,
            format!(
                "fork not synced: {} pack(s) of {} have no copy a fork can reference",
                plan.unreferenceable.len(),
                parent.display()
            ),
        )
        .cause("their only recorded copies are URLs too long for a manifest, or none at all")
        .fix(format!(
            "push {parent_branch} to dash://{} {fork_branch} from a full clone of the parent",
            fork.id()
        ))
        .note("nothing was written")
        .into());
    }
    let commits = fork_tip
        .as_deref()
        .and_then(|t| commits_between(dir, t, &parent_tip));
    let estimate = sync_estimate(
        &plan
            .manifests
            .iter()
            .map(|m| m.uris.len() as u64)
            .collect::<Vec<_>>(),
        fork_has_packs,
        !fork_refs.is_empty(),
    );
    let price = ctx.usd_price();
    if !ctx.json {
        println!(
            "Sync {}:{fork_branch} with {target}: fast-forward {} → {}{}\n  {} pack manifest(s) by reference, nothing re-uploaded, + 1 ref update   {}",
            fork.display(),
            fork_tip.as_deref().map_or_else(|| "(new branch)".into(), short),
            short(&parent_tip),
            commits.map_or_else(String::new, |n| format!(" ({n} commit(s))")),
            plan.manifests.len(),
            cost_line(estimate, price)
        );
    }
    ctx.confirm_or_cancel(&format!("Sync {}?", fork.display()))?;
    let before = s.balance().await;
    let result = sync_fork(
        &svc,
        fork,
        &fork_ref,
        fork_tip.as_deref(),
        &parent_tip,
        &plan,
    )
    .await
    .context("syncing the fork")?;
    // Read until the balance moves: a node a block behind still shows the old one.
    let spent = spent_since(&s.client, &s.identity.id(), before).await;
    emit(
        "synced",
        json!({
            "written": true,
            "to": parent_tip,
            "commits": commits,
            "manifestsWritten": result.manifests_written,
            "refUpdateId": result.ref_update,
            "cost": cost_json(spent, price),
        }),
        &|| {
            println!(
                "✓ synced {}:{fork_branch} with {target}: now at {}{}",
                fork.display(),
                short(&parent_tip),
                commits.map_or_else(String::new, |n| format!(" ({n} new commit(s))"))
            );
            println!(
                "  packs:   {} recorded by reference, nothing re-uploaded",
                result.manifests_written
            );
            println!("  cost:    {}", cost_line(spent, price));
        },
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// As on GitHub: the default branch follows the parent's default, any other branch the
    /// parent's branch of the same name.
    #[test]
    fn a_sync_pairs_the_default_branches_and_same_named_others() {
        assert_eq!(
            sync_pair(None, "main", "master"),
            ("main".into(), "master".into())
        );
        assert_eq!(
            sync_pair(Some("refs/heads/main"), "main", "master"),
            ("main".into(), "master".into())
        );
        assert_eq!(
            sync_pair(Some("dev"), "main", "master"),
            ("dev".into(), "dev".into())
        );
    }

    #[test]
    fn a_sync_quote_covers_each_manifest_and_the_ref() {
        use forge_core::cost::push_fees;
        assert_eq!(sync_estimate(&[], true, true), push_fees::REF_NEW_NAME);
        assert!(sync_estimate(&[1, 2], true, true) > sync_estimate(&[1, 1], true, true));
        assert_eq!(
            sync_estimate(&[1], true, true),
            push_fees::MANIFEST_LATER + push_fees::URIS_PER_TARGET + push_fees::REF_NEW_NAME
        );
        // A fork with no packs or no refs yet pays the firsts.
        assert_eq!(
            sync_estimate(&[1, 1], false, false),
            push_fees::MANIFEST_FIRST
                + push_fees::MANIFEST_LATER
                + 2 * push_fees::URIS_PER_TARGET
                + push_fees::REF_FIRST
        );
    }

    #[test]
    fn only_a_plain_branch_syncs() {
        assert_eq!(branch_ref("main").unwrap(), "refs/heads/main");
        assert_eq!(branch_ref("refs/heads/dev").unwrap(), "refs/heads/dev");
        let e = branch_ref("refs/tags/v1").unwrap_err().to_string();
        assert!(e.contains("not a plain branch name"), "{e}");
        assert!(!e.contains("pull request"), "{e}");
    }
}
