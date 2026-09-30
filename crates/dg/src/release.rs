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
use forge_core::collab::{Release, ReleaseAsset, ReleaseInput};
use forge_core::rules::v2::Role;
use forge_core::storage::policy::git_config_scoped;
use forge_core::storage::{
    replicate, ExternalTarget, PackReader, StoragePolicy, StorageProfiles, StorageTarget,
};
use forge_core::user_error::{codes, UserError};

use crate::common::{Reader, Session};
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
        ReleaseCommand::Unpublish { repo, tag } => unpublish(ctx, repo, tag).await,
    }
}

/// The external targets assets go to, and how many must confirm.
pub(crate) fn asset_targets(storage: Option<&str>) -> Result<(Vec<ExternalTarget>, usize)> {
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
    crate::storage::check_publishable(
        policy.external.iter().map(|(n, p)| (n.as_str(), p)),
        None,
        crate::storage::dash_remote_name().as_deref(),
        "release not created",
    )?;
    let http = forge_core::storage::http_client();
    let targets = policy
        .external
        .iter()
        .map(|(n, p)| ExternalTarget::from_profile(n, p, &http).map_err(anyhow::Error::from))
        .collect::<Result<Vec<_>>>()?;
    let required = policy.replicas.min(targets.len()).max(1);
    Ok((targets, required))
}

/// Upload one asset file and describe it, with how many copies were stored: one per storage
/// profile that confirmed it, however many URIs each records (an S3 copy has an `https` and an
/// `s3` one: "2 cop(ies)" for one profile was L-35).
pub(crate) async fn upload_asset(
    path: &Path,
    targets: &[ExternalTarget],
    required: usize,
) -> Result<(ReleaseAsset, usize)> {
    let name = upload_name(path)
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
    let asset = ReleaseAsset {
        name,
        sha256: meta.pack_hash,
        size_bytes: bytes.len() as u64,
        uris,
        uri: None,
    };
    Ok((asset, rep.replicas.len()))
}

/// `2 copies`, `1 copy`.
fn copies(n: usize) -> String {
    format!("{n} cop{}", if n == 1 { "y" } else { "ies" })
}

