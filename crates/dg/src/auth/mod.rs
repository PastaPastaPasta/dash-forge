//! `dg auth` — identities and keys (ux-dx-spec §2.1, §2.4).
//!
//! Daily use runs on a **limited key**: AUTHENTICATION / HIGH, bound to the `dash-forge`
//! contract group, with a budget and an expiry (CLI default 0.25 DASH / 180 days). The master
//! key appears only in one-time ceremonies — creating the identity, registering or disabling a
//! limited key, registering a DPNS name — and is not stored unless `--full-key` asks for it.
//!
//! - `new` — recovery words → deposit QR → asset lock → identity with its canonical keys and a
//!   limited key in one IdentityCreate ([`new`]).
//! - `login` — import an identity file or the recovery words once, register a limited key,
//!   store only that key.
//! - `status`, `balance`, `keys list|add|disable`, `name register`, `export`, `logout`.

mod keys;
mod new;
pub mod store;

use std::path::PathBuf;

use anyhow::{Context as _, Result};
use clap::Subcommand;
use serde_json::json;

use forge_core::keystore::{self, BridgeIdentity, Secret};
use forge_core::platform::identity::{
    self, dpns_label_kind, dpns_normalize, FreshKey, KeySpec, LimitedKeySpec, NewIdentityKeys,
};
use forge_core::platform::{LoadedIdentity, PlatformClient};
use forge_core::user_error::{codes, UserError};

use crate::config::Config;
use crate::context::Ctx;
use crate::fmt::{balance_json, credits_to_dash, dash_amount};

/// CLI limited-key defaults (spec §2.1): 0.25 DASH for 180 days.
pub const CLI_KEY_BUDGET_DASH: f64 = 0.25;
/// CLI limited-key default lifetime in days.
pub const CLI_KEY_DAYS: u64 = 180;
const DAY_MS: u64 = 24 * 60 * 60 * 1000;

/// `dg auth` subcommands.
#[derive(Debug, Subcommand)]
pub enum AuthCommand {
    /// Create an identity: recovery words, a deposit address to fund from any Dash wallet, then
    /// the identity with a limited key for this computer (stored in the OS keychain).
    New(new::NewArgs),
    /// Sign in with an identity file or the recovery words: registers a limited key (the master
    /// key is used once and not stored, unless --full-key).
    Login(LoginArgs),
    /// Show the identity, its key, budget left, expiry, balance and where the key is stored.
    Status,
    /// Show the identity's credit balance.
    Balance,
    /// The identity's keys: list, add a limited or encryption key, disable one.
    #[command(subcommand)]
    Keys(keys::KeysCommand),
    /// DPNS usernames.
    #[command(subcommand)]
    Name(NameCommand),
    /// Write the stored key to a file: passphrase-encrypted, or with --reveal-secrets as a plain
    /// bridge-format file (0600) or a `dfk1:` value for CI (`--format dfk1`).
    Export(ExportArgs),
    /// Forget the stored key on this computer (the key stays valid on chain until disabled).
    Logout {
        /// Also disable the key on chain (needs the master key once).
        #[arg(long)]
        disable: bool,
        /// The identity file or recovery words for --disable (see `dg auth login`).
        #[arg(long, value_name = "FILE")]
        master: Option<PathBuf>,
    },
}

impl AuthCommand {
    /// The headline lead for errors.
    pub fn context(&self) -> &'static str {
        match self {
            AuthCommand::New(_) => "identity not created",
            AuthCommand::Login(_) => "login failed",
            AuthCommand::Status => "could not show auth status",
            AuthCommand::Balance => "could not read the balance",
            AuthCommand::Keys(k) => k.context(),
            AuthCommand::Name(_) => "name not registered",
            AuthCommand::Export(_) => "nothing exported",
            AuthCommand::Logout { .. } => "logout failed",
        }
    }
}

/// Limited-key options shared by `new`, `login` and `keys add`.
#[derive(Debug, Clone, clap::Args)]
pub struct KeyLimitArgs {
    /// The key's total budget in DASH (default 0.25).
    #[arg(long, value_name = "DASH")]
    pub budget: Option<f64>,
    /// How long the key lives: `180d`, `12w`, `6m`, `1y` (default 180d).
    #[arg(long, value_name = "DURATION")]
    pub expires: Option<String>,
}

/// Where to put the key when there is no OS keychain.
#[derive(Debug, Clone, clap::Args)]
pub struct StorageArgs {
    /// Without an OS keychain, store the key unencrypted (0600) instead of behind a
    /// passphrase. Every later use warns.
    #[arg(long)]
    pub insecure_plaintext: bool,
}

