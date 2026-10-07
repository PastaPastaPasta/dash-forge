//! `dg storage mirror add | list | remove` (UPDATE-1 `packMirror`): record another copy of a
//! public repository's pack. Readers (dg, git-remote-dash, the web) try recorded mirrors only
//! when every copy the repository's manifests name has failed, members' mirrors first, and use
//! the bytes only when they hash to the pack ([`forge_core::rules::pack_mirror`]).

use anyhow::{bail, Result};
use serde_json::json;

use forge_core::pack_mirror::{
    check_serves, delete_mirror, mirror_of_owner, mirrors_by, mirrors_of, record_mirror,
    uri_problem_words, PackMirror, ServeCheck, DOC_PACK_MIRROR,
};
use forge_core::rules::pack_mirror::{check_mirror_uris, UriCheck};
use forge_core::rules::v2::Visibility;
use forge_core::storage::publish::{publish_problem, PublishProblem};
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

/// The addresses among `uris` other readers never follow: loopback and private-network hosts
/// (their egress guard refuses them), each as written.
fn private_addresses(uris: &[String]) -> Vec<&str> {
    uris.iter()
        .filter(|u| matches!(publish_problem(u), Some(PublishProblem::PrivateHost)))
        .map(String::as_str)
        .collect()
}

/// E201 for addresses no mirror may hold, or that other readers never fetch (checked before
/// anything is read or signed).
fn refuse_unusable(uris: &[String]) -> Result<()> {
    let check = check_mirror_uris(uris);
    if matches!(check, UriCheck::Refused { .. }) {
        return Err(bad_uris(&check));
    }
    let private = private_addresses(uris);
    if !private.is_empty() {
        bail!(UserError::new(
            codes::USAGE,
            format!(
                "mirror not recorded: {} {} on this machine or a private network",
                private
                    .iter()
                    .map(|u| safe(u).into_owned())
                    .collect::<Vec<_>>()
                    .join(", "),
                if private.len() == 1 { "is" } else { "are" }
            )
        )
        .cause("other readers never fetch from a loopback or private-network address")
        .fix("record a public https address, or an ipfs:// CID")
        .note("checked before anything was signed; nothing was written or paid"));
    }
    Ok(())
}

/// The addresses must serve the pack: a mirror that cannot is a record nobody can use. E504 when
/// one serves other bytes, E503 when none answers with it.
async fn require_serves(uris: &[String], pack: &str, size: Option<u64>) -> Result<()> {
    let reader = PackReader::from_user_config();
    let fix = "check the addresses, or pass --no-verify to record them anyway";
    match check_serves(&reader, uris, pack, size).await {
        ServeCheck::Serves => Ok(()),
        ServeCheck::WrongBytes(why) => bail!(UserError::new(
            codes::INTEGRITY,
            "mirror not recorded: an address serves other bytes than that pack"
        )
        .cause(why)
        .fix(fix)
        .note("nothing was written or paid")),
        ServeCheck::Unreachable(why) => bail!(UserError::new(
            codes::PACKS_UNREADABLE,
            "mirror not recorded: none of the addresses serves that pack"
        )
        .cause(why)
        .fix(fix)
        .note("nothing was written or paid")),
    }
}

async fn add(ctx: &Ctx, repo: &str, pack: &str, uris: &[String], no_verify: bool) -> Result<()> {
    refuse_unusable(uris)?;
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
    let core = s.client.fetch_contract(&s.repo.forge().core).await?;
    // One record per pack each: a second would be refused at consensus, after paying for it.
    if let Some(mine) = mirror_of_owner(&s.client, &core, &s.repo, &pack, &s.identity.id()).await? {
        bail!(UserError::new(
            codes::ALREADY_EXISTS,
            format!(
                "mirror not recorded: you already have a mirror of pack {} ({})",
                &pack[..12],
                mine.id
            )
        )
        .fix(format!(
            "to change its addresses, remove it first: `dg storage mirror remove {}`",
            mine.id
        ))
        .note("nothing was written or paid"));
    }
    if !no_verify {
        let size = (manifest.size_bytes > 0).then_some(manifest.size_bytes);
        require_serves(uris, &pack, size).await?;
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
        let svc = r.service();
        let manifests = svc.read_pack_manifests(&r.repo).await?;
        // Each pack once (a pack has a manifest per copy).
        let hashes: std::collections::BTreeSet<String> =
            manifests.iter().map(|m| hex::encode(m.pack_hash)).collect();
        let members: Vec<String> = svc.copy_roles(&r.repo).await?.into_keys().collect();
        let mut out = Vec::new();
        for h in hashes {
            out.extend(mirrors_of(&r.client, &core, &r.repo, &h, &members).await?);
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

#[cfg(test)]
mod tests {
    use super::private_addresses;

    #[test]
    fn loopback_and_private_hosts_are_refused_public_ones_kept() {
        let uris: Vec<String> = [
            "https://m.example.com/p",
            "https://127.0.0.1:8443/p",
            "https://192.168.1.4/p",
            "https://localhost/p",
            "ipfs://bafyq",
        ]
        .map(String::from)
        .to_vec();
        assert_eq!(
            private_addresses(&uris),
            [
                "https://127.0.0.1:8443/p",
                "https://192.168.1.4/p",
                "https://localhost/p"
            ]
        );
    }
}
