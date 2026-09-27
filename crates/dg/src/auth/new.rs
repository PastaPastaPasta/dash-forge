//! `dg auth new` — create an identity from the terminal (ux-dx-spec §2.2 tile 2, §2.4, §2.5).
//!
//! 1. Twelve recovery words, shown once; the user types three of them back.
//! 2. The deposit address (the words' BIP-44 asset-lock key) as a QR code and as text, with the
//!    amount. Funds come from any Dash wallet.
//! 3. The deposit is watched through DAPI: a bloom-filtered `subscribeToTransactionsWithProofs`
//!    feed of the address, from the height the creation started at. Values come from the raw
//!    transactions themselves. A block explorer (Insight; `--explorer` changes it) is asked
//!    only when the feed is idle or unavailable, and its outputs are re-read from their raw
//!    transactions too.
//! 4. A type-8 asset lock spends the deposit to a credit output; it is saved to the journal
//!    before it is broadcast (DAPI first, the explorer as fallback).
//! 5. The lock is proven: an InstantSend lock where the network offers one, else a chain lock
//!    once DAPI reports the transaction mined and Platform's chain-locked height reaches it.
//! 6. One IdentityCreate registers the canonical keys (MASTER, HIGH, CRITICAL, TRANSFER,
//!    ENCRYPTION — the same DIP-13 keys the bridge and the web app derive) plus this computer's
//!    limited key, which is stored **before** the identity exists, so an interruption can never
//!    leave a registered key nobody holds.
//!
//! The journal (`$XDG_STATE_HOME/dash-forge/journals/auth-new-<network>.json`) holds only public
//! facts: the deposit address, the signed asset lock and its txid, the identity id. A resumed
//! run asks for the words again and re-derives everything.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use anyhow::{Context as _, Result};
use serde::{Deserialize, Serialize};
use serde_json::json;

use forge_core::funding::{self, fetch_islock, CoreChain as _, CoreEndpoints, Insight};
use forge_core::keystore::{BridgeIdentity, Secret};
use forge_core::platform::identity::{
    self, build_asset_lock, identity_id_for, FreshKey, LimitedKeySpec, LockProof, NewIdentityKeys,
    SignedAssetLock, VerifiedUtxo, DUFFS_PER_DASH, FIRST_LIMITED_KEY_ID, MIN_DEPOSIT_DUFFS,
};
use forge_core::platform::PlatformClient;
use forge_core::user_error::{codes, UserError};

use super::{
    check_group, dash_amount, expiry_text, key_spec, read_mnemonic, register_and_store, store,
    KeyLimitArgs, StorageArgs, CLI_KEY_BUDGET_DASH, CLI_KEY_DAYS,
};
use crate::context::Ctx;
use crate::fmt::credits_to_dash;

/// How long to wait for a deposit before saving the journal and exiting.
const DEPOSIT_WAIT: Duration = Duration::from_mins(30);
/// How long to wait for the asset lock to become provable.
const PROOF_WAIT: Duration = Duration::from_mins(20);
/// A journal started this recently was created by this run (the address is not shown yet).
const FRESH_JOURNAL_MS: u64 = 10 * 60 * 1000;
/// How long to try for an InstantSend lock before falling back to a chain lock.
const ISLOCK_WAIT: Duration = Duration::from_secs(90);

/// `dg auth new` arguments.
#[derive(Debug, clap::Args)]
pub struct NewArgs {
    /// How much to deposit, in DASH (becomes Platform credits; min 0.02).
    #[arg(long, default_value_t = 0.05, value_name = "DASH")]
    pub amount: f64,
    /// Register this DPNS username right after (see `dg auth name register`).
    #[arg(long, value_name = "LABEL")]
    pub name: Option<String>,
    #[command(flatten)]
    pub backup: BackupArgs,
    /// Fallback block explorer (Insight API base URL), asked only when DAPI cannot answer.
    #[arg(long, value_name = "URL")]
    pub explorer: Option<String>,
    /// Resume an interrupted creation (asks for the words again).
    #[arg(long)]
    pub resume: bool,
    /// Discard an unfinished creation journal and start over (warns if its address holds funds).
    #[arg(long, conflicts_with = "resume")]
    pub restart: bool,
    #[command(flatten)]
    pub limits: KeyLimitArgs,
    #[command(flatten)]
    pub storage: StorageArgs,
}

