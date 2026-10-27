//! DAPI Core for funding: [`CoreChain`] on [`PlatformClient`] (broadcast, transaction status,
//! chain tip, a bloom-filtered address feed, and a watch for an asset lock's InstantSend
//! lock), plus [`DepositTracker`], which turns the address feed into the verified unspent
//! outputs of a deposit address.
//!
//! All of it runs over the SDK's DAPI client against the same evonodes Platform reads use,
//! so creating an identity depends on no block explorer and no InstantSend service.

use std::collections::BTreeMap;
use std::str::FromStr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use dapi_grpc::core::v0::{
    transactions_with_proofs_request::FromBlock, transactions_with_proofs_response::Responses,
    BloomFilter as ProtoBloomFilter, GetBlockchainStatusRequest, GetTransactionRequest,
    TransactionsWithProofsRequest, TransactionsWithProofsResponse,
};
use dapi_grpc::tonic::{Code, Streaming};
use dash_sdk::dapi_client::transport::TransportError;
use dash_sdk::dapi_client::{
    Address as DapiAddress, DapiClient, DapiClientError, DapiRequestExecutor, IntoInner,
    RequestSettings,
};
use dash_sdk::dpp::dashcore::bloom::{BloomFilter, BloomFlags};
use dash_sdk::dpp::dashcore::consensus::encode::{deserialize, serialize};
use dash_sdk::dpp::dashcore::hashes::Hash as _;
use dash_sdk::dpp::dashcore::{Address, ScriptBuf, Transaction};

use super::identity::VerifiedUtxo;
use super::PlatformClient;
use crate::error::{Error, Result};
use crate::funding::{CoreChain, CoreTxFeed, CoreTxStatus, InstantLockFeed};

/// The bloom filter's false-positive rate. A false positive only costs bandwidth: every
/// delivered transaction is checked against the address's script.
const BLOOM_FP_RATE: f64 = 0.0001;
/// Elements the filter is sized for. With `BLOOM_UPDATE_ALL` the node inserts each matched
/// outpoint, so a filter sized for the one address hash would saturate after a match or two
/// and stream every transaction. Fifty keeps it under 150 bytes.
const BLOOM_CAPACITY: u32 = 50;
/// BIP37 `nFlags`: add every matched output to the filter.
const BLOOM_UPDATE_ALL: u32 = 1;
/// Elements a lock watch's filter is sized for, at least: enough for 200+ bytes, as DAPI
/// nodes stream nearly everything to smaller filters (govhub's finding).
const LOCK_BLOOM_MIN_CAPACITY: u32 = 100;
/// Nodes a lock watch listens on at once: the first to send the lock wins, and a stream that
/// cannot open, ends or fails moves on to a node not tried yet (as mainnet-bridge and govhub
/// do).
const LOCK_STREAMS: usize = 3;
/// How long opening a lock stream on one node may take.
const LOCK_STREAM_OPEN: Duration = Duration::from_secs(10);
/// How long to wait for a lock watch's first stream to open before broadcasting anyway.
const LOCK_WATCH_OPEN: Duration = Duration::from_secs(15);
/// Blocks below the tip a lock watch starts at: nodes' tips differ by a block or two.
const LOCK_WATCH_LOOKBACK: u32 = 2;

fn dapi_err(what: &str, e: impl std::fmt::Display) -> Error {
    Error::Platform(format!("{what} through DAPI: {e}"))
}

fn is_not_found(e: &DapiClientError) -> bool {
    match e {
        DapiClientError::Transport(TransportError::Grpc(status)) => status.code() == Code::NotFound,
        DapiClientError::NoAvailableAddressesToRetry(inner) => {
            matches!(inner.as_ref(), TransportError::Grpc(status) if status.code() == Code::NotFound)
        }
        _ => false,
    }
}

