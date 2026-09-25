//! [`S3Backend`] — S3-compatible object storage (AWS S3, Cloudflare R2, Backblaze B2,
//! MinIO), with AWS SigV4-signed writes and credential-free public reads.
//!
//! - **Writes** (`PUT`/`DELETE`, and `HEAD`/`GET` against the API endpoint) are signed with
//!   SigV4 ([`super::sigv4`]) when credentials are configured. The body's real SHA-256 is
//!   sent as `x-amz-content-sha256`, so the store itself rejects an upload that was
//!   corrupted in transit. With no credentials the requests go out unsigned — only useful
//!   for a public-write bucket such as the local MinIO fixture.
//! - **Reads** by browsers and other clients go to the profile's `public_url`, the https
//!   origin the bucket is published at (an R2 `r2.dev`/custom domain, a B2 friendly URL,
//!   an S3 website/CloudFront origin, or the MinIO path-style URL). Those GETs are never
//!   signed; the bytes are checked against the manifest SHA-256 outside this adapter.
//! - Objects are content-addressed: a pack lives at `<prefix>packs/<sha256>.pack`, so a
//!   re-push of the same bytes is an idempotent no-op ([`S3Backend::put`] checks with a
//!   `HEAD` first and skips the upload when the object is already there).
//!
//! The manifest records the public URL first (what browsers use) and the canonical
//! `s3://bucket/key` second (what a credentialed CLI can resolve against the API endpoint).

use reqwest::{Client, Method, StatusCode, Url};

use super::https::{http_get, http_probe, transport_err};
use super::sigv4::{self, AmzDate, RequestToSign, SigningKeys, EMPTY_PAYLOAD_SHA256};
use super::{ByteRange, Caps, Health, PackBackend, PackMeta, Uri};
use crate::error::{Error, Result};
use crate::keystore::Secret;

/// The S3 scheme label used in manifest URIs.
pub const S3_SCHEME: &str = "s3";

/// The longest store error body echoed into an error message. S3 error documents can be
/// long (a `SignatureDoesNotMatch` carries the whole canonical request); the first part is
/// the actionable code + message.
const MAX_ERROR_BODY: usize = 600;

/// Static credentials for SigV4 signing. The secret parts are [`Secret`]s, so a `Debug`
/// of this struct (or of an [`S3Config`] holding it) never prints them.
#[derive(Debug, Clone)]
pub struct S3Credentials {
    /// Access key id (not secret; it appears in every signed request's scope).
    pub access_key_id: String,
    /// Secret access key.
    pub secret_access_key: Secret,
    /// STS session token, for temporary credentials.
    pub session_token: Option<Secret>,
}

impl S3Credentials {
    fn signing_keys(&self) -> SigningKeys<'_> {
        SigningKeys {
            access_key_id: &self.access_key_id,
            secret_access_key: self.secret_access_key.expose(),
            session_token: self.session_token.as_ref().map(Secret::expose),
        }
    }
}

/// Configuration for an [`S3Backend`].
#[derive(Debug, Clone)]
pub struct S3Config {
    /// The API endpoint origin, no trailing slash (`https://s3.us-east-1.amazonaws.com`,
    /// `https://<account>.r2.cloudflarestorage.com`, `https://s3.us-west-004.backblazeb2.com`,
    /// `http://127.0.0.1:9000`).
    pub endpoint: String,
    /// The SigV4 region (`us-east-1`; R2 uses `auto`; B2 uses the region in its endpoint).
    pub region: String,
    /// The bucket name.
    pub bucket: String,
    /// Path-style addressing (`endpoint/bucket/key`) instead of virtual-hosted
    /// (`bucket.endpoint/key`). R2 and MinIO want path-style; AWS prefers virtual-hosted.
    pub path_style: bool,
    /// The public, credential-free read origin objects are served from, no trailing slash;
    /// a key is read at `<public_url>/<key>`. `None` means the bucket is private and the
    /// manifest records only the `s3://` URI.
    pub public_url: Option<String>,
    /// An optional key prefix (`forge/`), so one bucket can hold other data too.
    pub prefix: String,
    /// Signing credentials. `None` sends unsigned requests (public-write buckets only).
    pub credentials: Option<S3Credentials>,
}

