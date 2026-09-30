//! `dg repack` / `dg reseed` / `dg import` — maintenance commands.
//!
//! - `repack` consolidates a repo's live packs into one optimized pack and publishes it
//!   with a `supersedes` list (`forge_core::repo::RepoService::repack`). It deletes
//!   nothing on Platform — forge-v2 chunks and manifests are permanent, so there is no
//!   refund — and the superseded packs stay readable as a fallback. Only packs on your own
//!   external storage can be garbage-collected afterwards, by you.
//! - `reseed` re-uploads pack bytes to another backend for availability and records the new
//!   location as the caller's own copy of the pack.
//! - `import` remains a thin, not-yet-wired wrapper over `forge-import` (PRD 06).

use anyhow::{bail, Context, Result};
use serde_json::json;

use forge_core::backends::ipfs::IpfsConfig;
use forge_core::backends::{IpfsBackend, PackBackend, S3Backend, S3Config};
use forge_core::repo::{PlatformChunkTarget, RepackTarget, RepoService};
use forge_core::storage::policy::git_config_scoped;
use forge_core::storage::{ExternalTarget, StorageProfiles, StorageTarget};

use crate::common::{resolve, RepoRef};
use crate::context::Ctx;
use crate::fmt::{cost_line, dash_usd_price};
use crate::Backend;

/// `dg repack <repo> [--backend]` — consolidate the live packs into one superseding pack.
/// Shows what will be consolidated, prompts unless `--yes`, then reports what it cost.
pub async fn repack(
    ctx: &Ctx,
    repo: Option<&str>,
    backend: Option<Backend>,
    profile: Option<&str>,
) -> Result<()> {
    let repo = repo.context("`dg repack` needs a repository: dg repack <owner>/<name>")?;
    let repo_ref = RepoRef::parse(repo)?;
    // `--profile a,b[,platform]`: the consolidated pack goes to every listed profile, and
    // each must confirm (so older packs gain the copies a new storage policy asks for).
    let profile_names = profile.map(profile_list).transpose()?.unwrap_or_default();
    let (external_names, platform) = split_platform(&profile_names)?;
    for name in &external_names {
        refuse_unpublishable_profile(name, "nothing repacked")?;
    }
    let legacy_uri = legacy_backend_uri(backend);
    if let Some(uri) = legacy_uri.as_deref() {
        refuse_unpublishable_url(uri, "nothing repacked")?;
    }
    let (client, bridge, identity) = ctx.connect_with_identity().await?;
    let handle = resolve(&client, &identity, &repo_ref).await?;
    let svc = RepoService::new(&client, &identity, &bridge);
    let price = dash_usd_price();

    let manifests = svc.read_pack_manifests(&handle).await.unwrap_or_default();
    let roles = svc.copy_roles(&handle).await.unwrap_or_default();
    let space = forge_core::repo::locator_pack_space(&manifests, &roles, None);
    let live_bytes: u64 = space.iter().map(|m| m.size_bytes).sum();
    if !ctx.json {
        println!(
            "Repack {}: {} git pack(s), {live_bytes} bytes",
            handle.display(),
            space.len()
        );
        println!(
            "  writes one consolidated pack + manifest; deletes nothing (Platform packs are \
             permanent, so there is no refund). Superseded packs stay readable as a fallback."
        );
    }
    if !ctx.confirm(&format!(
        "Repack {}? Uploads one consolidated pack (paid like a push)",
        handle.display()
    ))? {
        return Err(crate::errors::cancelled());
    }

    // The consolidated pack's destination: Platform (default), storage profiles and/or
    // Platform (verified uploads), or a legacy env-configured backend.
    let profile_targets = external_names
        .iter()
        .map(|n| external_profile_target(n))
        .collect::<Result<Vec<_>>>()?;
    let platform_target = platform.map(|name| PlatformChunkTarget::new(&svc, &handle, name));
    let external = if profile_names.is_empty() {
        build_external_backend(backend)?
    } else {
        None
    };
    let profile_refs: Vec<&dyn StorageTarget> = profile_targets
        .iter()
        .map(|t| t as &dyn StorageTarget)
        .chain(platform_target.as_ref().map(|t| t as &dyn StorageTarget))
        .collect();
    let target = if !profile_refs.is_empty() {
        RepackTarget::Replicated {
            targets: &profile_refs,
            required: profile_refs.len(),
        }
    } else if let Some(b) = &external {
        RepackTarget::External(b.as_ref())
    } else {
        RepackTarget::Platform
    };

    let report = svc.repack(&handle, target).await.context("repack failed")?;
    emit_repack_report(ctx, &handle, &report, price);
    Ok(())
}

