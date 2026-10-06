//! `dg pr create`'s code owner review requests (P1-6): the reviewers the base branch's
//! `CODEOWNERS` names for the files a PR changes, asked as soon as the PR is open, as GitHub does.
//!
//! The rule (where the file is, how it parses and matches, whom to ask) is
//! [`forge_core::rules::codeowners`], shared with the web by conformance vectors. This module
//! only gathers its input from git: the code owners file at the base tip and the paths changed
//! between the merge base and the head (`git diff --name-only --no-renames`, so a rename counts
//! as its old and new path, as the web counts it). Both commits are read from the clone `dg`
//! runs in when it has them, else fetched over `dash://` into a scratch repository.

use std::collections::BTreeMap;
use std::path::Path;

use anyhow::{Context, Result};
use serde_json::json;

use forge_core::collab::v2::PatchView;
use forge_core::collab::v2::{kind_route, StateRoute, Target, TargetKind};
use forge_core::rules::codeowners::{
    code_owner_requests, code_owner_review, owner_kind, parse_code_owners, CodeOwnerStatus,
    CodeOwners, OwnerKind, OwnerRequests, OwnersFile, SkipReason, CODEOWNERS_PATHS,
    MAX_CODEOWNERS_BYTES,
};
use forge_core::rules::review::Policy;
use forge_core::rules::EventKind;
use forge_core::scope::RepoRef as Repo;

use crate::common::Session;
use crate::context::Ctx;
use crate::git;

/// The code owners a new PR will ask for review.
pub struct OwnerPlan {
    /// Where the owners came from (one of [`CODEOWNERS_PATHS`]).
    pub file: String,
    /// Whom to ask, and who is left out.
    pub requests: OwnerRequests,
    /// How the requests are written: a member's `event`, or the author's `authorEvent`.
    pub route: StateRoute,
}

/// The code owners file at `commit` in `dir`: the first of [`CODEOWNERS_PATHS`] that is a regular
/// file of at most [`MAX_CODEOWNERS_BYTES`] (larger or binary: none, as on the web).
pub fn read_code_owners(dir: &Path, commit: &str) -> Result<Option<(String, CodeOwners)>> {
    for path in CODEOWNERS_PATHS {
        // `--full-tree`: from the repository root, wherever in the clone dg runs.
        let entry = git::git_bytes(dir, &["ls-tree", "--full-tree", "-z", commit, "--", path])?;
        let entry = String::from_utf8_lossy(&entry);
        let Some((meta, _)) = entry.split_once('\t') else {
            continue;
        };
        let mut fields = meta.split(' ');
        let (mode, kind, oid) = (fields.next(), fields.next(), fields.next());
        let (Some(mode), Some("blob"), Some(oid)) = (mode, kind, oid) else {
            continue;
        };
        // A regular file, whatever its permission bits (git's `S_IFREG`), not a symlink.
        if !mode.starts_with("100") {
            continue;
        }
        let size: usize = git::git(dir, &["cat-file", "-s", oid], &[])?
            .parse()
            .context("reading the code owners file's size")?;
        if size > MAX_CODEOWNERS_BYTES {
            return Ok(None);
        }
        let bytes = git::git_bytes(dir, &["cat-file", "blob", oid])?;
        // Binary (a NUL in the first 8 KiB) is no code owners file, as the web reads it.
        if bytes.iter().take(8192).any(|&b| b == 0) {
            return Ok(None);
        }
        return Ok(Some((
            path.to_string(),
            parse_code_owners(&String::from_utf8_lossy(&bytes)),
        )));
    }
    Ok(None)
}

/// The paths the PR changes: `git diff --name-only --no-renames` from the merge base of `base`
/// and `head` (no merge base: the head's first parent) to `head`. A root head with no merge
/// base changes every file it holds.
pub fn changed_paths(dir: &Path, base: &str, head: &str) -> Result<Vec<String>> {
    let from = git::git(dir, &["merge-base", base, head], &[]).or_else(|_| {
        git::git(
            dir,
            &["rev-parse", "--verify", "-q", &format!("{head}^")],
            &[],
        )
    });
    let out = match from {
        Ok(from) => git::git_bytes(
            dir,
            &["diff", "--name-only", "--no-renames", "-z", &from, head],
        )?,
        // Not the empty tree's oid: that differs between SHA-1 and SHA-256 repositories.
        Err(_) => git::git_bytes(
            dir,
            &["ls-tree", "-r", "--full-tree", "--name-only", "-z", head],
        )?,
    };
    Ok(out
        .split(|&b| b == 0)
        .filter(|p| !p.is_empty())
        .map(|p| String::from_utf8_lossy(p).into_owned())
        .collect())
}