impl S3Config {
    /// A public-bucket (anonymous, path-style) config for `endpoint` + `bucket`, readable at
    /// the path-style URL. This is the local MinIO fixture's shape.
    pub fn public(endpoint: impl Into<String>, bucket: impl Into<String>) -> Self {
        let endpoint = endpoint.into().trim_end_matches('/').to_string();
        let bucket = bucket.into();
        Self {
            public_url: Some(format!("{endpoint}/{bucket}")),
            endpoint,
            region: "us-east-1".into(),
            bucket,
            path_style: true,
            prefix: String::new(),
            credentials: None,
        }
    }

    /// Validate the config: a parseable endpoint, a sane bucket, and a prefix with no
    /// empty, `.` or `..` segments (an HTTP stack would normalize those AFTER signing and
    /// break the signature, or point the key somewhere else entirely).
    pub fn validate(&self) -> Result<()> {
        let url = Url::parse(&self.endpoint).map_err(|e| {
            Error::Config(format!("s3 endpoint {:?} is not a URL: {e}", self.endpoint))
        })?;
        if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
            return Err(Error::Config(format!(
                "s3 endpoint {:?} must be an http(s) origin",
                self.endpoint
            )));
        }
        if url.path() != "/" && !url.path().is_empty() {
            return Err(Error::Config(format!(
                "s3 endpoint {:?} must be an origin with no path; put the bucket in `bucket`",
                self.endpoint
            )));
        }
        let bucket_ok = !self.bucket.is_empty()
            && self.bucket.bytes().all(|b| {
                b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'-' | b'.' | b'_')
            });
        if !bucket_ok {
            return Err(Error::Config(format!(
                "s3 bucket name {:?} must be lowercase letters, digits, '-', '.', '_'",
                self.bucket
            )));
        }
        if !self.path_style && self.bucket.contains('.') && url.scheme() == "https" {
            return Err(Error::Config(format!(
                "bucket {:?} contains '.', which breaks TLS for virtual-hosted addressing; \
                 set path_style = true",
                self.bucket
            )));
        }
        if !self.prefix.is_empty() {
            let trimmed = self.prefix.trim_end_matches('/');
            if trimmed
                .split('/')
                .any(|s| s.is_empty() || s == "." || s == "..")
            {
                return Err(Error::Config(format!(
                    "s3 prefix {:?} has an empty, '.' or '..' segment",
                    self.prefix
                )));
            }
        }
        if let Some(public) = &self.public_url {
            let u = Url::parse(public)
                .map_err(|e| Error::Config(format!("public_url {public:?} is not a URL: {e}")))?;
            if !matches!(u.scheme(), "http" | "https") {
                return Err(Error::Config(format!(
                    "public_url {public:?} must be http(s)"
                )));
            }
        }
        Ok(())
    }

    /// The normalized prefix: empty, or ending in exactly one `/`.
    fn prefix_norm(&self) -> String {
        let p = self.prefix.trim_matches('/');
        if p.is_empty() {
            String::new()
        } else {
            format!("{p}/")
        }
    }
}

/// An S3-compatible backend.
#[derive(Debug, Clone)]
pub struct S3Backend {
    config: S3Config,
    client: Client,
}

/// A signed (or anonymous) request ready to send: the URL plus the headers to add.
struct Prepared {
    url: Url,
    headers: Vec<(String, String)>,
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

    /// The backend's config.
    pub fn config(&self) -> &S3Config {
        &self.config
    }

    /// The content-addressed object key a pack/artifact is stored under
    /// (`packs/<sha256>.pack`), without the profile prefix.
    pub fn pack_key(pack_hash: &str) -> String {
        format!("packs/{pack_hash}.pack")
    }

    /// The full object key (profile prefix + `rel`).
    pub fn object_key(&self, rel: &str) -> String {
        format!("{}{rel}", self.config.prefix_norm())
    }

