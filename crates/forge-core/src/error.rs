//! The `forge-core` error taxonomy.
//!
//! Each variant maps to a product-level error class from the PRDs and must, at the
//! binary boundary, be rendered as an actionable message (e.g. insufficient credits
//! links to the funding bridge; a frozen token explains the revocation).

use thiserror::Error;

/// Convenience alias for results returned across `forge-core`.
pub type Result<T> = std::result::Result<T, Error>;

/// Errors surfaced by `forge-core` services.
#[derive(Debug, Error)]
#[non_exhaustive]
pub enum Error {
    /// The signing identity cannot cover the estimated fee for a write batch.
    #[error("insufficient credits: need {needed} credits, have {available}")]
    InsufficientCredits {
        /// Credits required by the estimate.
        needed: u64,
        /// Credits currently available to the identity.
        available: u64,
    },

    /// The identity's WRITE/MAINTAIN token is frozen — access was revoked/suspended.
    #[error("token frozen: this identity's write access has been suspended")]
    TokenFrozen,

    /// A network / consensus operation timed out.
    ///
    /// `retryable` distinguishes an idempotent rebroadcast candidate (the signed ST
    /// bytes may still land) from a terminal failure.
    #[error("operation timed out (retryable: {retryable})")]
    Timeout {
        /// Whether the same signed bytes may be safely rebroadcast.
        retryable: bool,
    },

    /// The identity lacks the token/key authorization for the requested write.
    #[error("unauthorized: missing the required WRITE or MAINTAIN token")]
    Unauthorized,

    /// A referenced document, ref, manifest or chunk could not be found.
    #[error("not found")]
    NotFound,

    /// A document create collided with a unique index (e.g. an `issue`/`patch`
    /// `number` already taken). The optimistic-numbering allocator catches this and
    /// retries with the next number; other callers surface it as a genuine collision.
    #[error("duplicate unique index: {0}")]
    DuplicateUniqueIndex(String),

    /// A SHA-256 / git-OID verification of reassembled bytes failed.
    #[error("integrity check failed: reassembled bytes did not match the manifest hash")]
    Integrity,

    /// An identity-contract nonce desync was detected.
    #[error("nonce error: identity-contract nonce desynchronized")]
    Nonce,

    /// A serialization / deserialization failure (e.g. parsing a keystore file).
    #[error("serialization error: {0}")]
    Serde(#[from] serde_json::Error),

    /// An I/O failure (e.g. reading a keystore file from disk).
    #[error("io error: {0}")]
    Io(String),

    /// A misconfiguration detected before any network call (bad id, missing key,
    /// unsupported network).
    #[error("configuration error: {0}")]
    Config(String),

    /// An error surfaced by the Dash Platform SDK (connect, fetch, sign, broadcast).
    ///
    /// The SDK's rich error type is flattened to a message here so the SDK stays
    /// confined to `forge-core::platform` (style guide §B) and never leaks across the
    /// crate's public boundary.
    #[error("platform error: {0}")]
    Platform(String),
}