fn p2pkh_script(address: &str) -> Result<ScriptBuf> {
    Ok(Address::from_str(address)
        .map_err(|e| Error::Config(format!("address {address}: {e}")))?
        .assume_checked()
        .script_pubkey())
}

/// A BIP37 filter matching `address`'s pubkey hash, in the proto shape DAPI takes. It is
/// `BLOOM_UPDATE_ALL`: the node adds each matched output to the filter, so the transaction
/// that later spends it (whose scriptSig holds the public key, not its hash) matches too.
pub(crate) fn address_bloom_filter(address: &str) -> Result<ProtoBloomFilter> {
    let script = p2pkh_script(address)?;
    let hash = script
        .as_script()
        .p2pkh_public_key_hash_bytes()
        .ok_or_else(|| Error::Config(format!("{address} is not a P2PKH address")))?
        .to_vec();
    let mut filter = BloomFilter::new(
        BLOOM_CAPACITY,
        BLOOM_FP_RATE,
        rand::random(),
        BloomFlags::All,
    )
    .map_err(|e| Error::Config(format!("bloom filter: {e}")))?;
    filter.insert(&hash);
    Ok(ProtoBloomFilter {
        v_data: filter.to_bytes(),
        n_hash_funcs: filter.hash_funcs(),
        n_tweak: filter.tweak(),
        n_flags: BLOOM_UPDATE_ALL,
    })
}

/// A BIP37 filter matching the transaction `tx` by its txid and by each outpoint it spends,
/// each in both byte orders: rs-dapi matches Core's internal (wire) order, the older JS DAPI
/// the display order. A node sends a transaction's InstantSend lock only when the filter
/// matches the transaction.
pub(crate) fn lock_bloom_filter(tx: &Transaction) -> Result<ProtoBloomFilter> {
    let wire_txid = tx.txid().to_byte_array();
    let mut elements = vec![wire_txid.to_vec(), reversed(&wire_txid)];
    for input in &tx.input {
        let outpoint = serialize(&input.previous_output);
        let (txid, vout) = outpoint.split_at(32);
        elements.push(outpoint.clone());
        elements.push([reversed(txid).as_slice(), vout].concat());
    }
    let capacity = u32::try_from(elements.len())
        .unwrap_or(u32::MAX)
        .max(LOCK_BLOOM_MIN_CAPACITY);
    let mut filter = BloomFilter::new(capacity, BLOOM_FP_RATE, rand::random(), BloomFlags::None)
        .map_err(|e| Error::Config(format!("bloom filter: {e}")))?;
    for e in &elements {
        filter.insert(e);
    }
    Ok(ProtoBloomFilter {
        v_data: filter.to_bytes(),
        n_hash_funcs: filter.hash_funcs(),
        n_tweak: filter.tweak(),
        n_flags: 0,
    })
}

fn reversed(bytes: &[u8]) -> Vec<u8> {
    bytes.iter().rev().copied().collect()
}

/// Open the lock stream `request` on the one node `address` (no retries elsewhere, and the
/// node is not banned for its answer).
async fn open_lock_stream(
    address: DapiAddress,
    request: TransactionsWithProofsRequest,
) -> Result<Streaming<TransactionsWithProofsResponse>> {
    let node = address.uri().to_string();
    let client = DapiClient::new(
        std::iter::once(address).collect(),
        RequestSettings {
            connect_timeout: Some(super::DAPI_CONNECT_TIMEOUT),
            retries: Some(0),
            ban_failed_address: Some(false),
            ..RequestSettings::default()
        },
    );
    tokio::time::timeout(
        LOCK_STREAM_OPEN,
        client.execute(request, RequestSettings::default()),
    )
    .await
    .map_err(|_| dapi_err(&format!("opening a lock watch on {node}"), "timed out"))?
    .into_inner()
    .map_err(|e| dapi_err(&format!("opening a lock watch on {node}"), e))
}

