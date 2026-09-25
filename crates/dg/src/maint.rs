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
use forge_core::repo::{RepackTarget, RepoService};
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
    let (client, bridge, identity) = ctx.connect_with_identity().await?;
    let handle = resolve(&client, &identity, &repo_ref).await?;
    handle.require_v2()?;
    let svc = RepoService::new(&client, &identity, &bridge);
    let price = dash_usd_price();

    let manifests = svc.read_pack_manifests(&handle).await.unwrap_or_default();
    let space = forge_core::repo::locator_pack_space(&manifests, None);
    let live_bytes: u64 = space.iter().map(|m| m.size_bytes).sum();
    if !ctx.json {
        println!(
            "Repack {}: {} live pack(s), {live_bytes} bytes",
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

    // The consolidated pack's destination: Platform (default), an external profile
    // (verified upload), or a legacy env-configured backend (migrates cold history out).
    let profile_target = profile.map(external_profile_target).transpose()?;
    let external = if profile_target.is_some() {
        None
    } else {
        build_external_backend(backend)?
    };
    let profile_targets: Vec<&dyn StorageTarget> = profile_target
        .iter()
        .map(|t| t as &dyn StorageTarget)
        .collect();
    let target = match (&profile_target, &external) {
        (Some(_), _) => RepackTarget::Replicated {
            targets: &profile_targets,
            required: 1,
        },
        (None, Some(b)) => RepackTarget::External(b.as_ref()),
        (None, None) => RepackTarget::Platform,
    };

    let report = svc.repack(&handle, target).await.context("repack failed")?;
    emit_repack_report(ctx, &handle, &report, price);
    Ok(())
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
    let (client, bridge, identity) = ctx.connect_with_identity().await?;
    let handle = resolve(&client, &identity, &repo_ref).await?;
    let svc = RepoService::new(&client, &identity, &bridge);

    let backend = match profile {
        Some(name) => profile_backend(name)?,
        None => build_external_backend(to)?.ok_or_else(|| {
            crate::errors::usage(
                "`dg reseed` needs a target: --profile <name> (or legacy --to ipfs|s3)",
            )
        })?,
    };
    let target_label = profile.unwrap_or_else(|| to.map_or("external", Backend::label));

    handle.require_v2()?;
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
        }),
        || {
            println!(
                "Reseeded {} pack(s) of {} to {target_label}.",
                report.reseeded.len(),
                handle.display()
            );
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
            for h in &missing {
                println!("  {h} — no local copy in this clone (try a clone that fetched it)");
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

/// `dg import <github-url>` — thin wrapper over `forge-import` (PRD 06), not yet wired.
///
/// Fails (E103) rather than exiting 0, so `dg import X && …` does not proceed as if a
/// repository had been imported.
#[allow(clippy::unnecessary_wraps)]
pub fn import(_ctx: &Ctx, url: &str) -> Result<()> {
    Err(crate::errors::reported(
        forge_core::user_error::UserError::new(
            forge_core::user_error::codes::NOT_IMPLEMENTED,
            "dg import is not wired yet",
        )
        .cause(format!("{url} would be delegated to forge-import (PRD 06), which has no callable entry point yet"))
        .fix("run the forge-import binary directly (`cargo run -p forge-import -- --help`)"),
        json!({
            "status": "not_implemented",
            "command": "import",
            "url": url,
            "todo": "delegate to the forge-import crate (Forgejo-semantics mapping, PRD 06); the importer is not yet exposed as a callable entry point",
        }),
    ))
}
