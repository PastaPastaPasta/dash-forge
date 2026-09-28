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

/// What a `git push` writes on Platform, priced from fees measured on devnet moutai (drive
/// 4.2.0-beta.5, protocol 14; per-write and per-push balance deltas, 2026-09-27/28; the table
/// and method are in `docs/guides/costs.md` and PR #127). The byte formula above prices
/// storage alone: forge-v2 documents also pay for their index entries (`repoId`, the
/// uploader, counts), a fixed cost per document that dominates small writes, and was the
/// 6-10x gap of D-311 / D-514 / D-700 / L-11.
///
/// Every figure is at or above what the calibration paid, so the estimate is an upper bound:
/// 1.01-1.2x the charge on a first push, up to about 1.6x on a small later one.
pub mod push_fees {
    /// Credits per byte of a `chunk` document's signed transition (storage, its processing,
    /// and the chunk's own index entries growing with it). Measured 27,450-27,650.
    pub const CHUNK_PER_BYTE: u64 = 27_700;
    /// A `chunk`'s cost beyond its bytes. Measured 60-70M for a later chunk, more for a
    /// repository's first (new index subtrees): whole pushes into new repositories need 94M.
    pub const CHUNK_FLAT: u64 = 94_000_000;
    /// Bytes a chunk document's transition carries beyond its payload (ids, the pack hash,
    /// `seq`, field headers, the signature). Measured 116-128.
    pub const CHUNK_OVERHEAD_BYTES: u64 = 130;
    /// A `packManifest`, the first of a push into a repository or ref that has none of its
    /// kind yet (its index subtrees are created). Measured 109.3-110.2M.
    pub const MANIFEST_FIRST: u64 = 112_000_000;
    /// A `refUpdate` or `protectedRefUpdate` creating a ref's history, public or private.
    /// Measured 88.3-90.0M (a later one 56.8-67.3M).
    pub const REF_FIRST: u64 = 92_000_000;
    /// What each external target's URIs add to a manifest: a second target's 239 bytes
    /// measured +6.4-7.1M; a URI is at most 300 bytes (`MANIFEST_URIS_V2`).
    pub const URIS_PER_TARGET: u64 = 9_000_000;

    /// The credits of storing `bytes` as `chunk` documents.
    pub fn chunks(bytes: u64) -> u64 {
        let payload = crate::pack::DOC_PAYLOAD_MAX as u64;
        let full = bytes / payload;
        let rest = bytes % payload;
        let doc = |b: u64| CHUNK_PER_BYTE * (b + CHUNK_OVERHEAD_BYTES) + CHUNK_FLAT;
        let tail = if rest > 0 { doc(rest) } else { 0 };
        full.saturating_mul(doc(payload)).saturating_add(tail)
    }

    /// The size of a browse-index fragment over `objects` objects: the fanout, a header, and
    /// one row per object.
    pub fn locator_bytes(objects: u64) -> u64 {
        const HEADER: u64 = crate::pack::FANOUT_LEN as u64 + 76;
        HEADER + crate::pack::LOCATOR_ROW_LEN as u64 * objects
    }

    /// What a push writes, as far as its price depends on it.
    #[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
    pub struct PushShape {
        /// The pack's (plaintext) size.
        pub pack_bytes: u64,
        /// Objects in the pack.
        pub objects: u64,
        /// Objects the browse index published with it covers: the pack's, or, when this push
        /// folds the live fragments into one index, every object they and the pack index.
        pub index_objects: u64,
        /// Ref updates.
        pub refs: u64,
        /// External targets the manifests name (each adds its URIs).
        pub external_targets: u64,
        /// Platform stores the pack and the index as chunks.
        pub platform_bytes: bool,
        /// A private repository: both are stored sealed (a little larger).
        pub sealed: bool,
    }

