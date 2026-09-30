//! `dg cost` — pre-write estimates and a per-operation / storage audit.

use anyhow::{Context, Result};
use serde_json::json;

use forge_core::cost::{estimate, push_fees};
use forge_core::cost_audit::{self, AuditReport};
use forge_core::pack::DOC_PAYLOAD_MAX;
use forge_core::repo::RepoService;
use forge_import::budget::{collab_doc_credits, CollabDoc};

use crate::common::{resolve, RepoRef};
use crate::context::Ctx;
use crate::fmt::{cost_json, cost_line, dash_usd_price, REPO_CREATE_ESTIMATE_CREDITS};
use crate::{Backend, CostCommand};

/// Dispatch a `cost` subcommand.
pub async fn run(ctx: &Ctx, cmd: &CostCommand) -> Result<()> {
    match cmd {
        CostCommand::Estimate {
            backend,
            bytes,
            path,
        } => estimate_cmd(ctx, *backend, *bytes, path.as_deref()),
        CostCommand::Audit { owner, since, repo } => {
            audit(ctx, owner.as_deref(), since.as_deref(), repo.as_deref()).await
        }
        CostCommand::Prices => {
            prices_cmd(ctx);
            Ok(())
        }
    }
}

/// The static per-operation price reference (`dg cost audit`'s home before it became an
/// identity spend estimate; moved here so it stays reachable — see `docs/guides/costs.md`
/// §What each action costs).
fn prices_cmd(ctx: &Ctx) {
    let price = dash_usd_price();
    // Upper bounds from the fees measured on moutai (`push_fees`, the importer's calibrated
    // collaboration model); docs/guides/costs.md has the measured table.
    let ops = [
        ("repo create", REPO_CREATE_ESTIMATE_CREDITS),
        ("ref update", push_fees::REF_FIRST),
        ("pack manifest", push_fees::MANIFEST_FIRST),
        (
            "pack chunk (14.7 KB)",
            push_fees::chunks(DOC_PAYLOAD_MAX as u64),
        ),
        ("issue (~500 B)", collab_doc_credits(CollabDoc::Target, 500)),
        (
            "comment (~500 B)",
            collab_doc_credits(CollabDoc::Comment, 500),
        ),
    ];
    let rows: Vec<_> = ops
        .iter()
        .map(|(op, credits)| json!({ "op": op, "cost": cost_json(*credits, price) }))
        .collect();
    ctx.emit(
        json!({
            "mode": "per_operation_estimates",
            "operations": rows,
            "note": "upper bounds from fees measured on devnet moutai; for what one identity has actually spent, use `dg cost audit`",
        }),
        || {
            println!("Per-operation cost reference (upper bounds; see `dg cost audit` for what you've spent):");
            for (op, credits) in ops {
                println!("  {op:<26} {}", cost_line(credits, price));
            }
        },
    );
}

/// A pre-write quote for storing `bytes` bytes as Platform `chunk` documents, priced like
/// `git push` prices them (platform tier). External
/// backends move the pack bytes off-chain — only the manifest + refs are billed on-chain —
/// so the figure is labeled with the chosen backend.
fn estimate_cmd(
    ctx: &Ctx,
    backend: Option<Backend>,
    bytes: Option<u64>,
    path: Option<&std::path::Path>,
) -> Result<()> {
    let bytes = match (bytes, path) {
        (Some(b), _) => b,
        (None, Some(p)) => std::fs::metadata(p)
            .with_context(|| format!("stat {}", p.display()))?
            .len(),
        (None, None) => 0,
    };
    // What `git push` would pay to store `bytes` as Platform chunks (the calibrated fees),
    // split into the storage deposit and the rest (per-document and processing fees).
    let deposit = estimate(bytes).deposit;
    let total = push_fees::chunks(bytes);
    let burn = total.saturating_sub(deposit);
    let price = dash_usd_price();
    let backend_label = backend.map_or("platform", Backend::label);

    ctx.emit(
        json!({
            "bytes": bytes,
            "backend": backend_label,
            "depositCredits": deposit,
            "burnCredits": burn,
            "totalCredits": total,
            "cost": cost_json(total, price),
            "storageDeposit": cost_json(deposit, price),
        }),
        || {
            println!("Estimate for {bytes} bytes ({backend_label} tier):");
            println!("  total:      {}", cost_line(total, price));
            println!("  storage:    {} (deposit; Platform packs are permanent, not refunded)", cost_line(deposit, price));
            println!("  fees:       {} (per-document and processing)", cost_line(burn, price));
            if !matches!(backend, None | Some(Backend::Platform)) {
                println!("  note: external backends store pack bytes off-chain — only the manifest + refs are billed on-chain.");
            }
        },
    );
    Ok(())
}

