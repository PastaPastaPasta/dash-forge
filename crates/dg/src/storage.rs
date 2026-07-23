//! `dg storage status` — per-URI availability matrix for a repo's packs.

use anyhow::Result;
use serde_json::json;

use forge_core::backends::ipfs::IpfsConfig;
use forge_core::backends::{BackendRegistry, HttpsBackend, IpfsBackend, Uri};

use crate::common::{resolve, RepoRef};
use crate::context::Ctx;
use crate::StorageCommand;

/// Dispatch a `storage` subcommand.
pub async fn run(ctx: &Ctx, cmd: &StorageCommand) -> Result<()> {
    match cmd {
        StorageCommand::Status { repo } => status(ctx, repo).await,
    }
}

/// Probe each pack's mirror URIs and report an availability matrix. Platform-tier packs
/// (on-chain `chunk` docs) are reported as on-chain; external mirrors (https/ipfs) are
/// probed live via the reader-side registry.
async fn status(ctx: &Ctx, repo: &str) -> Result<()> {
    let repo_ref = RepoRef::parse(repo)?;
    let (client, bridge, identity) = ctx.connect_with_identity().await?;
    let handle = resolve(&client, &identity, &bridge, &repo_ref).await?;
    let svc = forge_core::repo::RepoService::new(&client, &identity, &bridge);
    let manifests = svc.read_pack_manifests(&handle).await.unwrap_or_default();

    let mut registry = BackendRegistry::new();
    registry.register(Box::new(HttpsBackend::new()));
    registry.register(Box::new(IpfsBackend::new(IpfsConfig {
        api: None,
        gateway: "https://ipfs.io".to_string(),
    })));

    let mut packs = Vec::new();
    for m in &manifests {
        let pack_hex = hex::encode(m.pack_hash);
        let external: Vec<Uri> = m.uris.iter().map(|u| Uri(u.clone())).collect();
        let probed = registry.probe_all(&external).await;

        let mut mirrors = Vec::new();
        // Platform tier (storage == 0) means the bytes are on-chain chunk docs.
        if m.storage == 0 || m.uris.is_empty() {
            mirrors.push(json!({
                "uri": format!("platform://{}/{pack_hex}", handle.repo_contract_id),
                "scheme": "platform",
                "ok": m.chunk_count > 0,
                "detail": "on-chain chunk documents",
            }));
        }
        for (uri, health) in &probed {
            mirrors.push(json!({
                "uri": uri.0,
                "scheme": uri.scheme(),
                "ok": health.ok,
                "sizeBytes": health.size,
                "latencyMs": u64::try_from(health.latency.as_millis()).unwrap_or(u64::MAX),
            }));
        }

        packs.push(json!({
            "packHash": pack_hex,
            "sizeBytes": m.size_bytes,
            "chunkCount": m.chunk_count,
            "storageTier": if m.storage == 0 { "platform" } else { "external" },
            "mirrors": mirrors,
        }));
    }

    ctx.emit(
        json!({
            "repoContractId": handle.repo_contract_id,
            "packCount": manifests.len(),
            "packs": packs,
        }),
        || {
            println!(
                "Storage status for {}/{}:",
                handle.owner_id, handle.normalized_name
            );
            if manifests.is_empty() {
                println!("  (no packs)");
            }
            for p in &packs {
                let hash = p["packHash"].as_str().unwrap_or("");
                println!(
                    "  pack {}  ({} bytes)",
                    &hash[..hash.len().min(12)],
                    p["sizeBytes"]
                );
                if let Some(mirrors) = p["mirrors"].as_array() {
                    for m in mirrors {
                        let ok = m["ok"].as_bool().unwrap_or(false);
                        let mark = if ok { "OK " } else { "DOWN" };
                        println!("    [{mark}] {}", m["uri"].as_str().unwrap_or(""));
                    }
                }
            }
        },
    );
    Ok(())
}