    /// A push's estimate, split by what is written on chain.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct PushEstimate {
        /// Manifests + ref updates (always on Platform).
        pub metadata_credits: u64,
        /// Pack + browse-index `chunk` documents (only when Platform stores the bytes).
        pub chunk_credits: u64,
    }

    impl PushEstimate {
        /// Total credits.
        pub fn total(&self) -> u64 {
            self.metadata_credits + self.chunk_credits
        }
    }

    /// What a push writes on chain: two manifests (the pack's and its browse index's), a
    /// ref update per ref, and, only when Platform stores the bytes, the chunk documents of
    /// the pack AND of its browse index (D-311: the index chunks were left out), sealed for
    /// a private repository. A push that creates anything new pays first-write fees (a
    /// repository's first manifest, a ref's first update: new index subtrees, up to +40%);
    /// this prices every push as a first write, so the estimate is an upper bound for all of
    /// them. git-remote-dash's guard and forge-import's cap both use it.
    pub fn estimate_push(shape: &PushShape) -> PushEstimate {
        let manifest = MANIFEST_FIRST + URIS_PER_TARGET * shape.external_targets;
        let index_objects = shape.index_objects.max(shape.objects);
        PushEstimate {
            metadata_credits: manifest * 2 + estimate_ref_updates(shape.refs),
            chunk_credits: if shape.platform_bytes {
                chunks(stored(shape.pack_bytes, shape.sealed))
                    + index_chunks(index_objects, shape.sealed)
            } else {
                0
            },
        }
    }

    /// The credits of a browse-index fragment over `objects` objects stored as `chunk`
    /// documents, sealed when the repository is private (`dg repo reindex` prices the same).
    pub fn index_chunks(objects: u64, sealed: bool) -> u64 {
        chunks(stored(locator_bytes(objects), sealed))
    }

    /// The bytes a `plain`-byte artifact takes stored: sealed ones are a little larger.
    fn stored(plain: u64, sealed: bool) -> u64 {
        if sealed {
            crate::private::pack::sealed_upper_bound(plain)
        } else {
            plain
        }
    }

    /// `n` ref updates alone (a push that stores no pack), priced as first writes of their
    /// refs (the upper bound).
    pub fn estimate_ref_updates(n: u64) -> u64 {
        REF_FIRST * n
    }
}

/// Estimate the split `{deposit, burn}` cost of writing a single `bytes`-byte
/// document. Convenience alias for [`estimate_document_storage`] matching the
/// `CostEngine::estimate` name used in the PRDs and `economics.md` §2.
pub fn estimate(bytes: u64) -> CostEstimate {
    estimate_document_storage(bytes)
}

/// Upper-bound refund recoverable by deleting a `bytes`-byte document *promptly*
/// after writing it (economics.md §3).
///
/// The 27,000-credits/byte storage deposit is spread across 2,000 epochs; on delete,
/// every not-yet-elapsed epoch share is refunded to the document owner. Deleting
/// within the same epoch recovers essentially the whole deposit (bar rounding
/// leftovers). Processing burn is never refunded. This returns the deposit as the
/// prompt-delete upper bound — the observed on-chain refund is slightly lower by the
/// elapsed-epoch share plus rounding, which is why the live test asserts a *range*.
pub fn prompt_delete_refund(bytes: u64) -> u64 {
    estimate_document_storage(bytes).deposit
}

#[cfg(test)]
mod tests {
    use super::push_fees::{chunks, estimate_push, estimate_ref_updates, PushShape};
    use super::{
        estimate_document_storage, BASE_ST_PROCESSING, CREDITS_PER_DASH, PROCESSING_PER_BYTE, SEEK,
        STORAGE_CREDIT_PER_BYTE, STORAGE_PROCESSING_PER_BYTE, WRITE_BASE,
    };

    fn shape(bytes: u64, objects: u64, refs: u64, targets: u64, platform: bool) -> PushShape {
        PushShape {
            pack_bytes: bytes,
            objects,
            index_objects: objects,
            refs,
            external_targets: targets,
            platform_bytes: platform,
            sealed: false,
        }
    }

    #[test]
    fn external_policy_bills_metadata_only() {
        let ext = estimate_push(&shape(1_258_291, 300, 1, 1, false));
        assert_eq!(ext.chunk_credits, 0);
        let chain = estimate_push(&shape(1_258_291, 300, 1, 0, true));
        assert!(
            chain.chunk_credits > 100 * ext.metadata_credits,
            "{chain:?} vs {ext:?}"
        );
        // ~1.2 MiB of chunks is ~0.43 DASH (measured ≈0.33 DASH/MiB, plus the index).
        #[allow(clippy::cast_precision_loss)]
        let d = chain.total() as f64 / CREDITS_PER_DASH as f64;
        assert!((0.40..0.48).contains(&d), "{d}");
    }