/// How `dg auth new` backs the identity up besides the words shown on screen.
#[derive(Debug, clap::Args)]
pub struct BackupArgs {
    /// Also write the full identity (recovery words and every key) to this new file,
    /// encrypted under a passphrase (0600). Required with --skip-backup-check.
    #[arg(long, value_name = "FILE")]
    pub backup_file: Option<PathBuf>,
    /// Write the --backup-file unencrypted.
    #[arg(long, requires = "backup_file")]
    pub reveal_secrets: bool,
    /// Skip showing the words and the three-word check (automation). Needs --backup-file:
    /// the file is then the only backup.
    #[arg(long, requires = "backup_file")]
    pub skip_backup_check: bool,
}

/// A pending creation: public facts only.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct Journal {
    network: String,
    deposit_address: String,
    lock_txid: Option<String>,
    /// The signed asset lock (hex), saved before it is broadcast.
    lock_raw: Option<String>,
    identity_id: Option<String>,
    started_at: u64,
    /// The Core height when the creation started: the deposit watch replays from here.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    start_height: Option<u32>,
}

fn journal_path(network: &str) -> Result<PathBuf> {
    Ok(forge_core::create::default_journal_dir()?.join(format!("auth-new-{network}.json")))
}

fn read_journal(network: &str) -> Result<Option<Journal>> {
    let p = journal_path(network)?;
    match std::fs::read_to_string(&p) {
        Ok(raw) => Ok(Some(
            serde_json::from_str(&raw).with_context(|| format!("reading {}", p.display()))?,
        )),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e).with_context(|| format!("reading {}", p.display())),
    }
}

fn save_journal(j: &Journal) -> Result<()> {
    let p = journal_path(&j.network)?;
    forge_core::keystore::write_private_file(&p, serde_json::to_string_pretty(j)?.as_bytes())?;
    Ok(())
}

fn clear_journal(network: &str) {
    if let Ok(p) = journal_path(network) {
        let _ = std::fs::remove_file(p);
    }
}

/// Progress on stderr (never in `--json` output).
fn say(ctx: &Ctx, msg: impl AsRef<str>) {
    if !ctx.json {
        eprintln!("{}", msg.as_ref());
    }
}

/// The deposit address as a terminal QR code (half-block characters).
fn qr(address: &str, duffs: u64) -> String {
    use qrcode::render::unicode::Dense1x2;
    let uri = format!(
        "dash:{address}?amount={}",
        dash_amount(duffs_to_dash(duffs))
    );
    qrcode::QrCode::new(uri.as_bytes()).map_or_else(
        |_| String::new(),
        |code| {
            code.render::<Dense1x2>()
                .dark_color(Dense1x2::Light)
                .light_color(Dense1x2::Dark)
                .quiet_zone(true)
                .build()
        },
    )
}

/// Show the words once and have the user type three of them back.
fn backup_ceremony(ctx: &Ctx, words: &Secret, skip_check: bool) -> Result<()> {
    if ctx.json {
        return Ok(());
    }
    let list: Vec<&str> = words.expose().split(' ').collect();
    eprintln!();
    eprintln!("Your recovery words. Write them down now, in order, and keep them offline.");
    eprintln!(
        "The 12 words ARE the identity: lose them (and any backup file) and nobody can recover it."
    );
    eprintln!();
    for (i, w) in list.iter().enumerate() {
        eprint!("  {:>2}. {w:<12}", i + 1);
        if i % 4 == 3 {
            eprintln!();
        }
    }
    eprintln!();
    if skip_check {
        return Ok(());
    }
    if !std::io::IsTerminal::is_terminal(&std::io::stdin()) {
        return Err(UserError::new(codes::USAGE, "the backup check needs a terminal")
            .cause("dg auth new asks you to type three of the words back, and stdin is not a terminal")
            .fix("run it in a terminal, or pass --skip-backup-check (and --backup-file) for automation")
            .into());
    }
    let mut positions = rand::seq::index::sample(&mut rand::rngs::OsRng, list.len(), 3).into_vec();
    positions.sort_unstable();
    eprintln!("Check your copy: type the words it asks for (hidden as you type).");
    for p in positions {
        for attempt in 0..3 {
            let got = rpassword::prompt_password(format!("  word #{}: ", p + 1))
                .context("reading a word")?;
            if got.trim().eq_ignore_ascii_case(list[p]) {
                break;
            }
            if attempt == 2 {
                return Err(UserError::new(codes::USAGE, "the backup check failed")
                    .cause(format!("word #{} did not match three times", p + 1))
                    .fix("run `dg auth new` again and copy the words carefully (nothing was created or paid)")
                    .into());
            }
            eprintln!("  that is not word #{}; try again", p + 1);
        }
    }
    eprintln!(
        "  ✓ backup checked. Keep the 12 words offline; do everything else with limited keys."
    );
    Ok(())
}

