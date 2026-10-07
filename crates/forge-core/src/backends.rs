//! Pack-storage backends (`platform | ipfs | s3 | https`).
//!
//! Backends control only where **pack bytes** rest; refs and manifests always live on
//! Platform. Integrity comes from the manifest SHA-256 + git OIDs verified *outside* any
//! backend — a malicious backend can only trigger a retry/failover, never corrupt state
//! (see `docs/prd/04-storage-adapters.md`).
//!
//! Layout:
//! - [`PackBackend`] — the async trait every adapter implements (`scheme`, `caps`, `put`,
//!   ranged `get`, `get_capped`, `probe`). Object-safe via `async-trait` so a caller can hold
//!   heterogeneous backends behind `dyn`.
//! - [`https`] — [`https::HttpsBackend`], read-only plain GET + HTTP Range (the simplest
//!   adapter; validates the 206 ranged-read path the browse plane depends on).
//! - [`s3`] — [`s3::S3Backend`], S3-compatible storage (AWS/R2/B2/MinIO): SigV4-signed
//!   PUT/GET/HEAD/DELETE ([`sigv4`]), path-style or virtual-hosted, plus unsigned reads
//!   from the bucket's public URL.
//! - [`ipfs`] — [`ipfs::IpfsBackend`], write via kubo `/api/v0/add` with pinned import
//!   parameters (the CID is re-derived locally by [`cid`] and must match), optional remote
//!   pin through an IPFS Pinning Service API; read via gateway `…/ipfs/<CID>` + Range.
//! - [`platform`] — [`platform::PlatformBackend`], pack bytes as pipelined `chunk` docs
//!   through the Platform [`WriteEngine`](crate::platform::WriteEngine).
//! - [`gitmirror`] — [`gitmirror::GitMirrorBackend`], an existing git hoster as a byte
//!   *source* (fetch + rebuild by tips; `git push --mirror` to write). CLI-only —
//!   coverage-by-tips, not whole-pack-hash — so it is resolved outside the hash-checked
//!   reader.
//!
//! Reads of a manifest's copies go through [`crate::storage::PackReader`], which races them
//! with bounded time and bytes and checks each against the manifest hash.

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};

pub mod cid;
pub mod gitmirror;
pub mod https;
pub mod ipfs;
pub mod platform;
pub mod s3;
pub mod sigv4;

#[cfg(test)]
mod live_tests;

pub use gitmirror::{GitMirrorBackend, GITMIRROR_SCHEME};
pub use https::HttpsBackend;
pub use ipfs::IpfsBackend;
pub use platform::{
    decode_chunk_doc, encode_chunk_doc, PlatformBackend, PlatformLocator, PLATFORM_SCHEME,
};
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
/// backend responsibility; it lives in [`crate::storage::PackReader`] / the pack pipeline.
/// Made object-safe with `async-trait` so a caller can hold a mix of backend types behind
/// `Box<dyn PackBackend>`.
#[async_trait::async_trait]
pub trait PackBackend: Send + Sync {
    /// URI scheme this backend serves (`platform | ipfs | s3 | https`).
    fn scheme(&self) -> &'static str;

    /// This backend's capability matrix.
    fn caps(&self) -> Caps;

    /// Store `bytes`, returning one or more URIs the manifest should record.
    async fn put(&self, bytes: &[u8], meta: &PackMeta) -> Result<Vec<Uri>>;

    /// Store `bytes` again unconditionally, for when a verification re-read found the
    /// stored copy wrong. Backends whose `put` never skips an existing object (IPFS is
    /// content-addressed by the bytes themselves) keep the default.
    async fn reput(&self, bytes: &[u8], meta: &PackMeta) -> Result<Vec<Uri>> {
        self.put(bytes, meta).await
    }

    /// [`Self::get`] of a whole object, refusing a body larger than `max_bytes`. A backend
    /// that reads from a remote host stops reading as soon as the body passes the cap rather
    /// than buffering it first, so there is no default.
    async fn get_capped(&self, uri: &Uri, max_bytes: u64) -> Result<Vec<u8>>;

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
/// that tampers with bytes can only cause a failed check here (→ failover),
/// never a corrupt clone. Ranged reads are deliberately *not* verified here — a slice
/// cannot be checked against a whole-pack hash; the browse plane verifies partial reads
/// via the locator/OID chain (architecture §6.3), out of this helper's scope.
///
/// Tests only: it has no time or size bound. Reads use [`crate::storage::PackReader`].
#[cfg(test)]
pub(crate) async fn verify_and_get(
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

/// `bytes`, unless longer than `max_bytes`: [`PackBackend::get_capped`] for a backend that
/// assembles an object on this computer (Platform chunks, a git rebuild) instead of
/// streaming it from a host.
pub(crate) fn within_cap(uri: &Uri, bytes: Vec<u8>, max_bytes: u64) -> Result<Vec<u8>> {
    if bytes.len() as u64 > max_bytes {
        return Err(Error::Io(format!(
            "{uri} returned more than the expected {max_bytes} bytes"
        )));
    }
    Ok(bytes)
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
}
