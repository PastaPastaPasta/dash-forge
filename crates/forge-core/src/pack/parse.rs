//! Direct git packfile + `.idx` (v2) parsing, object reconstruction, and hashing.
//!
//! **Why hand-parse instead of scraping `git verify-pack -v`?** Three reasons:
//!
//! 1. The browse plane's *single-contiguous-span* blob read (architecture §6.3)
//!    requires zlib-inflate + OFS/REF delta application over raw pack bytes to turn a
//!    ranged slice back into a git object. That decoder has to exist regardless, so
//!    the pack format is already parsed — reusing it for the index is free.
//! 2. The exact byte `offset` and on-disk `length` that the `objectLocator` stores
//!    come straight out of the `.idx` fanout/offset tables; no text parsing needed.
//! 3. `git verify-pack -v` prints the *resolved base OID* for every delta and does
//!    **not** distinguish `OFS_DELTA` from `REF_DELTA` — but that distinction is
//!    exactly what the `deltaChainSpan` contiguity guarantee turns on (OFS bases sit
//!    earlier in the same pack; a fix-thin'd REF base is appended *after*). Only the
//!    packfile type nibble carries it. `verify-pack` is therefore used only as an
//!    independent oracle in tests, never in the library path.
//!
//! SHA-1 object ids (20 bytes) are assumed — git's default. A SHA-256 `.idx`
//! (32-byte ids) is rejected with a clear error; SHA-256 repos are a documented v1
//! limitation, matching the `oid` width in the browse artifacts.

#![allow(clippy::cast_possible_truncation)]

use crate::error::{Error, Result};
use flate2::read::ZlibDecoder;
use sha1::{Digest as _, Sha1};
use sha2::Sha256;
use std::collections::HashMap;
use std::io::Read as _;

/// Raw byte length of a git SHA-1 object id.
pub const OID_LEN: usize = 20;

/// Trailing checksum length of a SHA-1 packfile (its final 20 bytes).
const PACK_TRAILER: usize = 20;

// Packfile object type codes (the 3-bit type nibble of the first header byte).
const T_COMMIT: u8 = 1;
const T_TREE: u8 = 2;
const T_BLOB: u8 = 3;
const T_TAG: u8 = 4;
const T_OFS_DELTA: u8 = 6;
const T_REF_DELTA: u8 = 7;

/// Final git object type, after any delta chain is resolved to its base.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GitObjType {
    /// A commit object.
    Commit,
    /// A tree object.
    Tree,
    /// A blob object.
    Blob,
    /// An annotated tag object.
    Tag,
}

impl GitObjType {
    fn from_code(code: u8) -> Result<Self> {
        match code {
            T_COMMIT => Ok(Self::Commit),
            T_TREE => Ok(Self::Tree),
            T_BLOB => Ok(Self::Blob),
            T_TAG => Ok(Self::Tag),
            other => Err(Error::Config(format!("non-base pack object type {other}"))),
        }
    }

    /// The loose-object header keyword git prefixes before the payload when hashing.
    fn header_keyword(self) -> &'static str {
        match self {
            Self::Commit => "commit",
            Self::Tree => "tree",
            Self::Blob => "blob",
            Self::Tag => "tag",
        }
    }
}

/// One object as located in a single packfile, with its delta geometry resolved.
#[derive(Debug, Clone)]
pub struct PackObject {
    /// The object's git OID (SHA-1, 20 bytes).
    pub oid: [u8; OID_LEN],
    /// Byte offset of the object header within the packfile.
    pub offset: u64,
    /// On-disk bytes the object occupies in the pack (header + compressed payload).
    pub length: u64,
    /// Resolved base type (a delta reports the type of its chain root).
    pub obj_type: GitObjType,
    /// Number of delta hops from this object down to its non-delta base (0 = base).
    pub delta_depth: u32,
    /// `true` when this object is stored as a `REF_DELTA` (base referenced by OID).
    pub is_ref_delta: bool,
    /// The single contiguous byte span `[earliest_base.offset, self.end)` that a
    /// reader can range-read to recover this object *and* its whole delta chain.
    ///
    /// Sound only when the chain is [`Self::contiguous`] (all bases earlier in the
    /// pack — the post-`repack` invariant). When not contiguous this collapses to the
    /// object's own on-disk length and readers must walk bases individually.
    pub delta_chain_span: u64,
    /// Whether every base in the chain sits at a strictly lower offset (so the span
    /// is a valid single read). Always true after a `repack -adf`.
    pub contiguous: bool,
}

