//! `dg storage mirror add | list | remove` (UPDATE-1 `packMirror`): record another copy of a
//! public repository's pack. Readers (dg, git-remote-dash, the web) try recorded mirrors only
//! when every copy the repository's manifests name has failed, members' mirrors first, and use
//! the bytes only when they hash to the pack ([`forge_core::rules::pack_mirror`]).

use anyhow::{bail, Result};
use serde_json::json;

use forge_core::pack_mirror::{
    delete_mirror, mirrors_by, mirrors_of, record_mirror, uri_problem_words, PackMirror,
    DOC_PACK_MIRROR,
};
use forge_core::rules::pack_mirror::{check_mirror_uris, UriCheck};
use forge_core::rules::v2::Visibility;
use forge_core::storage::read::PackReader;
use forge_core::user_error::{codes, UserError};

use crate::common::{Reader, Session};
use crate::context::Ctx;
use crate::fmt::{cost_json, cost_line, safe};
use crate::StorageMirrorCommand;

/// Estimate of one `packMirror` with its `repo` reference (73.6M measured on sakura, 2026-10-05).
const MIRROR_CREDITS: u64 = 75_000_000;

/// Dispatch `dg storage mirror`.
pub async fn run(ctx: &Ctx, cmd: &StorageMirrorCommand) -> Result<()> {
    match cmd {
        StorageMirrorCommand::Add {
            repo,
            pack,
            uris,
            no_verify,
        } => add(ctx, repo, pack, uris, *no_verify).await,
        StorageMirrorCommand::List { repo, mine } => list(ctx, repo.as_deref(), *mine).await,
        StorageMirrorCommand::Remove { id } => remove(ctx, id).await,
    }
}

/// E204 for addresses the shared rule refuses (checked before anything is read or signed).
fn bad_uris(check: &UriCheck) -> anyhow::Error {
    UserError::new(
        codes::USAGE,
        format!(
            "mirror not recorded: {}",
            uri_problem_words(check).unwrap_or_default()
        ),
    )
    .note("checked before anything was signed; nothing was written or paid")
    .into()
}

async fn add(ctx: &Ctx, repo: &str, pack: &str, uris: &[String], no_verify: bool) -> Result<()> {
    let check = check_mirror_uris(uris);
    if matches!(check, UriCheck::Refused { .. }) {
        return Err(bad_uris(&check));
    }
    let pack = pack.to_ascii_lowercase();
    if pack.len() != 64 || !pack.bytes().all(|b| b.is_ascii_hexdigit()) {
        bail!(crate::errors::usage(format!(
            "{pack:?} is not a pack hash: 64 hex digits, as `dg storage status {repo}` lists them"
        )));
    }
    let s = Session::open(ctx, repo).await?;
    if s.repo.visibility == Visibility::Private {
        bail!(UserError::new(
            codes::PRIVATE_UNSUPPORTED,
            format!("mirror not recorded: {} is private", s.repo.display())
        )
        .cause("a private repository's packs are sealed to its members; readers take mirrors for public repositories only"));
    }
    // The pack must be one the repository lists: readers ignore a mirror of anything else.
    let svc = forge_core::repo::RepoService::new(&s.client, &s.identity, &s.bridge);
    let manifests = svc.read_pack_manifests(&s.repo).await?;
    let Some(manifest) = manifests.iter().find(|m| hex::encode(m.pack_hash) == pack) else {
        bail!(UserError::new(
            codes::NOT_FOUND,
            format!(
                "mirror not recorded: {} lists no pack {pack}",
                s.repo.display()
            )
        )
        .fix(format!("`dg storage status {repo}` lists its packs")));
    };
    // The addresses must serve the pack (unless told not to check): a mirror that cannot is a
    // record nobody can use.
    if !no_verify {
        let reader = PackReader::from_user_config();
        let size = (manifest.size_bytes > 0).then_some(manifest.size_bytes);
        if let Err(e) = reader.fetch_verified(uris, &pack, size, None).await {
            bail!(UserError::new(
                codes::INTEGRITY,
                "mirror not recorded: the addresses do not serve that pack"
            )
            .cause(format!("{e:#}"))
            .fix("check the addresses, or pass --no-verify to record them anyway")
            .note("nothing was written or paid"));
        }
    }
    let price = ctx.usd_price();
    ctx.confirm_or_cancel(&format!(
        "Record a mirror of pack {} of {} at {}? ({})",
        &pack[..12],
        s.repo.display(),
        uris.iter()
            .map(|u| safe(u).into_owned())
            .collect::<Vec<_>>()
            .join(", "),
        cost_line(MIRROR_CREDITS, price)
    ))?;
    let core = s.client.fetch_contract(&s.repo.forge().core).await?;
    let engine = forge_core::profile::engine(&s.client, &s.identity, &s.bridge)?;
    let before = s.balance().await;
    let id = record_mirror(&engine, &core, &s.repo, &pack, uris).await?;
    let spent = s.spent_since(before).await;
    ctx.emit(
        json!({
            "status": "recorded",
            "repo": s.repo.display(),
            "packHash": pack,
            "uris": uris,
            "documentId": id,
            "cost": cost_json(spent, price),
        }),
        || {
            println!(
                "✓ recorded a mirror of pack {} of {} ({id}) · {}",
                &pack[..12],
                s.repo.display(),
                cost_line(spent, price)
            );
        },
    );
    Ok(())
}