/// Wait until the deposit address holds `min_duffs` (DAPI feed first, the explorer when the
/// feed is idle or down). Returns the verified outputs.
async fn wait_for_deposit(
    ctx: &Ctx,
    client: &PlatformClient,
    insight: &Insight,
    address: &str,
    min_duffs: u64,
    from_height: u32,
) -> Result<Vec<VerifiedUtxo>> {
    let mut on_seen = |duffs: u64| {
        if duffs > 0 {
            say(
                ctx,
                format!("  deposit seen: {} DASH", dash_amount(duffs_to_dash(duffs))),
            );
        }
    };
    let found = funding::wait_for_deposit(
        client,
        Some(insight),
        address,
        min_duffs,
        from_height,
        DEPOSIT_WAIT,
        &mut on_seen,
    )
    .await?;
    found.ok_or_else(|| {
        UserError::new(codes::TIMED_OUT, "no deposit yet")
            .cause(format!(
                "nothing arrived at {address} within {} minutes",
                DEPOSIT_WAIT.as_secs() / 60
            ))
            .fix("send the deposit, then run `dg auth new --resume` (the address stays the same)")
            .note("nothing was spent; the journal keeps the address")
            .into()
    })
}

/// Broadcast the asset lock: DAPI first, the explorer as fallback; an "already known" answer
/// from either is success.
async fn broadcast(
    client: &PlatformClient,
    insight: &Insight,
    lock: &SignedAssetLock,
) -> Result<()> {
    funding::broadcast(client, Some(insight), &lock.raw, &lock.txid)
        .await
        .context("broadcasting the asset lock")
}

/// Wait until the lock is provable: InstantSend where available, else a chain lock.
async fn prove(
    ctx: &Ctx,
    client: &PlatformClient,
    endpoints: &CoreEndpoints,
    insight: &Insight,
    lock: &SignedAssetLock,
) -> Result<LockProof> {
    let start = Instant::now();
    if let Some(rpc) = &endpoints.islock_rpc {
        say(ctx, "  waiting for InstantSend…");
        while start.elapsed() < ISLOCK_WAIT {
            if let Ok(Some(islock)) = fetch_islock(rpc, &lock.txid).await {
                return Ok(LockProof::Instant {
                    raw_tx: lock.raw.clone(),
                    islock,
                });
            }
            tokio::time::sleep(Duration::from_secs(3)).await;
        }
        say(
            ctx,
            "  no InstantSend lock; proving with a chain lock instead",
        );
    }
    let mut height = None;
    let mut last_clh = 0;
    say(
        ctx,
        "  waiting for the asset lock to be mined and chain-locked (a few minutes)…",
    );
    while start.elapsed() < PROOF_WAIT {
        if height.is_none() {
            height = funding::tx_height(client, Some(insight), &lock.txid)
                .await
                .ok()
                .flatten();
            if let Some(h) = height {
                say(
                    ctx,
                    format!("  mined at height {h}; waiting for Platform to chain-lock it"),
                );
            }
        }
        if let Some(h) = height {
            if let Ok(clh) = client.core_chain_locked_height().await {
                if clh >= h {
                    return Ok(LockProof::Chain {
                        txid: lock.txid.clone(),
                        height: h,
                    });
                }
                if clh != last_clh {
                    tracing::debug!("platform chain-locked height {clh}, need {h}");
                    last_clh = clh;
                }
            }
        }
        tokio::time::sleep(Duration::from_secs(5)).await;
    }
    Err(UserError::new(codes::TIMED_OUT, "the asset lock is not provable yet")
        .cause(format!("{} is broadcast but was not locked within {} minutes", lock.txid, PROOF_WAIT.as_secs() / 60))
        .fix("run `dg auth new --resume` later: it reuses this asset lock and spends nothing new")
        .note("the funds are safe: they belong to the recovery words")
        .into())
}