/// `dg repo reindex <repo>` — publish the browse index over the stored packs no index
/// fragment covers, and the history index (the file list's last-commit column and the exact
/// commit count) of the default branch's tip when none covers it. The history index is computed
/// in a local clone that holds the tip: `git_dir`, else the current directory. Downloads those packs (verified), indexes them locally and uploads ONE
/// index fragment and its manifest: the packs themselves are never stored again, so it costs
/// the index (36 bytes per object) rather than a repack's full upload (D-920).
///
/// Where the index goes: `--profile a,b[,platform]` (each must confirm), else Platform when the
/// packs are stored there. `--profile` is required when they are not, and inside a clone of the
/// repository whose storage policy names your own storage: a repository is never given a
/// Platform index it did not ask for.
// Plan, quote, confirm, publish, report: each step is its own function.
#[allow(clippy::too_many_lines)]
pub async fn reindex(
    ctx: &Ctx,
    repo: &str,
    profile: Option<&str>,
    git_dir: Option<&std::path::Path>,
) -> Result<()> {
    let s = crate::common::Session::open_for_write(ctx, repo, "nothing published").await?;
    let svc = RepoService::new(&s.client, &s.identity, &s.bridge);
    let plan = svc
        .plan_reindex(&s.repo)
        .await
        .context("reading the browse index")?;
    let history = plan_history(&svc, &s.repo, &plan, git_dir).await?;
    if plan.missing.is_empty() && history.prepared.is_none() {
        ctx.emit(
            json!({
                "status": "indexed",
                "repoId": s.repo.id(),
                "missingPacks": 0,
                "history": history.status,
            }),
            || {
                println!(
                    "{}: every stored pack is already in the browse index; nothing to publish.",
                    s.repo.display()
                );
                if let Some(why) = &history.note {
                    println!("  history index:   {why}");
                }
            },
        );
        return Ok(());
    }

    let (external_names, platform) = reindex_targets(profile, repo, &s.repo, &plan)?;
    let profile_targets = external_names
        .iter()
        .map(|n| external_profile_target(n))
        .collect::<Result<Vec<_>>>()?;
    let platform_target = platform.map(|name| PlatformChunkTarget::new(&svc, &s.repo, name));
    let targets: Vec<&dyn StorageTarget> = profile_targets
        .iter()
        .map(|t| t as &dyn StorageTarget)
        .chain(platform_target.as_ref().map(|t| t as &dyn StorageTarget))
        .collect();
    let label = external_names
        .iter()
        .copied()
        .chain(platform)
        .collect::<Vec<_>>()
        .join(", ");

    let price = dash_usd_price();
    let estimate = quote_reindex(
        ctx,
        &s.repo,
        &plan,
        &history,
        &label,
        external_names.len() as u64,
        platform.is_some(),
        price,
    );
    ctx.confirm_or_cancel(&format!(
        "Publish the browse index of {} ({})?",
        s.repo.display(),
        cost_line(estimate, price)
    ))?;
    let before = s.client.get_balance(&s.identity.id()).await.ok();
    let target = || RepackTarget::Replicated {
        targets: &targets,
        required: targets.len(),
    };
    let report = if plan.missing.is_empty() {
        forge_core::repo::ReindexReport::default()
    } else {
        svc.reindex(&s.repo, &plan, target())
            .await
            .context("publishing the browse index")?
    };
    let published = match history.prepared {
        Some(h) => Some(
            svc.store_history_index(&s.repo, h, target())
                .await
                .context("publishing the history index")?,
        ),
        None => None,
    };
    // A balance that cannot be read leaves the spend unknown: never the estimate, never 0.
    let wrote = report.manifest_id.is_some() || published.is_some();
    let spent = match (before, wrote) {
        (Some(b), true) => measured_spend(&s, b).await,
        (Some(_), false) => Some(0),
        (None, _) => None,
    };
    let mut body = reindex_body(&s.repo, &report, spent, price);
    body["history"] = history_json(published.as_ref(), history.status);
    if published.is_some() && body["status"] == "unchanged" {
        body["status"] = json!("reindexed");
    }
    if report.manifest_id.is_none() && !report.skipped.is_empty() {
        // One document: the body with the error, not a success-shaped body and then an error.
        let err = forge_core::user_error::UserError::new(
            forge_core::user_error::codes::UNEXPECTED,
            "no pack could be indexed",
        )
        .cause(
            report
                .skipped
                .iter()
                .map(|(h, why)| format!("{h}: {why}"))
                .collect::<Vec<_>>()
                .join("; "),
        );
        if !ctx.json {
            print_reindex(&s.repo, &report, published.as_ref(), spent, price);
        }
        return Err(crate::errors::reported(err, body));
    }
    ctx.emit(body, || {
        print_reindex(&s.repo, &report, published.as_ref(), spent, price);
    });
    Ok(())
}

