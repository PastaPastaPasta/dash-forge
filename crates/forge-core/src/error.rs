//! The `forge-core` error taxonomy.
//!
//! Each variant maps to a product-level error class from the PRDs and must, at the
//! binary boundary, be rendered as an actionable message (e.g. insufficient credits
//! links to the funding bridge; a missing membership names who can grant it).

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

    /// The selected network has no forge-v2 deployment (no fully registered `v2` record in
    /// its deployment file). Returned instead of falling back to another network's
    /// contracts.
    #[error(
        "forge-v2 isn't deployed on {network} yet; use --network devnet --devnet-name moutai \
         (see docs/mainnet-runbook.md)"
    )]
    V2NotDeployed {
        /// The network key (`testnet`, `mainnet`).
        network: String,
    },

    /// This build records forge-v2 contracts for the network, but the network does not have
    /// them: a devnet that was reset, or a deployment record that is wrong. Platform answered
    /// (a proof of absence, or Drive's `contract not found` refusal); retrying cannot help.
    #[error("the forge contracts are not on {network}: {detail}")]
    ContractsMissing {
        /// The network as a person reads it (`devnet moutai`, `mainnet`); `user_error` tells a
        /// devnet by the `devnet ` prefix.
        network: String,
        /// What Platform answered: the missing contract, or Drive's refusal.
        detail: String,
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

    /// Consensus refused a write because a document, identity or contract one of its properties
    /// refers to does not exist (code 40120 on a path other than the membership gates): a
    /// `repoKey` wrapped to a member since revoked (`memberId`), a member enrolled before their
    /// `consent` (`consentBy`), a deleted parent comment (`replyTo`). Nothing landed.
    #[error(
        "consensus refused {document_type}: the reference at {path} does not exist ({detail})"
    )]
    ReferenceNotFound {
        /// The refused document type.
        document_type: String,
        /// The property whose reference is missing.
        path: String,
        /// The consensus error.
        detail: String,
    },

    /// Consensus refused a document because a rule of its type's `propertyConstraints` does not
    /// hold (code 10422): refused before execution, so nothing landed. `rule` is the rule's name
    /// (forge-v2 `dense`, `c1_closedAfter`, …), `detail` the node's message.
    #[error("{detail}")]
    RuleRefused {
        /// The refused document type.
        document_type: String,
        /// The broken rule's key in `propertyConstraints`.
        rule: String,
        /// The consensus message.
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

    /// A node refused a composite query itself (not a transient failure): `unsupported` when
    /// the network has no composite surface at all.
    #[error("composite query refused: {reason}")]
    CompositeRefused {
        /// The network does not support composite queries.
        unsupported: bool,
        /// The refusal.
        reason: String,
    },

    /// A failure already phrased for a person (code, cause, fix): the private-repository key
    /// checks raise these where the reason is understood. Rendered as-is at the boundary.
    #[error("{0}")]
    User(Box<crate::user_error::UserError>),
}

impl From<crate::user_error::UserError> for Error {
    fn from(u: crate::user_error::UserError) -> Self {
        Self::User(Box::new(u))
    }
}