/// `dg auth login` arguments.
#[derive(Debug, clap::Args)]
pub struct LoginArgs {
    /// The identity file (bridge export, `dg auth export`, or mint-identity output). Also
    /// accepted via --identity.
    pub file: Option<PathBuf>,
    /// Type the 12 recovery words instead of giving a file (read without echo).
    #[arg(long, conflicts_with = "file")]
    pub mnemonic: bool,
    /// Keep the full identity (master key included) instead of registering a limited key.
    #[arg(long)]
    pub full_key: bool,
    /// Replace this limited key (disable it in the same update), e.g. the one a lost laptop held.
    #[arg(long, value_name = "KEY_ID")]
    pub replace: Option<u32>,
    #[command(flatten)]
    pub limits: KeyLimitArgs,
    #[command(flatten)]
    pub storage: StorageArgs,
}

/// `dg auth name` subcommands.
#[derive(Debug, Subcommand)]
pub enum NameCommand {
    /// Register a DPNS username (`alice` → alice.dash). Needs an unbound CRITICAL/HIGH key:
    /// the identity file or recovery words (used once), not the limited key.
    Register {
        /// The label (3–63 letters, digits, `-`).
        label: String,
        /// The identity file with the master/CRITICAL keys (else you are asked for the words).
        #[arg(long, value_name = "FILE")]
        master: Option<PathBuf>,
    },
}

/// `dg auth export` arguments.
#[derive(Debug, clap::Args)]
pub struct ExportArgs {
    /// Where to write (default: `dash-forge-<id>.key.json` in the current directory; `-` for
    /// stdout with --format dfk1).
    #[arg(long, short = 'o')]
    pub output: Option<PathBuf>,
    /// Write the secrets unencrypted: a bridge-format file (0600), or with `--format dfk1` the
    /// one-value `DASH_FORGE_KEY` for CI.
    #[arg(long)]
    pub reveal_secrets: bool,
    /// `bridge` (default) or `dfk1` (needs --reveal-secrets; the key alone, for CI secrets).
    #[arg(long, default_value = "bridge", value_parser = ["bridge", "dfk1"])]
    pub format: String,
    /// Export a new limited key registered just for this (e.g. a CI runner: `--budget 0.5
    /// --expires 365d`), instead of this computer's key. Needs the master key once.
    #[arg(long)]
    pub new_key: bool,
    /// With --new-key: the identity file or recovery words (see `dg auth login`).
    #[arg(long, value_name = "FILE", requires = "new_key")]
    pub master: Option<PathBuf>,
    #[command(flatten)]
    pub limits: KeyLimitArgs,
}

/// Dispatch an `auth` subcommand.
pub async fn run(ctx: &Ctx, cmd: &AuthCommand) -> Result<()> {
    match cmd {
        AuthCommand::New(args) => new::run(ctx, args).await,
        AuthCommand::Login(args) => login(ctx, args).await,
        AuthCommand::Status => status(ctx).await,
        AuthCommand::Balance => balance(ctx).await,
        AuthCommand::Keys(k) => keys::run(ctx, k).await,
        AuthCommand::Name(NameCommand::Register { label, master }) => {
            name_register(ctx, label, master.as_deref()).await
        }
        AuthCommand::Export(args) => export(ctx, args).await,
        AuthCommand::Logout { disable, master } => logout(ctx, *disable, master.as_deref()).await,
    }
}

// ---------------------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------------------

/// Parse `180d` / `12w` / `6m` / `1y` / a bare number of days into days.
pub fn parse_days(s: &str) -> Result<u64> {
    let s = s.trim().to_ascii_lowercase();
    let (num, unit) = match s.char_indices().find(|(_, c)| !c.is_ascii_digit()) {
        Some((i, _)) => (&s[..i], &s[i..]),
        None => (s.as_str(), "d"),
    };
    let n: u64 = num.parse().map_err(|_| {
        crate::errors::usage(format!("--expires {s:?} is not like 180d, 12w, 6m or 1y"))
    })?;
    let days = match unit {
        "d" | "day" | "days" => n,
        "w" | "wk" | "weeks" => n * 7,
        "m" | "mo" | "months" => n * 30,
        "y" | "yr" | "years" => n * 365,
        _ => {
            return Err(crate::errors::usage(format!(
                "--expires {s:?} is not like 180d, 12w, 6m or 1y"
            )))
        }
    };
    if days == 0 || days > 3650 {
        return Err(crate::errors::usage(
            "--expires must be between 1 day and 10 years",
        ));
    }
    Ok(days)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

/// DASH to credits (1 DASH = 1e11 credits), refusing nonsense.
pub fn dash_to_credits(dash: f64) -> Result<u64> {
    if !dash.is_finite() || dash <= 0.0 || dash > 1_000.0 {
        return Err(crate::errors::usage(format!(
            "a budget of {dash} DASH is not between 0 and 1000"
        )));
    }
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        clippy::cast_precision_loss
    )]
    Ok((dash * forge_core::cost::CREDITS_PER_DASH as f64).round() as u64)
}

