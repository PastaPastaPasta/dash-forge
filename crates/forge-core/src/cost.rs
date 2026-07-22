//! Fee constants and the storage-cost estimator (the `CostEngine`).
//!
//! Constants are the protocol-versioned Platform fee schedule from
//! `docs/research/platform-constraints.md` §4 (identical on testnet and mainnet).
//! Every code path that broadcasts a state transition must route its estimate
//! through here so quotes and audits never drift from reality.

/// Refundable perpetual-storage cost, in credits per byte.
pub const STORAGE_CREDIT_PER_BYTE: u64 = 27_000;

/// Non-refundable storage-processing cost, in credits per byte.
pub const STORAGE_PROCESSING_PER_BYTE: u64 = 400;

/// Non-refundable general processing cost, in credits per byte.
pub const PROCESSING_PER_BYTE: u64 = 12;

/// Flat base processing fee charged per state transition.
pub const BASE_ST_PROCESSING: u64 = 10_000;

/// Flat base cost of a single document write operation.
pub const WRITE_BASE: u64 = 6_000;

/// Per-operation storage seek cost.
pub const SEEK: u64 = 2_000;

/// Credits per whole DASH (1 DASH = 10^11 credits).
pub const CREDITS_PER_DASH: u64 = 100_000_000_000;

/// A split fee estimate for a single document write.
///
/// `deposit` is the refundable storage credit locked for perpetual storage
/// (reclaimed pro-rata on deletion, e.g. via `dg repack`). `burn` is the
/// non-refundable processing cost that is consumed regardless of later deletion.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CostEstimate {
    /// Refundable storage credits.
    pub deposit: u64,
    /// Non-refundable processing credits.
    pub burn: u64,
}

impl CostEstimate {
    /// Total credits required for the write (`deposit + burn`).
    pub fn total(&self) -> u64 {
        self.deposit + self.burn
    }

    /// Total cost expressed in DASH.
    ///
    /// Precision loss is acceptable: this is a display-only convenience; the integer
    /// credit values are the source of truth.
    #[allow(clippy::cast_precision_loss)]
    pub fn total_dash(&self) -> f64 {
        self.total() as f64 / CREDITS_PER_DASH as f64
    }
}

/// Estimate the cost of storing a single document whose serialized payload is
/// `bytes` bytes.
///
/// The refundable deposit scales with storage; the burn is the flat per-transition
/// and per-write processing overhead plus the per-byte processing components.
pub fn estimate_document_storage(bytes: u64) -> CostEstimate {
    let deposit = STORAGE_CREDIT_PER_BYTE * bytes;
    let burn = BASE_ST_PROCESSING
        + WRITE_BASE
        + SEEK
        + (STORAGE_PROCESSING_PER_BYTE + PROCESSING_PER_BYTE) * bytes;
    CostEstimate { deposit, burn }
}

#[cfg(test)]
mod tests {
    use super::{
        estimate_document_storage, BASE_ST_PROCESSING, CREDITS_PER_DASH, PROCESSING_PER_BYTE, SEEK,
        STORAGE_CREDIT_PER_BYTE, STORAGE_PROCESSING_PER_BYTE, WRITE_BASE,
    };

    const FLAT_BURN: u64 = BASE_ST_PROCESSING + WRITE_BASE + SEEK;

    #[test]
    fn zero_byte_document_is_flat_overhead_only() {
        let est = estimate_document_storage(0);
        assert_eq!(est.deposit, 0);
        assert_eq!(est.burn, FLAT_BURN);
        assert_eq!(est.total(), FLAT_BURN);
    }

    #[test]
    fn one_kib_matches_rule_of_thumb() {
        // platform-constraints §4: ~1 KiB ≈ 28M credits (storage component).
        let est = estimate_document_storage(1024);
        assert_eq!(est.deposit, STORAGE_CREDIT_PER_BYTE * 1024); // 27,648,000
        assert_eq!(
            est.burn,
            FLAT_BURN + (STORAGE_PROCESSING_PER_BYTE + PROCESSING_PER_BYTE) * 1024
        );
        // Storage deposit dominates and lands in the ~28M range.
        assert!((27_000_000..29_000_000).contains(&est.deposit));
    }

    #[test]
    #[allow(clippy::cast_precision_loss)]
    fn one_mib_storage_component_is_about_point_two_eight_three_dash() {
        // 1 MiB deposit ≈ 0.283 DASH (§4 table).
        let est = estimate_document_storage(1024 * 1024);
        let deposit_dash = est.deposit as f64 / CREDITS_PER_DASH as f64;
        assert!(
            (0.28..0.29).contains(&deposit_dash),
            "1 MiB deposit was {deposit_dash} DASH"
        );
    }

    #[test]
    fn total_is_deposit_plus_burn() {
        let est = estimate_document_storage(4096);
        assert_eq!(est.total(), est.deposit + est.burn);
    }
}