/// A cost audit. With a repo, tally its on-chain pack storage (locked deposit + prompt
/// refund). Without one, estimate an identity's total Forge spend from what it has proved to
/// have created (`forge_core::cost_audit`; there is no spend ledger on forge-v2).
async fn audit(
    ctx: &Ctx,
    identity: Option<&str>,
    since: Option<&str>,
    repo: Option<&str>,
) -> Result<()> {
    let price = dash_usd_price();

    let Some(repo) = repo else {
        return identity_audit(ctx, identity, since, price).await;
    };

    // Live storage tally for a repo.
    let repo_ref = RepoRef::parse(repo)?;
    let (client, bridge, identity) = ctx.connect_with_identity().await?;
    let handle = resolve(&client, &identity, &repo_ref).await?;
    let svc = RepoService::new(&client, &identity, &bridge);
    let manifests = svc.read_pack_manifests(&handle).await.unwrap_or_default();
    let total_bytes: u64 = manifests.iter().map(|m| m.size_bytes).sum();
    let deposit_locked: u64 = est_deposit(total_bytes);

    ctx.emit(
        json!({
            "mode": "repo_storage_tally",
            "repoId": handle.id(),
            "packCount": manifests.len(),
            "packBytes": total_bytes,
            "depositLocked": cost_json(deposit_locked, price),
        }),
        || {
            println!("Storage tally for {}:", handle.display());
            println!(
                "  packs:           {} ({total_bytes} bytes)",
                manifests.len()
            );
            println!("  deposit locked:  {}", cost_line(deposit_locked, price));
            println!("  (packs are permanent: the deposit is not refundable)");
        },
    );
    Ok(())
}

/// An identity-wide spend estimate: total, per document type, per repository. With neither
/// `--owner` nor a cached identity-id hint, this falls back to the signing identity
/// (`Ctx::signer_on`), which does open — and, if sealed, prompt to unseal — a key; the key is
/// used only to learn its id, never to sign anything, since this is a read-only audit (mirrors
/// `repo list`'s owner resolution, L-12).
async fn identity_audit(
    ctx: &Ctx,
    identity: Option<&str>,
    since: Option<&str>,
    price: f64,
) -> Result<()> {
    let client = ctx.connect().await?;
    let identity_id = match identity {
        Some(i) => forge_core::resolve::resolve_owner(&client, i)
            .await
            .with_context(|| format!("resolving identity {i}"))?,
        None => match ctx.identity_id_hint() {
            Some(id) => id,
            None => ctx.signer_on(&client).await?.1.id(),
        },
    };
    let since_ms = since.map(cost_audit::parse_since).transpose()?;

    let report = cost_audit::audit(&client, &identity_id, since_ms)
        .await
        .context("auditing spend")?;

    ctx.emit(audit_json(&report, price), || print_audit(&report, price));
    Ok(())
}

/// The `--json` payload for an identity spend [`AuditReport`].
fn audit_json(report: &AuditReport, price: f64) -> serde_json::Value {
    json!({
        "mode": "identity_spend_estimate",
        "identityId": report.identity_id,
        "sinceMs": report.since_ms,
        "documentCount": report.document_count,
        "totalCredits": report.total_credits,
        "cost": cost_json(report.total_credits, price),
        "byType": report.by_type.iter().map(|t| json!({
            "docType": t.doc_type,
            "count": t.count,
            "cost": cost_json(t.credits, price),
        })).collect::<Vec<_>>(),
        "byRepo": report.by_repo.iter().map(|r| json!({
            "repo": r.repo,
            "count": r.count,
            "cost": cost_json(r.credits, price),
        })).collect::<Vec<_>>(),
        "excludedTypes": report.excluded_types,
        "note": "an estimate from proved document counts x each type's flat create cost; forge-v2 keeps no spend ledger",
        "scopeNote": SCOPE_NOTE,
        "chunkGapNote": CHUNK_GAP_NOTE,
    })
}

