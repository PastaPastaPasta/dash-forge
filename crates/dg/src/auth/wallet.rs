//! `dg auth login --wallet`: sign in with a DashPay wallet over App Connect v2
//! (`docs/design/wallet-primary.md` item 8).
//!
//! dg prints Forge's request as a QR code and a `dash-key:` link, the wallet adds one limited
//! key to the user's identity (AUTHENTICATION / HIGH, bound to the dash-forge contract group,
//! with a budget and an expiry) and publishes it encrypted to the request's one-time key, and
//! dg reads the answer from Platform ([`forge_core::app_connect`]). No Forge server is involved,
//! so it works over SSH. The key is stored like the limited key `dg auth login <file>`
//! registers; the master key never leaves the wallet.
//!
//! dg keeps two non-secret things in `app-connect.toml` beside config.toml: the connection id
//! per network (a wallet that sees it again disables the key of its previous grant, so signing
//! in again never leaves the old key live), and which stored keys came from a wallet, for
//! `dg auth status`.

use std::collections::BTreeMap;
use std::io::{IsTerminal as _, Write as _};
use std::path::{Path, PathBuf};

use anyhow::{Context as _, Result};
use serde::{Deserialize, Serialize};
use serde_json::json;

use forge_core::app_connect::forge::{
    await_forge_grant, new_connection_id, LoginError, LoginParams, LoginRequest, PollOptions,
    PollStatus, WalletGrant, MIN_PROTOCOL, SETTLE_MS,
};
use forge_core::app_connect::poll::ResponsePort;
use forge_core::app_connect::verify::IdentityPort;
use forge_core::keystore::{BridgeIdentity, Secret};
use forge_core::network::{ForgeIds, Network};
use forge_core::platform::identity::LimitedKeySpec;
use forge_core::platform::PlatformClient;
use forge_core::user_error::{codes, UserError};

use super::{store, LoginArgs, CLI_KEY_BUDGET_DASH, CLI_KEY_DAYS, DAY_MS};
use crate::context::Ctx;
use crate::fmt::{credits_to_dash, dash_amount};

/// The most a wallet grants in one request: both DashPay wallets cap it at 5 DASH.
const WALLET_MAX_BUDGET_DASH: f64 = 5.0;
/// ... and 365 days.
const WALLET_MAX_DAYS: u64 = 365;

/// Where to find the scanner in DashPay.
const SCAN_HOW: &str =
    "open DashPay → More → Tools → Connections → Scan QR, or open the link on the phone";
/// Testnet needs DashPay's testnet build.
const TESTNET_WALLET: &str = "on testnet, use DashPay's testnet build: the `-testnet.apk` on https://github.com/dashpay/dash-wallet/releases/latest (installs beside the store app)";
/// The fix a JSON field and `dg auth status` name for a wallet key.
pub(crate) const RENEW: &str = "dg auth login --wallet";

// ---------------------------------------------------------------------------------------
// The state file
// ---------------------------------------------------------------------------------------

/// `app-connect.toml`: nothing secret.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct State {
    /// The connection id (32 hex digits) per network key (`testnet`, `devnet-sakura`).
    #[serde(default)]
    connections: BTreeMap<String, String>,
    /// The key a wallet granted, per `<network>/<identity>`.
    #[serde(default)]
    wallet_keys: BTreeMap<String, u32>,
}

fn wallet_key_name(network: &str, identity_id: &str) -> String {
    format!("{network}/{identity_id}")
}

fn state_path() -> Result<PathBuf> {
    Ok(crate::config::config_dir()?.join("app-connect.toml"))
}

impl State {
    /// The state in `path`, or an empty one when there is none. A file that does not parse is
    /// an error: a fresh connection id would leave the previous grant's key live.
    fn load(path: &Path) -> Result<Self> {
        let unreadable = |why: String| -> anyhow::Error {
            UserError::new(codes::INVALID_CONFIG, format!("{} could not be read", path.display()))
                .cause(why)
                .fix(format!("repair {}, or delete it: dg then makes a new connection id, and the key your wallet last granted this computer stays live until it expires or you disconnect Dash Forge in the wallet", path.display()))
                .into()
        };
        match std::fs::read_to_string(path) {
            Ok(raw) => toml::from_str(&raw).map_err(|e| unreadable(e.message().to_string())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(e) => Err(unreadable(e.to_string())),
        }
    }

    fn save(&self, path: &Path) -> Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
        }
        let raw = toml::to_string_pretty(self).context("serializing the App Connect state")?;
        forge_core::keystore::write_private_file(path, raw.as_bytes())
            .with_context(|| format!("writing {}", path.display()))
    }

    /// This network's connection id, made (and saved) on first use.
    fn connection_id(path: &Path, network: &str) -> Result<[u8; 16]> {
        let mut state = Self::load(path)?;
        if let Some(id) = state
            .connections
            .get(network)
            .and_then(|h| hex::decode(h).ok())
            .and_then(|b| <[u8; 16]>::try_from(b).ok())
        {
            return Ok(id);
        }
        let id = new_connection_id()?;
        state
            .connections
            .insert(network.to_string(), hex::encode(id));
        state.save(path)?;
        Ok(id)
    }

    fn record_wallet_key(path: &Path, network: &str, identity_id: &str, key_id: u32) -> Result<()> {
        let mut state = Self::load(path)?;
        state
            .wallet_keys
            .insert(wallet_key_name(network, identity_id), key_id);
        state.save(path)
    }

    fn wallet_key(path: &Path, network: &str, identity_id: &str) -> Option<u32> {
        Self::load(path)
            .ok()?
            .wallet_keys
            .get(&wallet_key_name(network, identity_id))
            .copied()
    }
}

