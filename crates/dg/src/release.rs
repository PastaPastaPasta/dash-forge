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
use forge_core::collab::{Release, ReleaseAsset, ReleaseInput};
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

/// Upload one asset file and describe it.
async fn upload_asset(
    path: &Path,
    targets: &[ExternalTarget],
    required: usize,
) -> Result<ReleaseAsset> {
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
    Ok(ReleaseAsset {
        name,
        sha256: meta.pack_hash,
        size_bytes: bytes.len() as u64,
        uris,
        uri: None,
    })
}

async fn create(ctx: &Ctx, args: &ReleaseCreateArgs) -> Result<()> {
    let s = Session::open_for_write(ctx, &args.repo, "release not created").await?;
    // Release notes and assets are not encrypted in this release: refuse before any asset
    // leaves the machine.
    s.repo.require_public("releases")?;
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
    let s = Session::open(ctx, repo).await?;
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
    if let Some(e) = unverifiable(&asset, repo, tag) {
        return Err(e.into());
    }
    // The gateway the uploader recorded reaches its node: try it before the shared list.
    let reader = PackReader::from_user_config()
        .prefer_gateways(forge_core::storage::read::repo_gateways(&asset.uris));
    // Every recorded copy may be one this reader will not follow (plain http, this machine, a
    // private network, a bucket with no profile here). Say that, rather than let the empty
    // candidate list surface as "not found" on Platform (the release itself was read).
    if !reader.has_candidates(&asset.uris) {
        return Err(no_readable_copy(&asset).into());
    }
    let bytes = reader
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
