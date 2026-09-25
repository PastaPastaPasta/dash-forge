//! [`IpfsBackend`] — content-addressed storage over a kubo (IPFS) node, optionally
//! replicated to a remote IPFS Pinning Service API endpoint.
//!
//! - **Write**: multipart `POST` to the kubo RPC API `/api/v0/add` with the import
//!   parameters pinned (`cid-version=1`, `raw-leaves=true`, `chunker=size-262144`,
//!   `hash=sha2-256`, balanced layout with 174 links per node, pinned). The CID kubo returns must equal the CID this crate derives
//!   locally from the same bytes ([`super::cid`]) — a second, independent integrity check
//!   next to the manifest SHA-256 (PRD 04 §2) — and `pin/ls` must then show it pinned.
//!   URI form `ipfs://<CID>`.
//! - **Remote pin** (optional): after the local add, the CID is pinned through an
//!   [IPFS Pinning Service API](https://ipfs.github.io/pinning-services-api-spec/)
//!   endpoint, with the kubo node's addresses as `origins`, and the write only counts once
//!   the service reports `pinned`. An existing pin for the CID is reused (idempotent).
//! - **Read**: gateway `GET …/ipfs/<CID>` with HTTP Range, reusing the shared HTTP get.
//!   Pack readers do not come through here; they race a configurable gateway list
//!   ([`crate::storage::PackReader`]).
//! - **Probe**: gateway `HEAD …/ipfs/<CID>`.

use std::time::Duration;

use reqwest::{multipart, Client, RequestBuilder, StatusCode};
use serde::Deserialize;

use super::https::{http_get, http_get_capped, http_probe, transport_err, truncate_chars};
use super::{ByteRange, Caps, Health, PackBackend, PackMeta, Uri};
use crate::error::{Error, Result};
use crate::keystore::Secret;

/// The IPFS scheme label.
pub const IPFS_SCHEME: &str = "ipfs";

/// The kubo `add` query that pins every import parameter the local CID derivation assumes.
const ADD_PARAMS: &str = "cid-version=1&raw-leaves=true&chunker=size-262144&hash=sha2-256\
     &trickle=false&max-file-links=174&pin=true&quieter=true";

/// How long to wait for a remote pinning service to report `pinned` by default.
pub const DEFAULT_PIN_TIMEOUT: Duration = Duration::from_secs(120);

/// A remote IPFS Pinning Service API endpoint.
#[derive(Debug, Clone)]
pub struct PinningServiceConfig {
    /// The API base URL, no trailing slash (e.g. `https://api.pinata.cloud/psa`).
    pub endpoint: String,
    /// The bearer access token.
    pub token: Secret,
    /// How long to wait for `pinned` before counting the replica as failed.
    pub timeout: Duration,
    /// Poll interval while the pin is `queued`/`pinning`.
    pub poll_interval: Duration,
}

/// Configuration for an [`IpfsBackend`]: the kubo RPC API, a read gateway, and an optional
/// remote pinning service.
#[derive(Debug, Clone)]
pub struct IpfsConfig {
    /// The kubo RPC API origin, no trailing slash (e.g. `http://127.0.0.1:5001`).
    /// `None` disables writes (read-only via gateway).
    pub api: Option<String>,
    /// A full `Authorization` header value for a kubo RPC API behind auth
    /// (kubo `API.Authorizations`, or a reverse proxy).
    pub api_auth: Option<Secret>,
    /// The gateway origin, no trailing slash (e.g. `http://127.0.0.1:8081`).
    pub gateway: String,
    /// Remote pinning after the local add.
    pub pinning: Option<PinningServiceConfig>,
}

impl IpfsConfig {
    /// A read+write config against a local kubo node's API + gateway.
    pub fn local(api: impl Into<String>, gateway: impl Into<String>) -> Self {
        Self {
            api: Some(api.into().trim_end_matches('/').to_string()),
            api_auth: None,
            gateway: gateway.into().trim_end_matches('/').to_string(),
            pinning: None,
        }
    }

    /// A read-only config against a gateway only (no write API).
    pub fn gateway_only(gateway: impl Into<String>) -> Self {
        Self {
            api: None,
            api_auth: None,
            gateway: gateway.into().trim_end_matches('/').to_string(),
            pinning: None,
        }
    }
}

/// A kubo-backed IPFS backend.
#[derive(Debug, Clone)]
pub struct IpfsBackend {
    config: IpfsConfig,
    client: Client,
}

