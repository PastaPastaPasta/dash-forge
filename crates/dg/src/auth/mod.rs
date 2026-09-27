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
    /// bridge-format file (0600) or a `dfk1:` value for CI (`--format dfk1`). Sign in elsewhere
    /// with `dg auth login <file>`, or use the file as DASH_FORGE_KEY.
    Export(ExportArgs),
    /// Forget the stored key on this computer (the key stays valid on chain until disabled).
    Logout {
        /// Also disable the key on chain (needs the master key once).
        #[arg(long)]
        disable: bool,
        /// The identity file or recovery words for --disable (see `dg auth login`).
        #[arg(long, value_name = "FILE", requires = "disable")]
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
    #[arg(long, value_name = "KEY_ID", conflicts_with = "full_key")]
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
    let forge = ctx.target.require_v2()?;
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

/// Refuse to bind a key to a group unless the chain shows it holds the two forge contracts and
/// nothing but Forge's own contracts (the current pair, and earlier versions the bundled
/// deployment lists as superseded in the same group): a key bound to the group can sign for
/// whatever it holds. This is a check at binding time: the group's owner can add members later,
/// so the owner is a trust root (docs/guides/identity-and-keys.md#trust-roots).
pub async fn check_group(ctx: &Ctx, client: &PlatformClient, group: &str) -> Result<()> {
    let forge = ctx.target.require_v2()?;
    let members = client
        .contract_group_members(group)
        .await
        .context("checking the forge contract group on chain")?;
    let mut have = members.contracts;
    have.sort();
    let ours = |c: &String| {
        *c == forge.core || *c == forge.collab || forge.superseded_in_group.contains(c)
    };
    let current_present = have.contains(&forge.core) && have.contains(&forge.collab);
    if current_present
        && have.iter().all(ours)
        && members.document_types == 0
        && members.tokens == 0
    {
        return Ok(());
    }
    Err(UserError::new(
        codes::INVALID_CONFIG,
        "refusing to bind a key to the forge contract group",
    )
    .cause(format!(
        "group {group} on {} holds contracts {have:?}, {} document type(s) and {} token(s); \
         a Forge limited key must be usable only on forge-core {} and forge-collab {}",
        ctx.network_label(),
        members.document_types,
        members.tokens,
        forge.core,
        forge.collab
    ))
    .fix("update dg (its deployment file may be stale), or report it")
    .into())
}

/// Ask for the 12 recovery words without echo (never from the environment: child processes
/// would inherit them).
pub fn read_mnemonic() -> Result<Secret> {
    if !forge_core::sealed::prompts_allowed() {
        return Err(
            UserError::new(codes::USAGE, "the recovery words could not be read")
                .cause("this command does not prompt (--json)")
                .fix("pass the identity file with --master <file> (or as the login file) instead")
                .into(),
        );
    }
    let words =
        rpassword::prompt_password("Recovery words (12, hidden as you type): ").map_err(|e| {
            UserError::new(codes::USAGE, "the recovery words could not be read")
                .cause(format!("no terminal to ask on ({e})"))
                .fix("run it in a terminal, or pass the identity file instead")
        })?;
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
/// optionally disabling `replace`, and verify it on chain. `persist` receives the key (as a
/// `dfk1:` source text) **before** anything is broadcast, so a failure to store it stops the
/// command before a key nobody holds is registered; it is called again if the key lands under
/// another id than predicted (a concurrent update). Returns the key's id.
pub async fn register_limited_key(
    ctx: &Ctx,
    client: &PlatformClient,
    master: &BridgeIdentity,
    spec: &LimitedKeySpec,
    replace: Option<u32>,
    persist: &mut dyn FnMut(&Secret) -> Result<()>,
) -> Result<u32> {
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
    let wif = fresh.wif();
    let network = ctx.network_label();
    let dfk1_for = |id| keystore::dfk1(&network, &master.identity_id, id, wif.expose());
    let predicted = before.next_key_id();
    persist(&dfk1_for(predicted)).context("storing the new key before registering it")?;
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
    if key_id != predicted {
        persist(&dfk1_for(key_id))?;
    }
    verify_key(client, &master.identity_id, key_id, &wif, ctx, spec).await?;
    Ok(key_id)
}

/// [`register_limited_key`], making the new key this computer's. The new key is written to a
/// staging slot before it is registered and moved over the key in use only once the chain has
/// it, so a failed or refused update never leaves this computer without a working key. When the
/// outcome is unclear (the update errored, but it may have landed), the chain is asked: a key
/// that landed is promoted; otherwise both copies stay and the error says where each is.
/// Returns the new key's id and where it is stored.
pub async fn register_and_store(
    ctx: &Ctx,
    client: &PlatformClient,
    master: &BridgeIdentity,
    spec: &LimitedKeySpec,
    replace: Option<u32>,
    insecure_plaintext: bool,
) -> Result<(u32, store::Stored)> {
    let network = ctx.network_label();
    let id_ = master.identity_id.clone();
    let storer = std::cell::RefCell::new(store::Storer::new(insecure_plaintext));
    let in_use = ctx.identity_path.as_ref().map_or_else(
        || "none".to_string(),
        |p| store::describe_source(&p.to_string_lossy()).0,
    );
    let slots = KeySlots {
        stage: |t: &Secret| {
            storer
                .borrow_mut()
                .store(&network, &id_, t, store::Slot::Pending)
        },
        promote: |t: &Secret| store::promote(&mut storer.borrow_mut(), &network, &id_, t),
    };
    let mut staged = None;
    let result = register_limited_key(ctx, client, master, spec, replace, &mut |t| {
        staged = Some((t.clone(), (slots.stage)(t)?));
        Ok(())
    })
    .await;
    let landed = if result.is_err() {
        // Did it land anyway? The staged key's public half is on chain if so.
        let wif = staged.as_ref().and_then(|(t, _)| {
            BridgeIdentity::from_dfk1(t.expose())
                .ok()
                .and_then(|b| b.doc_op_key().ok().map(|k| k.private_key_wif.clone()))
        });
        match (&wif, client.fetch_identity(&id_).await) {
            (Some(w), Ok(identity)) => identity
                .key_id_for(w.expose(), ctx.network())
                .map(|id| (id, keystore::dfk1(&network, &id_, id, w.expose()))),
            _ => None,
        }
    } else {
        None
    };
    settle(&slots, result, staged, landed, &in_use)
}

/// Where a new key is kept while it is being registered.
struct KeySlots<S, P> {
    /// Write the key to the staging slot.
    stage: S,
    /// Move a confirmed key over the one in use (and drop the staged copy).
    promote: P,
}

/// A registered key that could not be moved over the key in use: say where it is kept.
fn promote_failed(e: anyhow::Error, id: u32, pending_at: &store::Stored) -> anyhow::Error {
    e.context(format!(
        "key #{id} is registered on chain but could not be made this computer's key; it is kept \
         in {} — run the same command again to finish, or sign in with it: `dg auth login {}`",
        pending_at.describe(),
        pending_at.source()
    ))
}

/// Decide what happens to a staged key once the registration returned: promote it when it
/// registered (or when the chain shows it landed despite an error); otherwise leave the key in
/// use untouched and say where both are.
fn settle<S, P>(
    slots: &KeySlots<S, P>,
    result: Result<u32>,
    staged: Option<(Secret, store::Stored)>,
    landed: Option<(u32, Secret)>,
    in_use: &str,
) -> Result<(u32, store::Stored)>
where
    P: Fn(&Secret) -> Result<store::Stored>,
{
    match (result, staged) {
        (Ok(id), Some((text, pending_at))) => {
            let main = (slots.promote)(&text).map_err(|e| promote_failed(e, id, &pending_at))?;
            Ok((id, main))
        }
        (Ok(_), None) => Err(anyhow::anyhow!("the new key was registered but not staged")),
        // Staging itself failed: nothing was broadcast.
        (Err(e), None) => Err(e),
        (Err(e), Some((_, pending_at))) => {
            if let Some((id, text)) = landed {
                let main =
                    (slots.promote)(&text).map_err(|e| promote_failed(e, id, &pending_at))?;
                eprintln!(
                    "note: the update reported an error ({e:#}), but key #{id} is on chain; using it"
                );
                return Ok((id, main));
            }
            Err(e.context(format!(
                "the new key is not on chain (as far as Platform shows now); the key in use is \
                 unchanged ({in_use}); the new one is kept in {} — run the command again, or \
                 `dg auth logout` removes both",
                pending_at.describe()
            )))
        }
    }
}

/// Disable `key_id` on the identity, signed once by `master`'s MASTER key.
pub async fn disable_key(
    client: &PlatformClient,
    master: &BridgeIdentity,
    key_id: u32,
) -> Result<()> {
    client
        .update_identity_keys(
            &master.identity_id,
            &master
                .master_key()
                .context("no master key")?
                .private_key_wif,
            &[],
            &[key_id],
        )
        .await?;
    Ok(())
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
    let days = (ms - now + DAY_MS / 2) / DAY_MS;
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
    // `--identity <file>` (the pre-spec spelling) still works as the source; DASH_FORGE_KEY
    // and the stored default do not (a bare `dg auth login` must not re-import them).
    let file = args.file.clone().or_else(|| {
        ctx.cli_identity
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
                    "add {}",
                    match master.network.strip_prefix("devnet-") {
                        Some(name) => format!("`--network devnet --devnet-name {name}`"),
                        None => format!("`--network {}`", master.network),
                    }
                ))
                .into(),
        );
    }
    if master.master_key().is_none() && master.doc_op_key().is_err() {
        return Err(
            UserError::new(codes::KEY_CANNOT_SIGN, "this file cannot sign in")
                .cause("it holds neither a MASTER key nor a key that can sign writes")
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

    let insecure = args.storage.insecure_plaintext;
    let full_key = args.full_key || ctx.target.v2.is_none();
    if full_key && !args.full_key && !ctx.json {
        eprintln!(
            "note: {} has no forge-v2 contract group, so there is no limited key to register; \
             storing the identity as given (master key included) in a passphrase-sealed file \
             (DASH_FORGE_PASSPHRASE when there is no terminal)",
            ctx.network_label()
        );
    }
    if full_key && insecure {
        return Err(crate::errors::usage(
            "--full-key keeps the master key: it goes to a passphrase-sealed file, never unencrypted (drop --insecure-plaintext)",
        ));
    }
    let (stored, key_id, spec) = if full_key || master.master_key().is_none() {
        // --full-key, no forge-v2 here, or a file holding one limited key (an export of this
        // or another computer's key): store it as it is. A master key never goes into the
        // keychain (any program running as you can read it there): a sealed file only.
        let lone_key = master.master_key().is_none();
        let text = if lone_key {
            let k = master.doc_op_key()?;
            keystore::dfk1(
                &master.network,
                &master.identity_id,
                k.id,
                k.private_key_wif.expose(),
            )
        } else {
            master.to_json_with_secrets()
        };
        let mut keeper = if lone_key {
            store::Storer::new(insecure)
        } else {
            store::Storer::sealed_only(insecure)
        };
        let stored = keeper.store(&network, &master.identity_id, &text, store::Slot::Main)?;
        (stored, None, None)
    } else {
        let spec = key_spec(ctx, &args.limits, CLI_KEY_BUDGET_DASH, CLI_KEY_DAYS)?;
        explain_new_key(ctx, &master.identity_id, &spec, "for this computer");
        ctx.confirm_or_cancel("Register the key?")?;
        let (id, stored) =
            register_and_store(ctx, &client, &master, &spec, args.replace, insecure).await?;
        (stored, Some(id), Some(spec))
    };
    store::set_default(ctx, &master.identity_id, &stored.source())?;
    let balance = on_chain.balance();
    ctx.emit(
        json!({
            "status": "logged_in",
            "identityId": master.identity_id,
            "network": network,
            "keyId": key_id,
            "fullKey": full_key,
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
                _ if master.master_key().is_some() => println!(
                    "  full identity stored (master key included): keep this computer safe"
                ),
                _ => println!("  the key in the file is stored as it is (no new key registered)"),
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
    let key_id = identity.signing_key_id(bridge, ctx.network());
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
                if kind == "keychain" {
                    println!("          warning: an older dg put this master key in the keychain, where any program running as you can read it; `dg auth login --full-key <file>` moves it to a sealed file");
                }
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
    let full = match ctx.load_bridge() {
        Ok(b) => master_identity(ctx, master, &b.identity_id)?,
        // Nothing stored: the file given, or the words (found on chain by their master key).
        Err(_) => match master {
            Some(_) => master_identity(ctx, master, "")?,
            None => identity_from_words(ctx, &client, &read_mnemonic()?).await?,
        },
    };
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

/// Seal `text` under `pass`, or keep it as is (`None`).
fn sealed_or_clear(text: &Secret, pass: Option<&Secret>) -> Result<zeroize::Zeroizing<Vec<u8>>> {
    Ok(zeroize::Zeroizing::new(match pass {
        Some(p) => forge_core::sealed::seal(text.expose().as_bytes(), p.expose())?.into_bytes(),
        None => text.expose().as_bytes().to_vec(),
    }))
}

/// Where an export goes: `-o`, else a file under the config directory (not the current
/// directory: that is usually a git work tree, one `git add .` away from publishing the key).
/// The file must not exist yet.
fn export_path(args: &ExportArgs, identity_id: &str, to_stdout: bool) -> Result<PathBuf> {
    let path = match &args.output {
        Some(p) => p.clone(),
        None => crate::config::config_dir()?.join("exports").join(
            match (args.reveal_secrets, args.format.as_str()) {
                (true, "dfk1") => format!("dash-forge-{identity_id}.dfk1"),
                (true, _) => format!("dash-forge-{identity_id}.identity.json"),
                (false, _) => format!("dash-forge-{identity_id}.key.json"),
            },
        ),
    };
    if to_stdout {
        return Ok(path);
    }
    if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
        std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    }
    if path.exists() || path.symlink_metadata().is_ok() {
        return Err(crate::errors::usage(format!(
            "{} exists; pass another -o",
            path.display()
        )));
    }
    Ok(path)
}

/// The stored key as an export: a `dfk1:` value (only a limited key: it is for CI, and CI gets
/// a bounded key) or the identity as a bridge file.
async fn current_key_text(
    ctx: &Ctx,
    current: &BridgeIdentity,
    format: &str,
) -> Result<(Secret, Option<u32>)> {
    if format != "dfk1" {
        return Ok((current.to_json_with_secrets(), None));
    }
    let key = current.doc_op_key()?;
    let client = ctx.connect().await?;
    let identity = client.fetch_identity(&current.identity_id).await?;
    let id = identity
        .signing_key_id(current, ctx.network())
        .filter(|id| identity.is_limited_key(*id))
        .ok_or_else(|| {
            crate::errors::usage(
                "the key in use is not a Forge limited key; export a new one for CI with \
                 `dg auth export --new-key --format dfk1 --reveal-secrets -o <file>`",
            )
        })?;
    Ok((current.to_dfk1(key.id).context("no key")?, Some(id)))
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
    if to_stdout && args.new_key {
        return Err(crate::errors::usage(
            "--new-key writes the key to a file (so it is kept before it is registered); pass -o <file>",
        ));
    }
    let current = ctx.load_bridge()?;
    let path = export_path(args, &current.identity_id, to_stdout)?;
    // Ask for the passphrase before anything is registered.
    let pass = if args.reveal_secrets || to_stdout {
        None
    } else {
        Some(forge_core::sealed::passphrase(
            &format!("the export {}", path.display()),
            true,
        )?)
    };
    let (key_id, identity_id) = if args.new_key {
        let client = ctx.connect().await?;
        let master = master_identity(ctx, args.master.as_deref(), &current.identity_id)?;
        let spec = key_spec(ctx, &args.limits, 0.5, 365)?;
        explain_new_key(ctx, &master.identity_id, &spec, "to export");
        ctx.confirm_or_cancel("Register the key?")?;
        let mut written = false;
        let id = register_limited_key(ctx, &client, &master, &spec, None, &mut |t| {
            // A bridge-format export of a lone limited key.
            let text = if args.format == "bridge" {
                BridgeIdentity::from_dfk1(t.expose())?.to_json_with_secrets()
            } else {
                t.clone()
            };
            let bytes = sealed_or_clear(&text, pass.as_ref())?;
            // The first write creates the file (refusing anything already there); a second one
            // (the key landed under another id) replaces what the first wrote.
            if written {
                keystore::write_private_file(&path, &bytes)?;
            } else {
                keystore::create_private_file(&path, &bytes)?;
                written = true;
            }
            Ok(())
        })
        .await?;
        (Some(id), master.identity_id)
    } else {
        let (text, key_id) = current_key_text(ctx, &current, &args.format).await?;
        if to_stdout {
            // The value itself is the output; nothing else goes to stdout.
            println!("{}", text.expose());
            return Ok(());
        }
        keystore::create_private_file(&path, &sealed_or_clear(&text, pass.as_ref())?)?;
        (key_id, current.identity_id.clone())
    };
    let encrypted = pass.is_some();
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
                    "  use it elsewhere: `dg auth login {}` (asks for the passphrase) stores it as that computer's key",
                    path.display()
                );
            }
        },
    );
    Ok(())
}

async fn logout(ctx: &Ctx, disable: bool, master: Option<&std::path::Path>) -> Result<()> {
    let network = ctx.network_label();
    let mut config = Config::load().unwrap_or_default();
    // Without --disable the key is not needed: a missing or locked keychain entry, or a sealed
    // file whose passphrase is lost, must not stop a sign-out.
    let identity_id = match (disable, ctx.load_bridge()) {
        (_, Ok(b)) => b.identity_id,
        (false, Err(_)) => config.default_identity_id.clone().ok_or_else(|| {
            crate::errors::usage("no identity is signed in (nothing recorded to sign out of)")
        })?,
        (true, Err(e)) => return Err(e),
    };
    let mut disabled = None;
    if disable {
        let bridge = ctx.load_bridge()?;
        let client = ctx.connect().await?;
        let identity = client.fetch_identity(&identity_id).await?;
        let key_id = identity
            .signing_key_id(&bridge, ctx.network())
            .filter(|id| identity.is_limited_key(*id))
            .context("the stored key is not a live Forge limited key; nothing to disable")?;
        let full = master_identity(ctx, master, &identity_id)?;
        ctx.confirm_or_cancel(&format!("Disable key #{key_id} on chain?"))?;
        disable_key(&client, &full, key_id).await?;
        disabled = Some(key_id);
    }
    let source = ctx
        .identity_path
        .as_ref()
        .map(|p| p.to_string_lossy().into_owned());
    let removed = store::remove(&network, &identity_id, source.as_deref());
    // The default goes either way: a half-removed key must not stay the one every command uses.
    if config.default_identity_id.as_deref() == Some(identity_id.as_str()) {
        config.default_identity = None;
        config.default_identity_id = None;
        config.save()?;
    }
    let removed = removed?;
    ctx.emit(
        json!({ "status": "logged_out", "identityId": identity_id, "removed": removed, "disabledKeyId": disabled }),
        || {
            println!("✓ signed out of {identity_id}");
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

    /// A simulated broadcast failure never touches the key in use; a confirmed (or landed)
    /// key is promoted.
    #[test]
    fn a_failed_registration_keeps_the_key_in_use() {
        use std::cell::RefCell;
        let main: RefCell<Option<String>> = RefCell::new(Some("dfk1:old".into()));
        let pending: RefCell<Option<String>> = RefCell::new(None);
        let at = |p: &str| store::Stored::Sealed(std::path::PathBuf::from(p));
        let slots = KeySlots {
            stage: |t: &Secret| {
                *pending.borrow_mut() = Some(t.expose().to_string());
                anyhow::Ok(at("pending"))
            },
            promote: |t: &Secret| {
                *main.borrow_mut() = Some(t.expose().to_string());
                *pending.borrow_mut() = None;
                Ok(at("main"))
            },
        };
        let new = Secret::new("dfk1:new");
        (slots.stage)(&new).unwrap();

        // The broadcast fails and the chain does not have the key.
        let err = settle(
            &slots,
            Err(anyhow::anyhow!("broadcast failed")),
            Some((new.clone(), at("pending"))),
            None,
            "keychain old",
        )
        .unwrap_err();
        let msg = format!("{err:#}");
        assert!(
            msg.contains("broadcast failed") && msg.contains("unchanged (keychain old)"),
            "{msg}"
        );
        assert_eq!(
            main.borrow().as_deref(),
            Some("dfk1:old"),
            "key in use untouched"
        );
        assert_eq!(
            pending.borrow().as_deref(),
            Some("dfk1:new"),
            "new key kept"
        );

        // The broadcast errors but the key landed: promoted.
        let (id, where_) = settle(
            &slots,
            Err(anyhow::anyhow!("timeout")),
            Some((new.clone(), at("pending"))),
            Some((9, Secret::new("dfk1:new9"))),
            "x",
        )
        .unwrap();
        assert_eq!((id, where_.kind()), (9, "sealed-file"));
        assert_eq!(main.borrow().as_deref(), Some("dfk1:new9"));
        assert!(pending.borrow().is_none());

        // Staging failed: the error is the staging error, nothing promoted.
        *main.borrow_mut() = Some("dfk1:old".into());
        let err = settle(
            &slots,
            Err(anyhow::anyhow!("no passphrase")),
            None,
            None,
            "x",
        )
        .unwrap_err();
        assert!(format!("{err:#}").contains("no passphrase"));
        assert_eq!(main.borrow().as_deref(), Some("dfk1:old"));

        // Registered, but promoting fails: the error says where the key is kept.
        let failing = KeySlots {
            stage: |_: &Secret| anyhow::Ok(at("pending")),
            promote: |_: &Secret| -> Result<store::Stored> {
                Err(anyhow::anyhow!("keychain locked"))
            },
        };
        let err = settle(
            &failing,
            Ok(8),
            Some((Secret::new("k"), at("pending"))),
            None,
            "x",
        )
        .unwrap_err();
        let msg = format!("{err:#}");
        assert!(
            msg.contains("key #8 is registered") && msg.contains("pending"),
            "{msg}"
        );

        // Success: promoted.
        let (id, _) = settle(&slots, Ok(7), Some((new, at("pending"))), None, "x").unwrap();
        assert_eq!(id, 7);
        assert_eq!(main.borrow().as_deref(), Some("dfk1:new"));
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