/// One of a lock watch's streams, run as its own task: open `request` on the next untried node
/// in `spare` (telling `opened` when it does), forward its InstantSend locks to `locks`, and
/// once the stream fails to open, ends or fails, move on to the next node, until the nodes
/// run out or the watch is dropped.
async fn lock_stream_slot(
    spare: Arc<Mutex<Vec<DapiAddress>>>,
    request: TransactionsWithProofsRequest,
    locks: tokio::sync::mpsc::Sender<Vec<Vec<u8>>>,
    opened: tokio::sync::mpsc::UnboundedSender<()>,
) {
    loop {
        let Some(node) = spare.lock().ok().and_then(|mut s| s.pop()) else {
            return;
        };
        let mut stream = match open_lock_stream(node, request.clone()).await {
            Ok(stream) => stream,
            Err(e) => {
                tracing::debug!("{e}");
                continue;
            }
        };
        let _ = opened.send(());
        loop {
            match stream.message().await {
                Ok(Some(TransactionsWithProofsResponse {
                    responses: Some(Responses::InstantSendLockMessages(m)),
                })) => {
                    if locks.send(m.messages).await.is_err() {
                        return;
                    }
                }
                Ok(Some(_)) => {}
                Ok(None) => break,
                Err(e) => {
                    tracing::debug!("a lock watch stream failed: {e}");
                    break;
                }
            }
        }
    }
}

/// The InstantSend locks every stream of a lock watch sends, merged. Dropping it stops the
/// streams.
struct DapiLockFeed {
    locks: tokio::sync::mpsc::Receiver<Vec<Vec<u8>>>,
    slots: Vec<tokio::task::JoinHandle<()>>,
}

impl Drop for DapiLockFeed {
    fn drop(&mut self) {
        for slot in &self.slots {
            slot.abort();
        }
    }
}

#[async_trait]
impl InstantLockFeed for DapiLockFeed {
    async fn next_locks(&mut self) -> Result<Option<Vec<Vec<u8>>>> {
        Ok(self.locks.recv().await)
    }
}

struct DapiFeed {
    stream: Streaming<TransactionsWithProofsResponse>,
    /// Merkle blocks delivered so far: one per block replayed from the start height.
    blocks: u32,
}

#[async_trait]
impl CoreTxFeed for DapiFeed {
    fn blocks_seen(&self) -> u32 {
        self.blocks
    }

    async fn next_transactions(&mut self) -> Result<Option<Vec<Vec<u8>>>> {
        loop {
            let msg = self
                .stream
                .message()
                .await
                .map_err(|e| dapi_err("reading the transaction feed", e))?;
            let Some(TransactionsWithProofsResponse { responses }) = msg else {
                return Ok(None);
            };
            // Merkle blocks and InstantSend locks carry no outputs; the raw transactions do.
            match responses {
                Some(Responses::RawTransactions(raw)) => return Ok(Some(raw.transactions)),
                Some(Responses::RawMerkleBlock(_)) => self.blocks = self.blocks.saturating_add(1),
                _ => {}
            }
        }
    }
}

#[async_trait]
impl CoreChain for PlatformClient {
    async fn broadcast(&self, raw: &[u8]) -> Result<()> {
        self.broadcast_core_tx(raw).await
    }

    async fn transaction(&self, txid: &str) -> Result<Option<CoreTxStatus>> {
        match self
            .sdk()
            .execute(
                GetTransactionRequest {
                    id: txid.to_string(),
                },
                RequestSettings::default(),
            )
            .await
            .into_inner()
        {
            Ok(r) if r.transaction.is_empty() => Ok(None),
            Ok(r) => Ok(Some(CoreTxStatus {
                raw: r.transaction,
                height: (!r.block_hash.is_empty() && r.height > 0).then_some(r.height),
                chain_locked: r.is_chain_locked,
                instant_locked: r.is_instant_locked,
            })),
            Err(e) if is_not_found(&e) => Ok(None),
            Err(e) => Err(dapi_err(&format!("reading transaction {txid}"), e)),
        }
    }

