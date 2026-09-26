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
use forge_core::rules::v2::Role;
use forge_core::storage::policy::git_config_scoped;
use forge_core::storage::{
    replicate, ExternalTarget, PackReader, StoragePolicy, StorageProfiles, StorageTarget,
};
use forge_core::user_error::{codes, UserError};

use crate::common::Session;
use crate::context::Ctx;
use crate::fmt::{cost_json, cost_line, dash_usd_price, short};
use crate::{ReleaseCommand, ReleaseCreateArgs};

/// URIs an asset records (the contract's whole `assets` JSON is 4096 bytes).
const MAX_ASSET_URIS: usize = 4;

/// Dispatch a `release` subcommand.
pub async fn run(ctx: &Ctx, cmd: &ReleaseCommand) -> Result<()> {
    match cmd {
        ReleaseCommand::Create(args) => create(ctx, args).await,
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
        uri: None,
    })
}

async fn create(ctx: &Ctx, args: &ReleaseCreateArgs) -> Result<()> {
    let s = Session::open_v2(ctx, &args.repo).await?;
    let collab = s.collab();
    let tag = &args.tag;
    // Maintainer-only at consensus: find out before uploading anything.
    collab
        .require_role(&s.repo, Role::Maintainer, &format!("publish release {tag}"))
        .await?;
    let targets = if args.assets.is_empty() {
        None
    } else {
        Some(asset_targets(args.storage.as_deref())?)
    };
    let total = args
        .assets
        .iter()
        .map(|p| std::fs::metadata(p).map(|m| m.len()))
        .sum::<std::io::Result<u64>>()
        .context("reading the asset files")?;
    let with = if args.assets.is_empty() {
        String::new()
    } else {
        format!(
            " with {} asset(s), {}",
            args.assets.len(),
            forge_core::storage::human_bytes(total)
        )
    };
    ctx.confirm_or_cancel(&format!(
        "Publish release {tag} of {}{with}? (one small document, ~0.0002 DASH)",
        s.repo.display()
    ))?;
    let mut uploaded = Vec::new();
    if let Some((targets, required)) = &targets {
        for p in &args.assets {
            let a = upload_asset(p, targets, *required).await?;
            if !ctx.json {
                eprintln!(
                    "  ✓ {} ({}) sha256 {} → {} cop(ies)",
                    a.name,
                    forge_core::storage::human_bytes(a.size_bytes),
                    short(&a.sha256),
                    a.uris.len()
                );
            }
            uploaded.push(a);
        }
    }
    let before = s.balance().await;
    let input = ReleaseInput {
        tag_name: tag.clone(),
        name: args.name.clone(),
        notes: args.notes.clone(),
        yanked: args.yanked,
        assets: uploaded,
    };
    let doc_id = collab.create_release(&s.repo, &input).await.map_err(|e| {
        anyhow::Error::from(e).context(if input.assets.is_empty() {
            "nothing was written"
        } else {
            "the assets were uploaded (content-addressed; re-running reuses them)"
        })
    })?;
    let spent = s.spent_since(before).await;
    let price = dash_usd_price();
    ctx.emit(
        json!({
            "status": "created",
            "tag": tag,
            "documentId": doc_id,
            "assets": input.assets.iter().map(asset_json).collect::<Vec<_>>(),
            "cost": cost_json(spent, price),
        }),
        || {
            println!(
                "✓ published release {tag} of {} ({} asset(s)) · {}",
                s.repo.display(),
                input.assets.len(),
                cost_line(spent, price)
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
    let s = Session::open(ctx, repo).await?;
    if s.repo.is_v1() {
        let r = ReleaseService::new(&s.client, &s.identity, &s.bridge)
            .list_releases(s.repo.v1_contract_id()?)
            .await
            .context("list_releases")?;
        return Ok((r, Vec::new()));
    }
    Ok(Collab::reader(&s.client).releases(&s.repo).await?)
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
    // Without --output the file is new: an existing file (or a symlink) of that name is not
    // overwritten, since the name came from someone else.
    let explicit = output.is_some();
    let out_path = output.unwrap_or(safe_name);
    let mut open = std::fs::OpenOptions::new();
    open.write(true);
    if explicit {
        open.create(true).truncate(true);
    } else {
        open.create_new(true);
    }
    let mut f = open.open(&out_path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::AlreadyExists {
            crate::errors::usage(format!(
                "{} already exists; pass --output <path> to choose where the asset goes",
                out_path.display()
            ))
        } else {
            anyhow::Error::from(e).context(format!("writing {}", out_path.display()))
        }
    })?;
    std::io::Write::write_all(&mut f, &bytes)
        .with_context(|| format!("writing {}", out_path.display()))?;
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
                crate::fmt::safe(&asset.name),
                bytes.len(),
                out_path.display()
            );
        },
    );
    Ok(())
}