fn mirror_json(m: &PackMirror) -> serde_json::Value {
    json!({
        "documentId": m.id,
        "by": m.owner_id,
        "repoId": m.repo_id,
        "packHash": m.pack_hash,
        "kind": m.kind,
        "uris": m.uris,
        "createdAt": m.created_at,
    })
}

async fn list(ctx: &Ctx, repo: Option<&str>, mine: bool) -> Result<()> {
    let mirrors = if mine {
        let client = ctx.connect().await?;
        let me = match ctx.identity_id_hint() {
            Some(id) => id,
            None => ctx.load_bridge()?.identity_id,
        };
        let forge = ctx.target.require_v2()?;
        let core = client.fetch_contract(&forge.core).await?;
        mirrors_by(&client, &core, &me).await?
    } else {
        let r = Reader::open_unsealed(ctx, repo.unwrap_or_default()).await?;
        let core = r.client.fetch_contract(&r.repo.forge().core).await?;
        let manifests = r.service().read_pack_manifests(&r.repo).await?;
        let mut hashes: Vec<String> = manifests.iter().map(|m| hex::encode(m.pack_hash)).collect();
        hashes.dedup();
        let mut out = Vec::new();
        for h in hashes {
            out.extend(mirrors_of(&r.client, &core, &r.repo, &h).await?);
        }
        out
    };
    ctx.emit(
        json!({ "mirrors": mirrors.iter().map(mirror_json).collect::<Vec<_>>() }),
        || {
            if mirrors.is_empty() {
                println!("no pack mirrors recorded");
                return;
            }
            for m in &mirrors {
                println!(
                    "{}  pack {}  by {}  {}",
                    m.id,
                    &m.pack_hash[..12.min(m.pack_hash.len())],
                    m.owner_id,
                    m.uris
                        .iter()
                        .map(|u| safe(u).into_owned())
                        .collect::<Vec<_>>()
                        .join(" ")
                );
            }
        },
    );
    Ok(())
}

async fn remove(ctx: &Ctx, id: &str) -> Result<()> {
    let (client, bridge, identity) = ctx.connect_with_identity().await?;
    let forge = ctx.target.require_v2()?;
    let core = client.fetch_contract(&forge.core).await?;
    let mine = mirrors_by(&client, &core, &identity.id()).await?;
    if !mine.iter().any(|m| m.id == id) {
        bail!(UserError::new(
            codes::NOT_FOUND,
            format!("mirror not removed: you have no mirror record {id}")
        )
        .fix("`dg storage mirror list --mine` lists yours; only its writer can delete a record"));
    }
    ctx.confirm_or_cancel(&format!(
        "Delete your mirror record {id}? (part of its storage fee is refunded)"
    ))?;
    let engine = forge_core::profile::engine(&client, &identity, &bridge)?;
    delete_mirror(&engine, &core, id).await?;
    ctx.emit(
        json!({ "status": "removed", "documentId": id, "type": DOC_PACK_MIRROR }),
        || println!("✓ removed mirror record {id}"),
    );
    Ok(())
}
