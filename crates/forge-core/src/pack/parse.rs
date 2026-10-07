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
use std::collections::{HashMap, HashSet};
use std::io::Read as _;

/// Raw byte length of a git SHA-1 object id.
pub const OID_LEN: usize = 20;

/// Trailing checksum length of a SHA-1 packfile (its final 20 bytes).
const PACK_TRAILER: usize = 20;

/// The longest delta chain git writes: `pack-objects` clamps `--depth` / `pack.depth` to 4095
/// (its 12-bit depth field), so a longer chain — or one that loops — is not a git pack.
/// forge-web's reader walks at most this many bases too (`DELTA_WALK_MAX`).
pub const MAX_DELTA_DEPTH: u32 = 4095;

/// Deflate cannot expand its input by more than this factor (a 258-byte match per ~2 bits);
/// forge-web's pack reader holds a declared size to the same bound. No reconstructed object can
/// honestly be larger than its input inflated at this ratio, so the decoder refuses to grow one
/// past that: bytes a pack only *declares* are never reserved.
const DEFLATE_MAX_RATIO: u64 = 1032;

/// What a decoder reserves up front for an inflated object before the stream proves it is
/// that large; past it the buffer grows with the bytes actually produced.
const INITIAL_RESERVE: usize = 64 * 1024;

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
        let base_addr = obj
            .offset
            .checked_add(obj.length)
            .and_then(|end| end.checked_sub(obj.delta_chain_span))
            .ok_or_else(|| Error::Config("span geometry out of range".into()))?;
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

    /// Decode the object at pack-absolute `abs_off`, where `buf[0]` corresponds to pack-absolute
    /// `base_addr`.
    ///
    /// Walks the delta chain down to its base first — OFS bases inside `buf`, REF bases by OID
    /// when `allow_ref` (set only when `buf` is the whole pack) — then applies the deltas back up.
    /// The walk is a loop, not a recursion, and it refuses a chain that revisits an object or runs
    /// past [`MAX_DELTA_DEPTH`], so no bytes can drive it into a stack overflow or a hang. Every
    /// output is held to what `buf` can inflate to ([`DEFLATE_MAX_RATIO`]).
    fn decode_at(
        &self,
        buf: &[u8],
        base_addr: u64,
        abs_off: u64,
        allow_ref: bool,
    ) -> Result<(GitObjType, Vec<u8>)> {
        let budget = (buf.len() as u64).saturating_mul(DEFLATE_MAX_RATIO);
        // (start of the delta's zlib stream, its declared inflated size), outermost first.
        let mut deltas: Vec<(usize, usize)> = Vec::new();
        let mut seen = HashSet::new();
        let mut at = abs_off;
        let (obj_type, mut data) = loop {
            if !seen.insert(at) {
                return Err(Error::Config("delta chain loops back on itself".into()));
            }
            let pos = at
                .checked_sub(base_addr)
                .and_then(|p| usize::try_from(p).ok())
                .ok_or_else(|| Error::Config("delta base outside the bytes read".into()))?;
            let (t, size, after) = parse_obj_header(buf, pos)?;
            at = match t {
                T_COMMIT | T_TREE | T_BLOB | T_TAG => {
                    break (GitObjType::from_code(t)?, inflate(&buf[after..], size)?);
                }
                T_OFS_DELTA => {
                    let (rel, dpos) = parse_ofs_base(buf, after)?;
                    deltas.push((dpos, size));
                    at.checked_sub(rel)
                        .ok_or_else(|| Error::Config("OFS base before pack start".into()))?
                }
                T_REF_DELTA => {
                    if !allow_ref {
                        return Err(Error::Config(
                            "REF_DELTA in a span read (pack is not self-contained/OFS-only)".into(),
                        ));
                    }
                    let end = after + OID_LEN;
                    let oid = buf
                        .get(after..end)
                        .ok_or_else(|| Error::Config("truncated REF_DELTA base oid".into()))?;
                    deltas.push((end, size));
                    self.object(oid).ok_or(Error::NotFound)?.offset
                }
                other => return Err(Error::Config(format!("unknown pack object type {other}"))),
            };
            if deltas.len() > MAX_DELTA_DEPTH as usize {
                return Err(Error::Config(format!(
                    "delta chain deeper than {MAX_DELTA_DEPTH}"
                )));
            }
        };
        for &(dpos, size) in deltas.iter().rev() {
            let delta = inflate(&buf[dpos..], size)?;
            data = apply_delta(&data, &delta, budget)?;
        }
        Ok((obj_type, data))
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
    let n = read_u32(idx, fanout_at + 255 * 4)?;

    // The oid, CRC and off32 tables and both 20-byte trailers must fit under a SHA-1 layout
    // before we can safely scan for large offsets. Sized in u64 first, so every usize position
    // below is within `idx`.
    let tables = u64::from(n) * (OID_LEN as u64 + 4 + 4);
    if 8 + 1024 + tables + 2 * PACK_TRAILER as u64 > idx.len() as u64 {
        return Err(Error::Config(
            "pack index too short for its object count".into(),
        ));
    }
    let n = n as usize;
    let oids_at = fanout_at + 256 * 4;
    let off32_at = oids_at + n * OID_LEN + n * 4; // after the oid + CRC tables
    let big_at = off32_at + n * 4;

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
    let expected = 8 + 1024 + tables + num_big as u64 * 8 + 2 * PACK_TRAILER as u64;
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
            let at = j
                .checked_mul(8)
                .and_then(|o| o.checked_add(big_at))
                .ok_or_else(|| Error::Config("index truncated (u64)".into()))?;
            offsets.push(read_u64(idx, at)?);
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
        size |= shl_exact(u64::from(c & 0x7f), shift)
            .ok_or_else(|| Error::Config("object size varint overflow".into()))?;
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
        ofs = ofs
            .checked_add(1)
            .and_then(|o| o.checked_mul(128))
            .ok_or_else(|| Error::Config("OFS base varint overflow".into()))?
            | u64::from(c & 0x7f);
    }
    // git reads a zero back-pointer as out of bounds: an object cannot be its own base.
    if ofs == 0 {
        return Err(Error::Config("OFS delta names itself as its base".into()));
    }
    Ok((ofs, p))
}

