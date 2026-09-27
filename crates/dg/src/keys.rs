//! `dg repo keys` — a private repository's keys (`docs/security/private-repos.md` §5):
//! `status` (epochs, wraps, alerts, pending repair), `repair` (§5.6) and `rotate` (§5.5).
//!
//! Nothing here prints key material: epochs are named by number, wraps by who holds them.

use anyhow::{Context, Result};
use serde_json::{json, Value};

use forge_core::keyring::{self, Keyring, PrivateSigner, RepairReport, Rotation};
use forge_core::platform::{encode_identifier, PlatformClient};
use forge_core::private::Alert;
use forge_core::rules::v2::Visibility;
use forge_core::scope::RepoRef;

use crate::common::Session;
use crate::context::Ctx;
use crate::fmt::{cost_json, cost_line, dash_usd_price};
use crate::RepoKeysCommand;

/// One `repoKey` wrap costs about this much (a 64-byte encrypted property, three integers).
pub const WRAP_ESTIMATE_CREDITS: u64 = 30_000_000;
/// One anchor `config` (sealed, up to ~1.5 KB).
pub const ANCHOR_ESTIMATE_CREDITS: u64 = 60_000_000;

/// Dispatch a `repo keys` subcommand.
pub async fn run(ctx: &Ctx, cmd: &RepoKeysCommand) -> Result<()> {
    match cmd {
        RepoKeysCommand::Status { repo } => status(ctx, repo).await,
        RepoKeysCommand::Repair { repo } => repair(ctx, repo).await,
        RepoKeysCommand::Rotate { repo } => rotate(ctx, repo).await,
    }
}

/// Refuse a public repository with a usage error.
pub fn require_private(repo: &RepoRef) -> Result<()> {
    if repo.visibility == Visibility::Private {
        return Ok(());
    }
    Err(crate::errors::usage(format!(
        "{} is a public repository; it has no keys",
        repo.display()
    )))
}

pub(crate) fn signer(s: &Session) -> PrivateSigner<'_> {
    PrivateSigner {
        client: &s.client,
        identity: &s.identity,
        bridge: &s.bridge,
    }
}

/// An alert as the UI names it (§9 "Repair and alerts").
fn alert_text(a: &Alert) -> String {
    match a {
        Alert::KeyMismatch { epoch, author } => format!(
            "{} gave you a key that isn't this repo's key (epoch {epoch})",
            encode_identifier(*author)
        ),
        Alert::ChainBroken { epoch, author } => format!(
            "the key chain is broken at epoch {epoch} (anchor by {})",
            encode_identifier(*author)
        ),
        Alert::RotationRequired { epoch, members } => format!(
            "rotation required: epoch {epoch} is still wrapped to {} (not a member)",
            members
                .iter()
                .map(|m| encode_identifier(*m))
                .collect::<Vec<_>>()
                .join(", ")
        ),
    }
}

/// The status of `kr` as JSON (and the lines a person reads).
fn status_json(kr: &Keyring) -> Value {
    let r = kr.resolution();
    let anchors: Vec<Value> = r
        .anchors
        .iter()
        .map(|(e, a)| {
            json!({
                "epoch": e,
                "anchorId": encode_identifier(a.id),
                "by": encode_identifier(a.owner),
                "blockHeight": a.height,
            })
        })
        .collect();
    let repair = r.repair.as_ref().map(|p| {
        json!({
            "rotate": p.rotate,
            "nonMembers": p.non_members.iter().map(|m| encode_identifier(*m)).collect::<Vec<_>>(),
            "missingWraps": p.missing_wraps.iter().map(|m| encode_identifier(*m)).collect::<Vec<_>>(),
        })
    });
    json!({
        "currentEpoch": r.current_epoch,
        "writeEpoch": r.write_epoch,
        "readableEpochs": kr.readable_epochs(),
        "unanchoredEpochs": r.unanchored,
        "anchors": anchors,
        "alerts": r.alerts.iter().map(alert_text).collect::<Vec<_>>(),
        "repair": repair,
        "unreadableWraps": kr.unreadable_wraps(),
        "members": kr.members().iter().map(|m| json!({
            "identityId": m.identity_id,
            "role": forge_core::members::doc_type(m.role),
        })).collect::<Vec<_>>(),
    })
}