    /// The public, credential-free URL of `key`, when the profile has a public origin.
    pub fn public_url(&self, key: &str) -> Option<String> {
        self.config.public_url.as_ref().map(|base| {
            format!(
                "{}/{}",
                base.trim_end_matches('/'),
                sigv4::uri_encode(key, true)
            )
        })
    }

    /// The canonical `s3://bucket/key` URI for `key`.
    pub fn s3_uri(&self, key: &str) -> String {
        format!("{S3_SCHEME}://{}/{}", self.config.bucket, key)
    }

    /// The API URL of `key` (path-style or virtual-hosted).
    fn api_url(&self, key: &str) -> Result<Url> {
        // `.`/`..`/empty segments would be normalized by the URL parser AFTER signing (and
        // could address another key) — refuse them rather than sign one path and send another.
        if key.is_empty() || key.split('/').any(|s| s.is_empty() || s == "." || s == "..") {
            return Err(Error::Config(format!(
                "s3 object key {key:?} has an empty, '.' or '..' segment"
            )));
        }
        let endpoint = Url::parse(&self.config.endpoint)
            .map_err(|e| Error::Config(format!("s3 endpoint: {e}")))?;
        let encoded_key = sigv4::uri_encode(key, true);
        let raw = if self.config.path_style {
            format!(
                "{}/{}/{encoded_key}",
                self.config.endpoint.trim_end_matches('/'),
                self.config.bucket
            )
        } else {
            let host = endpoint.host_str().unwrap_or_default();
            let port = endpoint.port().map(|p| format!(":{p}")).unwrap_or_default();
            format!(
                "{}://{}.{host}{port}/{encoded_key}",
                endpoint.scheme(),
                self.config.bucket
            )
        };
        Url::parse(&raw).map_err(|e| Error::Config(format!("building s3 url: {e}")))
    }

    /// Prepare a request to the API endpoint for `key`, signing it when credentials exist.
    fn prepare(
        &self,
        method: &str,
        key: &str,
        extra_headers: &[(String, String)],
        payload_hash: &str,
    ) -> Result<Prepared> {
        let url = self.api_url(key)?;
        let mut headers: Vec<(String, String)> = extra_headers.to_vec();
        if let Some(creds) = &self.config.credentials {
            let host = match url.port() {
                Some(p) => format!("{}:{p}", url.host_str().unwrap_or_default()),
                None => url.host_str().unwrap_or_default().to_string(),
            };
            let signed = sigv4::sign_request(
                &RequestToSign {
                    method,
                    host: &host,
                    // `Url` keeps our percent-encoding verbatim (we only emit unreserved
                    // characters, `/` and `%XX`), so its path IS the canonical URI.
                    canonical_uri: url.path(),
                    query: &[],
                    headers: extra_headers,
                    payload_hash,
                    region: &self.config.region,
                    service: "s3",
                    content_sha256_header: true,
                },
                creds.signing_keys(),
                &AmzDate::now(),
            );
            headers.extend(signed);
        }
        Ok(Prepared { url, headers })
    }

    async fn send(
        &self,
        method: Method,
        prepared: Prepared,
        body: Option<Vec<u8>>,
    ) -> Result<reqwest::Response> {
        let mut req = self.client.request(method, prepared.url);
        for (k, v) in &prepared.headers {
            req = req.header(k.as_str(), v.as_str());
        }
        if let Some(b) = body {
            req = req.header(reqwest::header::CONTENT_LENGTH, b.len()).body(b);
        }
        req.send()
            .await
            .map_err(|e| transport_err("S3 request failed", &e))
    }

    /// `PUT` `bytes` at `key` (signed, with the body hash in `x-amz-content-sha256`).
    pub async fn put_object(&self, key: &str, bytes: &[u8], content_type: &str) -> Result<()> {
        let payload_hash = sigv4::sha256_hex(bytes);
        let prepared = self.prepare(
            "PUT",
            key,
            &[("content-type".to_string(), content_type.to_string())],
            &payload_hash,
        )?;
        let resp = self
            .send(Method::PUT, prepared, Some(bytes.to_vec()))
            .await?;
        expect_success(resp, "PUT", key).await
    }

