//! `dg release` — create / list / download releases.
//!
//! On forge-v2 a `release` is a maintainer-only forge-core document, newest per tag wins.
//! `create --asset <file>` uploads each file to the repository's storage policy (the same
//! `dash.storage` / `dash.replicas` profiles a `git push` uses, or `--storage`), verifies the
//! copies, and records `{name, sha256, sizeBytes, uris}`; `download` accepts only bytes that
//! hash to the recorded sha256. Assets are external-only: Platform stores packs, not
//! arbitrary files, so a Platform-only policy is refused with the fix.

use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use serde_json::json;

use forge_core::backends::PackMeta;
use forge_core::collab::v2::Collab;
use forge_core::collab::{Release, ReleaseAsset, ReleaseInput, ReleaseService};
use forge_core::storage::policy::git_config_scoped;
use forge_core::storage::{
    replicate, ExternalTarget, PackReader, StoragePolicy, StorageProfiles, StorageTarget,
};
use forge_core::user_error::{codes, UserError};

use crate::common::{resolve, RepoRef};
use crate::context::Ctx;
use crate::ReleaseCommand;

/// URIs an asset records (the contract's whole `assets` JSON is 4096 bytes).
const MAX_ASSET_URIS: usize = 4;

/// Dispatch a `release` subcommand.
pub async fn run(ctx: &Ctx, cmd: &ReleaseCommand) -> Result<()> {
    match cmd {
        ReleaseCommand::Create {
            repo,
            tag,
            name,
            notes,
            yanked,
            assets,
            storage,
        } => {
            create(
                ctx,
                repo,
                tag,
                name,
                notes,
                *yanked,
                assets,
                storage.as_deref(),
            )
            .await
        }
        ReleaseCommand::List { repo } => list(ctx, repo).await,
        ReleaseCommand::Download {
            repo,
            tag,
            asset,
            output,
        } => download(ctx, repo, tag, asset.as_deref(), output.clone()).await,
    }
}

/// The external targets assets go to, and how many must confirm.
fn asset_targets(storage: Option<&str>) -> Result<(Vec<ExternalTarget>, usize)> {
    let (list, replicas) = match storage {
        Some(s) => (Some(s.to_string()), None),
        None => (
            git_config_scoped("dash.storage").map(|(_, v)| v),
            git_config_scoped("dash.replicas").map(|(_, v)| v),
        ),
    };
    let policy = StoragePolicy::from_git_values(list.as_deref(), replicas.as_deref(), None)?
        .resolve(&StorageProfiles::load()?)?;
    if policy.external.is_empty() {
        return Err(UserError::new(
            codes::STORAGE_CONFIG,
            "release not created: no storage for the assets",
        )
        .cause("release assets are stored on your own storage (S3, IPFS), and this repository's policy is Platform only")
        .fix("`dg storage add <name> …` then pass `--storage <name>` (or `dg storage use <name>` in the repository)")
        .note("nothing was uploaded or written")
        .into());
    }
    let http = forge_core::storage::http_client();
    let targets = policy
        .external
        .iter()
        .map(|(n, p)| ExternalTarget::from_profile(n, p, &http).map_err(anyhow::Error::from))
        .collect::<Result<Vec<_>>>()?;
    let required = policy.replicas.min(targets.len()).max(1);
    Ok((targets, required))
}

/// Upload one asset file and describe it.
async fn upload_asset(
    path: &Path,
    targets: &[ExternalTarget],
    required: usize,
) -> Result<ReleaseAsset> {
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .context("an asset path needs a file name")?
        .to_string();
    let bytes = std::fs::read(path).with_context(|| format!("reading {}", path.display()))?;
    let meta = PackMeta::for_bytes(&bytes);
    let dyn_targets: Vec<&dyn StorageTarget> =
        targets.iter().map(|t| t as &dyn StorageTarget).collect();
    let rep = replicate(&dyn_targets, &bytes, &meta, required)
        .await
        .map_err(|e| anyhow::Error::from(e).context(format!("uploading {name}")))?;
    let mut uris = rep.uris();
    // Credential-less readers use the public copies; drop private s3:// first.
    if uris.len() > MAX_ASSET_URIS {
        uris.retain(|u| !u.starts_with("s3://"));
    }
    uris.truncate(MAX_ASSET_URIS);
    Ok(ReleaseAsset {
        name,
        sha256: meta.pack_hash,
        size_bytes: bytes.len() as u64,
        uris,
    })
}