impl PackObject {
    /// Absolute end offset of the object within the pack (`offset + length`).
    pub fn end(&self) -> u64 {
        self.offset + self.length
    }
}

/// A fully parsed packfile: object geometry, the raw bytes (for reconstruction), and
/// the SHA-256 `packHash` the manifest stores.
#[derive(Debug)]
pub struct ParsedPack {
    pack_bytes: Vec<u8>,
    /// SHA-256 of the entire packfile — the `packManifest.packHash`.
    pub pack_hash: [u8; 32],
    /// Objects in `.idx` order (ascending OID).
    pub objects: Vec<PackObject>,
    oid_to_idx: HashMap<[u8; OID_LEN], usize>,
}

/// Immediate delta base of a pack object, before chain resolution.
enum RawBase {
    /// Not a delta.
    None,
    /// `OFS_DELTA`: base is `offset - rel` in the same pack.
    Ofs(u64),
    /// `REF_DELTA`: base referenced by OID (resolved to an offset in a later pass).
    Ref([u8; OID_LEN]),
}

impl ParsedPack {
    /// Parse a packfile and its v2 `.idx`, resolving every object's type and delta
    /// span. Verifies the `.idx` magic/version and that ids are 20-byte SHA-1.
    pub fn parse(pack_bytes: &[u8], idx_bytes: &[u8]) -> Result<Self> {
        let (oids, offsets) = parse_idx_v2(idx_bytes)?;
        let n = oids.len();
        let pack_len = pack_bytes.len();
        if pack_len < PACK_TRAILER {
            return Err(Error::Config("packfile shorter than its trailer".into()));
        }

        // On-disk length per object = gap to the next-higher offset (last runs to the
        // start of the 20-byte pack trailer).
        let mut order: Vec<usize> = (0..n).collect();
        order.sort_by_key(|&i| offsets[i]);
        let mut length = vec![0u64; n];
        for (k, &i) in order.iter().enumerate() {
            let end = order
                .get(k + 1)
                .map_or((pack_len - PACK_TRAILER) as u64, |&j| offsets[j]);
            length[i] = end
                .checked_sub(offsets[i])
                .ok_or_else(|| Error::Config("overlapping pack offsets".into()))?;
        }

        // First pass: header type + immediate base.
        let mut raw_type = vec![0u8; n];
        let mut base = Vec::with_capacity(n);
        for i in 0..n {
            let off = usize::try_from(offsets[i])
                .map_err(|_| Error::Config("pack offset exceeds usize".into()))?;
            let (t, _size, after) = parse_obj_header(pack_bytes, off)?;
            raw_type[i] = t;
            base.push(match t {
                T_OFS_DELTA => {
                    let (rel, _) = parse_ofs_base(pack_bytes, after)?;
                    let b = offsets[i]
                        .checked_sub(rel)
                        .ok_or_else(|| Error::Config("OFS base before pack start".into()))?;
                    RawBase::Ofs(b)
                }
                T_REF_DELTA => {
                    let end = after + OID_LEN;
                    let slice = pack_bytes
                        .get(after..end)
                        .ok_or_else(|| Error::Config("truncated REF_DELTA base oid".into()))?;
                    let mut oid = [0u8; OID_LEN];
                    oid.copy_from_slice(slice);
                    RawBase::Ref(oid)
                }
                _ => RawBase::None,
            });
        }

        let oid_to_idx: HashMap<[u8; OID_LEN], usize> =
            oids.iter().enumerate().map(|(i, o)| (*o, i)).collect();
        let off_to_idx: HashMap<u64, usize> =
            offsets.iter().enumerate().map(|(i, o)| (*o, i)).collect();

        // Resolve each immediate base to an in-pack offset (REF → OID lookup).
        let mut base_off: Vec<Option<u64>> = Vec::with_capacity(n);
        let mut is_ref = vec![false; n];
        for (i, b) in base.iter().enumerate() {
            base_off.push(match b {
                RawBase::None => None,
                RawBase::Ofs(o) => Some(*o),
                RawBase::Ref(oid) => {
                    is_ref[i] = true;
                    // A self-contained pack resolves the base internally. If it does
                    // not (a raw thin pack), the object has no in-pack base.
                    oid_to_idx.get(oid).map(|&j| offsets[j])
                }
            });
        }

        // Second pass: walk each chain for resolved type, depth, span, contiguity.
        let mut objects = Vec::with_capacity(n);
        for i in 0..n {
            let (obj_type, depth, span, contiguous) =
                resolve_chain(i, &offsets, &length, &raw_type, &base_off, &off_to_idx)?;
            objects.push(PackObject {
                oid: oids[i],
                offset: offsets[i],
                length: length[i],
                obj_type,
                delta_depth: depth,
                is_ref_delta: is_ref[i],
                delta_chain_span: span,
                contiguous,
            });
        }

        let pack_hash = {
            let mut h = Sha256::new();
            h.update(pack_bytes);
            h.finalize().into()
        };

        Ok(Self {
            pack_bytes: pack_bytes.to_vec(),
            pack_hash,
            objects,
            oid_to_idx,
        })
    }

