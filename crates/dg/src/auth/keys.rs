//! `dg auth keys list | add | disable | rotate` (ux-dx-spec §2.4, §2.5, §9).

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
    /// Register a limited key for this computer, or an encryption key.
    ///
    /// A limited key is what this computer then signs with (default: 0.25 DASH / 180
    /// days, bound to dash-forge; `--replace <id>` disables the old one in the same update), or
    /// with --encryption the ENCRYPTION key private repositories need. Needs the master key once.
    /// For a key to hand to CI use `dg auth export --new-key`. With `--for-browser <request>`
    /// the key is for a browser tab instead: dg prints it sealed to that tab, so the recovery
    /// phrase never goes into a web page.
    Add(AddArgs),
    /// Disable a key on Platform. Needs the master key once.
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
    /// Replace the encryption key after a lost device or a leak: add a new one from the recovery
    /// phrase, move every private repository you maintain to it, then disable the old one.
    ///
    /// Repositories you don't maintain are listed, for a maintainer to move. Run it again to
    /// continue after a failure. To replace a limited key, use `dg auth keys add --replace <id>`.
    Rotate {
        /// Replace the ENCRYPTION key (the only key this command rotates).
        #[arg(long, required = true)]
        encryption: bool,
        /// Keep the old key enabled (it still opens what was sealed for it).
        #[arg(long)]
        keep_old: bool,
        /// The identity file with the master key and the recovery phrase (else you are asked for
        /// the phrase).
        #[arg(long, value_name = "FILE")]
        master: Option<PathBuf>,
        #[command(flatten)]
        storage: StorageArgs,
    },
}

impl KeysCommand {
    /// The headline lead for errors.
    pub fn context(&self) -> &'static str {
        match self {
            KeysCommand::List => "could not list keys",
            KeysCommand::Add(_) => "key not added",
            KeysCommand::Disable { .. } => "key not disabled",
            KeysCommand::Rotate { .. } => "encryption key not replaced",
        }
    }
}

/// `dg auth keys add` arguments.
#[derive(Debug, clap::Args)]
pub struct AddArgs {
    /// Add an ENCRYPTION key (for private repositories) instead of a limited key.
    #[arg(long, conflicts_with_all = ["budget", "expires", "replace", "for_browser"])]
    pub encryption: bool,
    /// Register a limited key for a browser tab and print it sealed to that tab: paste the
    /// `dfkr1:` request the browser shows (Sign in → Use dg, or Renew). This computer keeps
    /// signing with its own key. Default limits are the browser's: 0.05 DASH for 90 days.
    #[arg(long, value_name = "REQUEST", conflicts_with = "keep_current")]
    pub for_browser: Option<String>,
    /// With --for-browser: also hand over the identity's encryption key, so the browser opens
    /// private repositories.
    #[arg(long, requires = "for_browser")]
    pub with_encryption_key: bool,
    /// With --for-browser: the identity the browser asked a key for. dg refuses, before anything
    /// is signed, to make the key for another identity.
    #[arg(long, value_name = "IDENTITY_ID", requires = "for_browser")]
    pub for_identity: Option<String>,
    /// Bound to the `dash-forge` contract group (the only binding dg makes; kept for the
    /// spec's command line).
    #[arg(long, value_name = "GROUP", default_value = "dash-forge", value_parser = ["dash-forge"])]
    pub bound: String,
    /// Disable this limited key in the same update (default: the one this computer signs with;
    /// none with --for-browser).
    #[arg(long, value_name = "KEY_ID")]
    pub replace: Option<u32>,
    /// Keep the key this computer signs with now valid on Platform (it is no longer stored here).
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
        KeysCommand::Rotate {
            encryption: _,
            keep_old,
            master,
            storage,
        } => super::rekey::rotate_encryption(ctx, master.as_deref(), storage, *keep_old).await,
    }
}

