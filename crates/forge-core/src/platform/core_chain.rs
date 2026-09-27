//! DAPI Core for funding: [`CoreChain`] on [`PlatformClient`] (broadcast, transaction status,
//! chain tip, and a bloom-filtered address feed), plus [`DepositTracker`], which turns that
//! feed into the verified unspent outputs of a deposit address.
//!
//! All of it runs over the SDK's DAPI client against the same evonodes Platform reads use,
//! so creating an identity depends on no block explorer.

use std::collections::BTreeMap;
use std::str::FromStr;

use async_trait::async_trait;
use dapi_grpc::core::v0::{
    transactions_with_proofs_request::FromBlock, transactions_with_proofs_response::Responses,
    BloomFilter as ProtoBloomFilter, GetBlockchainStatusRequest, GetTransactionRequest,
    TransactionsWithProofsRequest, TransactionsWithProofsResponse,
};
use dapi_grpc::tonic::{Code, Streaming};
use dash_sdk::dapi_client::transport::TransportError;
use dash_sdk::dapi_client::{DapiClientError, DapiRequestExecutor, IntoInner, RequestSettings};
use dash_sdk::dpp::dashcore::bloom::{BloomFilter, BloomFlags};
use dash_sdk::dpp::dashcore::consensus::encode::deserialize;
use dash_sdk::dpp::dashcore::{Address, ScriptBuf, Transaction};

use super::identity::VerifiedUtxo;
use super::PlatformClient;
use crate::error::{Error, Result};
use crate::funding::{CoreChain, CoreTxFeed, CoreTxStatus};

/// The bloom filter's false-positive rate. A false positive only costs bandwidth: every
/// delivered transaction is checked against the address's script.
const BLOOM_FP_RATE: f64 = 0.0001;
/// BIP37 `nFlags`: add every matched output to the filter.
const BLOOM_UPDATE_ALL: u32 = 1;

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
    let mut filter = BloomFilter::new(1, BLOOM_FP_RATE, rand::random(), BloomFlags::All)
        .map_err(|e| Error::Config(format!("bloom filter: {e}")))?;
    filter.insert(&hash);
    Ok(ProtoBloomFilter {
        v_data: filter.to_bytes(),
        n_hash_funcs: filter.hash_funcs(),
        n_tweak: filter.tweak(),
        n_flags: BLOOM_UPDATE_ALL,
    })
}

struct DapiFeed(Streaming<TransactionsWithProofsResponse>);

#[async_trait]
impl CoreTxFeed for DapiFeed {
    async fn next_transactions(&mut self) -> Result<Option<Vec<Vec<u8>>>> {
        loop {
            let msg = self
                .0
                .message()
                .await
                .map_err(|e| dapi_err("reading the transaction feed", e))?;
            let Some(TransactionsWithProofsResponse { responses }) = msg else {
                return Ok(None);
            };
            // Merkle blocks and InstantSend locks carry no outputs; the raw transactions do.
            if let Some(Responses::RawTransactions(raw)) = responses {
                return Ok(Some(raw.transactions));
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
        Ok(Box::new(DapiFeed(stream)))
    }
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
    use dash_sdk::dpp::dashcore::hashes::Hash as _;
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
}
