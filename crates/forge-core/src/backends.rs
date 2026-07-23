//! Pack-storage backends (`platform | ipfs | s3 | https`).
//!
//! Backends control only where **pack bytes** rest; refs and manifests always live on
//! Platform. Integrity comes from the manifest SHA-256 + git OIDs verified *outside* any
//! backend — a malicious backend can only trigger a retry/failover, never corrupt state
//! (see `docs/prd/04-storage-adapters.md`).
//!
//! Layout:
//! - [`PackBackend`] — the async trait every adapter implements (`scheme`, `caps`, `put`,
//!   ranged `get`, `probe`). Object-safe via `async-trait` so the [`BackendRegistry`] can
//!   hold heterogeneous backends behind `dyn`.
//! - [`https`] — [`https::HttpsBackend`], read-only plain GET + HTTP Range (the simplest
//!   adapter; validates the 206 ranged-read path the browse plane depends on).
//! - [`s3`] — [`s3::S3Backend`], MinIO / S3-compatible over a public bucket (authless
//!   PUT/GET/HEAD + Range). Authenticated (SigV4) writes are a documented v1 follow-up.
//! - [`ipfs`] — [`ipfs::IpfsBackend`], write via kubo `/api/v0/add`, read via gateway
//!   `…/ipfs/<CID>` + Range; the CID double-verifies alongside the manifest SHA-256.
//! - [`platform`] — [`platform::PlatformBackend`], pack bytes as pipelined `chunk` docs
//!   through the Platform [`WriteEngine`](crate::platform::WriteEngine).
//! - [`gitmirror`] — [`gitmirror::GitMirrorBackend`], an existing git hoster as a byte
//!   *source* (fetch + rebuild by tips; `git push --mirror` to write). CLI-only —
//!   coverage-by-tips, not whole-pack-hash — so it is resolved outside [`verify_and_get`].
//! - [`verify_and_get`] — the hash-check helper layered *on top of* `get`.
//! - [`BackendRegistry`] — reader-side failover across a manifest's URIs.

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};

pub mod gitmirror;
pub mod https;
pub mod ipfs;
pub mod platform;
pub mod s3;

#[cfg(test)]
mod live_tests;

pub use gitmirror::{GitMirrorBackend, GITMIRROR_SCHEME};
pub use https::HttpsBackend;
pub use ipfs::IpfsBackend;
pub use platform::{decode_chunk_doc, encode_chunk_doc, PlatformBackend, PLATFORM_SCHEME};
pub use s3::{S3Backend, S3Config};

/// A storage location for pack bytes (e.g. `ipfs://<cid>`, `s3://…`, `https://…`,
/// or a `platform://<contract>/<packHash>` chunk locator).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Uri(pub String);

impl Uri {
    /// The URI scheme (the part before `://`), if present.
    pub fn scheme(&self) -> Option<&str> {
        self.0.split_once("://").map(|(s, _)| s)
    }

    /// The part after `://`, if present.
    pub fn rest(&self) -> Option<&str> {
        self.0.split_once("://").map(|(_, r)| r)
    }
}

impl std::fmt::Display for Uri {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// A half-open byte range for ranged/partial reads (`[start, end)`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ByteRange {
    /// Inclusive start offset.
    pub start: u64,
    /// Exclusive end offset.
    pub end: u64,
}

impl ByteRange {
    /// Build a half-open range, erroring if it is empty or inverted.
    pub fn new(start: u64, end: u64) -> Result<Self> {
        if start >= end {
            return Err(Error::Config(format!(
                "invalid byte range: start ({start}) must be < end ({end})"
            )));
        }
        Ok(Self { start, end })
    }

    /// Length of the range in bytes.
    pub fn len(&self) -> u64 {
        self.end - self.start
    }

    /// Whether the range is empty (never true for a range built via [`ByteRange::new`]).
    pub fn is_empty(&self) -> bool {
        self.start >= self.end
    }

