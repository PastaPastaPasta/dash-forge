//! `dg auth keys list | add | disable` (ux-dx-spec §2.4, §2.5, §9).

use std::path::PathBuf;

use anyhow::{Context as _, Result};
use clap::Subcommand;
use serde_json::json;

use forge_core::platform::identity::{FreshKey, KeySpec};

use super::{
    dash_amount, expiry_text, key_spec, master_identity, register_limited_key, KeyLimitArgs,
    StorageArgs, CLI_KEY_BUDGET_DASH, CLI_KEY_DAYS, KEY_UPDATE_ESTIMATE_CREDITS,
};
use crate::context::Ctx;
use crate::fmt::credits_to_dash;

/// `dg auth keys` subcommands.
#[derive(Debug, Subcommand)]
pub enum KeysCommand {
    /// List the identity's keys with purpose, level, limits and state.
    List,
    /// Register a key: a limited key (default: 0.25 DASH / 180 days, bound to dash-forge), or
    /// with --encryption the ENCRYPTION key private repositories need. Needs the master key once.
    Add(AddArgs),
    /// Disable a key on chain. Needs the master key once.
    Disable {
        /// The key id (`dg auth keys list`).
        id: u32,
        /// The identity file with the master key (else you are asked for the words).
        #[arg(long, value_name = "FILE")]
        master: Option<PathBuf>,
        /// Allow disabling a key that is not a Forge limited key.
        #[arg(long)]
        force: bool,
    },
}

impl KeysCommand {
    /// The headline lead for errors.
    pub fn context(&self) -> &'static str {
        match self {
            KeysCommand::List => "could not list keys",
            KeysCommand::Add(_) => "key not added",
            KeysCommand::Disable { .. } => "key not disabled",
        }
    }
}

/// `dg auth keys add` arguments.
#[derive(Debug, clap::Args)]
pub struct AddArgs {
    /// Add an ENCRYPTION key (for private repositories) instead of a limited key.
    #[arg(long, conflicts_with_all = ["budget", "expires", "use_it"])]
    pub encryption: bool,
    /// Bound to the `dash-forge` contract group (the only binding dg makes; kept for the
    /// spec's command line).
    #[arg(long, value_name = "GROUP", default_value = "dash-forge", value_parser = ["dash-forge"])]
    pub bound: String,
    /// Store the new limited key and make it the one this computer signs with.
    #[arg(long = "use")]
    pub use_it: bool,
    /// The identity file with the master key (else you are asked for the words).
    #[arg(long, value_name = "FILE")]
    pub master: Option<PathBuf>,
    #[command(flatten)]
    pub limits: KeyLimitArgs,
    #[command(flatten)]
    pub storage: StorageArgs,
}

/// Dispatch a `keys` subcommand.
pub async fn run(ctx: &Ctx, cmd: &KeysCommand) -> Result<()> {
    match cmd {
        KeysCommand::List => list(ctx).await,
        KeysCommand::Add(args) => add(ctx, args).await,
        KeysCommand::Disable { id, master, force } => {
            disable(ctx, *id, master.as_deref(), *force).await
        }
    }
}

async fn list(ctx: &Ctx) -> Result<()> {
    let bridge = ctx.load_bridge()?;
    let client = ctx.connect().await?;
    let identity = client
        .fetch_identity(&bridge.identity_id)
        .await
        .context("fetching the signing identity")?;
    let mine = bridge
        .doc_op_key()
        .ok()
        .and_then(|k| identity.key_id_for(k.private_key_wif.expose(), ctx.network()));
    let group = ctx.target.v2.as_ref().map(|f| f.group.clone());
    let mut rows = Vec::new();
    for k in identity.public_keys() {
        let limits = identity.key_limits(k.id);
        let remaining = if limits.is_some_and(|l| l.total_budget.is_some()) {
            client
                .key_remaining_budget(&identity.id(), k.id)
                .await
                .ok()
                .flatten()
        } else {
            None
        };
        let key_group = identity.key_group(k.id);
        rows.push(json!({
            "id": k.id,
            "purpose": k.purpose,
            "securityLevel": k.security_level,
            "keyType": k.key_type,
            "disabled": k.disabled,
            "boundTo": key_group.clone().or(k.bound_to.clone()),
            "forgeGroup": key_group.is_some() && key_group == group,
            "budgetCredits": limits.and_then(|l| l.total_budget),
            "budgetRemainingCredits": remaining,
            "expiresAt": limits.and_then(|l| l.expires_at),
            "limited": identity.is_limited_key(k.id),
            "thisComputer": mine == Some(k.id),
        }));
    }
    ctx.emit(json!({ "identityId": identity.id(), "keys": rows }), || {
        println!("Keys of {}:", identity.id());
        for r in &rows {
            let limits = match (r["budgetCredits"].as_u64(), r["expiresAt"].as_u64()) {
                (Some(total), exp) => format!(
                    "  {} of {} DASH left, expires {}",
                    r["budgetRemainingCredits"]
                        .as_u64()
                        .map_or("?".into(), |c| dash_amount(credits_to_dash(c))),
                    dash_amount(credits_to_dash(total)),
                    exp.map_or("never".into(), expiry_text)
                ),
                _ => String::new(),
            };
            println!(
                "  #{:<3} {:<14} {:<8} {}{}{}{}",
                r["id"],
                r["purpose"].as_str().unwrap_or(""),
                r["securityLevel"].as_str().unwrap_or(""),
                if r["forgeGroup"].as_bool() == Some(true) {
                    "dash-forge "
                } else {
                    ""
                },
                if r["disabled"].as_bool() == Some(true) {
                    "DISABLED"
                } else {
                    ""
                },
                limits,
                if r["thisComputer"].as_bool() == Some(true) {
                    "  ← this computer"
                } else {
                    ""
                }
            );
        }
    });
    Ok(())
}