/// Price what `dg repo reindex` will publish (the locator part and the history index, each an
/// upper bound), and show it unless `--json`. Returns the total.
#[allow(clippy::too_many_arguments)]
fn quote_reindex(
    ctx: &Ctx,
    handle: &forge_core::scope::RepoRef,
    plan: &forge_core::repo::ReindexPlan,
    history: &HistoryReindex,
    label: &str,
    external_targets: u64,
    platform: bool,
    price: f64,
) -> u64 {
    let sealed = handle.visibility == forge_core::rules::v2::Visibility::Private;
    let locator = if plan.missing.is_empty() {
        0
    } else {
        reindex_estimate(plan.index_objects(), sealed, external_targets, platform)
    };
    let history_credits = history
        .prepared
        .as_ref()
        .map_or(0, |h| h.credits(sealed, external_targets, platform));
    if !ctx.json {
        if !plan.missing.is_empty() {
            print_reindex_plan(handle, plan, label, &cost_line(locator, price));
        }
        if let Some(h) = &history.prepared {
            print_history_plan(handle, h, label, &cost_line(history_credits, price));
        }
        if let Some(why) = &history.note {
            println!("  history index:   {why}");
        }
    }
    locator + history_credits
}

/// What `dg repo reindex` does about the history index.
struct HistoryReindex {
    /// The index to publish, computed locally.
    prepared: Option<forge_core::repo::PreparedHistory>,
    /// `covered` (an index covers the default branch's tip), `publish`, `no-branch` (the
    /// default branch has no tip), or `no-clone` (no local repository holds the tip).
    status: &'static str,
    /// Why nothing is published, or what the publish replaces, for a person.
    note: Option<String>,
}

/// Plan the history index of the default branch's tip: covered already, or computed from the
/// local repository (`git_dir`, else the current one) when it holds the tip. Never an error
/// for a missing clone: the locator part still runs, and the note says how to add the history.
async fn plan_history(
    svc: &RepoService<'_>,
    repo: &forge_core::scope::RepoRef,
    plan: &forge_core::repo::ReindexPlan,
    git_dir: Option<&std::path::Path>,
) -> Result<HistoryReindex> {
    let default = svc
        .read_default_branch(repo)
        .await
        .context("reading the default branch")?
        .unwrap_or_else(|| forge_core::repo::DEFAULT_BRANCH.to_string());
    let refs = svc.read_refs(repo).await.context("reading the refs")?;
    let want = format!("refs/heads/{default}");
    let tip = refs
        .iter()
        .find(|(n, _)| *n == want)
        .and_then(|(_, st)| forge_core::rules::tip_of(st))
        .and_then(|h| forge_core::pack::historyindex::parse_hex_oid(h.as_bytes()).ok());
    let Some(tip) = tip else {
        return Ok(HistoryReindex {
            prepared: None,
            status: "no-branch",
            note: Some(format!("the default branch {default} has no tip")),
        });
    };
    let hplan = plan.history_plan(tip);
    if hplan.covered {
        return Ok(HistoryReindex {
            prepared: None,
            status: "covered",
            note: None,
        });
    }
    let dir = match git_dir {
        Some(d) => d.to_path_buf(),
        None => std::env::current_dir()?,
    };
    let no_clone = |why: String| HistoryReindex {
        prepared: None,
        status: "no-clone",
        note: Some(format!(
            "not published: {why}; run it inside a clone that has {default} at {} (or pass \
             --git-dir)",
            &hex::encode(tip)[..12]
        )),
    };
    let tip_hex = hex::encode(tip);
    if !crate::git::has_object(&dir, &tip_hex) {
        return Ok(no_clone(format!("{} does not hold the tip", dir.display())));
    }
    match forge_core::repo::prepare_history_index(&dir, tip, &hplan) {
        Ok(Some(p)) => Ok(HistoryReindex {
            prepared: Some(p),
            status: "publish",
            note: None,
        }),
        Ok(None) => Ok(HistoryReindex {
            prepared: None,
            status: "covered",
            note: None,
        }),
        Err(e) => Ok(no_clone(format!("computing it failed ({e})"))),
    }
}

/// The history index part of the plan line.
fn print_history_plan(
    handle: &forge_core::scope::RepoRef,
    h: &forge_core::repo::PreparedHistory,
    label: &str,
    price: &str,
) {
    let ix = h.index();
    // The path versions are published only with the version lists (a missing column alone
    // carries none).
    let versions = if h.publishes_lists() {
        let n: usize = ix
            .versions
            .as_ref()
            .map_or(0, |v| v.lists.values().map(|l| l.versions.len()).sum());
        format!(", {n} path version(s)")
    } else {
        ", the column index only".to_string()
    };
    let manifests = h.cost().manifests();
    println!(
        "History index of {}: {} path(s), {} commit(s){versions}, {} bytes ({}) to {label} + \
         {manifests} manifest(s)   {price}",
        handle.display(),
        ix.paths.len(),
        ix.commit_count,
        h.plain_len(),
        if h.is_delta() { "delta" } else { "full" },
    );
}