    /// The value for an HTTP `Range` header, using the *inclusive* end HTTP mandates
    /// (`bytes=start-(end-1)`).
    pub fn http_header_value(&self) -> String {
        format!("bytes={}-{}", self.start, self.end - 1)
    }
}

/// Read/write capability matrix for a backend, split by consumer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
#[allow(clippy::struct_excessive_bools)]
pub struct Caps {
    /// Supports reads from the CLI/helper.
    pub read_cli: bool,
    /// Supports reads from the browser (CORS-permitting).
    pub read_browser: bool,
    /// Supports writes from the CLI/helper.
    pub write_cli: bool,
    /// Supports writes from the browser.
    pub write_browser: bool,
}

/// Metadata supplied alongside pack bytes on write.
#[derive(Debug, Clone)]
pub struct PackMeta {
    /// Hex SHA-256 of the pack.
    pub pack_hash: String,
    /// Pack size in bytes.
    pub size: u64,
}

impl PackMeta {
    /// Build metadata for `bytes`, computing its SHA-256.
    pub fn for_bytes(bytes: &[u8]) -> Self {
        Self {
            pack_hash: hex::encode(sha256(bytes)),
            size: bytes.len() as u64,
        }
    }

    /// The 32-byte packHash decoded from the hex string, if it is valid.
    pub fn pack_hash_bytes(&self) -> Result<[u8; 32]> {
        let raw = hex::decode(&self.pack_hash)
            .map_err(|e| Error::Config(format!("packHash is not valid hex: {e}")))?;
        raw.try_into()
            .map_err(|_| Error::Config("packHash is not 32 bytes".into()))
    }
}

/// Availability/health of a stored URI, as reported by `dg storage status`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Health {
    /// Whether the URI is reachable and serving bytes.
    pub ok: bool,
    /// Object size in bytes, when the probe (HEAD) reported one.
    pub size: Option<u64>,
    /// Round-trip latency of the probe.
    pub latency: std::time::Duration,
}

impl Health {
    /// An unreachable probe result with the observed latency.
    pub fn down(latency: std::time::Duration) -> Self {
        Self {
            ok: false,
            size: None,
            latency,
        }
    }
}

/// A pack-byte storage backend.
///
/// Mirrors the TypeScript reader trait in forge-web. Hash verification is *not* a
/// backend responsibility; it lives in [`verify_and_get`] / the pack pipeline. Made
/// object-safe with `async-trait` so the [`BackendRegistry`] can hold a mix of backend
/// types behind `Box<dyn PackBackend>`.
#[async_trait::async_trait]
pub trait PackBackend: Send + Sync {
    /// URI scheme this backend serves (`platform | ipfs | s3 | https`).
    fn scheme(&self) -> &'static str;

    /// This backend's capability matrix.
    fn caps(&self) -> Caps;

    /// Store `bytes`, returning one or more URIs the manifest should record.
    async fn put(&self, bytes: &[u8], meta: &PackMeta) -> Result<Vec<Uri>>;

    /// Fetch bytes for `uri`, optionally restricted to `range` (partial clone / browse).
    ///
    /// A ranged read MUST be served as an HTTP `206 Partial Content` (or equivalent) —
    /// backends error rather than silently returning the whole object for a range.
    async fn get(&self, uri: &Uri, range: Option<ByteRange>) -> Result<Vec<u8>>;

    /// Probe the health/availability of `uri`.
    async fn probe(&self, uri: &Uri) -> Result<Health>;
}

