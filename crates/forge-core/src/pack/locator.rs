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

/// The prefix rows sort by: the oid, then `packRef` big-endian — `(oid, packRef)` order.
const SORT_KEY_LEN: usize = OID_LEN + 2;

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
    /// **Rows are keyed by `(oid, packRef)`, not by `oid`.** An object routinely sits in
    /// more than one live pack — a push whose `have` set was incomplete re-sends history an
    /// earlier pack already holds — and each copy's row is the only record of that pack's
    /// address for it. The locator is not just an OID→entry map: a reader resolving an
    /// `OFS_DELTA` base looks it up by `(packRef, offset)`, and the base of an object in
    /// pack N is always in pack N. Dropping the pack-N row because pack 0 also carried the
    /// object leaves every delta in pack N that uses it unreadable. So every copy is kept
    /// and only exact `(oid, packRef)` duplicates collapse, which keeps the fold idempotent.
    /// [`Self::lookup`] returns the lowest-`packRef` copy, so which pack an OID resolves to
    /// does not change as fragments accumulate.
    pub fn merge(parts: &[&Self]) -> Self {
        // Rows sort by their first SORT_KEY_LEN bytes, which IS the (oid, packRef) order, so a
        // plain byte comparison drives the k-way merge.
        const KEY: usize = SORT_KEY_LEN;
        let total = parts.iter().map(|p| p.count).sum();
        let mut cursors = vec![0usize; parts.len()];
        let mut merged: Vec<[u8; LOCATOR_ROW_LEN]> = Vec::with_capacity(total);
        loop {
            let mut pick: Option<usize> = None;
            for (i, part) in parts.iter().enumerate() {
                if cursors[i] >= part.count {
                    continue;
                }
                let better = match pick {
                    None => true,
                    Some(j) => part.row(cursors[i])[..KEY] < parts[j].row(cursors[j])[..KEY],
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
            // Collapse only exact (oid, packRef) duplicates — the same pack indexed twice.
            for (j, part) in parts.iter().enumerate() {
                while cursors[j] < part.count && part.row(cursors[j])[..KEY] == row[..KEY] {
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
        self.pack_ref_iter().max()
    }

    /// Every row's `packRef` (with repeats): the packs this locator covers, as forge-web's
    /// `packRefsCovered` collects them to decide whether a repository reads as fully indexed.
    pub fn pack_ref_iter(&self) -> impl Iterator<Item = u16> + '_ {
        (0..self.count).map(|i| {
            u16::from_be_bytes(
                self.row(i)[OFF_PACKREF..OFF_PACKREF + 2]
                    .try_into()
                    .expect("fixed-width row"),
            )
        })
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
    ///
    /// Refuses a fanout that does not describe its rows: every entry is the cumulative row
    /// count through that first byte, so the counts never fall and end at the row count, the
    /// rows each bucket brackets all start with its byte, and the rows are in `(oid, packRef)`
    /// order. [`Self::lookup`] and [`Self::merge`] index rows by those counts.
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        let bad = |what: &str| Error::Config(format!("locator {what}"));
        if bytes.len() < FANOUT_LEN {
            return Err(bad("shorter than fanout"));
        }
        let fanout = |b: usize| {
            u32::from_be_bytes(bytes[b * 4..b * 4 + 4].try_into().expect("4 bytes")) as usize
        };
        let count = fanout(255);
        if count
            .checked_mul(LOCATOR_ROW_LEN)
            .and_then(|n| n.checked_add(FANOUT_LEN))
            != Some(bytes.len())
        {
            return Err(bad("length inconsistent with fanout"));
        }
        let row = |i: usize| &bytes[FANOUT_LEN + i * LOCATOR_ROW_LEN..][..LOCATOR_ROW_LEN];
        let mut lo = 0;
        for b in 0..256 {
            let hi = fanout(b);
            if !(lo..=count).contains(&hi) {
                return Err(bad("fanout is not cumulative"));
            }
            if (lo..hi).any(|i| usize::from(row(i)[0]) != b) {
                return Err(bad("row outside its fanout bucket"));
            }
            lo = hi;
        }
        if (1..count).any(|i| row(i - 1)[..SORT_KEY_LEN] > row(i)[..SORT_KEY_LEN]) {
            return Err(bad("rows out of order"));
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
                std::cmp::Ordering::Equal => {
                    // A merged locator can hold one row per pack that stores this OID
                    // ([`Self::merge`]). They are adjacent and ordered by `packRef`, so
                    // walking back to the first makes the answer the lowest-`packRef` copy
                    // regardless of where the binary search landed.
                    let mut at = mid;
                    while at > 0 && self.row(at - 1)[..OID_LEN] == *oid {
                        at -= 1;
                    }
                    return Some(decode_row(self.row(at)));
                }
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

#[cfg(test)]
mod tests {
    use super::{ObjectLocator, FANOUT_LEN, LOCATOR_ROW_LEN, OID_LEN};
    use crate::pack::TestRng;

    /// A row for `oid` in pack `pack_ref`, the rest of it `fill`.
    fn row(oid: [u8; OID_LEN], pack_ref: u16, fill: u8) -> [u8; LOCATOR_ROW_LEN] {
        let mut r = [fill; LOCATOR_ROW_LEN];
        r[..OID_LEN].copy_from_slice(&oid);
        r[OID_LEN..OID_LEN + 2].copy_from_slice(&pack_ref.to_be_bytes());
        r
    }

    /// `fanout || rows` exactly as written, fanout entries taken as given.
    fn raw(fanout: &[u32; 256], rows: &[[u8; LOCATOR_ROW_LEN]]) -> Vec<u8> {
        let mut out: Vec<u8> = fanout.iter().flat_map(|f| f.to_be_bytes()).collect();
        for r in rows {
            out.extend(r);
        }
        out
    }

    #[test]
    fn a_fanout_past_the_row_count_is_refused() {
        // Bucket 0 claims a row, the total says there are none.
        let mut fanout = [0u32; 256];
        fanout[0] = 1;
        assert!(ObjectLocator::parse(&raw(&fanout, &[])).is_err());
    }

    #[test]
    fn a_falling_fanout_is_refused() {
        let mut fanout = [1u32; 256];
        fanout[0] = 2;
        let rows = [row([0; OID_LEN], 0, 0)];
        assert!(ObjectLocator::parse(&raw(&fanout, &rows)).is_err());
    }

    #[test]
    fn a_row_outside_its_bucket_is_refused() {
        // Counted in bucket 0 but its oid starts with 5.
        let fanout = [1u32; 256];
        let rows = [row([5; OID_LEN], 0, 0)];
        assert!(ObjectLocator::parse(&raw(&fanout, &rows)).is_err());
    }

    #[test]
    fn rows_out_of_order_are_refused() {
        let fanout = [2u32; 256];
        let mut hi = [0u8; OID_LEN];
        hi[1] = 9;
        let rows = [row(hi, 0, 0), row([0; OID_LEN], 0, 0)];
        assert!(ObjectLocator::parse(&raw(&fanout, &rows)).is_err());
        // The same oid twice, packRef descending, is out of (oid, packRef) order too.
        let rows = [row([0; OID_LEN], 1, 0), row([0; OID_LEN], 0, 0)];
        assert!(ObjectLocator::parse(&raw(&fanout, &rows)).is_err());
    }

    #[test]
    fn a_written_locator_parses_and_looks_up() {
        let mut rows = vec![
            row([0; OID_LEN], 0, 1),
            row([0; OID_LEN], 3, 2),
            row([7; OID_LEN], 0, 3),
            row([255; OID_LEN], 1, 4),
        ];
        rows.sort_unstable();
        let built = ObjectLocator::from_sorted_rows(&rows);
        let parsed = ObjectLocator::parse(built.as_bytes()).unwrap();
        assert_eq!(parsed.object_count(), 4);
        assert_eq!(parsed.lookup(&[0; OID_LEN]).unwrap().pack_ref, 0);
        assert_eq!(parsed.lookup(&[255; OID_LEN]).unwrap().pack_ref, 1);
        assert!(parsed.lookup(&[8; OID_LEN]).is_none());
        assert!(ObjectLocator::parse(&built.as_bytes()[..=FANOUT_LEN]).is_err());
    }

    #[test]
    fn random_locators_never_panic_lookup_or_merge() {
        let mut rng = TestRng(0x2545_f491_4f6c_dd1d);
        for _ in 0..3000 {
            let count = rng.below(6);
            let mut rows: Vec<[u8; LOCATOR_ROW_LEN]> = (0..count)
                .map(|_| {
                    let mut oid = [0u8; OID_LEN];
                    oid[0] = u8::try_from(rng.below(4)).unwrap();
                    oid[1] = rng.byte();
                    row(oid, u16::from(rng.byte() % 3), rng.byte())
                })
                .collect();
            rows.sort_unstable();
            let mut bytes = ObjectLocator::from_sorted_rows(&rows).as_bytes().to_vec();
            // Corrupt a few fanout entries or row bytes, keeping the total length.
            for _ in 0..rng.below(3) {
                if rng.below(2) == 0 {
                    let b = rng.below(256);
                    let v = u32::try_from(rng.below(count + 3)).unwrap();
                    bytes[b * 4..b * 4 + 4].copy_from_slice(&v.to_be_bytes());
                } else if bytes.len() > FANOUT_LEN {
                    let at = FANOUT_LEN + rng.below(bytes.len() - FANOUT_LEN);
                    bytes[at] = rng.byte();
                }
            }
            let Ok(loc) = ObjectLocator::parse(&bytes) else {
                continue;
            };
            for b in 0..4u8 {
                let mut oid = [b; OID_LEN];
                oid[1] = rng.byte();
                let _ = loc.lookup(&oid);
            }
            let _ = loc.max_pack_ref();
            let merged = ObjectLocator::merge(&[&loc, &loc]);
            assert!(ObjectLocator::parse(merged.as_bytes()).is_ok());
        }
    }
}
