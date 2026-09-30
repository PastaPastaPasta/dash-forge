//! `dg auth keys list | add | disable` (ux-dx-spec §2.4, §2.5, §9).

use std::path::PathBuf;

use anyhow::{Context as _, Result};
use clap::Subcommand;
use serde_json::json;

use super::{
    dash_amount, expiry_text, key_spec, master_identity, KeyLimitArgs, StorageArgs,
    CLI_KEY_BUDGET_DASH, CLI_KEY_DAYS,
};
use crate::context::Ctx;
use crate::fmt::credits_to_dash;
use forge_core::user_error::{codes, UserError};

/// `dg auth keys` subcommands.
#[derive(Debug, Subcommand)]
pub enum KeysCommand {
    /// List the identity's keys with purpose, level, limits and state.
    List,
    /// Register a key: a limited key this computer then signs with (default: 0.25 DASH / 180
    /// days, bound to dash-forge; `--replace <id>` disables the old one in the same update), or
    /// with --encryption the ENCRYPTION key private repositories need. Needs the master key once.
    /// For a key to hand to CI use `dg auth export --new-key`.
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
    #[arg(long, conflicts_with_all = ["budget", "expires", "replace"])]
    pub encryption: bool,
    /// Bound to the `dash-forge` contract group (the only binding dg makes; kept for the
    /// spec's command line).
    #[arg(long, value_name = "GROUP", default_value = "dash-forge", value_parser = ["dash-forge"])]
    pub bound: String,
    /// Disable this limited key in the same update (default: the one this computer signs with).
    #[arg(long, value_name = "KEY_ID")]
    pub replace: Option<u32>,
    /// Keep the key this computer signs with now live on chain (it is no longer stored here).
    #[arg(long, conflicts_with = "replace")]
    pub keep_current: bool,
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
        .fetch_signer(&bridge)
        .await
        .context("fetching the signing identity")?;
    let mine = identity.signing_key_id(&bridge, ctx.network());
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

/// Register an ENCRYPTION key for an identity that has none (`docs/security/private-repos.md`
/// §5.2): derived from the recovery words at the identity's DIP-13 key path with the next key
/// id, so the words alone recover it. One identity update signed by the master key.
///
/// Only a master identity that carries its words can do this: the private half must be
/// recoverable. Readers (`git clone`, `dg`) need the key's private half in the key source they
/// sign with: `dg auth login` again stores it beside a limited key (QW2-004), and the words'
/// file now derives it.
async fn add_encryption(
    ctx: &Ctx,
    client: &forge_core::platform::PlatformClient,
    master: &forge_core::keystore::BridgeIdentity,
) -> Result<()> {
    use forge_core::platform::identity_keys;
    let identity = client.fetch_signer(master).await?;
    let key_id = identity_keys::next_key_id(&identity);
    let secret = if identity_keys::recorded_keys_match(master, &identity.public_keys()) {
        identity_keys::derive_encryption_secret(master, key_id, ctx.network())
    } else {
        None
    }
    .ok_or_else(|| {
        UserError::new(
            codes::KEY_CANNOT_SIGN,
            "the ENCRYPTION key cannot be derived from what was given",
        )
        .cause("the key must come from the identity's recovery words, so that they alone recover it; the source given does not reproduce the identity's keys from its words")
        .fix("run it again and type the recovery words when asked, or pass --master <identity file> with the words")
        .note("nothing was sent")
    })?;
    let price = crate::fmt::dash_usd_price();
    if !ctx.json {
        println!(
            "Add ENCRYPTION key #{key_id} to {} (derived from the recovery words), {}",
            master.identity_id,
            crate::fmt::cost_line(identity_keys::ADD_KEY_ESTIMATE_CREDITS, price)
        );
        println!("  This key can read every private repo you're a member of, and every key you've handed out as a maintainer.");
    }
    ctx.confirm_or_cancel("Add the key?")?;
    let added = identity_keys::add_encryption_key(client, &identity, master, &secret)
        .await
        .context("adding the encryption key")?;
    ctx.emit(
        json!({
            "status": "added",
            "identityId": master.identity_id,
            "keyId": added,
            "purpose": "ENCRYPTION",
            "derived": true,
        }),
        || {
            println!("✓ added ENCRYPTION key #{added}; the recovery words re-derive it");
            println!("  to use it from this computer: `dg auth login <identity file>` (or --mnemonic) stores it beside a limited key");
        },
    );
    Ok(())
}

async fn add(ctx: &Ctx, args: &AddArgs) -> Result<()> {
    let current = ctx.load_bridge()?;
    let client = ctx.connect().await?;
    let master = master_identity(ctx, args.master.as_deref(), &current.identity_id)?;
    if args.encryption {
        // Every identity dg creates already has one (key #4, from the recovery words). Adding
        // another would register a key whose private half nothing keeps yet.
        let identity = client.fetch_signer(&master).await?;
        let existing = identity
            .public_keys()
            .into_iter()
            .find(|k| !k.disabled && k.purpose == "ENCRYPTION" && k.bound_to.is_none());
        return match existing {
            Some(k) => {
                ctx.emit(
                    json!({ "status": "exists", "keyId": k.id, "purpose": "ENCRYPTION" }),
                    || {
                        println!(
                            "identity {} already has an ENCRYPTION key (#{}); private repositories use it",
                            master.identity_id, k.id
                        );
                    },
                );
                Ok(())
            }
            None => add_encryption(ctx, &client, &master).await,
        };
    }
    let spec = key_spec(ctx, &args.limits, CLI_KEY_BUDGET_DASH, CLI_KEY_DAYS)?;
    let checked = super::check_group(ctx, &client, &spec.group, args.limits.strict_group()).await?;
    super::explain_new_key(
        ctx,
        &master.identity_id,
        &spec,
        "for this computer",
        &checked,
    );
    ctx.confirm_or_cancel("Add the key?")?;
    // The key this computer signs with now is replaced by default: otherwise it would stay live
    // on chain with nothing holding it. `--replace` names another one; `--keep-current` keeps it.
    let identity = client.fetch_signer(&master).await?;
    let replace = match args.replace {
        Some(id) => Some(id),
        None if args.keep_current => None,
        None => identity
            .signing_key_id(&current, ctx.network())
            .filter(|id| identity.is_limited_key(*id)),
    };
    // The encryption keys the key in use holds are kept too, whatever the master source holds.
    let encryption =
        super::encryption_to_store(ctx, &args.storage, &identity, &[&master, &current]);
    let (id, stored) = super::register_and_store(
        ctx,
        &client,
        &master,
        &spec,
        replace,
        &checked,
        args.storage.insecure_plaintext,
        &encryption,
    )
    .await?;
    let kept: Vec<u32> = encryption.iter().map(|k| k.id).collect();
    super::store::set_default(ctx, &master.identity_id, &stored.source())?;
    ctx.emit(
        super::group::with_group_fields(
            json!({
                "status": "added",
                "keyId": id,
                "budgetCredits": spec.budget_credits,
                "expiresAt": spec.expires_at_ms,
                "storedAt": stored.describe(),
                "encryptionKeyIds": kept,
                "replacedKeyId": replace,
            }),
            Some(&checked),
        ),
        || {
            println!("✓ limited key #{id} added; this computer now signs with it");
            super::print_kept_encryption(&kept);
            println!("  stored in {}", stored.describe());
            if let Some(old) = replace {
                println!("  key #{old} disabled");
            }
        },
    );
    Ok(())
}

async fn disable(ctx: &Ctx, id: u32, master: Option<&std::path::Path>, force: bool) -> Result<()> {
    let current = ctx.load_bridge()?;
    let client = ctx.connect().await?;
    let identity = client.fetch_signer(&current).await?;
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
    // A CI runner key (bound to one document type, `dg ci runner new`) is a Forge key too.
    let forge_key = identity.is_limited_key(id) || identity.key_doc_type(id).is_some();
    if !forge_key && !force {
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
    super::disable_key(&client, &full, id).await?;
    ctx.emit(json!({ "status": "disabled", "keyId": id }), || {
        println!("✓ key #{id} disabled; it can no longer sign");
    });
    Ok(())
}
