//! `dg storage mirror add | list | remove` (UPDATE-1 `packMirror`): record another copy of a
//! public repository's pack. Readers (dg, git-remote-dash, the web) try recorded mirrors only
//! when every copy the repository's manifests name has failed, members' mirrors first, and use
//! the bytes only when they hash to the pack ([`forge_core::rules::pack_mirror`]).

use anyhow::{bail, Result};
use serde_json::json;

use forge_core::pack_mirror::{
    check_serves, delete_mirror, mirror_of_owner, mirrors_by, mirrors_of, record_mirror,
    require_support, uri_problem_words, PackMirror, ServeCheck, DOC_PACK_MIRROR,
};
use forge_core::rules::pack_mirror::{check_mirror_uris, UriCheck};
use forge_core::rules::v2::Visibility;
use forge_core::storage::egress::{may_fetch, Trusted};
use forge_core::storage::publish::{publish_problem, PublishProblem};
use forge_core::storage::read::PackReader;
use forge_core::user_error::{codes, UserError};

use crate::common::{resolve_for, Reader, RepoRef, Session};
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

/// E201 for addresses the shared rule refuses (checked before anything is read or signed).
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

/// Why other readers never use an address ([`unusable_addresses`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Unusable {
    /// Not a URL a reader can parse (`https://host:99999/p`).
    Invalid,
    /// Loopback, a private network or another address a reader's egress guard refuses.
    Private,
    /// A temporary tunnel name (`trycloudflare.com`, `ts.net`), which push refuses too.
    Tunnel,
}

/// The `https://` addresses among `uris` other readers never fetch, each as written: the
/// readers' own egress rule ([`may_fetch`], with no configured origins, since another reader has
/// none of this machine's), and the temporary tunnels a push refuses to record.
fn unusable_addresses(uris: &[String]) -> Vec<(&str, Unusable)> {
    let none = Trusted::default();
    uris.iter()
        .filter(|u| u.starts_with("https://"))
        .filter_map(|u| {
            let problem = publish_problem(u);
            let why = if matches!(problem, Some(PublishProblem::NotAUrl)) {
                Unusable::Invalid
            } else if !may_fetch(u, &none) || matches!(problem, Some(PublishProblem::PrivateHost)) {
                Unusable::Private
            } else if matches!(problem, Some(PublishProblem::TemporaryTunnel)) {
                Unusable::Tunnel
            } else {
                return None;
            };
            Some((u.as_str(), why))
        })
        .collect()
}

