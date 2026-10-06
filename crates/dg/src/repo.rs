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
use forge_core::resolve::{list_owned, repo_description, repo_fork_defaults, repo_slug};
use forge_core::user_error::{codes, UserError};

use crate::common::{resolve, Reader, RepoRef, Session};
use crate::context::Ctx;
use crate::fmt::{cost_json, cost_line, REPO_CREATE_ESTIMATE_CREDITS};
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
        RepoCommand::Fork {
            repo,
            name,
            default_branch_only,
        } => fork(ctx, repo, name.as_deref(), *default_branch_only).await,
        RepoCommand::Sync { repo, branch } => {
            crate::repo_sync::sync(ctx, repo, branch.as_deref()).await
        }
        RepoCommand::Reindex {
            repo,
            profile,
            git_dir,
        } => crate::maint::reindex(ctx, repo, profile.as_deref(), git_dir.as_deref()).await,
        RepoCommand::Star { repo, no_trending } => star(ctx, repo, true, !no_trending).await,
        RepoCommand::Unstar { repo } => star(ctx, repo, false, false).await,
        RepoCommand::Watch { repo } => watch(ctx, repo, true).await,
        RepoCommand::Unwatch { repo } => watch(ctx, repo, false).await,
        RepoCommand::Topic { repo, add, remove } => topic(ctx, repo, add, remove).await,
        RepoCommand::View { repo } => Box::pin(view(ctx, repo)).await,
        RepoCommand::List { owner_arg, owner } => {
            list(ctx, owner_arg.as_deref().or(owner.as_deref())).await
        }
        RepoCommand::Backend(RepoBackendCommand::Set { repo, mode }) => {
            backend_set(ctx, repo, mode.mode(), mode.label()).await
        }
        RepoCommand::Keys(cmd) => crate::keys::run(ctx, cmd).await,
        RepoCommand::Members(cmd) => crate::keys::run_members(ctx, cmd).await,
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
/// into the parent's scope), and the parent's branches and tags copied (its default branch
/// alone with `default_branch_only`). Resumable.
async fn fork(ctx: &Ctx, repo: &str, name: Option<&str>, default_branch_only: bool) -> Result<()> {
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
    // Refused before any read a private parent would need its keys for.
    parent.require_public("forking")?;
    let price = ctx.usd_price();
    let svc = RepoService::new(&client, &identity, &bridge);
    let (parent_packs, default_branch, doc_defaults) = tokio::join!(
        Box::pin(svc.read_pack_manifests(&parent)),
        Box::pin(svc.read_default_branch(&parent)),
        Box::pin(repo_fork_defaults(&client, &parent))
    );
    let parent_packs = parent_packs.context("reading the parent's packs")?;
    // The manifests the fork will write, with the URIs each records (each adds to its price).
    let planned: Vec<forge_core::repo::PackManifestInput> =
        forge_core::fork::plan_manifests(&parent_packs, &BTreeMap::new(), &BTreeSet::new())
            .iter()
            .filter_map(|copies| {
                forge_core::fork::fork_manifest(&parent, copies)
                    .ok()
                    .flatten()
            })
            .collect();
    let manifest_uris: Vec<u64> = planned.iter().map(|m| m.uris.len() as u64).collect();
    let packs = manifest_uris.len();
    warn_unreadable_packs(&parent, &planned);
    // As on GitHub, the fork takes the parent's default branch (QW2-013) and description
    // (QW2-062; it was "fork of <parent>", which `forkOf` already records).
    let default_branch = default_branch.context("reading the parent's default branch")?;
    let (description, doc_branch) = doc_defaults.context("reading the parent's repo document")?;
    // The newest config's branch, else the one the repo document names (as the web reads it).
    let default_branch = default_branch.filter(|b| !b.is_empty()).or(doc_branch);
    let opts = fork_opts(slug.clone(), default_branch, &description);
    // Its branches and tags (a mirror's PR heads stay the parent's, QW3-009), or the default
    // branch alone.
    let refs = forge_core::fork::plan_refs(
        &svc.read_refs(&parent)
            .await
            .context("reading the parent's refs")?,
        &[],
        default_branch_only.then_some(opts.default_branch.as_str()),
    )
    .len();
    let estimate = fork_estimate(&manifest_uris, refs as u64);
    if !ctx.json {
        println!(
            "Forking {} as {}/{slug} on {}\n  repo + {}, nothing re-uploaded, + {}   {}",
            parent.display(),
            identity.id(),
            ctx.network_label(),
            crate::fmt::plural(packs, "pack"),
            crate::fmt::plural(refs, "ref"),
            cost_line(estimate, price)
        );
    }
    ctx.confirm_or_cancel(&format!("Fork {}?", parent.display()))?;
    let result = forge_core::fork::fork_repo(
        &client,
        &identity,
        &bridge,
        &parent,
        &opts,
        &default_journal_dir()?,
        default_branch_only,
    )
    .await
    .context("forking the repository")?;
    report_fork(ctx, &parent, &result, price)
}

