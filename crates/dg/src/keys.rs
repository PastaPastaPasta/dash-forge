//! `dg repo keys` — a repository's members key (`docs/security/private-repos.md` §5, §17):
//! `status` (epochs, wraps, alerts, pending repair), `repair` (§5.6) and `rotate` (§5.5), for
//! every private repository and every public one with members-only content turned on; and
//! `dg repo members enable|status`, which turns members-only content on in a public repository
//! (DESIGN §4.1, §10).
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
use crate::fmt::{cost_json, cost_line};
use crate::{RepoKeysCommand, RepoMembersCommand};

/// One `repoKey` wrap, as measured on sakura (S1: 57,058,360 to 73,518,360 credits; the first
/// wrap of an epoch pays more), the upper figure rounded up.
pub const WRAP_ESTIMATE_CREDITS: u64 = 74_000_000;
/// One anchor `config` (sealed, up to ~1.5 KB).
pub const ANCHOR_ESTIMATE_CREDITS: u64 = 60_000_000;

/// One members-key anchor `config` (sealed, settings-free, epoch 0), as measured on sakura (S1:
/// 36,836,680 credits), rounded up.
pub const ENABLE_ANCHOR_CREDITS: u64 = 37_000_000;
/// One `repoKey` wrap when turning members-only content on ([`WRAP_ESTIMATE_CREDITS`]).
pub const ENABLE_WRAP_CREDITS: u64 = WRAP_ESTIMATE_CREDITS;

/// Dispatch a `repo keys` subcommand.
pub async fn run(ctx: &Ctx, cmd: &RepoKeysCommand) -> Result<()> {
    match cmd {
        RepoKeysCommand::Status { repo } => status(ctx, repo).await,
        RepoKeysCommand::Repair { repo } => repair(ctx, repo).await,
        RepoKeysCommand::Rotate { repo } => rotate(ctx, repo).await,
    }
}

/// Dispatch a `repo members` subcommand.
pub async fn run_members(ctx: &Ctx, cmd: &RepoMembersCommand) -> Result<()> {
    match cmd {
        RepoMembersCommand::Enable { repo } => enable(ctx, repo).await,
        RepoMembersCommand::Status { repo } => members_status(ctx, repo).await,
    }
}

/// Refuse a repository with no members key: a public one where nobody turned members-only
/// content on (E312). Every private repository has one.
pub async fn require_members_key(s: &Session) -> Result<()> {
    if s.repo.visibility == Visibility::Private
        || keyring::has_members_key(&s.client, &s.repo).await?
    {
        return Ok(());
    }
    Err(keyring::members_only_off(&s.repo).into())
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
        Alert::EpochGap { epoch, author } => format!(
            "{} posted a config for epoch {epoch}, above a missing epoch number: it is not an epoch",
            encode_identifier(*author)
        ),
        Alert::PublishedKeyMismatch { author, .. } => format!(
            "{} published a key for this repo's history that doesn't match it: ignored",
            encode_identifier(*author)
        ),
        Alert::RotationRequired { epoch, members } if members.is_empty() => {
            format!("rotation required: epoch {epoch} is burned")
        }
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
        "burnedEpochs": r.burned,
        "burnedBy": kr.burned_by().map(|(_, by)| encode_identifier(by)),
        "unanchoredEpochs": r.unanchored,
        "anchors": anchors,
        "alerts": r.alerts.iter().map(alert_text).collect::<Vec<_>>(),
        "repair": repair,
        "unreadableWraps": kr.unreadable_wraps(),
        "members": kr.members().iter().map(|m| json!({
            "identityId": m.identity_id,
            "role": m.role.as_str(),
        })).collect::<Vec<_>>(),
    })
}

async fn status(ctx: &Ctx, repo: &str) -> Result<()> {
    let session = Session::open(ctx, repo).await?;
    require_members_key(&session).await?;
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
    if handle.visibility == Visibility::Private {
        println!("{} (private)", handle.display());
    } else {
        println!("{} (public, members-only content on)", handle.display());
    }
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
    if let Some((epoch, by)) = kr.burned_by() {
        println!(
            "  key epoch {epoch} is burned: {} closed it (its key may have reached someone it must not); nothing is written under it until a maintainer rotates",
            encode_identifier(by)
        );
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
        if repair.rotate && repair.non_members.is_empty() {
            println!("  repair: rotate past the burned epoch: `dg repo keys repair {arg}`");
        } else if repair.rotate {
            println!("  repair: rotate (a non-member holds the current key): `dg repo keys repair {arg}`");
        } else if !repair.missing_wraps.is_empty() {
            println!(
                "  repair: {} without the current key: `dg repo keys repair {arg}`",
                crate::fmt::plural(repair.missing_wraps.len(), "member")
            );
        } else {
            println!("  repair: nothing to do");
        }
    }
    println!("  members:");
    for m in kr.members() {
        println!("    {}  {}", m.identity_id, m.role);
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
        reason: "only a current maintainer can wrap or rotate a repository's members key".into(),
        needs: "maintainer".into(),
    }
    .into())
}

