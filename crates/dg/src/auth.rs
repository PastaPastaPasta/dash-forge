//! `dg auth` — identity import, status, and balance.

use anyhow::{Context, Result};
use serde_json::json;

use forge_core::keystore::BridgeIdentity;

use crate::config::{identities_dir, Config};
use crate::context::Ctx;
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
    let network = ctx.network_label();

    // Copy the export into the per-network import directory (private, 0600-ish via the
    // source's own perms; we do not widen them).
    let dir = identities_dir(&network)?;
    std::fs::create_dir_all(&dir).with_context(|| format!("creating {}", dir.display()))?;
    let dest = dir.join(format!("{}.identity.json", bridge.identity_id));
    let raw =
        std::fs::read_to_string(&src).with_context(|| format!("reading {}", src.display()))?;
    std::fs::write(&dest, raw).with_context(|| format!("writing {}", dest.display()))?;

    // Record as the config default (network + identity path + id). A devnet also records
    // its name, or the next command could not reconnect to it. Its DAPI list is recorded
    // only when it differs from the deployment file's: config outranks that file, so
    // copying the file's list here would pin it past a devnet reset that updates the file.
    let mut config = Config::load().unwrap_or_default();
    let previous_network = config
        .network_settings()
        .resolve()
        .ok()
        .map(|t| t.network.key());
    config.network = Some(ctx.network().kind().to_string());
    config.devnet_name = ctx.network().devnet_name().map(str::to_string);
    config.dapi_addresses = explicit_dapi_addresses(ctx.network());
    // A registry override belongs to the network it was set for.
    if previous_network.as_deref() != Some(network.as_str()) {
        config.registry_contract_id = None;
    }
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

/// A devnet's DAPI list worth persisting: `None` when it is empty (discovery) or is exactly
/// the list in its embedded `deployments/devnet-<name>.json`.
fn explicit_dapi_addresses(network: &forge_core::platform::Network) -> Option<String> {
    let forge_core::platform::Network::Devnet { dapi_addresses, .. } = network else {
        return None;
    };
    let recorded = forge_core::network::deployment(&network.key())
        .ok()
        .flatten()
        .map(|d| d.dapi_addresses)
        .unwrap_or_default();
    (!dapi_addresses.is_empty() && *dapi_addresses != recorded).then(|| dapi_addresses.join(","))
}

/// Show the resolved identity, network, and config default (no network call).
#[allow(clippy::unnecessary_wraps)]
fn status(ctx: &Ctx) -> Result<()> {
    let config = Config::load().unwrap_or_default();
    let network = ctx.network_label();
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
    let network = ctx.network_label();

    ctx.emit(balance_json(&bridge.identity_id, credits, &network), || {
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

#[cfg(test)]
mod tests {
    use super::explicit_dapi_addresses;
    use forge_core::network::NetworkSettings;

    fn moutai(dapi: Option<&str>) -> forge_core::platform::Network {
        NetworkSettings {
            network: Some("devnet".into()),
            devnet_name: Some("moutai".into()),
            dapi_addresses: dapi.map(str::to_string),
            ..Default::default()
        }
        .resolve()
        .unwrap()
        .network
    }

    #[test]
    fn deployment_file_addresses_are_not_pinned_into_config() {
        assert_eq!(explicit_dapi_addresses(&moutai(None)), None);
    }

    #[test]
    fn user_supplied_addresses_are_persisted() {
        assert_eq!(
            explicit_dapi_addresses(&moutai(Some("10.0.0.1"))).as_deref(),
            Some("https://10.0.0.1:1443")
        );
        assert_eq!(
            explicit_dapi_addresses(&forge_core::platform::Network::Testnet),
            None
        );
    }
}
