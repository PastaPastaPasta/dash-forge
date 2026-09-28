//! `dg repo` — repository lifecycle: create / fork / view / list / star / backend set
//! (+ clone). `create` (and `dg init`) live in [`crate::publish`].
//!
//! New repositories are forge-v2: a `repo` document plus the owner's `maintainer`
//! membership and an initial `config` in the network's shared forge-core contract, written
//! by one resumable session (`forge_core::create`). A fork is the same plus `forkOf`, the
//! parent's packs recorded by reference and its refs copied (`forge_core::fork`).
//! Repositories cannot be deleted.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::process::Stdio;

use anyhow::{Context, Result};
use serde_json::json;

use forge_core::create::{default_journal_dir, CreateRepoOpts};
use forge_core::members::MemberReader;
use forge_core::repo::RepoService;
use forge_core::resolve::{list_owned, repo_slug};
use forge_core::user_error::{codes, UserError};

use crate::common::{resolve, Reader, RepoRef, Session};
use crate::context::Ctx;
use crate::fmt::{
    cost_json, cost_line, dash_usd_price, FORK_PER_DOC_CREDITS, REPO_CREATE_ESTIMATE_CREDITS,
};
use crate::publish::Report;

pub use crate::publish::init;
use crate::{RepoBackendCommand, RepoCommand};
use forge_core::rules::v2::Visibility;

/// How often, and how far apart, `dg repo star/unstar` re-reads the count after a write that
/// landed, until a node that has the write answers.
const STAR_VISIBLE_ATTEMPTS: usize = 8;
const STAR_VISIBLE_DELAY: std::time::Duration = std::time::Duration::from_millis(1500);

/// Dispatch a `repo` subcommand.
pub async fn run(ctx: &Ctx, cmd: &RepoCommand) -> Result<()> {
    match cmd {
        RepoCommand::Create(args) => crate::publish::create(ctx, args).await,
        RepoCommand::Clone { repo, dir } => clone(ctx, repo, dir.as_deref()),
        RepoCommand::Fork { repo, name } => fork(ctx, repo, name.as_deref()).await,
        RepoCommand::Star { repo, no_trending } => star(ctx, repo, true, !no_trending).await,
        RepoCommand::Unstar { repo } => star(ctx, repo, false, false).await,
        RepoCommand::Watch { repo } => watch(ctx, repo, true).await,
        RepoCommand::Unwatch { repo } => watch(ctx, repo, false).await,
        RepoCommand::Topic { repo, add, remove } => topic(ctx, repo, add, remove).await,
        RepoCommand::View { repo } => view(ctx, repo).await,
        RepoCommand::List { owner } => list(ctx, owner.as_deref()).await,
        RepoCommand::Backend(RepoBackendCommand::Set { repo, mode }) => {
            backend_set(ctx, repo, mode.mode(), mode.label()).await
        }
        RepoCommand::Keys(cmd) => crate::keys::run(ctx, cmd).await,
        RepoCommand::Edit(args) => crate::repo_settings::edit(ctx, args).await,
        RepoCommand::Protect(cmd) => crate::repo_settings::protect(ctx, cmd).await,
        RepoCommand::Policy(cmd) => crate::repo_settings::policy(ctx, cmd).await,
        RepoCommand::Archive { repo } => crate::repo_settings::archive(ctx, repo, true).await,
        RepoCommand::Unarchive { repo } => crate::repo_settings::archive(ctx, repo, false).await,
    }
}

