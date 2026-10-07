//! `dg release` — create / list / download releases.
//!
//! On forge-v2 a `release` is a maintainer-only forge-core document, newest per tag wins.
//! `create --asset <file>` uploads each file to the repository's storage policy (the same
//! `dash.storage` / `dash.replicas` profiles a `git push` uses, or `--storage`), verifies the
//! copies, and records `{name, sha256, sizeBytes, uris}`; `download` accepts only bytes that
//! hash to the recorded sha256. Assets are external-only: Platform stores packs, not
//! arbitrary files, so a Platform-only policy is refused with the fix.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use serde_json::json;

use forge_core::backends::PackMeta;
use forge_core::collab::{
    Release, ReleaseAsset, ReleaseFile, ReleaseInput, ReleaseList, ReleaseStore,
};
use forge_core::private::release::ManifestAsset;
use forge_core::rules::v2::{Role, Visibility};
use forge_core::storage::policy::git_config_scoped;
use forge_core::storage::{
    replicate, ExternalTarget, PackReader, StoragePolicy, StorageProfiles, StorageTarget,
};
use forge_core::user_error::{codes, UserError};

use crate::common::{Reader, Session};
use crate::context::Ctx;
use crate::fmt::{cost_json, cost_line, short};
use crate::{ReleaseCommand, ReleaseCreateArgs};

/// URIs an asset records (the contract's whole `assets` JSON is 4096 bytes).
const MAX_ASSET_URIS: usize = 4;

/// Dispatch a `release` subcommand.
pub async fn run(ctx: &Ctx, cmd: &ReleaseCommand) -> Result<()> {
    match cmd {
        ReleaseCommand::Create(args) => {
            check_upload_names(&args.assets)?;
            create(ctx, args).await
        }
        ReleaseCommand::List { repo } => list(ctx, repo).await,
        ReleaseCommand::Download {
            repo,
            tag,
            asset,
            output,
            dir,
            force,
        } => {
            // `-D/--dir` is always a directory, made when missing, as gh's is (QW3-069).
            let output = match dir {
                Some(d) => {
                    std::fs::create_dir_all(d)
                        .with_context(|| format!("creating {}", d.display()))?;
                    Some(d.clone())
                }
                None => output.clone(),
            };
            download(ctx, repo, tag, asset.as_deref(), output, *force).await
        }
        ReleaseCommand::Unpublish { repo, tag } => unpublish(ctx, repo, tag).await,
        ReleaseCommand::Verify { repo, tag } => crate::release_verify::verify(ctx, repo, tag).await,
    }
}

/// What a refused `dg release create` says first.
const NOT_CREATED: &str = "release not created";