    /// Number of objects in the pack.
    pub fn object_count(&self) -> usize {
        self.objects.len()
    }

    /// Count of `REF_DELTA` objects — expected to be `0` after `repack -adf`.
    pub fn ref_delta_count(&self) -> usize {
        self.objects.iter().filter(|o| o.is_ref_delta).count()
    }

    /// Look up an object by OID.
    pub fn object(&self, oid: &[u8]) -> Option<&PackObject> {
        let key: [u8; OID_LEN] = oid.try_into().ok()?;
        self.oid_to_idx.get(&key).map(|&i| &self.objects[i])
    }

    /// The raw packfile bytes (for slicing a ranged read in tests / callers).
    pub fn pack_bytes(&self) -> &[u8] {
        &self.pack_bytes
    }

    /// Reconstruct an object's full uncompressed bytes from the whole pack, resolving
    /// its delta chain (OFS or REF). Returns the base type and the payload.
    pub fn object_bytes(&self, oid: &[u8]) -> Result<(GitObjType, Vec<u8>)> {
        let obj = self.object(oid).ok_or(Error::NotFound)?;
        self.decode_at(&self.pack_bytes, 0, obj.offset, true)
    }

    /// Reconstruct an object from **only** the contiguous `deltaChainSpan` slice —
    /// the browse-plane single-read path. `span_slice` must be exactly the pack bytes
    /// `[obj.end - obj.delta_chain_span, obj.end)`. REF deltas are rejected here (the
    /// span model is only valid on self-contained, all-OFS repacked packs).
    pub fn reconstruct_from_span(
        &self,
        obj: &PackObject,
        span_slice: &[u8],
    ) -> Result<(GitObjType, Vec<u8>)> {
        if !obj.contiguous {
            return Err(Error::Config(
                "object chain is not contiguous; use the per-base walk".into(),
            ));
        }
        let base_addr = obj.end() - obj.delta_chain_span;
        if span_slice.len() as u64 != obj.delta_chain_span {
            return Err(Error::Config("span slice length mismatch".into()));
        }
        self.decode_at(span_slice, base_addr, obj.offset, false)
    }

