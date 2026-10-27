//! The Core-chain side of funding an identity.
//!
//! [`CoreChain`] is the DAPI Core service every evonode serves next to Platform (dapi-grpc
//! `core.proto`): `broadcastTransaction`, `getTransaction` (raw bytes, height, lock status),
//! `getBlockchainStatus`, and `subscribeToTransactionsWithProofs`, a bloom-filtered stream of
//! the transactions that pay or spend an address, and of the InstantSend locks of the ones
//! it matched. [`crate::platform::PlatformClient`] implements it over the SDK's DAPI client,
//! so funding needs no service besides the evonodes. The [`Insight`] block explorer is only a
//! fallback for when DAPI cannot answer.
//!
//! An asset lock's InstantSend lock comes from that same stream, filtered on the lock's txid
//! and the outpoints it spends ([`CoreChain::watch_instant_lock`]). Nodes send a lock once,
//! live, and never replay it, so the watch is opened before the asset lock is broadcast
//! ([`send_and_await_instant_lock`]); without a lock in time the asset lock is proven with a
//! chain lock instead. A `getislocks` JSON-RPC endpoint, when the user names one, is asked as
//! well (no network has one by default: the public one stopped serving locks).
//!
//! None of them is trusted with amounts or keys: every output a deposit is built from is
//! re-read from its raw funding transaction, which must hash to its txid
//! (`platform::identity::DepositWatch`, `verify_deposit`), an InstantSend lock is used only
//! when it names the asset lock's txid (Platform checks its signature), and none sees a
//! private key. A node or explorer can delay the user or hide funds, not take them.

use std::time::Duration;

use async_trait::async_trait;
use serde::Deserialize;

use crate::error::{Error, Result};
use crate::network::Network;
use crate::platform::core_chain::DepositTracker;
use crate::platform::identity::{verify_deposit, VerifiedUtxo};

/// A Core transaction as a DAPI node reports it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoreTxStatus {
    /// The raw transaction bytes.
    pub raw: Vec<u8>,
    /// The height it was mined at; `None` while it is in the mempool.
    pub height: Option<u32>,
    /// Whether its block is chain-locked.
    pub chain_locked: bool,
    /// Whether it is InstantSend-locked.
    pub instant_locked: bool,
}

/// A live feed of the raw transactions a bloom filter matched.
#[async_trait]
pub trait CoreTxFeed: Send {
    /// The next batch of matched raw transactions; `None` once the node ends the stream.
    async fn next_transactions(&mut self) -> Result<Option<Vec<Vec<u8>>>>;
    /// How many blocks the feed has replayed so far (a reconnect resumes after them).
    fn blocks_seen(&self) -> u32 {
        0
    }
}

/// A live feed of the InstantSend locks a lock watch's nodes send.
#[async_trait]
pub trait InstantLockFeed: Send {
    /// The next batch of raw InstantSend lock messages; `None` once every stream has ended.
    async fn next_locks(&mut self) -> Result<Option<Vec<Vec<u8>>>>;
}

/// The DAPI Core calls funding needs (implemented by [`crate::platform::PlatformClient`]).
#[async_trait]
pub trait CoreChain: Send + Sync {
    /// Broadcast a raw transaction.
    async fn broadcast(&self, raw: &[u8]) -> Result<()>;
    /// Transaction `txid` (display hex), or `None` when no node knows it.
    async fn transaction(&self, txid: &str) -> Result<Option<CoreTxStatus>>;
    /// The height of the best block.
    async fn best_height(&self) -> Result<u32>;
    /// Subscribe to the transactions that pay or spend `address`, from block `from_height`.
    /// With `history_only` the feed ends at the tip; otherwise it continues with the mempool
    /// and new blocks.
    async fn watch_address(
        &self,
        address: &str,
        from_height: u32,
        history_only: bool,
    ) -> Result<Box<dyn CoreTxFeed>>;
    /// Watch for the InstantSend lock of the transaction `raw`: a feed filtered on its txid
    /// and the outpoints it spends, from just below the tip. Nodes send a lock only live, so
    /// open the watch before broadcasting.
    async fn watch_instant_lock(&self, raw: &[u8]) -> Result<Box<dyn InstantLockFeed>>;
}

/// The fallback explorer and the optional extra InstantSend source, per network.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoreEndpoints {
    /// Insight API base URL (`…/insight-api`), consulted only when DAPI cannot answer.
    pub insight: String,
    /// A JSON-RPC with `getislocks`, asked for an InstantSend lock beside the DAPI stream;
    /// `None` (every network's default) asks only the stream.
    pub islock_rpc: Option<String>,
}

impl CoreEndpoints {
    /// The defaults for `network`, with the explorer overridable (ux-dx-spec §2.2: the
    /// explorer is configurable). No network has an InstantSend RPC by default: the DAPI
    /// stream delivers the locks (testnet's `trpc.digitalcash.dev` stopped serving them).
    pub fn for_network(network: &Network, insight_override: Option<&str>) -> Self {
        let insight = match network {
            Network::Testnet => "https://insight.testnet.networks.dash.org/insight-api".to_string(),
            Network::Mainnet => "https://insight.dash.org/insight-api".to_string(),
            Network::Devnet { name, .. } => {
                format!("https://insight.{name}.networks.dash.org/insight-api")
            }
        };
        Self {
            insight: insight_override.map_or(insight, |s| s.trim_end_matches('/').to_string()),
            islock_rpc: None,
        }
    }