/// The estimate of a repair from the loaded keyring: a rotation's `members + 1` writes, or one
/// wrap per member missing one.
fn repair_estimate(kr: &Keyring) -> (u64, String) {
    match kr.resolution().repair.as_ref() {
        Some(p) if p.rotate => rotation_cost(kr, distinct_members(kr.members())),
        Some(p) if !p.missing_wraps.is_empty() => (
            WRAP_ESTIMATE_CREDITS * p.missing_wraps.len() as u64,
            crate::fmt::plural(p.missing_wraps.len(), "wrap"),
        ),
        _ => (0, "nothing".into()),
    }
}

/// The estimate of the reader's next rotation over `members` members: a burn first when an
/// earlier run left a key for the next epoch (§5.5).
pub fn rotation_cost(kr: &Keyring, members: usize) -> (u64, String) {
    if keyring::rotation_may_burn(kr) {
        burn_estimate(members)
    } else {
        rotation_estimate(members)
    }
}

/// A rotation that may first have to burn an earlier run's epoch (§5.5): the burned epoch's
/// wraps and anchor, then the rotation's.
pub fn burn_estimate(members: usize) -> (u64, String) {
    let (one, _) = rotation_estimate(members);
    (
        2 * one,
        format!(
            "up to {} + 2 anchors (an earlier run's key must be burned)",
            crate::fmt::plural(2 * members, "wrap")
        ),
    )
}

/// A rotation over `members` members (the rotator included): one wrap each and the anchor.
pub fn rotation_estimate(members: usize) -> (u64, String) {
    (
        WRAP_ESTIMATE_CREDITS * members as u64 + ANCHOR_ESTIMATE_CREDITS,
        format!("{} + 1 anchor", crate::fmt::plural(members, "wrap")),
    )
}