    /// `HEAD` `key` on the API endpoint: `Some(size)` when present, `None` on 404.
    pub async fn head_object(&self, key: &str) -> Result<Option<u64>> {
        let prepared = self.prepare("HEAD", key, &[], EMPTY_PAYLOAD_SHA256)?;
        let resp = self.send(Method::HEAD, prepared, None).await?;
        match resp.status() {
            StatusCode::NOT_FOUND => Ok(None),
            s if s.is_success() => Ok(Some(
                resp.headers()
                    .get(reqwest::header::CONTENT_LENGTH)
                    .and_then(|v| v.to_str().ok())
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(0),
            )),
            s => Err(Error::Io(format!(
                "S3 HEAD {key} failed with status {s}{}",
                auth_hint(s)
            ))),
        }
    }

    /// `GET` `key` (optionally a range) from the API endpoint, signed when credentialed.
    pub async fn get_object(&self, key: &str, range: Option<ByteRange>) -> Result<Vec<u8>> {
        let extra: Vec<(String, String)> = range
            .map(|r| vec![("range".to_string(), r.http_header_value())])
            .unwrap_or_default();
        let prepared = self.prepare("GET", key, &extra, EMPTY_PAYLOAD_SHA256)?;
        let resp = self.send(Method::GET, prepared, None).await?;
        let status = resp.status();
        if status == StatusCode::NOT_FOUND {
            return Err(Error::NotFound);
        }
        if range.is_some() && status != StatusCode::PARTIAL_CONTENT {
            return Err(Error::Io(format!(
                "ranged S3 GET {key} expected 206 Partial Content, got {status}"
            )));
        }
        if !status.is_success() {
            let body = truncated_body(resp).await;
            return Err(Error::Io(format!(
                "S3 GET {key} failed with status {status}{}: {body}",
                auth_hint(status)
            )));
        }
        Ok(resp
            .bytes()
            .await
            .map_err(|e| transport_err("reading S3 body", &e))?
            .to_vec())
    }

    /// `DELETE` `key` (signed). A missing key is success (S3 semantics).
    pub async fn delete_object(&self, key: &str) -> Result<()> {
        let prepared = self.prepare("DELETE", key, &[], EMPTY_PAYLOAD_SHA256)?;
        let resp = self.send(Method::DELETE, prepared, None).await?;
        if resp.status() == StatusCode::NOT_FOUND {
            return Ok(());
        }
        expect_success(resp, "DELETE", key).await
    }

    /// Resolve an `s3://bucket/key` URI to its key, when it names this backend's bucket.
    fn key_of(&self, uri: &Uri) -> Option<String> {
        let rest = uri.rest()?;
        let (bucket, key) = rest.split_once('/')?;
        (bucket == self.config.bucket).then(|| key.to_string())
    }
}

/// Map an auth-looking status onto the usual cause.
fn auth_hint(status: StatusCode) -> &'static str {
    match status {
        StatusCode::FORBIDDEN => {
            " (access denied — check the credentials, the region, and that the key may write this bucket)"
        }
        StatusCode::UNAUTHORIZED => " (unauthorized — check the credentials)",
        StatusCode::MOVED_PERMANENTLY | StatusCode::TEMPORARY_REDIRECT => {
            " (redirected — the bucket is in another region, or needs virtual-hosted addressing)"
        }
        _ => "",
    }
}

async fn truncated_body(resp: reqwest::Response) -> String {
    let mut body = resp.text().await.unwrap_or_default();
    if body.len() > MAX_ERROR_BODY {
        let mut cut = MAX_ERROR_BODY;
        while !body.is_char_boundary(cut) {
            cut -= 1;
        }
        body.truncate(cut);
        body.push('…');
    }
    body
}

async fn expect_success(resp: reqwest::Response, op: &str, key: &str) -> Result<()> {
    let status = resp.status();
    if status.is_success() {
        return Ok(());
    }
    let body = truncated_body(resp).await;
    Err(Error::Io(format!(
        "S3 {op} {key} failed with status {status}{}: {body}",
        auth_hint(status)
    )))
}