async fn status(ctx: &Ctx, repo: &str) -> Result<()> {
    let session = Session::open(ctx, repo).await?;
    require_private(&session.repo)?;
    let kr = signer(&session)
        .keyring(&session.repo)
        .await
        .context("reading the repository's keys")?;
    ctx.emit(status_json(&kr), || print_status(&session.repo, repo, &kr));
    Ok(())
}

/// `dg repo keys status` for a person.
fn print_status(handle: &RepoRef, arg: &str, kr: &Keyring) {
    let res = kr.resolution();
    println!("{} (private)", handle.display());
    match res.current_epoch {
        Some(epoch) => {
            let anchor = &res.anchors[&epoch];
            println!(
                "  key epoch {epoch} · anchored at block {} by {}",
                anchor.height,
                encode_identifier(anchor.owner)
            );
        }
        None => println!("  no key epoch exists yet (the repository was not finished)"),
    }
    println!(
        "  you can read epochs {:?}; you write under {}",
        kr.readable_epochs(),
        res.write_epoch
            .map_or_else(|| "none (see below)".to_string(), |e| e.to_string())
    );
    if !res.unanchored.is_empty() {
        println!(
            "  epochs with no anchor (content under them is unreadable to everyone): {:?}",
            res.unanchored
        );
    }
    for alert in &res.alerts {
        println!("  alert: {}", alert_text(alert));
    }
    let maintainer = kr.reader_role() == Some(forge_core::rules::v2::Role::Maintainer);
    if let (true, Some(repair)) = (maintainer, &res.repair) {
        if repair.rotate {
            println!("  repair: rotate (a non-member holds the current key): `dg repo keys repair {arg}`");
        } else if !repair.missing_wraps.is_empty() {
            println!(
                "  repair: {} member(s) have no wrap for the current epoch: `dg repo keys repair {arg}`",
                repair.missing_wraps.len()
            );
        } else {
            println!("  repair: nothing to do");
        }
    }
    println!("  members:");
    for m in kr.members() {
        println!(
            "    {}  {}",
            m.identity_id,
            forge_core::members::doc_type(m.role)
        );
    }
}

/// How many distinct identities hold a role (a member with both roles is one wrap).
pub fn distinct_members(members: &[forge_core::members::Member]) -> usize {
    members
        .iter()
        .map(|m| m.identity_id.as_str())
        .collect::<std::collections::BTreeSet<_>>()
        .len()
}

/// Refuse a key operation by a non-maintainer before any prompt (the rotation and wraps are
/// maintainer-gated at consensus).
fn require_maintainer(kr: &Keyring, repo: &RepoRef, action: &str) -> Result<()> {
    if kr.reader_role() == Some(forge_core::rules::v2::Role::Maintainer) {
        return Ok(());
    }
    Err(forge_core::Error::NotPermitted {
        action: format!("{action} of {}", repo.display()),
        reason: "only a current maintainer can wrap or rotate a private repository's key".into(),
        needs: "maintainer".into(),
    }
    .into())
}

/// The estimate of a repair from the loaded keyring: a rotation's `members + 1` writes, or one
/// wrap per member missing one.
fn repair_estimate(kr: &Keyring) -> (u64, String) {
    match kr.resolution().repair.as_ref() {
        Some(p) if p.rotate => rotation_estimate(distinct_members(kr.members())),
        Some(p) if !p.missing_wraps.is_empty() => (
            WRAP_ESTIMATE_CREDITS * p.missing_wraps.len() as u64,
            format!("{} wrap(s)", p.missing_wraps.len()),
        ),
        _ => (0, "nothing".into()),
    }
}

/// A rotation over `members` members (the rotator included): one wrap each and the anchor.
pub fn rotation_estimate(members: usize) -> (u64, String) {
    (
        WRAP_ESTIMATE_CREDITS * members as u64 + ANCHOR_ESTIMATE_CREDITS,
        format!("{members} wrap(s) + 1 anchor"),
    )
}