    async fn best_height(&self) -> Result<u32> {
        let status = self
            .sdk()
            .execute(GetBlockchainStatusRequest {}, RequestSettings::default())
            .await
            .into_inner()
            .map_err(|e| dapi_err("reading the Core chain status", e))?;
        status
            .chain
            .map(|c| c.blocks_count)
            .filter(|h| *h > 0)
            .ok_or_else(|| Error::Platform("DAPI reported no Core chain height".into()))
    }

    async fn watch_address(
        &self,
        address: &str,
        from_height: u32,
        history_only: bool,
    ) -> Result<Box<dyn CoreTxFeed>> {
        let from_height = from_height.max(1);
        let count = if history_only {
            self.best_height().await?.saturating_sub(from_height) + 1
        } else {
            0
        };
        let stream = self
            .sdk()
            .execute(
                TransactionsWithProofsRequest {
                    bloom_filter: Some(address_bloom_filter(address)?),
                    from_block: Some(FromBlock::FromBlockHeight(from_height)),
                    count,
                    send_transaction_hashes: false,
                },
                RequestSettings::default(),
            )
            .await
            .into_inner()
            .map_err(|e| dapi_err(&format!("watching {address}"), e))?;
        Ok(Box::new(DapiFeed { stream, blocks: 0 }))
    }

    /// Streams on up to [`LOCK_STREAMS`] distinct live nodes ([`open_lock_watch`]); one is
    /// open before this returns, so a lock sent after it is seen.
    async fn watch_instant_lock(&self, raw: &[u8]) -> Result<Box<dyn InstantLockFeed>> {
        let tx: Transaction = deserialize(raw)
            .map_err(|e| Error::Config(format!("the asset-lock transaction: {e}")))?;
        let from = self
            .best_height()
            .await?
            .saturating_sub(LOCK_WATCH_LOOKBACK)
            .max(1);
        let request = TransactionsWithProofsRequest {
            bloom_filter: Some(lock_bloom_filter(&tx)?),
            from_block: Some(FromBlock::FromBlockHeight(from)),
            count: 0,
            send_transaction_hashes: false,
        };
        tracing::debug!(from, "watching {} for InstantSend", tx.txid());
        let list = self.sdk().address_list();
        let mut nodes = list.get_live_addresses();
        if nodes.is_empty() {
            // Every node is banned for now (a ban is the SDK's guess, often about Platform
            // and not Core): try them all rather than not watching.
            nodes = list
                .ban_info()
                .iter()
                .filter_map(|b| b.uri.parse().ok())
                .collect();
        }
        Ok(Box::new(open_lock_watch(nodes, request).await?))
    }
}

/// A lock watch: `request` open on up to [`LOCK_STREAMS`] of `nodes` at once, picked at
/// random, each stream replaced by one on an untried node the moment it fails to open, ends
/// or fails. Returns once the first stream is open (the others keep connecting meanwhile),
/// or after [`LOCK_WATCH_OPEN`] with whatever is open by then; fails only when every node
/// was tried and none opened.
async fn open_lock_watch(
    mut nodes: Vec<DapiAddress>,
    request: TransactionsWithProofsRequest,
) -> Result<DapiLockFeed> {
    nodes.sort_by_cached_key(|_| rand::random::<u64>());
    let slots = LOCK_STREAMS.min(nodes.len());
    let spare = Arc::new(Mutex::new(nodes));
    let (locks_tx, locks) = tokio::sync::mpsc::channel(16);
    let (opened_tx, mut opened) = tokio::sync::mpsc::unbounded_channel();
    let feed = DapiLockFeed {
        locks,
        slots: (0..slots)
            .map(|_| {
                tokio::spawn(lock_stream_slot(
                    spare.clone(),
                    request.clone(),
                    locks_tx.clone(),
                    opened_tx.clone(),
                ))
            })
            .collect(),
    };
    drop(opened_tx);
    match tokio::time::timeout(LOCK_WATCH_OPEN, opened.recv()).await {
        Ok(Some(())) => tracing::debug!("lock watch open"),
        // Every slot ran out of nodes without opening a stream.
        Ok(None) => {
            return Err(Error::Platform(
                "no DAPI node opened an InstantSend watch".into(),
            ))
        }
        Err(_slow) => {
            tracing::warn!(
                "no DAPI node has opened the InstantSend watch yet; broadcasting anyway"
            );
        }
    }
    Ok(feed)
}