/// The human-readable rendering of an identity spend [`AuditReport`].
fn print_audit(report: &AuditReport, price: f64) {
    println!("Spend estimate for {}:", report.identity_id);
    if let Some(since_ms) = report.since_ms {
        println!("  since:  {} UTC", format_utc(since_ms));
    }
    println!(
        "  total:  {} across {} document(s)",
        cost_line(report.total_credits, price),
        report.document_count
    );
    println!("\n  by document type:");
    for t in &report.by_type {
        println!(
            "    {:<20} {:>4}  {}",
            t.doc_type,
            t.count,
            cost_line(t.credits, price)
        );
    }
    println!("\n  by repository:");
    for r in &report.by_repo {
        println!(
            "    {:<46} {:>4}  {}",
            r.repo,
            r.count,
            cost_line(r.credits, price)
        );
    }
    if !report.excluded_types.is_empty() {
        println!(
            "\n  note: excludes {} (no proved query can attribute them to their author)",
            report.excluded_types.join(", ")
        );
    }
    println!("  note: {SCOPE_NOTE}");
    println!("  note: {CHUNK_GAP_NOTE}");
}

/// The repository-scope caveat every audit's output carries: which repositories it can find a
/// repo-scoped write in, and the one case it structurally cannot (see
/// `forge_core::cost_audit`'s module doc, `Auditor::repo_scope`).
const SCOPE_NOTE: &str = "covers every repo owned, filed an issue/patch to, or still a \
    maintainer/writer/CI-runner/private-repo-key-holder of; a membership revoked with no other \
    trace in that repo cannot be found by any proved query";

/// The `chunk`-counting caveat every audit's output carries: chunks are derived from each
/// owned `packManifest`'s `chunkCount`, not queried directly (see `forge_core::cost_audit`'s
/// module doc), so chunks written by an interrupted push or before a mid-push membership
/// revocation — with no live manifest to derive them from — are not counted here.
const CHUNK_GAP_NOTE: &str = "chunk counts come from each owned pack's own manifest; chunks \
    uploaded by a push that never finished with a manifest are not counted";

/// The refundable storage deposit for `bytes` (the deposit half of the estimate).
fn est_deposit(bytes: u64) -> u64 {
    estimate(bytes).deposit
}

/// `ms` (epoch milliseconds) as `YYYY-MM-DD HH:MM:SS`, so `--since` prints back as a date a
/// person gave it as, not the raw milliseconds `forge_core::cost_audit::parse_since` produced.
/// No `chrono` / `time` dependency: the importer's existing `unix_to_iso8601` (Howard
/// Hinnant's `civil_from_days`) does the calendar math.
fn format_utc(ms: u64) -> String {
    // `YYYY-MM-DDTHH:MM:SSZ` -> `YYYY-MM-DD HH:MM:SS`.
    forge_import::github::unix_to_iso8601(ms / 1000)
        .trim_end_matches('Z')
        .replacen('T', " ", 1)
}

#[cfg(test)]
mod format_utc_tests {
    use super::format_utc;

    #[test]
    fn round_trips_known_dates() {
        // Same reference point cost_audit's own tests use.
        assert_eq!(format_utc(20_725 * 86_400_000), "2026-09-29 00:00:00");
        assert_eq!(format_utc(0), "1970-01-01 00:00:00");
    }

    #[test]
    fn keeps_the_time_of_day() {
        assert_eq!(
            format_utc(20_725 * 86_400_000 + 3_661_000),
            "2026-09-29 01:01:01"
        );
    }
}