/// A Pinning Service API `PinStatus`.
#[derive(Debug, Clone, Deserialize)]
pub struct PinStatus {
    /// The service's id for this pin request.
    pub requestid: String,
    /// `queued | pinning | pinned | failed`.
    pub status: String,
}

#[derive(Debug, Deserialize)]
struct PinResults {
    #[serde(default)]
    results: Vec<PinStatus>,
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

    /// The backend's config.
    pub fn config(&self) -> &IpfsConfig {
        &self.config
    }

    /// The gateway URL for a CID (`<gateway>/ipfs/<cid>`).
    fn gateway_url(&self, cid: &str) -> String {
        format!("{}/ipfs/{}", self.config.gateway, cid)
    }

    /// The CID out of an `ipfs://<CID>` URI (or a bare CID), erroring on a foreign scheme.
    pub fn cid_of(uri: &Uri) -> Result<String> {
        let cid = match uri.scheme() {
            Some(IPFS_SCHEME) => uri.rest().unwrap_or_default().to_string(),
            None => uri.0.clone(),
            other => {
                return Err(Error::Config(format!(
                    "ipfs backend cannot serve uri scheme {other:?}: {uri}"
                )))
            }
        };
        // A CID is base-encoded: letters and digits only. Anything else (a `/`, `?`, `#`)
        // would let a hostile manifest steer the gateway request somewhere else.
        if cid.is_empty() || !cid.bytes().all(|b| b.is_ascii_alphanumeric()) {
            return Err(Error::Config(format!("not a CID: {cid:?}")));
        }
        Ok(cid)
    }

    /// The URL to read `uri` from: `ipfs://<cid>` through this backend's gateway; an
    /// already-http(s) gateway URL (as recorded for a public gateway) verbatim.
    fn read_url(&self, uri: &Uri) -> Result<String> {
        match uri.scheme() {
            Some("http" | "https") => Ok(uri.0.clone()),
            _ => Ok(self.gateway_url(&Self::cid_of(uri)?)),
        }
    }

    fn api(&self) -> Result<&str> {
        self.config.api.as_deref().ok_or_else(|| {
            Error::Config("this ipfs backend is gateway-only (no write API configured)".into())
        })
    }

    /// A `POST` to the kubo RPC API (every RPC is a POST), with auth when configured.
    fn rpc(&self, path_and_query: &str) -> Result<RequestBuilder> {
        let mut req = self
            .client
            .post(format!("{}/api/v0/{path_and_query}", self.api()?));
        if let Some(auth) = &self.config.api_auth {
            req = req.header(reqwest::header::AUTHORIZATION, auth.expose());
        }
        Ok(req)
    }

    async fn rpc_text(&self, what: &str, req: RequestBuilder) -> Result<String> {
        let resp = req
            .send()
            .await
            .map_err(|e| transport_err(&format!("kubo {what} failed"), &e))?;
        let status = resp.status();
        let body = resp
            .text()
            .await
            .map_err(|e| transport_err(&format!("reading kubo {what} response"), &e))?;
        if !status.is_success() {
            let hint = if status == StatusCode::FORBIDDEN || status == StatusCode::UNAUTHORIZED {
                " (the RPC API needs an Authorization header — set api_auth in the profile)"
            } else {
                ""
            };
            return Err(Error::Io(format!(
                "kubo {what} failed with status {status}{hint}: {}",
                body.trim()
            )));
        }
        Ok(body)
    }

    /// `ipfs version` — used by `dg storage test` to confirm the API answers.
    pub async fn version(&self) -> Result<String> {
        let body = self.rpc_text("version", self.rpc("version")?).await?;
        let v: serde_json::Value = serde_json::from_str(&body)?;
        Ok(v.get("Version")
            .and_then(|s| s.as_str())
            .unwrap_or("unknown")
            .to_string())
    }

    /// Add `bytes` with the pinned import parameters, returning kubo's CID.
    pub async fn add(&self, bytes: &[u8]) -> Result<String> {
        let part = multipart::Part::bytes(bytes.to_vec()).file_name("pack");
        let form = multipart::Form::new().part("file", part);
        let body = self
            .rpc_text(
                "add",
                self.rpc(&format!("add?{ADD_PARAMS}"))?.multipart(form),
            )
            .await?;
        parse_add_cid(&body)
    }

    /// Whether `cid` is pinned (recursively) on the kubo node.
    pub async fn is_pinned(&self, cid: &str) -> Result<bool> {
        let req = self.rpc(&format!("pin/ls?arg={cid}&type=recursive"))?;
        match self.rpc_text("pin/ls", req).await {
            Ok(body) => Ok(body.contains(cid)),
            // kubo answers 500 "not pinned" for an unpinned CID.
            Err(Error::Io(msg)) if msg.contains("not pinned") => Ok(false),
            Err(e) => Err(e),
        }
    }

