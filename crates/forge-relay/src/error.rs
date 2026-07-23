//! The relay error taxonomy.

/// Convenience alias for relay results.
pub type Result<T> = std::result::Result<T, RelayError>;

/// Errors surfaced by the relay daemon.
#[derive(Debug, thiserror::Error)]
pub enum RelayError {
    /// A misconfiguration (bad config file, missing identity, malformed repo id).
    #[error("configuration error: {0}")]
    Config(String),

    /// A delivery target was refused by the SSRF policy.
    #[error("ssrf guard: {0}")]
    Ssrf(String),

    /// A webhook secret could not be resolved (no config secret, encrypted-only path).
    #[error("secret unavailable: {0}")]
    SecretUnavailable(String),

    /// Delivery failed after exhausting retries (dead-lettered).
    #[error("delivery failed after {attempts} attempts: {reason}")]
    DeliveryExhausted {
        /// Number of attempts made.
        attempts: u32,
        /// The last failure reason.
        reason: String,
    },

    /// An underlying forge-core error (Platform read/write).
    #[error("forge-core: {0}")]
    Core(#[from] forge_core::error::Error),

    /// An I/O failure.
    #[error("io error: {0}")]
    Io(String),
}