/// The `history` member of the `--json` body.
fn history_json(
    published: Option<&forge_core::repo::HistoryPublished>,
    status: &str,
) -> serde_json::Value {
    match published {
        Some(p) => json!({
            "status": "published",
            "manifestId": p.manifest_id,
            "versionsManifestId": p.versions_manifest_id,
            "paths": p.rows,
            "delta": p.delta,
            "commits": p.commit_count,
        }),
        None => json!({ "status": status }),
    }
}

/// What `dg repo reindex` is about to do, and its price, before the prompt.
fn print_reindex_plan(
    handle: &forge_core::scope::RepoRef,
    plan: &forge_core::repo::ReindexPlan,
    label: &str,
    price: &str,
) {
    let missing_bytes: u64 = plan.missing.iter().map(|p| p.size_bytes).sum();
    println!(
        "Reindex {}: {} pack(s) without a browse index ({missing_bytes} bytes, read not \
         re-uploaded)",
        handle.display(),
        plan.missing.len()
    );
    println!(
        "  uploads one index fragment over {} objects{} to {label} + its manifest   {price}",
        plan.index_objects(),
        if plan.fold() {
            " (folding the live fragments in)"
        } else {
            ""
        },
    );
}

/// Credits spent since `before`, read until the balance moves (a node a block behind still
/// shows the old one); `None` when the balance cannot be read.
async fn measured_spend(s: &crate::common::Session, before: u64) -> Option<u64> {
    // A manifest was paid for, so a balance that has not moved is a node a block behind, not
    // a free write: unknown, not 0.
    for _ in 0..4 {
        if let Ok(after) = s.client.get_balance(&s.identity.id()).await {
            if after < before {
                return Some(before - after);
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
    }
    None
}

/// Where `dg repo reindex` stores the index: `--profile`, else this clone's storage policy
/// (inside a clone of `repo`), else Platform when the packs are stored there. Returns the
/// external profile names and the Platform profile (if any).
fn reindex_targets<'a>(
    profile: Option<&'a str>,
    asked: &str,
    repo: &forge_core::scope::RepoRef,
    plan: &forge_core::repo::ReindexPlan,
) -> Result<(Vec<&'a str>, Option<&'a str>)> {
    if let Some(list) = profile {
        let names = profile_list(list)?;
        let (external, platform) = split_platform(&names)?;
        for name in &external {
            refuse_unpublishable_profile(name, "nothing published")?;
        }
        return Ok((external, platform));
    }
    let owner_label = asked.split_once('/').map_or(asked, |(o, _)| o);
    if crate::storage::dash_remote_is(repo, owner_label) {
        let policy = crate::storage::push_policy()?;
        if !policy.external.is_empty() {
            return Err(crate::errors::usage(format!(
                "this clone stores packs on {}; pass the same storage as --profile \
                 (e.g. `--profile {}`) so the index goes where the packs are",
                policy.target_names().join(", "),
                policy.target_names().join(",")
            )));
        }
    }
    // With packs missing their locator, the index goes where those packs are; with only the
    // history index to publish, where any pack is.
    let on_platform = if plan.missing.is_empty() {
        plan.any_pack_on_platform()
    } else {
        plan.packs_on_platform()
    };
    if on_platform {
        return Ok((Vec::new(), Some(forge_core::storage::PLATFORM_PROFILE)));
    }
    Err(crate::errors::usage(
        "the packs of this repository are not stored on Platform; name the storage the \
         index goes to with --profile <name>[,<name>…] (see `dg storage list`)",
    ))
}

/// The on-chain price of a reindex: one index fragment's chunks when Platform stores it, and
/// its manifest with each external target's URIs, as a push prices the same (an upper bound).
fn reindex_estimate(
    index_objects: u64,
    sealed: bool,
    external_targets: u64,
    platform: bool,
) -> u64 {
    use forge_core::cost::push_fees::{index_chunks, MANIFEST_FIRST, URIS_PER_TARGET};
    let chunks = if platform {
        index_chunks(index_objects, sealed)
    } else {
        0
    };
    chunks + MANIFEST_FIRST + URIS_PER_TARGET * external_targets
}

/// The `--json` body of a finished reindex. `spent` is `None` when the balance could not be
/// read.
fn reindex_body(
    handle: &forge_core::scope::RepoRef,
    report: &forge_core::repo::ReindexReport,
    spent: Option<u64>,
    price: f64,
) -> serde_json::Value {
    let skipped: Vec<_> = report
        .skipped
        .iter()
        .map(|(h, why)| json!({ "packHash": h, "reason": why }))
        .collect();
    json!({
        "status": if report.manifest_id.is_some() { "reindexed" } else { "unchanged" },
        "repoId": handle.id(),
        "indexedPacks": report.indexed.len(),
        "indexObjects": report.index_objects,
        "skipped": skipped,
        "locatorManifestId": report.manifest_id,
        "cost": spent.map(|c| crate::fmt::cost_json(c, price)),
    })
}

/// Print a finished reindex for a person.
fn print_reindex(
    handle: &forge_core::scope::RepoRef,
    report: &forge_core::repo::ReindexReport,
    history: Option<&forge_core::repo::HistoryPublished>,
    spent: Option<u64>,
    price: f64,
) {
    match &report.manifest_id {
        Some(id) => {
            println!(
                "Published the browse index of {}: {} object(s) over {} pack(s).",
                handle.display(),
                report.index_objects,
                report.indexed.len()
            );
            println!("  index manifest:  {id}");
        }
        None if history.is_none() => println!(
            "Nothing published for {}: an index published meanwhile covers the packs, \
             or none could be indexed.",
            handle.display()
        ),
        None => {}
    }
    if let Some(h) = history {
        println!(
            "Published the history index of {}: {} path(s), {} commit(s){}.",
            handle.display(),
            h.rows,
            h.commit_count,
            if h.delta { " (delta)" } else { "" }
        );
        for (what, id) in [
            ("column index:     ", &h.manifest_id),
            ("version lists:    ", &h.versions_manifest_id),
        ] {
            if let Some(id) = id {
                println!("  {what}{id}");
            }
        }
    }
    for (h, why) in &report.skipped {
        println!("  not indexed:     {h}: {why}");
    }
    match spent {
        Some(c) => println!("  cost:            {}", cost_line(c, price)),
        None => println!("  cost:            unknown (the balance could not be read)"),
    }
}

/// Print (or `--json`-emit) a finished repack.
fn emit_repack_report(
    ctx: &Ctx,
    handle: &forge_core::scope::RepoRef,
    report: &forge_core::repo::RepackReport,
    price: f64,
) {
    ctx.emit(
        json!({
            "status": "repacked",
            "repoId": handle.id(),
            "newPackHash": hex::encode(report.new_pack_hash),
            "newManifestId": report.new_manifest_id,
            "locatorManifestId": report.locator_manifest_id,
            "newPackBytes": report.new_pack_bytes,
            "objectCount": report.object_count,
            "newUris": report.new_uris,
            "supersededCount": report.superseded_count,
            "supersededBytes": report.superseded_bytes,
            "unnamedLivePacks": report.remaining,
            "deletedDocuments": 0,
            "cost": crate::fmt::cost_json(report.cost_credits, price),
        }),
        || {
            println!(
                "Repacked {} → 1 consolidated pack ({} objects, {} bytes).",
                handle.display(),
                report.object_count,
                report.new_pack_bytes
            );
            println!("  new pack:        {}", hex::encode(report.new_pack_hash));
            println!(
                "  supersedes:      {} pack(s), {} bytes (kept; nothing deleted)",
                report.superseded_count, report.superseded_bytes
            );
            if report.remaining > 0 {
                println!(
                    "  not named:       {} older pack(s): a manifest names at most {} packs, so \
                     they stay live and keep the copies they have (the new pack holds their \
                     objects too)",
                    report.remaining,
                    forge_core::repo::MAX_SUPERSEDES
                );
            }
            // The locator is what makes the repo browsable without downloading every pack,
            // so say plainly whether it landed rather than leaving it to be inferred.
            match &report.locator_manifest_id {
                Some(id) => println!("  browse index:    published ({id})"),
                None => println!(
                    "  browse index:    NOT published — browsing falls back to downloading \
                     every pack; re-run repack to retry"
                ),
            }
            println!(
                "  cost:            {}",
                cost_line(report.cost_credits, price)
            );
        },
    );
}

/// `dg reseed <repo> [--to ipfs|s3|https]` — re-upload packs to another backend and
/// announce the new availability URIs. Availability-only; anyone with a clone can reseed.
pub async fn reseed(
    ctx: &Ctx,
    repo: Option<&str>,
    to: Option<Backend>,
    profile: Option<&str>,
) -> Result<()> {
    let repo = repo.context("`dg reseed` needs a repository: dg reseed <owner>/<name>")?;
    let repo_ref = RepoRef::parse(repo)?;
    if let Some(name) = profile {
        refuse_unpublishable_profile(name, "nothing reseeded")?;
    }
    let (client, bridge, identity) = ctx.connect_with_identity().await?;
    let handle = resolve(&client, &identity, &repo_ref).await?;
    let svc = RepoService::new(&client, &identity, &bridge);

    if profile.is_none() {
        if let Some(uri) = legacy_backend_uri(to) {
            refuse_unpublishable_url(&uri, "nothing reseeded")?;
        }
    }
    let backend = match profile {
        Some(name) => profile_backend(name)?,
        None => build_external_backend(to)?.ok_or_else(|| {
            crate::errors::usage(
                "`dg reseed` needs a target: --profile <name> (or legacy --to ipfs|s3)",
            )
        })?,
    };
    let target_label = profile.unwrap_or_else(|| to.map_or("external", Backend::label));

    if !ctx.confirm(&format!(
        "Reseed {} packs to {target_label}? (re-uploads pack bytes for availability)",
        handle.display()
    ))? {
        return Err(crate::errors::cancelled());
    }

    let report = svc
        .reseed(&handle, backend.as_ref())
        .await
        .context("reseed failed")?;

    let reseeded_json: Vec<_> = report
        .reseeded
        .iter()
        .map(|r| {
            json!({
                "packHash": hex::encode(r.pack_hash),
                "uris": r.uris,
                "announced": r.announced,
            })
        })
        .collect();
    ctx.emit(
        json!({
            "status": "reseeded",
            "repoId": handle.id(),
            "target": target_label,
            "packs": reseeded_json,
            "unreadable": report.unreadable.iter().map(hex::encode).collect::<Vec<_>>(),
        }),
        || {
            println!(
                "Reseeded {} pack(s) of {} to {target_label}.",
                report.reseeded.len(),
                handle.display()
            );
            for h in &report.unreadable {
                println!(
                    "  {} — no readable copy; skipped (try `dg reseed --from-local`)",
                    hex::encode(h)
                );
            }
            for r in &report.reseeded {
                let note = if r.announced {
                    "recorded as your copy"
                } else {
                    "uploaded (you already hold a manifest for this pack)"
                };
                println!("  {} — {note}", hex::encode(r.pack_hash));
                for u in &r.uris {
                    println!("      {u}");
                }
            }
        },
    );
    Ok(())
}

/// `dg reseed --from-local [GIT_DIR]` — restore lost pack copies from this clone.
///
/// Targets: `--profile <name>`, else the external targets of this repo's storage policy
/// (`dash.storage` / `dash.replicas`, the same config `git push` uses). Re-uploading
/// through the profile a pack was pushed with recreates the exact URI its manifest
/// records (keys are content-addressed), which is what makes the pack readable again.
pub async fn reseed_from_local(
    ctx: &Ctx,
    repo: Option<&str>,
    git_dir: &std::path::Path,
    profile: Option<&str>,
    pack: Option<&str>,
    force: bool,
) -> Result<()> {
    let repo = repo.context("`dg reseed` needs a repository: dg reseed <owner>/<name>")?;
    let repo_ref = RepoRef::parse(repo)?;
    let git_dir =
        std::fs::canonicalize(git_dir).with_context(|| format!("git dir {}", git_dir.display()))?;
    let only = pack
        .map(|h| -> Result<[u8; 32]> {
            let raw = hex::decode(h).context("--pack must be a hex SHA-256")?;
            raw.try_into()
                .map_err(|_| crate::errors::usage("--pack must be 32 bytes (64 hex chars)"))
        })
        .transpose()?;

    let (targets, required, label) = reseed_targets(profile)?;

    let (client, bridge, identity) = ctx.connect_with_identity().await?;
    let handle = resolve(&client, &identity, &repo_ref).await?;
    let svc = RepoService::new(&client, &identity, &bridge);
    if !ctx.confirm(&format!(
        "Restore unreadable packs of {} from {} to {label}? (uploads to your storage; no \
         Platform spend)",
        handle.display(),
        git_dir.display()
    ))? {
        return Err(crate::errors::cancelled());
    }
    let refs: Vec<&dyn StorageTarget> = targets.iter().map(|t| t as &dyn StorageTarget).collect();
    let report = svc
        .reseed_from_local(&handle, &git_dir, &refs, required, only, force)
        .await
        .context("reseed from local failed")?;

    emit_local_reseed(ctx, &handle, &git_dir, &label, &report);
    if !report.missing.is_empty() {
        bail!(
            "{} pack(s) could not be restored from this clone",
            report.missing.len()
        );
    }
    Ok(())
}

/// `dg reseed --from-local` targets: the named profile, or this repo's storage policy's
/// external targets. Returns `(targets, required confirmations, label)`.
fn reseed_targets(profile: Option<&str>) -> Result<(Vec<ExternalTarget>, usize, String)> {
    if let Some(name) = profile {
        return Ok((vec![external_profile_target(name)?], 1, name.to_string()));
    }
    let storage = git_config_scoped("dash.storage").map(|(_, v)| v);
    let replicas = git_config_scoped("dash.replicas").map(|(_, v)| v);
    let resolved = forge_core::storage::StoragePolicy::from_git_values(
        storage.as_deref(),
        replicas.as_deref(),
        None,
    )?
    .resolve(&StorageProfiles::load()?)?;
    if resolved.external.is_empty() {
        return Err(crate::errors::usage(
            "this repo's storage policy has no external target to restore to; pass --profile \
             <name> (the profile the pack was pushed with restores its recorded URI)",
        ));
    }
    let http = forge_core::storage::http_client();
    let targets = resolved
        .external
        .iter()
        .map(|(n, p)| ExternalTarget::from_profile(n, p, &http).map_err(anyhow::Error::from))
        .collect::<Result<Vec<_>>>()?;
    let required = resolved.replicas.min(targets.len()).max(1);
    let label = resolved
        .external
        .iter()
        .map(|(n, _)| n.as_str())
        .collect::<Vec<_>>()
        .join(", ");
    Ok((targets, required, label))
}

/// Print (or `--json`-emit) a finished `dg reseed --from-local`.
fn emit_local_reseed(
    ctx: &Ctx,
    handle: &forge_core::scope::RepoRef,
    git_dir: &std::path::Path,
    label: &str,
    report: &forge_core::repo::LocalReseedReport,
) {
    let restored_json: Vec<_> = report
        .restored
        .iter()
        .map(|r| {
            json!({
                "packHash": hex::encode(r.pack_hash),
                "uris": r.uris,
                "restoredRecordedUri": r.restored_recorded_uri,
            })
        })
        .collect();
    let missing: Vec<String> = report.missing.iter().map(hex::encode).collect();
    ctx.emit(
        json!({
            "status": if missing.is_empty() { "reseeded" } else { "partial" },
            "repoId": handle.id(),
            "targets": label,
            "restored": restored_json,
            "healthy": report.healthy.len(),
            "missingLocally": missing,
        }),
        || {
            println!(
                "Restored {} pack(s) of {} from {} to {label} ({} still healthy).",
                report.restored.len(),
                handle.display(),
                git_dir.display(),
                report.healthy.len()
            );
            for r in &report.restored {
                let state = if r.restored_recorded_uri {
                    "its recorded copy is readable again"
                } else {
                    "stored at NEW locations only — run `dg reseed --profile <p>` to record them"
                };
                println!("  {} — {state}", hex::encode(r.pack_hash));
                for u in &r.uris {
                    println!("      {u}");
                }
            }
            let hint = if handle.visibility == forge_core::rules::v2::Visibility::Private {
                "a private repo's stored packs are sealed: only the clone that pushed it keeps them; re-push from a clone with the objects instead"
            } else {
                "try a clone that fetched it"
            };
            for h in &missing {
                println!("  {h} — no local copy in this clone ({hint})");
            }
        },
    );
}

/// Load the named EXTERNAL profile from storage.toml.
fn load_external_profile(name: &str) -> Result<forge_core::storage::Profile> {
    let profiles = StorageProfiles::load()?;
    let profile = profiles
        .get(name)
        .with_context(|| format!("no storage profile {name:?} (see `dg storage list`)"))?;
    if profile.is_platform() {
        return Err(crate::errors::usage(format!(
            "profile {name:?} is Platform storage; omit --profile to use the platform tier"
        )));
    }
    Ok(profile)
}

/// The names of a `--profile a,b` list: none empty, none twice.
fn profile_list(list: &str) -> Result<Vec<&str>> {
    let names: Vec<&str> = list.split(',').map(str::trim).collect();
    if names.iter().any(|n| n.is_empty()) {
        return Err(crate::errors::usage(format!(
            "--profile {list:?} has an empty name; list profiles as a,b"
        )));
    }
    if let Some(dup) = names
        .iter()
        .enumerate()
        .find(|(i, n)| names[..*i].contains(n))
    {
        return Err(crate::errors::usage(format!(
            "--profile lists {:?} twice",
            dup.1
        )));
    }
    Ok(names)
}

/// Split a profile list into its external profiles and the Platform one (the built-in
/// `platform`, or a `kind = "platform"` profile), which may appear at most once.
fn split_platform<'a>(names: &[&'a str]) -> Result<(Vec<&'a str>, Option<&'a str>)> {
    let profiles = StorageProfiles::load()?;
    let mut external = Vec::new();
    let mut platform = None;
    for name in names {
        let is_platform = profiles.get(name).is_some_and(|p| p.is_platform());
        match (is_platform, platform) {
            (true, Some(_)) => {
                return Err(crate::errors::usage(
                    "--profile lists Platform storage twice (under two names)",
                ))
            }
            (true, None) => platform = Some(*name),
            (false, _) => external.push(*name),
        }
    }
    Ok((external, platform))
}