/// The limited-key spec for the context's network: `args` over the CLI defaults, bound to the
/// network's forge contract group.
pub fn key_spec(
    ctx: &Ctx,
    args: &KeyLimitArgs,
    default_budget: f64,
    default_days: u64,
) -> Result<LimitedKeySpec> {
    let forge = ctx.target.v2.as_ref().ok_or_else(|| {
        anyhow::Error::from(forge_core::Error::V2NotDeployed {
            network: ctx.network_label(),
        })
    })?;
    let days = match &args.expires {
        Some(s) => parse_days(s)?,
        None => default_days,
    };
    Ok(LimitedKeySpec {
        budget_credits: dash_to_credits(args.budget.unwrap_or(default_budget))?,
        expires_at_ms: now_ms() + days * DAY_MS,
        group: forge.group.clone(),
    })
}

/// Refuse to bind a key to a group the chain does not show holding both forge contracts (the
/// group id comes from the bundled deployment file; this checks it against state).
pub async fn check_group(ctx: &Ctx, client: &PlatformClient, group: &str) -> Result<()> {
    let forge = ctx
        .target
        .v2
        .as_ref()
        .context("forge-v2 is not deployed on this network")?;
    for contract in [&forge.core, &forge.collab] {
        let groups = client
            .contract_groups_of(contract)
            .await
            .with_context(|| format!("checking contract {contract}'s group on chain"))?;
        if !groups.iter().any(|g| g == group) {
            return Err(UserError::new(
                codes::INVALID_CONFIG,
                "refusing to bind a key to the forge contract group",
            )
            .cause(format!(
                "contract {contract} is not in group {group} on {} (the deployment file and the chain disagree)",
                ctx.network_label()
            ))
            .fix("update dg (its deployment file may be stale), or report it")
            .into());
        }
    }
    Ok(())
}

/// Ask for the 12 recovery words without echo (or read `DASH_FORGE_MNEMONIC`).
pub fn read_mnemonic() -> Result<Secret> {
    let words = match std::env::var("DASH_FORGE_MNEMONIC")
        .ok()
        .filter(|v| !v.is_empty())
    {
        Some(w) => w,
        None => rpassword::prompt_password("Recovery words (12, hidden as you type): ").map_err(
            |e| {
                UserError::new(codes::USAGE, "the recovery words could not be read")
                    .cause(format!("no terminal to ask on ({e})"))
                    .fix("run it in a terminal, or pass the identity file instead")
            },
        )?,
    };
    let words = zeroize::Zeroizing::new(words);
    identity::normalize_mnemonic(&words).map_err(Into::into)
}

/// The master identity for a ceremony: `--master <file>` (or the file given to login), else the
/// stored full identity if it has a master key, else the recovery words typed now.
pub fn master_identity(
    ctx: &Ctx,
    file: Option<&std::path::Path>,
    identity_id: &str,
) -> Result<BridgeIdentity> {
    let bridge = if let Some(f) = file {
        BridgeIdentity::load_from_file(f).with_context(|| {
            format!("loading identity from {}", keystore::describe_key_source(f))
        })?
    } else if let Some(b) = ctx.load_bridge().ok().filter(|b| b.master_key().is_some()) {
        b
    } else {
        eprintln!(
            "This needs your master key once. It is used for this one signature and not stored."
        );
        let words = read_mnemonic()?;
        NewIdentityKeys::from_mnemonic(&words, ctx.network())?.to_bridge(identity_id)
    };
    if bridge.identity_id != identity_id && !identity_id.is_empty() {
        return Err(
            UserError::new(codes::KEY_CANNOT_SIGN, "that is a different identity")
                .cause(format!(
                    "the master key given is for {}, but the key in use is for {identity_id}",
                    bridge.identity_id
                ))
                .fix("pass the identity file (or words) of the identity you are signed in as")
                .into(),
        );
    }
    if bridge.master_key().is_none() {
        return Err(UserError::new(codes::KEY_CANNOT_SIGN, "no master key given")
            .cause("this needs the identity's MASTER key; the source given has none (a limited key cannot register or disable keys)")
            .fix("pass the identity file with --master <file>, or type the recovery words when asked")
            .into());
    }
    Ok(bridge)
}

