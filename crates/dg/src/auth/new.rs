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

use super::group::GroupCheck;
use super::{
    check_group, dash_amount, expiry_text, key_spec, read_mnemonic, register_and_store, store,
    KeyLimitArgs, StorageArgs, CLI_KEY_BUDGET_DASH, CLI_KEY_DAYS,
};
use crate::context::Ctx;
use crate::fmt::credits_to_dash;
use crate::secret_out::{Stream, Surroundings};

/// How long to wait for a deposit before saving the journal and exiting.
const DEPOSIT_WAIT: Duration = Duration::from_mins(30);
/// How long to wait for the asset lock to become provable.
const PROOF_WAIT: Duration = Duration::from_mins(20);
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
    /// Write the full identity (recovery words and every key) to this new file (0600; an
    /// existing file is refused), encrypted under a passphrase (DASH_FORGE_PASSPHRASE without a
    /// terminal or with --json). Required without a terminal (CI, pipes, --json): the words are
    /// then never printed, only this file's path.
    #[arg(long, value_name = "FILE")]
    pub backup_file: Option<PathBuf>,
    /// Write the --backup-file unencrypted.
    #[arg(long, requires = "backup_file")]
    pub reveal_secrets: bool,
    /// Skip the three-word check after the words are shown on a terminal; needs --backup-file,
    /// so a copy exists that was not checked by hand. It does not print or write the words
    /// anywhere else: without a terminal they are never shown, and go only to --backup-file.
    #[arg(long, requires = "backup_file")]
    pub skip_backup_check: bool,
}

/// Refuse, before anything is read or asked, a `--backup-file` that cannot be written: for a
/// fresh creation one already there (it is never overwritten; a resume may replace its own,
/// see [`is_backup_of`]), or a sealed one with no passphrase to seal it.
fn check_backup_file(args: &BackupArgs, fresh: bool) -> Result<()> {
    let Some(path) = &args.backup_file else {
        return Ok(());
    };
    if fresh && path.symlink_metadata().is_ok() {
        return Err(crate::errors::usage(format!(
            "--backup-file {} exists; name a new file (it is never overwritten)",
            path.display()
        )));
    }
    if !args.reveal_secrets && !forge_core::sealed::passphrase_available() {
        return Err(UserError::new(codes::USAGE, "the backup file cannot be sealed")
            .cause("it is encrypted under a passphrase, and there is no terminal to ask for one (or --json)")
            .fix("set DASH_FORGE_PASSPHRASE (10 or more characters) for this run")
            .note("nothing was created or paid")
            .into());
    }
    Ok(())
}

/// Where the fresh recovery words go.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WordsTo {
    /// Shown once on the terminal (stderr), then the three-word check unless skipped.
    Screen { check: bool },
    /// Never printed: `--backup-file` is the only copy.
    BackupFileOnly,
}