async fn list(ctx: &Ctx) -> Result<()> {
    let bridge = ctx.load_bridge()?;
    let client = ctx.connect().await?;
    let identity = client
        .fetch_signer(&bridge)
        .await
        .context("fetching the signing identity")?;
    // A disabled key this computer still holds is marked too (QW3-024).
    let mine = identity
        .signing_key_standing(&bridge, ctx.network())
        .map(|(id, _)| id);
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
        let doc_type = identity.key_doc_type(k.id).map(|(_, t)| t);
        rows.push(json!({
            "id": k.id,
            "purpose": k.purpose,
            "securityLevel": k.security_level,
            "keyType": k.key_type,
            "disabled": k.disabled,
            "boundTo": key_group.clone().or(k.bound_to.clone()),
            "forgeGroup": key_group.is_some() && key_group == group,
            "boundDocumentType": doc_type,
            "budgetCredits": limits.and_then(|l| l.total_budget),
            "budgetRemainingCredits": remaining,
            "expiresAt": limits.and_then(|l| l.expires_at),
            // Spend-capped (a budget or an expiry), live or disabled: what `dg auth status
            // --json` says of the key it signs with (QW4-049).
            "limited": limits.is_some_and(|l| l.total_budget.is_some() || l.expires_at.is_some()),
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
                key_label(r),
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

/// What a key is for, in `dg auth keys list`: `dash-forge ` for a Forge limited key, and
/// `checkRun only (CI runner) ` for a key bound to one document type (QW3-070: runner keys
/// had a blank label).
fn key_label(r: &serde_json::Value) -> String {
    if r["forgeGroup"].as_bool() == Some(true) {
        return "dash-forge ".into();
    }
    match r["boundDocumentType"].as_str() {
        Some("checkRun") => "checkRun only (CI runner) ".into(),
        Some(t) => format!("{t} only "),
        None => String::new(),
    }
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
        .cause("the key must come from the identity's recovery phrase, so that it alone recovers the key; the source given does not reproduce the identity's keys from its phrase")
        .fix("run it again and type the recovery phrase when asked, or pass --master <identity file> with the phrase")
        .note("nothing was sent")
    })?;
    let price = ctx.usd_price();
    if !ctx.json {
        println!(
            "Add ENCRYPTION key #{key_id} to {} (derived from the recovery phrase), {}",
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
            println!("✓ added ENCRYPTION key #{added}; the recovery phrase re-derives it");
            println!("  to use it from this computer: `dg auth login <identity file>` (or --mnemonic) stores it beside a limited key");
        },
    );
    Ok(())
}

/// The browser key defaults (`forge-web/lib/auth/limited-key.ts` `BROWSER_KEY_DEFAULTS`).
const BROWSER_KEY_BUDGET_DASH: f64 = 0.05;
const BROWSER_KEY_DAYS: u64 = 90;

/// The flag that selects `network`, a network key (`testnet`, `mainnet`, `devnet-<name>`).
fn network_flag(network: &str) -> String {
    match network.strip_prefix("devnet-") {
        Some(name) => format!("--devnet-name {name}"),
        None => format!("--network {network}"),
    }
}

/// The browser's `dfkr1:` request, refused when it is not one or is for another network.
fn browser_request(ctx: &Ctx, text: &str) -> Result<forge_core::browser_key::Request> {
    let request = forge_core::browser_key::parse_request(text).map_err(|e| {
        UserError::new(codes::USAGE, "that is not a browser key request")
            .cause(e.to_string())
            .fix("copy the whole command the browser shows, including the dfkr1:… request")
    })?;
    let network = ctx.network_label();
    if request.network != network {
        return Err(
            UserError::new(codes::USAGE, "the browser is on another network")
                .cause(format!(
                    "the request is from a site on {}, and dg is on {network}",
                    request.network
                ))
                .fix(format!(
                    "run it again with {}",
                    network_flag(&request.network)
                ))
                .note("nothing was sent")
                .into(),
        );
    }
    Ok(request)
}

/// The encryption key `--with-encryption-key` hands over: the highest-id one `sources` (the
/// master source and the key dg signs with) open.
/// Checked before anything is paid for, so a key dg cannot hand over never leaves the browser
/// with a signing key and a promise.
fn handover_encryption_key(
    ctx: &Ctx,
    identity: &forge_core::platform::LoadedIdentity,
    sources: &[&forge_core::keystore::BridgeIdentity],
) -> Result<forge_core::browser_key::EncryptionKey> {
    let storage = super::StorageArgs {
        insecure_plaintext: false,
        signing_only: false,
    };
    let key = super::encryption_to_store(ctx, &storage, identity, sources)
        .into_iter()
        .max_by_key(|k| k.id)
        .ok_or_else(|| {
            UserError::new(codes::KEY_CANNOT_SIGN, "no encryption key to hand over")
                .cause("this identity has no encryption key that the recovery words or the --master file open")
                .fix("run it without --with-encryption-key, or add one first: `dg auth keys add --encryption`")
                .note("nothing was sent")
        })?;
    Ok(forge_core::browser_key::EncryptionKey {
        key_id: key.id,
        private_key_hex: key.private_key_hex.expose().to_string(),
    })
}

/// The longest a browser key may live (the web app's longest choice, TS-06).
const BROWSER_KEY_MAX_DAYS: u64 = 365;

/// The master identity for `--for-browser`: `--master`, else the identity dg is signed in as,
/// else the recovery words (only when dg is not signed in at all: a key file that fails to
/// open is an error, not a reason to ask for the words). Refused when it is not `for_identity`.
async fn browser_master(
    ctx: &Ctx,
    client: &forge_core::platform::PlatformClient,
    args: &AddArgs,
) -> Result<(
    forge_core::keystore::BridgeIdentity,
    Option<forge_core::keystore::BridgeIdentity>,
)> {
    let current = match ctx.identity_path {
        Some(_) => Some(ctx.load_bridge()?),
        None => None,
    };
    let current_id = current.as_ref().map(|b| b.identity_id.clone());
    let master = match (&current_id, &args.master) {
        (None, None) => {
            eprintln!("{}", super::MASTER_PROMPT);
            let words = super::read_mnemonic()?;
            super::identity_from_words(ctx, client, &words).await?
        }
        _ => master_identity(
            ctx,
            args.master.as_deref(),
            current_id.as_deref().unwrap_or(""),
        )?,
    };
    if let Some(want) = &args.for_identity {
        if *want != master.identity_id {
            return Err(
                UserError::new(codes::KEY_CANNOT_SIGN, "that is a different identity")
                    .cause(format!(
                        "the browser asked for a key of {want}, and dg would sign for {}",
                        master.identity_id
                    ))
                    .fix(format!("pass --master with the identity file of {want}"))
                    .note("nothing was sent")
                    .into(),
            );
        }
    }
    Ok((master, current))
}

/// The key a reply carries, from the `dfk1:` text `register_limited_key` hands its `persist`.
fn handoff_payload(
    network: &str,
    dfk1: &forge_core::keystore::Secret,
    replaced: Option<u32>,
    encryption: Option<&forge_core::browser_key::EncryptionKey>,
) -> Result<forge_core::browser_key::Payload> {
    let bridge = forge_core::keystore::BridgeIdentity::from_dfk1(dfk1.expose())?;
    let key = bridge.doc_op_key()?;
    Ok(forge_core::browser_key::Payload {
        v: 1,
        network: network.to_string(),
        identity_id: bridge.identity_id.clone(),
        key_id: key.id,
        wif: key.private_key_wif.expose().to_string(),
        replaced_key_id: replaced,
        encryption_key: encryption.map(|e| forge_core::browser_key::EncryptionKey {
            key_id: e.key_id,
            private_key_hex: e.private_key_hex.clone(),
        }),
    })
}

/// `dg auth keys add --for-browser <request>` (TS-06): register a limited key for a browser tab
/// and print it sealed to the tab's one-time key (`forge_core::browser_key`). Nothing is stored
/// here; this computer's own key is untouched unless `--replace` names it.
async fn add_for_browser(ctx: &Ctx, args: &AddArgs, request: &str) -> Result<()> {
    let request = browser_request(ctx, request)?;
    let network = ctx.network_label();
    let client = ctx.connect().await?;
    let (master, current) = browser_master(ctx, &client, args).await?;
    let identity = client.fetch_signer(&master).await?;
    let encryption = if args.with_encryption_key {
        let sources: Vec<_> = std::iter::once(&master).chain(current.as_ref()).collect();
        Some(handover_encryption_key(ctx, &identity, &sources)?)
    } else {
        None
    };
    let spec = key_spec(ctx, &args.limits, BROWSER_KEY_BUDGET_DASH, BROWSER_KEY_DAYS)?;
    if spec.expires_at_ms > super::expiry_ms(BROWSER_KEY_MAX_DAYS) {
        return Err(crate::errors::usage(format!(
            "a browser key lives at most {BROWSER_KEY_MAX_DAYS} days; pass --expires 365d or less"
        )));
    }
    let checked = super::check_group(ctx, &client, &spec.group, args.limits.strict_group()).await?;
    super::explain_new_key(ctx, &master.identity_id, &spec, "for a browser", &checked);
    explain_handover(ctx, args.replace, encryption.as_ref());
    ctx.confirm_or_cancel("Add the key?")?;
    // The reply is sealed before anything is sent (as `register_limited_key` stores a key before
    // it registers it), and again if the key lands under another id.
    let seal = |dfk1: &forge_core::keystore::Secret| -> Result<(u32, String)> {
        let payload = handoff_payload(&network, dfk1, args.replace, encryption.as_ref())?;
        Ok((
            payload.key_id,
            forge_core::browser_key::seal(&request, &payload)?,
        ))
    };
    let mut sealed: Option<(u32, String, forge_core::keystore::Secret)> = None;
    let registered = super::register_limited_key(
        ctx,
        &client,
        &master,
        &spec,
        args.replace,
        &checked,
        &mut |t| {
            let (id, reply) = seal(t)?;
            sealed = Some((id, reply, t.clone()));
            Ok(())
        },
    )
    .await;
    let (id, reply, unconfirmed) = match (registered, sealed) {
        (Ok(id), Some((sealed_id, reply, _))) if id == sealed_id => (id, reply, None),
        (Ok(id), _) => {
            anyhow::bail!("internal error: key #{id} registered, but its reply was not sealed")
        }
        // The update errored but may have landed (a broadcast that timed out, a node behind):
        // a key that is on chain is handed over, or nobody would hold it.
        (Err(e), Some((_, _, dfk1))) => {
            let Some(landed) = landed_key(ctx, &client, &network, &dfk1).await else {
                return Err(e);
            };
            let (id, reply) = seal(&landed)?;
            (id, reply, Some(format!("{e:#}")))
        }
        (Err(e), None) => return Err(e),
    };
    ctx.emit(
        json!({
            "status": "added",
            "keyId": id,
            "budgetCredits": spec.budget_credits,
            "expiresAt": spec.expires_at_ms,
            "replacedKeyId": args.replace,
            "encryptionKeyId": encryption.as_ref().map(|e| e.key_id),
            "reply": reply,
            "warning": unconfirmed,
        }),
        || {
            if let Some(why) = &unconfirmed {
                eprintln!("note: the update reported an error ({why}), but key #{id} is on chain");
            }
            eprintln!("✓ limited key #{id} added for the browser");
            if let Some(old) = args.replace {
                eprintln!("  key #{old} disabled");
            }
            eprintln!(
                "Paste this line into the browser. It opens only in the tab that asked for it:"
            );
            println!("{reply}");
        },
    );
    Ok(())
}

/// The key in `dfk1` under the id it is live with on chain (a `dfk1:` text again), if it landed.
async fn landed_key(
    ctx: &Ctx,
    client: &forge_core::platform::PlatformClient,
    network: &str,
    dfk1: &forge_core::keystore::Secret,
) -> Option<forge_core::keystore::Secret> {
    let bridge = forge_core::keystore::BridgeIdentity::from_dfk1(dfk1.expose()).ok()?;
    let wif = bridge.doc_op_key().ok()?.private_key_wif.clone();
    let identity = client.fetch_identity(&bridge.identity_id).await.ok()?;
    let id = identity.key_id_for(wif.expose(), ctx.network())?;
    Some(forge_core::keystore::dfk1(
        network,
        &bridge.identity_id,
        id,
        wif.expose(),
    ))
}

/// What else the update does (human mode): the key it disables, the encryption key it hands over.
fn explain_handover(
    ctx: &Ctx,
    replace: Option<u32>,
    encryption: Option<&forge_core::browser_key::EncryptionKey>,
) {
    if ctx.json {
        return;
    }
    // Anyone can show a request: a look-alike page could ask for this command too.
    eprintln!(
        "  run this only for a Forge page you opened yourself: the key can write to Forge as you"
    );
    if let Some(old) = replace {
        eprintln!("  key #{old} is disabled in the same update");
    }
    if let Some(e) = encryption {
        eprintln!(
            "  the browser also gets encryption key #{}: it opens your private repositories",
            e.key_id
        );
    }
}

async fn add(ctx: &Ctx, args: &AddArgs) -> Result<()> {
    if let Some(request) = &args.for_browser {
        return add_for_browser(ctx, args, request).await;
    }
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
    let before = client.get_balance(&full.identity_id).await.unwrap_or(0);
    super::disable_key(&client, &full, id).await?;
    // Every paid write ends with its charge (QW3-070).
    let spent = crate::common::spent_since(&client, &full.identity_id, before).await;
    let price = ctx.usd_price();
    ctx.emit(
        json!({
            "status": "disabled",
            "keyId": id,
            "cost": crate::fmt::cost_json(spent, price),
        }),
        || {
            println!(
                "✓ key #{id} disabled; it can no longer sign · {}",
                crate::fmt::cost_line(spent, price)
            );
        },
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::network_flag;

    #[test]
    fn the_network_flag_matches_the_browser_command() {
        assert_eq!(network_flag("devnet-sakura"), "--devnet-name sakura");
        assert_eq!(network_flag("testnet"), "--network testnet");
    }
}
