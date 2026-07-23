//! The `PackPipeline`: git-object / pack plumbing for Dash Forge.
//!
//! This module is pure logic plus subprocess `git` — no Platform SDK, no network. It
//! turns a repository into the content-addressed artifacts the storage and browse
//! planes transport (architecture §5–6.3, data-contracts §2.3):
//!
//! - [the chunker](split) — split a pack (or any artifact) into `chunk`-document
//!   payloads and rejoin them. Platform caps a single field at ~5 KiB and a whole
//!   state transition at 20 KiB, so a `chunk` carries up to [`FIELDS_PER_DOC`] fields
//!   of at most [`FIELD_MAX`] bytes, all within [`ST_SIZE_LIMIT`].
//! - [`build`] — pack creation via system git: [`build_pack`] (thin push pack +
//!   `index-pack --fix-thin` → self-contained) and [`repack_all`] (consolidated pack,
//!   0 `REF_DELTA`).
//! - [`parse`] — packfile + `.idx` v2 parsing, object reconstruction (inflate + OFS/REF
//!   delta), and SHA-256 `packHash`. Hand-parsed rather than scraping
//!   `git verify-pack -v`; see that module for why (verify-pack can't distinguish
//!   OFS from REF deltas, and the browse-plane span read needs the decoder anyway).
//! - [`locator`] — the `objectLocator` artifact (fanout + OID-sorted rows) with an
//!   `O(1/256)` [`lookup`](locator::ObjectLocator::lookup).
//! - [`flatindex`] — the `flatIndex` recursive tree listing (incl. gitlinks).
//! - [`manifest`] — `packManifest` (kind 0/1/2) types + the repack supersedes planner.
//!
//! The chunker is pure, so it is fully implemented here and covered by round-trip and
//! bounds unit tests.

pub mod build;
pub mod flatindex;
pub mod locator;
pub mod manifest;
pub mod parse;

#[cfg(test)]
mod gittests;

pub use build::{build_pack, repack_all, BuildReport, Pack};
pub use flatindex::{FlatEntry, FlatIndex, MODE_GITLINK};
pub use locator::{
    LocatorEntry, ObjectLocator, FANOUT_LEN, LOCATOR_ROW_LEN, SPAN_SENTINEL,
    SPAN_SINGLE_READ_THRESHOLD,
};
pub use manifest::{
    plan_supersedes, PackManifest, KIND_FLAT_INDEX, KIND_GIT_PACK, KIND_OBJECT_LOCATOR,
};
pub use parse::{git_oid, GitObjType, PackObject, ParsedPack, OID_LEN};

/// Maximum bytes per byte-array field. Held below Platform's 5,120 B hard cap to
/// leave room for per-field CBOR/document overhead.
pub const FIELD_MAX: usize = 4_900;

/// Byte fields carried by a single `chunk` document (`data0..data2`).
pub const FIELDS_PER_DOC: usize = 3;

/// Hard cap on a whole signed state transition, in bytes.
pub const ST_SIZE_LIMIT: usize = 20_480;

/// Maximum raw payload a single chunk document can carry.
pub const DOC_PAYLOAD_MAX: usize = FIELD_MAX * FIELDS_PER_DOC;

/// Compile-time guarantee that a maximally packed chunk document leaves ≥ 5 KiB for
/// CBOR/document/signature overhead inside a single state transition (mirrors the
/// runtime `max_doc_payload_fits_st_with_headroom` test — this one can never regress
/// silently because the crate would fail to compile).
const _: () = assert!(DOC_PAYLOAD_MAX + 5_000 <= ST_SIZE_LIMIT);

/// One `chunk` document's worth of pack bytes: a sequence number and up to
/// [`FIELDS_PER_DOC`] fields, each at most [`FIELD_MAX`] bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Chunk {
    /// Zero-based position of this chunk within the pack (its ranged-fetch key).
    pub seq: u32,
    /// The `1..=FIELDS_PER_DOC` non-empty byte fields making up this chunk.
    pub fields: Vec<Vec<u8>>,
}

impl Chunk {
    /// Total raw payload bytes carried by this chunk (sum of its field lengths).
    pub fn payload_len(&self) -> usize {
        self.fields.iter().map(Vec::len).sum()
    }
}

/// Split a contiguous pack byte stream into ordered [`Chunk`]s.
///
/// An empty input yields no chunks. Fields are filled to [`FIELD_MAX`] before a new
/// field is started, and [`FIELDS_PER_DOC`] full fields before a new chunk is started,
/// so every chunk except possibly the last is maximally packed.
pub fn split(data: &[u8]) -> Vec<Chunk> {
    if data.is_empty() {
        return Vec::new();
    }

    let mut chunks = Vec::new();
    let mut fields: Vec<Vec<u8>> = Vec::with_capacity(FIELDS_PER_DOC);
    let mut seq: u32 = 0;

    for field in data.chunks(FIELD_MAX) {
        fields.push(field.to_vec());
        if fields.len() == FIELDS_PER_DOC {
            chunks.push(Chunk {
                seq,
                fields: std::mem::take(&mut fields),
            });
            seq += 1;
        }
    }

    if !fields.is_empty() {
        chunks.push(Chunk { seq, fields });
    }

    chunks
}