/// `git clone dash://<owner>/<name> [<dir>]` on `dg`'s network, then pin that network in the
/// clone's git config, so `cd <dir> && git push` works in any shell (L-21). The helper does
/// the cloning; its progress and errors go to the terminal as with a plain `git clone`.
fn clone(ctx: &Ctx, repo: &str, dir: Option<&Path>) -> Result<()> {
    let repo_ref = RepoRef::parse(repo)?;
    let Some(owner) = &repo_ref.owner else {
        return Err(crate::errors::usage(
            "clone needs an explicit owner: `dg repo clone <owner>/<name>`",
        ));
    };
    // E702 with dg's own fix (flags) before git runs, rather than the helper's git-shaped one.
    ctx.target.require_v2()?;
    let url = format!("dash://{owner}/{}", repo_ref.name);
    let dest = dir.unwrap_or_else(|| Path::new(clone_dir_name(&repo_ref.name)));
    // git refuses a non-empty destination; say so here, where --json can show it.
    if !clone_dest_usable(dest) {
        return Err(crate::errors::usage(format!(
            "{} already exists and is not an empty directory: pass another directory \
             (`dg repo clone {repo} <dir>`)",
            dest.display()
        )));
    }
    let (_report_dir, report) = Report::new()?;
    let mut cmd = crate::git::dash_env(ctx).git_command()?;
    cmd.arg("clone")
        .arg(&url)
        .arg(dest)
        .envs(report.env())
        .stdin(Stdio::null());
    // Under --json git's own words (`fatal: …`) are captured for the cause; otherwise they
    // go to the terminal as with a plain `git clone`.
    let (status, stderr) = if ctx.json {
        let out = cmd
            .stdout(Stdio::null())
            .output()
            .context("running git clone")?;
        (
            out.status,
            String::from_utf8_lossy(&out.stderr).into_owned(),
        )
    } else {
        (cmd.status().context("running git clone")?, String::new())
    };
    if !status.success() {
        let (code, cause) = Report::helper_error(&report.events(), ctx.json).unwrap_or_else(|| {
            let git_said = last_fatal_line(&stderr)
                .map_or_else(|| format!("git clone exited with {status}"), str::to_string);
            (codes::UNEXPECTED, git_said)
        });
        return Err(UserError::new(code, format!("could not clone {url}"))
            .cause(cause)
            .fix("fix what the clone reported, then run the same command again")
            .into());
    }
    let pinned = crate::git::pin_network(ctx, dest).map_err(|e| {
        UserError::new(
            codes::GIT_REPO,
            format!(
                "cloned into {}, but recording the network failed",
                dest.display()
            ),
        )
        .cause(format!("{e:#}"))
        .fix(format!(
            "in {}: `{}`",
            dest.display(),
            ctx.network().git_config_command("")
        ))
    })?;
    let (shown, network) = (dest.display(), ctx.network_label());
    ctx.emit(
        json!({
            "remoteUrl": url,
            "directory": shown.to_string(),
            "network": network,
            "gitConfig": pinned,
        }),
        || {
            println!("✓ cloned {url} into {shown} ({network})");
            if !pinned.is_empty() {
                println!(
                    "✓ git config {} (so `git push` there uses {network})",
                    pinned.join(", ")
                );
            }
        },
    );
    Ok(())
}

/// Whether `git clone` can use `dest`: it does not exist, or is an empty directory.
fn clone_dest_usable(dest: &Path) -> bool {
    match std::fs::read_dir(dest) {
        Ok(mut entries) => entries.next().is_none(),
        Err(e) => e.kind() == std::io::ErrorKind::NotFound,
    }
}

/// git's last `fatal: …` line in `stderr`, without the prefix.
fn last_fatal_line(stderr: &str) -> Option<&str> {
    stderr
        .lines()
        .rev()
        .find_map(|l| l.trim().strip_prefix("fatal: "))
}

/// The directory `git clone` would make for a repository called `name` (its name without a
/// trailing `.git`, which `RepoRef` keeps and the helper strips).
fn clone_dir_name(name: &str) -> &str {
    name.strip_suffix(".git")
        .filter(|n| !n.is_empty())
        .unwrap_or(name)
}

