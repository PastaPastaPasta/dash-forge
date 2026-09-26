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

    /// A read that must be complete could not be proven complete.
    ///
    /// Returned instead of a short answer: a caller folding a partial history cannot tell
    /// "no more documents" from "I stopped early", and the rules layer only guarantees that
    /// every client resolves identically when every client folds the same input. Mirrors
    /// forge-web's `IncompleteReadError` so both ports fail at the same boundary.
    #[error("incomplete read of {document_type} after {fetched} documents: {reason}")]
    IncompleteRead {
        /// The document type being read.
        document_type: String,
        /// How many documents were collected before giving up.
        fetched: usize,
        /// Why completeness could not be established.
        reason: String,
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

    /// Consensus rejected a document create because its id was derived at a different
    /// protocol version than the network's (protocol 14 derives ids from the nonce too). The
    /// transition was refused at basic validation, so nothing landed and nothing was
    /// charged. [`crate::platform::WriteEngine::create_document`] refreshes the version and
    /// retries once.
    #[error("document id derived at a stale protocol version: {0}")]
    StaleProtocolVersion(String),

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

    /// The selected network has no Dash Forge registry deployment (no id in
    /// `forge-contracts/deployments/<network>.json`, and no override). Returned instead of
    /// falling back to another network's contract id.
    #[error(
        "no Dash Forge registry is deployed on {network} yet; see docs/mainnet-runbook.md \
         (or set FORGE_REGISTRY_CONTRACT_ID to a registry you deployed there)"
    )]
    NotDeployed {
        /// The network key (`mainnet`, `devnet-moutai`).
        network: String,
    },

    /// The selected network has no forge-v2 deployment (no fully registered `v2` record in
    /// its deployment file). v2 writes and v2 lookups fail with this; v1 reads still work.
    #[error(
        "forge-v2 isn't deployed on {network} yet; use --network devnet --devnet-name moutai \
         (existing v1 repos there stay readable)"
    )]
    V2NotDeployed {
        /// The network key (`testnet`, `mainnet`).
        network: String,
    },

    /// A write was attempted on a forge-v1 repository. v1 (one contract per repo) is read
    /// only now; new writes go to forge-v2.
    #[error("{repo} is a v1 repo (read-only); run `dg migrate {repo}` to copy it to forge-v2")]
    V1ReadOnly {
        /// The repo as the user named it (`owner/name` or a contract id).
        repo: String,
    },

    /// Consensus refused a write because the writer has no membership document the
    /// document type needs (protocol 14 `ownerRefersTo`, consensus code 40120): not a
    /// member at all, or a writer where the type is maintainer-only (`protectedRefUpdate`,
    /// `config`, `release`).
    #[error(
        "consensus refused {document_type}: no membership document for your identity ({detail})"
    )]
    NotAMember {
        /// The refused document type.
        document_type: String,
        /// The consensus error.
        detail: String,
    },

    /// The signer may not perform `action`, decided before anything was signed: the client
    /// read the repository's membership (or the target's author) and found no role that
    /// consensus would admit. Consensus remains the authority; this only saves the fee.
    #[error("{action}: {reason}")]
    NotPermitted {
        /// What was attempted ("close issue #3").
        action: String,
        /// Why the signer cannot ("you are neither a member of alice/proj nor the author").
        reason: String,
        /// The role or relationship that would allow it ("writer", "maintainer", "author").
        needs: String,
    },

    /// An error surfaced by the Dash Platform SDK (connect, fetch, sign, broadcast).
    ///
    /// The SDK's rich error type is flattened to a message here so the SDK stays
    /// confined to `forge-core::platform` (style guide §B) and never leaks across the
    /// crate's public boundary.
    #[error("platform error: {0}")]
    Platform(String),
}