    /// L-11 / D-311 / D-700: every push recorded on moutai (drive 4.2.0-beta.5, 2026-09-27/28,
    /// an identity nothing else spent from) with what it paid: the sum of its writes'
    /// balance deltas, or its balance change rounded up. The estimate must be an upper bound;
    /// within +25% of the charge on a push into a new repository or ref (the case the
    /// first-write fees price), within +60% on a later one (existing index subtrees pay less).
    #[test]
    fn estimates_cover_recorded_beta5_pushes() {
        // (pack bytes, objects, refs, external targets, platform, private, paid, first write)
        type Run = (u64, u64, u64, u64, bool, bool, u64, bool);
        #[rustfmt::skip]
        const RUNS: &[Run] = &[
            (218, 3, 1, 0, true, false, 460_467_580, true),         // tiny, new repo
            (247, 3, 1, 0, true, false, 402_038_960, false),        // tiny, same ref again
            (207_108, 4, 2, 0, true, false, 7_074_537_480, true),   // 202 KiB, 2 refs, new repo
            (410_023, 3, 1, 0, true, false, 13_809_268_400, false), // 400 KiB follow-up
            (62_312, 4, 1, 1, false, false, 281_865_480, true),     // own storage, new repo
            (278, 3, 1, 1, false, false, 213_867_380, false),       // own storage, follow-up
            (2_347, 4, 1, 1, false, false, 285_000_000, true),      // one external target
            (2_345, 4, 1, 2, false, false, 305_000_000, true),      // two external targets
            (21_011, 4, 1, 0, true, true, 1_123_943_560, true),     // private 20 KiB, new repo
            (4_466, 4, 3, 0, true, true, 785_000_000, true),        // private, 3 new refs
            (332, 3, 3, 0, true, true, 595_000_000, false),         // private, the 3 refs again
            (1_318, 4, 1, 0, true, false, 575_000_000, true),       // public, new repo
            (279, 3, 1, 0, true, false, 445_000_000, false),        // protected main, first
            (286, 3, 1, 0, true, false, 445_000_000, false),        // protected main, again
            (205_126, 4, 1, 0, true, false, 7_025_000_000, true),   // 200 KiB, new repo
            (1_536_767, 3, 1, 0, true, false, 50_125_000_000, false), // 1.5 MiB (105 chunks)
        ];
        for &(bytes, objects, refs, targets, platform, sealed, paid, first) in RUNS {
            let est = estimate_push(&PushShape {
                sealed,
                ..shape(bytes, objects, refs, targets, platform)
            })
            .total();
            #[allow(clippy::cast_precision_loss)]
            let ratio = est as f64 / paid as f64;
            let cap = if first { 1.25 } else { 1.6 };
            assert!(
                est >= paid && ratio <= cap,
                "{bytes} B: estimate {est} vs paid {paid} ({ratio:.3})"
            );
        }
        // A new ref at a stored commit (no pack): paid 65,783,120; a first protected ref
        // update 87,714,300; the first of a private push's refs 90,039,140.
        for paid in [65_783_120, 87_714_300, 90_039_140] {
            assert!(estimate_ref_updates(1) >= paid);
        }
    }

    /// A private push stores its pack and its index sealed, so both are priced sealed; a push
    /// that folds the browse index prices the whole folded index.
    #[test]
    fn sealed_and_folding_pushes_price_what_they_store() {
        let public = shape(16_300, 50_000, 1, 0, true);
        let private = PushShape {
            sealed: true,
            ..public
        };
        // Sealing adds a header and a tag per 16 KiB to the pack and to the index.
        assert!(estimate_push(&private).chunk_credits > estimate_push(&public).chunk_credits);
        // A fold's index covers 100,000 more objects: 3.6 MB more of chunks.
        let folding = PushShape {
            index_objects: 150_000,
            ..public
        };
        let (plain, folded) = (estimate_push(&public), estimate_push(&folding));
        assert!(
            folded.chunk_credits >= plain.chunk_credits + chunks(36 * 100_000) - chunks(14_700),
            "{plain:?} vs {folded:?}"
        );
        // The index never covers fewer objects than the pack.
        let fewer = PushShape {
            index_objects: 1,
            ..public
        };
        assert_eq!(estimate_push(&fewer), estimate_push(&public));
    }

    /// forge-web's `estimateChunkCredits` mirrors [`chunks`]; its test pins the same figure.
    #[test]
    fn a_mib_of_chunks_is_what_the_web_quotes() {
        assert_eq!(chunks(1 << 20), 36_072_827_200);
        assert_eq!(chunks(0), 0);
    }

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

    #[test]
    fn estimate_alias_matches_full_name() {
        assert_eq!(super::estimate(4096), estimate_document_storage(4096));
    }

    #[test]
    fn prompt_delete_refund_is_the_deposit() {
        // Prompt deletion recovers the refundable storage deposit (upper bound);
        // the non-refundable burn is never returned.
        let bytes = 15_000;
        assert_eq!(
            super::prompt_delete_refund(bytes),
            estimate_document_storage(bytes).deposit
        );
    }
}