/// Fork `repo`: a new forge-v2 repository with `forkOf` = the parent, the parent's packs
/// recorded without re-uploading (external URIs as they are; Platform chunks by a locator
/// into the parent's scope), and the parent's refs copied. Resumable.
async fn fork(ctx: &Ctx, repo: &str, name: Option<&str>) -> Result<()> {
    let Session {
        client,
        bridge,
        identity,
        repo: parent,
    } = Session::open(ctx, repo).await?;
    let slug = repo_slug(name.unwrap_or(parent.name()))?;
    if parent.owner_id() == identity.id() && slug == parent.name() {
        return Err(crate::errors::usage(format!(
            "{} is yours already; pass --name <new name> to fork it under another name",
            parent.display()
        )));
    }
    let price = dash_usd_price();
    let packs = RepoService::new(&client, &identity, &bridge)
        .read_pack_manifests(&parent)
        .await
        .map_or(0, |m| {
            forge_core::fork::plan_manifests(&m, &BTreeMap::new(), &BTreeSet::new()).len()
        });
    // repo + maintainer + config, one manifest per pack, and a few ref updates.
    let estimate = REPO_CREATE_ESTIMATE_CREDITS + FORK_PER_DOC_CREDITS * (packs as u64 + 4);
    if !ctx.json {
        println!(
            "Forking {} as {}/{slug} on {}\n  repo + {packs} pack manifest(s), nothing re-uploaded, + refs   {}",
            parent.display(),
            identity.id(),
            ctx.network_label(),
            cost_line(estimate, price)
        );
    }
    ctx.confirm_or_cancel(&format!("Fork {}?", parent.display()))?;
    let opts = CreateRepoOpts {
        description: format!("fork of {}", parent.display()),
        ..CreateRepoOpts::public(slug)
    };
    let result = forge_core::fork::fork_repo(
        &client,
        &identity,
        &bridge,
        &parent,
        &opts,
        &default_journal_dir()?,
    )
    .await
    .context("forking the repository")?;
    report_fork(ctx, &parent, &result, price)
}

/// Print (or `--json`-emit) a finished fork; an incomplete one is E503.
fn report_fork(
    ctx: &Ctx,
    parent: &forge_core::scope::RepoRef,
    result: &forge_core::fork::ForkResult,
    price: f64,
) -> Result<()> {
    let fork = &result.created.repo;
    let nothing_new = result.created.already_existed()
        && result.manifests_written == 0
        && result.refs_written.is_empty();
    let incomplete = !result.unreferenceable.is_empty();
    let body = json!({
        "status": if incomplete { "incomplete" } else if nothing_new { "exists" } else { "forked" },
        "repoId": fork.id(),
        "ownerId": fork.owner_id(),
        "name": fork.name(),
        "forkOf": parent.id(),
        "parent": parent.display(),
        "remoteUrl": fork.remote_url(),
        "manifestsWritten": result.manifests_written,
        "platformPacksReferenced": result.platform_referenced,
        "manifestsExisting": result.manifests_existing,
        "unreferenceablePacks": result.unreferenceable.iter().map(hex::encode).collect::<Vec<_>>(),
        "refsWritten": result.refs_written,
        "cost": cost_json(result.cost_credits, price),
    });
    if incomplete {
        // Some objects are nowhere a fork can point at: refs were not copied (they could
        // name commits the fork cannot serve). The repository exists; the user pushes.
        return Err(crate::errors::reported(
            forge_core::user_error::UserError::new(
                forge_core::user_error::codes::PACKS_UNREADABLE,
                format!(
                    "fork incomplete: {} pack(s) of {} have no copy a fork can reference",
                    result.unreferenceable.len(),
                    parent.display()
                ),
            )
            .cause("their only recorded copies are URLs too long for a manifest, or none at all")
            .fix(format!(
                "push your branches to {} from a full clone of the parent",
                fork.remote_url()
            ))
            .note(format!(
                "{} exists with {} pack(s) recorded; no ref was copied",
                fork.display(),
                result.manifests_written
            )),
            body,
        ));
    }
    ctx.emit(
        body,
        || {
            println!("✓ forked {} → {}", parent.display(), fork.display());
            println!(
                "  packs:   {} recorded ({} by reference to the parent's Platform chunks), nothing re-uploaded",
                result.manifests_written, result.platform_referenced
            );
            println!("  refs:    {} copied", result.refs_written.len());
            println!("  remote:  {}", fork.remote_url());
            println!("  cost:    {}", cost_line(result.cost_credits, price));
            println!(
                "  next:    push a branch to {}, then `dg pr create {}`",
                fork.remote_url(),
                parent.display()
            );
        },
    );
    Ok(())
}