    /// Reconstruct + hash every object and confirm each git OID matches the `.idx`.
    /// Returns the number of objects verified. `Err(Integrity)` on any mismatch.
    pub fn verify_all_oids(&self) -> Result<usize> {
        for obj in &self.objects {
            let (t, bytes) = self.object_bytes(&obj.oid)?;
            if git_oid(t, &bytes) != obj.oid {
                return Err(Error::Integrity);
            }
        }
        Ok(self.objects.len())
    }

    /// Decode the object at pack-absolute `abs_off`, where `buf[0]` corresponds to
    /// pack-absolute `base_addr`. Recurses into (earlier) delta bases within `buf`.
    fn decode_at(
        &self,
        buf: &[u8],
        base_addr: u64,
        abs_off: u64,
        allow_ref: bool,
    ) -> Result<(GitObjType, Vec<u8>)> {
        let pos = usize::try_from(abs_off - base_addr)
            .map_err(|_| Error::Config("offset exceeds usize".into()))?;
        let (t, size, after) = parse_obj_header(buf, pos)?;
        match t {
            T_COMMIT | T_TREE | T_BLOB | T_TAG => {
                let data = inflate(&buf[after..], size)?;
                Ok((GitObjType::from_code(t)?, data))
            }
            T_OFS_DELTA => {
                let (rel, dpos) = parse_ofs_base(buf, after)?;
                let base_abs = abs_off
                    .checked_sub(rel)
                    .ok_or_else(|| Error::Config("OFS base before pack start".into()))?;
                let (bt, base) = self.decode_at(buf, base_addr, base_abs, allow_ref)?;
                let delta = inflate(&buf[dpos..], size)?;
                Ok((bt, apply_delta(&base, &delta)?))
            }
            T_REF_DELTA => {
                if !allow_ref {
                    return Err(Error::Config(
                        "REF_DELTA in a span read (pack is not self-contained/OFS-only)".into(),
                    ));
                }
                let oid = &buf[after..after + OID_LEN];
                let (bt, base) = self.object_bytes(oid)?;
                let delta = inflate(&buf[after + OID_LEN..], size)?;
                Ok((bt, apply_delta(&base, &delta)?))
            }
            other => Err(Error::Config(format!("unknown pack object type {other}"))),
        }
    }
}

/// git OID of an object: `sha1("<type> <len>\0" + payload)`.
pub fn git_oid(t: GitObjType, payload: &[u8]) -> [u8; OID_LEN] {
    let mut h = Sha1::new();
    h.update(t.header_keyword().as_bytes());
    h.update(b" ");
    h.update(payload.len().to_string().as_bytes());
    h.update([0u8]);
    h.update(payload);
    h.finalize().into()
}