/// QW4-062: warn, before the prompt (on stderr, JSON mode too), when some of the parent's packs
/// are recorded only where no other computer reads them: the fork records the same copies, so
/// a clone of it fails (E503) until the parent's pusher copies them to public storage.
fn warn_unreadable_packs(
    parent: &forge_core::scope::RepoRef,
    planned: &[forge_core::repo::PackManifestInput],
) {
    let (n, places) = forge_core::fork::unreadable_by_others(planned);
    if n == 0 {
        return;
    }
    eprintln!(
        "warning: {n} of {p}'s {} are recorded only at {}, which other computers don't read: a fork records the copies its parent has when it is made, so cloning this one fails (E503). Ask {p}'s maintainers to record them at a public https address first (`dg repack {p} --profile <profile>`), then fork",
        crate::fmt::plural(planned.len(), "pack"),
        if places.is_empty() {
            "no address".to_string()
        } else {
            places.join(", ")
        },
        p = parent.display()
    );
}

/// A fork's create options: the parent's default branch (`main` when it has none) and its
/// description.
fn fork_opts(slug: String, default_branch: Option<String>, description: &str) -> CreateRepoOpts {
    let base = CreateRepoOpts::public(slug);
    CreateRepoOpts {
        default_branch: default_branch
            .filter(|b| !b.is_empty())
            .unwrap_or(base.default_branch.clone()),
        // A fork of a mirror is no mirror (QW3-011): the copied description loses its marker.
        description: forge_core::fork::without_mirror_marker(description),
        ..base
    }
}

/// The pre-sign quote for a fork writing one manifest per entry of `manifest_uris` (each
/// recording that many URIs) and copying `refs` refs (QW2-020: it priced each manifest and ref
/// at 20M credits and was exceeded 1.5x): the repository's three documents, its first manifest
/// and first ref update as firsts of their kind (their subtrees are created), and every later
/// one as what it is: a manifest into a repository that has one, and the first update of a new
/// ref name. The web's fork dialog prices the same writes the same way (QW4-047: pricing every
/// one as the repository's first quoted 17-36 % over the web, and over the charge). An upper
/// bound.
fn fork_estimate(manifest_uris: &[u64], refs: u64) -> u64 {
    use forge_core::cost::push_fees;
    let manifests: u64 = manifest_uris
        .iter()
        .enumerate()
        .map(|(i, uris)| {
            let base = if i == 0 {
                push_fees::MANIFEST_FIRST
            } else {
                push_fees::MANIFEST_LATER
            };
            base + uris * push_fees::URIS_PER_TARGET
        })
        .sum();
    let refs = match refs {
        0 => 0,
        n => push_fees::REF_FIRST + (n - 1) * push_fees::REF_NEW_NAME,
    };
    REPO_CREATE_ESTIMATE_CREDITS + manifests + refs
}

