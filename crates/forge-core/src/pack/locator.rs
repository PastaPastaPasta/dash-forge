//! The `objectLocator` browse artifact (git MIDX analog): a fanout header plus
//! OID-sorted fixed-width rows, so a single-object lookup is the header plus one
//! ~1/256 slice — `O(1/256)` of the index (data-contracts §2.3, S0.5-confirmed).
//!
//! Row layout (S0.5-corrected widths, 36 B/object):
//!
//! | field            | width | notes                                             |
//! |------------------|-------|---------------------------------------------------|
//! | `oid`            | 20 B  | SHA-1                                              |
//! | `packRef`        | 2 B   | index into the manifest's pack list (u16 BE)      |
//! | `offset`         | 5 B   | byte offset in the pack (BE; up to 1 TB)          |
//! | `length`         | 4 B   | on-disk object length (u32 BE, saturating)        |
//! | `deltaChainSpan` | 4 B   | contiguous span covering the object + its chain   |
//! | `deltaHint`      | 1 B   | chain depth (saturating) — the per-base fallback  |
//!
//! `deltaChainSpan` is a **fixed** 4-byte field, not a varint: fixed-stride rows are
//! what make the fanout-slice binary search a flat seek. 4 bytes covers the observed
//! 107 MB maximum span. Reader rule (normative): use the single contiguous span read
//! when `span <= SPAN_SINGLE_READ_THRESHOLD` (blobs, median 1.21× over-fetch), else
//! walk each delta base individually via `deltaHint` (trees over-fetch catastrophically
//! under a single span — root tree measured 212×).

use super::parse::{ParsedPack, OID_LEN};
use crate::error::{Error, Result};

/// Fixed row width of the locator, in bytes.
pub const LOCATOR_ROW_LEN: usize = OID_LEN + 2 + 5 + 4 + 4 + 1; // 36

/// Byte length of the fanout header (256 cumulative u32 counts).
pub const FANOUT_LEN: usize = 256 * 4;

/// Span at or below which a single contiguous ranged read is advised (≈ 64 KiB).
/// Above it, readers fall back to the per-base delta-chain walk.
pub const SPAN_SINGLE_READ_THRESHOLD: u64 = 64 * 1024;

/// Sentinel `deltaChainSpan` meaning "this object's chain is **not** a single
/// contiguous range — never single-read it, walk each base via `deltaHint`". Encoded
/// for any non-contiguous object so the wire format itself signals the hazard even to
/// a reader that never saw the source pack. `u32::MAX` is safe as a real span too
/// (any object that large already exceeds the single-read threshold).
pub const SPAN_SENTINEL: u32 = u32::MAX;

const OFF_PACKREF: usize = OID_LEN;
const OFF_OFFSET: usize = OFF_PACKREF + 2;
const OFF_LENGTH: usize = OFF_OFFSET + 5;
const OFF_SPAN: usize = OFF_LENGTH + 4;
const OFF_HINT: usize = OFF_SPAN + 4;

/// One decoded locator row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LocatorEntry {
    /// Index into the manifest's pack list.
    pub pack_ref: u16,
    /// Byte offset of the object within its pack.
    pub offset: u64,
    /// On-disk object length.
    pub length: u32,
    /// Contiguous span covering the object and its whole (contiguous) delta chain.
    pub delta_chain_span: u32,
    /// Delta chain depth hint (0 = non-delta base).
    pub delta_depth: u8,
}

impl LocatorEntry {
    /// Whether a single contiguous span read is advised (span within threshold and
    /// not the non-contiguous [`SPAN_SENTINEL`]). Blobs almost always qualify;
    /// deep-delta trees and non-contiguous objects do not and take the per-base walk
    /// keyed off [`Self::delta_depth`].
    pub fn single_read_advised(&self) -> bool {
        self.delta_chain_span != SPAN_SENTINEL
            && u64::from(self.delta_chain_span) <= SPAN_SINGLE_READ_THRESHOLD
    }
}

/// A serialized `objectLocator`: `fanout(1024 B) || rows`.
#[derive(Debug)]
pub struct ObjectLocator {
    bytes: Vec<u8>,
    count: usize,
}