/// E201 for addresses no mirror may hold, or that other readers never fetch (checked before
/// anything is read or signed).
fn refuse_unusable(uris: &[String]) -> Result<()> {
    let check = check_mirror_uris(uris);
    if matches!(check, UriCheck::Refused { .. }) {
        return Err(bad_uris(&check));
    }
    let unusable = unusable_addresses(uris);
    // The first kind found, in the order of how final it is.
    let Some(kind) = [Unusable::Invalid, Unusable::Private, Unusable::Tunnel]
        .into_iter()
        .find(|k| unusable.iter().any(|(_, why)| why == k))
    else {
        return Ok(());
    };
    let named = unusable
        .iter()
        .filter(|(_, why)| *why == kind)
        .map(|(u, _)| safe(u).into_owned())
        .collect::<Vec<_>>();
    let many = named.len() > 1;
    let (what, cause) = match kind {
        Unusable::Invalid => (
            format!("{} {} a valid address", named.join(", "), if many { "are not" } else { "is not" }),
            "a reader cannot request an address it cannot parse",
        ),
        Unusable::Private => (
            format!(
                "{} {} on this machine or a private network",
                named.join(", "),
                if many { "are" } else { "is" }
            ),
            "other readers never fetch from a loopback, private-network or otherwise non-public address",
        ),
        Unusable::Tunnel => (
            format!(
                "{} {} a temporary tunnel address",
                named.join(", "),
                if many { "are" } else { "is" }
            ),
            "a quick tunnel's name changes when it restarts, so the record would soon point nowhere",
        ),
    };
    bail!(
        UserError::new(codes::USAGE, format!("mirror not recorded: {what}"))
            .cause(cause)
            .fix("record a stable public https address, or an ipfs:// CID")
            .note("checked before anything was signed; nothing was written or paid")
    );
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

/// E102: `repo` lists no pack `pack`. The hash is shortened to 12 digits, as elsewhere: in
/// full, 64 hex digits look like a raw private key, which every rendered error redacts (Q5).
fn unlisted_pack(display: &str, repo: &str, pack: &str) -> UserError {
    UserError::new(
        codes::NOT_FOUND,
        format!(
            "mirror not recorded: {display} lists no pack {}…",
            pack.get(..12).unwrap_or(pack)
        ),
    )
    .fix(format!("`dg storage status {repo}` lists its packs"))
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
        bail!(unlisted_pack(&s.repo.display(), repo, &pack));
    };
    let core = s.client.fetch_contract(&s.repo.forge().core).await?;
    // Before the download and the cost prompt: a network without the type cannot record one.
    require_support(&core)?;
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

pub(crate) fn mirror_json(m: &PackMirror, repo: Option<&str>) -> serde_json::Value {
    let mut v = json!({
        "documentId": m.id,
        "by": m.owner_id,
        "repoId": m.repo_id,
        "packHash": m.pack_hash,
        "kind": m.kind,
        "uris": m.uris,
        "createdAt": m.created_at,
    });
    if let Some(repo) = repo {
        v["repo"] = json!(repo);
    }
    v
}

/// `owner/name` of each repository `mirrors` are for, by repo id; a repository that no longer
/// resolves has no entry (its id is shown instead).
async fn repo_names(
    client: &forge_core::platform::PlatformClient,
    mirrors: &[PackMirror],
) -> std::collections::BTreeMap<String, String> {
    let mut names = std::collections::BTreeMap::new();
    for m in mirrors {
        if names.contains_key(&m.repo_id) {
            continue;
        }
        if let Ok(r) = forge_core::resolve::resolve_id(client, &m.repo_id).await {
            names.insert(m.repo_id.clone(), r.display());
        }
    }
    names
}

async fn list(ctx: &Ctx, repo: Option<&str>, mine: bool) -> Result<()> {
    let (mirrors, names) = if mine {
        let client = ctx.connect().await?;
        let me = match ctx.identity_id_hint() {
            Some(id) => id,
            None => ctx.load_bridge()?.identity_id,
        };
        let forge = ctx.target.require_v2()?;
        let core = client.fetch_contract(&forge.core).await?;
        let mut mirrors = mirrors_by(&client, &core, &me).await?;
        // `list REPO --mine`: only the mirrors you recorded for that repository.
        if let Some(repo) = repo {
            let want = resolve_for(&client, Some(&me), &RepoRef::parse(repo)?)
                .await?
                .repo_id;
            mirrors.retain(|m| m.repo_id == want);
        }
        let names = repo_names(&client, &mirrors).await;
        (mirrors, names)
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
        let names = std::collections::BTreeMap::from([(r.repo.repo_id.clone(), r.repo.display())]);
        (out, names)
    };
    // The repository of a record: its name when it resolved, else its id.
    let repo_of = |m: &PackMirror| {
        names
            .get(&m.repo_id)
            .cloned()
            .unwrap_or_else(|| m.repo_id.clone())
    };
    ctx.emit(
        json!({ "mirrors": mirrors.iter().map(|m| mirror_json(m, names.get(&m.repo_id).map(String::as_str))).collect::<Vec<_>>() }),
        || {
            if mirrors.is_empty() {
                println!("no pack mirrors recorded");
                return;
            }
            for m in &mirrors {
                println!(
                    "{}  {}  pack {}  by {}  {}",
                    m.id,
                    safe(&repo_of(m)),
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
    use super::{refuse_unusable, unlisted_pack, unusable_addresses, Unusable};
    use forge_core::user_error::{codes, UserError};

    fn uris(list: &[&str]) -> Vec<String> {
        list.iter().map(ToString::to_string).collect()
    }

    /// An unlisted pack is named by its 12-digit prefix, not shown as `[redacted]` (the
    /// renderer redacts 64 hex digits as a possible private key).
    #[test]
    fn an_unlisted_pack_is_named_not_redacted() {
        let pack = "f11e7416234702f2797b7e4d2f8959343e197b98633095e47f7b1910d5134f5d";
        let out = unlisted_pack("alice/project", "alice/project", pack).render("", false);
        assert!(out.contains("lists no pack f11e74162347…"), "{out}");
        assert!(!out.contains("[redacted]"), "{out}");
        // The redactor still hides a full 64-hex token.
        assert_eq!(
            forge_core::user_error::redact(&format!("key {pack}")),
            "key [redacted]"
        );
    }

    #[test]
    fn loopback_and_private_hosts_are_refused_public_ones_kept() {
        let list = uris(&[
            "https://m.example.com/p",
            "https://127.0.0.1:8443/p",
            "https://192.168.1.4/p",
            "https://localhost/p",
            "ipfs://bafyq",
        ]);
        assert_eq!(
            unusable_addresses(&list),
            [
                ("https://127.0.0.1:8443/p", Unusable::Private),
                ("https://192.168.1.4/p", Unusable::Private),
                ("https://localhost/p", Unusable::Private)
            ]
        );
    }

    /// The readers' egress guard refuses more than the old host list did; a mirror at any of
    /// these would be paid for and never read.
    #[test]
    fn every_address_a_reader_refuses_is_refused_before_anything_is_paid() {
        for bad in [
            "https://198.18.0.5/p",
            "https://198.19.255.1/p",
            "https://[64:ff9b::c0a8:105]/p",
            "https://[2002:c0a8:105::1]/p",
            "https://[::7f00:1]/p",
            "https://[::1]/p",
            "https://224.0.0.1/p",
            "https://nas.local/p",
        ] {
            let e = refuse_unusable(&uris(&[bad])).expect_err(bad);
            let u = e.downcast_ref::<UserError>().expect(bad);
            assert_eq!(u.code, codes::USAGE, "{bad}");
            assert!(
                u.message.contains("private network"),
                "{bad}: {}",
                u.message
            );
        }
        // An address no reader can parse is refused too, not read as an IPFS problem.
        let e = refuse_unusable(&uris(&["https://a.b:99999/p"])).unwrap_err();
        let u = e.downcast_ref::<UserError>().unwrap();
        assert_eq!(u.code, codes::USAGE);
        assert!(u.message.contains("not a valid address"), "{}", u.message);
    }

    #[test]
    fn temporary_tunnels_are_refused_as_a_push_refuses_them() {
        for bad in [
            "https://random-words.trycloudflare.com/p.pack",
            "https://box.tail1234.ts.net/p.pack",
        ] {
            let e = refuse_unusable(&uris(&[bad])).expect_err(bad);
            let u = e.downcast_ref::<UserError>().expect(bad);
            assert_eq!(u.code, codes::USAGE, "{bad}");
            assert!(u.message.contains("temporary tunnel"), "{}", u.message);
        }
    }

    #[test]
    fn public_addresses_pass() {
        // r2.dev is only a warning for a push (rate-limited, but public).
        refuse_unusable(&uris(&[
            "https://m.example.com/p",
            "https://pub-1.r2.dev/p.pack",
            "https://[2606:4700::1111]/p",
        ]))
        .unwrap();
        refuse_unusable(&uris(&["ipfs://bafybeigdyrzt"])).unwrap();
    }
}