/// Whether key `key_id` of `identity_id` on `network` is the one a wallet granted this computer.
pub(crate) fn is_wallet_key(network: &str, identity_id: &str, key_id: u32) -> bool {
    state_path().is_ok_and(|p| State::wallet_key(&p, network, identity_id) == Some(key_id))
}

// ---------------------------------------------------------------------------------------
// Asking the wallet
// ---------------------------------------------------------------------------------------

/// The chain reads a wallet sign-in needs beyond the App Connect ports.
pub(crate) trait WalletChain: IdentityPort + ResponsePort {
    /// The protocol version the network runs (proved).
    async fn protocol_version(&self) -> forge_core::Result<u32>;
    /// Chain time (ms): the latest block's.
    async fn chain_now_ms(&self) -> forge_core::Result<u64>;
}

impl WalletChain for PlatformClient {
    async fn protocol_version(&self) -> forge_core::Result<u32> {
        self.refresh_protocol_version().await
    }

    async fn chain_now_ms(&self) -> forge_core::Result<u64> {
        Ok(self.chain_tip().await?.time_ms)
    }
}

/// What the request proposes; the wallet may change it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Proposal {
    pub budget_credits: u64,
    pub lifetime_ms: u64,
}

impl Proposal {
    /// `--budget` / `--expires` over the CLI defaults, within what a wallet grants.
    pub(crate) fn from_args(args: &super::KeyLimitArgs) -> Result<Self> {
        let budget = args.budget.unwrap_or(CLI_KEY_BUDGET_DASH);
        if budget > WALLET_MAX_BUDGET_DASH {
            return Err(crate::errors::usage(format!(
                "a wallet grants at most {WALLET_MAX_BUDGET_DASH} DASH per sign-in; pass --budget {WALLET_MAX_BUDGET_DASH} or less"
            )));
        }
        let days = match &args.expires {
            Some(s) => super::parse_days(s)?,
            None => CLI_KEY_DAYS,
        };
        if days > WALLET_MAX_DAYS {
            return Err(crate::errors::usage(format!(
                "a wallet grants a key for at most {WALLET_MAX_DAYS} days; pass --expires 365d or less"
            )));
        }
        Ok(Self {
            budget_credits: super::dash_to_credits(budget)?,
            lifetime_ms: days * DAY_MS,
        })
    }
}

/// What the person at the terminal sees while the wallet is asked.
pub(crate) trait LoginUi: Sync {
    /// This machine's clock (ms).
    fn now_ms(&self) -> u64;
    /// Show a new request (its QR code and link).
    fn show(&self, req: &LoginRequest);
    /// After each poll round: what it saw, and how long the code has left (ms).
    fn waiting(&self, status: PollStatus, left_ms: u64);
    /// The code expired unanswered: whether to show a new one.
    fn again(&self) -> Result<bool>;
}

/// Show Forge's request until a wallet answers it, a new code is declined, or the answer is
/// refused. Every request carries `connection_id`; `renewing` says this computer holds a key
/// the wallet granted before (which the wallet disables when it answers).
pub(crate) async fn request_grant<C: WalletChain>(
    chain: &C,
    network: &Network,
    forge: &ForgeIds,
    proposal: Proposal,
    connection_id: [u8; 16],
    renewing: bool,
    ui: &impl LoginUi,
) -> Result<WalletGrant> {
    let protocol = chain
        .protocol_version()
        .await
        .context("reading the network's protocol version")?;
    if protocol < MIN_PROTOCOL {
        return Err(UserError::new(
            codes::UNSUPPORTED,
            "this network cannot sign in with a wallet yet",
        )
        .cause(format!(
            "{network} runs Platform protocol {protocol}; wallet sign-in (App Connect) needs {MIN_PROTOCOL} or later"
        ))
        .fix("sign in with your identity file or recovery phrase: `dg auth login <file>` or `dg auth login --mnemonic`")
        .into());
    }
    let now = || ui.now_ms();
    loop {
        let chain_now_ms = chain
            .chain_now_ms()
            .await
            .context("reading Platform's time")?;
        let req = LoginRequest::new(
            network,
            forge,
            &LoginParams {
                connection_id,
                budget_credits: proposal.budget_credits,
                lifetime_ms: proposal.lifetime_ms,
                chain_now_ms,
                now_ms: now(),
                identity_hint: None,
            },
        )?;
        ui.show(&req);
        let expires = req.expires_at_ms();
        let on_status = |s| ui.waiting(s, expires.saturating_sub(ui.now_ms()));
        let opts = PollOptions {
            settle_ms: SETTLE_MS,
            interval_ms: None,
            now_ms: &now,
            on_status: &on_status,
        };
        match await_forge_grant(chain, req, forge, &opts).await {
            Ok(grant) => return Ok(grant),
            Err(LoginError::Expired(_)) if ui.again()? => {}
            Err(e) => return Err(login_error(network, &e, renewing)),
        }
    }
}