    /// Unpin `cid` (used by `dg storage test` to clean up its probe).
    pub async fn unpin(&self, cid: &str) -> Result<()> {
        let req = self.rpc(&format!("pin/rm?arg={cid}"))?;
        match self.rpc_text("pin/rm", req).await {
            Ok(_) => Ok(()),
            Err(Error::Io(msg)) if msg.contains("not pinned") => Ok(()),
            Err(e) => Err(e),
        }
    }

    /// The node's announced multiaddrs (`/api/v0/id`), passed to a pinning service as
    /// `origins` so it can fetch the content directly.
    pub async fn origins(&self) -> Result<Vec<String>> {
        let body = self.rpc_text("id", self.rpc("id")?).await?;
        let v: serde_json::Value = serde_json::from_str(&body)?;
        Ok(v.get("Addresses")
            .and_then(|a| a.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|s| s.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default())
    }

    /// Add + verify: kubo's CID must equal the locally derived one, and it must be pinned.
    async fn add_verified(&self, bytes: &[u8]) -> Result<String> {
        let expected = super::cid::cid_v1_raw_leaves(bytes);
        let cid = self.add(bytes).await?;
        if cid != expected {
            return Err(Error::Io(format!(
                "kubo returned CID {cid} but these bytes derive to {expected} under the \
                 pinned import parameters — the node altered the import (an old kubo, or a \
                 proxy rewriting the request); refusing to record it"
            )));
        }
        if !self.is_pinned(&cid).await? {
            return Err(Error::Io(format!(
                "kubo added {cid} but does not report it pinned; a gc would drop it"
            )));
        }
        Ok(cid)
    }

    /// Pin `cid` on the configured remote pinning service and wait for `pinned`.
    pub async fn remote_pin(&self, cid: &str, name: &str) -> Result<PinStatus> {
        let psa = self.config.pinning.as_ref().ok_or_else(|| {
            Error::Config("no pinning service configured on this ipfs backend".into())
        })?;
        let client = PinningClient::new(&self.client, psa);
        // Reuse an existing request for this CID (a re-push) rather than paying twice.
        let existing = client.find(cid).await?;
        if let Some(done) = existing.iter().find(|p| p.status == "pinned") {
            return Ok(done.clone());
        }
        let pending = if let Some(p) = existing
            .into_iter()
            .find(|p| matches!(p.status.as_str(), "queued" | "pinning"))
        {
            p
        } else {
            let origins = self.origins().await.unwrap_or_default();
            client.add(cid, name, &origins).await?
        };
        client.wait_pinned(pending).await
    }
}

/// A minimal IPFS Pinning Service API client (the subset a push needs).
pub struct PinningClient<'a> {
    http: &'a Client,
    cfg: &'a PinningServiceConfig,
}