/// Decide where the recovery words of a fresh creation go, before anything is created or
/// connected to. Without a terminal (or with --json, or in CI) they are never printed: only a
/// `--backup-file` may hold them, and without one the creation is refused.
fn words_destination(args: &BackupArgs, here: Surroundings) -> Result<WordsTo> {
    if here.may_show() {
        return Ok(WordsTo::Screen {
            check: !args.skip_backup_check,
        });
    }
    if args.backup_file.is_some() {
        return Ok(WordsTo::BackupFileOnly);
    }
    let why = here.why_not().unwrap_or_default();
    Err(
        UserError::new(codes::USAGE, "the recovery words have nowhere safe to go")
            .cause(format!(
                "{why}, and dg never prints recovery words where a log or another program could \
                 keep them"
            ))
            .fix("run `dg auth new` in a terminal: it shows the words once and checks your copy")
            .fix(
                "or pass --backup-file <new file>: the words and keys go only to that file (0600, \
                 passphrase-encrypted, DASH_FORGE_PASSPHRASE without a terminal or with --json) \
                 and only its path is printed",
            )
            .note("nothing was created or paid")
            .into(),
    )
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

/// The words as the numbered list shown on screen.
fn words_list(list: &[&str]) -> String {
    use std::fmt::Write as _;
    let mut out = String::new();
    for (i, w) in list.iter().enumerate() {
        let _ = write!(out, "  {:>2}. {w:<12}", i + 1);
        if i % 4 == 3 {
            out.push('\n');
        }
    }
    out
}

/// Show the words once on `screen` (stderr, a terminal: see [`words_destination`]) and have the
/// user type three of them back. With [`WordsTo::BackupFileOnly`] nothing is written.
fn backup_ceremony(screen: &mut dyn std::io::Write, words: &Secret, to: WordsTo) -> Result<()> {
    let WordsTo::Screen { check } = to else {
        return Ok(());
    };
    let list: Vec<&str> = words.expose().split(' ').collect();
    let shown = zeroize::Zeroizing::new(words_list(&list));
    writeln!(screen)?;
    writeln!(
        screen,
        "Your recovery words. Write them down now, in order, and keep them offline."
    )?;
    writeln!(
        screen,
        "The 12 words ARE the identity: lose them (and any backup file) and nobody can recover it."
    )?;
    writeln!(screen)?;
    writeln!(screen, "{}", shown.as_str())?;
    screen.flush()?;
    if !check {
        return Ok(());
    }
    let mut positions = rand::seq::index::sample(&mut rand::rngs::OsRng, list.len(), 3).into_vec();
    positions.sort_unstable();
    writeln!(
        screen,
        "Check your copy: type the words it asks for (hidden as you type)."
    )?;
    for p in positions {
        for attempt in 0..3 {
            let got = crate::prompt::read_hidden(format!("  word #{}: ", p + 1), "reading a word")?;
            if got.trim().eq_ignore_ascii_case(list[p]) {
                break;
            }
            if attempt == 2 {
                return Err(UserError::new(codes::USAGE, "the backup check failed")
                    .cause(format!("word #{} did not match three times", p + 1))
                    .fix("run `dg auth new` again and copy the words carefully (nothing was created or paid)")
                    .into());
            }
            writeln!(screen, "  that is not word #{}; try again", p + 1)?;
        }
    }
    writeln!(
        screen,
        "  ✓ backup checked. Keep the 12 words offline; do everything else with limited keys."
    )?;
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
    // Neither source answering is "unknown", not "empty": ask. DAPI's history also misses an
    // unconfirmed payment, so a zero is only trusted when the explorer agrees.
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

/// Start and save a journal. The Core tip is read before the address is ever shown: nothing
/// can pay it earlier, so the deposit watch replays from there (less a margin for node lag).
async fn new_journal(client: &PlatformClient, network: String, address: String) -> Result<Journal> {
    let start_height = client
        .best_height()
        .await
        .context("reading the Core chain height")?;
    let j = Journal {
        network,
        deposit_address: address,
        started_at: super::now_ms(),
        start_height: Some(start_height),
        ..Journal::default()
    };
    save_journal(&j)?;
    Ok(j)
}

/// Load, discard or start the journal and get the words; returns the keys and the journal.
async fn start_or_resume(
    ctx: &Ctx,
    client: &PlatformClient,
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
            // `run` refused this up front; decided again right where the words are written.
            let to =
                words_destination(&args.backup, Surroundings::detect(ctx.json, Stream::Stderr))?;
            backup_ceremony(&mut std::io::stderr().lock(), &words, to)?;
            // The backup is written before the journal: a bad backup path leaves nothing
            // behind that would ask for --resume.
            if let Some(path) = &args.backup.backup_file {
                write_backup(path, &keys, "", backup_pass, true)?;
            }
            new_journal(client, network, address).await?
        }
    };
    if let Some(path) = &args.backup.backup_file {
        if !fresh {
            // A resume replaces its own backup (written when the creation started), and never
            // any other file: an existing file that is not a backup of these words is refused.
            let exists = path.symlink_metadata().is_ok();
            if exists && !is_backup_of(path, &words, backup_pass) {
                return Err(crate::errors::usage(format!(
                    "--backup-file {} exists and is not this creation's backup (or its \
                     passphrase differs); name a new file (it is never overwritten)",
                    path.display()
                )));
            }
            write_backup(
                path,
                &keys,
                j.identity_id.as_deref().unwrap_or(""),
                backup_pass,
                !exists,
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

/// Whether `path` is a backup of `words` (opened with `pass` when it is sealed): the only file a
/// resume may replace.
fn is_backup_of(path: &std::path::Path, words: &Secret, pass: Option<&Secret>) -> bool {
    let Ok(raw) = std::fs::read_to_string(path).map(zeroize::Zeroizing::new) else {
        return false;
    };
    let json = if forge_core::sealed::is_sealed(&raw) {
        let Some(pass) = pass else {
            return false;
        };
        match forge_core::sealed::open(&raw, pass.expose()) {
            Ok(bytes) => zeroize::Zeroizing::new(String::from_utf8_lossy(&bytes).into_owned()),
            Err(_) => return false,
        }
    } else {
        raw
    };
    BridgeIdentity::from_json(&json).is_ok_and(|b| b.mnemonic.expose() == words.expose())
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
    eprintln!(
        "It becomes your Platform credits (about 0.001 DASH per issue, 0.005 per small push)."
    );
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

/// The new identity's `ENCRYPTION` key entries (key 4, registered in the same IdentityCreate)
/// to store beside its limited key: none with `--signing-only` or `--insecure-plaintext`, as
/// [`super::encryption_to_store`] decides for an identity that exists.
fn encryption_to_keep(
    args: &NewArgs,
    keys: &NewIdentityKeys,
    identity_id: &str,
) -> Vec<forge_core::keystore::IdentityKey> {
    if args.storage.signing_only || args.storage.insecure_plaintext {
        return vec![];
    }
    keys.to_bridge(identity_id)
        .identity_keys
        .into_iter()
        .filter(|k| k.purpose == "ENCRYPTION")
        .map(|mut k| {
            // what the stored key needs, not how to derive it again
            k.derivation_path.clear();
            k
        })
        .collect()
}

/// Store this computer's limited key, then register the identity with it (or, when an earlier
/// run already created the identity, register a fresh limited key with the words' master key).
/// Returns the key's id, where it is stored and the encryption keys stored beside it.
#[allow(clippy::too_many_arguments)]
async fn register(
    ctx: &Ctx,
    client: &PlatformClient,
    args: &NewArgs,
    keys: &NewIdentityKeys,
    proof: &LockProof,
    identity_id: &str,
    spec: &LimitedKeySpec,
    checked: &GroupCheck,
) -> Result<(u32, store::Stored, Vec<u32>)> {
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
                    super::encryption_key_ids(&b),
                ));
            }
        }
        let replace = identity
            .is_limited_key(FIRST_LIMITED_KEY_ID)
            .then_some(FIRST_LIMITED_KEY_ID);
        let encryption = super::encryption_to_store(ctx, &args.storage, &identity, &[&master]);
        let (id, stored) = register_and_store(
            ctx,
            client,
            &master,
            spec,
            replace,
            checked,
            insecure,
            &encryption,
        )
        .await?;
        return Ok((id, stored, encryption.iter().map(|k| k.id).collect()));
    }
    let limited = FreshKey::generate(ctx.network());
    let dfk1 = forge_core::keystore::dfk1(
        &network,
        identity_id,
        FIRST_LIMITED_KEY_ID,
        limited.wif().expose(),
    );
    // With the identity's encryption key (key 4, registered in the same IdentityCreate), so
    // private repositories work with this computer's key (QW2-004), unless --signing-only.
    let encryption = encryption_to_keep(args, keys, identity_id);
    let text = super::with_encryption_keys(&dfk1, &encryption)?;
    // Stored before the identity exists: an interruption never leaves a key nobody holds.
    let stored = store::store(&network, identity_id, &text, insecure)?;
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
    Ok((
        FIRST_LIMITED_KEY_ID,
        stored,
        encryption.iter().map(|k| k.id).collect(),
    ))
}