async fn add(ctx: &Ctx, args: &AddArgs) -> Result<()> {
    let current = ctx.load_bridge()?;
    let client = ctx.connect().await?;
    let master = master_identity(ctx, args.master.as_deref(), &current.identity_id)?;
    let price = crate::fmt::dash_usd_price();
    if args.encryption {
        let identity = client.fetch_identity(&master.identity_id).await?;
        let existing = identity
            .public_keys()
            .into_iter()
            .find(|k| !k.disabled && k.purpose == "ENCRYPTION" && k.bound_to.is_none());
        if let Some(k) = existing {
            return Err(crate::errors::usage(format!(
                "identity {} already has an ENCRYPTION key (#{}); private repositories use it",
                master.identity_id, k.id
            )));
        }
        if !ctx.json {
            eprintln!(
                "Adding an ENCRYPTION key to {}: one identity update, {}",
                master.identity_id,
                crate::fmt::cost_line(KEY_UPDATE_ESTIMATE_CREDITS, price)
            );
            eprintln!(
                "  its private key is derived from nothing: keep the export `dg auth export` makes"
            );
        }
        ctx.confirm_or_cancel("Add the key?")?;
        let fresh = FreshKey::generate(ctx.network());
        let ids = client
            .update_identity_keys(
                &master.identity_id,
                &master
                    .master_key()
                    .context("no master key")?
                    .private_key_wif,
                &[(&fresh, KeySpec::Encryption)],
                &[],
            )
            .await?;
        let id = *ids.first().context("no key id")?;
        ctx.emit(
            json!({ "status": "added", "keyId": id, "purpose": "ENCRYPTION", "identityId": master.identity_id }),
            || {
                println!("✓ ENCRYPTION key #{id} added to {}", master.identity_id);
                println!("  note: dg does not store it yet; private repositories arrive in a later release");
            },
        );
        return Ok(());
    }
    let spec = key_spec(ctx, &args.limits, CLI_KEY_BUDGET_DASH, CLI_KEY_DAYS)?;
    if !ctx.json {
        eprintln!(
            "Adding a limited key to {}: {} DASH, only on Dash Forge, expires {}; {}",
            master.identity_id,
            dash_amount(credits_to_dash(spec.budget_credits)),
            expiry_text(spec.expires_at_ms),
            crate::fmt::cost_line(KEY_UPDATE_ESTIMATE_CREDITS, price)
        );
    }
    ctx.confirm_or_cancel("Add the key?")?;
    let (id, dfk1) = register_limited_key(ctx, &client, &master, &spec, None).await?;
    let stored = if args.use_it {
        let s = super::store::store(
            &ctx.network_label(),
            &master.identity_id,
            &dfk1,
            args.storage.insecure_plaintext,
        )?;
        super::store::set_default(ctx, &master.identity_id, &s.source())?;
        Some(s)
    } else {
        None
    };
    ctx.emit(
        json!({
            "status": "added",
            "keyId": id,
            "budgetCredits": spec.budget_credits,
            "expiresAt": spec.expires_at_ms,
            "storedAt": stored.as_ref().map(super::store::Stored::describe),
        }),
        || {
            println!("✓ limited key #{id} added");
            match &stored {
                Some(s) => println!("  this computer now signs with it ({})", s.describe()),
                None => println!(
                    "  not stored: use `dg auth export --new-key` to hand a key to CI, or re-run with --use"
                ),
            }
        },
    );
    Ok(())
}

async fn disable(ctx: &Ctx, id: u32, master: Option<&std::path::Path>, force: bool) -> Result<()> {
    let current = ctx.load_bridge()?;
    let client = ctx.connect().await?;
    let identity = client.fetch_identity(&current.identity_id).await?;
    let info = identity
        .public_keys()
        .into_iter()
        .find(|k| k.id == id)
        .with_context(|| format!("identity {} has no key #{id}", current.identity_id))?;
    if info.disabled {
        ctx.emit(json!({ "status": "already_disabled", "keyId": id }), || {
            println!("key #{id} is already disabled");
        });
        return Ok(());
    }
    if info.security_level == "MASTER" {
        return Err(crate::errors::usage("the MASTER key cannot be disabled"));
    }
    if !identity.is_limited_key(id) && !force {
        return Err(crate::errors::usage(format!(
            "key #{id} is not a Forge limited key ({} / {}); pass --force to disable it anyway",
            info.purpose, info.security_level
        )));
    }
    let full = master_identity(ctx, master, &current.identity_id)?;
    ctx.confirm_or_cancel(&format!(
        "Disable key #{id} of {}? (one identity update)",
        current.identity_id
    ))?;
    client
        .update_identity_keys(
            &current.identity_id,
            &full.master_key().context("no master key")?.private_key_wif,
            &[],
            &[id],
        )
        .await?;
    ctx.emit(json!({ "status": "disabled", "keyId": id }), || {
        println!("✓ key #{id} disabled; it can no longer sign");
    });
    Ok(())
}