async fn create(ctx: &Ctx, args: &ReleaseCreateArgs) -> Result<()> {
    let s = Session::open_for_write(ctx, &args.repo, "release not created").await?;
    // Release notes and assets are not encrypted in this release: refuse before any asset
    // leaves the machine.
    s.repo.require_public("releases")?;
    // A tag the contract would refuse is refused before any asset is uploaded.
    forge_core::collab::v2::check_tag_name(&args.tag)?;
    let collab = s.collab();
    let tag = &args.tag;
    // Maintainer-only at consensus: find out before uploading anything.
    collab
        .require_role(&s.repo, Role::Maintainer, &format!("publish release {tag}"))
        .await?;
    // A release for this tag supersedes the current one (newest per tag wins), so what the
    // command does not change is carried forward: `--yanked` alone must not drop the files.
    let (current, _) = collab.releases(&s.repo).await?;
    let existing = current.into_iter().find(|r| &r.tag_name == tag);
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
    let kept = existing.as_ref().map_or(String::new(), |r| {
        format!(
            "; it replaces the current {tag} release and keeps its {} other asset(s){}",
            r.assets
                .iter()
                .filter(|a| !uploads_replace(&args.assets, &a.name))
                .count(),
            if r.yanked && !args.yanked {
                " (it is yanked now: without --yanked this un-yanks it)"
            } else {
                ""
            }
        )
    });
    ctx.confirm_or_cancel(&format!(
        "Publish release {tag} of {}{with}{kept}? (one small document, ~0.0002 DASH)",
        s.repo.display()
    ))?;
    let mut uploaded = Vec::new();
    if let Some((targets, required)) = &targets {
        for p in &args.assets {
            let (a, stored) = upload_asset(p, targets, *required).await?;
            if !ctx.json {
                eprintln!(
                    "  ✓ {} ({}) sha256 {} → {}",
                    a.name,
                    forge_core::storage::human_bytes(a.size_bytes),
                    short(&a.sha256),
                    copies(stored)
                );
            }
            uploaded.push(a);
        }
    }
    let before = s.balance().await;
    let input = superseding_input(existing.as_ref(), args, uploaded);
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

/// `dg release unpublish <tag>`: writes a release revision with `delta` −1 (maintainers only),
/// which the contract accepts only while the tag is currently live. The tag and its history
/// stay: a release is never deleted, and publishing the tag again starts a fresh one.
async fn unpublish(ctx: &Ctx, repo: &str, tag: &str) -> Result<()> {
    let s = Session::open_for_write(ctx, repo, "release not unpublished").await?;
    // Releases are not sealed in this release: refuse before any network round trip, as
    // `create` does.
    s.repo.require_public("releases")?;
    forge_core::collab::v2::check_tag_name(tag)?;
    let collab = s.collab();
    // Maintainer-only at consensus: find out, and whether the tag is live, before confirming.
    collab
        .require_role(&s.repo, Role::Maintainer, &format!("unpublish release {tag}"))
        .await?;
    let (current, _) = collab.releases(&s.repo).await?;
    if !current.iter().any(|r| r.tag_name == *tag) {
        return Err(release_not_live(repo, tag).into());
    }
    ctx.confirm_or_cancel(&format!(
        "Unpublish release {tag} of {}? (one small document, ~0.0002 DASH)",
        s.repo.display()
    ))?;
    let before = s.balance().await;
    let doc_id = collab.unpublish_release(&s.repo, tag).await?;
    let spent = s.spent_since(before).await;
    let price = dash_usd_price();
    ctx.emit(
        json!({
            "status": "unpublished",
            "tag": tag,
            "documentId": doc_id,
            "cost": cost_json(spent, price),
        }),
        || {
            println!(
                "✓ unpublished release {tag} of {} · {}",
                s.repo.display(),
                cost_line(spent, price)
            );
        },
    );
    Ok(())
}

/// The refusal `dg release unpublish` gives for a tag that is not currently live: never
/// published, or already unpublished.
fn release_not_live(repo: &str, tag: &str) -> UserError {
    UserError::new(
        codes::REJECTED,
        format!("release {tag:?} not unpublished: it is not currently live"),
    )
    .cause("a release can be unpublished only while it is live: never published, or already unpublished")
    .fix(format!("`dg release list {repo}` shows which tags are currently live"))
    .note("nothing was written")
}

/// The asset name an upload of `path` records.
fn upload_name(path: &Path) -> Option<&str> {
    path.file_name().and_then(|n| n.to_str())
}

/// Whether one of `uploads` records an asset named `name` (and so replaces that asset).
fn uploads_replace(uploads: &[PathBuf], name: &str) -> bool {
    uploads.iter().any(|p| upload_name(p) == Some(name))
}

/// The release `args` publishes (D-504). The newest release per tag wins, so a revision
/// that left out what it did not mean to change would drop it: the current release's name
/// and notes stay unless given, and its assets stay, except those a new upload of the same
/// name replaces. `--yanked` is the one field each revision states afresh (a republish
/// without it un-yanks).
fn superseding_input(
    existing: Option<&Release>,
    args: &ReleaseCreateArgs,
    uploaded: Vec<ReleaseAsset>,
) -> ReleaseInput {
    let keep = |given: &str, old: fn(&Release) -> &str| match (given, existing) {
        ("", Some(r)) => old(r).to_string(),
        _ => given.to_string(),
    };
    let mut assets: Vec<ReleaseAsset> = existing
        .into_iter()
        .flat_map(|r| &r.assets)
        .filter(|a| !uploaded.iter().any(|u| u.name == a.name))
        .cloned()
        .collect();
    assets.extend(uploaded);
    ReleaseInput {
        tag_name: args.tag.clone(),
        name: keep(&args.name, |r| &r.name),
        notes: keep(&args.notes, |r| &r.notes),
        yanked: args.yanked,
        assets,
    }
}

/// Why `asset` cannot be downloaded verified (D-517): it records no SHA-256 to check the
/// bytes against. Releases mirrored by forge-import before it hashed assets record `""`;
/// without this, every candidate "failed verification" and the error blamed a pack.
/// Nothing is downloaded unverified: there is no opt-out.
fn unverifiable(asset: &ReleaseAsset, repo: &str, tag: &str) -> Option<UserError> {
    (!forge_core::rules::is_sha256_hex(&asset.sha256)).then(|| {
        UserError::new(
            codes::INTEGRITY,
            format!(
                "asset {:?} of release {tag:?} has no recorded SHA-256, so it cannot be verified",
                crate::fmt::safe(&asset.name)
            ),
        )
        .cause(if asset.sha256.is_empty() {
            "the release records an empty sha256 (a release mirrored by an older forge-import, which did not hash assets)".to_string()
        } else {
            format!("the recorded sha256 {:?} is not 64 hex digits", crate::fmt::safe(&asset.sha256))
        })
        .fix(format!(
            "a maintainer of {repo} re-runs the import with a current forge-import: it downloads and hashes each asset and republishes the release"
        ))
        .fix(format!(
            "or re-publishes it with the file: `dg release create {repo} --tag {tag} --asset <file>`"
        ))
        .note("nothing was downloaded: dg only saves bytes it can check against the recorded hash")
    })
}

fn asset_json(a: &ReleaseAsset) -> serde_json::Value {
    json!({ "name": a.name, "sha256": a.sha256, "sizeBytes": a.size_bytes, "uris": a.uris })
}

/// The releases of `repo` (newest per tag, newest first) and the superseded revisions.
async fn read_releases(ctx: &Ctx, repo: &str) -> Result<(Vec<Release>, Vec<Release>)> {
    // No key is opened to read them for a public repository (L-12).
    let s = Reader::open(ctx, repo).await?;
    Ok(s.collab().releases(&s.repo).await?)
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

/// E503 for an asset none of whose recorded copies this reader will follow (plain http, this
/// machine, a private network, a bucket with no profile here). Without it the empty candidate
/// list surfaced as "not found" on Platform, though the release itself was read.
fn no_readable_copy(asset: &ReleaseAsset) -> UserError {
    // The URIs are whatever the publisher recorded: printable, few and short.
    let shown: Vec<String> = asset
        .uris
        .iter()
        .take(4)
        .map(|u| crate::fmt::safe(&u.chars().take(200).collect::<String>()).into_owned())
        .collect();
    UserError::new(
        codes::PACKS_UNREADABLE,
        format!(
            "asset {:?} has no copy this computer will download from",
            crate::fmt::safe(&asset.name)
        ),
    )
    .cause(format!(
        "none of its recorded copies is one this computer reads from (a public https URL, \
         an IPFS CID with a gateway, or a bucket or host of your own storage profiles): {}",
        shown.join(", ")
    ))
    .fix("if you trust that host (your own storage), add a storage profile whose public_url is it; for an ipfs:// copy, set `[read] ipfs_gateways`; then retry")
}

/// Where one downloaded asset is saved.
#[derive(Debug, PartialEq, Eq)]
struct Dest {
    path: PathBuf,
    /// `--output` named this file: an existing one is replaced. Otherwise the file name came
    /// from the release (someone else's data), and an existing file or symlink is kept.
    replace: bool,
}

/// Whether `path` is a regular file already holding the bytes whose sha256 is `sha256`: an
/// earlier run saved it (a rerun after one asset failed resumes instead of refusing).
fn already_saved(path: &Path, sha256: &str) -> bool {
    path.symlink_metadata().is_ok_and(|m| m.is_file())
        && std::fs::read(path).is_ok_and(|b| {
            PackMeta::for_bytes(&b)
                .pack_hash
                .eq_ignore_ascii_case(sha256)
        })
}

/// Where each of the assets `names` goes (L-22). No `--output`: the current directory. An
/// `--output` that is a directory (or ends in `/`): one file per asset, by its name. Any other
/// `--output`: that file, for exactly one asset. Every destination is checked before anything
/// is downloaded.
fn plan_outputs(assets: &[(&str, &str)], output: Option<&Path>) -> Result<Vec<Dest>> {
    let dir = match output {
        None => PathBuf::new(),
        Some(p) if p.is_dir() || p.as_os_str().to_string_lossy().ends_with('/') => p.to_path_buf(),
        Some(file) if assets.len() == 1 => {
            return Ok(vec![Dest {
                path: file.to_path_buf(),
                replace: true,
            }]);
        }
        Some(_) => {
            return Err(crate::errors::usage(format!(
                "--output names one file, and the release has {} assets: pass an --output directory, or --asset <name>",
                assets.len()
            )));
        }
    };
    // Compared without case: on a case-insensitive filesystem (macOS, Windows) `A.bin` and
    // `a.bin` are one file.
    let mut seen = std::collections::BTreeSet::new();
    assets
        .iter()
        .map(|(name, sha256)| {
            // A recorded name is data anyone with the maintainer role wrote: never let it
            // choose a path outside the directory.
            let file = Path::new(name)
                .file_name()
                .map_or_else(|| PathBuf::from("asset"), PathBuf::from);
            let path = dir.join(&file);
            if !seen.insert(file.to_string_lossy().to_lowercase()) {
                return Err(crate::errors::usage(format!(
                    "two assets of the release save as {}: download them one at a time, with --asset <name> --output <file>",
                    crate::fmt::safe(&path.display().to_string())
                )));
            }
            if path.symlink_metadata().is_ok() && !already_saved(&path, sha256) {
                return Err(already_exists(&path));
            }
            Ok(Dest {
                path,
                replace: false,
            })
        })
        .collect()
}

/// E201: `path` is taken, and a name that came from the release never replaces a file.
fn already_exists(path: &Path) -> anyhow::Error {
    crate::errors::usage(format!(
        "{} already exists; pass --output <directory or file> to choose where the assets go",
        crate::fmt::safe(&path.display().to_string())
    ))
}

/// A local failure to save a downloaded asset: the release WAS read and the bytes verified,
/// so this is not "could not read releases" (L-22).
fn save_failed(path: &Path, e: &std::io::Error) -> anyhow::Error {
    if e.kind() == std::io::ErrorKind::AlreadyExists {
        return already_exists(path);
    }
    UserError::new(
        codes::USAGE,
        format!(
            "release asset not saved: could not write {}",
            path.display()
        ),
    )
    .cause(format!(
        "the asset was downloaded and its sha256 verified, but saving it failed: {e}"
    ))
    .fix("pass --output <directory or file> naming a place you can write")
    .into()
}

/// Write `bytes` to `dest` ([`Dest::replace`] decides whether an existing file may go). The
/// bytes go to a temporary file beside it first, so a failed write never leaves a truncated
/// file under the asset's name (a rerun would then refuse it as "already exists").
fn save(dest: &Dest, bytes: &[u8]) -> Result<()> {
    let fail = |e: std::io::Error| save_failed(&dest.path, &e);
    let dir = match dest.path.parent() {
        Some(d) if !d.as_os_str().is_empty() => d,
        _ => Path::new("."),
    };
    let mut tmp = tempfile::NamedTempFile::new_in(dir).map_err(fail)?;
    std::io::Write::write_all(&mut tmp, bytes).map_err(fail)?;
    if dest.replace {
        tmp.persist(&dest.path).map_err(|e| fail(e.error))?;
    } else {
        // Never replaces a file or a symlink that appeared meanwhile.
        tmp.persist_noclobber(&dest.path)
            .map_err(|e| fail(e.error))?;
    }
    Ok(())
}

/// The assets of release `tag` to download: every one, or the one named `--asset`.
async fn assets_to_download(
    ctx: &Ctx,
    repo: &str,
    tag: &str,
    asset_name: Option<&str>,
) -> Result<Vec<ReleaseAsset>> {
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
    let assets: Vec<ReleaseAsset> = release
        .assets
        .into_iter()
        .filter(|a| asset_name.is_none_or(|n| a.name == n))
        .collect();
    if assets.is_empty() {
        return Err(crate::errors::not_found(
            match asset_name {
                Some(n) => format!("release {tag:?} has no asset {n:?}"),
                None => format!("release {tag:?} has no assets"),
            },
            "omit --asset to download every asset, or check the names with `dg release list`",
        ));
    }
    Ok(assets)
}

/// Download a release's assets (every one, or `--asset`), accepting only bytes that hash to
/// the recorded sha256.
async fn download(
    ctx: &Ctx,
    repo: &str,
    tag: &str,
    asset_name: Option<&str>,
    output: Option<PathBuf>,
) -> Result<()> {
    let assets = assets_to_download(ctx, repo, tag, asset_name).await?;
    // The gateways the uploaders recorded reach their nodes: try them before the shared list.
    let reader = PackReader::from_user_config().prefer_gateways(
        forge_core::storage::read::repo_gateways(assets.iter().flat_map(|a| a.uris.iter())),
    );
    // Before anything is downloaded: every asset has a copy this reader follows (not plain
    // http, this machine, a private network, a bucket with no profile here: say that rather
    // than let an empty candidate list read as "not found"), and every destination is free.
    for a in &assets {
        if a.uris.is_empty() {
            bail!("asset {:?} records no URI to download from", a.name);
        }
        if let Some(e) = unverifiable(a, repo, tag) {
            return Err(e.into());
        }
        if !reader.has_candidates(&a.uris) {
            return Err(no_readable_copy(a).into());
        }
    }
    let planned: Vec<(&str, &str)> = assets
        .iter()
        .map(|a| (a.name.as_str(), a.sha256.as_str()))
        .collect();
    let dests = plan_outputs(&planned, output.as_deref())?;
    if let Some(dir) = dests.first().and_then(|d| d.path.parent()) {
        if !dir.as_os_str().is_empty() && !dir.exists() {
            std::fs::create_dir_all(dir).map_err(|e| save_failed(dir, &e))?;
        }
    }
    let mut saved = Vec::new();
    for (asset, dest) in assets.iter().zip(&dests) {
        let shown = crate::fmt::safe(&dest.path.display().to_string()).into_owned();
        if !dest.replace && already_saved(&dest.path, &asset.sha256) {
            if !ctx.json {
                println!(
                    "✓ {} is already there, sha256 verified → {shown}",
                    crate::fmt::safe(&asset.name)
                );
            }
            saved.push(json!({
                "name": asset.name,
                "sha256": asset.sha256,
                "bytes": asset.size_bytes,
                "output": dest.path.to_string_lossy(),
                "alreadyThere": true,
            }));
            continue;
        }
        let bytes = reader
            .fetch_verified(
                &asset.uris,
                &asset.sha256.to_ascii_lowercase(),
                (asset.size_bytes > 0).then_some(asset.size_bytes),
                None,
            )
            .await
            .with_context(|| format!("downloading and verifying {}", asset.name))?;
        save(dest, &bytes)?;
        if !ctx.json {
            println!(
                "✓ {} ({} bytes, sha256 verified) → {shown}",
                crate::fmt::safe(&asset.name),
                bytes.len(),
            );
        }
        saved.push(json!({
            "name": asset.name,
            "sha256": asset.sha256,
            "bytes": bytes.len(),
            "output": dest.path.to_string_lossy(),
        }));
    }
    if ctx.json {
        crate::errors::print_json(&json!({
            "status": "downloaded",
            "tag": tag,
            "count": saved.len(),
            "assets": saved,
        }));
    }
    Ok(())
}

#[cfg(test)]
mod download_tests {
    use super::*;

    /// Assets named `names`, whose sha256 nothing on disk matches.
    fn plan(names: &[&str], output: Option<&Path>) -> Result<Vec<Dest>> {
        let assets: Vec<(&str, &str)> = names.iter().map(|n| (*n, "00")).collect();
        plan_outputs(&assets, output)
    }

    fn dests(names: &[&str], output: Option<&Path>) -> Result<Vec<(PathBuf, bool)>> {
        Ok(plan(names, output)?
            .into_iter()
            .map(|d| (d.path, d.replace))
            .collect())
    }

    /// L-22: `--output <dir>` saves every asset in it by name (it was "Is a directory").
    #[test]
    fn an_output_directory_takes_every_asset_by_name() {
        let dir = tempfile::tempdir().unwrap();
        let got = dests(&["a.tar.gz", "../../etc/b.zip"], Some(dir.path())).unwrap();
        assert_eq!(
            got,
            [
                (dir.path().join("a.tar.gz"), false),
                (dir.path().join("b.zip"), false)
            ]
        );
        // A directory that does not exist yet, named with a trailing slash.
        let new = format!("{}/new/", dir.path().display());
        assert_eq!(
            dests(&["a"], Some(Path::new(&new))).unwrap()[0].0,
            Path::new(&new).join("a")
        );
        // No --output: the current directory.
        assert_eq!(
            dests(&["x", "y"], None).unwrap(),
            [(PathBuf::from("x"), false), (PathBuf::from("y"), false)]
        );
    }

    #[test]
    fn a_file_output_takes_one_asset_and_existing_files_stay() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("out.bin");
        assert_eq!(dests(&["a"], Some(&file)).unwrap(), [(file.clone(), true)]);
        let two = plan(&["a", "b"], Some(&file)).unwrap_err();
        assert!(format!("{two:#}").contains("--output directory"), "{two:#}");
        std::fs::write(dir.path().join("a"), b"mine").unwrap();
        let exists = plan(&["a"], Some(dir.path())).unwrap_err();
        assert!(
            format!("{exists:#}").contains("already exists"),
            "{exists:#}"
        );
        // Two recorded names that land on one file, also when they differ only in case.
        assert!(plan(&["x/c", "y/c"], Some(dir.path())).is_err());
        let case = plan(&["README.txt", "readme.TXT"], Some(dir.path())).unwrap_err();
        assert!(format!("{case:#}").contains("two assets"), "{case:#}");
    }

    /// A rerun after one asset failed resumes: a file already holding the asset's bytes
    /// (its sha256 matches) is kept and skipped, not refused.
    #[test]
    fn a_file_with_the_assets_bytes_is_already_saved() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a"), b"mine").unwrap();
        let sha = PackMeta::for_bytes(b"mine").pack_hash;
        let d = plan_outputs(&[("a", sha.as_str())], Some(dir.path())).unwrap();
        assert_eq!(d[0].path, dir.path().join("a"));
        assert!(already_saved(&d[0].path, &sha.to_ascii_uppercase()));
        assert!(!already_saved(&d[0].path, &"0".repeat(64)));
    }

    /// A save never leaves a partial file behind, and never replaces a name-derived file.
    #[test]
    fn saves_are_whole_and_do_not_clobber() {
        let dir = tempfile::tempdir().unwrap();
        let dest = Dest {
            path: dir.path().join("a"),
            replace: false,
        };
        save(&dest, b"one").unwrap();
        assert_eq!(std::fs::read(&dest.path).unwrap(), b"one");
        assert!(save(&dest, b"two").is_err());
        assert_eq!(std::fs::read(&dest.path).unwrap(), b"one");
        let file = Dest {
            replace: true,
            ..dest
        };
        save(&file, b"two").unwrap();
        assert_eq!(std::fs::read(&file.path).unwrap(), b"two");
        let left = std::fs::read_dir(dir.path()).unwrap().count();
        assert_eq!(left, 1, "no temporary file left behind");
    }

    /// A local write failure is its own error, not "could not read releases".
    #[test]
    fn a_failed_save_says_the_asset_was_read() {
        let dir = tempfile::tempdir().unwrap();
        let err = save(
            &Dest {
                path: dir.path().to_path_buf(),
                replace: true,
            },
            b"x",
        )
        .unwrap_err();
        let u = forge_core::user_error::classify(
            err.chain(),
            &forge_core::user_error::ErrorContext {
                goal: Some("release not downloaded"),
                ..Default::default()
            },
        );
        assert_eq!(u.code, "E201", "{u:?}");
        assert!(u.message.starts_with("release asset not saved"), "{u:?}");
        assert!(u.cause.unwrap().contains("sha256 verified"));
    }

    #[test]
    fn copies_counts_profiles() {
        assert_eq!(copies(1), "1 copy");
        assert_eq!(copies(2), "2 copies");
    }
}