/// Inflate one zlib stream, asserting it yields exactly `expected` bytes.
///
/// `expected` is the pack's claim. A claim `compressed` could not inflate to is refused outright,
/// and the stream is read through a limit of one byte past the claim, so memory follows the bytes
/// the stream actually produces and stops just past `expected`.
fn inflate(compressed: &[u8], expected: usize) -> Result<Vec<u8>> {
    let most = (compressed.len() as u64)
        .saturating_mul(DEFLATE_MAX_RATIO)
        .saturating_add(64);
    if expected as u64 > most {
        return Err(Error::Config(
            "object declares more bytes than its stream can inflate to".into(),
        ));
    }
    let mut out = Vec::with_capacity(expected.min(INITIAL_RESERVE));
    ZlibDecoder::new(compressed)
        .take((expected as u64).saturating_add(1))
        .read_to_end(&mut out)
        .map_err(|e| Error::Io(e.to_string()))?;
    if out.len() != expected {
        return Err(Error::Integrity);
    }
    Ok(out)
}

/// Apply a git delta (`src_size, dst_size, [copy|insert]*`) to `base`, producing at most
/// `budget` bytes.
///
/// `dst_size` is the delta's claim. It is checked against what the opcodes could produce
/// before anything is reserved (each opcode byte yields at most one copy, which is at most
/// 0xffffff bytes and never more than `base`, or one literal byte), and every opcode is checked
/// against it before its bytes are appended, so a few bytes of delta cannot claim gigabytes.
fn apply_delta(base: &[u8], delta: &[u8], budget: u64) -> Result<Vec<u8>> {
    let mut pos = 0usize;
    let src = read_delta_size(delta, &mut pos)?;
    // git's patch_delta refuses a delta made against a base of another size.
    if src != base.len() {
        return Err(Error::Config(
            "delta source size does not match its base".into(),
        ));
    }
    let dst = read_delta_size(delta, &mut pos)?;
    let per_op_byte = base.len().clamp(1, 0xff_ffff) as u64;
    let can_produce = ((delta.len() - pos) as u64).saturating_mul(per_op_byte);
    if dst as u64 > can_produce.min(budget) {
        return Err(Error::Config(
            "delta declares more output than it can produce".into(),
        ));
    }
    let mut out = Vec::with_capacity(dst.min(base.len().saturating_add(delta.len())));
    let overrun = || Error::Config("delta output runs past its declared size".into());
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
            if src.len() > dst - out.len() {
                return Err(overrun());
            }
            out.extend_from_slice(src);
        } else if op != 0 {
            let n = op as usize;
            let ins = delta
                .get(pos..pos + n)
                .ok_or_else(|| Error::Config("delta insert past end".into()))?;
            if n > dst - out.len() {
                return Err(overrun());
            }
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
        if depth > MAX_DELTA_DEPTH {
            return Err(Error::Config(format!(
                "delta chain deeper than {MAX_DELTA_DEPTH} (or a cycle)"
            )));
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
        r |= shl_exact(u64::from(b & 0x7f), shift)
            .ok_or_else(|| Error::Config("delta size varint overflow".into()))?;
        if b & 0x80 == 0 {
            break;
        }
        shift += 7;
    }
    usize::try_from(r).map_err(|_| Error::Config("delta size exceeds usize".into()))
}