/// What a refused or cancelled sign-in leaves behind.
fn nothing_stored(renewing: bool, what: &str) -> String {
    let renew = if renewing {
        format!("; your wallet may already have disabled the key it gave this computer before, so run `{RENEW}` again to get a working one")
    } else {
        String::new()
    };
    format!("nothing was stored on this computer; {what}{renew}")
}

/// A sign-in that ended without a key, with what to do.
fn login_error(network: &Network, e: &LoginError, renewing: bool) -> anyhow::Error {
    let testnet = matches!(network, Network::Testnet);
    let u = match e {
        LoginError::Expired(read_error) => {
            let mut u = UserError::new(codes::TIMED_OUT, "no wallet answered the sign-in code")
                .cause("the code is valid for 10 minutes and nobody answered it in time")
                .fix(format!("run `{RENEW}` again and scan the new code: {SCAN_HOW}"));
            if testnet {
                u = u.fix(TESTNET_WALLET);
            }
            if let Some(read) = read_error {
                u = u.note(format!("the last read of Platform failed: {read}"));
            }
            u
        }
        LoginError::Ambiguous(ids) => UserError::new(
            codes::REJECTED,
            "more than one identity answered the sign-in code",
        )
        .cause(format!(
            "{} answered, so dg cannot tell which is yours; someone else may have seen the code",
            ids.join(" and ")
        ))
        .fix(format!(
            "run `{RENEW}` again and keep the code private; scan only a code dg printed on this computer"
        ))
        .note(nothing_stored(renewing, "a key a wallet added stays on its identity until disconnected in that wallet")),
        LoginError::TooManyAnswers => UserError::new(
            codes::REJECTED,
            "too many answers reached the sign-in code to check them all",
        )
        .fix(format!("run `{RENEW}` again and keep the code private")),
        LoginError::Refused(_) => UserError::new(codes::REJECTED, "dg did not use the key your wallet sent")
            .cause(e.to_string())
            .fix(format!("run `{RENEW}` again; if it happens again, sign in with `dg auth login <identity file>` or `--mnemonic`"))
            .note(nothing_stored(renewing, "disconnect Dash Forge in your wallet (More → Tools → Connections) to disable that key")),
    };
    u.into()
}

// ---------------------------------------------------------------------------------------
// The terminal
// ---------------------------------------------------------------------------------------

/// The terminal's [`LoginUi`]: everything on stderr, so `--json` keeps stdout clean.
struct Terminal<'a> {
    ctx: &'a Ctx,
    tty: bool,
}

/// `m:ss`.
fn clock(ms: u64) -> String {
    let s = ms.div_ceil(1000);
    format!("{}:{:02}", s / 60, s % 60)
}

/// The lines around the QR code.
fn request_text(uri: &str, network: &str) -> String {
    format!(
        "Sign in to Dash Forge ({network}) with your DashPay wallet:\n\
         {qr}\n\
         {SCAN_HOW}.\n\
         Or copy this link to the phone:\n  {uri}\n\
         Scan only a code dg printed on this computer: anyone who answers it signs in this terminal as their identity.\n",
        qr = super::new::qr_text(uri),
    )
}

impl LoginUi for Terminal<'_> {
    fn now_ms(&self) -> u64 {
        super::now_ms()
    }

    fn show(&self, req: &LoginRequest) {
        eprint!("{}", request_text(req.uri(), &self.ctx.network_label()));
        if matches!(self.ctx.network(), Network::Testnet) {
            eprintln!("({TESTNET_WALLET})");
        }
        eprintln!(
            "The code expires in {}. Waiting for your wallet… (Ctrl-C to stop)",
            clock(req.expires_at_ms().saturating_sub(self.now_ms()))
        );
    }

    fn waiting(&self, status: PollStatus, left_ms: u64) {
        let line = match status {
            PollStatus::Answered => "your wallet answered; checking that nobody else did…".into(),
            PollStatus::IncompleteRead => format!(
                "Platform did not answer this time; retrying ({} left)",
                clock(left_ms)
            ),
            PollStatus::Waiting => format!("waiting for your wallet… {} left", clock(left_ms)),
        };
        if self.tty {
            eprint!("\r\x1b[2K{line}");
            let _ = std::io::stderr().flush();
        } else if status != PollStatus::Waiting {
            eprintln!("{line}");
        }
    }

    fn again(&self) -> Result<bool> {
        if self.tty {
            eprintln!();
        }
        Ok(self.ctx.stdin_tty
            && !self.ctx.json
            && self.ctx.ask("The code expired. Show a new one?", true)?)
    }
}

// ---------------------------------------------------------------------------------------
// login --wallet
// ---------------------------------------------------------------------------------------

/// The granted key's line: "#7 limited to Dash Forge, 0.25 DASH budget (0.25 left), expires in
/// 180 days".
fn grant_line(grant: &WalletGrant) -> String {
    format!(
        "#{} limited to Dash Forge, {} DASH budget ({} left), expires {}",
        grant.key_id,
        dash_amount(credits_to_dash(grant.total_budget)),
        dash_amount(credits_to_dash(grant.remaining_budget)),
        super::expiry_text(grant.expires_at_ms)
    )
}

/// When the wallet granted other limits than proposed, the line that says so.
fn changed_limits(
    grant: &WalletGrant,
    proposal: Proposal,
    proposed_expiry_ms: u64,
) -> Option<String> {
    // The wallet counts the lifetime from its own clock: a day's drift is not a change.
    let expiry_changed = grant.expires_at_ms.abs_diff(proposed_expiry_ms) > DAY_MS;
    (grant.total_budget != proposal.budget_credits || expiry_changed).then(|| {
        format!(
            "your wallet changed the limits dg proposed ({} DASH, {} days)",
            dash_amount(credits_to_dash(proposal.budget_credits)),
            proposal.lifetime_ms / DAY_MS
        )
    })
}