    /// With the InstantSend RPC chosen by the user (`--islock-rpc`, `config.toml`): a URL
    /// asked beside the DAPI stream, or `off` / `none` for the stream only (the default, also
    /// kept for `None` or blank).
    ///
    /// A URL must be https (plain http only to a loopback host: the RPC sees the asset-lock
    /// txid, so it must not travel in clear over the network). Anything else is an error.
    pub fn with_islock_rpc(mut self, choice: Option<&str>) -> Result<Self> {
        match choice.map(str::trim).filter(|c| !c.is_empty()) {
            None => {}
            Some(c) if c.eq_ignore_ascii_case("off") || c.eq_ignore_ascii_case("none") => {
                self.islock_rpc = None;
            }
            Some(url) => {
                check_islock_rpc_url(url)?;
                self.islock_rpc = Some(url.trim_end_matches('/').to_string());
            }
        }
        Ok(self)
    }

    /// The explorer's host, for messages ("asks insight.dash.org").
    pub fn insight_host(&self) -> String {
        reqwest::Url::parse(&self.insight)
            .ok()
            .and_then(|u| u.host_str().map(str::to_string))
            .unwrap_or_else(|| self.insight.clone())
    }
}

/// An InstantSend RPC URL is acceptable when it parses, names a host, and is https (or http to
/// a loopback host).
fn check_islock_rpc_url(url: &str) -> Result<()> {
    let bad = |why: &str| {
        Error::Config(format!(
            "the InstantSend RPC {url:?} is not usable: {why} (give an https:// URL, or `off`)"
        ))
    };
    let parsed = reqwest::Url::parse(url).map_err(|e| bad(&e.to_string()))?;
    let Some(host) = parsed.host_str().filter(|h| !h.is_empty()) else {
        return Err(bad("it names no host"));
    };
    let loopback = host.eq_ignore_ascii_case("localhost")
        || host
            .trim_matches(['[', ']'])
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_loopback());
    match parsed.scheme() {
        "https" => Ok(()),
        "http" if loopback => Ok(()),
        "http" => Err(bad("plain http is only allowed to localhost")),
        other => Err(bad(&format!("the scheme {other:?} is not https"))),
    }
}

/// An unspent output the explorer lists for an address (amount not yet verified).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct ListedUtxo {
    /// Funding transaction id (hex, display order).
    pub txid: String,
    /// Output index.
    pub vout: u32,
    /// Claimed value in duffs.
    pub satoshis: u64,
}

/// An Insight API client.
#[derive(Debug, Clone)]
pub struct Insight {
    base: String,
    http: reqwest::Client,
}

impl Insight {
    /// A client for `endpoints.insight`.
    pub fn new(endpoints: &CoreEndpoints) -> Self {
        Self {
            base: endpoints.insight.clone(),
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(20))
                .build()
                .unwrap_or_default(),
        }
    }

    async fn get_json<T: serde::de::DeserializeOwned>(&self, path: &str) -> Result<T> {
        let url = format!("{}{path}", self.base);
        let resp = self
            .http
            .get(&url)
            .send()
            .await
            .map_err(|e| Error::Io(format!("block explorer {}: {e}", self.base)))?;
        if !resp.status().is_success() {
            return Err(Error::Io(format!(
                "block explorer {}: HTTP {}",
                self.base,
                resp.status()
            )));
        }
        resp.json()
            .await
            .map_err(|e| Error::Io(format!("block explorer {}: bad response: {e}", self.base)))
    }

    /// The outputs the explorer lists as unspent at `address`.
    pub async fn utxos(&self, address: &str) -> Result<Vec<ListedUtxo>> {
        self.get_json(&format!("/addr/{address}/utxo")).await
    }

    /// The raw bytes of transaction `txid`.
    pub async fn raw_tx(&self, txid: &str) -> Result<Vec<u8>> {
        #[derive(Deserialize)]
        struct Raw {
            rawtx: String,
        }
        let raw: Raw = self.get_json(&format!("/rawtx/{txid}")).await?;
        hex::decode(raw.rawtx.trim()).map_err(|_| {
            Error::Io(format!(
                "block explorer returned a non-hex transaction for {txid}"
            ))
        })
    }

    /// The height `txid` was mined at, `None` while unconfirmed.
    pub async fn tx_height(&self, txid: &str) -> Result<Option<u32>> {
        #[derive(Deserialize)]
        struct Tx {
            blockheight: Option<i64>,
        }
        let tx: Tx = self.get_json(&format!("/tx/{txid}")).await?;
        Ok(tx
            .blockheight
            .filter(|h| *h >= 0)
            .and_then(|h| u32::try_from(h).ok()))
    }

    /// Broadcast a raw transaction through the explorer.
    pub async fn broadcast(&self, raw_hex: &str) -> Result<()> {
        let url = format!("{}/tx/send", self.base);
        let resp = self
            .http
            .post(&url)
            .json(&serde_json::json!({ "rawtx": raw_hex }))
            .send()
            .await
            .map_err(|e| Error::Io(format!("broadcast via {}: {e}", self.base)))?;
        if resp.status().is_success() {
            return Ok(());
        }
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        Err(Error::Io(format!(
            "broadcast via {} refused: HTTP {status} {}",
            self.base,
            body.chars().take(200).collect::<String>()
        )))
    }
}

/// How long one read of the DAPI feed may sit idle before the explorer is asked as well.
const FEED_IDLE: Duration = Duration::from_secs(30);
/// Pause before reopening a DAPI feed that ended or failed.
const RECONNECT_DELAY: Duration = Duration::from_secs(5);
/// Blocks to rewind a deposit watch whose start height was not recorded (older journals):
/// the blocks since the creation started (2.5-minute target spacing), plus a margin.
const REWIND_MARGIN_BLOCKS: u32 = 50;
/// The deepest rewind: about a week of blocks. Replaying further would not reach the live
/// feed before DAPI's five-minute stream deadline.
const MAX_REWIND_BLOCKS: u32 = 4_032;
/// Blocks subtracted from a recorded start height: nodes' tips differ by a block or two.
pub const START_HEIGHT_MARGIN: u32 = 6;