pub async fn run(ctx: &Ctx, args: &NewArgs) -> Result<()> {
    let network = ctx.network_label();
    // Before any network read or passphrase prompt: a fresh creation that has nowhere safe to
    // put its recovery words is refused here (a resume reads the words; it shows none).
    if !args.resume {
        words_destination(&args.backup, Surroundings::detect(ctx.json, Stream::Stderr))?;
    }
    check_backup_file(&args.backup, !args.resume)?;
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
    let checked = check_group(ctx, &client, &spec.group, args.limits.strict_group()).await?;
    checked.print_notice(ctx, "");

    let backup_pass = backup_passphrase(args)?;
    let (keys, mut j) = start_or_resume(ctx, &client, args, backup_pass.as_ref()).await?;
    let (lock, proof) = fund_and_lock(ctx, &client, args, &keys, &mut j).await?;
    let identity_id = identity_id_for(&proof)?;
    j.identity_id = Some(identity_id.clone());
    save_journal(&j)?;

    let (key_id, stored, encryption) = register(
        ctx,
        &client,
        args,
        &keys,
        &proof,
        &identity_id,
        &spec,
        &checked,
    )
    .await?;
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
        super::group::with_group_fields(json!({
            "status": "created",
            "identityId": identity_id,
            "network": network,
            "keyId": key_id,
            "budgetCredits": spec.budget_credits,
            "expiresAt": spec.expires_at_ms,
            "storage": stored.kind(),
            "storedAt": stored.describe(),
            "encryptionKeyIds": encryption,
            "assetLockTxid": lock.txid,
            "proof": match proof { LockProof::Instant { .. } => "instant", LockProof::Chain { .. } => "chain" },
            "balanceCredits": balance,
            "balanceDash": credits_to_dash(balance),
            "name": name,
            "backupFile": args.backup.backup_file.as_ref().map(|p| p.display().to_string()),
        }), Some(&checked)),
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
            super::print_kept_encryption(&encryption);
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

    fn backup(file: bool, skip: bool) -> BackupArgs {
        BackupArgs {
            backup_file: file.then(|| PathBuf::from("b.json")),
            reveal_secrets: false,
            skip_backup_check: skip,
        }
    }

    const PERSON: Surroundings = Surroundings {
        json: false,
        terminal: true,
        ci: false,
    };

    /// Every way a run can be automated or captured.
    fn not_a_person() -> [Surroundings; 3] {
        [
            Surroundings {
                json: true,
                ..PERSON
            },
            Surroundings {
                terminal: false,
                ..PERSON
            },
            Surroundings { ci: true, ..PERSON },
        ]
    }

    #[test]
    fn the_words_are_shown_only_to_a_person_at_a_terminal() {
        assert_eq!(
            words_destination(&backup(false, false), PERSON).unwrap(),
            WordsTo::Screen { check: true }
        );
        // --skip-backup-check skips the quiz, nothing else.
        assert_eq!(
            words_destination(&backup(false, true), PERSON).unwrap(),
            WordsTo::Screen { check: false }
        );
        assert_eq!(
            words_destination(&backup(true, true), PERSON).unwrap(),
            WordsTo::Screen { check: false }
        );
        for here in not_a_person() {
            for skip in [false, true] {
                assert_eq!(
                    words_destination(&backup(true, skip), here).unwrap(),
                    WordsTo::BackupFileOnly,
                    "{here:?}"
                );
                let err = words_destination(&backup(false, skip), here)
                    .unwrap_err()
                    .to_string();
                assert!(err.contains("nowhere safe"), "{here:?}: {err}");
            }
        }
    }

    #[test]
    fn the_refusal_names_both_safe_ways() {
        let err = words_destination(&backup(false, true), not_a_person()[1]).unwrap_err();
        let user = err.downcast_ref::<UserError>().expect("a UserError");
        let text = format!("{user:?}");
        assert!(text.contains("in a terminal"), "{text}");
        assert!(text.contains("--backup-file"), "{text}");
        assert!(text.contains("nothing was created"), "{text}");
    }

    #[test]
    fn skip_backup_check_writes_nothing_without_a_terminal() {
        let words = identity::new_mnemonic().unwrap();
        for here in not_a_person() {
            let to = words_destination(&backup(true, true), here).unwrap();
            let mut out = Vec::new();
            backup_ceremony(&mut out, &words, to).unwrap();
            assert!(out.is_empty(), "{here:?} wrote {} bytes", out.len());
        }
    }

    #[test]
    fn a_terminal_sees_every_word_once_and_in_order() {
        let words = identity::new_mnemonic().unwrap();
        let mut out = Vec::new();
        backup_ceremony(&mut out, &words, WordsTo::Screen { check: false }).unwrap();
        let text = String::from_utf8(out).unwrap();
        for (i, w) in words.expose().split(' ').enumerate() {
            assert!(
                text.contains(&format!("{:>2}. {w}", i + 1)),
                "word #{}",
                i + 1
            );
        }
    }

    #[test]
    fn skip_backup_check_needs_a_backup_file() {
        use clap::Args as _;
        let cmd = BackupArgs::augment_args(clap::Command::new("new"));
        let err = cmd
            .clone()
            .try_get_matches_from(["new", "--skip-backup-check"])
            .unwrap_err();
        assert_eq!(err.kind(), clap::error::ErrorKind::MissingRequiredArgument);
        cmd.try_get_matches_from(["new", "--skip-backup-check", "--backup-file", "b.json"])
            .unwrap();
    }

    #[test]
    fn skip_backup_check_help_does_not_promise_anything_about_printing() {
        use clap::Args as _;
        let cmd = BackupArgs::augment_args(clap::Command::new("new"));
        let help = cmd
            .get_arguments()
            .find(|a| a.get_id() == "skip_backup_check")
            .and_then(|a| a.get_help())
            .map(ToString::to_string)
            .unwrap();
        assert!(help.contains("three-word check"), "{help}");
        assert!(!help.contains("Skip showing"), "{help}");
        assert!(help.contains("never shown"), "{help}");
    }

    #[test]
    fn a_resume_replaces_only_a_backup_of_the_same_words() {
        let dir = tempfile::tempdir().unwrap();
        let words = identity::new_mnemonic().unwrap();
        let keys =
            NewIdentityKeys::from_mnemonic(&words, &forge_core::network::Network::Testnet).unwrap();
        let pass = Secret::new("correct horse battery staple");
        let sealed = dir.path().join("sealed.json");
        write_backup(&sealed, &keys, "", Some(&pass), true).unwrap();
        assert!(is_backup_of(&sealed, &words, Some(&pass)));
        assert!(!is_backup_of(
            &sealed,
            &words,
            Some(&Secret::new("another passphrase"))
        ));
        assert!(!is_backup_of(&sealed, &words, None));
        let plain = dir.path().join("plain.json");
        write_backup(&plain, &keys, "", None, true).unwrap();
        assert!(is_backup_of(&plain, &words, None));
        let other = identity::new_mnemonic().unwrap();
        assert!(!is_backup_of(&plain, &other, None));
        let unrelated = dir.path().join("notes.txt");
        std::fs::write(&unrelated, "not a backup").unwrap();
        assert!(!is_backup_of(&unrelated, &words, None));
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