impl<'a> PinningClient<'a> {
    /// Bind to `cfg` over `http`.
    pub fn new(http: &'a Client, cfg: &'a PinningServiceConfig) -> Self {
        Self { http, cfg }
    }

    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.cfg.endpoint.trim_end_matches('/'))
    }

    fn auth(&self, req: RequestBuilder) -> RequestBuilder {
        req.bearer_auth(self.cfg.token.expose())
    }

    async fn json<T: for<'de> Deserialize<'de>>(
        &self,
        what: &str,
        req: RequestBuilder,
    ) -> Result<T> {
        let resp = self
            .auth(req)
            .send()
            .await
            .map_err(|e| transport_err(&format!("pinning service {what} failed"), &e))?;
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        if !status.is_success() {
            let hint = if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
                " (check the access token)"
            } else {
                ""
            };
            let body = truncate_chars(body, 400);
            return Err(Error::Io(format!(
                "pinning service {what} failed with status {status}{hint}: {body}"
            )));
        }
        serde_json::from_str(&body).map_err(Error::from)
    }

    /// `GET /pins?cid=<cid>&status=queued,pinning,pinned`.
    pub async fn find(&self, cid: &str) -> Result<Vec<PinStatus>> {
        let req = self
            .http
            .get(self.url("/pins"))
            .query(&[("cid", cid), ("status", "queued,pinning,pinned")]);
        Ok(self.json::<PinResults>("list", req).await?.results)
    }

    /// `GET /pins?limit=1` — an authenticated no-op, for `dg storage test`.
    pub async fn check_auth(&self) -> Result<()> {
        let req = self.http.get(self.url("/pins")).query(&[("limit", "1")]);
        self.json::<PinResults>("list", req).await.map(|_| ())
    }

    /// `POST /pins`.
    pub async fn add(&self, cid: &str, name: &str, origins: &[String]) -> Result<PinStatus> {
        let body = serde_json::json!({ "cid": cid, "name": name, "origins": origins });
        let req = self.http.post(self.url("/pins")).json(&body);
        self.json("add", req).await
    }

    /// `GET /pins/<requestid>`.
    pub async fn status(&self, requestid: &str) -> Result<PinStatus> {
        if !requestid
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
        {
            return Err(Error::Io(format!(
                "pinning service returned a malformed requestid {requestid:?}"
            )));
        }
        let req = self.http.get(self.url(&format!("/pins/{requestid}")));
        self.json("status", req).await
    }

    /// Poll until `pinned` (success), `failed`, or the timeout.
    pub async fn wait_pinned(&self, mut pin: PinStatus) -> Result<PinStatus> {
        let deadline = std::time::Instant::now() + self.cfg.timeout;
        loop {
            match pin.status.as_str() {
                "pinned" => return Ok(pin),
                "failed" => {
                    return Err(Error::Io(format!(
                        "pinning service reports request {} failed",
                        pin.requestid
                    )))
                }
                _ => {}
            }
            if std::time::Instant::now() >= deadline {
                return Err(Error::Io(format!(
                    "pinning service request {} still {} after {}s — the service may not be \
                     able to reach your kubo node; make it publicly dialable or raise \
                     pin_timeout_secs",
                    pin.requestid,
                    pin.status,
                    self.cfg.timeout.as_secs()
                )));
            }
            tokio::time::sleep(self.cfg.poll_interval).await;
            pin = self.status(&pin.requestid).await?;
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

    /// Add + verify the CID + confirm the local pin, then (when configured) pin remotely
    /// and wait for `pinned`. Idempotent: re-adding identical bytes yields the same CID.
    async fn put(&self, bytes: &[u8], meta: &PackMeta) -> Result<Vec<Uri>> {
        let cid = self.add_verified(bytes).await?;
        if self.config.pinning.is_some() {
            let name = format!(
                "dash-forge {}",
                &meta.pack_hash[..meta.pack_hash.len().min(16)]
            );
            self.remote_pin(&cid, &name).await?;
        }
        Ok(vec![Uri(format!("{IPFS_SCHEME}://{cid}"))])
    }

    async fn get(&self, uri: &Uri, range: Option<ByteRange>) -> Result<Vec<u8>> {
        http_get(&self.client, &self.read_url(uri)?, range).await
    }

    async fn get_capped(&self, uri: &Uri, max_bytes: u64) -> Result<Vec<u8>> {
        http_get_capped(&self.client, &self.read_url(uri)?, None, Some(max_bytes)).await
    }

    async fn probe(&self, uri: &Uri) -> Result<Health> {
        http_probe(&self.client, &self.read_url(uri)?).await
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
    use super::*;

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

    #[test]
    fn pinning_error_bodies_truncate_on_a_char_boundary() {
        // A multi-byte character straddling byte 400 must not panic.
        let body = format!("{}é{}", "a".repeat(399), "b".repeat(50));
        let cut = truncate_chars(body, 400);
        assert!(cut.ends_with('…'));
        assert!(cut.len() <= 400 + '…'.len_utf8());
    }

    #[test]
    fn cid_of_rejects_path_injection() {
        assert!(IpfsBackend::cid_of(&Uri("ipfs://bafyok".into())).is_ok());
        assert!(IpfsBackend::cid_of(&Uri("ipfs://bafy/../../api".into())).is_err());
        assert!(IpfsBackend::cid_of(&Uri("ipfs://bafy?x=1".into())).is_err());
        assert!(IpfsBackend::cid_of(&Uri("ipfs://".into())).is_err());
        assert!(IpfsBackend::cid_of(&Uri("https://x/y".into())).is_err());
    }

    /// A one-shot scripted HTTP server: answers each accepted connection with the next
    /// canned `(status, body)` and records the request lines it saw.
    fn scripted_server(
        replies: Vec<(u16, String)>,
    ) -> (String, std::sync::Arc<std::sync::Mutex<Vec<String>>>) {
        use std::io::{BufRead as _, BufReader, Read as _, Write as _};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let seen2 = seen.clone();
        std::thread::spawn(move || {
            for (status, body) in replies {
                let Ok((stream, _)) = listener.accept() else {
                    return;
                };
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut request_line = String::new();
                reader.read_line(&mut request_line).unwrap();
                let mut content_length = 0usize;
                let mut auth = String::new();
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    if line == "\r\n" || line.is_empty() {
                        break;
                    }
                    let lower = line.to_ascii_lowercase();
                    if let Some(v) = lower.strip_prefix("content-length:") {
                        content_length = v.trim().parse().unwrap_or(0);
                    }
                    if lower.starts_with("authorization:") {
                        auth = line.trim().to_string();
                    }
                }
                let mut body_in = vec![0u8; content_length];
                reader.read_exact(&mut body_in).unwrap();
                seen2.lock().unwrap().push(format!(
                    "{} | {auth} | {}",
                    request_line.trim(),
                    String::from_utf8_lossy(&body_in)
                ));
                let mut stream = stream;
                write!(
                    stream,
                    "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                )
                .unwrap();
            }
        });
        (format!("http://{addr}"), seen)
    }

    fn psa(endpoint: String) -> PinningServiceConfig {
        PinningServiceConfig {
            endpoint,
            token: Secret::new("tok-123"),
            timeout: Duration::from_secs(5),
            poll_interval: Duration::from_millis(10),
        }
    }

    #[tokio::test]
    async fn pinning_service_add_then_poll_until_pinned() {
        let (base, seen) = scripted_server(vec![
            (200, r#"{"count":0,"results":[]}"#.into()),
            (202, r#"{"requestid":"r1","status":"queued"}"#.into()),
            (200, r#"{"requestid":"r1","status":"pinning"}"#.into()),
            (200, r#"{"requestid":"r1","status":"pinned"}"#.into()),
        ]);
        let http = Client::new();
        let cfg = psa(base);
        let c = PinningClient::new(&http, &cfg);
        assert!(c.find("bafyX").await.unwrap().is_empty());
        let added = c
            .add("bafyX", "n", &["/ip4/1.2.3.4/tcp/4001".into()])
            .await
            .unwrap();
        let done = c.wait_pinned(added).await.unwrap();
        assert_eq!(done.status, "pinned");
        let seen = seen.lock().unwrap();
        assert!(seen[0].starts_with("GET /pins?cid=bafyX&status=queued%2Cpinning%2Cpinned"));
        assert!(seen[0].contains("Bearer tok-123"));
        assert!(seen[1].starts_with("POST /pins"));
        assert!(seen[1].contains(r#""cid":"bafyX""#));
        assert!(seen[1].contains("/ip4/1.2.3.4/tcp/4001"));
        assert!(seen[2].starts_with("GET /pins/r1"));
    }

    #[tokio::test]
    async fn pinning_service_failure_and_auth_errors_surface() {
        let (base, _) = scripted_server(vec![
            (200, r#"{"requestid":"r2","status":"failed"}"#.into()),
            (401, r#"{"error":{"reason":"UNAUTHORIZED"}}"#.into()),
        ]);
        let http = Client::new();
        let cfg = psa(base);
        let c = PinningClient::new(&http, &cfg);
        let pending = PinStatus {
            requestid: "r2".into(),
            status: "queued".into(),
        };
        let err = c.wait_pinned(pending).await.unwrap_err().to_string();
        assert!(err.contains("failed"), "{err}");
        let err = c.check_auth().await.unwrap_err().to_string();
        assert!(err.contains("check the access token"), "{err}");
        assert!(!err.contains("tok-123"));
    }

    #[tokio::test]
    async fn pinning_service_times_out_while_queued() {
        let (base, _) = scripted_server(
            (0..50)
                .map(|_| (200, r#"{"requestid":"r3","status":"queued"}"#.to_string()))
                .collect(),
        );
        let http = Client::new();
        let mut cfg = psa(base);
        cfg.timeout = Duration::from_millis(50);
        let c = PinningClient::new(&http, &cfg);
        let pending = PinStatus {
            requestid: "r3".into(),
            status: "queued".into(),
        };
        let err = c.wait_pinned(pending).await.unwrap_err().to_string();
        assert!(err.contains("still queued"), "{err}");
    }

    #[test]
    fn malformed_requestid_is_refused() {
        let http = Client::new();
        let cfg = psa("http://127.0.0.1:1".into());
        let c = PinningClient::new(&http, &cfg);
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        assert!(rt.block_on(c.status("../../x")).is_err());
    }
}
