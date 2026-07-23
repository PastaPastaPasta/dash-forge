//! `dg auth` — identity import, status, and balance.

use anyhow::{Context, Result};
use serde_json::json;

use forge_core::keystore::BridgeIdentity;

use crate::config::{identities_dir, Config};
use crate::context::{network_label, Ctx};
use crate::fmt::{balance_json, credits_to_dash};
use crate::AuthCommand;

/// Dispatch an `auth` subcommand.
pub async fn run(ctx: &Ctx, cmd: &AuthCommand) -> Result<()> {
    match cmd {
        AuthCommand::Login => login(ctx).await,
        AuthCommand::Status => status(ctx),
        AuthCommand::Balance => balance(ctx).await,
    }
}

/// Import the `--identity <file>` bridge export into
/// `~/.config/dash-forge/identities/<network>/<id>.identity.json`, and record it as the
/// config default. Secrets are copied verbatim to the private import path but never printed.
async fn login(ctx: &Ctx) -> Result<()> {
    let src = ctx
        .require_identity_path()
        .context("`dg auth login` needs --identity <file> (the bridge identity export)")?
        .clone();

    let bridge = BridgeIdentity::load_from_file(&src)
        .with_context(|| format!("loading identity from {}", src.display()))?;
    let network = network_label(ctx.network);

    // Copy the export into the per-network import directory (private, 0600-ish via the
    // source's own perms; we do not widen them).
    let dir = identities_dir(network)?;
    std::fs::create_dir_all(&dir).with_context(|| format!("creating {}", dir.display()))?;
    let dest = dir.join(format!("{}.identity.json", bridge.identity_id));
    let raw =
        std::fs::read_to_string(&src).with_context(|| format!("reading {}", src.display()))?;
    std::fs::write(&dest, raw).with_context(|| format!("writing {}", dest.display()))?;

    // Record as the config default (network + identity path + id).
    let mut config = Config::load().unwrap_or_default();
    config.network = Some(network.to_string());
    config.default_identity = Some(dest.to_string_lossy().to_string());
    config.default_identity_id = Some(bridge.identity_id.clone());
    config.save()?;

    // Best-effort balance probe so login confirms the identity actually resolves on-chain.
    let balance = match ctx.connect().await {
        Ok(client) => client.get_balance(&bridge.identity_id).await.ok(),
        Err(_) => None,
    };

    ctx.emit(
        json!({
            "status": "logged_in",
            "identityId": bridge.identity_id,
            "network": network,
            "storedAt": dest.to_string_lossy(),
            "isDefault": true,
            "balanceCredits": balance,
            "balanceDash": balance.map(credits_to_dash),
        }),
        || {
            println!("Logged in as {} on {network}.", bridge.identity_id);
            println!("Stored default identity at {}.", dest.display());
            if let Some(c) = balance {
                println!("Balance: {} credits (~{:.6} DASH).", c, credits_to_dash(c));
            }
        },
    );
    Ok(())
}

/// Show the resolved identity, network, and config default (no network call).
#[allow(clippy::unnecessary_wraps)]
fn status(ctx: &Ctx) -> Result<()> {
    let config = Config::load().unwrap_or_default();
    let network = network_label(ctx.network);
    let identity_path = ctx
        .identity_path
        .as_ref()
        .map(|p| p.to_string_lossy().to_string());

    // The identity id from the resolved file, if it loads (kept cheap: no network).
    let identity_id = ctx
        .identity_path
        .as_ref()
        .and_then(|p| BridgeIdentity::load_from_file(p).ok())
        .map(|b| b.identity_id)
        .or_else(|| config.default_identity_id.clone());

    ctx.emit(
        json!({
            "network": network,
            "identityId": identity_id,
            "identityPath": identity_path,
            "defaultIdentityId": config.default_identity_id,
            "authenticated": identity_id.is_some(),
        }),
        || {
            println!("Network: {network}");
            match &identity_id {
                Some(id) => println!("Identity: {id}"),
                None => {
                    println!("Identity: (none configured — run `dg auth login --identity <file>`)");
                }
            }
            if let Some(p) = &identity_path {
                println!("Identity file: {p}");
            }
        },
    );
    Ok(())
}

/// Show the identity's spendable credit balance and its DASH equivalent.
async fn balance(ctx: &Ctx) -> Result<()> {
    let bridge = ctx.load_bridge()?;
    let client = ctx.connect().await?;
    let credits = client
        .get_balance(&bridge.identity_id)
        .await
        .context("fetching balance")?;
    let network = network_label(ctx.network);

    ctx.emit(balance_json(&bridge.identity_id, credits, network), || {
        println!("Identity: {}", bridge.identity_id);
        println!(
            "Balance:  {} credits  (~{:.6} DASH)",
            credits,
            credits_to_dash(credits)
        );
        if credits == 0 {
            println!(
                "  note: zero balance — fund via the bridge/faucet before any cost-bearing command"
            );
        }
    });
    Ok(())
}