/// Refuse before any code is shown what would fail after the wallet answered: a confirmation
/// that cannot be asked, or a key that cannot be stored.
fn preflight(ctx: &Ctx, args: &LoginArgs) -> Result<()> {
    if let Some(why) = crate::context::prompt_blocker(ctx.yes, ctx.json, ctx.stdin_tty) {
        return Err(UserError::new(
            codes::CONFIRMATION_REQUIRED,
            "dg auth login --wallet asks you to confirm the identity your wallet signed in with",
        )
        .cause(why)
        .fix("run it in a terminal, or pass --yes to accept the identity that answers")
        .note("nothing was shown or stored")
        .into());
    }
    let storable = forge_core::keychain::available()
        || args.storage.insecure_plaintext
        || forge_core::sealed::passphrase_available();
    if !storable {
        return Err(UserError::new(codes::USAGE, "the key your wallet grants could not be stored here")
            .cause("there is no OS keychain, and no passphrase can be asked for the key file (no terminal, and DASH_FORGE_PASSPHRASE is not set)")
            .fix("set DASH_FORGE_PASSPHRASE, or run it in a terminal")
            .fix("pass --insecure-plaintext to store it unencrypted (0600)")
            .note("nothing was shown or stored")
            .into());
    }
    Ok(())
}

/// The key this computer stores for `identity_id` now, if it can be opened: what a new wallet
/// key replaces.
fn current_key(ctx: &Ctx, identity_id: &str) -> Option<BridgeIdentity> {
    if ctx.identity_id_hint().as_deref() != Some(identity_id) {
        return None;
    }
    ctx.load_bridge()
        .map_err(|e| {
            if !ctx.json {
                eprintln!("note: the key in use was not opened ({e:#}), so no encryption key is carried over to the new one");
            }
        })
        .ok()
}

/// What happens to the key the wallet's key replaces: a full identity (master key included) is
/// replaced only when asked, and a limited key dg registered stays live on Platform, said so.
fn replace_current(
    ctx: &Ctx,
    current: &BridgeIdentity,
    grant: &WalletGrant,
) -> Result<Option<String>> {
    if current.master_key().is_some() {
        let prompt = "This computer stores this identity's master key. Replace it with the wallet's key (the master key is then deleted here; keep your recovery words)?";
        if ctx.yes || !ctx.ask(prompt, false)? {
            return Err(UserError::new(codes::CANCELLED, "the master key stored here was kept")
                .cause("the wallet's key would replace the full identity this computer stores")
                .fix(format!("keep using it, or `dg auth logout` (keep your recovery words) and run `{RENEW}` again"))
                .note("nothing was stored; the key your wallet added stays on the identity until you disconnect Dash Forge in the wallet")
                .into());
        }
        return Ok(None);
    }
    let old = current.doc_op_key().ok().map(|k| k.id);
    Ok(old
        .filter(|&id| id != grant.key_id && !is_wallet_key(&ctx.network_label(), &grant.identity_id, id))
        .map(|id| format!("key #{id} this computer held stays live on Platform: `dg auth keys disable {id}` (your master key signs once)")))
}

/// Show who answered and ask the user to confirm it is the identity the wallet showed.
fn confirm_identity(
    ctx: &Ctx,
    shown_as: &str,
    grant: &WalletGrant,
    changed: Option<&str>,
    renewing: bool,
) -> Result<()> {
    if !ctx.json {
        eprintln!("Your wallet signed in as {shown_as}");
        eprintln!("  key {}", grant_line(grant));
        if let Some(line) = changed {
            eprintln!("  {line}");
        }
    }
    if ctx.confirm("Is this the identity your wallet showed?")? {
        return Ok(());
    }
    Err(
        UserError::new(codes::CANCELLED, "cancelled: the identity was not confirmed")
            .fix(format!("run `{RENEW}` again and check the identity your wallet shows"))
            .note(nothing_stored(renewing, "if that identity is yours, disconnect Dash Forge in your wallet (More → Tools → Connections) to disable the key it added"))
            .into(),
    )
}