/// Print (or `--json`-emit) a finished fork; an incomplete one is E503.
fn report_fork(
    ctx: &Ctx,
    parent: &forge_core::scope::RepoRef,
    result: &forge_core::fork::ForkResult,
    price: Option<f64>,
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
                    "fork incomplete: {} of {} have no copy a fork can reference",
                    crate::fmt::plural(result.unreferenceable.len(), "pack"),
                    parent.display()
                ),
            )
            .cause("their only recorded copies are URLs too long for a manifest, or none at all")
            .fix(format!(
                "push your branches to {} from a full clone of the parent",
                fork.remote_url()
            ))
            .note(format!(
                "{} exists with {} recorded; no ref was copied",
                fork.display(),
                crate::fmt::plural(result.manifests_written, "pack")
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

/// Star or unstar `repo` (forge-community `star`, `indexOnly`; unstar is the values-carrying
/// delete). A new star also writes a `starBeat` when `trending` and the config allow it, unless
/// the contract is RC2's fused star, where the star itself counts toward Trending.
async fn star(ctx: &Ctx, repo: &str, on: bool, trending: bool) -> Result<()> {
    let s = Session::open(ctx, repo).await?;
    let handle = &s.repo;
    let collab = s.collab();
    let trending = on
        && trending
        && crate::config::Config::load()
            .ok()
            .and_then(|c| c.trending)
            .unwrap_or(forge_core::collab::v2::TRENDING_DEFAULT);
    // RC2's fused star (C1): the star is the only document, and a public repository's star
    // counts toward Trending by itself, with nothing to opt out of. (Readers leave out private
    // repositories, and an owner's star only where they can tell it is in the window: on a
    // repository created inside it. Elsewhere an owner's star counts too, so the warning stands.)
    let fused = collab.fused_star(handle).await?;
    if on && fused && !trending && handle.visibility == Visibility::Public {
        eprintln!(
            "warning: on this network a star counts toward Trending by itself, so --no-trending \
             (or `trending = false`) has no effect"
        );
    }
    let name = handle.display();
    let price = ctx.usd_price();
    ctx.confirm_or_cancel(&match (on, trending && !fused) {
        (true, true) => format!(
            "Star {name}? (two documents: the star, and one that counts it toward Trending, {}; --no-trending skips it)",
            cost_line(crate::quote::STAR + crate::quote::STAR_BEAT, price)
        ),
        (true, false) => format!("Star {name}? (one document, {})", cost_line(crate::quote::STAR, price)),
        // RC2's fused star has no `starBeat`, so no week count outlives the star.
        (false, _) if fused => format!("Unstar {name}? (one document, refunded)"),
        (false, _) => format!("Unstar {name}? (one document, refunded; a Trending count stays until its week ends)"),
    })?;
    let before = collab.star_count(handle).await.ok();
    // A new star pays; an unstar is refunded, so only a star's spend is measured.
    let (changed, spent) = if on {
        let before = s.balance().await;
        let changed = collab.star(handle, trending).await?;
        // Only a write that landed is measured: an already-starred repo answers at once
        // (`spent_since` waits for the balance to move).
        let spent = if changed {
            Some(s.spent_since(before).await)
        } else {
            None
        };
        (changed, spent)
    } else {
        (collab.unstar(handle).await?, None)
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
            "cost": spent.map(|c| cost_json(c, price)),
        }),
        || {
            let n = count
                .map(|c| format!(" ({})", crate::fmt::plural(c, "star")))
                .unwrap_or_default();
            let paid = spent.map_or(String::new(), |c| format!(" · {}", cost_line(c, price)));
            println!("✓ {} {what}{n}{paid}", handle.display());
        },
    );
    Ok(())
}