/// Fetch `uri` in full through `backend`, then verify the reassembled bytes against the
/// expected lowercase-hex SHA-256, returning [`Error::Integrity`] on mismatch.
///
/// This is the "verification lives OUTSIDE the adapter" boundary from PRD 04: a backend
/// that tampers with bytes can only cause a failed check here (→ registry failover),
/// never a corrupt clone. Ranged reads are deliberately *not* verified here — a slice
/// cannot be checked against a whole-pack hash; the browse plane verifies partial reads
/// via the locator/OID chain (architecture §6.3), out of this helper's scope.
pub async fn verify_and_get(
    backend: &dyn PackBackend,
    uri: &Uri,
    expected_hash_hex: &str,
) -> Result<Vec<u8>> {
    let bytes = backend.get(uri, None).await?;
    let got = hex::encode(sha256(&bytes));
    if got.eq_ignore_ascii_case(expected_hash_hex) {
        Ok(bytes)
    } else {
        Err(Error::Integrity)
    }
}

/// Reader-side failover across the URIs a `packManifest` records.
///
/// Holds one backend per scheme plus a scheme-preference order. [`get_verified`] orders
/// the manifest's URIs by that preference, races them in windows of ≤2 (PRD 04 reader
/// policy), verifies each candidate's hash, and falls through to the next window on
/// failure — so a dead or tampered mirror is transparently bypassed. Platform chunks are
/// the last resort in the default order.
///
/// [`get_verified`]: BackendRegistry::get_verified
#[derive(Default)]
pub struct BackendRegistry {
    backends: Vec<Box<dyn PackBackend>>,
    preference: Vec<String>,
}

impl BackendRegistry {
    /// An empty registry with the default scheme preference (`https`, `s3`, `ipfs`, then
    /// `platform` last — cheap external mirrors first, on-chain chunks as the backstop).
    pub fn new() -> Self {
        Self {
            backends: Vec::new(),
            preference: ["https", "s3", "ipfs", PLATFORM_SCHEME]
                .iter()
                .map(|s| (*s).to_string())
                .collect(),
        }
    }

    /// Register a backend (later registrations of the same scheme win).
    pub fn register(&mut self, backend: Box<dyn PackBackend>) -> &mut Self {
        let scheme = backend.scheme().to_string();
        self.backends.retain(|b| b.scheme() != scheme);
        self.backends.push(backend);
        self
    }

    /// Override the scheme-preference order (most-preferred first). Schemes absent from
    /// the list sort after every listed one, in registration order.
    pub fn set_preference(&mut self, order: impl IntoIterator<Item = String>) -> &mut Self {
        self.preference = order.into_iter().collect();
        self
    }

    /// The preference rank of `scheme` (lower = tried earlier); unlisted schemes rank last.
    fn rank(&self, scheme: &str) -> usize {
        self.preference
            .iter()
            .position(|s| s == scheme)
            .unwrap_or(usize::MAX)
    }

    /// Look up the backend serving `scheme`.
    fn backend_for(&self, scheme: &str) -> Option<&dyn PackBackend> {
        self.backends
            .iter()
            .find(|b| b.scheme() == scheme)
            .map(AsRef::as_ref)
    }

    /// Order `uris` into the (backend, uri) attempt list a read should walk: URIs whose
    /// scheme has no registered backend are dropped; the rest sort by scheme preference.
    fn ordered_targets<'a>(&'a self, uris: &'a [Uri]) -> Vec<(&'a dyn PackBackend, &'a Uri)> {
        let mut targets: Vec<(&dyn PackBackend, &Uri)> = uris
            .iter()
            .filter_map(|uri| {
                let scheme = uri.scheme()?;
                self.backend_for(scheme).map(|b| (b, uri))
            })
            .collect();
        targets.sort_by_key(|(b, _)| self.rank(b.scheme()));
        targets
    }

    /// Fetch a full pack from the first of `uris` that serves matching, hash-verified
    /// bytes — racing ≤2 candidates at a time and falling through on failure.
    ///
    /// Returns [`Error::NotFound`] when no URI has a registered backend, or the last
    /// underlying error when every candidate failed.
    pub async fn get_verified(&self, uris: &[Uri], expected_hash_hex: &str) -> Result<Vec<u8>> {
        let targets = self.ordered_targets(uris);
        if targets.is_empty() {
            return Err(Error::NotFound);
        }

        let mut last_err = Error::NotFound;
        // Race the ordered candidates in windows of ≤2 (PRD 04: "≤2 parallel attempts").
        for window in targets.chunks(2) {
            let attempts = window.iter().map(|(backend, uri)| {
                let expected = expected_hash_hex;
                Box::pin(async move { verify_and_get(*backend, uri, expected).await })
            });
            match futures::future::select_ok(attempts).await {
                Ok((bytes, _rest)) => return Ok(bytes),
                Err(e) => last_err = e,
            }
        }
        Err(last_err)
    }

    /// Probe every URI that has a registered backend, pairing each with its [`Health`].
    pub async fn probe_all(&self, uris: &[Uri]) -> Vec<(Uri, Health)> {
        let mut out = Vec::with_capacity(uris.len());
        for uri in uris {
            let Some(scheme) = uri.scheme() else { continue };
            let Some(backend) = self.backend_for(scheme) else {
                continue;
            };
            let health = backend
                .probe(uri)
                .await
                .unwrap_or_else(|_| Health::down(std::time::Duration::ZERO));
            out.push((uri.clone(), health));
        }
        out
    }
}