/// The unspent outputs paying one address, built from the raw transactions a DAPI feed
/// delivers. Values come from the transactions themselves (their txid is computed here, not
/// reported), so a node can hide or delay a deposit but not misstate it.
#[derive(Debug, Clone)]
pub struct DepositTracker {
    script: ScriptBuf,
    unspent: BTreeMap<(String, u32), u64>,
    spent: std::collections::BTreeSet<(String, u32)>,
}

impl DepositTracker {
    /// Track the P2PKH outputs paying `address`.
    pub fn new(address: &str) -> Result<Self> {
        Ok(Self {
            script: p2pkh_script(address)?,
            unspent: BTreeMap::new(),
            spent: std::collections::BTreeSet::new(),
        })
    }

    /// Record one raw transaction: its outputs to the address, and the outputs it spends.
    /// Transactions that do not decode (a bloom false positive with an unknown payload) are
    /// skipped.
    pub fn ingest(&mut self, raw: &[u8]) {
        let Ok(tx) = deserialize::<Transaction>(raw) else {
            tracing::debug!("skipping an undecodable transaction from the DAPI feed");
            return;
        };
        for input in &tx.input {
            let key = (
                input.previous_output.txid.to_string(),
                input.previous_output.vout,
            );
            self.unspent.remove(&key);
            self.spent.insert(key);
        }
        let txid = tx.txid().to_string();
        for (vout, out) in tx.output.iter().enumerate() {
            let Ok(vout) = u32::try_from(vout) else { break };
            let key = (txid.clone(), vout);
            if out.script_pubkey == self.script && !self.spent.contains(&key) {
                self.unspent.insert(key, out.value);
            }
        }
    }

    /// The total of the unspent outputs, in duffs.
    pub fn total(&self) -> u64 {
        self.unspent.values().sum()
    }