impl ObjectLocator {
    /// Build a locator over one pack's objects. `pack_ref` is the pack's position in
    /// the owning manifest's pack list.
    ///
    /// The pack **must be self-contained and repack-quality**: the single contiguous
    /// `deltaChainSpan` read is only sound when every delta base sits earlier in the
    /// same pack (the `repack -adf` invariant). A pack straight off the push path
    /// carries `REF_DELTA` objects whose fix-thin'd bases were appended *after* them —
    /// a reader would see a small span, single-read it, and miss the base. This errors
    /// on any such pack rather than emit a locator that lies about read safety. Feed it
    /// [`repack_all`](super::repack_all) output. As defense-in-depth, if a
    /// non-contiguous object ever reaches serialization its span is written as
    /// [`SPAN_SENTINEL`] so the wire format still self-signals the hazard.
    pub fn build(pack: &ParsedPack, pack_ref: u16) -> Result<Self> {
        let refs = pack.ref_delta_count();
        let noncontig = pack.objects.iter().filter(|o| !o.contiguous).count();
        if refs > 0 || noncontig > 0 {
            return Err(Error::Config(format!(
                "objectLocator requires a self-contained repacked pack \
                 (found {refs} REF_DELTA + {noncontig} non-contiguous objects); \
                 build it from repack_all output"
            )));
        }

        let mut rows: Vec<&super::parse::PackObject> = pack.objects.iter().collect();
        rows.sort_by(|a, b| a.oid.cmp(&b.oid));

        let mut fanout = [0u32; 256];
        for o in &rows {
            fanout[o.oid[0] as usize] += 1;
        }
        let mut cum = 0u32;
        for f in &mut fanout {
            cum += *f;
            *f = cum;
        }

        let mut bytes = Vec::with_capacity(FANOUT_LEN + rows.len() * LOCATOR_ROW_LEN);
        for f in fanout {
            bytes.extend_from_slice(&f.to_be_bytes());
        }
        for o in &rows {
            // Non-contiguous objects (unreachable given the guard above, but the wire
            // format is defined to be safe on its own) carry the sentinel span.
            let span = if o.contiguous {
                sat_u32(o.delta_chain_span)
            } else {
                SPAN_SENTINEL
            };
            bytes.extend_from_slice(&o.oid);
            bytes.extend_from_slice(&pack_ref.to_be_bytes());
            bytes.extend_from_slice(&u40_be(o.offset)?);
            bytes.extend_from_slice(&sat_u32(o.length).to_be_bytes());
            bytes.extend_from_slice(&span.to_be_bytes());
            bytes.push(u8::try_from(o.delta_depth).unwrap_or(u8::MAX));
        }
        Ok(Self {
            bytes,
            count: rows.len(),
        })
    }

    /// Serialized bytes (the artifact to chunk/upload).
    pub fn as_bytes(&self) -> &[u8] {
        &self.bytes
    }

    /// Number of rows.
    pub fn object_count(&self) -> usize {
        self.count
    }

    /// Whether the locator has no rows.
    pub fn is_empty(&self) -> bool {
        self.count == 0
    }

    /// Parse a serialized locator for reading.
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        if bytes.len() < FANOUT_LEN {
            return Err(Error::Config("locator shorter than fanout".into()));
        }
        let count = u32::from_be_bytes(bytes[255 * 4..256 * 4].try_into().unwrap()) as usize;
        if bytes.len() != FANOUT_LEN + count * LOCATOR_ROW_LEN {
            return Err(Error::Config(
                "locator length inconsistent with fanout".into(),
            ));
        }
        Ok(Self {
            bytes: bytes.to_vec(),
            count,
        })
    }

    /// Look up an object: read the fanout, take the one 1/256 slice for the OID's
    /// first byte, and binary-search it. This is the `O(1/256)` browse-plane lookup.
    pub fn lookup(&self, oid: &[u8]) -> Option<LocatorEntry> {
        if oid.len() != OID_LEN {
            return None;
        }
        let b = oid[0] as usize;
        let mut lo = if b == 0 { 0 } else { self.fanout(b - 1) };
        let mut hi = self.fanout(b);
        while lo < hi {
            let mid = (lo + hi) / 2;
            let row = self.row(mid);
            match row[..OID_LEN].cmp(oid) {
                std::cmp::Ordering::Less => lo = mid + 1,
                std::cmp::Ordering::Greater => hi = mid,
                std::cmp::Ordering::Equal => return Some(decode_row(row)),
            }
        }
        None
    }

    fn fanout(&self, byte: usize) -> usize {
        u32::from_be_bytes(self.bytes[byte * 4..byte * 4 + 4].try_into().unwrap()) as usize
    }

    fn row(&self, i: usize) -> &[u8] {
        let s = FANOUT_LEN + i * LOCATOR_ROW_LEN;
        &self.bytes[s..s + LOCATOR_ROW_LEN]
    }
}

fn decode_row(row: &[u8]) -> LocatorEntry {
    let pack_ref = u16::from_be_bytes(row[OFF_PACKREF..OFF_PACKREF + 2].try_into().unwrap());
    let mut off = [0u8; 8];
    off[3..8].copy_from_slice(&row[OFF_OFFSET..OFF_OFFSET + 5]);
    let offset = u64::from_be_bytes(off);
    let length = u32::from_be_bytes(row[OFF_LENGTH..OFF_LENGTH + 4].try_into().unwrap());
    let delta_chain_span = u32::from_be_bytes(row[OFF_SPAN..OFF_SPAN + 4].try_into().unwrap());
    let delta_depth = row[OFF_HINT];
    LocatorEntry {
        pack_ref,
        offset,
        length,
        delta_chain_span,
        delta_depth,
    }
}

/// Encode a value as 5 big-endian bytes, erroring above the 1 TB field ceiling.
fn u40_be(v: u64) -> Result<[u8; 5]> {
    if v > 0xff_ffff_ffff {
        return Err(Error::Config(
            "pack offset exceeds 5-byte locator field".into(),
        ));
    }
    let b = v.to_be_bytes();
    let mut out = [0u8; 5];
    out.copy_from_slice(&b[3..8]);
    Ok(out)
}

fn sat_u32(v: u64) -> u32 {
    u32::try_from(v).unwrap_or(u32::MAX)
}
