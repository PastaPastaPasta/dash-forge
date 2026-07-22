//! Pack-storage backends (`platform | ipfs | s3 | https`).
//!
//! Backends control only where **pack bytes** rest; refs and manifests always live on
//! Platform. Integrity comes from the manifest SHA-256 + git OIDs verified in the pack
//! pipeline, *outside* any backend — a malicious backend can only trigger a
//! retry/failover, never corrupt state (see `docs/prd/04-storage-adapters.md`).

use serde::{Deserialize, Serialize};

use crate::error::Result;

/// A storage location for pack bytes (e.g. `ipfs://<cid>`, `s3://…`, `https://…`,
/// or a Platform chunk locator).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Uri(pub String);

/// A half-open byte range for ranged/partial reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ByteRange {
    /// Inclusive start offset.
    pub start: u64,
    /// Exclusive end offset.
    pub end: u64,
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

/// Availability/health of a stored URI, as reported by `dg storage status`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Health {
    /// Reachable and serving bytes.
    Available,
    /// Reachable but slow or partially degraded.
    Degraded,
    /// Unreachable.
    Unavailable,
}

/// A pack-byte storage backend.
///
/// Mirrors the TypeScript reader trait in forge-web. Hash verification is *not* a
/// backend responsibility; it lives in the pack pipeline.
pub trait PackBackend {
    /// URI scheme this backend serves (`platform | ipfs | s3 | https`).
    fn scheme(&self) -> &str;

    /// This backend's capability matrix.
    fn caps(&self) -> Caps;

    /// Store `bytes`, returning one or more URIs the manifest should record.
    fn put(&self, bytes: &[u8], meta: &PackMeta) -> Result<Vec<Uri>>;

    /// Fetch bytes for `uri`, optionally restricted to `range` (partial clone).
    fn get(&self, uri: &Uri, range: Option<ByteRange>) -> Result<Vec<u8>>;

    /// Probe the health/availability of `uri`.
    fn probe(&self, uri: &Uri) -> Result<Health>;
}