#[async_trait::async_trait]
impl PackBackend for S3Backend {
    fn scheme(&self) -> &'static str {
        S3_SCHEME
    }

    fn caps(&self) -> Caps {
        Caps {
            read_cli: true,
            read_browser: self.config.public_url.is_some(),
            write_cli: true,
            write_browser: false,
        }
    }

    /// Store `bytes` at the content-addressed key, skipping the upload when an object of
    /// the same size is already there (a re-push). Whether the bytes AT the key are right
    /// is the caller's verification step — see [`crate::storage`].
    async fn put(&self, bytes: &[u8], meta: &PackMeta) -> Result<Vec<Uri>> {
        let key = self.object_key(&Self::pack_key(&meta.pack_hash));
        if self.head_object(&key).await? != Some(bytes.len() as u64) {
            self.put_object(&key, bytes, "application/octet-stream")
                .await?;
        }
        let mut uris = Vec::with_capacity(2);
        if let Some(public) = self.public_url(&key) {
            uris.push(Uri(public));
        }
        uris.push(Uri(self.s3_uri(&key)));
        Ok(uris)
    }

    async fn get(&self, uri: &Uri, range: Option<ByteRange>) -> Result<Vec<u8>> {
        match uri.scheme() {
            Some(S3_SCHEME) => {
                let key = self.key_of(uri).ok_or_else(|| {
                    Error::Config(format!(
                        "s3 uri {uri} does not name this profile's bucket {:?}",
                        self.config.bucket
                    ))
                })?;
                self.get_object(&key, range).await
            }
            Some("http" | "https") => http_get(&self.client, &uri.0, range).await,
            other => Err(Error::Config(format!(
                "s3 backend cannot serve uri scheme {other:?}: {uri}"
            ))),
        }
    }

    async fn probe(&self, uri: &Uri) -> Result<Health> {
        match uri.scheme() {
            Some(S3_SCHEME) => {
                let key = self
                    .key_of(uri)
                    .ok_or_else(|| Error::Config(format!("foreign s3 uri {uri}")))?;
                let started = std::time::Instant::now();
                let size = self.head_object(&key).await;
                let latency = started.elapsed();
                Ok(match size {
                    Ok(Some(size)) => Health {
                        ok: true,
                        size: Some(size),
                        latency,
                    },
                    _ => Health::down(latency),
                })
            }
            Some("http" | "https") => http_probe(&self.client, &uri.0).await,
            other => Err(Error::Config(format!(
                "s3 backend cannot probe uri scheme {other:?}: {uri}"
            ))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(path_style: bool) -> S3Config {
        S3Config {
            endpoint: "https://s3.us-east-1.amazonaws.com".into(),
            region: "us-east-1".into(),
            bucket: "examplebucket".into(),
            path_style,
            public_url: Some("https://cdn.example.org/".into()),
            prefix: "forge/".into(),
            credentials: None,
        }
    }

    #[test]
    fn path_style_and_virtual_hosted_urls() {
        let b = S3Backend::new(cfg(true));
        assert_eq!(
            b.api_url("forge/packs/ab.pack").unwrap().as_str(),
            "https://s3.us-east-1.amazonaws.com/examplebucket/forge/packs/ab.pack"
        );
        let b = S3Backend::new(cfg(false));
        assert_eq!(
            b.api_url("forge/packs/ab.pack").unwrap().as_str(),
            "https://examplebucket.s3.us-east-1.amazonaws.com/forge/packs/ab.pack"
        );
    }

    #[test]
    fn special_characters_in_keys_are_encoded_once() {
        let b = S3Backend::new(cfg(true));
        let url = b.api_url("a b/c+d$e=f").unwrap();
        assert_eq!(url.path(), "/examplebucket/a%20b/c%2Bd%24e%3Df");
        assert_eq!(
            b.public_url("a b/c+d").unwrap(),
            "https://cdn.example.org/a%20b/c%2Bd"
        );
    }

    #[test]
    fn signed_path_and_host_survive_url_parsing_unchanged() {
        // What we sign must be byte-for-byte what reqwest sends: the parsed Url's path
        // equals our encoding (no re-encoding, no normalization), and the signed host
        // carries the port exactly when the URL (and so the Host header) does.
        let mut c = cfg(true);
        c.endpoint = "http://127.0.0.1:9000".into();
        let b = S3Backend::new(c);
        let key = "p/a b+c=d&e$f,g;h@i(j)!*'~%ü.bin";
        let url = b.api_url(key).unwrap();
        let expected = format!("/examplebucket/{}", sigv4::uri_encode(key, true));
        assert_eq!(url.path(), expected);
        assert_eq!(url.port(), Some(9000));
        // Default ports are dropped by the parser, so the Host header has no port either.
        let mut c = cfg(true);
        c.endpoint = "https://s3.us-east-1.amazonaws.com:443".into();
        let url = S3Backend::new(c).api_url("k").unwrap();
        assert_eq!(url.port(), None);
        // Dot segments are refused before signing.
        let b = S3Backend::new(cfg(true));
        assert!(b.api_url("a/../b").is_err());
        assert!(b.api_url("a/./b").is_err());
        assert!(b.api_url("a//b").is_err());
        assert!(b.api_url("").is_err());
    }

    #[test]
    fn keys_are_content_addressed_under_the_prefix() {
        let b = S3Backend::new(cfg(true));
        assert_eq!(
            b.object_key(&S3Backend::pack_key("ff")),
            "forge/packs/ff.pack"
        );
        assert_eq!(
            b.s3_uri("forge/packs/ff.pack"),
            "s3://examplebucket/forge/packs/ff.pack"
        );
        assert_eq!(
            b.key_of(&Uri("s3://examplebucket/forge/packs/ff.pack".into())),
            Some("forge/packs/ff.pack".into())
        );
        assert_eq!(b.key_of(&Uri("s3://other/x".into())), None);
    }

    #[test]
    fn validate_rejects_dot_segments_and_bad_buckets() {
        let mut c = cfg(true);
        assert!(c.validate().is_ok());
        c.prefix = "a/../b".into();
        assert!(c.validate().is_err());
        c.prefix = "a//b".into();
        assert!(c.validate().is_err());
        let mut c = cfg(true);
        c.bucket = "Upper".into();
        assert!(c.validate().is_err());
        let mut c = cfg(false);
        c.bucket = "a.b".into();
        assert!(c.validate().is_err());
        let mut c = cfg(true);
        c.endpoint = "https://host/with/path".into();
        assert!(c.validate().is_err());
    }

    #[test]
    fn debug_redacts_credentials() {
        let mut c = cfg(true);
        c.credentials = Some(S3Credentials {
            access_key_id: "AKIDEXAMPLE".into(),
            secret_access_key: Secret::new("very-secret-value"),
            session_token: Some(Secret::new("session-secret-value")),
        });
        let rendered = format!("{:?}", S3Backend::new(c));
        assert!(!rendered.contains("very-secret-value"));
        assert!(!rendered.contains("session-secret-value"));
    }

    #[test]
    fn signed_request_carries_authorization_and_payload_hash() {
        let mut c = cfg(true);
        c.credentials = Some(S3Credentials {
            access_key_id: "AKIDEXAMPLE".into(),
            secret_access_key: Secret::new("s"),
            session_token: None,
        });
        let b = S3Backend::new(c);
        let p = b.prepare("PUT", "k", &[], "abc").unwrap();
        let names: Vec<&str> = p.headers.iter().map(|(k, _)| k.as_str()).collect();
        assert!(names.contains(&"authorization"));
        assert!(names.contains(&"x-amz-date"));
        assert!(p
            .headers
            .iter()
            .any(|(k, v)| k == "x-amz-content-sha256" && v == "abc"));
        let auth = &p
            .headers
            .iter()
            .find(|(k, _)| k == "authorization")
            .unwrap()
            .1;
        assert!(auth.contains("/us-east-1/s3/aws4_request"));
        assert!(auth.contains("SignedHeaders=host;x-amz-content-sha256;x-amz-date"));
    }

    #[test]
    fn anonymous_requests_are_unsigned() {
        let b = S3Backend::new(cfg(true));
        let p = b.prepare("GET", "k", &[], EMPTY_PAYLOAD_SHA256).unwrap();
        assert!(p.headers.is_empty());
    }
}