/// Star or unstar `repo` (forge-collab `star`, `indexOnly`; unstar is the values-carrying
/// delete). A new star also writes a `starBeat` when `trending` and the config allow it.
async fn star(ctx: &Ctx, repo: &str, on: bool, trending: bool) -> Result<()> {
    let s = Session::open(ctx, repo).await?;
    let handle = &s.repo;
    let trending = on
        && trending
        && crate::config::Config::load()
            .ok()
            .and_then(|c| c.trending)
            .unwrap_or(forge_core::collab::v2::TRENDING_DEFAULT);
    let name = handle.display();
    ctx.confirm_or_cancel(&match (on, trending) {
        (true, true) => format!("Star {name}? (two small documents: the star, and one that counts it toward Trending; --no-trending skips it)"),
        (true, false) => format!("Star {name}? (one small document)"),
        (false, _) => format!("Unstar {name}? (one small document, refunded; a Trending count stays until its week ends)"),
    })?;
    let collab = s.collab();
    let before = collab.star_count(handle).await.ok();
    let changed = if on {
        collab.star(handle, trending).await?
    } else {
        collab.unstar(handle).await?
    };
    // A read right after the write can hit a node a block behind, which still counts the old
    // star set: re-read a few times until the count has moved the way this write moved it.
    let mut count = collab.star_count(handle).await.ok();
    if let (true, Some(b)) = (changed, before) {
        let moved = |c: Option<u64>| c.is_some_and(|c| if on { c > b } else { c < b });
        for _ in 0..STAR_VISIBLE_ATTEMPTS {
            if moved(count) {
                break;
            }
            tokio::time::sleep(STAR_VISIBLE_DELAY).await;
            count = collab.star_count(handle).await.ok();
        }
    }
    // A write that landed decides the answer; only a no-op needs the (possibly lagging) read.
    let starred = if changed {
        on
    } else {
        collab.is_starred(handle).await.unwrap_or(on)
    };
    let (status, what) = match (on, changed) {
        (true, true) => ("starred", "starred"),
        (true, false) => ("already_starred", "already starred"),
        (false, true) => ("unstarred", "unstarred"),
        (false, false) => ("not_starred", "was not starred"),
    };
    ctx.emit(
        json!({
            "status": status,
            "repo": handle.display(),
            "starred": starred,
            "stars": count,
        }),
        || {
            let n = count.map(|c| format!(" ({c} star(s))")).unwrap_or_default();
            println!("✓ {} {what}{n}", handle.display());
        },
    );
    Ok(())
}

/// Watch or stop watching `repo` (forge-collab `watch`, indexOnly).
async fn watch(ctx: &Ctx, repo: &str, on: bool) -> Result<()> {
    let s = Session::open_for_write(ctx, repo, "watch not changed").await?;
    let verb = if on { "Watch" } else { "Stop watching" };
    ctx.confirm_or_cancel(&format!(
        "{verb} {}? (one small document{})",
        s.repo.display(),
        if on { "" } else { ", refunded" }
    ))?;
    let collab = s.collab();
    let changed = if on {
        collab.watch(&s.repo).await?
    } else {
        collab.unwatch(&s.repo).await?
    };
    let watchers = collab.watcher_count(&s.repo).await.ok();
    let status = match (on, changed) {
        (true, true) => "watching",
        (true, false) => "already_watching",
        (false, true) => "unwatched",
        (false, false) => "not_watching",
    };
    ctx.emit(
        json!({ "status": status, "repo": s.repo.display(), "watchers": watchers }),
        || {
            let n = watchers
                .map(|c| format!(" ({c} watching)"))
                .unwrap_or_default();
            println!("✓ {}: {}{n}", s.repo.display(), status.replace('_', " "));
        },
    );
    Ok(())
}

