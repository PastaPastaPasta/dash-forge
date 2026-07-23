//! `dg repack` / `dg reseed` / `dg import` — maintenance commands.
//!
//! - `repack` consolidates a repo's live packs into one optimized pack, publishes it, and
//!   deletes the caller's own now-superseded storage → an on-chain refund
//!   (`forge_core::repo::RepoService::repack`).
//! - `reseed` re-uploads pack bytes to another backend for availability, announcing the
//!   new URIs via `packMirror` docs when the contract template carries them.
//! - `import` remains a thin, not-yet-wired wrapper over `forge-import` (PRD 06).

use anyhow::{bail, Context, Result};
use serde_json::json;

use forge_core::backends::ipfs::IpfsConfig;
use forge_core::backends::{IpfsBackend, PackBackend, S3Backend, S3Config};
use forge_core::repo::{RepackTarget, RepoService};

use crate::common::{resolve, RepoRef};
use crate::context::Ctx;
use crate::fmt::{cost_line, dash_usd_price, refund_line};
use crate::Backend;

/// `dg repack <repo> [--backend]` — consolidate + reclaim storage (delete superseded docs
/// → refund). Shows an estimated refund, prompts unless `--yes`, then reports the measured
/// upload cost, observed refund, and net.
pub async fn repack(ctx: &Ctx, repo: Option<&str>, backend: Option<Backend>) -> Result<()> {
    let repo = repo.context("`dg repack` needs a repository: dg repack <owner>/<name>")?;
    let repo_ref = RepoRef::parse(repo)?;
    let (client, bridge, identity) = ctx.connect_with_identity().await?;
    let handle = resolve(&client, &identity, &bridge, &repo_ref).await?;
    let svc = RepoService::new(&client, &identity, &bridge);
    let price = dash_usd_price();

    // Pre-flight: show what will be consolidated + a rough refund estimate (superseded
    // bytes × the per-byte storage deposit) so the operator can weigh it before signing.
    let manifests = svc.read_pack_manifests(&handle).await.unwrap_or_default();
    let kind0: Vec<_> = manifests.iter().filter(|m| m.kind == 0).collect();
    let owned_bytes: u64 = kind0
        .iter()
        .filter(|m| m.owner_id == identity.id())
        .map(|m| m.size_bytes)
        .sum();
    let est_refund = forge_core::cost::prompt_delete_refund(owned_bytes);

    if !ctx.json {
        println!(
            "Repack {}/{}: {} live pack(s), {owned_bytes} caller-owned bytes",
            handle.owner_id,
            handle.normalized_name,
            kind0.len()
        );
        println!(
            "  estimated storage refund from deleting superseded packs: {}",
            refund_line(est_refund, price)
        );
        println!("  (repack re-uploads one consolidated pack first — availability never dips)");
    }
    if !ctx.confirm(&format!(
        "Repack {}/{}? Consolidates packs, then deletes superseded storage (est. {})",
        handle.owner_id,
        handle.normalized_name,
        refund_line(est_refund, price)
    ))? {
        bail!("aborted");
    }

    // The consolidated pack's destination. Platform (default) is the tier the refund
    // reclaims from; an external backend migrates cold history outward (mixed mode).
    let external = build_external_backend(backend)?;
    let target = match &external {
        Some(b) => RepackTarget::External(b.as_ref()),
        None => RepackTarget::Platform,
    };

    let report = svc.repack(&handle, target).await.context("repack failed")?;

    ctx.emit(
        json!({
            "status": "repacked",
            "repoContractId": handle.repo_contract_id,
            "newPackHash": hex::encode(report.new_pack_hash),
            "newManifestId": report.new_manifest_id,
            "newPackBytes": report.new_pack_bytes,
            "objectCount": report.object_count,
            "newUris": report.new_uris,
            "supersededCount": report.superseded_count,
            "bytesReclaimed": report.bytes_reclaimed,
            "deletedChunks": report.deleted_chunks,
            "deletedManifests": report.deleted_manifests,
            "uploadCost": cost_json_credits(report.upload_cost_credits, price),
            "refund": cost_json_credits(report.refund_credits, price),
            "netCredits": report.net_credits,
            "netDash": net_credits_to_dash(report.net_credits),
        }),
        || {
            println!(
                "Repacked {}/{} → 1 consolidated pack ({} objects, {} bytes).",
                handle.owner_id, handle.normalized_name, report.object_count, report.new_pack_bytes
            );
            println!("  new pack:        {}", hex::encode(report.new_pack_hash));
            println!("  superseded:      {} pack(s)", report.superseded_count);
            println!(
                "  deleted:         {} chunk(s), {} manifest(s) ({} bytes reclaimed)",
                report.deleted_chunks, report.deleted_manifests, report.bytes_reclaimed
            );
            println!(
                "  upload cost:     {}",
                cost_line(report.upload_cost_credits, price)
            );
            println!(
                "  observed refund: {}",
                refund_line(report.refund_credits, price)
            );
            let net = report.net_credits;
            let net_dash = net_credits_to_dash(net);
            if net >= 0 {
                println!("  net:             +{net_dash:.8} DASH reclaimed");
            } else {
                println!("  net:             {net_dash:.8} DASH (consolidation spend)");
            }
        },
    );
    Ok(())
}