#[allow(clippy::too_many_arguments)]
async fn create(
    ctx: &Ctx,
    repo: &str,
    tag: &str,
    name: &str,
    notes: &str,
    yanked: bool,
    assets: &[PathBuf],
    storage: Option<&str>,
) -> Result<()> {
    let repo_ref = RepoRef::parse(repo)?;
    let (client, bridge, identity) = ctx.connect_with_identity().await?;
    let handle = resolve(&client, &identity, &repo_ref).await?;
    handle.require_v2()?;
    let collab = Collab::new(&client, &identity, &bridge);
    // Maintainer-only at consensus: find out before uploading anything.
    if collab.signer_role(&handle).await? != Some(forge_core::rules::v2::Role::Maintainer)
        && std::env::var(forge_core::collab::v2::SKIP_PRECHECK_ENV).is_err()
    {
        return Err(forge_core::Error::NotPermitted {
            action: format!("publish release {tag}"),
            reason: format!("releases of {} are maintainer-only", handle.display()),
            needs: "maintainer".into(),
        }
        .into());
    }
    let targets = if assets.is_empty() {
        None
    } else {
        Some(asset_targets(storage)?)
    };
    let total: u64 = assets
        .iter()
        .map(|p| std::fs::metadata(p).map(|m| m.len()))
        .collect::<std::io::Result<Vec<_>>>()
        .context("reading the asset files")?
        .iter()
        .sum();
    if !ctx.confirm(&format!(
        "Publish release {tag} of {}{}? (one small document, ~0.0002 DASH)",
        handle.display(),
        if assets.is_empty() {
            String::new()
        } else {
            format!(
                " with {} asset(s), {}",
                assets.len(),
                forge_core::storage::human_bytes(total)
            )
        }
    ))? {
        return Err(crate::errors::cancelled());
    }
    let mut uploaded = Vec::new();
    if let Some((targets, required)) = &targets {
        for p in assets {
            let a = upload_asset(p, targets, *required).await?;
            if !ctx.json {
                eprintln!(
                    "  ✓ {} ({}) sha256 {} → {} cop(ies)",
                    a.name,
                    forge_core::storage::human_bytes(a.size_bytes),
                    &a.sha256[..12],
                    a.uris.len()
                );
            }
            uploaded.push(a);
        }
    }
    let before = client.get_balance(&identity.id()).await.unwrap_or(0);
    let input = ReleaseInput {
        tag_name: tag.to_string(),
        name: name.to_string(),
        notes: notes.to_string(),
        yanked,
        assets: uploaded.clone(),
    };
    let doc_id = collab.create_release(&handle, &input).await.map_err(|e| {
        let note = if uploaded.is_empty() {
            "nothing was written".to_string()
        } else {
            "the assets were uploaded (content-addressed; re-running reuses them)".to_string()
        };
        anyhow::Error::from(e).context(note)
    })?;
    let spent = crate::issue::spent(&client, &identity.id(), before).await;
    ctx.emit(
        json!({
            "status": "created",
            "tag": tag,
            "documentId": doc_id,
            "assets": uploaded.iter().map(asset_json).collect::<Vec<_>>(),
            "cost": crate::fmt::cost_json(spent, crate::fmt::dash_usd_price()),
        }),
        || {
            println!(
                "✓ published release {tag} of {} ({} asset(s)) · {}",
                handle.display(),
                uploaded.len(),
                crate::fmt::cost_line(spent, crate::fmt::dash_usd_price())
            );
        },
    );
    Ok(())
}