/// The identity's master identity loaded when only words are available and the id is unknown
/// yet: derive, then find the identity by its master key on chain.
async fn identity_from_words(
    ctx: &Ctx,
    client: &PlatformClient,
    words: &Secret,
) -> Result<BridgeIdentity> {
    let keys = NewIdentityKeys::from_mnemonic(words, ctx.network())?;
    let master = keys.master_key();
    let found = client
        .identity_by_key(master.private_key_wif.expose())
        .await?
        .ok_or_else(|| {
            UserError::new(
                codes::IDENTITY_NOT_FOUND,
                "no identity for those words on this network",
            )
            .cause(format!(
                "Platform ({}) has no identity whose master key comes from these words",
                ctx.network_label()
            ))
            .fix("check the words and the network (`--network`); `dg auth new` creates an identity")
        })?;
    Ok(keys.to_bridge(&found.id()))
}

/// Register a fresh limited key on the identity (one IdentityUpdate signed by `master`),
/// optionally disabling `replace`, verify it on chain, and return it as a `dfk1:` source text.
pub async fn register_limited_key(
    ctx: &Ctx,
    client: &PlatformClient,
    master: &BridgeIdentity,
    spec: &LimitedKeySpec,
    replace: Option<u32>,
) -> Result<(u32, Secret)> {
    check_group(ctx, client, &spec.group).await?;
    let before = client.fetch_identity(&master.identity_id).await?;
    let disable: Vec<u32> = match replace {
        Some(id) if before.is_limited_key(id) => vec![id],
        Some(id) => {
            return Err(crate::errors::usage(format!(
                "key {id} is not a live Forge limited key; `dg auth keys list` shows them"
            )))
        }
        None => vec![],
    };
    let fresh = FreshKey::generate(ctx.network());
    let master_key = master.master_key().context("no master key")?;
    let ids = client
        .update_identity_keys(
            &master.identity_id,
            &master_key.private_key_wif,
            &[(&fresh, KeySpec::Limited(spec.clone()))],
            &disable,
        )
        .await
        .context("registering the limited key")?;
    let key_id = *ids.first().context("no key id")?;
    let wif = fresh.wif();
    verify_key(client, &master.identity_id, key_id, &wif, ctx, spec).await?;
    let dfk1 = Secret::new(format!(
        "{}{}:{}:{key_id}:{}",
        keystore::DFK1_PREFIX,
        ctx.network_label(),
        master.identity_id,
        wif.expose()
    ));
    Ok((key_id, dfk1))
}