/// `dg reseed <repo> [--to ipfs|s3|https]` — re-upload packs to another backend and
/// announce the new availability URIs. Availability-only; anyone with a clone can reseed.
pub async fn reseed(ctx: &Ctx, repo: Option<&str>, to: Option<Backend>) -> Result<()> {
    let repo = repo.context("`dg reseed` needs a repository: dg reseed <owner>/<name>")?;
    let repo_ref = RepoRef::parse(repo)?;
    let (client, bridge, identity) = ctx.connect_with_identity().await?;
    let handle = resolve(&client, &identity, &bridge, &repo_ref).await?;
    let svc = RepoService::new(&client, &identity, &bridge);

    let backend = build_external_backend(to)?
        .ok_or_else(|| anyhow::anyhow!("`dg reseed` needs a target backend: --to ipfs|s3|https"))?;
    let target_label = to.map_or("external", Backend::label);

    if !ctx.confirm(&format!(
        "Reseed {}/{} packs to {target_label}? (re-uploads pack bytes for availability)",
        handle.owner_id, handle.normalized_name
    ))? {
        bail!("aborted");
    }

    let report = svc
        .reseed(&handle, backend.as_ref())
        .await
        .context("reseed failed")?;

    let reseeded_json: Vec<_> = report
        .reseeded
        .iter()
        .map(|(hash, uris)| json!({ "packHash": hex::encode(hash), "uris": uris }))
        .collect();

    ctx.emit(
        json!({
            "status": "reseeded",
            "repoContractId": handle.repo_contract_id,
            "target": target_label,
            "packs": reseeded_json,
            "announcedOnChain": report.announced_on_chain,
            "packMirrorDocsWritten": report.mirror_docs_written,
            "note": if report.announced_on_chain {
                "new URIs announced on-chain via packMirror docs"
            } else {
                "packMirror type absent on this contract (v1 template) — URIs returned but \
                 not announced on-chain; packMirror is the template-v2 addition that closes this"
            },
        }),
        || {
            println!(
                "Reseeded {} pack(s) of {}/{} to {target_label}.",
                report.reseeded.len(),
                handle.owner_id,
                handle.normalized_name
            );
            for (hash, uris) in &report.reseeded {
                println!("  {} →", hex::encode(hash));
                for u in uris {
                    println!("      {u}");
                }
            }
            if report.announced_on_chain {
                println!(
                    "  announced on-chain: {} packMirror doc(s).",
                    report.mirror_docs_written
                );
            } else {
                println!(
                    "  note: this contract has no packMirror type (v1 template); the URIs \
                     above are not announced on-chain. packMirror is a template-v2 addition."
                );
            }
        },
    );
    Ok(())
}

/// Build the external backend selected by `--to` / `--backend`, or `None` for the platform
/// tier. `platform`/`mixed` map to `None` (repack consolidates on-chain by default).
fn build_external_backend(backend: Option<Backend>) -> Result<Option<Box<dyn PackBackend>>> {
    Ok(match backend {
        None | Some(Backend::Platform | Backend::Mixed) => None,
        Some(Backend::Ipfs) => {
            let api = std::env::var("FORGE_IPFS_API").ok();
            let gateway = std::env::var("FORGE_IPFS_GATEWAY")
                .unwrap_or_else(|_| "https://ipfs.io".to_string());
            Some(Box::new(IpfsBackend::new(IpfsConfig { api, gateway })))
        }
        Some(Backend::S3) => {
            let endpoint = std::env::var("FORGE_S3_ENDPOINT")
                .context("--to s3 needs FORGE_S3_ENDPOINT (e.g. http://127.0.0.1:9000)")?;
            let bucket =
                std::env::var("FORGE_S3_BUCKET").unwrap_or_else(|_| "forge-packs".to_string());
            Some(Box::new(S3Backend::new(S3Config::public(endpoint, bucket))))
        }
        Some(Backend::Https) => {
            bail!("the https backend is read-only; reseed to s3/ipfs (or platform) instead")
        }
    })
}

/// A `--json` cost block (credits → dash/usd), local alias avoiding a fmt import churn.
fn cost_json_credits(credits: u64, price_usd: f64) -> serde_json::Value {
    crate::fmt::cost_json(credits, price_usd)
}

/// Convert a signed net-credit delta to DASH for display (1 DASH = 1e11 credits). The
/// magnitudes here (a repo's storage) sit far inside f64's exact-integer range.
#[allow(clippy::cast_precision_loss)]
fn net_credits_to_dash(net: i128) -> f64 {
    net as f64 / 1e11
}

/// `dg import <github-url>` — thin wrapper over `forge-import` (PRD 06), not yet wired.
#[allow(clippy::unnecessary_wraps)]
pub fn import(ctx: &Ctx, url: &str) -> Result<()> {
    ctx.emit(
        json!({
            "status": "not_implemented",
            "command": "import",
            "url": url,
            "todo": "delegate to the forge-import crate (Forgejo-semantics mapping, PRD 06); the importer is not yet exposed as a callable entry point",
        }),
        || {
            eprintln!("dg import: not yet wired");
            eprintln!("  TODO: delegate {url} to forge-import (PRD 06).");
        },
    );
    Ok(())
}
