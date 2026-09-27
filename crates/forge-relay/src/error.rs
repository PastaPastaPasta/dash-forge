//! The relay error taxonomy.

/// Convenience alias for relay results.
pub type Result<T> = std::result::Result<T, RelayError>;

/// Errors surfaced by the relay daemon.
#[derive(Debug, thiserror::Error)]
pub enum RelayError {
    /// A misconfiguration (bad config file, missing identity, malformed repo id).
    #[error("configuration error: {0}")]
    Config(String),

    /// A delivery target was refused by the SSRF policy (malformed, or a non-public
    /// address): permanent until the hook's URL changes.
    #[error("ssrf guard: {0}")]
    Ssrf(String),

    /// The delivery host did not resolve (in time): retried like any receiver failure.
    #[error("delivery host unresolved: {0}")]
    Unresolved(String),

    /// Delivery failed after exhausting retries (dead-lettered).
    #[error("delivery failed after {attempts} attempts: {reason}")]
    DeliveryExhausted {
        /// Number of attempts made.
        attempts: u32,
        /// The last failure reason.
        reason: String,
    },

    /// A delivery retrying cannot fix (a body over the cap, or a client error other than
    /// 408/429 from the receiver): dead-lettered at once, never queued for a retry.
    #[error("not retried: {0}")]
    Permanent(String),

    /// Another relay holds the delivery queue in this state dir.
    #[error("{0}")]
    StateLocked(String),

    /// No delivery slot to the destination freed up in time: other hooks kept it busy. Not
    /// the receiver's fault, so it does not count against the hook's circuit breaker.
    #[error("destination busy: {0}")]
    DestinationBusy(String),

    /// An underlying forge-core error (Platform read/write).
    #[error("forge-core: {0}")]
    Core(#[from] forge_core::error::Error),

    /// An I/O failure.
    #[error("io error: {0}")]
    Io(String),
}