/// Read a new key back from the chain (a node may be a block behind) and check it.
pub async fn verify_key(
    client: &PlatformClient,
    identity_id: &str,
    key_id: u32,
    wif: &Secret,
    ctx: &Ctx,
    spec: &LimitedKeySpec,
) -> Result<()> {
    let mut last = None;
    for attempt in 0..8u64 {
        match client.fetch_identity(identity_id).await {
            Ok(i) => match i.check_limited_key(key_id, wif.expose(), ctx.network(), spec) {
                Ok(()) => return Ok(()),
                Err(e) => last = Some(e),
            },
            Err(e) => last = Some(e),
        }
        tokio::time::sleep(std::time::Duration::from_millis(1500 * (attempt + 1))).await;
    }
    Err(last.map_or_else(|| anyhow::anyhow!("the new key was not found"), Into::into))
        .context("verifying the new key on chain")
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

fn expiry_text(ms: u64) -> String {
    let now = now_ms();
    if ms <= now {
        return "expired".into();
    }
    let days = (ms - now) / DAY_MS;
    format!("in {days} day(s)")
}

// ---------------------------------------------------------------------------------------
// login
// ---------------------------------------------------------------------------------------

/// The identity a login imports: the file given (or `--identity`), or the recovery words.
async fn login_source(
    ctx: &Ctx,
    client: &PlatformClient,
    args: &LoginArgs,
) -> Result<BridgeIdentity> {
    let file = args.file.clone().or_else(|| {
        // `--identity <file>` (the pre-spec spelling) still works as the source.
        ctx.identity_path
            .clone()
            .filter(|p| keystore::is_file_source(p) && !args.mnemonic)
    });
    let master = match (&file, args.mnemonic) {
        (Some(f), _) => {
            if keystore::is_inline_key(f) {
                return Err(crate::errors::usage(
                    "a dfk1: key is used directly (DASH_FORGE_KEY) and needs no login",
                ));
            }
            BridgeIdentity::load_from_file(f).with_context(|| {
                format!("loading identity from {}", keystore::describe_key_source(f))
            })?
        }
        (None, true) => identity_from_words(ctx, client, &read_mnemonic()?).await?,
        (None, false) => {
            return Err(crate::errors::usage(
                "`dg auth login` needs an identity file (`dg auth login <file>`) or --mnemonic",
            ))
        }
    };
    let network = ctx.network_label();
    if !master.network.is_empty()
        && master.network != network
        && !(master.network == "devnet" && network.starts_with("devnet-"))
    {
        return Err(
            UserError::new(codes::USAGE, "that identity is for another network")
                .cause(format!(
                    "the file says {}, but dg is on {network}",
                    master.network
                ))
                .fix(format!(
                    "add `--network {}` (and `--devnet-name` for a devnet)",
                    master.network
                ))
                .into(),
        );
    }
    if master.master_key().is_none() {
        return Err(
            UserError::new(codes::KEY_CANNOT_SIGN, "this file cannot sign in")
                .cause("it has no MASTER key (a limited or dfk1 key cannot register keys; use it directly via DASH_FORGE_KEY)")
                .fix("use the identity file with the master key, or --mnemonic")
                .into(),
        );
    }
    Ok(master)
}

/// Import an identity once: register a limited key signed by its master key and store only
/// that key (or, with `--full-key`, the whole identity).
async fn login(ctx: &Ctx, args: &LoginArgs) -> Result<()> {
    let client = ctx.connect().await?;
    let master = login_source(ctx, &client, args).await?;
    let network = ctx.network_label();
    let on_chain = client
        .fetch_identity(&master.identity_id)
        .await
        .context("fetching the signing identity")?;

    let (text, key_id, spec) = if args.full_key {
        (master.to_json_with_secrets(), None, None)
    } else {
        let spec = key_spec(ctx, &args.limits, CLI_KEY_BUDGET_DASH, CLI_KEY_DAYS)?;
        explain_new_key(ctx, &master.identity_id, &spec, "for this computer");
        ctx.confirm_or_cancel("Register the key?")?;
        let (id, dfk1) = register_limited_key(ctx, &client, &master, &spec, args.replace).await?;
        (dfk1, Some(id), Some(spec))
    };
    let stored = store::store(
        &network,
        &master.identity_id,
        &text,
        args.storage.insecure_plaintext,
    )?;
    store::set_default(ctx, &master.identity_id, &stored.source())?;
    let balance = on_chain.balance();
    ctx.emit(
        json!({
            "status": "logged_in",
            "identityId": master.identity_id,
            "network": network,
            "keyId": key_id,
            "fullKey": args.full_key,
            "budgetCredits": spec.as_ref().map(|s| s.budget_credits),
            "expiresAt": spec.as_ref().map(|s| s.expires_at_ms),
            "storage": stored.kind(),
            "storedAt": stored.describe(),
            "source": stored.source(),
            "balanceCredits": balance,
            "balanceDash": credits_to_dash(balance),
        }),
        || {
            println!("✓ signed in as {} on {network}", master.identity_id);
            match (key_id, &spec) {
                (Some(id), Some(s)) => println!(
                    "  key #{id}: limited, {} DASH budget, expires {}",
                    dash_amount(credits_to_dash(s.budget_credits)),
                    expiry_text(s.expires_at_ms)
                ),
                _ => println!(
                    "  full identity stored (master key included): keep this computer safe"
                ),
            }
            println!("  stored in {}", stored.describe());
            println!("  balance {} DASH", dash_amount(credits_to_dash(balance)));
            if key_id.is_some() {
                println!(
                    "  the identity file is no longer needed here; keep it (or the words) offline"
                );
            }
        },
    );
    Ok(())
}

/// Say what registering a limited key will allow and cost (human mode).
fn explain_new_key(ctx: &Ctx, identity_id: &str, spec: &LimitedKeySpec, purpose: &str) {
    if ctx.json {
        return;
    }
    eprintln!(
        "Registering a limited key {purpose} on {identity_id} ({}):",
        ctx.network_label()
    );
    eprintln!(
        "  it can spend at most {} DASH, only on Dash Forge, until it expires {}",
        dash_amount(credits_to_dash(spec.budget_credits)),
        expiry_text(spec.expires_at_ms)
    );
    eprintln!(
        "  one identity update, {}; the master key signs once and is not stored",
        crate::fmt::cost_line(KEY_UPDATE_ESTIMATE_CREDITS, crate::fmt::dash_usd_price())
    );
}

/// Estimate for one identity update adding a key (credits; an upper bound).
pub const KEY_UPDATE_ESTIMATE_CREDITS: u64 = 15_000_000;

// ---------------------------------------------------------------------------------------
// status / balance
// ---------------------------------------------------------------------------------------

/// Which key a source signs with, and what the chain says about it.
struct KeyReport {
    key_id: Option<u32>,
    limited: bool,
    total: Option<u64>,
    remaining: Option<u64>,
    expires_at: Option<u64>,
}

async fn key_report(
    client: &PlatformClient,
    identity: &LoadedIdentity,
    bridge: &BridgeIdentity,
    ctx: &Ctx,
) -> KeyReport {
    let key_id = bridge
        .doc_op_key()
        .ok()
        .and_then(|k| identity.key_id_for(k.private_key_wif.expose(), ctx.network()));
    let limits = key_id.and_then(|id| identity.key_limits(id));
    let remaining = match key_id {
        Some(id) if limits.is_some_and(|l| l.total_budget.is_some()) => client
            .key_remaining_budget(&identity.id(), id)
            .await
            .ok()
            .flatten(),
        _ => None,
    };
    KeyReport {
        key_id,
        limited: key_id.is_some_and(|id| identity.is_limited_key(id)),
        total: limits.and_then(|l| l.total_budget),
        remaining,
        expires_at: limits.and_then(|l| l.expires_at),
    }
}

async fn status(ctx: &Ctx) -> Result<()> {
    let config = Config::load().unwrap_or_default();
    let network = ctx.network_label();
    let Some(source) = ctx.identity_path.clone() else {
        ctx.emit(
            json!({ "network": network, "authenticated": false }),
            || {
                println!("Network:  {network}");
                println!(
                    "Identity: none — `dg auth new` creates one, `dg auth login <file>` signs in"
                );
            },
        );
        return Ok(());
    };
    let (where_, kind) = store::describe_source(&source.to_string_lossy());
    let bridge = ctx.load_bridge()?;
    let chain = match ctx.connect().await {
        Ok(client) => match client.fetch_identity(&bridge.identity_id).await {
            Ok(identity) => {
                let report = key_report(&client, &identity, &bridge, ctx).await;
                let names = client
                    .dpns_names_of(&bridge.identity_id)
                    .await
                    .unwrap_or_default();
                Some((identity.balance(), report, names))
            }
            Err(_) => None,
        },
        Err(_) => None,
    };
    let (balance, report, names) = match chain {
        Some((b, r, n)) => (Some(b), Some(r), n),
        None => (None, None, vec![]),
    };
    ctx.emit(
        json!({
            "network": network,
            "authenticated": true,
            "identityId": bridge.identity_id,
            "names": names,
            "keyId": report.as_ref().and_then(|r| r.key_id),
            "limited": report.as_ref().map(|r| r.limited),
            "budgetCredits": report.as_ref().and_then(|r| r.total),
            "budgetRemainingCredits": report.as_ref().and_then(|r| r.remaining),
            "expiresAt": report.as_ref().and_then(|r| r.expires_at),
            "balanceCredits": balance,
            "balanceDash": balance.map(credits_to_dash),
            "storage": kind,
            "storedAt": where_,
            "defaultIdentityId": config.default_identity_id,
            "masterKeyStored": bridge.master_key().is_some(),
        }),
        || {
            println!("Network:  {network}");
            match names.first() {
                Some(n) => println!("Identity: {n} ({})", bridge.identity_id),
                None => println!("Identity: {}", bridge.identity_id),
            }
            match &report {
                Some(r) => {
                    let id = r.key_id.map_or("?".to_string(), |i| format!("#{i}"));
                    if r.limited {
                        println!(
                            "Key:      {id} limited — {} of {} DASH left, expires {}",
                            r.remaining.map_or("?".into(), |c| dash_amount(credits_to_dash(c))),
                            r.total.map_or("?".into(), |c| dash_amount(credits_to_dash(c))),
                            r.expires_at.map_or("never".into(), expiry_text)
                        );
                    } else {
                        println!("Key:      {id} unlimited (not a Forge limited key)");
                    }
                }
                None => println!("Key:      (Platform unreachable; not checked)"),
            }
            if let Some(b) = balance {
                println!("Balance:  {} DASH", dash_amount(credits_to_dash(b)));
            }
            println!("Stored:   {where_}");
            if bridge.master_key().is_some() {
                println!("          (holds the master key: `dg auth login <file>` would store only a limited key)");
            }
        },
    );
    Ok(())
}

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
            "Balance:  {} DASH ({credits} credits)",
            dash_amount(credits_to_dash(credits))
        );
        if credits == 0 {
            println!("  note: reads still work; top up from any Dash wallet before writing");
        }
    });
    Ok(())
}

