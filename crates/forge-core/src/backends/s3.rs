//! [`S3Backend`] — MinIO / S3-compatible object storage.
//!
//! Scope for v1 (per PRD 04's explicit allowance): **authless public-bucket** access.
//! A bucket exposed with a public (readwrite) policy — MinIO's `mc anonymous set public`
//! or an S3 bucket policy granting anonymous `GetObject`/`PutObject` — serves plain
//! HTTP `PUT`/`GET`/`HEAD` with byte-range support, exactly the surface the browse plane
//! needs. The manifest records **both** the canonical `s3://bucket/key` URI and the
//! public `https://…` URL so browsers can read credential-free (PRD 04 §3).
//!
//! Authenticated writes to a *private* bucket need AWS SigV4 request signing; that is a
//! documented follow-up (see [`S3Config::credentials`]). When credentials are supplied,
//! writes error loudly rather than silently sending an unsigned (and rejected) request.

use super::https::{http_get, http_probe, transport_err};
use super::{ByteRange, Caps, Health, PackBackend, PackMeta, Uri};
use crate::error::{Error, Result};
use reqwest::Client;

/// The S3 scheme label used in manifest URIs.
pub const S3_SCHEME: &str = "s3";

/// Static credentials for an authenticated (SigV4) S3 endpoint.
///
/// Present only to shape the API; SigV4 signing is not yet implemented, so supplying
/// credentials makes writes error with a clear message. Public-bucket (anonymous) access
/// leaves this `None`.
#[derive(Debug, Clone)]
pub struct S3Credentials {
    /// Access key id.
    pub access_key: String,
    /// Secret access key.
    pub secret_key: String,
}

/// Configuration for an [`S3Backend`]: which endpoint + bucket to talk to.
#[derive(Debug, Clone)]
pub struct S3Config {
    /// The endpoint origin, no trailing slash (e.g. `http://127.0.0.1:9000` for MinIO,
    /// `https://s3.us-east-1.amazonaws.com` for AWS).
    pub endpoint: String,
    /// The bucket name.
    pub bucket: String,
    /// Optional static credentials. `None` = anonymous/public-bucket access.
    pub credentials: Option<S3Credentials>,
}

impl S3Config {
    /// A public-bucket (anonymous) config for `endpoint` + `bucket`.
    pub fn public(endpoint: impl Into<String>, bucket: impl Into<String>) -> Self {
        Self {
            endpoint: endpoint.into().trim_end_matches('/').to_string(),
            bucket: bucket.into(),
            credentials: None,
        }
    }
}

/// A MinIO / S3-compatible backend over a public bucket.
#[derive(Debug, Clone)]
pub struct S3Backend {
    config: S3Config,
    client: Client,
}

impl S3Backend {
    /// Build a backend from `config` with a fresh HTTP client.
    pub fn new(config: S3Config) -> Self {
        Self {
            config,
            client: Client::new(),
        }
    }

    /// Build a backend over an existing client.
    pub fn with_client(config: S3Config, client: Client) -> Self {
        Self { config, client }
    }

    /// The object key a pack's bytes are stored under (`packs/<packHash>.pack`).
    pub fn pack_key(pack_hash: &str) -> String {
        format!("packs/{pack_hash}.pack")
    }

    /// The public HTTP URL for `key` in this backend's bucket.
    pub fn public_url(&self, key: &str) -> String {
        format!("{}/{}/{}", self.config.endpoint, self.config.bucket, key)
    }

    /// The canonical `s3://bucket/key` URI for `key`.
    fn s3_uri(&self, key: &str) -> String {
        format!("{S3_SCHEME}://{}/{}", self.config.bucket, key)
    }

    /// Resolve a manifest URI to a fetchable HTTP URL: an `s3://bucket/key` maps onto
    /// this backend's endpoint; an already-HTTP URL passes through verbatim.
    fn http_url_for(&self, uri: &Uri) -> Result<String> {
        match uri.scheme() {
            Some(S3_SCHEME) => {
                let rest = uri.rest().unwrap_or_default();
                let (bucket, key) = rest.split_once('/').ok_or_else(|| {
                    Error::Config(format!(
                        "malformed s3 uri (expected s3://bucket/key): {uri}"
                    ))
                })?;
                Ok(format!("{}/{}/{}", self.config.endpoint, bucket, key))
            }
            Some("http" | "https") => Ok(uri.0.clone()),
            other => Err(Error::Config(format!(
                "s3 backend cannot serve uri scheme {other:?}: {uri}"
            ))),
        }
    }
}

#[async_trait::async_trait]
impl PackBackend for S3Backend {
    fn scheme(&self) -> &'static str {
        S3_SCHEME
    }

    fn caps(&self) -> Caps {
        // Public bucket: anonymous read + write from CLI; browser access depends on the
        // bucket's CORS config (writes typically CLI-only).
        Caps {
            read_cli: true,
            read_browser: true,
            write_cli: true,
            write_browser: false,
        }
    }

    async fn put(&self, bytes: &[u8], meta: &PackMeta) -> Result<Vec<Uri>> {
        if self.config.credentials.is_some() {
            return Err(Error::Config(
                "authenticated S3 writes need AWS SigV4 signing (not yet implemented in v1); \
                 use a public bucket (credentials: None) or the platform/ipfs backend"
                    .into(),
            ));
        }

        let key = Self::pack_key(&meta.pack_hash);
        let url = self.public_url(&key);
        let resp = self
            .client
            .put(&url)
            .header(reqwest::header::CONTENT_LENGTH, bytes.len())
            .body(bytes.to_vec())
            .send()
            .await
            .map_err(|e| transport_err("S3 PUT failed", &e))?;

        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(Error::Io(format!(
                "S3 PUT {url} failed with status {status}: {body}"
            )));
        }

        // Record both the canonical s3:// URI and the credential-free public URL.
        Ok(vec![Uri(self.s3_uri(&key)), Uri(url)])
    }

    async fn get(&self, uri: &Uri, range: Option<ByteRange>) -> Result<Vec<u8>> {
        let url = self.http_url_for(uri)?;
        http_get(&self.client, &url, range).await
    }

    async fn probe(&self, uri: &Uri) -> Result<Health> {
        let url = self.http_url_for(uri)?;
        http_probe(&self.client, &url).await
    }
}
