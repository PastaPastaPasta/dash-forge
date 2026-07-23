//! `dg cost` — pre-write estimates and a per-operation / storage audit.

use anyhow::{Context, Result};
use serde_json::json;

use forge_core::cost::{estimate, prompt_delete_refund};
use forge_core::repo::RepoService;

use crate::common::{resolve, RepoRef};
use crate::context::Ctx;
use crate::fmt::{cost_json, cost_line, dash_usd_price, refund_line, REPO_CREATE_ESTIMATE_CREDITS};
use crate::{Backend, CostCommand};

/// Dispatch a `cost` subcommand.
pub async fn run(ctx: &Ctx, cmd: &CostCommand) -> Result<()> {
    match cmd {
        CostCommand::Estimate {
            backend,
            bytes,
            path,
        } => estimate_cmd(ctx, *backend, *bytes, path.as_deref()),
        CostCommand::Audit { repo } => audit(ctx, repo.as_deref()).await,
    }
}

/// A pre-write quote for storing `bytes` bytes as a document (platform tier). External
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
    let est = estimate(bytes);
    let price = dash_usd_price();
    let backend_label = backend.map_or("platform", Backend::label);

    ctx.emit(
        json!({
            "bytes": bytes,
            "backend": backend_label,
            "depositCredits": est.deposit,
            "burnCredits": est.burn,
            "totalCredits": est.total(),
            "cost": cost_json(est.total(), price),
            "refundableDeposit": cost_json(est.deposit, price),
        }),
        || {
            println!("Estimate for {bytes} bytes ({backend_label} tier):");
            println!("  total:      {}", cost_line(est.total(), price));
            println!("  refundable: {} (storage deposit, reclaimable on delete)", cost_line(est.deposit, price));
            println!("  burned:     {} (non-refundable processing)", cost_line(est.burn, price));
            if !matches!(backend, None | Some(Backend::Platform)) {
                println!("  note: external backends store pack bytes off-chain — only the manifest + refs are billed on-chain.");
            }
        },
    );
    Ok(())
}

/// A cost audit. With a repo, tally its on-chain pack storage (locked deposit + prompt
/// refund). Without one, print a per-operation cost reference (running spend is not tracked
/// yet — every mutating command already prints its own estimate).
async fn audit(ctx: &Ctx, repo: Option<&str>) -> Result<()> {
    let price = dash_usd_price();

    let Some(repo) = repo else {
        // Per-operation reference table.
        let ops = [
            ("repo create", REPO_CREATE_ESTIMATE_CREDITS),
            ("ref update (~200 B doc)", estimate(200).total()),
            ("pack chunk (~4900 B)", estimate(4900).total()),
            ("issue / comment (~500 B)", estimate(500).total()),
        ];
        let rows: Vec<_> = ops
            .iter()
            .map(|(op, credits)| json!({ "op": op, "cost": cost_json(*credits, price) }))
            .collect();
        ctx.emit(
            json!({
                "mode": "per_operation_estimates",
                "tracked": false,
                "operations": rows,
                "note": "running spend is not tracked yet; these are per-op estimates from the fee schedule",
            }),
            || {
                println!("Per-operation cost reference (no live spend tracking yet):");
                for (op, credits) in ops {
                    println!("  {op:<26} {}", cost_line(credits, price));
                }
            },
        );
        return Ok(());
    };

    // Live storage tally for a repo.
    let repo_ref = RepoRef::parse(repo)?;
    let (client, bridge, identity) = ctx.connect_with_identity().await?;
    let handle = resolve(&client, &identity, &bridge, &repo_ref).await?;
    let svc = RepoService::new(&client, &identity, &bridge);
    let manifests = svc.read_pack_manifests(&handle).await.unwrap_or_default();
    let total_bytes: u64 = manifests.iter().map(|m| m.size_bytes).sum();
    let deposit_locked: u64 = est_deposit(total_bytes);
    let refund = prompt_delete_refund(total_bytes);

    ctx.emit(
        json!({
            "mode": "repo_storage_tally",
            "repoContractId": handle.repo_contract_id,
            "packCount": manifests.len(),
            "packBytes": total_bytes,
            "depositLocked": cost_json(deposit_locked, price),
            "promptRefund": cost_json(refund, price),
        }),
        || {
            println!(
                "Storage tally for {}/{}:",
                handle.owner_id, handle.normalized_name
            );
            println!(
                "  packs:           {} ({total_bytes} bytes)",
                manifests.len()
            );
            println!("  deposit locked:  {}", cost_line(deposit_locked, price));
            println!("  prompt refund:   {}", refund_line(refund, price));
        },
    );
    Ok(())
}

/// The refundable storage deposit for `bytes` (the deposit half of the estimate).
fn est_deposit(bytes: u64) -> u64 {
    estimate(bytes).deposit
}