/// The external targets assets go to, and how many must confirm. `lead` heads a refusal
/// ("release not created", "check run not reported").
pub(crate) fn asset_targets(
    storage: Option<&str>,
    lead: &str,
) -> Result<(Vec<ExternalTarget>, usize)> {
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
            format!("{lead}: no storage for the assets"),
        )
        .cause("release assets, check-run logs and artifacts are stored on your own storage (S3, IPFS), and this repository's policy is Platform only")
        .fix("`dg storage add <name> …` then pass `--storage <name>` (or `dg storage use <name>` in the repository)")
        .note("nothing was uploaded or written")
        .into());
    }
    crate::storage::check_publishable(
        policy.external.iter().map(|(n, p)| (n.as_str(), p)),
        None,
        crate::storage::dash_remote_name().as_deref(),
        lead,
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

#[allow(clippy::too_many_lines)] // one linear flow: checks, quote, uploads, write, report
async fn create(ctx: &Ctx, args: &ReleaseCreateArgs) -> Result<()> {
    let s = Session::open_for_write(ctx, &args.repo, "release not created").await?;
    // A tag the contract would refuse is refused before any asset is uploaded.
    forge_core::collab::v2::check_tag_name(&args.tag)?;
    if s.repo.visibility == Visibility::Private {
        return create_sealed(ctx, args, &s).await;
    }
    refuse_sealed_only_flags(args)?;
    let collab = s.collab();
    let tag = &args.tag;
    // Maintainer-only at consensus: find out before uploading anything.
    collab
        .require_role(&s.repo, Role::Maintainer, &format!("publish release {tag}"))
        .await?;
    // A release for this tag supersedes the current one (newest per tag wins), so what the
    // command does not change is carried forward: `--yanked` alone must not drop the files.
    let current = collab.releases(&s.repo).await?.current;
    let existing = current.into_iter().find(|r| &r.tag_name == tag);
    ensure_tag(&s, tag, Some(existing.is_some())).await?;
    let targets = if args.assets.is_empty() {
        None
    } else {
        Some(asset_targets(args.storage.as_deref(), NOT_CREATED)?)
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
            " with {}, {}",
            crate::fmt::plural(args.assets.len(), "asset"),
            forge_core::storage::human_bytes(total)
        )
    };
    let kept = existing.as_ref().map_or(String::new(), |r| {
        format!(
            "; it replaces the current {tag} release and keeps its other {}{}",
            crate::fmt::plural(
                r.assets
                    .iter()
                    .filter(|a| !uploads_replace(&args.assets, &a.name))
                    .count(),
                "asset"
            ),
            if r.yanked && args.yanked != Some(true) {
                " (it is yanked now: without --yanked this un-yanks it)"
            } else {
                ""
            }
        )
    });
    // Notes longer than the field are stored as a repository artifact (forge-v2.md §6.3).
    let planned = crate::long_body::Planned::new(
        &s.repo,
        forge_core::collab::long_body::BodyField::Release,
        None,
        &args.notes,
        forge_core::rules::v2::Audience::Public,
    )?;
    let quote = release_quote(
        existing.as_ref(),
        args,
        targets.as_ref().map_or(0, |t| t.0.len()),
    ) + planned.extra_credits(&s.repo);
    ctx.confirm_or_cancel(&format!(
        "Publish release {tag} of {}{with}{kept}? (one document, {}{})",
        s.repo.display(),
        cost_line(quote, ctx.usd_price()),
        planned.clause()
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
    let mut input = superseding_input(existing.as_ref(), args, uploaded);
    if !args.notes.is_empty() {
        input.notes = planned.field_text(&collab, &s.repo, None).await?;
    }
    let doc_id = collab.create_release(&s.repo, &input).await.map_err(|e| {
        anyhow::Error::from(e).context(if input.assets.is_empty() {
            "nothing was written"
        } else {
            "the assets were uploaded (content-addressed; re-running reuses them)"
        })
    })?;
    let spent = s.spent_since(before).await;
    let price = ctx.usd_price();
    ctx.emit(
        json!({
            "status": "created",
            "tag": tag,
            "documentId": doc_id,
            "id": doc_id,
            "assets": input.assets.iter().map(asset_json).collect::<Vec<_>>(),
            "cost": cost_json(spent, price),
        }),
        || {
            println!(
                "✓ published release {tag} of {} ({}) · {}",
                s.repo.display(),
                crate::fmt::plural(input.assets.len(), "asset"),
                cost_line(spent, price)
            );
        },
    );
    Ok(())
}

/// [`require_tag`] against the repository's refs (names opened for a member of a private
/// repository). `has_release`: whether the tag has a release now, `None` to read it.
async fn ensure_tag(s: &Session, tag: &str, has_release: Option<bool>) -> Result<()> {
    let has_release = match has_release {
        Some(h) => h,
        None => s
            .collab()
            .releases(&s.repo)
            .await?
            .current
            .iter()
            .any(|r| r.tag_name == tag),
    };
    let refs = forge_core::repo::RepoService::new(&s.client, &s.identity, &s.bridge)
        .read_refs(&s.repo)
        .await?;
    require_tag(&refs, &s.repo.display(), tag, has_release)
}

/// Refuse a release for a tag the repository does not have (E102), before anything is
/// uploaded or signed: a release cannot be deleted, only unpublished, so one for a mistyped
/// tag stays (QW-037). A tag that already has a release may be gone since; a new revision of
/// that release (yanking it, new notes) is still allowed.
fn require_tag(
    refs: &[(String, forge_core::rules::RefState)],
    repo: &str,
    tag: &str,
    has_release: bool,
) -> Result<()> {
    const SHOWN: usize = 10;
    let want = format!("refs/tags/{tag}");
    let live = |st: &forge_core::rules::RefState| forge_core::rules::tip_of(st).is_some();
    if has_release || refs.iter().any(|(n, st)| *n == want && live(st)) {
        return Ok(());
    }
    let mut tags: Vec<&str> = refs
        .iter()
        .filter(|(_, st)| live(st))
        .filter_map(|(n, _)| n.strip_prefix("refs/tags/"))
        .collect();
    tags.sort_unstable();
    let known = match tags.len() {
        0 => "it has no tags yet".to_string(),
        n if n <= SHOWN => format!("its tags: {}", crate::fmt::safe(&tags.join(", "))),
        n => format!(
            "its tags include {} and {} more",
            crate::fmt::safe(&tags[..SHOWN].join(", ")),
            n - SHOWN
        ),
    };
    Err(UserError::new(
        codes::NOT_FOUND,
        format!(
            "release not created: {} is not a tag of {}",
            crate::fmt::safe(tag),
            repo
        ),
    )
    .cause(format!(
        "a release is published for a tag the repository has, and it cannot be deleted later, only unpublished ({known})"
    ))
    .fix(format!(
        "push the tag first: `git tag {tag} <commit> && git push origin {tag}`, then run this again"
    ))
    .fix("pass --tag naming one of its tags")
    .note("checked before anything was uploaded or signed; nothing was written or paid")
    .into())
}

/// `dg release create` on a private repository (`private-repos.md` §16): every `--asset` is
/// sealed before it leaves the machine and stored under its sealed hash, the asset list is a
/// sealed kind-4 manifest, and the revision is sealed under the current key epoch. What the
/// command does not change is carried forward from the tag's newest revision by forge-core.
#[allow(clippy::too_many_lines)] // one command: plan, quote, confirm, store, write, report
async fn create_sealed(ctx: &Ctx, args: &ReleaseCreateArgs, s: &Session) -> Result<()> {
    let collab = s.collab();
    let tag = &args.tag;
    collab
        .require_role(&s.repo, Role::Maintainer, &format!("publish release {tag}"))
        .await?;
    ensure_tag(s, tag, None).await?;
    let files = read_release_files(&args.assets)?;
    // New files need storage; so may new notes (the full notes move into the sealed asset list
    // when they do not fit), so the policy is resolved whenever there is one.
    let targets = match asset_targets(args.storage.as_deref(), NOT_CREATED) {
        Ok(t) => Some(t),
        Err(e) if files.is_empty() => {
            tracing::debug!(error = %e, "no asset storage; a revision without new files may not need it");
            None
        }
        Err(e) => return Err(e),
    };
    let total: u64 = files.iter().map(|f| f.bytes.len() as u64).sum();
    let with = if files.is_empty() {
        String::new()
    } else {
        format!(
            " with {} (encrypted), {}",
            crate::fmt::plural(files.len(), "asset"),
            forge_core::storage::human_bytes(total)
        )
    };
    let notes_quote = sealed_notes_quote(args, targets.as_ref())?;
    let long_notes = notes_quote > 0;
    ctx.confirm_or_cancel(&format!(
        "Publish sealed release {tag} of {}{with}? A private release holds 1507 bytes of tag, \
         name, notes preview and provenance; longer notes continue in its sealed asset list{}. \
         What you do not change is kept from the tag's last revision. (one document, and one \
         for a new asset list: {})",
        s.repo.display(),
        if long_notes {
            ", and notes over 5,120 bytes in a sealed artifact on the same storage"
        } else {
            ""
        },
        cost_line(
            sealed_quote(&files, args, targets.as_ref()) + notes_quote,
            ctx.usd_price()
        )
    ))?;
    let store = targets.as_ref().map(|(t, required)| ReleaseStore {
        targets: t.iter().map(|t| t as &dyn StorageTarget).collect(),
        required: *required,
    });
    let notes = match &store {
        Some(st) if long_notes => {
            let on = forge_core::collab::long_body::BodyStore {
                external: st.targets.clone(),
                platform: false,
                required: st.required,
            };
            let field = forge_core::collab::long_body::BodyField::Release;
            collab
                .store_long_body(
                    &s.repo,
                    field,
                    None,
                    &args.notes,
                    &on,
                    forge_core::rules::v2::Audience::Public,
                )
                .await?
        }
        _ => args.notes.clone(),
    };
    let input = ReleaseInput {
        tag_name: tag.clone(),
        name: args.name.clone(),
        notes,
        yanked: args.yanked,
        files,
        prerelease: args.prerelease,
        draft: args.draft,
        ..ReleaseInput::default()
    };
    let before = s.balance().await;
    let written = collab
        .create_release_stored(&s.repo, &input, store.as_ref())
        .await
        .map_err(|e| {
            // new files or notes may store sealed copies and an asset list before the release
            // itself is signed
            anyhow::Error::from(e).context(if input.files.is_empty() && input.notes.is_empty() {
                "nothing was written"
            } else {
                "the release was not written; sealed copies and an asset list may have been \
                 stored, and a re-run with the same files and notes reuses a stored list (unless \
                 the key epoch moved meanwhile)"
            })
        })?;
    let spent = s.spent_since(before).await;
    let price = ctx.usd_price();
    ctx.emit(
        json!({
            "status": "created",
            "tag": tag,
            "sealed": true,
            "documentId": written.document_id,
            "id": written.document_id,
            "assets": written.sealed_assets,
            "assetListKept": written.asset_list_kept,
            "assetListReused": written.asset_list_reused,
            "warnings": written.warnings,
            "cost": cost_json(spent, price),
        }),
        || {
            for a in &written.sealed_assets {
                eprintln!(
                    "  ✓ {} ({}) sha256 {} sealed {}",
                    crate::fmt::safe(&a.name),
                    forge_core::storage::human_bytes(a.size_bytes),
                    short(&a.sha256),
                    a.sealed_sha256.as_deref().map_or("external", short)
                );
            }
            println!(
                "✓ published sealed release {tag} of {} ({}) · {}",
                s.repo.display(),
                sealed_assets_line(&written),
                cost_line(spent, price)
            );
            print_warnings(&written.warnings);
        },
    );
    Ok(())
}

/// What a sealed revision's notes longer than the field (5,120 bytes, which the sealed asset
/// list continues to) add to its quote: their full text, stored as a sealed artifact on the
/// same storage as the assets (forge-v2.md §6.3). 0 for notes that fit; refused when there is
/// no such storage (with the asset-storage refusal, which says why).
fn sealed_notes_quote(
    args: &ReleaseCreateArgs,
    targets: Option<&(Vec<ExternalTarget>, usize)>,
) -> Result<u64> {
    let field = forge_core::collab::long_body::FIELD_MAX;
    if !forge_core::rules::long_body::needs_artifact(&args.notes, field) {
        return Ok(0);
    }
    let Some((targets, _)) = targets else {
        asset_targets(args.storage.as_deref(), NOT_CREATED)?;
        return Err(crate::errors::usage(
            "notes over 5,120 bytes need storage of your own",
        ));
    };
    Ok(forge_core::cost::push_fees::long_body(
        args.notes.len() as u64,
        true,
        targets.len() as u64,
        false,
    ))
}

/// What a sealed revision's asset list is, as `dg release create` prints it.
fn sealed_assets_line(written: &forge_core::collab::ReleaseWritten) -> String {
    let n = written.sealed_assets.len();
    if written.asset_list_kept {
        "asset list unchanged".to_string()
    } else if written.asset_list_reused {
        format!(
            "{}, the asset list an earlier attempt stored",
            crate::fmt::plural(n, "asset")
        )
    } else {
        crate::fmt::plural(n, "asset")
    }
}

fn print_warnings(warnings: &[String]) {
    for w in warnings {
        println!("warning: {w}");
    }
}

/// `dg release unpublish <tag>`: writes a release revision with `delta` −1 (maintainers only),
/// which the contract accepts only while the tag is currently live. The tag and its history
/// stay: a release is never deleted, and publishing the tag again starts a fresh one. A
/// private repository's is a sealed revision with the unpublished flag instead
/// ([`unpublish_sealed`]).
async fn unpublish(ctx: &Ctx, repo: &str, tag: &str) -> Result<()> {
    let s = Session::open_for_write(ctx, repo, "release not unpublished").await?;
    forge_core::collab::v2::check_tag_name(tag)?;
    if s.repo.visibility == Visibility::Private {
        return unpublish_sealed(ctx, repo, tag, &s).await;
    }
    let collab = s.collab();
    // Maintainer-only at consensus: find out, and whether the tag is live, before confirming.
    collab
        .require_role(
            &s.repo,
            Role::Maintainer,
            &format!("unpublish release {tag}"),
        )
        .await?;
    // The same sum-based liveness test the write itself will make (not `releases()`'s "newest
    // per tag" pick, which tie-breaks by `$id` within a block and so can disagree with the sum
    // -- and so with consensus -- for two revisions landing there together).
    if !collab.tag_is_live(&s.repo, tag).await? {
        return Err(release_not_live(repo, tag).into());
    }
    // The unpublish revision carries the live one's name, notes and assets forward.
    let live = collab
        .releases(&s.repo)
        .await?
        .current
        .into_iter()
        .find(|r| r.tag_name == tag);
    let carried = ReleaseInput {
        tag_name: tag.to_string(),
        name: live.as_ref().map(|r| r.name.clone()).unwrap_or_default(),
        notes: live.as_ref().map(|r| r.notes.clone()).unwrap_or_default(),
        assets: live.map(|r| r.assets).unwrap_or_default(),
        ..ReleaseInput::default()
    };
    ctx.confirm_or_cancel(&format!(
        "Unpublish release {tag} of {}? (one document, {})",
        s.repo.display(),
        cost_line(revision_quote(&carried), ctx.usd_price())
    ))?;
    let before = s.balance().await;
    let doc_id = collab.unpublish_release(&s.repo, tag).await?;
    let spent = s.spent_since(before).await;
    let price = ctx.usd_price();
    ctx.emit(
        json!({
            "status": "unpublished",
            "tag": tag,
            "documentId": doc_id,
            "id": doc_id,
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

/// `dg release unpublish` on a private repository (§16.3): a sealed revision under the
/// current key epoch with flag `0x08` that carries every other field forward (the yank
/// included), with `delta` 0. A later revision without the flag publishes the tag again.
async fn unpublish_sealed(ctx: &Ctx, repo: &str, tag: &str, s: &Session) -> Result<()> {
    let collab = s.collab();
    collab
        .require_role(
            &s.repo,
            Role::Maintainer,
            &format!("unpublish release {tag}"),
        )
        .await?;
    // Live is the fold's answer here: consensus keeps no ledger for a sealed tag (§16.3).
    let Some(live) = collab
        .releases(&s.repo)
        .await?
        .current
        .into_iter()
        .find(|r| r.tag_name == tag)
    else {
        return Err(release_not_live(repo, tag).into());
    };
    ctx.confirm_or_cancel(&format!(
        "Unpublish sealed release {tag} of {}? (one document, {})",
        s.repo.display(),
        cost_line(
            forge_import::budget::sealed_release_credits(false, 0),
            ctx.usd_price()
        )
    ))?;
    let input = ReleaseInput {
        tag_name: tag.to_string(),
        yanked: Some(live.yanked),
        unpublished: true,
        ..ReleaseInput::default()
    };
    let before = s.balance().await;
    let written = collab
        .create_release_stored(&s.repo, &input, None)
        .await
        .map_err(|e| anyhow::Error::from(e).context("nothing was written"))?;
    let spent = s.spent_since(before).await;
    let price = ctx.usd_price();
    ctx.emit(
        json!({
            "status": "unpublished",
            "tag": tag,
            "sealed": true,
            "documentId": written.document_id,
            "id": written.document_id,
            "warnings": written.warnings,
            "cost": cost_json(spent, price),
        }),
        || {
            println!(
                "✓ unpublished sealed release {tag} of {} · {}",
                s.repo.display(),
                cost_line(spent, price)
            );
            print_warnings(&written.warnings);
        },
    );
    Ok(())
}

/// `--draft` and `--prerelease` on a public repository: they are sealed-only flags (§16.2).
fn refuse_sealed_only_flags(args: &ReleaseCreateArgs) -> Result<()> {
    if args.draft.is_some() || args.prerelease.is_some() {
        return Err(crate::errors::usage(
            "--draft and --prerelease are for a private repository's sealed releases; a public \
             release is a pre-release when its tag has a pre-release suffix (-rc.1)",
        ));
    }
    Ok(())
}

/// The `--asset` files, by the names an upload records.
fn read_release_files(paths: &[PathBuf]) -> Result<Vec<ReleaseFile>> {
    paths
        .iter()
        .map(|p| {
            let name = upload_name(p)
                .context("an asset path needs a file name")?
                .to_string();
            let bytes = std::fs::read(p).with_context(|| format!("reading {}", p.display()))?;
            Ok(ReleaseFile { name, bytes })
        })
        .collect()
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

/// The quote for a sealed release revision: the document, and a new asset list's manifest when
/// there are new files or notes (which may move into it), naming each target's URIs.
fn sealed_quote<F, T>(
    files: &[F],
    args: &ReleaseCreateArgs,
    targets: Option<&(Vec<T>, usize)>,
) -> u64 {
    let new_list = !files.is_empty() || !args.notes.is_empty();
    let targets = targets.map_or(1, |t| t.0.len() as u64);
    forge_import::budget::sealed_release_credits(new_list, targets)
}

/// The longest URI an uploaded asset records (`ReleaseAsset::uris`), for a quote made before
/// the upload names them.
const MAX_ASSET_URI_BYTES: usize = 300;

/// The quote for a public release revision (QW2-020): the revision [`superseding_input`] would
/// write, with each new asset recorded at its longest (a full SHA-256, and one URI of
/// [`MAX_ASSET_URI_BYTES`] per storage target, up to [`MAX_ASSET_URIS`]).
fn release_quote(existing: Option<&Release>, args: &ReleaseCreateArgs, targets: usize) -> u64 {
    let placeholders = args
        .assets
        .iter()
        .map(|p| ReleaseAsset {
            name: upload_name(p).unwrap_or_default().to_string(),
            sha256: "0".repeat(64),
            size_bytes: u64::MAX,
            uris: vec!["u".repeat(MAX_ASSET_URI_BYTES); targets.min(MAX_ASSET_URIS)],
            uri: None,
        })
        .collect();
    revision_quote(&superseding_input(existing, args, placeholders))
}

/// The quote for writing `input` as a public release revision: its text and its asset list as
/// stored (JSON).
fn revision_quote(input: &ReleaseInput) -> u64 {
    // longer notes are stored apart (forge-v2.md §6.3): the field holds at most its cap
    let notes = input
        .notes
        .len()
        .min(forge_core::collab::long_body::FIELD_MAX);
    let text = input.tag_name.len() + input.name.len() + notes;
    let assets = serde_json::to_string(&input.assets).map_or(0, |j| j.len());
    crate::quote::release(text as u64, assets as u64)
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
        ..ReleaseInput::default()
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
            "a maintainer re-publishes it with the file: `dg release create {repo} --tag {tag} --asset <file>`"
        ))
        .note("nothing was downloaded: dg only saves bytes it can check against the recorded hash")
    })
}

fn asset_json(a: &ReleaseAsset) -> serde_json::Value {
    json!({ "name": a.name, "sha256": a.sha256, "sizeBytes": a.size_bytes, "uris": a.uris })
}

/// The assets of each current release whose list is sealed (§16.5), by release document id:
/// the opened list, or why it could not be opened.
type SealedLists =
    std::collections::BTreeMap<String, std::result::Result<Vec<ReleaseAsset>, String>>;

/// What `dg release list` reads.
struct Read {
    /// The releases (newest per tag, newest first) and the superseded revisions.
    list: ReleaseList,
    /// For a maintainer, the live releases (`$id`s) whose asset list was uploaded under an old
    /// key (§16.5).
    late: Vec<String>,
    /// Why that could not be checked (a maintainer's only): the lists are then not judged, and
    /// the output says so rather than staying silent.
    late_error: Option<String>,
    /// The current releases' sealed asset lists, opened.
    sealed: SealedLists,
}

/// The releases of `repo`. A private repository's are opened with the identity's keys and
/// folded (§16.3); for a maintainer, also the live releases whose asset list was uploaded under
/// an old key (§16.5); and the current releases' sealed asset lists, opened (QW2-086: `assets`
/// was `[]` for them).
async fn read_releases(ctx: &Ctx, repo: &str) -> Result<Read> {
    // No key is opened to read them for a public repository (L-12).
    let s = Reader::open(ctx, repo).await?;
    let collab = s.collab();
    let list = collab.releases(&s.repo).await?;
    let maintainer = s.repo.visibility == Visibility::Private
        && matches!(
            collab.signer_role(&s.repo).await,
            Ok(Some(Role::Maintainer))
        );
    // A warning, never a failure: a check that could not be made is said, not skipped.
    let (late, late_error) = if maintainer {
        match collab.late_asset_lists(&s.repo, &list).await {
            Ok(late) => (late, None),
            Err(e) => (Vec::new(), Some(e.to_string())),
        }
    } else {
        (Vec::new(), None)
    };
    // Each list is a Platform read and a storage fetch: opened side by side, so one slow copy
    // does not hold up the others.
    let opening = list.current.iter().filter_map(|r| {
        let fields = r
            .sealed
            .as_ref()
            .map(|s| &s.fields)
            .filter(|f| f.asset_manifest.is_some())?;
        let (collab, repo) = (&collab, &s.repo);
        Some(async move {
            let opened = collab
                .release_manifest(repo, fields)
                .await
                .map(|m| {
                    m.assets
                        .into_iter()
                        .map(|e| Wanted::from_manifest(e).asset)
                        .collect()
                })
                .map_err(|e| e.to_string());
            (r.document_id.clone(), opened)
        })
    });
    let sealed: SealedLists = futures::future::join_all(opening)
        .await
        .into_iter()
        .collect();
    Ok(Read {
        list,
        late,
        late_error,
        sealed,
    })
}

/// The line under a release whose sealed asset list did not open: the list's assets are not
/// shown (the JSON has `assets: null`), and why.
fn asset_list_not_opened(why: &str) -> String {
    format!(
        "the asset list could not be opened, so its assets are not shown: {}",
        crate::fmt::safe(&why.chars().take(200).collect::<String>())
    )
}

/// What a maintainer is told when `dg release list` could not check the asset lists for an
/// upload under an old key: none is judged, which is not the same as none being late.
fn late_check_failed(why: &str) -> String {
    format!(
        "could not check whether any asset list was uploaded under an old key (none is judged): {}",
        crate::fmt::safe(&why.chars().take(200).collect::<String>())
    )
}

/// The warning `dg release list` gives a maintainer for release `tag`, whose asset list was
/// uploaded under an old key (§16.5).
fn late_list_note(tag: &str) -> String {
    format!(
        "the asset list of release {tag} was uploaded under an old key, after the key was \
         rotated: a member removed since may be able to read it; publish the release again with \
         its files to seal a new list"
    )
}

/// `(draft, pre-release, yanked)`, as `dg release list` prints them after the tag.
fn labels(r: &Release) -> String {
    let mut out = String::new();
    for (on, label) in [
        (r.is_draft(), "draft"),
        (r.is_prerelease(), "pre-release"),
        (r.yanked, "yanked"),
    ] {
        if on {
            out.push_str(" (");
            out.push_str(label);
            out.push(')');
        }
    }
    out
}

/// The tags taken down by an unpublish: each tag not listed live whose newest revision (the
/// first in `previous`, which is newest first) unpublishes it.
fn unpublished_tags(list: &ReleaseList) -> Vec<&Release> {
    let mut seen = BTreeSet::new();
    list.previous
        .iter()
        .filter(|r| {
            !list.current.iter().any(|c| c.tag_name == r.tag_name)
                && !list.unknown_tags.contains(&r.tag_name)
        })
        .filter(|r| seen.insert(r.tag_name.as_str()))
        .filter(|r| r.is_unpublish())
        .collect()
}

/// The lines a private repository's list ends with when it is incomplete (§16.3).
fn incomplete_notes(list: &ReleaseList) -> Vec<String> {
    let mut out = Vec::new();
    if list.stale {
        out.push(
            "releases may be out of date: newer revisions are under a key you don't hold yet"
                .to_string(),
        );
    }
    if list.hidden > 0 {
        let earlier = if list.earlier_use > 0 {
            format!(
                " ({} sealed under a key this repository no longer uses)",
                list.earlier_use
            )
        } else {
            String::new()
        };
        out.push(format!(
            "{} could not be read{earlier}",
            crate::fmt::plural(list.hidden, "release revision")
        ));
    }
    out
}

/// Whether `r` keeps its asset list in a sealed kind-4 manifest (§16.5).
fn has_sealed_asset_list(r: &Release) -> bool {
    r.sealed
        .as_ref()
        .is_some_and(|s| s.fields.asset_manifest.is_some())
}

/// A release's assets as `dg release list` reports them: the recorded ones, or its sealed list
/// once opened; `None` for a sealed list that is not (a superseded revision's is never read).
fn listed_assets<'a>(r: &'a Release, sealed: &'a SealedLists) -> Option<&'a [ReleaseAsset]> {
    if !has_sealed_asset_list(r) {
        return Some(&r.assets);
    }
    sealed
        .get(&r.document_id)
        .and_then(|o| o.as_ref().ok())
        .map(Vec::as_slice)
}

/// A release's asset count as `dg release list` shows it.
fn asset_count(r: &Release, sealed: &SealedLists) -> String {
    match (has_sealed_asset_list(r), sealed.get(&r.document_id)) {
        (false, _) => crate::fmt::plural(r.assets.len(), "asset"),
        (true, Some(Ok(a))) => format!("{}, encrypted list", crate::fmt::plural(a.len(), "asset")),
        // the reason is [`asset_list_error`]'s, on a line of its own
        (true, _) => "sealed asset list (not opened)".to_string(),
    }
}

/// Why `r`'s sealed asset list is not listed (`assets` is `null`), for the JSON
/// (`assetListError`) and the line under the release: the reason it did not open, or that it was
/// never read (a superseded revision's list is not). `None` for a list that is listed.
fn asset_list_error(r: &Release, sealed: &SealedLists) -> Option<String> {
    if !has_sealed_asset_list(r) {
        return None;
    }
    match sealed.get(&r.document_id) {
        Some(Ok(_)) => None,
        Some(Err(e)) => Some(e.clone()),
        None => Some("not opened: only a current release's list is read".to_string()),
    }
}

async fn list(ctx: &Ctx, repo: &str) -> Result<()> {
    let Read {
        list,
        late,
        late_error,
        sealed,
    } = read_releases(ctx, repo).await?;
    let row = |r: &Release| {
        // Notes longer than the field (forge-v2.md §6.3): the list gives their first part and
        // the full text's length; the artifact holding the rest is not fetched for a list.
        let (notes, notes_full_bytes) = match forge_core::rules::long_body::parse(&r.notes) {
            forge_core::rules::long_body::LongBody::Plain => (r.notes.as_str(), None),
            forge_core::rules::long_body::LongBody::Continued { prefix, bytes, .. } => {
                (prefix, Some(bytes))
            }
            forge_core::rules::long_body::LongBody::Unsupported { prefix } => (prefix, None),
        };
        json!({
            "tag": r.tag_name,
            "name": r.name,
            "notes": notes,
            "notesFullBytes": notes_full_bytes,
            // the notes above are a prefix: the rest is in the sealed manifest (§16.2 flag 0x10)
            "notesContinue": r.sealed.as_ref().is_some_and(|s| s.fields.notes_continue),
            "yanked": r.yanked,
            // QW2-059: an unpublish revision is not another copy of the publish it took down.
            "unpublished": r.is_unpublish(),
            "delta": r.delta,
            "draft": r.is_draft(),
            "prerelease": r.is_prerelease(),
            "sealed": r.sealed.is_some(),
            "stateUnknown": list.unknown_tags.contains(&r.tag_name),
            "assetListUploadedLate": late.contains(&r.document_id),
            "publishedBy": r.publisher,
            "createdAt": r.created_at,
            // `null`: a sealed list that was not opened (`assetListError` says why).
            "assets": listed_assets(r, &sealed).map(|a| a.iter().map(asset_json).collect::<Vec<_>>()),
            "assetList": if has_sealed_asset_list(r) { "sealed" } else { "plain" },
            "assetListError": asset_list_error(r, &sealed),
        })
    };
    ctx.emit(
        json!({
            "count": list.count(),
            "releases": list.current.iter().map(row).collect::<Vec<_>>(),
            "previous": list.previous.iter().map(row).collect::<Vec<_>>(),
            "hidden": list.hidden,
            "earlierUse": list.earlier_use,
            "stale": list.stale,
            // a maintainer's check for lists uploaded under an old key that could not be made
            "assetListLateCheckError": late_error,
        }),
        || {
            let unpublished = unpublished_tags(&list);
            if list.current.is_empty() {
                println!(
                    "{}",
                    if unpublished.is_empty() {
                        "no releases"
                    } else {
                        "no published releases"
                    }
                );
            }
            for r in &list.current {
                println!(
                    "{}{}  {}  {}  published by {}",
                    r.tag_name,
                    labels(r),
                    r.name,
                    asset_count(r, &sealed),
                    r.publisher
                );
                if list.unknown_tags.contains(&r.tag_name) {
                    println!("  a newer revision of this release could not be read; its state is unknown");
                }
                if late.contains(&r.document_id) {
                    println!("  warning: {}", late_list_note(&r.tag_name));
                }
                if let Some(why) = asset_list_error(r, &sealed) {
                    println!("  {}", asset_list_not_opened(&why));
                }
            }
            for r in &unpublished {
                // A stale list may have it back already (a newer revision under a key not held).
                let restore = if list.stale {
                    ""
                } else {
                    "  (publish it again to restore it)"
                };
                println!(
                    "{}  unpublished by {}{restore}",
                    r.tag_name, r.publisher
                );
            }
            for note in incomplete_notes(&list) {
                println!("note: {note}");
            }
            if let Some(why) = &late_error {
                println!("note: {}", late_check_failed(why));
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
    /// `--force`: an existing file (or symlink, which is replaced, never followed) goes.
    /// Otherwise an existing one is kept.
    replace: bool,
}

/// Why `name` is not one plain file name that saves as itself on every system, or None. A
/// recorded asset name is the publisher's data: `download` saves under it only when it names
/// one new file in the chosen directory, and `create` refuses to record a name `download`
/// would refuse.
fn file_name_problem(name: &str) -> Option<&'static str> {
    // Bidi embeddings, overrides and isolates, LRM, RLM and ALM disguise a name (the web app's
    // publish form refuses them too).
    let disguising = |c: char| {
        matches!(c, '\u{200e}' | '\u{200f}' | '\u{61c}')
            || ('\u{202a}'..='\u{202e}').contains(&c)
            || ('\u{2066}'..='\u{2069}').contains(&c)
    };
    // A Windows device name, with or without an extension (`nul.txt` is the device too).
    let stem = name
        .split('.')
        .next()
        .unwrap_or_default()
        .trim_end_matches(' ')
        .to_ascii_uppercase();
    let device = ["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"].contains(&stem.as_str())
        || ["COM", "LPT"].iter().any(|p| {
            stem.strip_prefix(p).is_some_and(|n| {
                (n.len() == 1 && n.as_bytes()[0].is_ascii_digit())
                    || matches!(n, "\u{b9}" | "\u{b2}" | "\u{b3}")
            })
        });
    if name.is_empty() || name == "." || name == ".." {
        Some("it is not a file name")
    } else if name.contains(['/', '\\']) {
        Some("it is a path")
    } else if name.contains(':') {
        Some("it holds `:` (a drive or a stream on Windows)")
    } else if name.chars().any(|c| c.is_control() || disguising(c)) {
        Some("it holds control or text-direction characters")
    } else if name.ends_with(['.', ' ']) {
        Some("it ends in a dot or a space, which Windows drops")
    } else if device {
        Some("it is a device name on Windows")
    } else if name.eq_ignore_ascii_case(".git") {
        Some("git reads a `.git` file as a repository link")
    } else {
        None
    }
}

/// E201: the release recorded `name`, which [`file_name_problem`] refuses to save under.
fn not_a_file_name(name: &str, why: &str) -> anyhow::Error {
    UserError::new(
        codes::USAGE,
        format!(
            "the release names an asset {:?}, which is not saved under that name: {why}",
            crate::fmt::safe(name)
        ),
    )
    .fix("choose the file yourself: --asset <name> --output <file>")
    .note("nothing was downloaded")
    .into()
}

/// E201 before anything is uploaded: `dg release create` records each file's own name, and one
/// a download would refuse to save under is refused here (rename the file).
fn check_upload_names(paths: &[PathBuf]) -> Result<()> {
    for p in paths {
        let Some(why) = upload_name(p).and_then(file_name_problem) else {
            continue;
        };
        return Err(UserError::new(
            codes::USAGE,
            format!(
                "{} can't be published as a release asset: {why}",
                crate::fmt::safe(&p.display().to_string())
            ),
        )
        .fix("rename the file, then publish it")
        .note("nothing was uploaded or written")
        .into());
    }
    Ok(())
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
/// `--output` that is a directory (or ends in `/`): one file per asset, by its name, which
/// must be a plain file name ([`file_name_problem`]). Any other `--output`: that file, for
/// exactly one asset. An existing file is refused unless `force` (or it already holds the
/// asset's bytes). Every destination is checked before anything is downloaded.
fn plan_outputs(assets: &[(&str, &str)], output: Option<&Path>, force: bool) -> Result<Vec<Dest>> {
    let dest = |path: PathBuf, sha256: &str| {
        if !force && path.symlink_metadata().is_ok() && !already_saved(&path, sha256) {
            return Err(already_exists(&path));
        }
        Ok(Dest {
            path,
            replace: force,
        })
    };
    let dir = match output {
        None => PathBuf::new(),
        Some(p) if p.is_dir() || p.as_os_str().to_string_lossy().ends_with('/') => p.to_path_buf(),
        Some(file) if assets.len() == 1 => return Ok(vec![dest(file.to_path_buf(), assets[0].1)?]),
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
            // A recorded name is data anyone with the maintainer role wrote: it never chooses
            // a path, only one plain file in the directory.
            if let Some(why) = file_name_problem(name) {
                return Err(not_a_file_name(name, why));
            }
            let path = dir.join(name);
            if !seen.insert(name.to_lowercase()) {
                return Err(crate::errors::usage(format!(
                    "two assets of the release save as {}: download them one at a time, with --asset <name> --output <file>",
                    crate::fmt::safe(&path.display().to_string())
                )));
            }
            dest(path, sha256)
        })
        .collect()
}

/// E201: `path` is taken, and without `--force` a download never replaces a file.
fn already_exists(path: &Path) -> anyhow::Error {
    crate::errors::usage(format!(
        "{} already exists; pass --force to replace it, or --output <directory or file> to save elsewhere",
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
    // A downloaded asset is an ordinary file (0666 less the umask, as curl or a browser leaves
    // it), not the temporary file's private 0600 (QW-083).
    let mut builder = tempfile::Builder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        builder.permissions(std::fs::Permissions::from_mode(0o666));
    }
    let mut tmp = builder.tempfile_in(dir).map_err(fail)?;
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
    s: &Reader,
    repo: &str,
    tag: &str,
    asset_name: Option<&str>,
) -> Result<Vec<Wanted>> {
    let collab = s.collab();
    let list = collab.releases(&s.repo).await?;
    let unpublished = unpublished_tags(&list).iter().any(|r| r.tag_name == tag);
    let release = list
        .current
        .into_iter()
        .find(|r| r.tag_name == tag)
        .ok_or_else(|| no_release_to_download(repo, tag, unpublished))?;
    // A sealed release lists its assets in its sealed kind-4 manifest (§16.5).
    let mut assets: Vec<Wanted> = match release.sealed.as_ref() {
        Some(sealed) if sealed.fields.asset_manifest.is_some() => collab
            .release_manifest(&s.repo, &sealed.fields)
            .await?
            .assets
            .into_iter()
            .map(Wanted::from_manifest)
            .collect(),
        _ => release
            .assets
            .into_iter()
            .map(|asset| Wanted {
                asset,
                sealed: None,
            })
            .collect(),
    };
    assets.retain(|w| asset_name.is_none_or(|n| w.asset.name == n));
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

/// E102 for a download of `tag`, which has no live release: it was `unpublished` (it has
/// revisions, none live: QW3-073 said "not found" while `dg release list` showed it), or
/// there never was one.
fn no_release_to_download(repo: &str, tag: &str, unpublished: bool) -> anyhow::Error {
    if unpublished {
        crate::errors::not_found(
            format!("release {tag:?} of {repo} was unpublished: it has no assets to download"),
            format!(
                "a maintainer publishes it again with `dg release create {repo} --tag {tag}`; `dg release list {repo}` shows its revisions"
            ),
        )
    } else {
        crate::errors::not_found(
            format!("release {tag:?} not found in {repo}"),
            format!("`dg release list {repo}` lists its releases"),
        )
    }
}

/// One asset to download: its plaintext name, `sha256`, size and URIs, and for a sealed
/// release's sealed object, its manifest entry.
struct Wanted {
    asset: ReleaseAsset,
    sealed: Option<ManifestAsset>,
}

impl Wanted {
    /// A manifest entry: sealed when it names a sealed object, else an external link (§16.5).
    fn from_manifest(e: ManifestAsset) -> Self {
        Self {
            asset: ReleaseAsset {
                name: e.name.clone(),
                sha256: e.sha256.clone(),
                size_bytes: e.size_bytes,
                uris: e.uris.clone(),
                uri: None,
            },
            sealed: e.sealed_sha256.is_some().then_some(e),
        }
    }
}

/// One asset's verified bytes. A sealed object must hash to its `sealedSha256`, then opens,
/// truncated to its size and checked against its `sha256` (§16.5); anything else must hash to
/// its `sha256`.
async fn fetch_asset(
    reader: &PackReader,
    collab: &forge_core::collab::v2::Collab<'_>,
    repo: &forge_core::scope::RepoRef,
    w: &Wanted,
) -> Result<Vec<u8>> {
    let a = &w.asset;
    // a sealed entry's `uris` are its asset's (`Wanted::from_manifest`)
    let (hash, size) = match &w.sealed {
        Some(e) => (
            e.sealed_sha256.clone().unwrap_or_default(),
            e.sealed_size_bytes,
        ),
        None => (
            a.sha256.to_ascii_lowercase(),
            (a.size_bytes > 0).then_some(a.size_bytes),
        ),
    };
    let bytes = reader
        .fetch_verified(&a.uris, &hash, size, None)
        .await
        .with_context(|| format!("downloading and verifying {}", a.name))?;
    let Some(e) = &w.sealed else {
        return Ok(bytes);
    };
    collab
        .open_release_asset(repo, e, &bytes)
        .await
        .with_context(|| format!("decrypting and verifying {}", a.name))
}

/// Download a release's assets (every one, or `--asset`), accepting only bytes that hash to
/// the recorded sha256. A sealed asset is checked against its `sealedSha256`, decrypted,
/// truncated to its size, then checked against its plaintext `sha256` (§16.5).
async fn download(
    ctx: &Ctx,
    repo: &str,
    tag: &str,
    asset_name: Option<&str>,
    output: Option<PathBuf>,
    force: bool,
) -> Result<()> {
    // No key is opened to read them for a public repository (L-12).
    let s = Reader::open(ctx, repo).await?;
    let wanted = assets_to_download(&s, repo, tag, asset_name).await?;
    let assets: Vec<&ReleaseAsset> = wanted.iter().map(|w| &w.asset).collect();
    // The gateways the uploaders recorded reach their nodes: try them before the shared list.
    let reader = PackReader::from_user_config().prefer_gateways(
        forge_core::storage::read::repo_gateways(assets.iter().flat_map(|a| a.uris.iter())),
    );
    // Before anything is downloaded: every asset has a copy this reader follows (not plain
    // http, this machine, a private network, a bucket with no profile here: say that rather
    // than let an empty candidate list read as "not found"), and every destination is free.
    for w in &wanted {
        let a = &w.asset;
        if s.repo.visibility == Visibility::Private && w.sealed.is_none() && !ctx.json {
            // an import's link to its source: nothing sealed, and it contacts that host
            eprintln!(
                "note: {} is an external link, not a sealed copy: downloading it contacts {}",
                crate::fmt::safe(&a.name),
                a.uris
                    .first()
                    .map_or_else(String::new, |u| crate::fmt::safe(u).into_owned())
            );
        }
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
    let dests = plan_outputs(&planned, output.as_deref(), force)?;
    if let Some(dir) = dests.first().and_then(|d| d.path.parent()) {
        if !dir.as_os_str().is_empty() && !dir.exists() {
            std::fs::create_dir_all(dir).map_err(|e| save_failed(dir, &e))?;
        }
    }
    let collab = s.collab();
    let mut saved = Vec::new();
    for (w, dest) in wanted.iter().zip(&dests) {
        let asset = &w.asset;
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
        let bytes = fetch_asset(&reader, &collab, &s.repo, w).await?;
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
mod tag_tests {
    use super::require_tag;
    use forge_core::rules::RefState;

    fn tip() -> RefState {
        RefState::Resolved {
            oid: "a".repeat(40),
            author: "o".into(),
            created_at: 1,
        }
    }

    /// QW-037: a release for a tag the repository does not have is refused before anything is
    /// uploaded or signed; an existing tag, or a tag that already has a release, is not.
    #[test]
    fn a_release_needs_a_tag_the_repository_has() {
        let refs = || {
            vec![
                ("refs/heads/main".to_string(), tip()),
                ("refs/tags/v0.1.0".to_string(), tip()),
                ("refs/tags/v0.0.9".to_string(), RefState::Unborn),
            ]
        };
        assert!(require_tag(&refs(), "o/r", "v0.1.0", false).is_ok());
        let err = require_tag(&refs(), "o/r", "v9.9.9", false).unwrap_err();
        let u = forge_core::user_error::classify(
            err.chain(),
            &forge_core::user_error::ErrorContext::default(),
        );
        assert_eq!(u.code, "E102");
        assert!(
            u.message.contains("v9.9.9 is not a tag of o/r"),
            "{}",
            u.message
        );
        assert!(u.cause.unwrap().contains("its tags: v0.1.0"));
        assert!(u.fix[0].contains("git push origin v9.9.9"), "{:?}", u.fix);
        // a deleted tag is not a tag…
        assert!(require_tag(&refs(), "o/r", "v0.0.9", false).is_err());
        // …but its existing release can still get a new revision (yank, notes)
        assert!(require_tag(&refs(), "o/r", "v0.0.9", true).is_ok());
    }
}

#[cfg(test)]
mod download_tests {
    use super::*;

    /// QW3-073: an unpublished tag says so (and how to publish it again), not "not found".
    #[test]
    fn an_unpublished_release_says_it_was_unpublished() {
        let e = no_release_to_download("o/r", "v0.1.0", true);
        let u = e.downcast_ref::<UserError>().unwrap();
        assert_eq!(u.code, "E102");
        assert!(u.message.contains("was unpublished"), "{u:?}");
        assert!(
            u.fix[0].contains("dg release create o/r --tag v0.1.0"),
            "{u:?}"
        );
        let e = no_release_to_download("o/r", "v9", false);
        let u = e.downcast_ref::<UserError>().unwrap();
        assert_eq!(u.message, "release \"v9\" not found in o/r");
    }

    /// Assets named `names`, whose sha256 nothing on disk matches.
    fn plan(names: &[&str], output: Option<&Path>) -> Result<Vec<Dest>> {
        let assets: Vec<(&str, &str)> = names.iter().map(|n| (*n, "00")).collect();
        plan_outputs(&assets, output, false)
    }

    fn dests(names: &[&str], output: Option<&Path>) -> Result<Vec<(PathBuf, bool)>> {
        Ok(plan(names, output)?
            .into_iter()
            .map(|d| (d.path, d.replace))
            .collect())
    }

    fn dests_forced(names: &[&str], output: Option<&Path>) -> Result<Vec<(PathBuf, bool)>> {
        let assets: Vec<(&str, &str)> = names.iter().map(|n| (*n, "00")).collect();
        Ok(plan_outputs(&assets, output, true)?
            .into_iter()
            .map(|d| (d.path, d.replace))
            .collect())
    }

    /// L-22: `--output <dir>` saves every asset in it by name (it was "Is a directory").
    #[test]
    fn an_output_directory_takes_every_asset_by_name() {
        let dir = tempfile::tempdir().unwrap();
        let got = dests(&["a.tar.gz", "b.zip"], Some(dir.path())).unwrap();
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
        assert_eq!(dests(&["a"], Some(&file)).unwrap(), [(file.clone(), false)]);
        let two = plan(&["a", "b"], Some(&file)).unwrap_err();
        assert!(format!("{two:#}").contains("--output directory"), "{two:#}");
        std::fs::write(dir.path().join("a"), b"mine").unwrap();
        let exists = plan(&["a"], Some(dir.path())).unwrap_err();
        assert!(
            format!("{exists:#}").contains("already exists"),
            "{exists:#}"
        );
        // Two recorded names that land on one file when they differ only in case.
        let case = plan(&["README.txt", "readme.TXT"], Some(dir.path())).unwrap_err();
        assert!(format!("{case:#}").contains("two assets"), "{case:#}");
    }

    /// A recorded name is saved only as one plain file name: a path, a Windows drive, UNC or
    /// device name, a control character or a name Windows would change is refused, with or
    /// without an --output directory, and nothing is written.
    #[test]
    fn a_name_that_is_not_a_plain_file_name_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        for name in [
            "../x",
            "../../etc/b.zip",
            ".git/config",
            "/abs",
            "/etc/passwd",
            "C:\\x",
            "C:x",
            "c:",
            "\\\\server\\share",
            "\\\\server\\share\\x",
            "\\\\?\\C:\\x",
            "x/y",
            "x\\y",
            "x/",
            "\\x",
            ".",
            "..",
            "",
            ".git",
            ".GIT",
            "CON",
            "con.txt",
            "Nul",
            "nul.tar.gz",
            "COM1",
            "lpt9.bin",
            "COM\u{b9}",
            "CONIN$",
            "AUX .txt",
            "x.",
            "x ",
            "a:stream",
            "a\0b",
            "a\nb",
            "a\u{7f}b",
            "a\u{9b}b",
            "evil\u{202e}gpj.exe",
        ] {
            for output in [None, Some(dir.path())] {
                let err = plan(&[name], output).expect_err(name);
                let u = err.downcast_ref::<UserError>().unwrap();
                assert_eq!(u.code, "E201", "{name:?}: {u:?}");
                assert!(u.fix[0].contains("--output <file>"), "{name:?}: {u:?}");
            }
        }
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
        for name in [
            "a.tar.gz",
            "README",
            ".hidden",
            "a..b",
            "console.log",
            "COM10",
            "nulls.txt",
            "Ünïcode ✓.txt",
        ] {
            assert_eq!(
                dests(&[name], Some(dir.path())).unwrap(),
                [(dir.path().join(name), false)],
                "{name:?}"
            );
        }
    }

    /// An existing file is replaced only with --force, the --output file named too; a file
    /// already holding the asset's bytes is kept either way.
    #[test]
    fn an_existing_file_is_replaced_only_with_force() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("out.bin");
        std::fs::write(&file, b"mine").unwrap();
        std::fs::write(dir.path().join("a"), b"mine").unwrap();
        for output in [file.as_path(), dir.path()] {
            let err = plan_outputs(&[("a", "00")], Some(output), false).unwrap_err();
            assert!(format!("{err:#}").contains("--force"), "{err:#}");
        }
        assert_eq!(
            dests_forced(&["a"], Some(&file)).unwrap(),
            [(file.clone(), true)]
        );
        assert_eq!(
            dests_forced(&["a"], Some(dir.path())).unwrap(),
            [(dir.path().join("a"), true)]
        );
        // The same bytes: kept, not refused.
        let sha = PackMeta::for_bytes(b"mine").pack_hash;
        let d = plan_outputs(&[("a", sha.as_str())], Some(&file), false).unwrap();
        assert_eq!((d[0].path.as_path(), d[0].replace), (file.as_path(), false));
        assert_eq!(std::fs::read(&file).unwrap(), b"mine");
    }

    /// A symlink where an asset goes is never written through: refused without --force, and
    /// with it replaced by the file itself, its target untouched.
    #[cfg(unix)]
    #[test]
    fn a_symlink_at_the_destination_is_not_followed() {
        let dir = tempfile::tempdir().unwrap();
        let victim = dir.path().join("victim");
        std::fs::write(&victim, b"keep").unwrap();
        let link = dir.path().join("a");
        std::os::unix::fs::symlink(&victim, &link).unwrap();
        let sha = PackMeta::for_bytes(b"keep").pack_hash;
        // Even when the target holds the asset's bytes: the link is not "already saved".
        assert!(plan_outputs(&[("a", sha.as_str())], Some(dir.path()), false).is_err());
        assert!(plan_outputs(&[("a", "00")], Some(&link), false).is_err());
        let keep = Dest {
            path: link.clone(),
            replace: false,
        };
        assert!(save(&keep, b"evil").is_err());
        assert_eq!(std::fs::read(&victim).unwrap(), b"keep");
        save(
            &Dest {
                replace: true,
                ..keep
            },
            b"new",
        )
        .unwrap();
        assert!(link.symlink_metadata().unwrap().is_file());
        assert_eq!(std::fs::read(&link).unwrap(), b"new");
        assert_eq!(std::fs::read(&victim).unwrap(), b"keep");
    }

    /// `dg release create` refuses a file whose name a download would refuse.
    #[test]
    fn an_upload_with_a_name_a_download_refuses_is_refused() {
        for bad in ["CON.txt", "x.", "a:b", "a\u{202e}b"] {
            let err =
                check_upload_names(&[PathBuf::from("ok.bin"), PathBuf::from(bad)]).expect_err(bad);
            let u = err.downcast_ref::<UserError>().unwrap();
            assert!(
                u.message.contains(bad) && u.fix[0].contains("rename"),
                "{u:?}"
            );
        }
        check_upload_names(&[PathBuf::from("dist/app-1.0.tar.gz")]).unwrap();
    }

    /// A rerun after one asset failed resumes: a file already holding the asset's bytes
    /// (its sha256 matches) is kept and skipped, not refused.
    #[test]
    fn a_file_with_the_assets_bytes_is_already_saved() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a"), b"mine").unwrap();
        let sha = PackMeta::for_bytes(b"mine").pack_hash;
        let d = plan_outputs(&[("a", sha.as_str())], Some(dir.path()), false).unwrap();
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

    /// QW-083: a downloaded asset gets an ordinary file's mode (0666 less the umask), not the
    /// temporary file's private 0600.
    #[cfg(unix)]
    #[test]
    fn a_saved_asset_has_an_ordinary_mode() {
        use std::os::unix::fs::PermissionsExt as _;
        let umask = std::process::Command::new("sh")
            .args(["-c", "umask"])
            .output()
            .ok()
            .and_then(|o| u32::from_str_radix(String::from_utf8_lossy(&o.stdout).trim(), 8).ok())
            .unwrap_or(0o022);
        let dir = tempfile::tempdir().unwrap();
        let dest = Dest {
            path: dir.path().join("asset.tar.gz"),
            replace: false,
        };
        save(&dest, b"x").unwrap();
        let mode = std::fs::metadata(&dest.path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o666 & !umask, "mode {mode:o}");
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
            sealed: None,
        }
    }

    /// QW2-059: an unpublish revision is told apart from the publish it took down, and its tag
    /// is listed once as unpublished.
    #[test]
    fn an_unpublish_is_named_and_its_tag_listed_once() {
        let rev = |id: &str, tag: &str, at: u64, delta: i64| Release {
            document_id: id.into(),
            tag_name: tag.into(),
            created_at: at,
            delta,
            ..current()
        };
        let list = ReleaseList {
            current: vec![rev("L2", "v2", 30, 1)],
            // Newest first: v1's newest is its unpublish; v3's newest is a publish again.
            previous: vec![
                rev("U3", "v3", 25, -1),
                rev("U1", "v1", 20, -1),
                rev("V2OLD", "v2", 15, 1),
                rev("V1", "v1", 10, 1),
                rev("V3", "v3", 5, 1),
            ],
            unknown_tags: vec!["v3".into()],
            ..ReleaseList::default()
        };
        assert!(rev("U1", "v1", 20, -1).is_unpublish());
        assert!(!rev("V1", "v1", 10, 1).is_unpublish());
        let ids: Vec<_> = unpublished_tags(&list)
            .iter()
            .map(|r| r.document_id.clone())
            .collect();
        assert_eq!(ids, ["U1"], "v2 is live and v3's state is unknown");
    }

    /// QW2-086: a sealed release lists the assets of its opened list, never the empty `assets`
    /// field it stores; one whose list did not open says why, and lists none (`null`).
    #[test]
    fn a_sealed_release_lists_its_opened_assets() {
        let mut sealed_release = current();
        sealed_release.assets = Vec::new();
        sealed_release.sealed = Some(forge_core::collab::SealedRelease {
            epoch: 1,
            fields: forge_core::private::release::ReleaseFields {
                asset_manifest: Some("ab".repeat(32)),
                ..Default::default()
            },
        });
        let mut lists = SealedLists::new();
        lists.insert("d1".into(), Ok(vec![asset("app.txt", 'c')]));
        assert_eq!(
            asset_count(&sealed_release, &lists),
            "1 asset, encrypted list"
        );
        assert_eq!(
            names(listed_assets(&sealed_release, &lists).unwrap()),
            [("app.txt".to_string(), 'c')]
        );
        assert_eq!(asset_list_error(&sealed_release, &lists), None);
        lists.insert("d1".into(), Err("no copy answered".into()));
        assert_eq!(
            asset_count(&sealed_release, &lists),
            "sealed asset list (not opened)"
        );
        assert!(listed_assets(&sealed_release, &lists).is_none());
        // the reason is given, for the JSON and as a line under the release
        let why = asset_list_error(&sealed_release, &lists).unwrap();
        assert_eq!(why, "no copy answered");
        assert_eq!(
            asset_list_not_opened(&why),
            "the asset list could not be opened, so its assets are not shown: no copy answered"
        );
        // a list nobody read (a superseded revision's) is `null` with a reason too, never silent
        let unread = SealedLists::new();
        assert!(listed_assets(&sealed_release, &unread).is_none());
        assert_eq!(
            asset_count(&sealed_release, &unread),
            "sealed asset list (not opened)"
        );
        assert!(asset_list_error(&sealed_release, &unread)
            .unwrap()
            .contains("not opened"));
        // a public release lists what it stores
        let public = current();
        assert_eq!(asset_count(&public, &lists), "2 assets");
        assert_eq!(asset_list_error(&public, &lists), None);
        assert!(late_check_failed("node down").contains("none is judged): node down"));
        assert_eq!(listed_assets(&public, &lists).map(<[_]>::len), Some(2));
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
        assert_eq!(input.yanked, Some(true));
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
        assert_ne!(
            input.yanked,
            Some(true),
            "a republish without --yanked un-yanks"
        );
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