// ---------------------------------------------------------------------------------------
// name register
// ---------------------------------------------------------------------------------------

/// DPNS registration cost for a non-contested name (preorder + domain), credits; an estimate.
const DPNS_ESTIMATE_CREDITS: u64 = 2_000_000_000;

async fn name_register(ctx: &Ctx, label: &str, master: Option<&std::path::Path>) -> Result<()> {
    let label = label.trim().trim_end_matches(".dash");
    let (valid, contested) = dpns_label_kind(label);
    if !valid {
        return Err(crate::errors::usage(format!(
            "{label:?} is not a valid username: 3–63 letters, digits and `-`, starting and ending with a letter or digit"
        )));
    }
    if contested {
        return Err(UserError::new(codes::UNSUPPORTED, format!("{label} is a contested name"))
            .cause("names of 3–19 characters made only of a–z, 0, 1 and `-` go to a masternode vote (and cost ~0.2 DASH to enter); dg does not run contests")
            .fix(format!("pick a longer name or add a digit other than 0/1 (e.g. `{label}2`), or enter the contest from a wallet"))
            .into());
    }
    let id = ctx.load_bridge().map(|b| b.identity_id).unwrap_or_default();
    let client = ctx.connect().await?;
    if !client.dpns_name_available(label).await? {
        return Err(
            UserError::new(codes::ALREADY_EXISTS, format!("{label}.dash is taken"))
                .cause(format!(
                    "DPNS already has a name that normalizes to {:?}",
                    dpns_normalize(label)
                ))
                .fix("pick another name")
                .into(),
        );
    }
    let full = master_identity(ctx, master, &id)?;
    let price = crate::fmt::dash_usd_price();
    if !ctx.json {
        eprintln!(
            "Registering {label}.dash for {}: preorder + domain, {}",
            full.identity_id,
            crate::fmt::cost_line(DPNS_ESTIMATE_CREDITS, price)
        );
    }
    ctx.confirm_or_cancel(&format!("Register {label}.dash?"))?;
    let name = client.register_dpns_name(&full, label).await?;
    ctx.emit(
        json!({ "status": "registered", "name": name, "identityId": full.identity_id }),
        || println!("✓ {name} → {}", full.identity_id),
    );
    Ok(())
}