/// List `repo`'s topics, or add / remove some (its owner; a topic is its own document, and
/// the repo document's `topics`, which pages display, follows).
async fn topic(ctx: &Ctx, repo: &str, add: &[String], remove: &[String]) -> Result<()> {
    if add.is_empty() && remove.is_empty() {
        let r = Reader::open(ctx, repo).await?;
        let topics = r.collab().topics(&r.repo).await?;
        ctx.emit(
            json!({ "repo": r.repo.display(), "topics": topics }),
            || {
                if topics.is_empty() {
                    println!("no topics");
                }
                for t in &topics {
                    println!("{t}");
                }
            },
        );
        return Ok(());
    }
    let s = Session::open_for_write(ctx, repo, "topics not changed").await?;
    ctx.confirm_or_cancel(&format!(
        "Change the topics of {}? (+{} / -{}: one small document each, then the repo's topic list; owner only)",
        s.repo.display(),
        add.len(),
        remove.len()
    ))?;
    let collab = s.collab();
    let (mut added, mut removed) = (Vec::new(), Vec::new());
    for t in add {
        if collab.add_topic(&s.repo, t).await? {
            added.push(t.clone());
        }
    }
    for t in remove {
        if collab.remove_topic(&s.repo, t).await? {
            removed.push(t.clone());
        }
    }
    if !added.is_empty() || !removed.is_empty() {
        collab.sync_repo_topics(&s.repo).await?;
    }
    let topics = collab.topics(&s.repo).await.unwrap_or_default();
    ctx.emit(
        json!({ "repo": s.repo.display(), "added": added, "removed": removed, "topics": topics }),
        || {
            println!(
                "✓ {}: {}",
                s.repo.display(),
                if topics.is_empty() {
                    "no topics".to_string()
                } else {
                    topics.join(", ")
                }
            );
        },
    );
    Ok(())
}

/// View a repo: resolved refs, default branch, pack manifests, members.
async fn view(ctx: &Ctx, repo: &str) -> Result<()> {
    let r = Reader::open(ctx, repo).await?;
    let (client, handle) = (&r.client, &r.repo);
    let svc = r.service();
    // A private repo this identity cannot read (no encryption key, not a member, …): say
    // why, rather than show an empty repo (E306 / E307 and their fixes).
    if handle.visibility == Visibility::Private {
        svc.keyring(handle).await?.require_key(handle)?;
    }
    let default_branch = svc.read_default_branch(handle).await.unwrap_or(None);
    let refs = svc.read_refs(handle).await.unwrap_or_default();
    let manifests = svc.read_pack_manifests(handle).await.unwrap_or_default();
    let members = MemberReader::new(client)
        .list(handle)
        .await
        .map_or(0, |m| m.len());

    let refs_json: Vec<_> = refs
        .iter()
        .map(|(name, state)| {
            json!({ "name": name, "state": serde_json::to_value(state).unwrap_or_default() })
        })
        .collect();
    let total_bytes: u64 = manifests.iter().map(|m| m.size_bytes).sum();

    ctx.emit(
        json!({
            "repoId": handle.id(),
            "ownerId": handle.owner_id(),
            "name": handle.name(),
            "defaultBranch": default_branch,
            "refs": refs_json,
            "packCount": manifests.len(),
            "packBytes": total_bytes,
            "members": members,
            "remoteUrl": handle.remote_url(),
        }),
        || {
            println!("{}", handle.display());
            println!("  id:             {}", handle.id());
            println!(
                "  default branch: {}",
                default_branch.clone().unwrap_or_else(|| "(none)".into())
            );
            println!("  refs:           {}", refs.len());
            for (name, state) in &refs {
                println!("    {name}  {}", ref_state_short(state));
            }
            println!(
                "  packs:          {} ({total_bytes} bytes)",
                manifests.len()
            );
            println!("  members:        {members}");
            println!("  remote:         {}", handle.remote_url());
        },
    );
    Ok(())
}