/// Deposit amount in duffs from `--amount` DASH.
fn deposit_duffs(amount: f64) -> Result<u64> {
    if !(0.02..=1_000.0).contains(&amount) {
        return Err(crate::errors::usage(
            "--amount must be between 0.02 and 1000 DASH",
        ));
    }
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        clippy::cast_precision_loss
    )]
    Ok(((amount * DUFFS_PER_DASH as f64).round() as u64).max(MIN_DEPOSIT_DUFFS))
}

/// Duffs as DASH, for display.
#[allow(clippy::cast_precision_loss)]
fn duffs_to_dash(duffs: u64) -> f64 {
    duffs as f64 / DUFFS_PER_DASH as f64
}

/// `--restart`: drop the unfinished journal, asking first if its address may hold funds.
async fn discard(ctx: &Ctx, args: &NewArgs, j: &Journal) -> Result<()> {
    let insight = Insight::new(&CoreEndpoints::for_network(
        ctx.network(),
        args.explorer.as_deref(),
    ));
    // Neither DAPI nor the explorer answering is "unknown", not "empty": ask.
    let held = match ctx.connect().await {
        Ok(client) => match funding::watch_start(&client, j.start_height, j.started_at).await {
            Ok(from) => {
                funding::deposit_balance(&client, Some(&insight), &j.deposit_address, from).await
            }
            Err(_) => None,
        },
        Err(_) => None,
    };
    if held != Some(0) || j.lock_txid.is_some() {
        ctx.confirm_or_cancel(&format!(
            "The unfinished creation's address {} holds funds or a broadcast asset lock; they \
             stay recoverable only with its words. Discard it anyway?",
            j.deposit_address
        ))?;
    }
    clear_journal(&j.network);
    Ok(())
}

/// Load, discard or start the journal and get the words; returns the keys and the journal.
async fn start_or_resume(
    ctx: &Ctx,
    args: &NewArgs,
    backup_pass: Option<&Secret>,
) -> Result<(NewIdentityKeys, Journal)> {
    let network = ctx.network_label();
    let journal = match read_journal(&network)? {
        Some(j) if args.restart => {
            discard(ctx, args, &j).await?;
            None
        }
        j => j,
    };
    match (&journal, args.resume) {
        (Some(j), false) => {
            return Err(
                UserError::new(codes::USAGE, "an identity creation is unfinished")
                    .cause(format!(
                        "deposit address {} (journal {})",
                        j.deposit_address,
                        journal_path(&network)?.display()
                    ))
                    .fix("`dg auth new --resume` continues it (asks for the words again)")
                    .fix("`dg auth new --restart` discards it")
                    .into(),
            )
        }
        (None, true) => return Err(crate::errors::usage("nothing to resume on this network")),
        _ => {}
    }

    let words = if journal.is_some() {
        say(
            ctx,
            "Resuming. Type the recovery words of the unfinished identity.",
        );
        read_mnemonic()?
    } else {
        let stderr_tty = std::io::IsTerminal::is_terminal(&std::io::stderr());
        if (ctx.json || !stderr_tty) && !args.backup.skip_backup_check {
            return Err(crate::errors::usage(
                "the recovery words can only be shown on a terminal; run it in one, or add \
                 --skip-backup-check --backup-file <file>",
            ));
        }
        identity::new_mnemonic()?
    };
    let keys = NewIdentityKeys::from_mnemonic(&words, ctx.network())?;
    let address = keys.deposit_address();
    let fresh = journal.is_none();
    let j = match journal {
        Some(j) if j.deposit_address != address => {
            return Err(UserError::new(
                codes::USAGE,
                "those words do not match the creation in progress",
            )
            .cause(format!(
                "they fund {address}, the journal waits on {}",
                j.deposit_address
            ))
            .fix("type the words shown when it started, or `dg auth new --restart`")
            .into());
        }
        Some(j) => j,
        None => {
            backup_ceremony(ctx, &words, args.backup.skip_backup_check)?;
            // The backup is written before the journal: a bad backup path leaves nothing
            // behind that would ask for --resume.
            if let Some(path) = &args.backup.backup_file {
                write_backup(path, &keys, "", backup_pass, true)?;
            }
            let j = Journal {
                network,
                deposit_address: address,
                started_at: super::now_ms(),
                ..Journal::default()
            };
            save_journal(&j)?;
            j
        }
    };
    if let Some(path) = &args.backup.backup_file {
        if !fresh {
            // A resume replaces its own backup (written when the creation started).
            write_backup(
                path,
                &keys,
                j.identity_id.as_deref().unwrap_or(""),
                backup_pass,
                false,
            )?;
        }
        say(
            ctx,
            format!(
                "  backup written to {} (0600, {}; it holds the words and every key)",
                path.display(),
                if backup_pass.is_some() {
                    "passphrase-encrypted"
                } else {
                    "UNENCRYPTED"
                }
            ),
        );
    }
    Ok((keys, j))
}

