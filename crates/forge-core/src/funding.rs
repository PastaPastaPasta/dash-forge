//! The Core-chain side of funding an identity: a block explorer (Insight API) to watch a
//! deposit address and read raw transactions, and the `getislocks` JSON-RPC that recovers an
//! InstantSend lock by txid.
//!
//! The explorer is not trusted with amounts or keys: every output it lists is re-derived from
//! its raw funding transaction by the caller (`platform::identity::verify_deposit`), and it
//! never sees a private key. It can delay the user or hide funds, not take them. Broadcast goes
//! to DAPI first; the explorer is only the fallback.

use std::time::Duration;

use serde::Deserialize;

use crate::error::{Error, Result};
use crate::network::Network;

/// Where an identity's deposit is watched and its asset lock proven, per network.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoreEndpoints {
    /// Insight API base URL (`…/insight-api`).
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