    /// The unspent outputs.
    pub fn utxos(&self) -> Vec<VerifiedUtxo> {
        self.unspent
            .iter()
            .map(|((txid, vout), duffs)| VerifiedUtxo {
                txid: txid.clone(),
                vout: *vout,
                duffs: *duffs,
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dash_sdk::dpp::dashcore::consensus::encode::serialize;
    use dash_sdk::dpp::dashcore::{OutPoint, TxIn, TxOut, Txid};

    const ADDR: &str = "yhJHMkBAT2TF6D8GHc4v9bMfBh3V2Z6meg";
    const OTHER: &str = "ybofywdfsqiZJZ2dFPnsLKq41XTiu5KbiM";

    fn tx(inputs: &[(Txid, u32)], outputs: &[(&str, u64)]) -> Transaction {
        Transaction {
            version: 3,
            lock_time: 0,
            input: inputs
                .iter()
                .map(|(txid, vout)| TxIn {
                    previous_output: OutPoint::new(*txid, *vout),
                    ..TxIn::default()
                })
                .collect(),
            output: outputs
                .iter()
                .map(|(a, v)| TxOut {
                    value: *v,
                    script_pubkey: p2pkh_script(a).unwrap(),
                })
                .collect(),
            special_transaction_payload: None,
        }
    }

    #[test]
    fn the_tracker_keeps_unspent_outputs_to_the_address_only() {
        let mut t = DepositTracker::new(ADDR).unwrap();
        let pay = tx(&[(Txid::all_zeros(), 0)], &[(OTHER, 5), (ADDR, 2_000_000)]);
        t.ingest(&serialize(&pay));
        assert_eq!(t.total(), 2_000_000);
        let u = t.utxos();
        assert_eq!((u[0].txid.clone(), u[0].vout), (pay.txid().to_string(), 1));

        // A second deposit adds up; spending the first removes it.
        let pay2 = tx(&[(Txid::all_zeros(), 1)], &[(ADDR, 1_000_000)]);
        t.ingest(&serialize(&pay2));
        assert_eq!(t.total(), 3_000_000);
        t.ingest(&serialize(&tx(&[(pay.txid(), 1)], &[(OTHER, 1_999_000)])));
        assert_eq!(t.total(), 1_000_000);

        // Replayed out of order (the spend seen first), the spent output stays spent.
        let mut r = DepositTracker::new(ADDR).unwrap();
        r.ingest(&serialize(&tx(&[(pay.txid(), 1)], &[(OTHER, 1)])));
        r.ingest(&serialize(&pay));
        assert_eq!(r.total(), 0);

        // Garbage (a false positive we cannot decode) is ignored.
        r.ingest(&[1, 2, 3]);
        assert_eq!(r.total(), 0);
    }

    #[test]
    fn the_bloom_filter_matches_the_address_hash() {
        let proto = address_bloom_filter(ADDR).unwrap();
        let filter = BloomFilter::from_bytes(
            proto.v_data.clone(),
            proto.n_hash_funcs,
            proto.n_tweak,
            BloomFlags::All,
        )
        .unwrap();
        let script = p2pkh_script(ADDR).unwrap();
        let hash = script.as_script().p2pkh_public_key_hash_bytes().unwrap();
        assert!(filter.contains(hash));
        assert_eq!(proto.n_flags, BLOOM_UPDATE_ALL);
        assert!(!proto.v_data.is_empty() && proto.v_data.len() <= 36_000);
        assert!(address_bloom_filter("not-an-address").is_err());
    }

    #[test]
    fn the_lock_filter_matches_the_txid_and_outpoints_in_both_byte_orders() {
        let funding = tx(&[(Txid::all_zeros(), 0)], &[(ADDR, 2_000_000)]);
        let lock = tx(&[(funding.txid(), 0), (funding.txid(), 7)], &[(OTHER, 1)]);
        let proto = lock_bloom_filter(&lock).unwrap();
        assert!(
            proto.v_data.len() >= 200,
            "{} bytes saturate on DAPI nodes",
            proto.v_data.len()
        );
        assert_eq!(proto.n_flags, 0);
        let filter = BloomFilter::from_bytes(
            proto.v_data.clone(),
            proto.n_hash_funcs,
            proto.n_tweak,
            BloomFlags::None,
        )
        .unwrap();
        // The txid as Core keeps it (rs-dapi) and as it is displayed (the JS DAPI).
        let wire = lock.txid().to_byte_array();
        assert!(filter.contains(&wire));
        assert!(filter.contains(&hex::decode(lock.txid().to_string()).unwrap()));
        for vout in [0u32, 7] {
            let le = vout.to_le_bytes();
            let wire_outpoint = [funding.txid().to_byte_array().as_slice(), &le].concat();
            assert_eq!(
                wire_outpoint,
                serialize(&OutPoint::new(funding.txid(), vout))
            );
            let display_outpoint = [
                hex::decode(funding.txid().to_string()).unwrap().as_slice(),
                &le,
            ]
            .concat();
            assert!(filter.contains(&wire_outpoint));
            assert!(filter.contains(&display_outpoint));
        }
        // Not the funding transaction itself, nor an outpoint the lock does not spend.
        assert!(!filter.contains(&funding.txid().to_byte_array()));
        assert!(!filter.contains(
            &[
                funding.txid().to_byte_array().as_slice(),
                &1u32.to_le_bytes()
            ]
            .concat()
        ));
    }
}
