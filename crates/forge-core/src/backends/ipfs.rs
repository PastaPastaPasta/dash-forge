//! [`IpfsBackend`] — content-addressed storage over a kubo (IPFS) node.
//!
//! - **Write**: multipart `POST` to the kubo RPC API `/api/v0/add` (CIDv1 + raw-leaves so
//!   the CID re-derives from the bytes), pinned. URI form `ipfs://<CID>`. The CID is a
//!   *second* integrity check layered on the manifest SHA-256 (PRD 04 §2): a tampered
//!   gateway response fails to re-hash to the requested CID.
//! - **Read**: gateway `GET …/ipfs/<CID>` with HTTP Range (spike S0.5: kubo gateways
//!   honor Range → `206`), reusing the shared HTTP get.
//! - **Probe**: gateway `HEAD …/ipfs/<CID>`.

use super::https::{http_get, http_probe, transport_err};
use super::{ByteRange, Caps, Health, PackBackend, PackMeta, Uri};
use crate::error::{Error, Result};
use reqwest::{multipart, Client};

/// The IPFS scheme label.
pub const IPFS_SCHEME: &str = "ipfs";

/// Configuration for an [`IpfsBackend`]: the kubo RPC API and a read gateway.
#[derive(Debug, Clone)]
pub struct IpfsConfig {
    /// The kubo RPC API origin, no trailing slash (e.g. `http://127.0.0.1:5001`).
    /// `None` disables writes (read-only via gateway).
    pub api: Option<String>,
    /// The gateway origin, no trailing slash (e.g. `http://127.0.0.1:8081`).
    pub gateway: String,
}

impl IpfsConfig {
    /// A read+write config against a local kubo node's API + gateway.
    pub fn local(api: impl Into<String>, gateway: impl Into<String>) -> Self {
        Self {
            api: Some(api.into().trim_end_matches('/').to_string()),
            gateway: gateway.into().trim_end_matches('/').to_string(),
        }
    }

    /// A read-only config against a gateway only (no write API).
    pub fn gateway_only(gateway: impl Into<String>) -> Self {
        Self {
            api: None,
            gateway: gateway.into().trim_end_matches('/').to_string(),
        }
    }
}

/// A kubo-backed IPFS backend.
#[derive(Debug, Clone)]
pub struct IpfsBackend {
    config: IpfsConfig,
    client: Client,
}

impl IpfsBackend {
    /// Build a backend from `config` with a fresh HTTP client.
    pub fn new(config: IpfsConfig) -> Self {
        Self {
            config,
            client: Client::new(),
        }
    }

    /// Build a backend over an existing client.
    pub fn with_client(config: IpfsConfig, client: Client) -> Self {
        Self { config, client }
    }

    /// The gateway URL for a CID (`<gateway>/ipfs/<cid>`).
    fn gateway_url(&self, cid: &str) -> String {
        format!("{}/ipfs/{}", self.config.gateway, cid)
    }

    /// The CID out of an `ipfs://<CID>` URI (or a bare CID), erroring on a foreign scheme.
    fn cid_of(uri: &Uri) -> Result<String> {
        match uri.scheme() {
            Some(IPFS_SCHEME) => Ok(uri.rest().unwrap_or_default().to_string()),
            None => Ok(uri.0.clone()),
            other => Err(Error::Config(format!(
                "ipfs backend cannot serve uri scheme {other:?}: {uri}"
            ))),
        }
    }
}

#[async_trait::async_trait]
impl PackBackend for IpfsBackend {
    fn scheme(&self) -> &'static str {
        IPFS_SCHEME
    }

    fn caps(&self) -> Caps {
        // Read from CLI + browser (gateway race). Writes are CLI-only (a pinning API /
        // local kubo); browsers do not hold pinning credentials.
        Caps {
            read_cli: true,
            read_browser: true,
            write_cli: self.config.api.is_some(),
            write_browser: false,
        }
    }

    async fn put(&self, bytes: &[u8], _meta: &PackMeta) -> Result<Vec<Uri>> {
        let api = self.config.api.as_ref().ok_or_else(|| {
            Error::Config("this ipfs backend is gateway-only (no write API configured)".into())
        })?;

        // CIDv1 + raw-leaves so the CID re-derives deterministically from the bytes, and
        // pin so the content survives a gc.
        let url = format!("{api}/api/v0/add?cid-version=1&raw-leaves=true&pin=true");
        let part = multipart::Part::bytes(bytes.to_vec()).file_name("pack");
        let form = multipart::Form::new().part("file", part);

        let resp = self
            .client
            .post(&url)
            .multipart(form)
            .send()
            .await
            .map_err(|e| transport_err("IPFS add failed", &e))?;

        let status = resp.status();
        let body = resp
            .text()
            .await
            .map_err(|e| transport_err("reading IPFS add response", &e))?;
        if !status.is_success() {
            return Err(Error::Io(format!(
                "IPFS add failed with status {status}: {body}"
            )));
        }

        let cid = parse_add_cid(&body)?;
        Ok(vec![Uri(format!("{IPFS_SCHEME}://{cid}"))])
    }

    async fn get(&self, uri: &Uri, range: Option<ByteRange>) -> Result<Vec<u8>> {
        let cid = Self::cid_of(uri)?;
        http_get(&self.client, &self.gateway_url(&cid), range).await
    }

    async fn probe(&self, uri: &Uri) -> Result<Health> {
        let cid = Self::cid_of(uri)?;
        http_probe(&self.client, &self.gateway_url(&cid)).await
    }
}

/// Extract the CID from a kubo `/api/v0/add` response body.
///
/// kubo streams one JSON object per added path (`{"Name":…,"Hash":<CID>,"Size":…}`); for
/// a single file that is one line. Parse the last non-empty line's `Hash`.
fn parse_add_cid(body: &str) -> Result<String> {
    let line = body
        .lines()
        .rev()
        .find(|l| !l.trim().is_empty())
        .ok_or_else(|| Error::Io("empty IPFS add response".into()))?;
    let value: serde_json::Value = serde_json::from_str(line)?;
    value
        .get("Hash")
        .and_then(|h| h.as_str())
        .map(str::to_string)
        .ok_or_else(|| Error::Io(format!("IPFS add response missing Hash: {line}")))
}

#[cfg(test)]
mod tests {
    use super::parse_add_cid;

    #[test]
    fn parses_single_line_add_response() {
        let body = r#"{"Name":"pack","Hash":"bafkreicg3yzp5qbqniqyhkorlhjyfi77zvd4z5vpr7lzizzq3ldjosm3mq","Size":"46"}"#;
        assert_eq!(
            parse_add_cid(body).unwrap(),
            "bafkreicg3yzp5qbqniqyhkorlhjyfi77zvd4z5vpr7lzizzq3ldjosm3mq"
        );
    }

    #[test]
    fn parses_last_line_of_multi_line_response() {
        let body = "{\"Name\":\"a\",\"Hash\":\"bafyA\",\"Size\":\"1\"}\n{\"Name\":\"pack\",\"Hash\":\"bafyROOT\",\"Size\":\"9\"}\n";
        assert_eq!(parse_add_cid(body).unwrap(), "bafyROOT");
    }

    #[test]
    fn errors_on_missing_hash() {
        assert!(parse_add_cid(r#"{"Name":"x"}"#).is_err());
        assert!(parse_add_cid("").is_err());
    }
}