/// `dg auth login --wallet`.
#[allow(clippy::too_many_lines)]
pub(crate) async fn login(ctx: &Ctx, args: &LoginArgs) -> Result<()> {
    let forge = ctx.target.require_v2()?;
    let proposal = Proposal::from_args(&args.limits)?;
    preflight(ctx, args)?;
    let network = ctx.network_label();
    let state = state_path()?;
    let connection_id = State::connection_id(&state, &network)?;
    let renewing = ctx
        .identity_id_hint()
        .is_some_and(|id| State::wallet_key(&state, &network, &id).is_some());
    let client = ctx.connect().await?;
    let checked =
        super::check_group(ctx, &client, &forge.group, args.limits.strict_group()).await?;
    checked.print_notice(ctx, "");

    let ui = Terminal {
        ctx,
        tty: std::io::stderr().is_terminal(),
    };
    // The expiry the request proposes, as dg's clock sees it (the request uses chain time).
    let proposed_expiry_ms = ui.now_ms() + proposal.lifetime_ms;
    let grant = request_grant(
        &client,
        ctx.network(),
        forge,
        proposal,
        connection_id,
        renewing,
        &ui,
    )
    .await?;
    if ui.tty {
        eprintln!();
    }

    let spec = LimitedKeySpec {
        budget_credits: grant.total_budget,
        expires_at_ms: grant.expires_at_ms,
        group: forge.group.clone(),
    };
    let wif = grant.wif(ctx.network());
    super::verify_key(&client, &grant.identity_id, grant.key_id, &wif, ctx, &spec).await?;
    let identity = client
        .fetch_identity(&grant.identity_id)
        .await
        .context("fetching the identity that answered")?;
    let names = client
        .dpns_names_of(&grant.identity_id)
        .await
        .unwrap_or_default();
    let shown_as = names.first().map_or_else(
        || grant.identity_id.clone(),
        |n| format!("{n} ({})", grant.identity_id),
    );
    let changed = changed_limits(&grant, proposal, proposed_expiry_ms);
    confirm_identity(ctx, &shown_as, &grant, changed.as_deref(), renewing)?;

    let current = current_key(ctx, &grant.identity_id);
    let left_live = match &current {
        Some(c) => replace_current(ctx, c, &grant)?,
        None => None,
    };
    let encryption = current.as_ref().map_or_else(Vec::new, |c| {
        super::encryption_to_store(ctx, &args.storage, &identity, &[c])
    });
    let text = stored_text(&grant, ctx.network(), &network, &encryption)?;
    let stored = store::Storer::new(args.storage.insecure_plaintext).store(
        &network,
        &grant.identity_id,
        &text,
        store::Slot::Main,
    )?;
    store::set_default(ctx, &grant.identity_id, &stored.source())?;
    if let Err(e) = State::record_wallet_key(&state, &network, &grant.identity_id, grant.key_id) {
        if !ctx.json {
            eprintln!("note: signed in, but `dg auth status` will not know the key came from your wallet ({e:#})");
        }
    }

    let kept_ids: Vec<u32> = encryption.iter().map(|k| k.id).collect();
    let balance = identity.balance();
    ctx.emit(
        super::group::with_group_fields(
            json!({
                "status": "logged_in",
                "identityId": grant.identity_id,
                "names": names,
                "network": network,
                "keyId": grant.key_id,
                "keyOrigin": "wallet",
                "fullKey": false,
                "encryptionKeyIds": kept_ids,
                "budgetCredits": grant.total_budget,
                "budgetRemainingCredits": grant.remaining_budget,
                "expiresAt": grant.expires_at_ms,
                "proposedBudgetCredits": proposal.budget_credits,
                "storage": stored.kind(),
                "storedAt": stored.describe(),
                "source": stored.source(),
                "balanceCredits": balance,
                "balanceDash": credits_to_dash(balance),
                "renew": RENEW,
                "previousKeyLeftLive": left_live,
            }),
            Some(&checked),
        ),
        || {
            println!("✓ signed in as {shown_as} on {network}");
            println!(
                "  key {}, from your wallet (App Connect)",
                grant_line(&grant)
            );
            super::print_kept_encryption(&kept_ids);
            println!("  stored in {}", stored.describe());
            println!(
                "  balance {} DASH{}",
                dash_amount(credits_to_dash(balance)),
                crate::fmt::balance_note(credits_to_dash(balance), ctx.network())
            );
            if let Some(line) = &left_live {
                println!("  {line}");
            }
            println!("  renew: {RENEW}; disconnect Dash Forge in your wallet to disable the key");
        },
    );
    Ok(())
}

