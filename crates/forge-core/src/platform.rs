//! Platform client and the idempotent write engine.
//!
//! This is the one module allowed to touch rs-sdk/rs-dpp (Stage 2). For now it holds
//! SDK-free placeholders that fix the public shape:
//!
//! - [`PlatformClient`] — the future rs-sdk wrapper (connect/retry, proof verification,
//!   registry+template preload, pipelined nonce serializer).
//! - [`WriteEngine`] — the idempotent state-transition lifecycle: sign → persist bytes
//!   → broadcast → wait → rebroadcast the *same* bytes on timeout; "already exists" is
//!   success (see `docs/research/platform-constraints.md` §5).
//! - [`PushJournal`] — the on-disk record of uploaded chunks that lets an interrupted
//!   push resume without re-paying (`.git/dash/journal/<packHash>.json`).

use serde::{Deserialize, Serialize};

use crate::error::Result;

/// The network a client is bound to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Network {
    /// Dash testnet.
    Testnet,
    /// Dash mainnet.
    Mainnet,
    /// A local devnet (dashmate).
    Devnet,
}

/// Placeholder for the rs-sdk-backed Platform client.
///
/// Stage 2 fills this in with the SDK handle, quorum-key cache, preloaded contracts
/// and the per-identity nonce serializer. Kept as a zero-cost placeholder so the rest
/// of the workspace can compile and depend on its surface today.
#[derive(Debug, Clone)]
pub struct PlatformClient {
    network: Network,
    proof_verification: bool,
}

impl PlatformClient {
    /// Construct a client bound to `network` with proof verification enabled
    /// (the helper/CLI default).
    pub fn new(network: Network) -> Self {
        Self {
            network,
            proof_verification: true,
        }
    }

    /// The network this client targets.
    pub fn network(&self) -> Network {
        self.network
    }

    /// Whether DAPI proofs are verified on every read.
    pub fn proof_verification(&self) -> bool {
        self.proof_verification
    }

    /// Disable proof verification (benchmark/trusted-mode only).
    #[must_use]
    pub fn with_proof_verification(mut self, enabled: bool) -> Self {
        self.proof_verification = enabled;
        self
    }
}

/// A signed state transition ready to broadcast.
///
/// The engine caches `bytes` before the first broadcast so a timeout can rebroadcast
/// the identical, same-nonce transition rather than re-signing (which would burn a
/// fresh nonce and risk a double-write).
#[derive(Debug, Clone)]
pub struct SignedTransition {
    /// The serialized, signed transition bytes.
    pub bytes: Vec<u8>,
    /// The identity-contract nonce this transition was signed against.
    pub nonce: u64,
}

/// Outcome of a broadcast attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BroadcastOutcome {
    /// The transition was accepted and its result observed.
    Applied,
    /// The transition already existed on-chain — treated as success (idempotency).
    AlreadyExists,
}

/// The idempotent Platform write lifecycle plus journal persistence and fee accounting.
///
/// Implementations live in Stage 2 over [`PlatformClient`]; the trait is defined here
/// so binaries and the pack pipeline can be written against it now.
pub trait WriteEngine {
    /// Broadcast a signed transition idempotently, rebroadcasting the same bytes on a
    /// retryable timeout and treating "already exists" as success.
    fn broadcast(&self, transition: &SignedTransition) -> Result<BroadcastOutcome>;

    /// Persist journal progress so an interrupted push can resume without re-paying
    /// for already-uploaded chunks.
    fn checkpoint(&self, journal: &PushJournal) -> Result<()>;
}

/// A single uploaded-chunk record within a [`PushJournal`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JournalEntry {
    /// Zero-based chunk sequence within the pack.
    pub seq: u32,
    /// The on-chain document id of the uploaded `chunk`.
    pub document_id: String,
}

/// The resumable-push journal for a single pack (`.git/dash/journal/<packHash>.json`).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushJournal {
    /// Hex SHA-256 of the pack this journal tracks.
    pub pack_hash: String,
    /// Total chunk count for the pack (from the manifest plan).
    pub chunk_count: u32,
    /// Chunks already uploaded, by sequence.
    pub uploaded: Vec<JournalEntry>,
}

impl PushJournal {
    /// Start an empty journal for a pack.
    pub fn new(pack_hash: impl Into<String>, chunk_count: u32) -> Self {
        Self {
            pack_hash: pack_hash.into(),
            chunk_count,
            uploaded: Vec::new(),
        }
    }

    /// Whether the chunk at `seq` has already been uploaded (skip → no re-pay).
    pub fn has(&self, seq: u32) -> bool {
        self.uploaded.iter().any(|e| e.seq == seq)
    }

    /// Whether every chunk has been uploaded.
    pub fn is_complete(&self) -> bool {
        self.uploaded.len() >= self.chunk_count as usize
    }
}