/// Reassemble the original byte stream from ordered chunks.
///
/// Chunks are concatenated in slice order; callers are responsible for supplying
/// them sorted by [`Chunk::seq`].
pub fn join(chunks: &[Chunk]) -> Vec<u8> {
    let total: usize = chunks.iter().map(Chunk::payload_len).sum();
    let mut out = Vec::with_capacity(total);
    for chunk in chunks {
        for field in &chunk.fields {
            out.extend_from_slice(field);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::{join, split, Chunk, DOC_PAYLOAD_MAX, FIELDS_PER_DOC, FIELD_MAX, ST_SIZE_LIMIT};

    fn ramp(n: usize) -> Vec<u8> {
        (0..n).map(|i| u8::try_from(i % 256).unwrap()).collect()
    }

    #[test]
    fn empty_input_yields_no_chunks() {
        assert!(split(&[]).is_empty());
        assert!(join(&[]).is_empty());
    }

    #[test]
    fn round_trip_various_sizes() {
        // Boundaries around one field, one full doc, and several docs.
        let sizes = [
            1,
            FIELD_MAX - 1,
            FIELD_MAX,
            FIELD_MAX + 1,
            DOC_PAYLOAD_MAX - 1,
            DOC_PAYLOAD_MAX,
            DOC_PAYLOAD_MAX + 1,
            DOC_PAYLOAD_MAX * 3 + 123,
        ];
        for &n in &sizes {
            let data = ramp(n);
            let chunks = split(&data);
            assert_eq!(join(&chunks), data, "round-trip failed for {n} bytes");
        }
    }

    #[test]
    fn sequence_numbers_are_contiguous_from_zero() {
        let data = ramp(DOC_PAYLOAD_MAX * 3 + 7);
        let chunks = split(&data);
        for (i, chunk) in chunks.iter().enumerate() {
            assert_eq!(chunk.seq as usize, i);
        }
    }

    #[test]
    fn every_field_and_chunk_respects_bounds() {
        let data = ramp(DOC_PAYLOAD_MAX * 4 + 512);
        let chunks = split(&data);
        for chunk in &chunks {
            assert!(!chunk.fields.is_empty());
            assert!(chunk.fields.len() <= FIELDS_PER_DOC);
            for field in &chunk.fields {
                assert!(!field.is_empty());
                assert!(field.len() <= FIELD_MAX);
            }
            // The document payload must fit inside a single state transition.
            assert!(chunk.payload_len() <= DOC_PAYLOAD_MAX);
            assert!(chunk.payload_len() <= ST_SIZE_LIMIT);
        }
    }

    #[test]
    fn last_chunk_holds_the_remainder() {
        let data = ramp(DOC_PAYLOAD_MAX + FIELD_MAX + 10);
        let chunks = split(&data);
        assert_eq!(chunks.len(), 2);
        // First chunk is maximally packed.
        assert_eq!(chunks[0].fields.len(), FIELDS_PER_DOC);
        assert_eq!(chunks[0].payload_len(), DOC_PAYLOAD_MAX);
        // Second chunk holds one full field plus a 10-byte tail.
        assert_eq!(chunks[1].fields.len(), 2);
        assert_eq!(chunks[1].payload_len(), FIELD_MAX + 10);
    }

    #[test]
    fn max_doc_payload_fits_st_with_headroom() {
        // The frozen 3×4900 = 14700 B payload (S0.2) must sit comfortably below the
        // 20 KiB ST cap, leaving room for CBOR/document/signature overhead.
        assert_eq!(DOC_PAYLOAD_MAX, 14_700);
        let headroom = ST_SIZE_LIMIT - DOC_PAYLOAD_MAX;
        assert!(headroom >= 5_000, "headroom {headroom} too small");
    }

    #[test]
    fn reconstructed_size_matches_input() {
        let data = ramp(DOC_PAYLOAD_MAX * 2 + 777);
        let chunks = split(&data);
        let rebuilt = join(&chunks);
        assert_eq!(rebuilt.len(), data.len());
        assert_eq!(rebuilt, data);
    }

    #[test]
    fn join_is_order_sensitive_but_seq_labelled() {
        let a = Chunk {
            seq: 0,
            fields: vec![vec![1, 2, 3]],
        };
        let b = Chunk {
            seq: 1,
            fields: vec![vec![4, 5]],
        };
        assert_eq!(join(&[a, b]), vec![1, 2, 3, 4, 5]);
    }
}