/// The public read base a legacy `--backend s3` / `--to s3` target records
/// (`FORGE_S3_ENDPOINT/FORGE_S3_BUCKET`); `None` for the other legacy targets, which record
/// no http(s) URL of their own.
fn legacy_backend_uri(backend: Option<Backend>) -> Option<String> {
    if !matches!(backend, Some(Backend::S3)) {
        return None;
    }
    // Unset: `build_external_backend` reports what is missing.
    let endpoint = std::env::var("FORGE_S3_ENDPOINT").ok()?;
    let bucket = std::env::var("FORGE_S3_BUCKET").unwrap_or_else(|_| "forge-packs".into());
    Some(format!("{}/{bucket}", endpoint.trim_end_matches('/')))
}

/// Refuse (E501) to record `url` on chain when it is not a public https address, unless
/// git config `dash.allowPrivateUri` allows it (the legacy env-configured targets have no
/// profile to carry the flag).
fn refuse_unpublishable_url(url: &str, lead: &str) -> Result<()> {
    let allowed =
        crate::storage::allow_private_uri_config(crate::storage::dash_remote_name().as_deref())?;
    forge_core::storage::publish::refuse_unpublishable_url("FORGE_S3_ENDPOINT", url, allowed, lead)
        .map_err(Into::into)
}