fn asset_json(a: &ReleaseAsset) -> serde_json::Value {
    json!({ "name": a.name, "sha256": a.sha256, "sizeBytes": a.size_bytes, "uris": a.uris })
}

/// The releases of `repo` (newest per tag, newest first) and the superseded revisions.
async fn read_releases(ctx: &Ctx, repo: &str) -> Result<(Vec<Release>, Vec<Release>)> {
    let repo_ref = RepoRef::parse(repo)?;
    let (client, bridge, identity) = ctx.connect_with_identity().await?;
    let handle = resolve(&client, &identity, &repo_ref).await?;
    if handle.is_v1() {
        let r = ReleaseService::new(&client, &identity, &bridge)
            .list_releases(handle.v1_contract_id()?)
            .await
            .context("list_releases")?;
        return Ok((r, Vec::new()));
    }
    Ok(Collab::reader(&client).releases(&handle).await?)
}

async fn list(ctx: &Ctx, repo: &str) -> Result<()> {
    let (current, previous) = read_releases(ctx, repo).await?;
    let row = |r: &Release| {
        json!({
            "tag": r.tag_name,
            "name": r.name,
            "notes": r.notes,
            "yanked": r.yanked,
            "publishedBy": r.publisher,
            "createdAt": r.created_at,
            "assets": r.assets.iter().map(asset_json).collect::<Vec<_>>(),
        })
    };
    ctx.emit(
        json!({
            "count": current.len(),
            "releases": current.iter().map(row).collect::<Vec<_>>(),
            "previous": previous.iter().map(row).collect::<Vec<_>>(),
        }),
        || {
            if current.is_empty() {
                println!("no releases");
            }
            for r in &current {
                let y = if r.yanked { " (yanked)" } else { "" };
                println!(
                    "{}{y}  {}  {} asset(s)  published by {}",
                    r.tag_name,
                    r.name,
                    r.assets.len(),
                    r.publisher
                );
            }
        },
    );
    Ok(())
}

/// Download a release asset, accepting only bytes that hash to the recorded sha256.
async fn download(
    ctx: &Ctx,
    repo: &str,
    tag: &str,
    asset_name: Option<&str>,
    output: Option<PathBuf>,
) -> Result<()> {
    let (current, _) = read_releases(ctx, repo).await?;
    let release = current
        .into_iter()
        .find(|r| r.tag_name == tag)
        .ok_or_else(|| {
            crate::errors::not_found(
                format!("release {tag:?} not found in {repo}"),
                format!("`dg release list {repo}` lists its releases"),
            )
        })?;
    let asset = match asset_name {
        Some(n) => release.assets.into_iter().find(|a| a.name == n),
        None => release.assets.into_iter().next(),
    }
    .ok_or_else(|| {
        crate::errors::not_found(
            format!("no matching asset in release {tag:?}"),
            "omit --asset to download the first asset, or check the name with `dg release list`",
        )
    })?;
    if asset.uris.is_empty() {
        bail!("asset {:?} records no URI to download from", asset.name);
    }
    let bytes = PackReader::from_user_config()
        .fetch_verified(
            &asset.uris,
            &asset.sha256.to_ascii_lowercase(),
            (asset.size_bytes > 0).then_some(asset.size_bytes),
            None,
        )
        .await
        .context("downloading and verifying the asset")?;
    // A recorded name is data anyone with the maintainer role wrote: never let it choose a
    // path outside the current directory.
    let safe_name = Path::new(&asset.name)
        .file_name()
        .map_or_else(|| PathBuf::from("asset"), PathBuf::from);
    let out_path = output.unwrap_or(safe_name);
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
                "✓ {} ({} bytes, sha256 verified) → {}",
                asset.name,
                bytes.len(),
                out_path.display()
            );
        },
    );
    Ok(())
}
