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
    /// The pack **must be locator-quality**: the single contiguous `deltaChainSpan` read is
    /// only sound when every delta base sits earlier in the same pack. Both producers in
    /// [`crate::pack::build`] emit such packs and check it on the way out, so the push pack
    /// and the repack pack alike are accepted. A pack completed with `index-pack
    /// --fix-thin` is not: its external bases are appended *after* the deltas that reference
    /// them, so a reader would see a small span, single-read it, and miss the base. Such a
    /// pack (anything an older client stored) is rejected here rather than indexed by a
    /// locator that lies about read safety.
    pub fn build(pack: &ParsedPack, pack_ref: u16) -> Result<Self> {
        Ok(Self::from_sorted_rows(&rows_for(pack, pack_ref)?))
    }

    /// Merge published locators into one — the index-consolidation step.
    ///
    /// The browse index is published in fragments: a push adds a pack and publishes a
    /// locator over just that pack (cost proportional to the push, not to the repo), so a
    /// reader normally merges several. When the fragment count gets high enough to make
    /// that fan-out the dominant read cost, the writer folds them into one with this and
    /// supersedes the parts.
    ///
    /// Sound only when every part indexes the same `packRef` space, or a prefix of it —
    /// which holds because the live pack list only ever grows at the end between repacks,
    /// and a repack supersedes every locator it consolidates.
    /// `RepoService::publish_push_locator` establishes that before calling.
    ///
    /// `parts` are oldest-first and an OID present in more than one keeps its EARLIEST row.
    /// Every part is live, so either row reads correctly; preferring the earliest means a
    /// consolidation never silently moves a reader onto different bytes for an object it
    /// could already fetch.
    pub fn merge(parts: &[&Self]) -> Self {
        let total = parts.iter().map(|p| p.count).sum();
        let mut cursors = vec![0usize; parts.len()];
        let mut merged: Vec<[u8; LOCATOR_ROW_LEN]> = Vec::with_capacity(total);
        loop {
            // Smallest remaining OID across the parts; ties resolve to the earliest part.
            let mut pick: Option<usize> = None;
            for (i, part) in parts.iter().enumerate() {
                if cursors[i] >= part.count {
                    continue;
                }
                let better = match pick {
                    None => true,
                    Some(j) => {
                        part.row(cursors[i])[..OID_LEN] < parts[j].row(cursors[j])[..OID_LEN]
                    }
                };
                if better {
                    pick = Some(i);
                }
            }
            let Some(i) = pick else { break };
            let row: [u8; LOCATOR_ROW_LEN] = parts[i]
                .row(cursors[i])
                .try_into()
                .expect("fixed-width row");
            cursors[i] += 1;
            // Drop every other part's row for the same OID.
            for (j, part) in parts.iter().enumerate() {
                while cursors[j] < part.count && part.row(cursors[j])[..OID_LEN] == row[..OID_LEN] {
                    cursors[j] += 1;
                }
            }
            merged.push(row);
        }
        Self::from_sorted_rows(&merged)
    }

    /// The largest `packRef` any row carries — `None` for an empty locator. Lets a caller
    /// check a locator against the pack space it claims to index before trusting it.
    pub fn max_pack_ref(&self) -> Option<u16> {
        (0..self.count)
            .map(|i| {
                u16::from_be_bytes(
                    self.row(i)[OFF_PACKREF..OFF_PACKREF + 2]
                        .try_into()
                        .expect("fixed-width row"),
                )
            })
            .max()
    }

    /// Assemble `fanout || rows` from rows already sorted ascending by OID.
    fn from_sorted_rows(rows: &[[u8; LOCATOR_ROW_LEN]]) -> Self {
        let mut fanout = [0u32; 256];
        for r in rows {
            fanout[r[0] as usize] += 1;
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
        for r in rows {
            bytes.extend_from_slice(r);
        }
        Self {
            bytes,
            count: rows.len(),
        }
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
            let mid = usize::midpoint(lo, hi);
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

/// One pack's locator rows, sorted ascending by OID and tagged with `pack_ref`.
///
/// Rejects a pack the single-span read model cannot describe, for the reason spelled out on
/// [`ObjectLocator::build`]. As defense-in-depth a non-contiguous object that somehow
/// reached serialization is written with [`SPAN_SENTINEL`], so the wire format still
/// self-signals the hazard to a reader that never saw the source pack.
fn rows_for(pack: &ParsedPack, pack_ref: u16) -> Result<Vec<[u8; LOCATOR_ROW_LEN]>> {
    let refs = pack.ref_delta_count();
    let noncontig = pack.objects.iter().filter(|o| !o.contiguous).count();
    if refs > 0 || noncontig > 0 {
        return Err(Error::Config(format!(
            "objectLocator requires a self-contained repacked pack \
             (found {refs} REF_DELTA + {noncontig} non-contiguous objects); \
             build it from repack_all output"
        )));
    }

    let mut objects: Vec<&super::parse::PackObject> = pack.objects.iter().collect();
    objects.sort_by_key(|a| a.oid);

    let mut rows = Vec::with_capacity(objects.len());
    for o in objects {
        let span = if o.contiguous {
            sat_u32(o.delta_chain_span)
        } else {
            SPAN_SENTINEL
        };
        let mut row = [0u8; LOCATOR_ROW_LEN];
        row[..OID_LEN].copy_from_slice(&o.oid);
        row[OFF_PACKREF..OFF_PACKREF + 2].copy_from_slice(&pack_ref.to_be_bytes());
        row[OFF_OFFSET..OFF_OFFSET + 5].copy_from_slice(&u40_be(o.offset)?);
        row[OFF_LENGTH..OFF_LENGTH + 4].copy_from_slice(&sat_u32(o.length).to_be_bytes());
        row[OFF_SPAN..OFF_SPAN + 4].copy_from_slice(&span.to_be_bytes());
        row[OFF_HINT] = u8::try_from(o.delta_depth).unwrap_or(u8::MAX);
        rows.push(row);
    }
    Ok(rows)
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