async fn repair(ctx: &Ctx, repo: &str) -> Result<()> {
    let s = Session::open(ctx, repo).await?;
    require_private(&s.repo)?;
    let kr = signer(&s).keyring(&s.repo).await?;
    require_maintainer(&kr, &s.repo, "repair the key")?;
    let (est, what) = repair_estimate(&kr);
    if est == 0 {
        ctx.emit(json!({ "status": "nothing_to_do" }), || {
            println!("{}: the key needs no repair.", s.repo.display());
        });
        return Ok(());
    }
    let price = dash_usd_price();
    if !ctx.confirm(&format!(
        "Repair the key of {}: {what}, {}?",
        s.repo.display(),
        cost_line(est, price)
    ))? {
        return Err(crate::errors::cancelled());
    }
    let before = s.balance().await;
    let report = keyring::repair(&signer(&s), &s.repo).await?;
    let spent = s.spent_since(before).await;
    emit_repair(ctx, &s.repo, &report, spent, price);
    Ok(())
}

fn emit_repair(ctx: &Ctx, repo: &RepoRef, report: &RepairReport, spent: u64, price: f64) {
    ctx.emit(
        json!({
            "status": "repaired",
            "rotated": report.rotated.as_ref().map(rotation_json),
            "nonMembers": report.non_members,
            "wrapped": report.wrapped,
            "skipped": report.skipped,
            "cost": cost_json(spent, price),
        }),
        || {
            if let Some(r) = &report.rotated {
                println!(
                    "rotating the repo key: {} still had the current key",
                    report.non_members.join(", ")
                );
                print_rotation(repo, r);
            }
            for m in &report.wrapped {
                println!("wrapped the current key to {m}");
            }
            for m in &report.skipped {
                println!("not wrapped to {m}: they have no encryption key yet (`dg auth keys add --encryption`); run repair again once they do");
            }
            println!("  cost: {}", cost_line(spent, price));
        },
    );
}

async fn rotate(ctx: &Ctx, repo: &str) -> Result<()> {
    let s = Session::open(ctx, repo).await?;
    require_private(&s.repo)?;
    let kr = signer(&s).keyring(&s.repo).await?;
    require_maintainer(&kr, &s.repo, "rotate the key")?;
    let (est, what) = rotation_estimate(distinct_members(kr.members()));
    let price = dash_usd_price();
    if !ctx.confirm(&format!(
        "Rotate the key of {}: {what}, {}?",
        s.repo.display(),
        cost_line(est, price)
    ))? {
        return Err(crate::errors::cancelled());
    }
    let before = s.balance().await;
    let r = keyring::rotate(&signer(&s), &s.repo, &[]).await?;
    let spent = s.spent_since(before).await;
    ctx.emit(
        json!({ "status": "rotated", "rotation": rotation_json(&r), "cost": cost_json(spent, price) }),
        || {
            print_rotation(&s.repo, &r);
            println!("  cost: {}", cost_line(spent, price));
        },
    );
    Ok(())
}

/// A rotation as JSON.
pub fn rotation_json(r: &Rotation) -> Value {
    json!({ "epoch": r.epoch, "wrapped": r.wrapped, "skipped": r.skipped, "won": r.won })
}

/// The lines a rotation prints.
pub fn print_rotation(repo: &RepoRef, r: &Rotation) {
    if r.won {
        println!(
            "{}: key rotated to epoch {} (wrapped to {} member(s), you first)",
            repo.display(),
            r.epoch,
            r.wrapped.len()
        );
        for m in &r.skipped {
            println!(
                "  not wrapped to {m}: they have no encryption key yet; `dg repo keys repair {}` wraps them once they add one",
                repo.display()
            );
        }
    } else {
        println!(
            "{}: another maintainer rotated to epoch {} first; theirs stands and yours is superseded (nothing to do)",
            repo.display(),
            r.epoch
        );
    }
}

/// Whether `member` can receive a wrap (has a usable `ENCRYPTION` key), for `dg collab add`.
pub async fn member_can_receive(
    client: &PlatformClient,
    repo: &RepoRef,
    member: &str,
) -> Result<bool> {
    keyring::member_can_receive(client, repo, member)
        .await
        .with_context(|| format!("reading {member}'s keys"))
}