/// Watch or stop watching `repo` (forge-community `watch`, indexOnly).
async fn watch(ctx: &Ctx, repo: &str, on: bool) -> Result<()> {
    // Not a write to the repo: an archived repo can be watched, as it can be starred.
    let s = Session::open(ctx, repo).await?;
    let verb = if on { "Watch" } else { "Stop watching" };
    let price = ctx.usd_price();
    ctx.confirm_or_cancel(&format!(
        "{verb} {}? (one document, {})",
        s.repo.display(),
        if on {
            cost_line(crate::quote::WATCH, price)
        } else {
            "refunded".to_string()
        }
    ))?;
    let collab = s.collab();
    let (changed, spent) = if on {
        let before = s.balance().await;
        let changed = collab.watch(&s.repo).await?;
        let spent = if changed {
            Some(s.spent_since(before).await)
        } else {
            None
        };
        (changed, spent)
    } else {
        (collab.unwatch(&s.repo).await?, None)
    };
    let watchers = collab.watcher_count(&s.repo).await.ok();
    let status = match (on, changed) {
        (true, true) => "watching",
        (true, false) => "already_watching",
        (false, true) => "unwatched",
        (false, false) => "not_watching",
    };
    ctx.emit(
        json!({
            "status": status,
            "repo": s.repo.display(),
            "watchers": watchers,
            "cost": spent.map(|c| cost_json(c, price)),
        }),
        || {
            let n = watchers
                .map(|c| format!(" ({c} watching)"))
                .unwrap_or_default();
            let paid = spent.map_or(String::new(), |c| format!(" · {}", cost_line(c, price)));
            println!(
                "✓ {}: {}{n}{paid}",
                s.repo.display(),
                status.replace('_', " ")
            );
        },
    );
    Ok(())
}