/// Write the backup file: sealed under a passphrase unless `--reveal-secrets`. The first write
/// creates it (refusing an existing file or a symlink); the second, once the identity id is
/// known, replaces it.
fn write_backup(
    path: &std::path::Path,
    keys: &NewIdentityKeys,
    identity_id: &str,
    pass: Option<&Secret>,
    first: bool,
) -> Result<()> {
    let bytes = super::sealed_or_clear(&keys.to_bridge(identity_id).to_json_with_secrets(), pass)?;
    if first {
        forge_core::keystore::create_private_file(path, &bytes)?;
    } else {
        forge_core::keystore::write_private_file(path, &bytes)?;
    }
    Ok(())
}

/// The passphrase the backup file is sealed with (`None` with --reveal-secrets).
fn backup_passphrase(args: &NewArgs) -> Result<Option<Secret>> {
    match (&args.backup.backup_file, args.backup.reveal_secrets) {
        (Some(path), false) => Ok(Some(forge_core::sealed::passphrase(
            &format!("the backup {}", path.display()),
            true,
        )?)),
        _ => Ok(None),
    }
}

/// Show the deposit request (QR + address + amount), human or `--json` event.
fn show_deposit(ctx: &Ctx, endpoints: &CoreEndpoints, address: &str, duffs: u64) {
    if ctx.json {
        // Machine-readable progress for scripts driving the funding step, on stderr so stdout
        // stays one JSON document (the result).
        eprintln!(
            "{}",
            json!({ "event": "awaiting_deposit", "address": address, "amountDuffs": duffs })
        );
        return;
    }
    eprintln!();
    eprintln!(
        "Send {} DASH to this address from any Dash wallet:",
        dash_amount(duffs_to_dash(duffs))
    );
    eprintln!();
    eprintln!("{}", qr(address, duffs));
    eprintln!("  {address}");
    eprintln!();
    eprintln!("It becomes your Platform credits (~0.0005 DASH per issue or push).");
    eprintln!(
        "dg watches for the deposit through the Dash network's own nodes (DAPI), and asks a \
         block explorer ({}) only if they cannot answer. Neither can take funds or keys.",
        endpoints.insight_host()
    );
    if ctx.network().devnet_name().is_some() {
        eprintln!(
            "Devnet: fund it from the network faucet (or tools/mint-identity fund-from-key)."
        );
    }
}