/// Where to start watching a deposit address: the recorded height, else far enough back to
/// cover every block since `started_at_ms`.
pub async fn watch_start(
    chain: &dyn CoreChain,
    recorded: Option<u32>,
    started_at_ms: u64,
) -> Result<u32> {
    if let Some(h) = recorded {
        return Ok(h.saturating_sub(START_HEIGHT_MARGIN).max(1));
    }
    let best = chain.best_height().await?;
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX));
    let elapsed_blocks = now_ms.saturating_sub(started_at_ms) / 150_000;
    let back = u32::try_from(elapsed_blocks)
        .unwrap_or(u32::MAX)
        .saturating_add(REWIND_MARGIN_BLOCKS)
        .min(MAX_REWIND_BLOCKS);
    Ok(best.saturating_sub(back).max(1))
}

/// The explorer's view of `address`, every output re-read from its raw transaction.
async fn explorer_deposit(insight: &Insight, address: &str) -> Result<Vec<VerifiedUtxo>> {
    let mut verified = Vec::new();
    for u in insight.utxos(address).await? {
        let raw = insight.raw_tx(&u.txid).await?;
        match verify_deposit(&raw, &u.txid, u.vout, address) {
            Ok(v) => verified.push(v),
            Err(e) => tracing::warn!("ignoring {}:{}: {e}", u.txid, u.vout),
        }
    }
    Ok(verified)
}

fn total(utxos: &[VerifiedUtxo]) -> u64 {
    utxos.iter().map(|u| u.duffs).sum()
}

/// Wait until `address` holds at least `min_duffs`, and return its verified unspent outputs;
/// `None` once `timeout` passes. The deposit is seen through a DAPI bloom-filtered
/// transaction feed from block `from_height` (history, then the mempool and new blocks); the
/// explorer, when given, is asked as well whenever the feed is idle or unavailable.
/// `on_seen` hears each new total.
pub async fn wait_for_deposit(
    chain: &dyn CoreChain,
    explorer: Option<&Insight>,
    address: &str,
    min_duffs: u64,
    from_height: u32,
    timeout: Duration,
    on_seen: &mut (dyn FnMut(u64) + Send),
) -> Result<Option<Vec<VerifiedUtxo>>> {
    let deadline = tokio::time::Instant::now() + timeout;
    let mut tracker = DepositTracker::new(address)?;
    let mut last_seen = 0;
    // Where the next (re)connection replays from: past the blocks a feed already delivered,
    // less a margin (the tracker ignores repeats), so a long replay still reaches the tip.
    let mut from_height = from_height;
    let mut next_from = from_height;
    let mut report = |total: u64, on_seen: &mut (dyn FnMut(u64) + Send)| {
        if total != last_seen {
            last_seen = total;
            on_seen(total);
        }
    };
    let ask_explorer = || async move {
        let insight = explorer?;
        explorer_deposit(insight, address)
            .await
            .inspect_err(|e| tracing::debug!("explorer check failed: {e}"))
            .ok()
    };
    while tokio::time::Instant::now() < deadline {
        // Follow the feed until it ends, fails or cannot be opened; the tracker keeps what it
        // learned, and a replay after reconnecting re-applies the same transactions.
        match chain.watch_address(address, from_height, false).await {
            Ok(mut feed) => loop {
                let left = deadline.saturating_duration_since(tokio::time::Instant::now());
                if left.is_zero() {
                    return Ok(None);
                }
                let next =
                    tokio::time::timeout(left.min(FEED_IDLE), feed.next_transactions()).await;
                // The next connection replays from past what this one delivered.
                next_from = next_from.max(
                    from_height
                        .saturating_add(feed.blocks_seen())
                        .saturating_sub(START_HEIGHT_MARGIN),
                );
                match next {
                    Ok(Ok(Some(txs))) => {
                        for raw in &txs {
                            tracker.ingest(raw);
                        }
                        report(tracker.total(), on_seen);
                        if tracker.total() >= min_duffs {
                            return Ok(Some(tracker.utxos()));
                        }
                    }
                    Ok(Ok(None)) => break,
                    Ok(Err(e)) => {
                        tracing::warn!("DAPI transaction feed failed: {e}; reconnecting");
                        break;
                    }
                    Err(_idle) => {
                        if let Some(u) = ask_explorer().await {
                            report(total(&u), on_seen);
                            if total(&u) >= min_duffs {
                                return Ok(Some(u));
                            }
                        }
                    }
                }
            },
            Err(e) => tracing::warn!("watching {address} through DAPI failed: {e}"),
        }
        if let Some(u) = ask_explorer().await {
            report(total(&u), on_seen);
            if total(&u) >= min_duffs {
                return Ok(Some(u));
            }
        }
        tokio::time::sleep(
            RECONNECT_DELAY.min(deadline.saturating_duration_since(tokio::time::Instant::now())),
        )
        .await;
        from_height = next_from;
    }
    Ok(None)
}

/// What `address` holds (duffs): the larger of DAPI's confirmed history since `from_height` and
/// the explorer's view. `None` when neither answers, and also when only DAPI answered zero:
/// its history leaves out the mempool, so an unconfirmed payment would read as empty.
pub async fn deposit_balance(
    chain: &dyn CoreChain,
    explorer: Option<&Insight>,
    address: &str,
    from_height: u32,
) -> Option<u64> {
    let via_dapi = async {
        let mut tracker = DepositTracker::new(address)?;
        let mut feed = chain.watch_address(address, from_height, true).await?;
        while let Some(txs) = feed.next_transactions().await? {
            for raw in &txs {
                tracker.ingest(raw);
            }
        }
        Ok::<_, Error>(tracker.total())
    };
    let dapi = via_dapi
        .await
        .inspect_err(|e| tracing::warn!("reading {address} through DAPI failed: {e}"))
        .ok();
    let explorer = match explorer {
        Some(insight) => explorer_deposit(insight, address)
            .await
            .ok()
            .map(|u| total(&u)),
        None => None,
    };
    match (dapi, explorer) {
        (Some(d), Some(e)) => Some(d.max(e)),
        (Some(d), None) if d > 0 => Some(d),
        (None, Some(e)) => Some(e),
        _ => None,
    }
}

