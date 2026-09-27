//! `dg auth` — identity import, status, balance, and the identity's keys.

use anyhow::{Context, Result};
use serde_json::json;

use forge_core::keystore::BridgeIdentity;
use forge_core::platform::identity_keys::{self, EncryptionSecret, ADD_KEY_ESTIMATE_CREDITS};
use forge_core::platform::IdentityKeyInfo;

use crate::config::{identities_dir, Config};
use crate::context::Ctx;
use crate::fmt::{balance_json, cost_json, cost_line, credits_to_dash, dash_usd_price};
use crate::{AuthCommand, AuthKeysCommand};

/// What an encryption key exposes, shown before one is added (private-repos.md §5.2).
pub const ENCRYPTION_KEY_BLAST_RADIUS: &str = "This key can read every private repo you're a \
    member of, and every key you've handed out as a maintainer.";

/// Dispatch an `auth` subcommand.
pub async fn run(ctx: &Ctx, cmd: &AuthCommand) -> Result<()> {
    match cmd {
        AuthCommand::Login => login(ctx).await,
        AuthCommand::Status => status(ctx),
        AuthCommand::Balance => balance(ctx).await,
        AuthCommand::Keys(AuthKeysCommand::List) => keys_list(ctx).await,
        AuthCommand::Keys(AuthKeysCommand::Add { force, .. }) => {
            keys_add_encryption(ctx, *force).await
        }
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

    let bridge = BridgeIdentity::load_from_file(&src).with_context(|| {
        format!(
            "loading identity from {}",
            forge_core::keystore::describe_key_source(&src)
        )
    })?;
    if forge_core::keystore::is_inline_key(&src) {
        anyhow::bail!(
            "`dg auth login` stores an identity file; a dfk1: key is used directly via \
             DASH_FORGE_KEY and is never written to disk"
        );
    }
    let network = ctx.network_label();

    // Copy the export into the per-network import directory. The copy holds every private
    // key, so the directory is 0700 and the file 0600 from the moment it exists (created
    // with that mode, not chmod-ed after a world-readable write).
    let dir = identities_dir(&network)?;
    std::fs::create_dir_all(&dir).with_context(|| format!("creating {}", dir.display()))?;
    let dest = dir.join(format!("{}.identity.json", bridge.identity_id));
    let raw =
        std::fs::read_to_string(&src).with_context(|| format!("reading {}", src.display()))?;
    write_private(&dir, &dest, raw.as_bytes())
        .with_context(|| format!("writing {}", dest.display()))?;

    // Record as the config default (network + identity path + id). A devnet also records
    // its name, or the next command could not reconnect to it. Its DAPI list is recorded
    // only when it differs from the deployment file's: config outranks that file, so
    // copying the file's list here would pin it past a devnet reset that updates the file.
    let mut config = Config::load().unwrap_or_default();
    config.network = Some(ctx.network().kind().to_string());
    config.devnet_name = ctx.network().devnet_name().map(str::to_string);
    config.dapi_addresses = explicit_dapi_addresses(ctx.network());
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

/// Write `bytes` to `dest` readable by the owner only: `dir` is tightened to 0700, the file
/// is created 0600 (an existing file is re-tightened before it is overwritten). A no-op
/// mode change on platforms without Unix permissions.
fn write_private(dir: &std::path::Path, dest: &std::path::Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write as _;
    #[cfg(unix)]
    {
        use std::os::unix::fs::{OpenOptionsExt as _, PermissionsExt as _};
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
        if dest.exists() {
            std::fs::set_permissions(dest, std::fs::Permissions::from_mode(0o600))?;
        }
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(dest)?;
        f.write_all(bytes)?;
    }
    #[cfg(not(unix))]
    {
        let _ = dir;
        std::fs::File::create(dest)?.write_all(bytes)?;
    }
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
        .map(|p| forge_core::keystore::describe_key_source(p));

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

/// How a key's contract bound reads: the forge contract's name when it is one of them.
fn bound_label(ctx: &Ctx, bound_to: Option<&str>) -> String {
    let Some(id) = bound_to else {
        return "-".into();
    };
    match &ctx.target.v2 {
        Some(v2) if id == v2.core => format!("forge-core ({id})"),
        Some(v2) if id == v2.collab => format!("forge-collab ({id})"),
        _ => id.to_string(),
    }
}

/// `dg auth keys list`: the identity's on-chain keys, and whether the identity file holds the
/// private key of each. No secret is printed.
async fn keys_list(ctx: &Ctx) -> Result<()> {
    let (_client, bridge, identity) = ctx.connect_with_identity().await?;
    let keys = identity.public_keys();
    let rows: Vec<(&IdentityKeyInfo, bool)> = keys
        .iter()
        .map(|k| (k, identity_keys::file_holds_key(&bridge, k)))
        .collect();
    ctx.emit(
        json!({
            "identityId": bridge.identity_id,
            "network": ctx.network_label(),
            "keys": rows.iter().map(|(k, held)| json!({
                "id": k.id,
                "purpose": k.purpose,
                "securityLevel": k.security_level,
                "keyType": k.key_type,
                "enabled": !k.disabled,
                "boundTo": k.bound_to,
                "publicKeyHex": hex::encode(&k.public_key),
                "inIdentityFile": held,
            })).collect::<Vec<_>>(),
        }),
        || {
            println!("Identity: {}", bridge.identity_id);
            println!(
                "{:>3}  {:<14}  {:<8}  {:<15}  {:<8}  {:<7}  bound to",
                "id", "purpose", "level", "type", "state", "in file"
            );
            for (k, held) in &rows {
                println!(
                    "{:>3}  {:<14}  {:<8}  {:<15}  {:<8}  {:<7}  {}",
                    k.id,
                    k.purpose,
                    k.security_level,
                    k.key_type,
                    if k.disabled { "disabled" } else { "enabled" },
                    if *held { "yes" } else { "no" },
                    bound_label(ctx, k.bound_to.as_deref()),
                );
            }
        },
    );
    Ok(())
}

/// The identity's usable encryption keys whose private key the identity file holds: enabled,
/// `ECDSA_SECP256K1`, unbound or bound to the network's forge-core contract.
fn held_usable_encryption_keys<'k>(
    ctx: &Ctx,
    bridge: &BridgeIdentity,
    keys: &'k [IdentityKeyInfo],
) -> Vec<&'k IdentityKeyInfo> {
    // With no forge-v2 deployment only an unbound key qualifies.
    let core = ctx.target.v2.as_ref().map_or("", |v2| v2.core.as_str());
    keys.iter()
        .filter(|k| k.is_usable_encryption_key(core) && identity_keys::file_holds_key(bridge, k))
        .collect()
}

/// The key to add and how to record it: a pending entry of an earlier run (reused when it
/// still has the next id, moved when it is a random key and another key took its id), else a
/// key derived from the mnemonic, else a random one.
struct NewKey {
    secret: EncryptionSecret,
    derivation_path: String,
    /// The pending entry this replaces in the identity file (it moves to the new id).
    replaces: Option<u32>,
    /// The file already holds the entry exactly as it will be added.
    already_stored: bool,
}

impl NewKey {
    fn derived(&self) -> bool {
        !self.derivation_path.is_empty()
    }
}

fn choose_new_key(
    ctx: &Ctx,
    bridge: &BridgeIdentity,
    on_chain: &[IdentityKeyInfo],
    key_id: u32,
) -> Result<NewKey> {
    let on_chain_ids: Vec<u32> = on_chain.iter().map(|k| k.id).collect();
    let pending = bridge.pending_encryption_key(&on_chain_ids);
    if let Some(p) = pending {
        let secret = EncryptionSecret::from_identity_key(p).with_context(|| {
            format!(
                "reading the pending encryption key {} of the identity file",
                p.id
            )
        })?;
        let random = p.derivation_path.trim().is_empty();
        if p.id == key_id {
            return Ok(NewKey {
                secret,
                derivation_path: p.derivation_path.clone(),
                replaces: None,
                already_stored: true,
            });
        }
        if random {
            // A random key has no other copy: keep it, under the id it will really get.
            return Ok(NewKey {
                secret,
                derivation_path: String::new(),
                replaces: Some(p.id),
                already_stored: false,
            });
        }
    }
    let replaces = pending.map(|p| p.id);
    let network = ctx.network();
    if let (Some(secret), Some(path)) = (
        identity_keys::derive_encryption_secret(bridge, key_id, network),
        identity_keys::identity_key_path(bridge, key_id),
    ) {
        return Ok(NewKey {
            secret,
            derivation_path: path,
            replaces,
            already_stored: false,
        });
    }
    Ok(NewKey {
        secret: identity_keys::random_encryption_secret()?,
        derivation_path: String::new(),
        replaces,
        already_stored: false,
    })
}

/// What `dg auth keys add --encryption` is about to do, its cost and the blast-radius warning.
fn print_add_preview(
    ctx: &Ctx,
    identity_id: &str,
    key_id: u32,
    new_key: &NewKey,
    path: &std::path::Path,
    price: f64,
) {
    println!(
        "Adding encryption key {key_id} to {identity_id} on {}",
        ctx.network_label()
    );
    println!(
        "  one identity update (signed by the MASTER key)  {}",
        cost_line(ADD_KEY_ESTIMATE_CREDITS, price)
    );
    if new_key.derived() {
        println!(
            "  derived from your recovery phrase at {}",
            new_key.derivation_path
        );
    } else {
        println!(
            "  a random key: your identity file will be its only copy. Back up {} after this; \
             the 12 words alone cannot restore it.",
            path.display()
        );
    }
    println!("{ENCRYPTION_KEY_BLAST_RADIUS}");
}

/// `dg auth keys add --encryption`: add an `ENCRYPTION` key for private repositories.
///
/// Order: the key is written to the identity file first, then the identity update is sent, so
/// a random key is never lost when the update lands but the process dies. A re-run reuses an
/// `ENCRYPTION` entry of the file that is not on chain yet.
async fn keys_add_encryption(ctx: &Ctx, force: bool) -> Result<()> {
    let path = ctx.require_identity_path()?.clone();
    if forge_core::keystore::is_inline_key(&path) {
        anyhow::bail!(
            "`dg auth keys add` needs the identity file: a dfk1: key has no MASTER key to sign \
             the identity update and no file to store the new key in; nothing was sent"
        );
    }
    let bridge = ctx.load_bridge()?;
    identity_keys::require_master_key(&bridge)?;
    let client = ctx.connect().await?;
    let identity = client
        .fetch_identity(&bridge.identity_id)
        .await
        .context("fetching the signing identity")?;
    let on_chain = identity.public_keys();
    let network = ctx.network_label();

    let held = held_usable_encryption_keys(ctx, &bridge, &on_chain);
    if let (Some(existing), false) = (held.iter().max_by_key(|k| k.id), force) {
        ctx.emit(
            json!({
                "status": "exists",
                "identityId": bridge.identity_id,
                "network": network,
                "keyId": existing.id,
            }),
            || {
                println!(
                    "Identity {} already has a usable encryption key (key {}), and the identity \
                     file holds it. Nothing to do; pass --force to add another.",
                    bridge.identity_id, existing.id
                );
            },
        );
        return Ok(());
    }

    let key_id = identity_keys::next_key_id(&identity);
    let new_key = choose_new_key(ctx, &bridge, &on_chain, key_id)?;
    let price = dash_usd_price();
    if !ctx.json {
        print_add_preview(ctx, &bridge.identity_id, key_id, &new_key, &path, price);
    }
    ctx.confirm_or_cancel("Add the key?")?;

    if !new_key.already_stored {
        let entry = identity_keys::encryption_key_entry(
            &new_key.secret,
            key_id,
            ctx.network(),
            &new_key.derivation_path,
        );
        forge_core::keystore::store_identity_key(&path, &entry, new_key.replaces)
            .with_context(|| format!("writing the new key into {}", path.display()))?;
    }

    let before = identity.balance();
    let added = identity_keys::add_encryption_key(&client, &identity, &bridge, &new_key.secret)
        .await
        .context("adding the encryption key")?;
    // Best effort: the measured cost from the balance difference.
    let after = client.get_balance(&bridge.identity_id).await.ok();
    let spent = after.map(|a| before.saturating_sub(a));

    ctx.emit(
        json!({
            "status": "added",
            "identityId": bridge.identity_id,
            "network": network,
            "keyId": added,
            "purpose": "ENCRYPTION",
            "securityLevel": "MEDIUM",
            "keyType": "ECDSA_SECP256K1",
            "publicKeyHex": hex::encode(new_key.secret.public_key()),
            "derived": new_key.derived(),
            "derivationPath": (new_key.derived()).then_some(&new_key.derivation_path),
            "identityFile": path.to_string_lossy(),
            "estimate": cost_json(ADD_KEY_ESTIMATE_CREDITS, price),
            "cost": spent.map(|c| cost_json(c, price)),
            "warning": ENCRYPTION_KEY_BLAST_RADIUS,
        }),
        || {
            println!("Added encryption key {added}.");
            if let Some(c) = spent {
                println!("Cost: {}", cost_line(c, price));
            }
            println!("Stored its private key in {}.", path.display());
            if !new_key.derived() {
                println!("Back up this file now: it is the only copy of the key.");
            }
        },
    );
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

    #[cfg(unix)]
    #[test]
    fn the_imported_identity_copy_is_owner_only() {
        use std::os::unix::fs::PermissionsExt as _;
        let tmp = std::env::temp_dir().join(format!("dg-auth-private-{}", std::process::id()));
        let dir = tmp.join("identities");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        let dest = dir.join("x.identity.json");
        // A pre-existing world-readable copy (what older versions left) is tightened too.
        std::fs::write(&dest, b"old").unwrap();
        std::fs::set_permissions(&dest, std::fs::Permissions::from_mode(0o644)).unwrap();
        super::write_private(&dir, &dest, b"{}").unwrap();
        let mode = |p: &std::path::Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&dest), 0o600);
        assert_eq!(mode(&dir), 0o700);
        assert_eq!(std::fs::read(&dest).unwrap(), b"{}");
        std::fs::remove_dir_all(&tmp).ok();
    }
}