/// Refuse before anything is written when the named profile would record a non-public
/// read address (see [`crate::storage::check_publishable`]).
fn refuse_unpublishable_profile(name: &str, lead: &str) -> Result<()> {
    let profile = load_external_profile(name)?;
    let remote = crate::storage::dash_remote_name();
    crate::storage::check_publishable([(name, &profile)], None, remote.as_deref(), lead)
}

/// A verified-upload target for the named external profile.
fn external_profile_target(name: &str) -> Result<ExternalTarget> {
    let profile = load_external_profile(name)?;
    Ok(ExternalTarget::from_profile(
        name,
        &profile,
        &forge_core::storage::http_client(),
    )?)
}

/// The raw backend for the named external profile (reseed re-verifies by hash itself).
fn profile_backend(name: &str) -> Result<Box<dyn PackBackend>> {
    load_external_profile(name)?
        .build_backend(&forge_core::storage::http_client())?
        .with_context(|| format!("profile {name:?} has no external backend"))
}

/// Build the external backend selected by `--to` / `--backend`, or `None` for the platform
/// tier. `platform`/`mixed` map to `None` (repack consolidates on-chain by default).
///
/// Legacy, environment-configured path kept for existing scripts; `--profile` is the
/// supported way to name a target (SigV4 credentials, verified uploads).
fn build_external_backend(backend: Option<Backend>) -> Result<Option<Box<dyn PackBackend>>> {
    Ok(match backend {
        None | Some(Backend::Platform | Backend::Mixed) => None,
        Some(Backend::Ipfs) => {
            let api = std::env::var("FORGE_IPFS_API").ok();
            let gateway = std::env::var("FORGE_IPFS_GATEWAY").unwrap_or_else(|_| {
                forge_core::storage::default_ipfs_gateways()
                    .into_iter()
                    .next()
                    .unwrap_or_default()
            });
            Some(Box::new(IpfsBackend::new(IpfsConfig {
                api,
                api_auth: None,
                gateway,
                pinning: None,
            })))
        }
        Some(Backend::S3) => {
            let endpoint = std::env::var("FORGE_S3_ENDPOINT")
                .context("--to s3 needs FORGE_S3_ENDPOINT (e.g. http://127.0.0.1:9000)")?;
            let bucket =
                std::env::var("FORGE_S3_BUCKET").unwrap_or_else(|_| "forge-packs".to_string());
            Some(Box::new(S3Backend::new(S3Config::public(endpoint, bucket))))
        }
        Some(Backend::Https) => {
            return Err(crate::errors::usage(
                "the https backend is read-only; reseed to s3/ipfs (or platform) instead",
            ))
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Review finding: a reindex onto the owner's storage pays no Platform chunks, only the
    /// manifest and its URIs; onto Platform it pays the index chunks (about 3.6 DASH for
    /// dashpay/dash's 268,015 objects), sealed a little more for a private repository.
    #[test]
    fn a_reindex_is_priced_for_where_the_index_goes() {
        use forge_core::cost::push_fees::{MANIFEST_FIRST, URIS_PER_TARGET};
        let byo = reindex_estimate(268_015, false, 2, false);
        assert_eq!(byo, MANIFEST_FIRST + 2 * URIS_PER_TARGET);
        let chain = reindex_estimate(268_015, false, 0, true);
        assert!(
            (350_000_000_000..380_000_000_000).contains(&chain),
            "{chain}"
        );
        assert!(reindex_estimate(268_015, true, 0, true) > chain);
    }

    #[test]
    fn profile_lists_refuse_empty_and_repeated_names() {
        assert_eq!(profile_list("a, b").unwrap(), ["a", "b"]);
        assert!(profile_list("").is_err());
        assert!(profile_list("a,,b").is_err());
        assert!(format!("{:#}", profile_list("a,b,a").unwrap_err()).contains("twice"));
    }

    /// With FORGE_S3_ENDPOINT unset there is no address to judge: the legacy target reports
    /// the missing variable itself, not E501.
    #[test]
    fn an_unset_legacy_endpoint_is_reported_as_missing() {
        if std::env::var_os("FORGE_S3_ENDPOINT").is_some() {
            return;
        }
        assert_eq!(legacy_backend_uri(Some(Backend::S3)), None);
        let err = build_external_backend(Some(Backend::S3))
            .err()
            .map(|e| format!("{e:#}"))
            .unwrap_or_default();
        assert!(err.contains("FORGE_S3_ENDPOINT"), "{err}");
        assert_eq!(legacy_backend_uri(Some(Backend::Ipfs)), None);
    }
}