// ---------------------------------------------------------------------------------------
// export / logout
// ---------------------------------------------------------------------------------------

/// What `dg auth export` writes: the source text, the key id and the identity id.
async fn export_payload(ctx: &Ctx, args: &ExportArgs) -> Result<(Secret, Option<u32>, String)> {
    let current = ctx.load_bridge()?;
    let (text, key_id, identity_id) = if args.new_key {
        let client = ctx.connect().await?;
        let master = master_identity(ctx, args.master.as_deref(), &current.identity_id)?;
        let spec = key_spec(ctx, &args.limits, 0.5, 365)?;
        explain_new_key(ctx, &master.identity_id, &spec, "to export");
        ctx.confirm_or_cancel("Register the key?")?;
        let (id, dfk1) = register_limited_key(ctx, &client, &master, &spec, None).await?;
        (dfk1, Some(id), master.identity_id)
    } else if args.format == "dfk1" {
        let id = current.doc_op_key()?.id;
        let dfk1 = current.to_dfk1(id).context("no key")?;
        (dfk1, Some(id), current.identity_id.clone())
    } else {
        (
            current.to_json_with_secrets(),
            None,
            current.identity_id.clone(),
        )
    };
    // A dfk1 source text becomes a bridge file when --format bridge was asked for.
    let text = if args.format == "bridge" && text.expose().starts_with(keystore::DFK1_PREFIX) {
        BridgeIdentity::from_dfk1(text.expose())?.to_json_with_secrets()
    } else {
        text
    };
    Ok((text, key_id, identity_id))
}