/// Deposit → asset lock (saved to the journal before broadcast) → broadcast → proof.
async fn fund_and_lock(
    ctx: &Ctx,
    client: &PlatformClient,
    args: &NewArgs,
    keys: &NewIdentityKeys,
    j: &mut Journal,
) -> Result<(SignedAssetLock, LockProof)> {
    let endpoints = CoreEndpoints::for_network(ctx.network(), args.explorer.as_deref());
    let insight = Insight::new(&endpoints);
    // A fresh creation records the tip before the address is shown: nothing can pay it earlier.
    // An older journal without a height is left alone, so `watch_start` rewinds past its start.
    let fresh = super::now_ms().saturating_sub(j.started_at) < FRESH_JOURNAL_MS;
    if j.start_height.is_none() && j.lock_txid.is_none() && fresh {
        j.start_height = Some(
            client
                .best_height()
                .await
                .context("reading the Core chain height")?,
        );
        save_journal(j)?;
    }
    let lock = if let (Some(txid), Some(raw)) = (&j.lock_txid, &j.lock_raw) {
        SignedAssetLock {
            raw: hex::decode(raw).context("the journal's asset lock is not hex")?,
            txid: txid.clone(),
            locked_duffs: 0,
        }
    } else {
        let want = deposit_duffs(args.amount)?;
        show_deposit(ctx, &endpoints, &j.deposit_address, want);
        let from = funding::watch_start(client, j.start_height, j.started_at).await?;
        let utxos = wait_for_deposit(
            ctx,
            client,
            &insight,
            &j.deposit_address,
            want * 9 / 10,
            from,
        )
        .await?;
        let lock = build_asset_lock(keys, &utxos)?;
        j.lock_txid = Some(lock.txid.clone());
        j.lock_raw = Some(hex::encode(&lock.raw));
        save_journal(j)?;
        say(
            ctx,
            format!(
                "  locking {} DASH (asset lock {})",
                dash_amount(duffs_to_dash(lock.locked_duffs)),
                lock.txid
            ),
        );
        lock
    };
    broadcast(client, &insight, &lock).await?;
    let proof = prove(ctx, client, &endpoints, &insight, &lock).await?;
    Ok((lock, proof))
}

/// Store this computer's limited key, then register the identity with it (or, when an earlier
/// run already created the identity, register a fresh limited key with the words' master key).
async fn register(
    ctx: &Ctx,
    client: &PlatformClient,
    args: &NewArgs,
    keys: &NewIdentityKeys,
    proof: &LockProof,
    identity_id: &str,
    spec: &LimitedKeySpec,
) -> Result<(u32, store::Stored)> {
    let network = ctx.network_label();
    let insecure = args.storage.insecure_plaintext;
    if client.identity_exists(identity_id).await? {
        say(
            ctx,
            "  the identity exists already (an earlier run created it); registering a key for \
             this computer",
        );
        let master = keys.to_bridge(identity_id);
        let identity = client.fetch_identity(identity_id).await?;
        // The earlier run stored key 5 before creating the identity: if that copy still
        // controls a live key 5, it is this computer's key and nothing needs registering.
        let stored_source = forge_core::keystore::keychain_source(&network, identity_id);
        if let Ok(b) = BridgeIdentity::load_from_file(&stored_source) {
            if identity.signing_key_id(&b, ctx.network()) == Some(FIRST_LIMITED_KEY_ID)
                && identity.is_limited_key(FIRST_LIMITED_KEY_ID)
            {
                return Ok((
                    FIRST_LIMITED_KEY_ID,
                    store::Stored::Keychain {
                        source: stored_source,
                    },
                ));
            }
        }
        let replace = identity
            .is_limited_key(FIRST_LIMITED_KEY_ID)
            .then_some(FIRST_LIMITED_KEY_ID);
        return register_and_store(ctx, client, &master, spec, replace, insecure).await;
    }
    let limited = FreshKey::generate(ctx.network());
    let dfk1 = forge_core::keystore::dfk1(
        &network,
        identity_id,
        FIRST_LIMITED_KEY_ID,
        limited.wif().expose(),
    );
    // Stored before the identity exists: an interruption never leaves a key nobody holds.
    let stored = store::store(&network, identity_id, &dfk1, insecure)?;
    say(ctx, "  registering the identity…");
    client
        .create_identity(keys, proof, &limited, spec)
        .await
        .context("registering the identity")?;
    super::verify_key(
        client,
        identity_id,
        FIRST_LIMITED_KEY_ID,
        &limited.wif(),
        ctx,
        spec,
    )
    .await?;
    Ok((FIRST_LIMITED_KEY_ID, stored))
}