/// The granted key's `dfk1:` text, with `encryption` keys beside it when there are any.
fn stored_text(
    grant: &WalletGrant,
    network: &Network,
    network_label: &str,
    encryption: &[forge_core::keystore::IdentityKey],
) -> Result<Secret> {
    let text = super::with_encryption_keys(&grant.to_dfk1(network, network_label), encryption)?;
    // What was stored must load back as this key (what every later command reads).
    let loaded = BridgeIdentity::from_source_text(text.expose())?;
    anyhow::ensure!(
        loaded.identity_id == grant.identity_id
            && loaded.doc_op_key().is_ok_and(|k| k.id == grant.key_id),
        "internal error: the stored key does not load back as key {}",
        grant.key_id
    );
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    use async_trait::async_trait;
    use forge_core::app_connect::verify::Candidate;
    use forge_core::app_connect::{
        crypto, encode_base58, hash160, key_type, level, purpose, request, ChainKey, Id, KeyBounds,
    };
    use sha2::{Digest as _, Sha256};

    const T0: u64 = 1_791_676_800_000;
    const CHAIN_T0: u64 = T0 - 5_000;

    fn seed(label: &str) -> [u8; 32] {
        Sha256::digest(format!("dg wallet login test/{label}")).into()
    }

    fn forge() -> ForgeIds {
        ForgeIds {
            core: encode_base58(&seed("forge core")),
            group: encode_base58(&seed("forge group")),
            ..ForgeIds::test_forge()
        }
    }

    fn public(label: &str) -> [u8; 33] {
        let secret = secp256k1::SecretKey::from_slice(&seed(label)).unwrap();
        secp256k1::PublicKey::from_secret_key(&secp256k1::Secp256k1::new(), &secret).serialize()
    }

    /// The key a released wallet registers for `owner` (`ECDSA_HASH160`), 0.25 DASH / 180 d.
    fn wallet_key(owner: &str) -> ChainKey {
        ChainKey {
            id: 7,
            key_type: key_type::ECDSA_HASH160,
            purpose: purpose::AUTHENTICATION,
            security_level: level::HIGH,
            data: hash160(&public(&format!("{owner} key"))).to_vec(),
            disabled: false,
            bounds: Some(KeyBounds::ContractGroup {
                group_id: seed("forge group"),
            }),
            total_budget: Some(25_000_000_000),
            expires_at_ms: Some(CHAIN_T0 + 180 * DAY_MS),
        }
    }

    /// A fake Platform: identities, their keys, the answers published so far.
    #[derive(Default)]
    struct World {
        identities: Mutex<BTreeMap<Id, Vec<ChainKey>>>,
        answers: Mutex<Vec<([u8; 20], Candidate)>>,
        protocol: u32,
        /// The requests shown, by request hash: a wallet answers the latest.
        shown: Mutex<Vec<request::Request>>,
    }

    impl World {
        fn new() -> Self {
            Self {
                protocol: 14,
                ..Self::default()
            }
        }

        fn register(&self, owner: &str, key: ChainKey) {
            self.identities
                .lock()
                .unwrap()
                .insert(seed(owner), vec![key]);
        }

        /// `owner` answers `req` with its key.
        fn answer(&self, req: &request::Request, owner: &str) {
            let wallet_eph =
                secp256k1::SecretKey::from_slice(&seed(&format!("{owner} eph"))).unwrap();
            let (pub_key, payload) = crypto::seal_with(
                &req.app_ephemeral_pub_key,
                &seed(owner),
                &[seed(&format!("{owner} key"))],
                &wallet_eph,
                [1; 12],
            )
            .unwrap();
            let mut answers = self.answers.lock().unwrap();
            answers.push((
                request::request_hash(req),
                Candidate {
                    owner_id: seed(owner),
                    wallet_ephemeral_pub_key: pub_key.to_vec(),
                    encrypted_payload: payload,
                },
            ));
            answers.sort_by_key(|(_, c)| c.owner_id);
        }
    }

    #[async_trait]
    impl IdentityPort for World {
        async fn identity_keys(&self, id: &Id) -> forge_core::Result<Option<Vec<ChainKey>>> {
            Ok(self.identities.lock().unwrap().get(id).cloned())
        }
        async fn remaining_budgets(
            &self,
            id: &Id,
            key_ids: &[u32],
        ) -> forge_core::Result<BTreeMap<u32, u64>> {
            let keys = self
                .identities
                .lock()
                .unwrap()
                .get(id)
                .cloned()
                .unwrap_or_default();
            Ok(keys
                .iter()
                .filter(|k| key_ids.contains(&k.id))
                .filter_map(|k| Some((k.id, k.total_budget?)))
                .collect())
        }
        async fn contract_keys(&self, _: &Id, _: &Id, _: u8) -> forge_core::Result<Vec<ChainKey>> {
            panic!("Forge asks for no encryption key")
        }
    }

    #[async_trait]
    impl ResponsePort for World {
        async fn list_candidates(
            &self,
            hash: &[u8; 20],
            hint: Option<&Id>,
            after: Option<&Id>,
            limit: u32,
        ) -> forge_core::Result<Vec<Candidate>> {
            assert!(hint.is_none(), "a first sign-in names no identity");
            Ok(self
                .answers
                .lock()
                .unwrap()
                .iter()
                .filter(|(h, c)| h == hash && after.is_none_or(|a| c.owner_id > *a))
                .map(|(_, c)| c.clone())
                .take(limit as usize)
                .collect())
        }
    }

    impl WalletChain for World {
        fn protocol_version(&self) -> impl std::future::Future<Output = forge_core::Result<u32>> {
            std::future::ready(Ok(self.protocol))
        }
        fn chain_now_ms(&self) -> impl std::future::Future<Output = forge_core::Result<u64>> {
            std::future::ready(Ok(CHAIN_T0))
        }
    }

    /// A UI on paused tokio time; `answer` is what the wallet does when a code is shown.
    struct Script<'a> {
        world: &'a World,
        start: tokio::time::Instant,
        answer: &'a (dyn Fn(&World, &request::Request, usize) + Sync),
        again: bool,
        shown: Mutex<usize>,
    }

    impl LoginUi for Script<'_> {
        fn now_ms(&self) -> u64 {
            T0 + u64::try_from(self.start.elapsed().as_millis()).unwrap()
        }
        fn show(&self, req: &LoginRequest) {
            let mut n = self.shown.lock().unwrap();
            assert!(req.uri().starts_with("dash-key:") && req.uri().ends_with("&v=2"));
            self.world.shown.lock().unwrap().push(req.request().clone());
            (self.answer)(self.world, req.request(), *n);
            *n += 1;
        }
        fn waiting(&self, _: PollStatus, left_ms: u64) {
            assert!(left_ms <= request::MAX_REQUEST_AGE_MS);
        }
        fn again(&self) -> Result<bool> {
            Ok(self.again)
        }
    }

    fn proposal() -> Proposal {
        Proposal {
            budget_credits: 25_000_000_000,
            lifetime_ms: 180 * DAY_MS,
        }
    }

    async fn run(
        world: &World,
        again: bool,
        answer: &(dyn Fn(&World, &request::Request, usize) + Sync),
    ) -> (Result<WalletGrant>, usize) {
        let ui = Script {
            world,
            start: tokio::time::Instant::now(),
            answer,
            again,
            shown: Mutex::new(0),
        };
        let out = request_grant(
            world,
            &Network::Testnet,
            &forge(),
            proposal(),
            [5; 16],
            false,
            &ui,
        )
        .await;
        let shown = *ui.shown.lock().unwrap();
        (out, shown)
    }

    fn user_error(e: &anyhow::Error) -> &UserError {
        e.downcast_ref::<UserError>().expect("a UserError")
    }

    #[tokio::test(start_paused = true)]
    async fn the_wallets_key_is_granted() {
        let world = World::new();
        world.register("alice", wallet_key("alice"));
        let (grant, shown) = run(&world, false, &|w, r, _| w.answer(r, "alice")).await;
        let grant = grant.unwrap();
        assert_eq!(shown, 1);
        assert_eq!(grant.identity_id, encode_base58(&seed("alice")));
        assert_eq!(grant.key_id, 7);
        assert_eq!(grant.total_budget, 25_000_000_000);
        // The request proposed the CLI's limits and carried the connection id.
        let req = world.shown.lock().unwrap()[0].clone();
        let b = &req.auth_bindings[0];
        assert_eq!(b.total_budget, Some(25_000_000_000));
        assert_eq!(b.expires_at_ms, Some(CHAIN_T0 + 180 * DAY_MS));
        assert_eq!(req.connection_id, Some([5; 16]));
        assert_eq!(req.identity_hint, None);
    }

    #[tokio::test(start_paused = true)]
    async fn two_identities_answering_is_refused() {
        let world = World::new();
        world.register("alice", wallet_key("alice"));
        world.register("mallory", wallet_key("mallory"));
        let (out, _) = run(&world, false, &|w, r, _| {
            w.answer(r, "alice");
            w.answer(r, "mallory");
        })
        .await;
        let err = out.unwrap_err();
        let u = user_error(&err);
        assert_eq!(u.code, codes::REJECTED);
        assert!(u.message.contains("more than one identity"), "{u:?}");
        assert!(u
            .cause
            .as_deref()
            .unwrap()
            .contains(&encode_base58(&seed("mallory"))));
        assert!(u.fix.iter().any(|f| f.contains("keep the code private")));
    }

    #[tokio::test(start_paused = true)]
    async fn an_expired_code_is_shown_again_when_asked() {
        let world = World::new();
        world.register("alice", wallet_key("alice"));
        // Nobody answers the first code; the wallet answers the second.
        let (grant, shown) = run(&world, true, &|w, r, n| {
            if n == 1 {
                w.answer(r, "alice");
            }
        })
        .await;
        assert_eq!(shown, 2);
        assert!(grant.is_ok());
        let requests = world.shown.lock().unwrap();
        assert_ne!(
            requests[0].app_ephemeral_pub_key,
            requests[1].app_ephemeral_pub_key
        );
        assert_eq!(requests[0].connection_id, requests[1].connection_id);
    }

    #[tokio::test(start_paused = true)]
    async fn an_expired_code_says_how_to_scan() {
        let world = World::new();
        let started = tokio::time::Instant::now();
        let (out, shown) = run(&world, false, &|_, _, _| {}).await;
        assert!(started.elapsed().as_millis() >= u128::from(request::MAX_REQUEST_AGE_MS));
        assert_eq!(shown, 1);
        let err = out.unwrap_err();
        let u = user_error(&err);
        assert_eq!(u.code, codes::TIMED_OUT);
        let fixes = u.fix.join("\n");
        assert!(
            fixes.contains("More → Tools → Connections → Scan QR"),
            "{fixes}"
        );
        assert!(fixes.contains("-testnet.apk"), "{fixes}");
        assert!(fixes.contains(RENEW), "{fixes}");
    }

    #[tokio::test(start_paused = true)]
    async fn a_key_forge_will_not_use_is_refused() {
        let world = World::new();
        let mut critical = wallet_key("alice");
        critical.security_level = level::CRITICAL;
        world.register("alice", critical);
        let (out, _) = run(&world, true, &|w, r, _| w.answer(r, "alice")).await;
        let err = out.unwrap_err();
        let u = user_error(&err);
        assert_eq!(u.code, codes::REJECTED);
        assert!(
            u.cause
                .as_deref()
                .unwrap()
                .contains("can do more than Forge asked for"),
            "{u:?}"
        );
        assert!(u.note.as_deref().unwrap().contains("Connections"));
    }

    #[tokio::test(start_paused = true)]
    async fn a_network_before_protocol_14_is_refused_before_any_code() {
        let world = World {
            protocol: 13,
            ..World::new()
        };
        let (out, shown) = run(&world, true, &|_, _, _| {}).await;
        assert_eq!(shown, 0);
        assert_eq!(user_error(&out.unwrap_err()).code, codes::UNSUPPORTED);
    }

    async fn alice_grant() -> WalletGrant {
        let world = World::new();
        world.register("alice", wallet_key("alice"));
        run(&world, false, &|w, r, _| w.answer(r, "alice"))
            .await
            .0
            .unwrap()
    }

    #[tokio::test(start_paused = true)]
    async fn the_stored_key_loads_back_as_the_granted_key() {
        let grant = alice_grant().await;
        let text = stored_text(&grant, &Network::Testnet, "testnet", &[]).unwrap();
        assert!(text.expose().starts_with("dfk1:testnet:"));
        let bridge = BridgeIdentity::from_source_text(text.expose()).unwrap();
        assert_eq!(bridge.identity_id, grant.identity_id);
        let key = bridge.doc_op_key().unwrap();
        assert_eq!(key.id, 7);
        let public_hex = forge_core::platform::identity::public_key_hex(
            key.private_key_wif.expose(),
            &Network::Testnet,
        )
        .unwrap();
        assert_eq!(public_hex, hex::encode(public("alice key")));
        // Shown limits never include the key.
        let line = grant_line(&grant);
        assert!(
            line.starts_with("#7 limited to Dash Forge, 0.25 DASH budget (0.25 left)"),
            "{line}"
        );
        assert!(!line.contains(key.private_key_wif.expose()));
    }

    #[tokio::test(start_paused = true)]
    async fn the_limits_the_wallet_changed_are_named() {
        let mut grant = alice_grant().await;
        let expiry = grant.expires_at_ms;
        assert_eq!(changed_limits(&grant, proposal(), expiry), None);
        assert_eq!(
            changed_limits(&grant, proposal(), expiry + DAY_MS / 2),
            None
        );
        grant.total_budget = 5_000_000_000;
        let line = changed_limits(&grant, proposal(), expiry).unwrap();
        assert!(line.contains("0.25 DASH, 180 days"), "{line}");
    }

    #[test]
    fn the_state_keeps_the_connection_id_and_the_wallet_keys() {
        let t = tempfile::tempdir().unwrap();
        let path = t.path().join("dash-forge/app-connect.toml");
        let id = State::connection_id(&path, "testnet").unwrap();
        assert_eq!(State::connection_id(&path, "testnet").unwrap(), id);
        assert_ne!(State::connection_id(&path, "devnet-sakura").unwrap(), id);
        assert_eq!(State::wallet_key(&path, "testnet", "ALICE"), None);
        State::record_wallet_key(&path, "testnet", "ALICE", 7).unwrap();
        State::record_wallet_key(&path, "testnet", "ALICE", 9).unwrap();
        assert_eq!(State::wallet_key(&path, "testnet", "ALICE"), Some(9));
        assert_eq!(State::wallet_key(&path, "devnet-sakura", "ALICE"), None);
        // Recording a key keeps the connection id.
        assert_eq!(State::connection_id(&path, "testnet").unwrap(), id);
        std::fs::write(&path, "connections = 3").unwrap();
        assert!(State::connection_id(&path, "testnet").is_err());
    }

    #[test]
    fn a_renewal_says_the_old_wallet_key_may_be_gone() {
        assert!(!nothing_stored(false, "x").contains(RENEW));
        let note = nothing_stored(true, "x");
        assert!(
            note.starts_with("nothing was stored on this computer; x; "),
            "{note}"
        );
        assert!(note.contains(RENEW), "{note}");
        let err = login_error(
            &Network::Testnet,
            &LoginError::Ambiguous(vec!["A".into(), "B".into()]),
            true,
        );
        assert!(user_error(&err)
            .note
            .as_deref()
            .unwrap()
            .contains("may already have disabled"));
    }

    #[test]
    fn wallet_limits_are_capped() {
        let args = |budget: Option<f64>, expires: Option<&str>| super::super::KeyLimitArgs {
            budget,
            expires: expires.map(str::to_string),
            strict_group: false,
        };
        assert_eq!(Proposal::from_args(&args(None, None)).unwrap(), proposal());
        assert!(Proposal::from_args(&args(Some(5.0), Some("365d"))).is_ok());
        assert!(Proposal::from_args(&args(Some(5.5), None)).is_err());
        assert!(Proposal::from_args(&args(None, Some("2y"))).is_err());
    }

    #[test]
    fn login_wallet_parses_and_refuses_other_sources() {
        use clap::Parser as _;
        let login = |extra: &[&str]| {
            let mut argv = vec!["dg", "auth", "login", "--wallet"];
            argv.extend_from_slice(extra);
            crate::Cli::try_parse_from(argv)
        };
        let cli = login(&[
            "--budget",
            "1",
            "--expires",
            "90d",
            "--insecure-plaintext",
            "--yes",
        ])
        .unwrap();
        let crate::Command::Auth(super::super::AuthCommand::Login(args)) = cli.command else {
            panic!("not auth login")
        };
        assert!(args.wallet && args.storage.insecure_plaintext);
        assert_eq!(args.limits.budget, Some(1.0));
        for other in [
            &["id.json"][..],
            &["--mnemonic"],
            &["--full-key"],
            &["--replace", "3"],
        ] {
            assert!(login(other).is_err(), "--wallet with {other:?}");
        }
        assert!(crate::Cli::try_parse_from(["dg", "auth", "login", "--mnemonic"]).is_ok());
    }

    #[test]
    fn the_code_screen_has_the_qr_the_link_and_the_warning() {
        let text = request_text("dash-key:abc?n=t&v=2", "testnet");
        assert!(text.contains('█') || text.contains('▀') || text.contains('▄'));
        assert!(text.contains("  dash-key:abc?n=t&v=2\n"));
        assert!(text.contains("Scan only a code dg printed on this computer"));
        assert!(text.contains("More → Tools → Connections → Scan QR"));
        assert_eq!(clock(600_000), "10:00");
        assert_eq!(clock(61_001), "1:02");
    }
}