/// The height `txid` was mined at (`None` while unconfirmed or unknown): DAPI first, the
/// explorer only when DAPI cannot answer.
pub async fn tx_height(
    chain: &dyn CoreChain,
    explorer: Option<&Insight>,
    txid: &str,
) -> Result<Option<u32>> {
    match chain.transaction(txid).await {
        Ok(status) => Ok(status.and_then(|s| s.height)),
        Err(dapi) => match explorer {
            Some(insight) => insight.tx_height(txid).await,
            None => Err(dapi),
        },
    }
}

/// Broadcast `raw` (id `txid`): DAPI first, the explorer as fallback. A transaction the
/// network already has counts as broadcast, so a lost response never strands a deposit.
pub async fn broadcast(
    chain: &dyn CoreChain,
    explorer: Option<&Insight>,
    raw: &[u8],
    txid: &str,
) -> Result<()> {
    let dapi = chain.broadcast(raw).await;
    if dapi.is_ok() {
        return Ok(());
    }
    let via_explorer = match explorer {
        Some(insight) => insight.broadcast(&hex::encode(raw)).await,
        None => Err(Error::Io("no block explorer configured".into())),
    };
    if via_explorer.is_ok() {
        return Ok(());
    }
    if matches!(chain.transaction(txid).await, Ok(Some(_))) {
        return Ok(());
    }
    if let Some(insight) = explorer {
        if insight.tx_height(txid).await.is_ok() {
            return Ok(());
        }
    }
    Err(Error::Io(format!(
        "broadcasting {txid} failed: DAPI: {}; explorer: {}",
        dapi.err().map(|e| e.to_string()).unwrap_or_default(),
        via_explorer
            .err()
            .map(|e| e.to_string())
            .unwrap_or_default()
    )))
}

/// The InstantSend lock of `txid` from a `getislocks` JSON-RPC endpoint, if it has one yet.
pub async fn fetch_islock(rpc: &str, txid: &str) -> Result<Option<Vec<u8>>> {
    #[derive(Deserialize)]
    struct Entry {
        txid: Option<String>,
        hex: Option<String>,
    }
    #[derive(Deserialize)]
    struct Reply {
        result: Option<Vec<Option<Entry>>>,
    }
    let resp = reqwest::Client::new()
        .post(rpc)
        .timeout(Duration::from_secs(15))
        .json(&serde_json::json!({ "method": "getislocks", "params": [[txid]] }))
        .send()
        .await
        .map_err(|e| Error::Io(format!("getislocks at {rpc}: {e}")))?;
    if !resp.status().is_success() {
        return Ok(None);
    }
    let reply: Reply = resp
        .json()
        .await
        .map_err(|e| Error::Io(format!("getislocks at {rpc}: bad response: {e}")))?;
    Ok(reply
        .result
        .unwrap_or_default()
        .into_iter()
        .flatten()
        .find(|e| e.txid.as_deref() == Some(txid))
        .and_then(|e| e.hex)
        .and_then(|h| hex::decode(h).ok()))
}

/// The txid (display hex) an InstantSend lock message locks, or `None` when it is not one
/// (DIP-22 `ISDLOCK`: version, the locked outpoints, txid, cycle hash, BLS signature).
pub fn instant_lock_txid(islock: &[u8]) -> Option<String> {
    use dash_sdk::dpp::dashcore::consensus::encode::deserialize;
    deserialize::<dash_sdk::dpp::dashcore::InstantLock>(islock)
        .ok()
        .map(|l| l.txid.to_string())
}

/// How long the RPC, when one is configured, is left between two `getislocks` questions.
const ISLOCK_RPC_POLL: Duration = Duration::from_secs(3);

/// How an asset lock reached the network, and so how it can be proven.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LockRoute {
    /// Its InstantSend lock (raw message) arrived.
    Instant(Vec<u8>),
    /// It was mined already: its InstantSend lock is gone for good, prove with a chain lock.
    Mined,
    /// The network had InstantSend-locked it already (a resumed creation): nodes do not send
    /// that lock again, and no RPC had it, so prove with a chain lock.
    AlreadyInstantLocked,
    /// No InstantSend lock arrived in time: prove with a chain lock.
    NoInstantLock,
}

