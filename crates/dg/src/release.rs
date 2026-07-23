//! `dg release` — create / list / download releases.

use std::path::PathBuf;

use anyhow::{bail, Context, Result};
use serde_json::json;

use forge_core::backends::ipfs::IpfsConfig;
use forge_core::backends::{BackendRegistry, HttpsBackend, IpfsBackend, Uri};
use forge_core::collab::{ReleaseInput, ReleaseService};

use crate::common::{resolve, RepoRef};
use crate::context::Ctx;
use crate::ReleaseCommand;

/// Dispatch a `release` subcommand.
pub async fn run(ctx: &Ctx, cmd: &ReleaseCommand) -> Result<()> {
    match cmd {
        ReleaseCommand::Create {
            repo,
            tag,
            name,
            notes,
            yanked,
        } => create(ctx, repo, tag, name, notes, *yanked).await,
        ReleaseCommand::List { repo } => list(ctx, repo).await,
        ReleaseCommand::Download {
            repo,
            tag,
            asset,
            output,
        } => download(ctx, repo, tag, asset.as_deref(), output.clone()).await,
    }
}

async fn create(
    ctx: &Ctx,
    repo: &str,
    tag: &str,
    name: &str,
    notes: &str,
    yanked: bool,
) -> Result<()> {
    let repo_ref = RepoRef::parse(repo)?;
    if !ctx.confirm(&format!("Create release {tag:?}? (a MAINTAIN-gated write)"))? {
        bail!("aborted");
    }
    let (client, bridge, identity) = ctx.connect_with_identity().await?;
    let handle = resolve(&client, &identity, &bridge, &repo_ref).await?;
    let svc = ReleaseService::new(&client, &identity, &bridge);
    let input = ReleaseInput {
        tag_name: tag.to_string(),
        name: name.to_string(),
        notes: notes.to_string(),
        yanked,
        assets: Vec::new(),
    };
    let doc_id = svc
        .create_release(&handle.repo_contract_id, &input)
        .await
        .context("create_release")?;

    ctx.emit(
        json!({ "status": "created", "tag": tag, "documentId": doc_id }),
        || println!("Created release {tag} (document {doc_id})."),
    );
    Ok(())
}

async fn list(ctx: &Ctx, repo: &str) -> Result<()> {
    let repo_ref = RepoRef::parse(repo)?;
    let (client, bridge, identity) = ctx.connect_with_identity().await?;
    let handle = resolve(&client, &identity, &bridge, &repo_ref).await?;
    let svc = ReleaseService::new(&client, &identity, &bridge);
    let releases = svc
        .list_releases(&handle.repo_contract_id)
        .await
        .context("list_releases")?;

    let rows: Vec<_> = releases
        .iter()
        .map(|r| {
            json!({
                "tag": r.tag_name,
                "name": r.name,
                "yanked": r.yanked,
                "assets": r.assets.iter().map(|a| json!({
                    "name": a.name,
                    "sha256": a.sha256,
                    "sizeBytes": a.size_bytes,
                    "uris": a.uris,
                })).collect::<Vec<_>>(),
            })
        })
        .collect();

    ctx.emit(json!({ "count": rows.len(), "releases": rows }), || {
        for r in &releases {
            let y = if r.yanked { " (yanked)" } else { "" };
            println!("{}{y}  {} asset(s)", r.tag_name, r.assets.len());
        }
    });
    Ok(())
}

/// Download a release asset via the reader-side backend registry (https + ipfs gateways),
/// verifying the recorded SHA-256 before writing it out.
async fn download(
    ctx: &Ctx,
    repo: &str,
    tag: &str,
    asset_name: Option<&str>,
    output: Option<PathBuf>,
) -> Result<()> {
    let repo_ref = RepoRef::parse(repo)?;
    let (client, bridge, identity) = ctx.connect_with_identity().await?;
    let handle = resolve(&client, &identity, &bridge, &repo_ref).await?;
    let svc = ReleaseService::new(&client, &identity, &bridge);
    let releases = svc.list_releases(&handle.repo_contract_id).await?;
    let release = releases
        .into_iter()
        .find(|r| r.tag_name == tag)
        .ok_or_else(|| anyhow::anyhow!("release {tag:?} not found"))?;

    let asset = match asset_name {
        Some(n) => release.assets.into_iter().find(|a| a.name == n),
        None => release.assets.into_iter().next(),
    }
    .ok_or_else(|| anyhow::anyhow!("no matching asset in release {tag:?}"))?;

    if asset.uris.is_empty() {
        bail!(
            "asset {:?} records no mirror URIs to download from",
            asset.name
        );
    }

    let mut registry = BackendRegistry::new();
    registry.register(Box::new(HttpsBackend::new()));
    registry.register(Box::new(IpfsBackend::new(IpfsConfig {
        api: None,
        gateway: "https://ipfs.io".to_string(),
    })));

    let uris: Vec<Uri> = asset.uris.iter().map(|u| Uri(u.clone())).collect();
    let bytes = registry
        .get_verified(&uris, &asset.sha256)
        .await
        .context("downloading + verifying asset")?;

    let out_path = output.unwrap_or_else(|| PathBuf::from(&asset.name));
    std::fs::write(&out_path, &bytes).with_context(|| format!("writing {}", out_path.display()))?;

    ctx.emit(
        json!({
            "status": "downloaded",
            "tag": tag,
            "asset": asset.name,
            "sha256": asset.sha256,
            "bytes": bytes.len(),
            "output": out_path.to_string_lossy(),
        }),
        || {
            println!(
                "Downloaded {} ({} bytes, sha256 verified) → {}",
                asset.name,
                bytes.len(),
                out_path.display()
            );
        },
    );
    Ok(())
}