/// Parse a v2 `.idx`: returns `(oids, offsets)` in index (ascending-OID) order.
fn parse_idx_v2(idx: &[u8]) -> Result<(Vec<[u8; OID_LEN]>, Vec<u64>)> {
    const MAGIC: &[u8; 4] = b"\xfftOc";
    if idx.len() < 8 + 1024 || &idx[0..4] != MAGIC {
        return Err(Error::Config("not a v2 pack index".into()));
    }
    if u32::from_be_bytes(idx[4..8].try_into().unwrap()) != 2 {
        return Err(Error::Config("unsupported pack index version".into()));
    }
    let fanout_at = 8;
    let n = read_u32(idx, fanout_at + 255 * 4)? as usize;

    let oids_at = fanout_at + 256 * 4;
    let off32_at = oids_at + n * OID_LEN + n * 4; // after the oid + CRC tables
    let big_at = off32_at + n * 4;

    // The off32 table and both 20-byte trailers must fit under a SHA-1 layout before
    // we can safely scan for large offsets.
    if big_at + 2 * PACK_TRAILER > idx.len() {
        return Err(Error::Config(
            "pack index too short for its object count".into(),
        ));
    }

    // Count large-offset entries, then require the SHA-1 layout to reconcile to the
    // file length EXACTLY. A genuine SHA-256 index shares the magic + version 2 but
    // has 32-byte object ids and trailers, so it is always longer than this and never
    // reconciles — reject it with a clear message instead of misparsing downstream
    // (the old length check could not distinguish it from a valid larger index).
    let mut num_big = 0usize;
    for i in 0..n {
        if read_u32(idx, off32_at + i * 4)? & 0x8000_0000 != 0 {
            num_big += 1;
        }
    }
    let expected = 8
        + 1024
        + n as u64 * (OID_LEN as u64 + 4 + 4)
        + num_big as u64 * 8
        + 2 * PACK_TRAILER as u64;
    if expected != idx.len() as u64 {
        return Err(Error::Config(
            "pack index length does not match a SHA-1 v2 layout \
             (SHA-256 packs are unsupported in v1, or the index is corrupt)"
                .into(),
        ));
    }

    let mut oids = Vec::with_capacity(n);
    for i in 0..n {
        let s = oids_at + i * OID_LEN;
        let mut oid = [0u8; OID_LEN];
        oid.copy_from_slice(&idx[s..s + OID_LEN]);
        oids.push(oid);
    }

    let mut offsets = Vec::with_capacity(n);
    for i in 0..n {
        let v = read_u32(idx, off32_at + i * 4)?;
        if v & 0x8000_0000 != 0 {
            let j = (v & 0x7fff_ffff) as usize;
            offsets.push(read_u64(idx, big_at + j * 8)?);
        } else {
            offsets.push(u64::from(v));
        }
    }
    Ok((oids, offsets))
}

/// Parse an object header: returns `(type_code, decoded_size, pos_after_header)`.
fn parse_obj_header(buf: &[u8], pos: usize) -> Result<(u8, usize, usize)> {
    let mut p = pos;
    let mut c = *buf
        .get(p)
        .ok_or_else(|| Error::Config("truncated object header".into()))?;
    p += 1;
    let t = (c >> 4) & 7;
    let mut size = u64::from(c & 0x0f);
    let mut shift = 4u32;
    while c & 0x80 != 0 {
        c = *buf
            .get(p)
            .ok_or_else(|| Error::Config("truncated object size varint".into()))?;
        p += 1;
        size |= u64::from(c & 0x7f) << shift;
        shift += 7;
    }
    let size =
        usize::try_from(size).map_err(|_| Error::Config("object size exceeds usize".into()))?;
    Ok((t, size, p))
}

/// Parse an `OFS_DELTA` base back-pointer varint. Returns `(rel_offset, pos_after)`.
fn parse_ofs_base(buf: &[u8], pos: usize) -> Result<(u64, usize)> {
    let mut p = pos;
    let mut c = *buf
        .get(p)
        .ok_or_else(|| Error::Config("truncated OFS base varint".into()))?;
    p += 1;
    let mut ofs = u64::from(c & 0x7f);
    while c & 0x80 != 0 {
        c = *buf
            .get(p)
            .ok_or_else(|| Error::Config("truncated OFS base varint".into()))?;
        p += 1;
        ofs = ((ofs + 1) << 7) | u64::from(c & 0x7f);
    }
    Ok((ofs, p))
}

/// Inflate one zlib stream, asserting it yields exactly `expected` bytes.
fn inflate(compressed: &[u8], expected: usize) -> Result<Vec<u8>> {
    let mut d = ZlibDecoder::new(compressed);
    let mut out = Vec::with_capacity(expected);
    d.read_to_end(&mut out)
        .map_err(|e| Error::Io(e.to_string()))?;
    if out.len() != expected {
        return Err(Error::Integrity);
    }
    Ok(out)
}