/// Plan the code owner review requests of a PR from `head_oid` (in `source`) into `base_ref`
/// of `handle`, whose tip is `base_tip`. `None` when the base has no code owners file, or
/// nothing it names is changed. Read failures are notes on stderr, never a failed create.
#[allow(clippy::too_many_arguments)]
pub async fn plan(
    ctx: &Ctx,
    s: &Session,
    handle: &Repo,
    cwd: &Path,
    base_ref: &str,
    base_tip: &str,
    source: &Repo,
    head_ref: &str,
    head_oid: &str,
) -> Option<OwnerPlan> {
    match plan_inner(
        ctx, s, handle, cwd, base_ref, base_tip, source, head_ref, head_oid,
    )
    .await
    {
        Ok(p) => p,
        Err(e) => {
            eprintln!(
                "note: code owners were not read, so no reviewers are requested for them: {e:#}"
            );
            None
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn plan_inner(
    ctx: &Ctx,
    s: &Session,
    handle: &Repo,
    cwd: &Path,
    base_ref: &str,
    base_tip: &str,
    source: &Repo,
    head_ref: &str,
    head_oid: &str,
) -> Result<Option<OwnerPlan>> {
    // The clone dg runs in when it has both commits (a base without a code owners file needs
    // no head at all); else a scratch fetch of the two branches.
    let in_clone = git::has_object(cwd, base_tip);
    let found = if in_clone {
        read_code_owners(cwd, base_tip)?
    } else {
        None
    };
    if in_clone && found.is_none() {
        return Ok(None);
    }
    let scratch;
    let (dir, found) = if in_clone && git::has_object(cwd, head_oid) {
        (cwd, found)
    } else {
        git::require_branch_ref(base_ref)?;
        git::require_branch_ref(head_ref)?;
        if !ctx.json {
            eprintln!(
                "Fetching the base and head to read CODEOWNERS (`--no-code-owners` skips this)…"
            );
        }
        scratch = super::scratch_repo()?;
        let private = handle.visibility == forge_core::rules::v2::Visibility::Private;
        let env = super::read_env(ctx, private)?;
        super::fetch_base(scratch.path(), handle, base_ref, &env)?;
        super::fetch_pr_head(scratch.path(), source.id(), head_oid, &env)?;
        let found = match found {
            Some(f) => Some(f),
            None => read_code_owners(scratch.path(), base_tip)?,
        };
        (scratch.path(), found)
    };
    let Some((file, owners)) = found else {
        return Ok(None);
    };
    let tokens = owners.owners_of_paths(&changed_paths(dir, base_tip, head_oid)?);
    if tokens.is_empty() {
        return Ok(None);
    }
    // Names are looked up at once. An unregistered one is unresolved, as on the web; a failed
    // lookup fails the plan (it is no proof the name is unregistered).
    let names: Vec<&String> = tokens
        .iter()
        .filter(|t| owner_kind(t) == OwnerKind::Name)
        .collect();
    let ids = futures::future::join_all(names.iter().map(|t| async {
        match forge_core::resolve::dpns_label(t.trim_start_matches('@')) {
            Some(label) => s.client.resolve_dpns_name(label).await,
            None => Ok(None),
        }
    }))
    .await;
    let mut resolved: BTreeMap<String, Option<String>> = BTreeMap::new();
    for (name, id) in names.into_iter().zip(ids) {
        resolved.insert(
            name.clone(),
            id.with_context(|| format!("looking up the DPNS name {name}"))?,
        );
    }
    let oracle = s.collab().member_oracle(handle).await?;
    let me = s.identity.id().clone();
    let requests = code_owner_requests(&tokens, &resolved, &oracle, &me);
    // The PR does not exist yet: its author will be the signer. One membership read decides
    // both whom to ask and how every request is written.
    let target = Target {
        kind: TargetKind::Patch,
        id: String::new(),
        number: 0,
        author: me.clone(),
    };
    let route = kind_route(
        oracle.current_role(&me),
        &me,
        &target,
        EventKind::ReviewRequest,
    )
    .unwrap_or(StateRoute::Author);
    Ok(Some(OwnerPlan {
        file,
        requests,
        route,
    }))
}

/// Why a code owner is not asked, for humans.
pub fn skip_text(reason: SkipReason) -> &'static str {
    match reason {
        SkipReason::Team => "teams are not supported",
        SkipReason::Email => "e-mail addresses are not identities",
        SkipReason::Role => "roles are not supported",
        SkipReason::Invalid => "not an owner",
        SkipReason::Unresolved => "no DPNS name or identity",
        SkipReason::Author => "the author",
        SkipReason::NotApprover => "not a maintainer or writer",
        SkipReason::Duplicate => "listed twice",
        SkipReason::Cap => "over the 15-reviewer limit",
    }
}

/// Print the plan (human output only).
pub fn print_plan(plan: &OwnerPlan) {
    if plan.requests.request.is_empty() {
        println!(
            "{} names owners of these changes, but none can be asked for review:",
            plan.file
        );
    } else {
        println!(
            "Code owners ({}) to ask for review: {}",
            plan.file,
            plan.requests.request.join(", ")
        );
    }
    for skip in &plan.requests.skipped {
        println!("  not asked: {} ({})", skip.token, skip_text(skip.reason));
    }
}

/// Ask each planned reviewer for review on the PR just opened (`number`, document `id`). A
/// failed request is reported and the rest still asked: the PR is open whatever happens here.
pub async fn request(
    s: &Session,
    handle: &Repo,
    number: u32,
    id: &str,
    plan: &OwnerPlan,
) -> Vec<serde_json::Value> {
    let collab = s.collab();
    let target = Target {
        kind: TargetKind::Patch,
        id: id.to_string(),
        number,
        author: s.identity.id().clone(),
    };
    let via = match plan.route {
        StateRoute::Member => "event",
        StateRoute::Author => "authorEvent",
    };
    let mut out = Vec::new();
    for reviewer in &plan.requests.request {
        let payload = forge_core::collab::v2::EventPayload {
            ref_id: Some(reviewer),
            ..forge_core::collab::v2::EventPayload::default()
        };
        match collab
            .post_target_event_via(
                handle,
                &target,
                EventKind::ReviewRequest,
                &payload,
                plan.route,
            )
            .await
        {
            Ok(event) => {
                out.push(json!({ "reviewer": reviewer, "requested": true, "via": via, "eventId": event }));
            }
            Err(e) => {
                eprintln!("warning: requesting a review from {reviewer} failed: {e}; `dg pr request-review` asks again");
                out.push(
                    json!({ "reviewer": reviewer, "requested": false, "error": e.to_string() }),
                );
            }
        }
    }
    out
}

/// Where a PR stands against its policy's `requireCodeOwners` (UPDATE-1): the shared rule
/// [`code_owner_review`] over the code owners file at the base tip and the paths the PR changes.
/// Both commits come from the clone `dg` runs in when it has them, else a scratch fetch. A read
/// that fails is an unreadable file, which the rule fails closed on.
pub async fn code_owner_status(
    ctx: &Ctx,
    s: &Session,
    handle: &Repo,
    view: &PatchView,
    policy: &Policy,
) -> CodeOwnerStatus {
    if !policy.require_code_owners {
        return CodeOwnerStatus {
            met: true,
            ..CodeOwnerStatus::default()
        };
    }
    match status_inner(ctx, s, handle, view, policy).await {
        Ok(st) => st,
        Err(e) => {
            if !ctx.json {
                eprintln!("note: the code owners could not be read: {e:#}");
            }
            CodeOwnerStatus {
                met: false,
                unreadable: true,
                pending: Vec::new(),
            }
        }
    }
}

async fn status_inner(
    ctx: &Ctx,
    s: &Session,
    handle: &Repo,
    view: &PatchView,
    policy: &Policy,
) -> Result<CodeOwnerStatus> {
    let Some(base_tip) = view.base_tip.clone() else {
        anyhow::bail!("the base branch {} has no tip", view.merge_base.ref_name);
    };
    let cwd = std::env::current_dir().context("reading the current directory")?;
    let scratch;
    let dir: &Path = if git::has_object(&cwd, &base_tip) && git::has_object(&cwd, &view.head) {
        &cwd
    } else {
        if !ctx.json {
            eprintln!("Fetching the base and head to read CODEOWNERS…");
        }
        scratch = super::scratch_repo()?;
        let private = handle.visibility == forge_core::rules::v2::Visibility::Private;
        let env = super::read_env(ctx, private)?;
        super::fetch_base_and_head(scratch.path(), handle, view, &env)?;
        scratch.path()
    };
    let parsed = read_code_owners(dir, &base_tip)?;
    // The merge rule needs the real merge base: a first-parent fallback could miss owned files,
    // so without one the file counts as unreadable (fail closed).
    git::git(dir, &["merge-base", &base_tip, &view.head], &[]).context(
        "the head and the base branch share no history, so the changed files cannot be listed",
    )?;
    let paths = changed_paths(dir, &base_tip, &view.head)?;
    let collab = s.collab();
    let oracle = collab.member_oracle(handle).await?;
    let (approvals, _) = collab.approvals_with(handle, view, &oracle).await?;
    let mut resolved: BTreeMap<String, Option<String>> = BTreeMap::new();
    if let Some((_, owners)) = &parsed {
        for t in owners.owners_of_paths(&paths) {
            if owner_kind(&t) != OwnerKind::Name || resolved.contains_key(&t) {
                continue;
            }
            let id = match forge_core::resolve::dpns_label(t.trim_start_matches('@')) {
                Some(label) => s
                    .client
                    .resolve_dpns_name(label)
                    .await
                    .with_context(|| format!("looking up the DPNS name {t}"))?,
                None => None,
            };
            resolved.insert(t, id);
        }
    }
    let file = match &parsed {
        Some((_, owners)) => OwnersFile::Parsed(owners),
        None => OwnersFile::Absent,
    };
    Ok(code_owner_review(
        file,
        &paths,
        &approvals,
        &oracle,
        policy,
        &resolved,
        &view.patch.author,
    ))
}

/// The branch-rule lines a code owner status leaves unmet ("code owner approval: src/a.rs
/// (@alice)"), for a refusal and a bypass record; empty when met.
#[must_use]
pub fn code_owner_rules(status: &CodeOwnerStatus) -> Vec<String> {
    if status.met {
        return Vec::new();
    }
    if status.unreadable {
        return vec!["code owner approval: the code owners file could not be read".to_string()];
    }
    status
        .pending
        .iter()
        .map(|p| {
            format!(
                "code owner approval: {} ({}{})",
                crate::fmt::safe(&p.path),
                crate::fmt::safe(&p.owners.join(" ")),
                if p.approvable {
                    ""
                } else {
                    "; none of them can approve"
                }
            )
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo_with(files: &[(&str, &str)]) -> (tempfile::TempDir, String) {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        let g = |args: &[&str]| git::git(p, args, &[]).unwrap();
        g(&["init", "-q"]);
        g(&["config", "user.email", "t@example.com"]);
        g(&["config", "user.name", "t"]);
        for (path, text) in files {
            let full = p.join(path);
            std::fs::create_dir_all(full.parent().unwrap()).unwrap();
            std::fs::write(full, text).unwrap();
        }
        g(&["add", "."]);
        g(&["commit", "-q", "-m", "c"]);
        let tip = g(&["rev-parse", "HEAD"]);
        (dir, tip)
    }

    #[test]
    fn the_first_code_owners_file_wins() {
        let (dir, tip) = repo_with(&[
            ("CODEOWNERS", "* @root\n"),
            (".github/CODEOWNERS", "* @github\n"),
        ]);
        let (path, owners) = read_code_owners(dir.path(), &tip).unwrap().unwrap();
        assert_eq!(path, ".github/CODEOWNERS");
        assert_eq!(owners.owners_of("x"), ["@github"]);
        let (none, tip) = repo_with(&[("README.md", "hi")]);
        assert!(read_code_owners(none.path(), &tip).unwrap().is_none());
    }

    #[test]
    fn renames_count_as_both_paths() {
        let (dir, base) = repo_with(&[("a/old.txt", "same content here\n"), ("keep", "k")]);
        let p = dir.path();
        std::fs::create_dir_all(p.join("b")).unwrap();
        git::git(p, &["mv", "a/old.txt", "b/new.txt"], &[]).unwrap();
        git::git(p, &["commit", "-q", "-m", "mv"], &[]).unwrap();
        let head = git::git(p, &["rev-parse", "HEAD"], &[]).unwrap();
        let mut paths = changed_paths(p, &base, &head).unwrap();
        paths.sort();
        assert_eq!(paths, ["a/old.txt", "b/new.txt"]);
    }
}