/// A compact human string for a resolved ref state.
fn ref_state_short(state: &forge_core::rules::RefState) -> String {
    use forge_core::rules::RefState;
    match state {
        RefState::Unborn => "(unborn)".to_string(),
        RefState::Resolved { oid, .. } => oid.chars().take(12).collect(),
        RefState::Diverged { heads } => format!("(diverged: {} heads)", heads.len()),
    }
}

/// List an owner's repositories.
async fn list(ctx: &Ctx, owner: Option<&str>) -> Result<()> {
    // Another owner's list is public: no key is opened for it (L-12).
    let client = ctx.connect().await?;
    let owner_id = match owner {
        Some(o) => forge_core::resolve::resolve_owner(&client, o)
            .await
            .with_context(|| format!("resolving owner {o}"))?,
        None => match ctx.identity_id_hint() {
            Some(id) => id,
            None => ctx.signer_on(&client).await?.1.id(),
        },
    };
    let repos = list_owned(&client, &owner_id)
        .await
        .context("listing repositories")?;
    let rows: Vec<_> = repos
        .iter()
        .map(|r| {
            json!({
                "name": r.repo.name(),
                "repoId": r.repo.id(),
                "description": r.description,
            })
        })
        .collect();
    ctx.emit(
        json!({ "owner": owner_id, "count": rows.len(), "repos": rows }),
        || {
            println!("{} repo(s) for {owner_id}:", repos.len());
            for r in &repos {
                println!("  {}  {}", r.repo.name(), r.description);
            }
        },
    );
    Ok(())
}

/// Set a repo's storage backend mode (appends a new `config` doc; maintainer-gated).
async fn backend_set(ctx: &Ctx, repo: &str, mode: u8, label: &str) -> Result<()> {
    let repo_ref = RepoRef::parse(repo)?;
    let (client, bridge, identity) = ctx.connect_with_identity().await?;
    let handle = resolve(&client, &identity, &repo_ref).await?;

    if !ctx.confirm(&format!(
        "Set backend of {} to {label}? (a small config write)",
        handle.display()
    ))? {
        return Err(crate::errors::cancelled());
    }

    let svc = RepoService::new(&client, &identity, &bridge);
    let doc_id = svc
        .set_backend(&handle, mode, None)
        .await
        .context("writing the config")?;

    ctx.emit(
        json!({
            "status": if doc_id.is_some() { "backend_set" } else { "unchanged" },
            "repoId": handle.id(),
            "backend": label,
            "mode": mode,
            "configDocumentId": doc_id,
            "network": ctx.network_label(),
        }),
        || match &doc_id {
            Some(id) => println!(
                "Backend of {} set to {label} (config doc {id}).",
                handle.display()
            ),
            None => println!(
                "Backend of {} is already {label}; nothing was written.",
                handle.display()
            ),
        },
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_clone_destination_must_be_missing_or_empty() {
        let dir = tempfile::tempdir().unwrap();
        assert!(clone_dest_usable(&dir.path().join("new")));
        assert!(clone_dest_usable(dir.path()), "an empty directory");
        std::fs::write(dir.path().join("f"), "x").unwrap();
        assert!(!clone_dest_usable(dir.path()), "not empty");
        assert!(!clone_dest_usable(&dir.path().join("f")), "a file");
    }

    #[test]
    fn the_cause_is_gits_last_fatal_line() {
        let err = "Cloning into 'p'...\nwarning: x\nfatal: could not create work tree dir 'p': Permission denied\n";
        assert_eq!(
            last_fatal_line(err),
            Some("could not create work tree dir 'p': Permission denied")
        );
        assert_eq!(last_fatal_line("Cloning into 'p'...\n"), None);
    }
}