/// Apply a git delta (`src_size, dst_size, [copy|insert]*`) to `base`.
fn apply_delta(base: &[u8], delta: &[u8]) -> Result<Vec<u8>> {
    let mut pos = 0usize;
    let _src = read_delta_size(delta, &mut pos)?;
    let dst = read_delta_size(delta, &mut pos)?;
    let mut out = Vec::with_capacity(dst);
    while pos < delta.len() {
        let op = delta[pos];
        pos += 1;
        if op & 0x80 != 0 {
            let mut cp_off = 0u64;
            for i in 0..4 {
                if op & (1 << i) != 0 {
                    cp_off |= u64::from(read_byte(delta, &mut pos)?) << (8 * i);
                }
            }
            let mut cp_size = 0u64;
            for i in 0..3 {
                if op & (1 << (4 + i)) != 0 {
                    cp_size |= u64::from(read_byte(delta, &mut pos)?) << (8 * i);
                }
            }
            if cp_size == 0 {
                cp_size = 0x10000;
            }
            let s =
                usize::try_from(cp_off).map_err(|_| Error::Config("delta copy overflow".into()))?;
            let e = s
                .checked_add(usize::try_from(cp_size).unwrap_or(usize::MAX))
                .ok_or_else(|| Error::Config("delta copy overflow".into()))?;
            let src = base
                .get(s..e)
                .ok_or_else(|| Error::Config("delta copy out of base bounds".into()))?;
            out.extend_from_slice(src);
        } else if op != 0 {
            let n = op as usize;
            let ins = delta
                .get(pos..pos + n)
                .ok_or_else(|| Error::Config("delta insert past end".into()))?;
            out.extend_from_slice(ins);
            pos += n;
        } else {
            return Err(Error::Config("reserved delta opcode 0".into()));
        }
    }
    if out.len() != dst {
        return Err(Error::Integrity);
    }
    Ok(out)
}

/// Walk an object's delta chain: `(resolved_type, depth, span, contiguous)`.
fn resolve_chain(
    start: usize,
    offsets: &[u64],
    length: &[u64],
    raw_type: &[u8],
    base_off: &[Option<u64>],
    off_to_idx: &HashMap<u64, usize>,
) -> Result<(GitObjType, u32, u64, bool)> {
    let end = offsets[start] + length[start];
    let mut min_off = offsets[start];
    let mut depth = 0u32;
    let mut contiguous = true;
    let mut j = start;
    while let Some(b) = base_off[j] {
        if b >= offsets[j] {
            contiguous = false; // a fix-thin'd REF base sits *after* the object
        }
        min_off = min_off.min(b);
        depth += 1;
        let Some(&next) = off_to_idx.get(&b) else {
            contiguous = false;
            break;
        };
        j = next;
        if depth > 100_000 {
            return Err(Error::Config("delta chain too deep (cycle?)".into()));
        }
    }
    let obj_type = GitObjType::from_code(raw_type[j])?;
    let span = if contiguous {
        end - min_off
    } else {
        length[start]
    };
    Ok((obj_type, depth, span, contiguous))
}

fn read_delta_size(buf: &[u8], pos: &mut usize) -> Result<usize> {
    let mut r = 0u64;
    let mut shift = 0u32;
    loop {
        let b = read_byte(buf, pos)?;
        r |= u64::from(b & 0x7f) << shift;
        if b & 0x80 == 0 {
            break;
        }
        shift += 7;
    }
    usize::try_from(r).map_err(|_| Error::Config("delta size exceeds usize".into()))
}

fn read_byte(buf: &[u8], pos: &mut usize) -> Result<u8> {
    let b = *buf
        .get(*pos)
        .ok_or_else(|| Error::Config("unexpected end of delta".into()))?;
    *pos += 1;
    Ok(b)
}

fn read_u32(buf: &[u8], at: usize) -> Result<u32> {
    let s = buf
        .get(at..at + 4)
        .ok_or_else(|| Error::Config("index truncated (u32)".into()))?;
    Ok(u32::from_be_bytes(s.try_into().unwrap()))
}