pub async fn run(ctx: &Ctx, args: &NewArgs) -> Result<()> {
    let network = ctx.network_label();
    deposit_duffs(args.amount)?;
    let spec = key_spec(ctx, &args.limits, CLI_KEY_BUDGET_DASH, CLI_KEY_DAYS)?;
    if let Some(label) = &args.name {
        let (valid, contested) = identity::dpns_label_kind(label);
        if !valid || contested {
            return Err(crate::errors::usage(format!(
                "--name {label:?} is not a free-to-register username (3–63 letters, digits, -; \
                 short names of only a–z, 0, 1 are contested)"
            )));
        }
    }
    let client = ctx.connect().await?;
    check_group(ctx, &client, &spec.group).await?;

    let backup_pass = backup_passphrase(args)?;
    let (keys, mut j) = start_or_resume(ctx, args, backup_pass.as_ref()).await?;
    let (lock, proof) = fund_and_lock(ctx, &client, args, &keys, &mut j).await?;
    let identity_id = identity_id_for(&proof)?;
    j.identity_id = Some(identity_id.clone());
    save_journal(&j)?;

    let (key_id, stored) = register(ctx, &client, args, &keys, &proof, &identity_id, &spec).await?;
    store::set_default(ctx, &identity_id, &stored.source())?;
    clear_journal(&network);
    if let Some(path) = &args.backup.backup_file {
        write_backup(path, &keys, &identity_id, backup_pass.as_ref(), false)?;
    }
    let balance = client.get_balance(&identity_id).await.unwrap_or(0);

    let mut name = None;
    if let Some(label) = &args.name {
        match client
            .register_dpns_name(&keys.to_bridge(&identity_id), label)
            .await
        {
            Ok(n) => name = Some(n),
            Err(e) => say(
                ctx,
                format!("  the name was not registered ({e}); try `dg auth name register {label}`"),
            ),
        }
    }

    ctx.emit(
        json!({
            "status": "created",
            "identityId": identity_id,
            "network": network,
            "keyId": key_id,
            "budgetCredits": spec.budget_credits,
            "expiresAt": spec.expires_at_ms,
            "storage": stored.kind(),
            "storedAt": stored.describe(),
            "assetLockTxid": lock.txid,
            "proof": match proof { LockProof::Instant { .. } => "instant", LockProof::Chain { .. } => "chain" },
            "balanceCredits": balance,
            "balanceDash": credits_to_dash(balance),
            "name": name,
            "backupFile": args.backup.backup_file.as_ref().map(|p| p.display().to_string()),
        }),
        || {
            println!("✓ identity {identity_id} created on {network}");
            if let Some(n) = &name {
                println!("✓ name {n}");
            }
            println!(
                "  key #{key_id}: limited, {} DASH budget, only on Dash Forge, expires {}",
                dash_amount(credits_to_dash(spec.budget_credits)),
                expiry_text(spec.expires_at_ms)
            );
            println!("  stored in {}", stored.describe());
            println!("  balance {} DASH", dash_amount(credits_to_dash(balance)));
            println!("  next: cd my-project && dg init");
        },
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_qr_code_renders_as_text() {
        let q = qr("yRd4FhXfVGHXpsuZXPNkMrfD9GVj46pnjt", 5_000_000);
        assert!(q.lines().count() > 10);
        assert!(q.contains('█') || q.contains('▀') || q.contains('▄'));
    }

    #[test]
    fn the_journal_holds_no_secrets() {
        let j = Journal {
            network: "testnet".into(),
            deposit_address: "yX".into(),
            lock_txid: Some("ab".into()),
            lock_raw: Some("00".into()),
            identity_id: None,
            started_at: 1,
            start_height: Some(88_000),
        };
        let s = serde_json::to_string(&j).unwrap();
        for field in ["mnemonic", "wif", "private"] {
            assert!(!s.to_lowercase().contains(field), "{s}");
        }
    }
}