/// `bits << shift`, or `None` when any bit would fall off the top of a u64: an overlong
/// varint, which no git writer emits.
fn shl_exact(bits: u64, shift: u32) -> Option<u64> {
    let v = bits.checked_shl(shift)?;
    (v >> shift == bits).then_some(v)
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
        .get(at..at.saturating_add(4))
        .ok_or_else(|| Error::Config("index truncated (u32)".into()))?;
    Ok(u32::from_be_bytes(s.try_into().unwrap()))
}

fn read_u64(buf: &[u8], at: usize) -> Result<u64> {
    let s = buf
        .get(at..at.saturating_add(8))
        .ok_or_else(|| Error::Config("index truncated (u64)".into()))?;
    Ok(u64::from_be_bytes(s.try_into().unwrap()))
}

#[cfg(test)]
mod tests {
    use super::{
        apply_delta, parse_idx_v2, GitObjType, PackObject, ParsedPack, MAX_DELTA_DEPTH, OID_LEN,
        T_BLOB, T_OFS_DELTA, T_REF_DELTA,
    };
    use crate::pack::TestRng;
    use flate2::{write::ZlibEncoder, Compression};
    use std::io::Write as _;

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
        assert_eq!(apply_delta(base, &delta, u64::MAX).unwrap(), b"hello!!");
    }

    fn zlib(data: &[u8]) -> Vec<u8> {
        let mut e = ZlibEncoder::new(Vec::new(), Compression::default());
        e.write_all(data).unwrap();
        e.finish().unwrap()
    }

    /// A pack object header: the type nibble and git's size varint.
    fn obj_header(t: u8, mut size: u64) -> Vec<u8> {
        let mut out = Vec::new();
        let mut c = (t << 4) | (size & 0x0f) as u8;
        size >>= 4;
        while size != 0 {
            out.push(c | 0x80);
            c = (size & 0x7f) as u8;
            size >>= 7;
        }
        out.push(c);
        out
    }

    /// git's `OFS_DELTA` back-pointer encoding of `rel`.
    fn ofs_varint(mut rel: u64) -> Vec<u8> {
        let mut out = vec![(rel & 0x7f) as u8];
        rel >>= 7;
        while rel != 0 {
            rel -= 1;
            out.push(0x80 | (rel & 0x7f) as u8);
            rel >>= 7;
        }
        out.reverse();
        out
    }

    /// A delta header size (little-endian base-128).
    fn delta_size(mut v: u64) -> Vec<u8> {
        let mut out = Vec::new();
        loop {
            let b = (v & 0x7f) as u8;
            v >>= 7;
            if v == 0 {
                out.push(b);
                return out;
            }
            out.push(b | 0x80);
        }
    }

    /// A delta that copies the whole of a `len`-byte base (`len` in 1..=255).
    fn copy_all_delta(len: u8) -> Vec<u8> {
        vec![len, len, 0x80 | 0x10, len]
    }

    /// A packed `OFS_DELTA` entry `rel` bytes after its base.
    fn ofs_entry(rel: u64, delta: &[u8]) -> Vec<u8> {
        let mut e = obj_header(T_OFS_DELTA, delta.len() as u64);
        e.extend(ofs_varint(rel));
        e.extend(zlib(delta));
        e
    }

    /// A packed `REF_DELTA` entry against `base`.
    fn ref_entry(base: [u8; OID_LEN], delta: &[u8]) -> Vec<u8> {
        let mut e = obj_header(T_REF_DELTA, delta.len() as u64);
        e.extend(base);
        e.extend(zlib(delta));
        e
    }

    fn blob_entry(data: &[u8]) -> Vec<u8> {
        let mut e = obj_header(T_BLOB, data.len() as u64);
        e.extend(zlib(data));
        e
    }

    fn object(oid: [u8; OID_LEN], offset: u64, length: u64) -> PackObject {
        PackObject {
            oid,
            offset,
            length,
            obj_type: GitObjType::Blob,
            delta_depth: 0,
            is_ref_delta: false,
            delta_chain_span: offset + length,
            contiguous: true,
        }
    }

    /// A parsed pack over `pack` that knows only `objects`: enough for the decoders.
    fn bare(pack: Vec<u8>, objects: Vec<PackObject>) -> ParsedPack {
        let oid_to_idx = objects
            .iter()
            .enumerate()
            .map(|(i, o)| (o.oid, i))
            .collect();
        ParsedPack {
            pack_bytes: pack,
            pack_hash: [0; 32],
            objects,
            oid_to_idx,
        }
    }

    /// Decode the object at `offset` of `buf` as a span read covering all of `buf`.
    fn span_decode(buf: &[u8], offset: usize) -> crate::error::Result<(GitObjType, Vec<u8>)> {
        let obj = object([0; OID_LEN], offset as u64, (buf.len() - offset) as u64);
        bare(Vec::new(), Vec::new()).reconstruct_from_span(&obj, buf)
    }

    /// `PACK` v2 header, `entries` back to back, and a zero trailer; plus each entry's offset.
    fn pack_of(entries: &[Vec<u8>]) -> (Vec<u8>, Vec<u64>) {
        let mut pack = b"PACK".to_vec();
        pack.extend(2u32.to_be_bytes());
        pack.extend((entries.len() as u32).to_be_bytes());
        let mut offsets = Vec::new();
        for e in entries {
            offsets.push(pack.len() as u64);
            pack.extend(e);
        }
        pack.extend([0u8; 20]);
        (pack, offsets)
    }

    /// A v2 `.idx` for `(oid, offset)` pairs (offsets under 2^31).
    fn idx_of(objects: &[([u8; OID_LEN], u64)]) -> Vec<u8> {
        let mut sorted = objects.to_vec();
        sorted.sort_unstable();
        let mut idx = b"\xfftOc".to_vec();
        idx.extend(2u32.to_be_bytes());
        for b in 0..=255u8 {
            let n = sorted.iter().filter(|(o, _)| o[0] <= b).count() as u32;
            idx.extend(n.to_be_bytes());
        }
        for (oid, _) in &sorted {
            idx.extend(oid);
        }
        idx.extend(vec![0u8; 4 * sorted.len()]);
        for (_, off) in &sorted {
            idx.extend((*off as u32).to_be_bytes());
        }
        idx.extend([0u8; 40]);
        idx
    }

    #[test]
    fn huge_declared_object_size_fails_before_allocating() {
        let mut buf = obj_header(T_BLOB, 1 << 60);
        buf.extend(zlib(b"hi"));
        assert!(span_decode(&buf, 0).is_err());
    }

    #[test]
    fn declared_object_size_must_match_the_stream() {
        let mut buf = obj_header(T_BLOB, 3);
        buf.extend(zlib(b"four"));
        assert!(span_decode(&buf, 0).is_err());
        let mut buf = obj_header(T_BLOB, 4);
        buf.extend(zlib(b"four"));
        assert_eq!(span_decode(&buf, 0).unwrap().1, b"four");
    }

    #[test]
    fn huge_delta_destination_fails_before_allocating() {
        let mut delta = vec![3u8];
        delta.extend(delta_size(1 << 60));
        delta.extend([0x80 | 0x10, 3]);
        assert!(apply_delta(b"abc", &delta, u64::MAX).is_err());

        // The same through the decoder: a tiny delta entry claiming an exabyte.
        let mut buf = blob_entry(b"abc");
        let rel = buf.len() as u64;
        buf.extend(ofs_entry(rel, &delta));
        assert!(span_decode(&buf, rel as usize).is_err());
    }

    #[test]
    fn delta_output_is_held_to_its_declared_size_and_base() {
        // Claims 2 bytes, copies 3.
        assert!(apply_delta(b"abc", &[3, 2, 0x80 | 0x10, 3], u64::MAX).is_err());
        // Made against a 4-byte base, applied to a 3-byte one.
        assert!(apply_delta(b"abc", &[4, 3, 0x80 | 0x10, 3], u64::MAX).is_err());
        // Within the declared size but over the caller's budget.
        assert!(apply_delta(b"abc", &copy_all_delta(3)[..], 2).is_err());
        assert_eq!(
            apply_delta(b"abc", &copy_all_delta(3), u64::MAX).unwrap(),
            b"abc"
        );
    }

    #[test]
    fn overlong_size_varints_are_refused() {
        // An object header whose size runs past 64 bits.
        let mut buf = vec![0xb0];
        buf.extend([0xff; 10]);
        buf.push(0x7f);
        assert!(span_decode(&buf, 0).is_err());
        // A delta size that does.
        let mut delta = vec![0xff; 10];
        delta.push(0x7f);
        assert!(apply_delta(b"", &delta, u64::MAX).is_err());
    }

    #[test]
    fn a_self_referencing_ofs_delta_is_refused() {
        let mut buf = obj_header(T_OFS_DELTA, 4);
        buf.push(0x00); // back-pointer 0: the object itself
        buf.extend(zlib(&copy_all_delta(1)));
        assert!(span_decode(&buf, 0).is_err());
    }

    #[test]
    fn an_ofs_base_outside_the_span_is_refused() {
        let mut buf = blob_entry(b"x");
        let rel = buf.len() as u64;
        buf.extend(ofs_entry(rel + 1000, &copy_all_delta(1)));
        assert!(span_decode(&buf, rel as usize).is_err());
    }

    #[test]
    fn ref_delta_cycles_are_refused() {
        let (a, b) = ([1u8; OID_LEN], [2u8; OID_LEN]);
        // A names itself as its base.
        let (pack, offs) = pack_of(&[ref_entry(a, &copy_all_delta(1))]);
        let p = bare(pack, vec![object(a, offs[0], 1)]);
        assert!(p.object_bytes(&a).is_err());

        // A and B name each other.
        let entries = [
            ref_entry(b, &copy_all_delta(1)),
            ref_entry(a, &copy_all_delta(1)),
        ];
        let (pack, offs) = pack_of(&entries);
        let p = bare(
            pack.clone(),
            vec![object(a, offs[0], 1), object(b, offs[1], 1)],
        );
        assert!(p.object_bytes(&a).is_err());
        assert!(p.object_bytes(&b).is_err());

        // And the full parse refuses the pack itself.
        let idx = idx_of(&[(a, offs[0]), (b, offs[1])]);
        assert!(ParsedPack::parse(&pack, &idx).is_err());
    }

    /// A blob "x" then `deltas` OFS deltas, each against the entry before it.
    fn chain(deltas: usize) -> (Vec<u8>, Vec<u64>) {
        let mut entries = vec![blob_entry(b"x")];
        let step = ofs_entry(1, &copy_all_delta(1)).len();
        for i in 0..deltas {
            let rel = if i == 0 { entries[0].len() } else { step };
            entries.push(ofs_entry(rel as u64, &copy_all_delta(1)));
            // Every back-pointer encodes in one byte, so every delta entry has the same length.
            assert_eq!(entries[i + 1].len(), step);
        }
        pack_of(&entries)
    }

    #[test]
    fn delta_chains_deeper_than_git_writes_are_refused() {
        let depth = MAX_DELTA_DEPTH as usize;
        let (pack, offs) = chain(depth);
        let top = offs[depth] as usize;
        let span = &pack[..pack.len() - 20];
        assert_eq!(span_decode(span, top).unwrap().1, b"x");

        let (pack, offs) = chain(depth + 1);
        let top = offs[depth + 1] as usize;
        let span = &pack[..pack.len() - 20];
        assert!(span_decode(span, top).is_err());
        let oids: Vec<([u8; OID_LEN], u64)> = offs
            .iter()
            .enumerate()
            .map(|(i, &o)| {
                let mut oid = [0u8; OID_LEN];
                oid[..8].copy_from_slice(&(i as u64).to_be_bytes());
                (oid, o)
            })
            .collect();
        assert!(ParsedPack::parse(&pack, &idx_of(&oids)).is_err());
    }

    #[test]
    fn a_hand_built_pack_parses_and_reconstructs() {
        let (a, b) = ([1u8; OID_LEN], [2u8; OID_LEN]);
        let base = blob_entry(b"hello");
        let rel = base.len() as u64;
        let mut delta = vec![5, 7, 0x80 | 0x10, 5, 2];
        delta.extend(b"!!");
        let (pack, offs) = pack_of(&[base, ofs_entry(rel, &delta)]);
        let p = ParsedPack::parse(&pack, &idx_of(&[(a, offs[0]), (b, offs[1])])).unwrap();
        assert_eq!(p.object_bytes(&b).unwrap().1, b"hello!!");
        let obj = p.object(&b).unwrap().clone();
        let start = (obj.end() - obj.delta_chain_span) as usize;
        let slice = &pack[start..obj.end() as usize];
        assert_eq!(p.reconstruct_from_span(&obj, slice).unwrap().1, b"hello!!");
    }

    #[test]
    fn random_bytes_never_panic_the_pack_decoders() {
        let mut rng = TestRng(0x9e37_79b9_7f4a_7c15);
        // Raw random spans and deltas.
        for _ in 0..4000 {
            let len = 1 + rng.below(96);
            let buf = rng.bytes(len);
            let _ = span_decode(&buf, rng.below(len));
            let base_len = rng.below(32);
            let base = rng.bytes(base_len);
            let _ = apply_delta(&base, &buf, 1 << 20);
        }
        // Mutations of a well-formed pack + index with a delta in it.
        let (a, b) = ([1u8; OID_LEN], [2u8; OID_LEN]);
        let base = blob_entry(b"hello");
        let rel = base.len() as u64;
        let mut delta = vec![5, 7, 0x80 | 0x10, 5, 2];
        delta.extend(b"!!");
        let (pack, offs) = pack_of(&[base, ofs_entry(rel, &delta)]);
        let idx = idx_of(&[(a, offs[0]), (b, offs[1])]);
        for _ in 0..4000 {
            let (mut pk, mut ix) = (pack.clone(), idx.clone());
            for _ in 0..=rng.below(4) {
                if rng.below(2) == 0 {
                    let at = rng.below(pk.len());
                    pk[at] = rng.byte();
                } else {
                    let at = rng.below(ix.len());
                    ix[at] = rng.byte();
                }
            }
            let Ok(p) = ParsedPack::parse(&pk, &ix) else {
                continue;
            };
            let _ = p.verify_all_oids();
            for obj in p.objects.clone() {
                let _ = p.object_bytes(&obj.oid);
                let start = obj.offset.saturating_add(obj.length);
                let range = start
                    .checked_sub(obj.delta_chain_span)
                    .map(|s| s as usize..start as usize);
                if let Some(slice) = range.and_then(|r| pk.get(r)) {
                    let _ = p.reconstruct_from_span(&obj, slice);
                }
            }
        }
    }
}
