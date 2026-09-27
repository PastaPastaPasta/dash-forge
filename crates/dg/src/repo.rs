//! `dg repo` — repository lifecycle: create / fork / view / list / star / backend set
//! (+ clone). `create` (and `dg init`) live in [`crate::publish`].
//!
//! New repositories are forge-v2: a `repo` document plus the owner's `maintainer`
//! membership and an initial `config` in the network's shared forge-core contract, written
//! by one resumable session (`forge_core::create`). A fork is the same plus `forkOf`, the
//! parent's packs recorded by reference and its refs copied (`forge_core::fork`).
//! Repositories cannot be deleted.

use std::collections::{BTreeMap, BTreeSet};

use anyhow::{Context, Result};
use serde_json::json;

use forge_core::create::{default_journal_dir, CreateRepoOpts};
use forge_core::members::MemberReader;
use forge_core::repo::RepoService;
use forge_core::resolve::{list_owned, repo_slug};

use crate::common::{resolve, RepoRef, Session};
use crate::context::Ctx;
use crate::fmt::{
    cost_json, cost_line, dash_usd_price, FORK_PER_DOC_CREDITS, REPO_CREATE_ESTIMATE_CREDITS,
};

pub use crate::publish::init;
use crate::{RepoBackendCommand, RepoCommand};
use forge_core::rules::v2::Visibility;

/// Dispatch a `repo` subcommand.
pub async fn run(ctx: &Ctx, cmd: &RepoCommand) -> Result<()> {
    match cmd {
        RepoCommand::Create(args) => crate::publish::create(ctx, args).await,
        RepoCommand::Clone { repo } => clone(ctx, repo),
        RepoCommand::Fork { repo, name } => fork(ctx, repo, name.as_deref()).await,
        RepoCommand::Star { repo } => star(ctx, repo, true).await,
        RepoCommand::Unstar { repo } => star(ctx, repo, false).await,
        RepoCommand::View { repo } => view(ctx, repo).await,
        RepoCommand::List { owner } => list(ctx, owner.as_deref()).await,
        RepoCommand::Backend(RepoBackendCommand::Set { repo, mode }) => {
            backend_set(ctx, repo, mode.mode(), mode.label()).await
        }
        RepoCommand::Keys(cmd) => crate::keys::run(ctx, cmd).await,
    }
}

/// Print the `git clone` invocation for a repo (cloning itself is the remote helper's job).
fn clone(ctx: &Ctx, repo: &str) -> Result<()> {
    let repo_ref = RepoRef::parse(repo)?;
    let owner = repo_ref
        .owner
        .clone()
        .context("clone needs an explicit owner: `dg repo clone <owner>/<name>`")?;
    let url = format!("dash://{}/{}", owner, repo_ref.name);
    ctx.emit(
        json!({ "remoteUrl": url, "command": format!("git clone {url}") }),
        || println!("git clone {url}"),
    );
    Ok(())
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
/// delete).
async fn star(ctx: &Ctx, repo: &str, on: bool) -> Result<()> {
    let s = Session::open(ctx, repo).await?;
    let handle = &s.repo;
    let verb = if on { "Star" } else { "Unstar" };
    ctx.confirm_or_cancel(&format!(
        "{verb} {}? (one small document)",
        handle.display()
    ))?;
    let collab = s.collab();
    let changed = if on {
        collab.star(handle).await?
    } else {
        collab.unstar(handle).await?
    };
    let starred = collab.is_starred(handle).await.unwrap_or(on);
    let count = collab.star_count(handle).await.ok();
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

/// View a repo: resolved refs, default branch, pack manifests, members.
async fn view(ctx: &Ctx, repo: &str) -> Result<()> {
    let repo_ref = RepoRef::parse(repo)?;
    let (client, bridge, identity) = ctx.connect_with_identity().await?;
    let handle = resolve(&client, &identity, &repo_ref).await?;

    let svc = RepoService::new(&client, &identity, &bridge);
    // A private repo this identity cannot read (no encryption key, not a member, …): say
    // why, rather than show an empty repo (E306 / E307 and their fixes).
    if handle.visibility == Visibility::Private {
        svc.keyring(&handle).await?.require_key(&handle)?;
    }
    let default_branch = svc.read_default_branch(&handle).await.unwrap_or(None);
    let refs = svc.read_refs(&handle).await.unwrap_or_default();
    let manifests = svc.read_pack_manifests(&handle).await.unwrap_or_default();
    let members = MemberReader::new(&client)
        .list(&handle)
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
    let (client, _bridge, identity) = ctx.connect_with_identity().await?;
    let owner_id = match owner {
        Some(o) => forge_core::resolve::resolve_owner(&client, o)
            .await
            .with_context(|| format!("resolving owner {o}"))?,
        None => identity.id(),
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
            "status": "backend_set",
            "repoId": handle.id(),
            "backend": label,
            "mode": mode,
            "configDocumentId": doc_id,
            "network": ctx.network_label(),
        }),
        || {
            println!(
                "Backend of {} set to {label} (config doc {doc_id}).",
                handle.display()
            );
        },
    );
    Ok(())
}