#[cfg(test)]
mod no_readable_copy_tests {
    use super::*;

    #[test]
    fn an_asset_with_no_followable_copy_is_e503_with_its_copies_made_printable() {
        let asset = ReleaseAsset {
            name: "tool\u{1b}[2J.tar.gz".into(),
            sha256: "00".repeat(32),
            size_bytes: 1,
            uris: vec![
                "http://127.0.0.1:9000/forge-byo/a.tar.gz".into(),
                format!("http://10.0.0.1/\u{1b}]8;;evil\u{7}{}", "x".repeat(400)),
            ],
            uri: None,
        };
        let e = no_readable_copy(&asset);
        assert_eq!(e.code, "E503");
        let cause = e.cause.unwrap_or_default();
        assert!(
            cause.contains("http://127.0.0.1:9000/forge-byo/a.tar.gz"),
            "{cause}"
        );
        assert!(
            !cause.contains('\u{1b}') && !cause.contains('\u{7}'),
            "{cause:?}"
        );
        assert!(!e.message.contains('\u{1b}'), "{:?}", e.message);
        assert!(cause.len() < 600, "each copy is capped: {}", cause.len());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn asset(name: &str, sha: char) -> ReleaseAsset {
        ReleaseAsset {
            name: name.into(),
            sha256: sha.to_string().repeat(64),
            size_bytes: 10,
            uris: vec![format!("https://a.example/{name}")],
            uri: None,
        }
    }

    fn current() -> Release {
        Release {
            document_id: "d1".into(),
            tag_name: "v1".into(),
            name: "One".into(),
            notes: "first".into(),
            yanked: false,
            assets: vec![asset("app.tar.gz", 'a'), asset("CHANGES.txt", 'b')],
            publisher: "M".into(),
            created_at: 1,
            delta: 1,
        }
    }

    fn args(extra: &[&str]) -> ReleaseCreateArgs {
        use clap::Parser as _;
        #[derive(clap::Parser)]
        struct Wrap {
            #[command(flatten)]
            a: ReleaseCreateArgs,
        }
        let mut argv = vec!["dg", "o/r", "--tag", "v1"];
        argv.extend_from_slice(extra);
        Wrap::parse_from(argv).a
    }

    fn names(assets: &[ReleaseAsset]) -> Vec<(String, char)> {
        assets
            .iter()
            .map(|a| (a.name.clone(), a.sha256.chars().next().unwrap_or('-')))
            .collect()
    }

    /// D-504: `--yanked` alone republished the tag with no assets, name or notes.
    #[test]
    fn yanking_keeps_the_assets_name_and_notes() {
        let input = superseding_input(Some(&current()), &args(&["--yanked"]), Vec::new());
        assert!(input.yanked);
        assert_eq!(
            (input.name.as_str(), input.notes.as_str()),
            ("One", "first")
        );
        assert_eq!(names(&input.assets), names(&current().assets));
    }

    #[test]
    fn given_fields_win_and_a_same_named_upload_replaces_its_asset() {
        let a = args(&["--notes", "second", "--asset", "dist/app.tar.gz"]);
        let input = superseding_input(Some(&current()), &a, vec![asset("app.tar.gz", 'c')]);
        assert!(!input.yanked, "a republish without --yanked un-yanks");
        assert_eq!(
            (input.name.as_str(), input.notes.as_str()),
            ("One", "second")
        );
        assert_eq!(
            names(&input.assets),
            [
                ("CHANGES.txt".to_string(), 'b'),
                ("app.tar.gz".to_string(), 'c')
            ]
        );
        assert!(uploads_replace(&a.assets, "app.tar.gz"));
        assert!(!uploads_replace(&a.assets, "CHANGES.txt"));
    }

    #[test]
    fn a_new_tag_has_only_what_was_given() {
        let input = superseding_input(None, &args(&["--yanked"]), Vec::new());
        assert!(input.assets.is_empty() && input.name.is_empty() && input.notes.is_empty());
    }

    /// `dg release unpublish` refuses a tag that is not live (never published, or already
    /// unpublished) before any network round trip, naming the tag and pointing at `release
    /// list` to check.
    #[test]
    fn release_not_live_names_the_tag_and_points_at_release_list() {
        let e = release_not_live("o/r", "v9.9.9");
        assert_eq!(e.code, codes::REJECTED);
        assert!(e.message.contains("v9.9.9"), "{}", e.message);
        assert!(
            e.fix.iter().any(|f| f.contains("dg release list o/r")),
            "{:?}",
            e.fix
        );
    }

    /// D-517: an asset with no recorded hash is refused with its own error, not E503.
    #[test]
    fn an_asset_without_a_hash_is_refused_by_name_with_the_fix() {
        let mut a = asset("fd", 'a');
        assert!(unverifiable(&a, "o/r", "v0.1.0").is_none());
        a.sha256 = String::new();
        let e = unverifiable(&a, "o/r", "v0.1.0").expect("refused");
        assert_eq!(e.code, codes::INTEGRITY);
        let text = e.to_json().to_string();
        assert!(text.contains("no recorded SHA-256"), "{text}");
        assert!(text.contains("forge-import"), "{text}");
        assert!(text.contains("nothing was downloaded"), "{text}");
        assert!(!text.contains("reseed"), "{text}");
        a.sha256 = "nothex".into();
        assert!(unverifiable(&a, "o/r", "v0.1.0").is_some());
    }
}
