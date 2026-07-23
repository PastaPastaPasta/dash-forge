//! [`HttpsBackend`] — read-only HTTP(S) static-host adapter.
//!
//! The simplest backend and the reference for the ranged-read path every other adapter
//! shares: a plain `GET`, or a `GET` carrying an HTTP `Range` header that MUST come back
//! as `206 Partial Content` (spike S0.5 confirmed IPFS gateways, MinIO and nginx all
//! honor Range → 206). Any static host or mirror works; writes are unsupported (a
//! read-only mirror), so [`HttpsBackend::put`] errors.

use std::time::Instant;

use reqwest::{Client, StatusCode};

use super::{ByteRange, Caps, Health, PackBackend, PackMeta, Uri};
use crate::error::{Error, Result};

/// A read-only HTTP(S) backend over an arbitrary static host.
#[derive(Debug, Clone)]
pub struct HttpsBackend {
    client: Client,
}

impl Default for HttpsBackend {
    fn default() -> Self {
        Self::new()
    }
}

impl HttpsBackend {
    /// Build a backend with a fresh HTTP client.
    pub fn new() -> Self {
        Self {
            client: Client::new(),
        }
    }

    /// Build a backend over an existing client (share a connection pool).
    pub fn with_client(client: Client) -> Self {
        Self { client }
    }
}

/// Map a transport-level reqwest error onto the crate error taxonomy (there is no
/// dedicated network variant; a failed request is an I/O failure).
pub(super) fn transport_err(context: &str, e: &reqwest::Error) -> Error {
    Error::Io(format!("{context}: {e}"))
}

#[async_trait::async_trait]
impl PackBackend for HttpsBackend {
    fn scheme(&self) -> &'static str {
        "https"
    }

    fn caps(&self) -> Caps {
        // Read-only; browser reads depend on the host's CORS headers (reported by
        // `dg storage status`), so advertise both read consumers.
        Caps {
            read_cli: true,
            read_browser: true,
            write_cli: false,
            write_browser: false,
        }
    }

    async fn put(&self, _bytes: &[u8], _meta: &PackMeta) -> Result<Vec<Uri>> {
        Err(Error::Config(
            "the https backend is read-only; use s3/ipfs/platform to write".into(),
        ))
    }

    async fn get(&self, uri: &Uri, range: Option<ByteRange>) -> Result<Vec<u8>> {
        http_get(&self.client, &uri.0, range).await
    }

    async fn probe(&self, uri: &Uri) -> Result<Health> {
        http_probe(&self.client, &uri.0).await
    }
}

/// Shared GET (with optional Range) used by the https and s3 adapters — both read plain
/// HTTP URLs. A ranged request asserts `206`; a full request accepts `200`/`206`.
pub(super) async fn http_get(
    client: &Client,
    url: &str,
    range: Option<ByteRange>,
) -> Result<Vec<u8>> {
    let mut req = client.get(url);
    if let Some(r) = range {
        req = req.header(reqwest::header::RANGE, r.http_header_value());
    }
    let resp = req
        .send()
        .await
        .map_err(|e| transport_err("GET request failed", &e))?;

    let status = resp.status();
    if status == StatusCode::NOT_FOUND {
        return Err(Error::NotFound);
    }
    if range.is_some() {
        // A ranged read MUST be served as 206 — a 200 means the host ignored Range and
        // returned the whole object, which would corrupt a partial-clone/browse read.
        if status != StatusCode::PARTIAL_CONTENT {
            return Err(Error::Io(format!(
                "ranged GET {url} expected 206 Partial Content, got {status}"
            )));
        }
    } else if !status.is_success() {
        return Err(Error::Io(format!("GET {url} failed with status {status}")));
    }

    let bytes = resp
        .bytes()
        .await
        .map_err(|e| transport_err("reading response body", &e))?;
    Ok(bytes.to_vec())
}

/// Shared HEAD probe used by the https and s3 adapters.
pub(super) async fn http_probe(client: &Client, url: &str) -> Result<Health> {
    let started = Instant::now();
    let resp = client.head(url).send().await;
    let latency = started.elapsed();

    match resp {
        Ok(r) if r.status().is_success() => {
            let size = r
                .headers()
                .get(reqwest::header::CONTENT_LENGTH)
                .and_then(|v| v.to_str().ok())
                .and_then(|s| s.parse::<u64>().ok());
            Ok(Health {
                ok: true,
                size,
                latency,
            })
        }
        Ok(_) | Err(_) => Ok(Health::down(latency)),
    }
}