/// SHA-256 of `bytes`.
pub(crate) fn sha256(bytes: &[u8]) -> [u8; 32] {
    use sha2::{Digest as _, Sha256};
    let mut h = Sha256::new();
    h.update(bytes);
    h.finalize().into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uri_scheme_and_rest() {
        let u = Uri("ipfs://bafyfoo".into());
        assert_eq!(u.scheme(), Some("ipfs"));
        assert_eq!(u.rest(), Some("bafyfoo"));
        assert_eq!(Uri("nonsense".into()).scheme(), None);
    }

    #[test]
    fn byte_range_http_header_is_inclusive_end() {
        let r = ByteRange::new(0, 10).unwrap();
        assert_eq!(r.len(), 10);
        assert_eq!(r.http_header_value(), "bytes=0-9");
        assert!(ByteRange::new(5, 5).is_err());
        assert!(ByteRange::new(9, 5).is_err());
    }

    #[test]
    fn pack_meta_hashes_bytes() {
        let m = PackMeta::for_bytes(b"hello");
        // Known SHA-256 of "hello".
        assert_eq!(
            m.pack_hash,
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        );
        assert_eq!(m.size, 5);
        assert_eq!(m.pack_hash_bytes().unwrap().len(), 32);
    }

    // A minimal in-memory backend for exercising the registry policy offline (no docker).
    struct MemBackend {
        scheme: &'static str,
        // uri.rest() -> bytes, or a poison flag that returns tampered bytes.
        store: std::collections::HashMap<String, Vec<u8>>,
        tamper: bool,
        unreachable: bool,
    }

    impl MemBackend {
        fn new(scheme: &'static str) -> Self {
            Self {
                scheme,
                store: std::collections::HashMap::new(),
                tamper: false,
                unreachable: false,
            }
        }
        fn with(mut self, key: &str, bytes: &[u8]) -> Self {
            self.store.insert(key.to_string(), bytes.to_vec());
            self
        }
    }

    #[async_trait::async_trait]
    impl PackBackend for MemBackend {
        fn scheme(&self) -> &'static str {
            self.scheme
        }
        fn caps(&self) -> Caps {
            Caps {
                read_cli: true,
                ..Default::default()
            }
        }
        async fn put(&self, _bytes: &[u8], _meta: &PackMeta) -> Result<Vec<Uri>> {
            Err(Error::Config("mem backend is read-only".into()))
        }
        async fn get(&self, uri: &Uri, range: Option<ByteRange>) -> Result<Vec<u8>> {
            if self.unreachable {
                return Err(Error::Io("mem backend unreachable".into()));
            }
            let key = uri.rest().unwrap_or_default();
            let mut bytes = self.store.get(key).cloned().ok_or(Error::NotFound)?;
            if self.tamper {
                bytes.push(0xFF);
            }
            if let Some(r) = range {
                let s = usize::try_from(r.start).unwrap();
                let e = usize::try_from(r.end).unwrap().min(bytes.len());
                bytes = bytes[s..e].to_vec();
            }
            Ok(bytes)
        }
        async fn probe(&self, uri: &Uri) -> Result<Health> {
            let ok = !self.unreachable && self.store.contains_key(uri.rest().unwrap_or_default());
            Ok(Health {
                ok,
                size: None,
                latency: std::time::Duration::ZERO,
            })
        }
    }

    fn registry_with(backends: Vec<Box<dyn PackBackend>>) -> BackendRegistry {
        let mut r = BackendRegistry::new();
        for b in backends {
            r.register(b);
        }
        r
    }

    #[tokio::test]
    async fn registry_fails_over_from_bad_uri_to_good() {
        let payload = b"the-real-pack-bytes";
        let hash = hex::encode(sha256(payload));

        // https backend is preferred but has nothing (NotFound); ipfs backend has the blob.
        let https = MemBackend::new("https"); // empty store
        let ipfs = MemBackend::new("ipfs").with("good", payload);
        let reg = registry_with(vec![Box::new(https), Box::new(ipfs)]);

        let uris = vec![
            Uri("https://mirror.example/missing".into()),
            Uri("ipfs://good".into()),
        ];
        let got = reg.get_verified(&uris, &hash).await.unwrap();
        assert_eq!(got, payload);
    }

    #[tokio::test]
    async fn registry_fails_over_past_a_tampering_backend() {
        let payload = b"the-real-pack-bytes";
        let hash = hex::encode(sha256(payload));

        // Preferred https backend HAS the key but tampers → integrity fail → failover.
        let mut https = MemBackend::new("https").with("blob", payload);
        https.tamper = true;
        let ipfs = MemBackend::new("ipfs").with("blob", payload);
        let reg = registry_with(vec![Box::new(https), Box::new(ipfs)]);

        let uris = vec![
            Uri("https://mirror.example/blob".into()),
            Uri("ipfs://blob".into()),
        ];
        let got = reg.get_verified(&uris, &hash).await.unwrap();
        assert_eq!(got, payload);
    }

    #[tokio::test]
    async fn registry_reports_not_found_when_no_backend_matches() {
        let reg = registry_with(vec![Box::new(MemBackend::new("https"))]);
        let uris = vec![Uri("ipfs://orphan".into())];
        assert!(matches!(
            reg.get_verified(&uris, "00").await,
            Err(Error::NotFound)
        ));
    }

    #[tokio::test]
    async fn registry_errors_when_all_candidates_fail() {
        let payload = b"data";
        let hash = hex::encode(sha256(payload));
        let https = MemBackend::new("https"); // empty
        let ipfs = MemBackend::new("ipfs"); // empty
        let reg = registry_with(vec![Box::new(https), Box::new(ipfs)]);
        let uris = vec![
            Uri("https://x/missing".into()),
            Uri("ipfs://missing".into()),
        ];
        assert!(reg.get_verified(&uris, &hash).await.is_err());
    }

    #[test]
    fn registry_orders_by_scheme_preference() {
        let reg = registry_with(vec![
            Box::new(MemBackend::new(PLATFORM_SCHEME)),
            Box::new(MemBackend::new("ipfs")),
            Box::new(MemBackend::new("https")),
        ]);
        let uris = vec![
            Uri(format!("{PLATFORM_SCHEME}://c/h")),
            Uri("ipfs://cid".into()),
            Uri("https://host/x".into()),
        ];
        let ordered: Vec<&str> = reg
            .ordered_targets(&uris)
            .iter()
            .map(|(b, _)| b.scheme())
            .collect();
        // Default preference: https, s3, ipfs, platform — platform last.
        assert_eq!(ordered, vec!["https", "ipfs", PLATFORM_SCHEME]);
    }
}