/// Broadcast the asset lock `raw` (id `txid`) and wait up to `wait` for its InstantSend lock.
///
/// The lock watch ([`CoreChain::watch_instant_lock`]) is opened first, because nodes send a
/// lock once, live: one that arrived before the watch is never seen. A lock the network has
/// already mined is not sent again ([`LockRoute::Mined`]), and one it knows is not broadcast
/// again; one it has already InstantSend-locked (a resumed creation) can no longer arrive
/// through the stream, so only `rpc` is asked for it ([`LockRoute::AlreadyInstantLocked`]).
/// `rpc`, a `getislocks` endpoint, is asked every few seconds, each call bounded by the time
/// left. Only a lock that decodes and names `txid` counts. A watch that cannot be opened does
/// not stop the broadcast. `on_waiting` is called once the broadcast is done and the wait
/// begins. Fails only when the broadcast does.
pub async fn send_and_await_instant_lock(
    chain: &dyn CoreChain,
    explorer: Option<&Insight>,
    rpc: Option<&str>,
    raw: &[u8],
    txid: &str,
    wait: Duration,
    on_waiting: &mut (dyn FnMut() + Send),
) -> Result<LockRoute> {
    let status = chain
        .transaction(txid)
        .await
        .inspect_err(|e| tracing::debug!("reading {txid} before broadcasting it failed: {e}"))
        .ok()
        .flatten();
    if status.as_ref().is_some_and(|s| s.height.is_some()) {
        return Ok(LockRoute::Mined);
    }
    let locked_before = status.as_ref().is_some_and(|s| s.instant_locked);
    if locked_before && rpc.is_none() {
        return Ok(LockRoute::AlreadyInstantLocked);
    }
    let mut feed = if locked_before {
        None
    } else {
        chain
            .watch_instant_lock(raw)
            .await
            .inspect_err(|e| tracing::warn!("watching {txid} for InstantSend failed: {e}"))
            .ok()
    };
    if status.is_none() {
        broadcast(chain, explorer, raw, txid).await?;
    }
    on_waiting();
    let is_ours = |l: &Vec<u8>| instant_lock_txid(l).as_deref() == Some(txid);
    let none = if locked_before {
        LockRoute::AlreadyInstantLocked
    } else {
        LockRoute::NoInstantLock
    };
    let deadline = tokio::time::Instant::now() + wait;
    let mut next_rpc = tokio::time::Instant::now();
    loop {
        let now = tokio::time::Instant::now();
        if now >= deadline {
            return Ok(none);
        }
        if let Some(rpc) = rpc.filter(|_| now >= next_rpc) {
            match tokio::time::timeout_at(deadline, fetch_islock(rpc, txid)).await {
                Ok(Ok(Some(l))) if is_ours(&l) => return Ok(LockRoute::Instant(l)),
                Ok(Ok(Some(_))) => tracing::warn!("{rpc} sent a lock that is not {txid}'s"),
                Ok(Ok(None)) | Err(_) => {}
                Ok(Err(e)) => tracing::debug!("{e}"),
            }
            next_rpc = tokio::time::Instant::now() + ISLOCK_RPC_POLL;
        }
        let until = if rpc.is_some() {
            deadline.min(next_rpc)
        } else {
            deadline
        };
        let Some(f) = feed.as_mut() else {
            if rpc.is_none() {
                return Ok(none);
            }
            tokio::time::sleep_until(until).await;
            continue;
        };
        match tokio::time::timeout_at(until, f.next_locks()).await {
            Ok(Ok(Some(locks))) => {
                if let Some(l) = locks.into_iter().find(is_ours) {
                    return Ok(LockRoute::Instant(l));
                }
            }
            Ok(Ok(None)) => {
                tracing::debug!("every InstantSend stream for {txid} ended");
                feed = None;
            }
            Ok(Err(e)) => {
                tracing::warn!("the InstantSend stream for {txid} failed: {e}");
                feed = None;
            }
            Err(_waited) => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    use dash_sdk::dpp::dashcore::consensus::encode::serialize;
    use dash_sdk::dpp::dashcore::hashes::Hash as _;
    use dash_sdk::dpp::dashcore::{Address, OutPoint, Transaction, TxIn, TxOut, Txid};

    const ADDR: &str = "yhJHMkBAT2TF6D8GHc4v9bMfBh3V2Z6meg";

    /// An Insight explorer that is down: every request gets `503 Back-end server is at
    /// capacity`, as insight.moutai did on 2026-09-27. Counts the requests it served.
    fn insight_503() -> (Insight, Arc<AtomicUsize>) {
        use std::io::{Read as _, Write as _};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}/insight-api", listener.local_addr().unwrap());
        let hits = Arc::new(AtomicUsize::new(0));
        let counter = hits.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { return };
                counter.fetch_add(1, Ordering::SeqCst);
                let mut buf = [0u8; 4096];
                let _ = stream.read(&mut buf);
                let body = "Back-end server is at capacity";
                let _ = write!(
                    stream,
                    "HTTP/1.1 503 Service Unavailable\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
            }
        });
        let endpoints = CoreEndpoints {
            insight: base,
            islock_rpc: None,
        };
        (Insight::new(&endpoints), hits)
    }

    /// DAPI Core in memory: transactions by id, a feed per watch, the InstantSend locks a
    /// lock watch delivers, and a broadcast log.
    #[derive(Default)]
    struct FakeDapi {
        txs: Mutex<BTreeMap<String, CoreTxStatus>>,
        feed: Mutex<Vec<Vec<Vec<u8>>>>,
        islocks: Mutex<Vec<Vec<Vec<u8>>>>,
        broadcasts: Mutex<Vec<Vec<u8>>>,
        watched_from: Mutex<Vec<u32>>,
        /// For each lock watch, how many broadcasts had happened when it was opened.
        lock_watches: Mutex<Vec<usize>>,
        /// A lock watch cannot be opened.
        lock_watch_fails: bool,
        /// A lock watch stays open without sending anything.
        lock_watch_silent: bool,
    }

    /// A lock watch that is open and never sends anything.
    struct SilentFeed;

    #[async_trait]
    impl InstantLockFeed for SilentFeed {
        async fn next_locks(&mut self) -> Result<Option<Vec<Vec<u8>>>> {
            std::future::pending().await
        }
    }

    struct FakeFeed(Vec<Vec<Vec<u8>>>);

    #[async_trait]
    impl CoreTxFeed for FakeFeed {
        async fn next_transactions(&mut self) -> Result<Option<Vec<Vec<u8>>>> {
            if self.0.is_empty() {
                return Ok(None);
            }
            Ok(Some(self.0.remove(0)))
        }
    }

    #[async_trait]
    impl InstantLockFeed for FakeFeed {
        async fn next_locks(&mut self) -> Result<Option<Vec<Vec<u8>>>> {
            self.next_transactions().await
        }
    }

    #[async_trait]
    impl CoreChain for FakeDapi {
        async fn broadcast(&self, raw: &[u8]) -> Result<()> {
            self.broadcasts.lock().unwrap().push(raw.to_vec());
            Ok(())
        }
        async fn transaction(&self, txid: &str) -> Result<Option<CoreTxStatus>> {
            Ok(self.txs.lock().unwrap().get(txid).cloned())
        }
        async fn best_height(&self) -> Result<u32> {
            Ok(88_900)
        }
        async fn watch_address(
            &self,
            _address: &str,
            from_height: u32,
            _history_only: bool,
        ) -> Result<Box<dyn CoreTxFeed>> {
            self.watched_from.lock().unwrap().push(from_height);
            Ok(Box::new(FakeFeed(self.feed.lock().unwrap().clone())))
        }
        async fn watch_instant_lock(&self, _raw: &[u8]) -> Result<Box<dyn InstantLockFeed>> {
            let sent = self.broadcasts.lock().unwrap().len();
            self.lock_watches.lock().unwrap().push(sent);
            if self.lock_watch_fails {
                return Err(Error::Platform("no DAPI node opened a watch".into()));
            }
            if self.lock_watch_silent {
                return Ok(Box::new(SilentFeed));
            }
            Ok(Box::new(FakeFeed(self.islocks.lock().unwrap().clone())))
        }
    }

    /// An `ISDLOCK` message locking `txid` (one input), its signature zeros.
    fn islock_for(txid: Txid) -> Vec<u8> {
        let mut m = vec![1u8, 1];
        m.extend_from_slice(Txid::all_zeros().as_byte_array());
        m.extend_from_slice(&3u32.to_le_bytes());
        m.extend_from_slice(txid.as_byte_array());
        m.extend_from_slice(&[0x11; 32]);
        m.extend_from_slice(&[0; 96]);
        m
    }

    fn payment(to: &str, duffs: u64) -> Transaction {
        Transaction {
            version: 3,
            lock_time: 0,
            input: vec![TxIn {
                previous_output: OutPoint::new(Txid::all_zeros(), 7),
                ..TxIn::default()
            }],
            output: vec![TxOut {
                value: duffs,
                script_pubkey: Address::from_str(to)
                    .unwrap()
                    .assume_checked()
                    .script_pubkey(),
            }],
            special_transaction_payload: None,
        }
    }

    use std::collections::BTreeMap;
    use std::str::FromStr;

    #[tokio::test]
    async fn insight_503_the_deposit_is_seen_broadcast_and_mined_through_dapi() {
        let (insight, hits) = insight_503();
        let dapi = FakeDapi::default();
        let pay = payment(ADDR, 3_000_000);
        dapi.feed.lock().unwrap().push(vec![serialize(&pay)]);

        let mut seen = Vec::new();
        let utxos = wait_for_deposit(
            &dapi,
            Some(&insight),
            ADDR,
            2_700_000,
            88_850,
            Duration::from_secs(5),
            &mut |d| seen.push(d),
        )
        .await
        .unwrap()
        .expect("the deposit is found");
        assert_eq!(utxos.len(), 1);
        assert_eq!(utxos[0].txid, pay.txid().to_string());
        assert_eq!(utxos[0].duffs, 3_000_000);
        assert_eq!(seen, vec![3_000_000]);
        assert_eq!(*dapi.watched_from.lock().unwrap(), vec![88_850]);

        let lock = serialize(&payment(ADDR, 2_999_000));
        broadcast(&dapi, Some(&insight), &lock, "ab").await.unwrap();
        assert_eq!(dapi.broadcasts.lock().unwrap().len(), 1);

        dapi.txs.lock().unwrap().insert(
            "ab".into(),
            CoreTxStatus {
                raw: lock,
                height: Some(88_861),
                chain_locked: true,
                instant_locked: false,
            },
        );
        assert_eq!(
            tx_height(&dapi, Some(&insight), "ab").await.unwrap(),
            Some(88_861)
        );
        assert_eq!(
            hits.load(Ordering::SeqCst),
            0,
            "a healthy DAPI never needs the explorer"
        );
    }

    #[tokio::test]
    async fn insight_503_and_no_deposit_times_out_instead_of_failing() {
        let (insight, _hits) = insight_503();
        let dapi = FakeDapi::default();
        let found = wait_for_deposit(
            &dapi,
            Some(&insight),
            ADDR,
            1,
            1,
            Duration::from_millis(300),
            &mut |_| {},
        )
        .await
        .unwrap();
        assert!(found.is_none());
        // DAPI's history says zero, but it leaves out the mempool and the explorer is down:
        // unknown, so a discard still asks.
        assert_eq!(deposit_balance(&dapi, Some(&insight), ADDR, 1).await, None);
        let pay = payment(ADDR, 7_000);
        dapi.feed.lock().unwrap().push(vec![serialize(&pay)]);
        assert_eq!(
            deposit_balance(&dapi, Some(&insight), ADDR, 1).await,
            Some(7_000)
        );
    }

    #[tokio::test]
    async fn the_watch_starts_at_the_recorded_height_else_rewinds_past_the_start() {
        let dapi = FakeDapi::default();
        assert_eq!(
            watch_start(&dapi, Some(88_000), 0).await.unwrap(),
            88_000 - START_HEIGHT_MARGIN
        );
        // A journal from long ago rewinds at most about a week.
        assert_eq!(
            watch_start(&dapi, None, 0).await.unwrap(),
            88_900 - MAX_REWIND_BLOCKS
        );
        let now_ms = u64::try_from(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis(),
        )
        .unwrap();
        // Started an hour ago: 24 blocks at 2.5 min, plus the margin.
        let from = watch_start(&dapi, None, now_ms - 3_600_000).await.unwrap();
        assert_eq!(from, 88_900 - 24 - REWIND_MARGIN_BLOCKS);
    }

    #[test]
    fn endpoints_follow_the_network_and_the_override() {
        let t = CoreEndpoints::for_network(&Network::Testnet, None);
        assert!(t.insight.contains("testnet"));
        assert!(
            t.islock_rpc.is_none(),
            "testnet's InstantSend locks come from the DAPI stream"
        );
        let m = CoreEndpoints::for_network(&Network::Mainnet, Some("https://my.explorer/api/"));
        assert_eq!(m.insight, "https://my.explorer/api");
        assert_eq!(m.insight_host(), "my.explorer");
        assert!(m.islock_rpc.is_none());
        let d = CoreEndpoints::for_network(
            &Network::Devnet {
                name: "moutai".into(),
                dapi_addresses: vec![],
                quorum_base_url: None,
            },
            None,
        );
        assert_eq!(
            d.insight,
            "https://insight.moutai.networks.dash.org/insight-api"
        );
    }

    #[test]
    fn the_islock_rpc_is_the_users_choice() {
        let default = CoreEndpoints::for_network(&Network::Testnet, None);
        assert_eq!(default.islock_rpc, None, "no third-party RPC by default");
        // Unset or blank: the network's default.
        let with = |c: Option<&str>| default.clone().with_islock_rpc(c);
        assert_eq!(with(None).unwrap(), default);
        assert_eq!(with(Some("  ")).unwrap(), default);
        // A URL adds one (trailing slash dropped); `off` means the DAPI stream only.
        let own = with(Some("https://rpc.example/")).unwrap();
        assert_eq!(own.islock_rpc.as_deref(), Some("https://rpc.example"));
        assert!(with(Some("OFF")).unwrap().islock_rpc.is_none());
        assert!(with(Some("none")).unwrap().islock_rpc.is_none());
        // Plain http only to a loopback host; anything that is not a URL is refused early.
        assert!(with(Some("http://localhost:8080/rpc")).is_ok());
        assert!(with(Some("http://127.0.0.1:9999")).is_ok());
        assert!(with(Some("http://[::1]:9999")).is_ok());
        for bad in [
            "http://rpc.example",
            "ftp://rpc.example",
            "rpc.example",
            "https://",
            "x y",
        ] {
            let e = with(Some(bad)).unwrap_err().to_string();
            assert!(e.contains("InstantSend RPC"), "{bad}: {e}");
        }
        // Any network takes one.
        let m = CoreEndpoints::for_network(&Network::Mainnet, None)
            .with_islock_rpc(Some("https://rpc.example"))
            .unwrap();
        assert!(m.islock_rpc.is_some());
    }

    #[test]
    fn an_instant_lock_names_the_txid_it_locks() {
        let pay = payment(ADDR, 5_000);
        let islock = islock_for(pay.txid());
        // The wire bytes are reversed into the display hex every txid is compared in.
        assert_eq!(instant_lock_txid(&islock), Some(pay.txid().to_string()));
        assert_ne!(
            hex::encode(pay.txid().as_byte_array()),
            pay.txid().to_string()
        );
        // Truncated, padded or empty: not a lock.
        assert_eq!(instant_lock_txid(&islock[..islock.len() - 1]), None);
        assert_eq!(instant_lock_txid(&[islock.as_slice(), &[0]].concat()), None);
        assert_eq!(instant_lock_txid(&[]), None);
    }

    #[tokio::test]
    async fn a_matching_instant_lock_from_the_stream_proves_the_asset_lock() {
        let dapi = FakeDapi::default();
        let lock = payment(ADDR, 2_999_000);
        let txid = lock.txid().to_string();
        let ours = islock_for(lock.txid());
        // Another transaction's lock first (a bloom false positive), then ours.
        dapi.islocks.lock().unwrap().extend([
            vec![islock_for(payment(ADDR, 1).txid())],
            vec![vec![9, 9], ours.clone()],
        ]);
        let mut waited = 0;
        let route = send_and_await_instant_lock(
            &dapi,
            None,
            None,
            &serialize(&lock),
            &txid,
            Duration::from_secs(5),
            &mut || waited += 1,
        )
        .await
        .unwrap();
        assert_eq!(route, LockRoute::Instant(ours));
        assert_eq!(waited, 1);
        // The watch was open before the one broadcast.
        assert_eq!(*dapi.lock_watches.lock().unwrap(), vec![0]);
        assert_eq!(dapi.broadcasts.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn without_a_matching_instant_lock_the_asset_lock_proves_by_chain() {
        let dapi = FakeDapi::default();
        let lock = payment(ADDR, 2_999_000);
        let txid = lock.txid().to_string();
        dapi.islocks
            .lock()
            .unwrap()
            .push(vec![islock_for(payment(ADDR, 1).txid())]);
        let route = send_and_await_instant_lock(
            &dapi,
            None,
            None,
            &serialize(&lock),
            &txid,
            Duration::from_secs(5),
            &mut || {},
        )
        .await
        .unwrap();
        assert_eq!(route, LockRoute::NoInstantLock);
        assert_eq!(dapi.broadcasts.lock().unwrap().len(), 1);

        // Mined already: nothing is watched or sent, straight to the chain proof.
        let mined = FakeDapi::default();
        mined.txs.lock().unwrap().insert(
            txid.clone(),
            CoreTxStatus {
                raw: serialize(&lock),
                height: Some(88_861),
                chain_locked: false,
                instant_locked: true,
            },
        );
        mined
            .islocks
            .lock()
            .unwrap()
            .push(vec![islock_for(lock.txid())]);
        let route = send_and_await_instant_lock(
            &mined,
            None,
            None,
            &serialize(&lock),
            &txid,
            Duration::from_secs(5),
            &mut || {},
        )
        .await
        .unwrap();
        assert_eq!(route, LockRoute::Mined);
        assert!(mined.lock_watches.lock().unwrap().is_empty());
        assert!(mined.broadcasts.lock().unwrap().is_empty());
    }

    /// The lock `txid` a pending creation sent, as DAPI reports it before a resume.
    fn known(dapi: &FakeDapi, lock: &Transaction, instant_locked: bool) {
        dapi.txs.lock().unwrap().insert(
            lock.txid().to_string(),
            CoreTxStatus {
                raw: serialize(lock),
                height: None,
                chain_locked: false,
                instant_locked,
            },
        );
    }

    async fn route(
        dapi: &FakeDapi,
        rpc: Option<&str>,
        lock: &Transaction,
        wait: Duration,
    ) -> (LockRoute, usize) {
        let mut waited = 0;
        let route = send_and_await_instant_lock(
            dapi,
            None,
            rpc,
            &serialize(lock),
            &lock.txid().to_string(),
            wait,
            &mut || waited += 1,
        )
        .await
        .unwrap();
        (route, waited)
    }

    #[tokio::test(start_paused = true)]
    async fn a_silent_stream_is_given_up_on_after_the_wait() {
        let dapi = FakeDapi {
            lock_watch_silent: true,
            ..FakeDapi::default()
        };
        let lock = payment(ADDR, 2_999_000);
        let start = tokio::time::Instant::now();
        let (r, waited) = route(&dapi, None, &lock, Duration::from_secs(60)).await;
        assert_eq!(r, LockRoute::NoInstantLock);
        assert_eq!(waited, 1);
        assert_eq!(start.elapsed(), Duration::from_secs(60));
        assert_eq!(dapi.broadcasts.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn a_resumed_lock_already_instant_locked_is_neither_watched_nor_sent() {
        let dapi = FakeDapi::default();
        let lock = payment(ADDR, 2_999_000);
        known(&dapi, &lock, true);
        dapi.islocks
            .lock()
            .unwrap()
            .push(vec![islock_for(lock.txid())]);
        let (r, waited) = route(&dapi, None, &lock, Duration::from_secs(5)).await;
        assert_eq!(r, LockRoute::AlreadyInstantLocked);
        assert_eq!(waited, 0, "no wait is announced");
        assert!(dapi.lock_watches.lock().unwrap().is_empty());
        assert!(dapi.broadcasts.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_resumed_lock_not_yet_instant_locked_is_watched_but_not_sent_again() {
        let dapi = FakeDapi::default();
        let lock = payment(ADDR, 2_999_000);
        known(&dapi, &lock, false);
        let ours = islock_for(lock.txid());
        dapi.islocks.lock().unwrap().push(vec![ours.clone()]);
        let (r, _) = route(&dapi, None, &lock, Duration::from_secs(5)).await;
        assert_eq!(r, LockRoute::Instant(ours));
        assert_eq!(*dapi.lock_watches.lock().unwrap(), vec![0]);
        assert!(dapi.broadcasts.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_failed_watch_still_broadcasts_and_falls_back_to_chain() {
        let dapi = FakeDapi {
            lock_watch_fails: true,
            ..FakeDapi::default()
        };
        let lock = payment(ADDR, 2_999_000);
        let (r, _) = route(&dapi, None, &lock, Duration::from_secs(5)).await;
        assert_eq!(r, LockRoute::NoInstantLock);
        assert_eq!(dapi.lock_watches.lock().unwrap().len(), 1);
        assert_eq!(dapi.broadcasts.lock().unwrap().len(), 1);
    }

    /// A `getislocks` RPC that answers every call with `body`; counts the calls.
    fn rpc_answering(body: String) -> (String, Arc<AtomicUsize>) {
        use std::io::{Read as _, Write as _};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let hits = Arc::new(AtomicUsize::new(0));
        let counter = hits.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { return };
                counter.fetch_add(1, Ordering::SeqCst);
                let mut buf = [0u8; 4096];
                let _ = stream.read(&mut buf);
                let _ = write!(
                    stream,
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
            }
        });
        (url, hits)
    }

    #[tokio::test]
    async fn an_rpc_lock_for_another_transaction_is_refused() {
        let dapi = FakeDapi::default();
        let lock = payment(ADDR, 2_999_000);
        // The entry claims our txid, but the lock it carries locks another transaction.
        let other = islock_for(payment(ADDR, 1).txid());
        let body = serde_json::json!({
            "result": [{ "txid": lock.txid().to_string(), "hex": hex::encode(&other) }]
        })
        .to_string();
        let (url, hits) = rpc_answering(body);
        let (r, _) = route(&dapi, Some(&url), &lock, Duration::from_millis(1_500)).await;
        assert_eq!(r, LockRoute::NoInstantLock);
        assert!(hits.load(Ordering::SeqCst) >= 1, "the RPC was asked");

        // The same RPC with our own lock proves it.
        let ours = islock_for(lock.txid());
        let body = serde_json::json!({
            "result": [{ "txid": lock.txid().to_string(), "hex": hex::encode(&ours) }]
        })
        .to_string();
        let (url, _) = rpc_answering(body);
        let (r, _) = route(
            &FakeDapi::default(),
            Some(&url),
            &lock,
            Duration::from_secs(5),
        )
        .await;
        assert_eq!(r, LockRoute::Instant(ours));
    }
}