/// List `repo`'s topics, or add / remove some (its owner): `repo.topics` changes, and the
/// `topic` documents Explore counts follow it.
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
    let collab = s.collab();
    let current = collab.topics(&s.repo).await?;
    let added: Vec<String> = add
        .iter()
        .filter(|t| !current.contains(t))
        .cloned()
        .collect();
    let removed: Vec<String> = remove
        .iter()
        .filter(|t| current.contains(t))
        .cloned()
        .collect();
    let mut topics: Vec<String> = current
        .iter()
        .filter(|t| !removed.contains(t))
        .cloned()
        .collect();
    for t in &added {
        if !topics.contains(t) {
            topics.push(t.clone());
        }
    }
    // The repo document's list is replaced, and each added topic writes its document (a removed
    // one's delete is refunded).
    let price = ctx.usd_price();
    let list_bytes: usize = topics.iter().map(String::len).sum();
    let quote = crate::quote::replace(list_bytes as u64) + added.len() as u64 * crate::quote::TOPIC;
    ctx.confirm_or_cancel(&format!(
        "Change the topics of {}? (+{} / -{}: the repo document's list, and one topic document each, {}; owner only)",
        s.repo.display(),
        added.len(),
        removed.len(),
        cost_line(quote, price)
    ))?;
    // Also run when the list is unchanged: it repairs topic documents that lag the list.
    let before = s.balance().await;
    collab.set_topics(&s.repo, &topics).await?;
    let spent = s.spent_since(before).await;
    ctx.emit(
        json!({
            "repo": s.repo.display(),
            "added": added,
            "removed": removed,
            "topics": topics,
            "cost": cost_json(spent, price),
        }),
        || {
            println!(
                "✓ {}: {} · {}",
                s.repo.display(),
                if topics.is_empty() {
                    "no topics".to_string()
                } else {
                    topics.join(", ")
                },
                cost_line(spent, price)
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
    // `archived` is `null` when the config cannot be read, not a guessed `false` (QW-081);
    // likewise `description` (`""` when the repo has none, as `repo list` has it).
    let member_reader = MemberReader::new(client);
    let (default_branch, config, description, refs, manifests, members) = tokio::join!(
        svc.read_default_branch(handle),
        svc.current_config(handle),
        repo_description(client, handle),
        svc.read_refs(handle),
        svc.read_pack_manifests(handle),
        member_reader.list(handle),
    );
    let archived = config.ok().map(|c| c.archived);
    let description = description.ok();
    let visibility = match handle.visibility {
        Visibility::Private => "private",
        Visibility::Public => "public",
    };
    let ViewListing {
        default_branch,
        refs,
        manifests,
        members,
    } = view_listing(default_branch, refs, manifests, members.map(|m| m.len()))?;

    // Sorted by name (QW4-063: in the order they were read).
    let mut refs = refs;
    refs.sort_by(|a, b| a.0.cmp(&b.0));
    let refs_json: Vec<_> = refs
        .iter()
        .map(|(name, state)| {
            json!({ "name": name, "state": serde_json::to_value(state).unwrap_or_default() })
        })
        .collect();
    // Git packs only (kind 0): browse indexes, long bodies (a members-only one is kind 70),
    // release assets and history indexes are artifacts of their own, not packs.
    let manifests: Vec<_> = manifests
        .into_iter()
        .filter(|m| m.kind == u64::from(forge_core::pack::KIND_GIT_PACK))
        .collect();
    let total_bytes: u64 = manifests.iter().map(|m| m.size_bytes).sum();

    ctx.emit(
        json!({
            "repoId": handle.id(),
            "ownerId": handle.owner_id(),
            "name": handle.name(),
            "description": description,
            "visibility": visibility,
            "archived": archived,
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
            if let Some(d) = description.as_deref().filter(|d| !d.is_empty()) {
                println!("  description:    {}", crate::fmt::safe(d));
            }
            println!(
                "  visibility:     {visibility}{}",
                if archived == Some(true) {
                    " (archived)"
                } else {
                    ""
                }
            );
            println!(
                "  default branch: {}",
                default_branch.clone().unwrap_or_else(|| "(none)".into())
            );
            for line in ref_summary(&refs, default_branch.as_deref()) {
                println!("{line}");
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

/// How many branches and tags `repo view` lists by name before it counts the rest.
const VIEW_REFS_SHOWN: usize = 10;

/// `repo view`'s refs (QW4-063: every ref, unsorted, 606 lines for dashpay/dash): the
/// branches, the default one first and the rest by name (digit runs as numbers), and the tags
/// in release order (`forge_core::collab::v2::tag_order`, as `dg release list` and the web
/// order them), each up to [`VIEW_REFS_SHOWN`] with the rest counted; other refs (a mirror's
/// PR heads) only counted. A diverged ref is always listed, wherever it falls: it is the one
/// that needs action. `--json` lists every ref.
fn ref_summary(
    refs: &[(String, forge_core::rules::RefState)],
    default_branch: Option<&str>,
) -> Vec<String> {
    use forge_core::collab::v2::{natural_order, tag_order};
    use forge_core::rules::RefState;
    type Ref = (String, RefState);
    let diverged = |r: &&Ref| matches!(r.1, RefState::Diverged { .. });
    let short = |n: &str, prefix: &str| n.strip_prefix(prefix).unwrap_or(n).to_string();
    let default_ref = default_branch.map(crate::git::full_ref);
    let mut branches: Vec<&Ref> = refs
        .iter()
        .filter(|(n, _)| n.starts_with("refs/heads/"))
        .collect();
    branches.sort_by(|a, b| {
        (Some(&a.0) != default_ref.as_ref())
            .cmp(&(Some(&b.0) != default_ref.as_ref()))
            .then_with(|| natural_order(&a.0, &b.0))
    });
    let mut tags: Vec<&Ref> = refs
        .iter()
        .filter(|(n, _)| n.starts_with("refs/tags/"))
        .collect();
    tags.sort_by(|a, b| tag_order(&short(&a.0, "refs/tags/"), &short(&b.0, "refs/tags/")));
    let others: Vec<&Ref> = refs
        .iter()
        .filter(|(n, _)| !n.starts_with("refs/heads/") && !n.starts_with("refs/tags/"))
        .collect();
    let mut out = Vec::new();
    let mut truncated = false;
    for (label, prefix, list) in [
        ("branches", "refs/heads/", &branches),
        ("tags", "refs/tags/", &tags),
    ] {
        out.push(format!(
            "  {label}:{}{}",
            " ".repeat(15 - label.len()),
            list.len()
        ));
        let shown: Vec<&&Ref> = list
            .iter()
            .enumerate()
            .filter(|(i, r)| *i < VIEW_REFS_SHOWN || diverged(r))
            .map(|(_, r)| r)
            .collect();
        for (name, state) in shown.iter().map(|r| (&r.0, &r.1)) {
            out.push(format!(
                "    {}  {}",
                short(name, prefix),
                ref_state_short(state)
            ));
        }
        if list.len() > shown.len() {
            truncated = true;
            out.push(format!("    … and {} more", list.len() - shown.len()));
        }
    }
    if !others.is_empty() {
        out.push(format!("  other refs:     {}", others.len()));
        for (name, state) in others.iter().filter(|r| diverged(r)).map(|r| (&r.0, &r.1)) {
            out.push(format!("    {name}  {}", ref_state_short(state)));
        }
    }
    if truncated || !others.is_empty() {
        out.push("  (`--json` lists every ref; `git ls-remote` in a clone too)".to_string());
    }
    out
}

/// What `repo view` lists: the default branch, live refs, pack manifests and member count.
struct ViewListing {
    default_branch: Option<String>,
    refs: Vec<(String, forge_core::rules::RefState)>,
    manifests: Vec<forge_core::repo::PackManifestInfo>,
    members: usize,
}

/// Every read `repo view` lists must have succeeded: a failed read (a DAPI outage, an
/// incomplete history) is the error, named, not a repo shown with no refs, no packs and no
/// members, which reads as "this repository is empty".
fn view_listing(
    default_branch: forge_core::Result<Option<String>>,
    refs: forge_core::Result<Vec<(String, forge_core::rules::RefState)>>,
    manifests: forge_core::Result<Vec<forge_core::repo::PackManifestInfo>>,
    members: forge_core::Result<usize>,
) -> Result<ViewListing> {
    Ok(ViewListing {
        default_branch: default_branch.context("reading the default branch")?,
        refs: live_refs(refs.context("reading the refs")?),
        manifests: manifests.context("reading the pack manifests")?,
        members: members.context("reading the members")?,
    })
}

/// Keep only refs that currently point at a commit: `read_refs` enumerates every ref name
/// that ever had a push, and a ref folding to `Unborn` there means it was deleted (Platform
/// history is append-only, so the name persists — `RefState::Unborn`'s doc comment). Neither
/// `git ls-remote` nor the web's Branches/Tags count (`isLive`, forge-web `lib/view/refs.ts`)
/// show a deleted ref, so `repo view` should not list or count one either (D-6).
fn live_refs(
    refs: Vec<(String, forge_core::rules::RefState)>,
) -> Vec<(String, forge_core::rules::RefState)> {
    refs.into_iter()
        .filter(|(_, state)| forge_core::rules::tip_of(state).is_some())
        .collect()
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
            println!(
                "{} for {owner_id}:",
                crate::fmt::plural(repos.len(), "repo")
            );
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

    /// QW2-013 / QW2-062: a fork takes the parent's default branch and description.
    #[test]
    fn a_fork_takes_the_parents_default_branch_and_description() {
        let opts = fork_opts("proj".into(), Some("develop".into()), "A project");
        assert_eq!(opts.default_branch, "develop");
        assert_eq!(opts.description, "A project");
        assert_eq!(opts.visibility, Visibility::Public);
        let bare = fork_opts("proj".into(), None, "");
        assert_eq!(bare.default_branch, "main");
        assert_eq!(bare.description, "");
        assert_eq!(
            fork_opts("proj".into(), Some(String::new()), "").default_branch,
            "main"
        );
        // QW3-011: a fork of a mirror does not claim to be one.
        let of_mirror = fork_opts(
            "dips".into(),
            None,
            "Dash Improvement Proposals (mirror of github.com/dashpay/dips)",
        );
        assert_eq!(of_mirror.description, "Dash Improvement Proposals");
    }

    /// QW2-020: a fork of a parent with two packs and two refs was quoted 0.0032 DASH and
    /// charged 0.00494466 on bonsia.
    #[test]
    fn a_fork_quote_covers_its_charge() {
        // Each of the two manifests names the parent's Platform locator (live: 0.0061 DASH
        // charged for 2 packs and 3 refs, quoted 0.00736).
        assert!(fork_estimate(&[1, 1], 2) >= 494_466_000);
        assert!(fork_estimate(&[1, 1], 3) >= 608_980_000);
        assert!(fork_estimate(&[1, 1], 2) < 2 * 494_466_000);
        assert!(fork_estimate(&[1, 1, 1], 2) > fork_estimate(&[1, 1], 2));
        assert!(fork_estimate(&[1, 1], 3) > fork_estimate(&[1, 1], 2));
        // A pack replicated to more stores records more URIs, and costs more.
        assert!(fork_estimate(&[4, 4], 2) > fork_estimate(&[1, 1], 2));
    }

    /// QW4-047: dg quoted a fork 17-36 % over the web's fork dialog for the same writes. The two
    /// now agree within a few percent, and still cover the charge.
    #[test]
    fn a_fork_quote_agrees_with_the_web_dialog() {
        let near = |dg: u64, web: u64| dg >= web && dg * 100 <= web * 106;
        // dips on sakura (2 manifests, 5 branches): the web quoted 0.007687 (dg 0.00902).
        assert!(near(fork_estimate(&[1, 1], 5), 768_700_000));
        // dash (1 manifest, 606 refs): the web quoted 0.411803 (dg 0.56073).
        assert!(near(fork_estimate(&[1], 606), 41_180_300_000));
        // The web's default-branch-only fork of dips (2 manifests, 1 ref) charged 0.004979.
        assert!(fork_estimate(&[1, 1], 1) >= 497_900_000);
    }

    /// A DAPI failure on any listed read is an error naming that read, never an empty repo
    /// (`refs: 0`, `packs: 0`, `members: 0`).
    #[test]
    fn repo_view_surfaces_a_failed_read_instead_of_an_empty_repo() {
        let down = || forge_core::Error::Timeout { retryable: true };
        let ok = view_listing(Ok(Some("main".into())), Ok(vec![]), Ok(vec![]), Ok(2)).unwrap();
        assert_eq!(ok.default_branch.as_deref(), Some("main"));
        assert_eq!(ok.members, 2);

        let cases = [
            (
                view_listing(Err(down()), Ok(vec![]), Ok(vec![]), Ok(1)),
                "default branch",
            ),
            (
                view_listing(Ok(None), Err(down()), Ok(vec![]), Ok(1)),
                "refs",
            ),
            (
                view_listing(Ok(None), Ok(vec![]), Err(down()), Ok(1)),
                "pack manifests",
            ),
            (
                view_listing(Ok(None), Ok(vec![]), Ok(vec![]), Err(down())),
                "members",
            ),
        ];
        for (r, what) in cases {
            let Err(e) = r else {
                panic!("a failed {what} read rendered as a repo")
            };
            let msg = format!("{e:#}");
            assert!(msg.contains(what), "{msg}");
            assert!(msg.contains("timed out"), "the cause is kept: {msg}");
        }
    }

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

    /// QW4-063: `repo view` summarises the refs: branches (the default first) and tags, each
    /// bounded, other refs counted, not 606 lines in read order.
    #[test]
    fn repo_view_summarises_the_refs() {
        use forge_core::rules::RefState;
        let at = |n: &str| {
            (
                n.to_string(),
                RefState::Resolved {
                    oid: "a".repeat(40),
                    author: "who".into(),
                    created_at: 1,
                },
            )
        };
        let mut refs = vec![
            at("refs/tags/v0.1"),
            at("refs/heads/zeta"),
            at("refs/heads/master"),
        ];
        refs.extend((0..15).map(|i| at(&format!("refs/tags/v1.{i:02}"))));
        refs.extend((0..30).map(|i| at(&format!("refs/mirror/pull/{i}/head"))));
        let lines = ref_summary(&refs, Some("master"));
        assert_eq!(lines[0], "  branches:       2");
        assert_eq!(lines[1], "    master  aaaaaaaaaaaa");
        assert_eq!(lines[2], "    zeta  aaaaaaaaaaaa");
        assert_eq!(lines[3], "  tags:           16");
        assert_eq!(lines[4], "    v1.14  aaaaaaaaaaaa");
        assert_eq!(lines[14], "    … and 6 more");
        assert_eq!(lines[15], "  other refs:     30");
        assert!(lines[16].contains("`--json` lists every ref"));
        assert_eq!(lines.len(), 17);

        // Release order: a release above its pre-releases, `v0.10` above `v0.9`, a hyphen
        // before the version (`jq-1.7.1`) read as the name, not a pre-release.
        let names = [
            "v24.0.0-rc.2",
            "v0.9",
            "v24.0.0",
            "v24.0.0-rc.10",
            "v0.10",
            "jq-1.7.1-rc1",
            "jq-1.7.1",
        ];
        let refs: Vec<_> = names
            .iter()
            .map(|n| at(&format!("refs/tags/{n}")))
            .collect();
        let lines = ref_summary(&refs, None);
        let shown: Vec<&str> = lines[2..9]
            .iter()
            .map(|l| l.trim().split("  ").next().unwrap())
            .collect();
        assert_eq!(
            shown,
            [
                "v24.0.0",
                "v24.0.0-rc.10",
                "v24.0.0-rc.2",
                "jq-1.7.1",
                "jq-1.7.1-rc1",
                "v0.10",
                "v0.9"
            ]
        );

        // A diverged ref is listed even past the first ten, and among the other refs.
        let mut refs: Vec<_> = (0..12)
            .map(|i| at(&format!("refs/heads/b{i:02}")))
            .collect();
        let fork = RefState::Diverged { heads: vec![] };
        refs.push(("refs/heads/zz-split".to_string(), fork.clone()));
        refs.push(("refs/mirror/pull/1/head".to_string(), fork));
        let lines = ref_summary(&refs, None);
        assert!(
            lines
                .iter()
                .any(|l| l.starts_with("    zz-split  (diverged")),
            "{lines:?}"
        );
        assert!(lines.contains(&"    … and 2 more".to_string()), "{lines:?}");
        assert!(
            lines
                .iter()
                .any(|l| l.starts_with("    refs/mirror/pull/1/head  (diverged")),
            "{lines:?}"
        );
    }

    /// D-6: a deleted branch (folds to `Unborn`) is neither listed nor counted — parity with
    /// `git ls-remote` and the web's Branches/Tags count. A resolved or diverged ref stays.
    #[test]
    fn live_refs_drops_deleted_branches_and_keeps_the_rest() {
        use forge_core::rules::{RefHead, RefState};

        let resolved = RefState::Resolved {
            oid: "a".repeat(40),
            author: "who".into(),
            created_at: 1,
        };
        let diverged = RefState::Diverged {
            heads: vec![RefHead {
                id: "id".into(),
                oid: "b".repeat(40),
                author: "who".into(),
                created_at: 2,
            }],
        };
        let refs = vec![
            ("refs/heads/main".to_string(), resolved.clone()),
            (
                "refs/heads/feature/greet-name".to_string(),
                RefState::Unborn,
            ),
            ("refs/heads/diverged-branch".to_string(), diverged.clone()),
        ];
        let live = live_refs(refs);
        assert_eq!(
            live,
            vec![
                ("refs/heads/main".to_string(), resolved),
                ("refs/heads/diverged-branch".to_string(), diverged),
            ]
        );
    }
}
