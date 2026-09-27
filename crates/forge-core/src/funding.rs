//! The Core-chain side of funding an identity.
//!
//! [`CoreChain`] is the DAPI Core service every evonode serves next to Platform (dapi-grpc
//! `core.proto`): `broadcastTransaction`, `getTransaction` (raw bytes, height, lock status),
//! `getBlockchainStatus`, and `subscribeToTransactionsWithProofs`, a bloom-filtered stream of
//! the transactions that pay or spend an address. [`crate::platform::PlatformClient`]
//! implements it over the SDK's DAPI client, so funding needs no service besides the
//! evonodes. The [`Insight`] block explorer is only a fallback for when DAPI cannot answer,
//! and `getislocks` JSON-RPC recovers an InstantSend lock by txid where one exists.
//!
//! Neither is trusted with amounts or keys: every output a deposit is built from is re-read
//! from its raw funding transaction, which must hash to its txid
//! (`platform::identity::DepositWatch`, `verify_deposit`), and neither sees a private key.
//! A node or explorer can delay the user or hide funds, not take them.

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
}

/// The fallback explorer and the lock-proof endpoint, per network.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoreEndpoints {
    /// Insight API base URL (`…/insight-api`), consulted only when DAPI cannot answer.
    pub insight: String,
    /// JSON-RPC with `getislocks` (InstantSend proofs), or `None` to use chain-lock proofs.
    pub islock_rpc: Option<String>,
}

impl CoreEndpoints {
    /// The defaults for `network`, with the explorer overridable (ux-dx-spec §2.2: the
    /// explorer is configurable).
    pub fn for_network(network: &Network, insight_override: Option<&str>) -> Self {
        let (insight, islock_rpc) = match network {
            Network::Testnet => (
                "https://insight.testnet.networks.dash.org/insight-api".to_string(),
                Some("https://trpc.digitalcash.dev".to_string()),
            ),
            Network::Mainnet => ("https://insight.dash.org/insight-api".to_string(), None),
            Network::Devnet { name, .. } => (
                format!("https://insight.{name}.networks.dash.org/insight-api"),
                None,
            ),
        };
        Self {
            insight: insight_override.map_or(insight, |s| s.trim_end_matches('/').to_string()),
            islock_rpc,
        }
    }

    /// The explorer's host, for messages ("asks insight.dash.org").
    pub fn insight_host(&self) -> String {
        reqwest::Url::parse(&self.insight)
            .ok()
            .and_then(|u| u.host_str().map(str::to_string))
            .unwrap_or_else(|| self.insight.clone())
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

/// Where to start watching a deposit address: the recorded height, else far enough back to
/// cover every block since `started_at_ms`.
pub async fn watch_start(
    chain: &dyn CoreChain,
    recorded: Option<u32>,
    started_at_ms: u64,
) -> Result<u32> {
    if let Some(h) = recorded {
        return Ok(h);
    }
    let best = chain.best_height().await?;
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX));
    let elapsed_blocks = now_ms.saturating_sub(started_at_ms) / 150_000;
    let back = u32::try_from(elapsed_blocks)
        .unwrap_or(u32::MAX)
        .saturating_add(REWIND_MARGIN_BLOCKS);
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
                match tokio::time::timeout(left.min(FEED_IDLE), feed.next_transactions()).await {
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
    }
    Ok(None)
}

/// What `address` holds (duffs), from the DAPI feed's history since `from_height`, else the
/// explorer; `None` when neither can say.
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
    match via_dapi.await {
        Ok(t) => return Some(t),
        Err(e) => tracing::warn!("reading {address} through DAPI failed: {e}"),
    }
    match explorer {
        Some(insight) => explorer_deposit(insight, address)
            .await
            .ok()
            .map(|u| total(&u)),
        None => None,
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

    /// DAPI Core in memory: transactions by id, a feed per watch, and a broadcast log.
    #[derive(Default)]
    struct FakeDapi {
        txs: Mutex<BTreeMap<String, CoreTxStatus>>,
        feed: Mutex<Vec<Vec<Vec<u8>>>>,
        broadcasts: Mutex<Vec<Vec<u8>>>,
        watched_from: Mutex<Vec<u32>>,
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
        assert_eq!(
            deposit_balance(&dapi, Some(&insight), ADDR, 1).await,
            Some(0)
        );
    }

    #[tokio::test]
    async fn the_watch_starts_at_the_recorded_height_else_rewinds_past_the_start() {
        let dapi = FakeDapi::default();
        assert_eq!(watch_start(&dapi, Some(88_000), 0).await.unwrap(), 88_000);
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
        assert!(t.islock_rpc.is_some(), "testnet proves with InstantSend");
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
}