async fn repair(ctx: &Ctx, repo: &str) -> Result<()> {
    let s = Session::open(ctx, repo).await?;
    require_members_key(&s).await?;
    let kr = signer(&s).keyring(&s.repo).await?;
    require_maintainer(&kr, &s.repo, "repair the key")?;
    let (est, what) = repair_estimate(&kr);
    if est == 0 {
        ctx.emit(json!({ "status": "nothing_to_do" }), || {
            println!("{}: the key needs no repair.", s.repo.display());
        });
        return Ok(());
    }
    let price = ctx.usd_price();
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

fn emit_repair(ctx: &Ctx, repo: &RepoRef, report: &RepairReport, spent: u64, price: Option<f64>) {
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
                if report.non_members.is_empty() {
                    println!("rotating the repo key past the burned epoch");
                } else {
                    println!(
                        "rotating the repo key: {} still had the current key",
                        report.non_members.join(", ")
                    );
                }
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
    require_members_key(&s).await?;
    let kr = signer(&s).keyring(&s.repo).await?;
    require_maintainer(&kr, &s.repo, "rotate the key")?;
    let (est, what) = rotation_cost(&kr, distinct_members(kr.members()));
    let price = ctx.usd_price();
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
    json!({ "epoch": r.epoch, "wrapped": r.wrapped, "skipped": r.skipped, "won": r.won, "burned": r.burned })
}

/// The lines a rotation prints.
pub fn print_rotation(repo: &RepoRef, r: &Rotation) {
    if let Some(b) = r.burned {
        println!(
            "{}: closed key epoch {b} as burned (an earlier run's key for it may have reached someone outside the members)",
            repo.display()
        );
    }
    if r.won {
        println!(
            "{}: key rotated to epoch {} (wrapped to {}, you first)",
            repo.display(),
            r.epoch,
            crate::fmt::plural(r.wrapped.len(), "member")
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

/// The members who would receive the members key: every member whose role holds it
/// ([`forge_core::members::holds_members_key`]; runners are not members), each once.
fn key_holders(members: &[forge_core::members::Member], repo: &RepoRef) -> usize {
    members
        .iter()
        .filter(|m| forge_core::members::holds_members_key(m.role, repo.visibility))
        .map(|m| m.identity_id.as_str())
        .collect::<std::collections::BTreeSet<_>>()
        .len()
}

/// The measured cost of turning members-only content on for `holders` members (the
/// maintainer included): one anchor and one wrap each.
#[must_use]
pub fn enable_estimate(holders: usize) -> u64 {
    ENABLE_ANCHOR_CREDITS + ENABLE_WRAP_CREDITS * holders as u64
}

/// The `dg repo members enable` question (DESIGN §10, "Turn on members-only content?", for the
/// terminal).
fn enable_prompt(repo: &RepoRef, holders: usize, price: Option<f64>) -> String {
    format!(
        "Turn on members-only content in {}?\n\
         Members of this repo will be able to post comments, reviews and issues only members can \
         read. Everyone can still see that something was posted, by whom and when.\n\
         Setting up keys for {holders} member(s) costs {}; each later removal costs about the \
         same again.\n\
         People using older Forge builds will see fewer things until they update. Change its \
         members only with an up-to-date Forge (dg, or the web app once it supports this), so \
         the key follows every change.\n\
         Turn on",
        repo.display(),
        cost_line(enable_estimate(holders), price)
    )
}

/// `dg repo members enable`: turn members-only content on in a public repository (a
/// maintainer): the settings-free members-key anchor and a wrap to every member whose role holds
/// the key, after the measured cost and a confirmation (`--yes` skips it).
async fn enable(ctx: &Ctx, repo: &str) -> Result<()> {
    let s = Session::open(ctx, repo).await?;
    if s.repo.visibility == Visibility::Private {
        return Err(crate::errors::usage(format!(
            "{} is private: everything in it is already members-only",
            s.repo.display()
        )));
    }
    let kr = signer(&s).keyring(&s.repo).await?;
    if kr.reader_role() != Some(forge_core::rules::v2::Role::Maintainer) {
        return Err(forge_core::user_error::UserError::new(
            forge_core::user_error::codes::NOT_A_WRITER,
            format!(
                "only maintainers can turn on members-only content in {}",
                s.repo.display()
            ),
        )
        .fix(format!(
            "ask a maintainer of {} to run `dg repo members enable {}`",
            s.repo.display(),
            s.repo.display()
        ))
        .note("nothing was written")
        .into());
    }
    if kr.has_members_key() {
        // already on: what is left is the key's own repair (a member with no key yet, a
        // rotation), with its own cost; never a second "Turn on?"
        let pending = kr
            .resolution()
            .repair
            .as_ref()
            .is_some_and(|r| r.rotate || !r.missing_wraps.is_empty());
        if kr.resolution().anchors.is_empty() {
            return Err(keyring::unresolved_members_key(&s.repo).into());
        }
        if pending {
            return Box::pin(repair(ctx, repo)).await;
        }
        ctx.emit(
            json!({ "status": "already_on", "repo": s.repo.display(), "epoch": kr.resolution().current_epoch }),
            || println!("{}: members-only content is already on.", s.repo.display()),
        );
        return Ok(());
    }
    let holders = key_holders(kr.members(), &s.repo);
    let price = ctx.usd_price();
    if !ctx.confirm(&enable_prompt(&s.repo, holders, price))? {
        return Err(crate::errors::cancelled());
    }
    let before = s.balance().await;
    let done = keyring::enable_members_key(&signer(&s), &s.repo).await?;
    let spent = s.spent_since(before).await;
    ctx.emit(
        json!({
            "status": if done.anchored { "enabled" } else { "finished" },
            "repo": s.repo.display(),
            "wrapped": done.wrapped,
            "skipped": done.skipped,
            "cost": cost_json(spent, price),
        }),
        || {
            println!(
                "{}: members-only content is on. The key was shared with {} other member(s).",
                s.repo.display(),
                done.wrapped.len()
            );
            for m in &done.skipped {
                println!(
                    "  not shared with {m} yet: they have no encryption key (`dg auth keys add --encryption`); run `dg repo keys repair {}` once they do",
                    s.repo.display()
                );
            }
            println!("  cost: {}", cost_line(spent, price));
        },
    );
    Ok(())
}

/// `dg repo members status`: whether members-only content is on, and who has the key.
async fn members_status(ctx: &Ctx, repo: &str) -> Result<()> {
    let s = Session::open(ctx, repo).await?;
    let kr = signer(&s)
        .keyring(&s.repo)
        .await
        .context("reading the repository's keys")?;
    let on = s.repo.visibility == Visibility::Private || kr.has_members_key();
    // readable means the CURRENT epoch: a removed member still holds the old ones
    let can_read = kr
        .resolution()
        .current_epoch
        .is_some_and(|e| kr.readable_epochs().contains(&e));
    let missing: Vec<String> = kr
        .resolution()
        .repair
        .as_ref()
        .map(|r| {
            r.missing_wraps
                .iter()
                .map(|m| encode_identifier(*m))
                .collect()
        })
        .unwrap_or_default();
    ctx.emit(
        json!({
            "repo": s.repo.display(),
            "on": on,
            "epoch": kr.resolution().current_epoch,
            "youCanRead": can_read,
            "noKeyYet": missing,
        }),
        || {
            if !on {
                println!(
                    "{}: members-only content is off. A maintainer turns it on with `dg repo members enable {}`.",
                    s.repo.display(),
                    s.repo.display()
                );
                return;
            }
            println!("{}: members-only content is on.", s.repo.display());
            if !can_read {
                println!("  you can't read new members-only content: you're not a member, or no key has been shared with you yet");
            }
            for m in &missing {
                println!("  no key shared with {m} yet: `dg repo keys repair {}` (a maintainer)", s.repo.display());
            }
        },
    );
    Ok(())
}