fn read_u64(buf: &[u8], at: usize) -> Result<u64> {
    let s = buf
        .get(at..at + 8)
        .ok_or_else(|| Error::Config("index truncated (u64)".into()))?;
    Ok(u64::from_be_bytes(s.try_into().unwrap()))
}

#[cfg(test)]
mod tests {
    use super::{apply_delta, parse_idx_v2};

    /// A minimal, well-formed SHA-1 v2 idx header for `n` objects (fanout says `n`,
    /// tables + trailers are zero-filled). `n` must be small enough that no off32
    /// entry has its MSB set (they are all zero here → 0 large offsets).
    fn sha1_idx(n: u32) -> Vec<u8> {
        let n_us = n as usize;
        let len = 8 + 1024 + n_us * (20 + 4 + 4) + 2 * 20;
        let mut idx = vec![0u8; len];
        idx[0..4].copy_from_slice(b"\xfftOc");
        idx[4..8].copy_from_slice(&2u32.to_be_bytes());
        // Cumulative fanout: the last bucket carries the total object count.
        idx[8 + 255 * 4..8 + 256 * 4].copy_from_slice(&n.to_be_bytes());
        idx
    }

    #[test]
    fn rejects_bad_magic() {
        let mut idx = sha1_idx(0);
        idx[0] = 0;
        assert!(parse_idx_v2(&idx).is_err());
    }

    #[test]
    fn rejects_bad_version() {
        let mut idx = sha1_idx(0);
        idx[4..8].copy_from_slice(&3u32.to_be_bytes());
        assert!(parse_idx_v2(&idx).is_err());
    }

    #[test]
    fn rejects_truncated_before_fanout() {
        assert!(parse_idx_v2(&[0xff, b't', b'O', b'c']).is_err());
    }

    #[test]
    fn empty_index_parses_to_zero_objects() {
        let (oids, offs) = parse_idx_v2(&sha1_idx(0)).unwrap();
        assert!(oids.is_empty() && offs.is_empty());
    }

    #[test]
    fn well_formed_single_object_reconciles() {
        let (oids, offs) = parse_idx_v2(&sha1_idx(1)).unwrap();
        assert_eq!(oids.len(), 1);
        assert_eq!(offs, vec![0]);
    }

    #[test]
    fn rejects_length_mismatch_like_sha256() {
        // Correct magic/version/fanout but the file is longer than a SHA-1 layout for
        // n=1 — exactly how a genuine SHA-256 index (32-byte ids/trailers) presents.
        let mut idx = sha1_idx(1);
        idx.resize(idx.len() + 24, 0); // longer than the SHA-1 layout for n=1
        let err = parse_idx_v2(&idx).unwrap_err();
        let msg = format!("{err}");
        assert!(
            msg.contains("SHA-1 v2 layout") || msg.contains("SHA-256"),
            "unexpected message: {msg}"
        );
    }

    #[test]
    fn rejects_short_for_object_count() {
        // Fanout claims 1000 objects but the file is header-sized only.
        let mut idx = sha1_idx(0);
        idx[8 + 255 * 4..8 + 256 * 4].copy_from_slice(&1000u32.to_be_bytes());
        assert!(parse_idx_v2(&idx).is_err());
    }

    #[test]
    fn apply_delta_copy_and_insert() {
        let base = b"hello world";
        // delta: src_size=11, dst_size=7, copy 5 from off 0 ("hello"), insert "!!"
        let mut delta = vec![11u8, 7u8];
        delta.push(0x80 | 0x01 | 0x10); // copy: offset byte + size byte present
        delta.push(0); // copy offset = 0
        delta.push(5); // copy size = 5
        delta.push(2); // insert 2 literal bytes
        delta.extend_from_slice(b"!!");
        assert_eq!(apply_delta(base, &delta).unwrap(), b"hello!!");
    }
}