async fn export(ctx: &Ctx, args: &ExportArgs) -> Result<()> {
    let to_stdout = args.output.as_deref().is_some_and(|p| p.as_os_str() == "-");
    if args.format == "dfk1" && !args.reveal_secrets {
        return Err(crate::errors::usage(
            "--format dfk1 writes the key in the clear; add --reveal-secrets",
        ));
    }
    if to_stdout && args.format != "dfk1" {
        return Err(crate::errors::usage(
            "`-o -` (stdout) is only for --format dfk1 --reveal-secrets",
        ));
    }
    let (text, key_id, identity_id) = export_payload(ctx, args).await?;
    if to_stdout {
        // The value itself is the output; nothing else goes to stdout.
        println!("{}", text.expose());
        return Ok(());
    }
    let path = args.output.clone().unwrap_or_else(|| {
        PathBuf::from(match (args.reveal_secrets, args.format.as_str()) {
            (true, "dfk1") => format!("dash-forge-{identity_id}.dfk1"),
            (true, _) => format!("dash-forge-{identity_id}.identity.json"),
            (false, _) => format!("dash-forge-{identity_id}.key.json"),
        })
    });
    if path.exists() {
        return Err(crate::errors::usage(format!(
            "{} exists; pass another -o",
            path.display()
        )));
    }
    let bytes = if args.reveal_secrets {
        zeroize::Zeroizing::new(text.expose().as_bytes().to_vec())
    } else {
        let pass = forge_core::sealed::passphrase(&format!("the export {}", path.display()), true)?;
        zeroize::Zeroizing::new(
            forge_core::sealed::seal(text.expose().as_bytes(), pass.expose())?.into_bytes(),
        )
    };
    keystore::write_private_file(&path, &bytes)?;
    let encrypted = !args.reveal_secrets;
    ctx.emit(
        json!({
            "status": "exported",
            "path": path.display().to_string(),
            "identityId": identity_id,
            "keyId": key_id,
            "encrypted": encrypted,
            "format": args.format,
            "network": ctx.network_label(),
        }),
        || {
            println!(
                "✓ wrote {} (0600, {})",
                path.display(),
                if encrypted {
                    "passphrase-encrypted"
                } else {
                    "UNENCRYPTED"
                }
            );
            if args.format == "dfk1" {
                println!("  use it as a CI secret: DASH_FORGE_KEY=<the file's contents>");
            } else if encrypted {
                println!(
                    "  sign in elsewhere with `dg auth login {}` (asks for the passphrase)",
                    path.display()
                );
            }
        },
    );
    Ok(())
}

async fn logout(ctx: &Ctx, disable: bool, master: Option<&std::path::Path>) -> Result<()> {
    let bridge = ctx.load_bridge()?;
    let network = ctx.network_label();
    let mut disabled = None;
    if disable {
        let client = ctx.connect().await?;
        let identity = client.fetch_identity(&bridge.identity_id).await?;
        let key_id = bridge
            .doc_op_key()
            .ok()
            .and_then(|k| identity.key_id_for(k.private_key_wif.expose(), ctx.network()))
            .filter(|id| identity.is_limited_key(*id))
            .context("the stored key is not a live Forge limited key; nothing to disable")?;
        let full = master_identity(ctx, master, &bridge.identity_id)?;
        ctx.confirm_or_cancel(&format!("Disable key #{key_id} on chain?"))?;
        client
            .update_identity_keys(
                &bridge.identity_id,
                &full.master_key().context("no master key")?.private_key_wif,
                &[],
                &[key_id],
            )
            .await?;
        disabled = Some(key_id);
    }
    let removed = store::remove(&network, &bridge.identity_id)?;
    let mut config = Config::load().unwrap_or_default();
    if config.default_identity_id.as_deref() == Some(bridge.identity_id.as_str()) {
        config.default_identity = None;
        config.default_identity_id = None;
        config.save()?;
    }
    ctx.emit(
        json!({ "status": "logged_out", "identityId": bridge.identity_id, "removed": removed, "disabledKeyId": disabled }),
        || {
            println!("✓ signed out of {}", bridge.identity_id);
            for r in &removed {
                println!("  removed {r}");
            }
            match disabled {
                Some(id) => println!("  key #{id} disabled on chain"),
                None => println!("  the key stays valid on chain until it expires or `dg auth keys disable` disables it"),
            }
        },
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
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

    #[test]
    fn durations() {
        assert_eq!(parse_days("180d").unwrap(), 180);
        assert_eq!(parse_days("12w").unwrap(), 84);
        assert_eq!(parse_days("6m").unwrap(), 180);
        assert_eq!(parse_days("1y").unwrap(), 365);
        assert_eq!(parse_days("30").unwrap(), 30);
        assert!(parse_days("0d").is_err());
        assert!(parse_days("soon").is_err());
        assert!(parse_days("99y").is_err());
    }

    #[test]
    fn budgets() {
        assert_eq!(dash_to_credits(0.25).unwrap(), 25_000_000_000);
        assert!(dash_to_credits(0.0).is_err());
        assert!(dash_to_credits(f64::NAN).is_err());
        assert!(dash_to_credits(-1.0).is_err());
    }
}
