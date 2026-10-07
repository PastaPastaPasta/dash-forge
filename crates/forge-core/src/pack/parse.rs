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

/// How many single steps' worth of bytes ([`DEFLATE_MAX_RATIO`] × the bytes a chain is stored
/// in) one read may build across its whole chain, base included.
///
/// Each step of a chain is already held to that per-step bound; without a total, a chain of
/// [`MAX_DELTA_DEPTH`] steps could build that much again at every one. An honest chain rebuilds
/// an object of about the same size at each step, so it costs `depth × size`: even at git's
/// deepest chain this admits every object up to 64× the bytes its chain is stored in (256 ×
/// 1032 / 4096), far more than real content compresses by, and any chain of up to 255 steps is
/// bounded only per step.
const CHAIN_BUILD_HEADROOM: u64 = 256;

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
    /// Absolute end offset of the object within the pack (`offset + length`, saturating: no
    /// parsed object comes near `u64::MAX`, but the fields are public).
    pub fn end(&self) -> u64 {
        self.offset.saturating_add(self.length)
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
    /// Object index by pack offset (offsets are distinct).
    at_offset: HashMap<u64, usize>,
    /// Each object's immediate delta base, by index, when that base is in this pack.
    bases: Vec<Option<usize>>,
}

/// What a delta names as its base, as stored.
enum EntryBase<'a> {
    /// Not a delta.
    None,
    /// `OFS_DELTA`: the base starts this many bytes before the delta.
    Ofs(u64),
    /// `REF_DELTA`: the base's OID.
    Ref(&'a [u8]),
}

/// A pack entry's header: its type code, declared inflated size, where its zlib stream starts,
/// and the base a delta names.
struct Entry<'a> {
    t: u8,
    size: usize,
    data: usize,
    base: EntryBase<'a>,
}

/// One zlib stream of a delta chain: `buf[start..end]` inflates to `size` bytes.
#[derive(Debug, Clone, Copy)]
struct Link {
    start: usize,
    end: usize,
    size: usize,
}

/// An object's delta chain as stored, ready to build.
struct Links {
    obj_type: GitObjType,
    base: Link,
    /// Outermost (the object itself) first.
    deltas: Vec<Link>,
    /// Bytes the chain is stored in: what bounds what it may build ([`ReadBudget`]).
    covered: u64,
}

/// One object's resolved delta chain, as [`resolve_chains`] memoizes it.
#[derive(Debug, Clone, Copy)]
struct Chain {
    /// Type code of the entry the chain ends at.
    root: u8,
    /// Delta hops down to it.
    depth: u32,
    /// Lowest offset among the object and every base in its chain.
    min_off: u64,
    /// Whether every base sits at a lower offset than the delta naming it.
    contiguous: bool,
}

/// What one read may build: each delta step at most `step` bytes, and every step (and the
/// base) together at most `left` more.
#[derive(Debug, Clone, Copy)]
struct ReadBudget {
    step: u64,
    left: u64,
}

impl ReadBudget {
    /// The budget of a read whose chain is stored in `covered` bytes.
    fn new(covered: u64) -> Self {
        let step = covered.saturating_mul(DEFLATE_MAX_RATIO);
        Self {
            step,
            left: step.saturating_mul(CHAIN_BUILD_HEADROOM),
        }
    }

    /// The most the next step may produce.
    fn next_step(self) -> u64 {
        self.step.min(self.left)
    }

    /// Count `n` bytes built.
    fn spend(&mut self, n: u64) -> Result<()> {
        self.left = self
            .left
            .checked_sub(n)
            .ok_or_else(|| Error::Config("delta chain builds more than one read may".into()))?;
        Ok(())
    }
}

/// One object of [`ParsedPack::verify_all_oids`]' walk, with the bytes its deltas build on.
struct VerifyFrame {
    idx: usize,
    obj_type: GitObjType,
    data: Vec<u8>,
    covered: u64,
    built: u64,
    next_child: usize,
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
        if order.windows(2).any(|w| offsets[w[0]] == offsets[w[1]]) {
            return Err(Error::Config("two pack objects share one offset".into()));
        }
        let mut length = vec![0u64; n];
        for (k, &i) in order.iter().enumerate() {
            let end = order
                .get(k + 1)
                .map_or((pack_len - PACK_TRAILER) as u64, |&j| offsets[j]);
            length[i] = end
                .checked_sub(offsets[i])
                .ok_or_else(|| Error::Config("overlapping pack offsets".into()))?;
        }

        let oid_to_idx: HashMap<[u8; OID_LEN], usize> =
            oids.iter().enumerate().map(|(i, o)| (*o, i)).collect();
        let at_offset: HashMap<u64, usize> =
            offsets.iter().enumerate().map(|(i, o)| (*o, i)).collect();

        // Header type + immediate base, resolved to an in-pack offset (REF → OID lookup).
        let mut raw_type = vec![0u8; n];
        let mut base_off: Vec<Option<u64>> = Vec::with_capacity(n);
        let mut is_ref = vec![false; n];
        for i in 0..n {
            let off = usize::try_from(offsets[i])
                .map_err(|_| Error::Config("pack offset exceeds usize".into()))?;
            let entry = read_entry(pack_bytes, off)?;
            raw_type[i] = entry.t;
            base_off.push(match entry.base {
                EntryBase::None => None,
                EntryBase::Ofs(rel) => Some(
                    offsets[i]
                        .checked_sub(rel)
                        .ok_or_else(|| Error::Config("OFS base before pack start".into()))?,
                ),
                EntryBase::Ref(oid) => {
                    is_ref[i] = true;
                    // A self-contained pack resolves the base internally. If it does
                    // not (a raw thin pack), the object has no in-pack base.
                    oid_to_idx.get(oid).map(|&j| offsets[j])
                }
            });
        }

        // Resolved type, depth, span and contiguity of every chain, each resolved once.
        let chains = resolve_chains(&order, &offsets, &raw_type, &base_off, &at_offset)?;
        let mut objects = Vec::with_capacity(n);
        for (i, chain) in chains.into_iter().enumerate() {
            // `offset + length` is the next object's offset or the trailer's: no overflow, and
            // a contiguous chain's lowest offset is at most the object's own.
            let end = offsets[i] + length[i];
            objects.push(PackObject {
                oid: oids[i],
                offset: offsets[i],
                length: length[i],
                obj_type: GitObjType::from_code(chain.root)?,
                delta_depth: chain.depth,
                is_ref_delta: is_ref[i],
                delta_chain_span: if chain.contiguous {
                    end - chain.min_off
                } else {
                    length[i]
                },
                contiguous: chain.contiguous,
            });
        }
        let bases = base_off
            .iter()
            .map(|off| off.and_then(|o| at_offset.get(&o).copied()))
            .collect();

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
            at_offset,
            bases,
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
    ///
    /// Each object is built once, from its base's bytes, by walking the delta tree from every
    /// base object down — not by rebuilding its whole chain, which would cost objects × depth.
    /// What each object may build is held to exactly what [`Self::object_bytes`] allows it. A
    /// base's bytes are dropped once its last delta starts, and its heaviest subtree goes last,
    /// so at most about log2(objects) bases are held at once.
    pub fn verify_all_oids(&self) -> Result<usize> {
        let n = self.objects.len();
        let mut children: Vec<Vec<usize>> = vec![Vec::new(); n];
        let mut roots = Vec::new();
        for (i, base) in self.bases.iter().enumerate() {
            match *base {
                Some(b) => children[b].push(i),
                None => roots.push(i),
            }
        }
        // Subtree weights, children before parents (reverse preorder).
        let mut preorder = Vec::with_capacity(n);
        let mut pending = roots.clone();
        while let Some(i) = pending.pop() {
            preorder.push(i);
            pending.extend_from_slice(&children[i]);
        }
        if preorder.len() != n {
            return Err(Error::Config("delta bases form a cycle".into()));
        }
        let mut weight = vec![1usize; n];
        for &i in preorder.iter().rev() {
            if let Some(b) = self.bases[i] {
                weight[b] += weight[i];
            }
        }
        for kids in &mut children {
            kids.sort_by_key(|&c| weight[c]);
        }

        let check = |i: usize, t: GitObjType, data: &[u8]| {
            if git_oid(t, data) == self.objects[i].oid {
                Ok(())
            } else {
                Err(Error::Integrity)
            }
        };
        for &root in &roots {
            let (obj_type, data) = self.object_bytes(&self.objects[root].oid)?;
            check(root, obj_type, &data)?;
            let mut stack = vec![VerifyFrame {
                idx: root,
                obj_type,
                covered: self.objects[root].length,
                built: data.len() as u64,
                data,
                next_child: 0,
            }];
            while let Some(top) = stack.last_mut() {
                let kids = &children[top.idx];
                let Some(&child) = kids.get(top.next_child) else {
                    stack.pop();
                    continue;
                };
                top.next_child += 1;
                let last = top.next_child == kids.len();
                let (obj_type, built) = (top.obj_type, top.built);
                let covered = top.covered.saturating_add(self.objects[child].length);
                // The same budget `object_bytes(child)` would spend: its chain's bytes, less what
                // building the base already took.
                let mut budget = ReadBudget::new(covered);
                budget.spend(built)?;
                let data = self.apply_own_delta(child, &top.data, budget.next_step())?;
                if last {
                    stack.pop();
                }
                check(child, obj_type, &data)?;
                if !children[child].is_empty() {
                    stack.push(VerifyFrame {
                        idx: child,
                        obj_type,
                        covered,
                        built: built.saturating_add(data.len() as u64),
                        data,
                        next_child: 0,
                    });
                }
            }
        }
        Ok(n)
    }

    /// `[offset, offset + length)` of the object at pack offset `at`, as positions in the pack.
    fn extent(&self, at: u64) -> Result<(usize, usize)> {
        let obj = self
            .at_offset
            .get(&at)
            .map(|&i| &self.objects[i])
            .ok_or_else(|| Error::Config("delta base is not an object in the pack".into()))?;
        let start = usize::try_from(obj.offset).ok();
        let end = obj
            .offset
            .checked_add(obj.length)
            .and_then(|e| usize::try_from(e).ok())
            .filter(|&e| e <= self.pack_bytes.len());
        match (start, end) {
            (Some(s), Some(e)) if s <= e => Ok((s, e)),
            _ => Err(Error::Config("object runs outside the pack".into())),
        }
    }

    /// Apply object `i`'s own delta to `base`, its base's bytes, producing at most `budget`.
    fn apply_own_delta(&self, i: usize, base: &[u8], budget: u64) -> Result<Vec<u8>> {
        let (start, end) = self.extent(self.objects[i].offset)?;
        let stored = &self.pack_bytes[..end];
        let entry = read_entry(stored, start)?;
        if matches!(entry.base, EntryBase::None) {
            return Err(Error::Config(
                "pack object has a base but is no delta".into(),
            ));
        }
        apply_delta(base, &inflate(&stored[entry.data..], entry.size)?, budget)
    }

    /// Decode the object at pack-absolute `abs_off`, where `buf[0]` corresponds to pack-absolute
    /// `base_addr`.
    ///
    /// Walks the delta chain down to its base first — OFS bases inside `buf`, REF bases by OID
    /// when `allow_ref` (set only when `buf` is the whole pack) — then applies the deltas back up.
    /// The walk is a loop, not a recursion, and it refuses a chain that revisits an object or runs
    /// past [`MAX_DELTA_DEPTH`], so no bytes can drive it into a stack overflow or a hang. What
    /// the chain builds, step by step and in total, is held to what the bytes it is stored in can
    /// inflate to ([`ReadBudget`]).
    fn decode_at(
        &self,
        buf: &[u8],
        base_addr: u64,
        abs_off: u64,
        allow_ref: bool,
    ) -> Result<(GitObjType, Vec<u8>)> {
        let links = self.links_at(buf, base_addr, abs_off, allow_ref)?;
        let data = build(buf, &links, ReadBudget::new(links.covered))?;
        Ok((links.obj_type, data))
    }

    /// The stored delta chain of the object at pack-absolute `abs_off` ([`Self::decode_at`]).
    ///
    /// In the whole pack each link is cut to its own object's extent and the chain covers the
    /// sum of them; a span read holds only the chain, so its links run to the end of `buf` and
    /// the chain covers all of it.
    fn links_at(&self, buf: &[u8], base_addr: u64, abs_off: u64, allow_ref: bool) -> Result<Links> {
        let mut deltas = Vec::new();
        let mut covered = 0u64;
        let mut seen = HashSet::new();
        let mut at = abs_off;
        let (obj_type, base) = loop {
            if !seen.insert(at) {
                return Err(Error::Config("delta chain loops back on itself".into()));
            }
            let pos = at
                .checked_sub(base_addr)
                .and_then(|p| usize::try_from(p).ok())
                .ok_or_else(|| Error::Config("delta base outside the bytes read".into()))?;
            let end = if allow_ref {
                let (start, end) = self.extent(at)?;
                covered = covered.saturating_add((end - start) as u64);
                end
            } else {
                buf.len()
            };
            let stored = buf
                .get(..end)
                .ok_or_else(|| Error::Config("pack object outside the bytes read".into()))?;
            let entry = read_entry(stored, pos)?;
            let link = Link {
                start: entry.data,
                end,
                size: entry.size,
            };
            at = match entry.base {
                EntryBase::None => break (GitObjType::from_code(entry.t)?, link),
                EntryBase::Ofs(rel) => at
                    .checked_sub(rel)
                    .ok_or_else(|| Error::Config("OFS base before pack start".into()))?,
                EntryBase::Ref(oid) => {
                    if !allow_ref {
                        return Err(Error::Config(
                            "REF_DELTA in a span read (pack is not self-contained/OFS-only)".into(),
                        ));
                    }
                    self.object(oid).ok_or(Error::NotFound)?.offset
                }
            };
            deltas.push(link);
            if deltas.len() > MAX_DELTA_DEPTH as usize {
                return Err(Error::Config(format!(
                    "delta chain deeper than {MAX_DELTA_DEPTH}"
                )));
            }
        };
        if !allow_ref {
            covered = buf.len() as u64;
        }
        Ok(Links {
            obj_type,
            base,
            deltas,
            covered,
        })
    }
}

/// Build a stored chain's object: inflate its base, then apply its deltas back up, all within
/// `budget`.
fn build(buf: &[u8], links: &Links, mut budget: ReadBudget) -> Result<Vec<u8>> {
    let Link { start, end, size } = links.base;
    let mut data = inflate(&buf[start..end], size)?;
    budget.spend(data.len() as u64)?;
    for &Link { start, end, size } in links.deltas.iter().rev() {
        let delta = inflate(&buf[start..end], size)?;
        data = apply_delta(&data, &delta, budget.next_step())?;
        budget.spend(data.len() as u64)?;
    }
    Ok(data)
}

/// Read the entry header at `pos`: type, declared size, the base a delta names, and where its
/// zlib stream starts (never past `buf`).
fn read_entry(buf: &[u8], pos: usize) -> Result<Entry<'_>> {
    let (t, size, after) = parse_obj_header(buf, pos)?;
    let (data, base) = match t {
        T_OFS_DELTA => {
            let (rel, data) = parse_ofs_base(buf, after)?;
            (data, EntryBase::Ofs(rel))
        }
        T_REF_DELTA => {
            let end = after + OID_LEN;
            let oid = buf
                .get(after..end)
                .ok_or_else(|| Error::Config("truncated REF_DELTA base oid".into()))?;
            (end, EntryBase::Ref(oid))
        }
        _ => (after, EntryBase::None),
    };
    Ok(Entry {
        t,
        size,
        data,
        base,
    })
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
    #[cfg(test)]
    DELTAS_APPLIED.with(|c| c.set(c.get() + 1));
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

#[cfg(test)]
thread_local! {
    /// Steps [`resolve_chains`] has taken on this thread, so a test can hold it to linear time.
    static CHAIN_STEPS: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
    /// Deltas [`apply_delta`] has applied on this thread.
    static DELTAS_APPLIED: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

fn count_chain_step() {
    #[cfg(test)]
    CHAIN_STEPS.with(|c| c.set(c.get() + 1));
}

/// Resolve every object's delta chain, in time linear in the object count.
///
/// An object's chain is its base's chain plus one hop, so each is resolved once and reused.
/// Objects are taken in ascending offset (`order`), which resolves every `OFS_DELTA` base (always
/// earlier) before its deltas; a base not resolved yet (a `REF_DELTA` base stored later) is walked
/// down to with an explicit stack, never recursion. A walk that reaches an object still on its
/// stack is a cycle, and one longer than [`MAX_DELTA_DEPTH`] is refused before it gets longer.
fn resolve_chains(
    order: &[usize],
    offsets: &[u64],
    raw_type: &[u8],
    base_off: &[Option<u64>],
    at_offset: &HashMap<u64, usize>,
) -> Result<Vec<Chain>> {
    let too_deep = || {
        Error::Config(format!(
            "delta chain deeper than {MAX_DELTA_DEPTH} (or a cycle)"
        ))
    };
    let mut chains: Vec<Option<Chain>> = vec![None; offsets.len()];
    let mut on_path = vec![false; offsets.len()];
    // (object, its base's offset) for each delta walked through, outermost first.
    let mut path: Vec<(usize, u64)> = Vec::new();
    for &start in order {
        let mut j = start;
        let mut chain = loop {
            count_chain_step();
            if let Some(known) = chains[j] {
                break known;
            }
            if on_path[j] {
                return Err(too_deep());
            }
            let Some(b) = base_off[j] else {
                break Chain {
                    root: raw_type[j],
                    depth: 0,
                    min_off: offsets[j],
                    contiguous: true,
                };
            };
            let Some(&next) = at_offset.get(&b) else {
                // The base is not in this pack: the chain ends at the delta itself.
                break Chain {
                    root: raw_type[j],
                    depth: 1,
                    min_off: offsets[j].min(b),
                    contiguous: false,
                };
            };
            on_path[j] = true;
            path.push((j, b));
            if path.len() > MAX_DELTA_DEPTH as usize {
                return Err(too_deep());
            }
            j = next;
        };
        chains[j] = Some(chain);
        while let Some((p, b)) = path.pop() {
            count_chain_step();
            on_path[p] = false;
            chain = Chain {
                root: chain.root,
                depth: chain.depth + 1,
                min_off: offsets[p].min(chain.min_off),
                // A base at or after its delta (a fix-thin'd REF base) breaks the single span.
                contiguous: chain.contiguous && b < offsets[p],
            };
            if chain.depth > MAX_DELTA_DEPTH {
                return Err(too_deep());
            }
            chains[p] = Some(chain);
        }
    }
    chains
        .into_iter()
        .collect::<Option<Vec<_>>>()
        .ok_or_else(|| Error::Config("pack object left unresolved".into()))
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
        apply_delta, build, git_oid, parse_idx_v2, GitObjType, PackObject, ParsedPack, ReadBudget,
        CHAIN_STEPS, DELTAS_APPLIED, MAX_DELTA_DEPTH, OID_LEN, T_BLOB, T_OFS_DELTA, T_REF_DELTA,
    };
    use crate::pack::TestRng;
    use flate2::{write::ZlibEncoder, Compression};
    use std::cell::Cell;
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
        let at_offset = objects
            .iter()
            .enumerate()
            .map(|(i, o)| (o.offset, i))
            .collect();
        ParsedPack {
            pack_bytes: pack,
            pack_hash: [0; 32],
            bases: vec![None; objects.len()],
            objects,
            oid_to_idx,
            at_offset,
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

    /// Distinct made-up oids for objects at `offs`.
    fn numbered(offs: &[u64]) -> Vec<([u8; OID_LEN], u64)> {
        offs.iter()
            .enumerate()
            .map(|(i, &o)| {
                let mut oid = [0u8; OID_LEN];
                oid[..8].copy_from_slice(&(i as u64).to_be_bytes());
                (oid, o)
            })
            .collect()
    }

    /// A delta copy opcode for `base[off..off + size]` (`size` in `1..1 << 24`).
    fn copy_op(off: usize, size: usize) -> Vec<u8> {
        let mut op = vec![0x80u8];
        for i in 0..4 {
            let b = (off >> (8 * i)) as u8;
            if b != 0 {
                op[0] |= 1 << i;
                op.push(b);
            }
        }
        for i in 0..3 {
            let b = (size >> (8 * i)) as u8;
            if b != 0 {
                op[0] |= 1 << (4 + i);
                op.push(b);
            }
        }
        op
    }

    /// A delta that keeps all of a `base_len`-byte base and appends `extra` (1..=127 bytes).
    fn appending_delta(base_len: usize, extra: &[u8]) -> Vec<u8> {
        let mut d = delta_size(base_len as u64);
        d.extend(delta_size((base_len + extra.len()) as u64));
        if base_len > 0 {
            d.extend(copy_op(0, base_len));
        }
        d.push(extra.len() as u8);
        d.extend(extra);
        d
    }

    /// A pack under construction whose objects' contents are known, so its oids are real.
    #[derive(Default)]
    struct Packer {
        entries: Vec<Vec<u8>>,
        offs: Vec<u64>,
        contents: Vec<Vec<u8>>,
    }

    impl Packer {
        /// Where the next entry goes.
        fn next_off(&self) -> u64 {
            match (self.offs.last(), self.entries.last()) {
                (Some(&o), Some(e)) => o + e.len() as u64,
                _ => 12, // after the `PACK` header
            }
        }

        /// Append a packed entry whose object is `content`; returns its index.
        fn raw(&mut self, entry: Vec<u8>, content: Vec<u8>) -> usize {
            let at = self.next_off();
            self.entries.push(entry);
            self.offs.push(at);
            self.contents.push(content);
            self.offs.len() - 1
        }

        fn blob(&mut self, data: &[u8]) -> usize {
            self.raw(blob_entry(data), data.to_vec())
        }

        /// An `OFS_DELTA` on object `base` that appends `extra` to it.
        fn appending(&mut self, base: usize, extra: &[u8]) -> usize {
            let at = self.next_off();
            let delta = appending_delta(self.contents[base].len(), extra);
            let content = [&self.contents[base][..], extra].concat();
            self.raw(ofs_entry(at - self.offs[base], &delta), content)
        }

        /// The pack, its index and every object's oid, in entry order.
        fn finish(&self) -> (Vec<u8>, Vec<u8>, Vec<[u8; OID_LEN]>) {
            let (pack, offs) = pack_of(&self.entries);
            assert_eq!(offs, self.offs);
            let oids: Vec<[u8; OID_LEN]> = self
                .contents
                .iter()
                .map(|c| git_oid(GitObjType::Blob, c))
                .collect();
            let idx = idx_of(&oids.iter().copied().zip(offs).collect::<Vec<_>>());
            (pack, idx, oids)
        }
    }

    #[test]
    fn parse_resolves_every_chain_in_linear_steps() {
        // A chain as deep as git writes, then many deltas on its tip: walking each object's
        // chain afresh would take objects × depth steps.
        let depth = MAX_DELTA_DEPTH as usize - 1;
        let (mut pack, mut offs) = chain(depth);
        pack.truncate(pack.len() - 20);
        let tip = offs[depth];
        for _ in 0..3000 {
            let at = pack.len() as u64;
            pack.extend(ofs_entry(at - tip, &copy_all_delta(1)));
            offs.push(at);
        }
        let n = offs.len();
        pack[8..12].copy_from_slice(&(n as u32).to_be_bytes());
        pack.extend([0u8; 20]);
        let ids = numbered(&offs);

        let before = CHAIN_STEPS.with(Cell::get);
        let p = ParsedPack::parse(&pack, &idx_of(&ids)).unwrap();
        let steps = CHAIN_STEPS.with(Cell::get) - before;
        assert!(steps <= 4 * n as u64, "{steps} chain steps for {n} objects");

        // And the geometry is what walking each chain gives.
        for (k, (oid, off)) in ids.iter().enumerate() {
            let o = p.object(oid).unwrap();
            assert_eq!(o.offset, *off);
            assert_eq!(o.delta_depth as usize, k.min(depth + 1));
            assert!(o.contiguous && !o.is_ref_delta);
            assert_eq!(o.delta_chain_span, o.end() - offs[0]);
            assert_eq!(o.obj_type, GitObjType::Blob);
        }
        assert_eq!(p.object_bytes(&ids[n - 1].0).unwrap().1, b"x");
    }

    #[test]
    fn verify_builds_each_object_once_from_its_base() {
        // A chain of deltas each appending to the last, with a two-delta branch off every one,
        // and a REF delta whose base is stored after it.
        let mut pk = Packer::default();
        let mut tip = pk.blob(b"base");
        for i in 0..400 {
            let branch = pk.appending(tip, format!("b{i}").as_bytes());
            pk.appending(branch, b"+");
            tip = pk.appending(tip, format!("c{i}").as_bytes());
        }
        let later = b"stored after its delta".to_vec();
        let thin = [&later[..], &b"!"[..]].concat();
        let delta = appending_delta(later.len(), b"!");
        let ref_delta = pk.raw(ref_entry(git_oid(GitObjType::Blob, &later), &delta), thin);
        pk.blob(&later);
        let (pack, idx, oids) = pk.finish();
        let p = ParsedPack::parse(&pack, &idx).unwrap();
        assert!(p.objects.iter().any(|o| !o.contiguous));

        let before = DELTAS_APPLIED.with(Cell::get);
        assert_eq!(p.verify_all_oids().unwrap(), oids.len());
        // Every delta applied once; rebuilding every chain would apply about 240 000.
        let applied = DELTAS_APPLIED.with(Cell::get) - before;
        assert_eq!(applied, oids.len() as u64 - 2);
        for i in (0..oids.len()).step_by(97).chain([tip, ref_delta]) {
            assert_eq!(p.object_bytes(&oids[i]).unwrap().1, pk.contents[i]);
        }

        // A wrong oid for a delta is still caught.
        let mut ids: Vec<_> = oids.iter().copied().zip(pk.offs.iter().copied()).collect();
        ids[2].0[OID_LEN - 1] ^= 1;
        let p = ParsedPack::parse(&pack, &idx_of(&ids)).unwrap();
        assert!(matches!(
            p.verify_all_oids(),
            Err(crate::error::Error::Integrity)
        ));
    }

    #[test]
    fn a_read_is_held_to_one_total_across_its_chain() {
        // A base and ten deltas, one byte each: eleven bytes built in all.
        let (pack, offs) = chain(10);
        let span = &pack[..pack.len() - 20];
        let p = bare(Vec::new(), Vec::new());
        let links = p.links_at(span, 0, offs[10], false).unwrap();
        let total = |left| ReadBudget {
            step: u64::MAX,
            left,
        };
        assert_eq!(build(span, &links, total(11)).unwrap(), b"x");
        assert!(build(span, &links, total(10)).is_err());
        // Each step is still held to its own bound too.
        let per_step = ReadBudget {
            step: 0,
            left: u64::MAX,
        };
        assert!(build(span, &links, per_step).is_err());
        // The default total is the per-step bound times the headroom.
        let budget = ReadBudget::new(links.covered);
        assert_eq!(budget.left, budget.step * super::CHAIN_BUILD_HEADROOM);
    }

    #[test]
    fn a_whole_pack_read_is_budgeted_on_its_own_chain() {
        // A small chain that builds far more than its own bytes inflate to, in a pack whose
        // other bytes would cover it.
        let filler = TestRng(7).bytes(8192);
        let run = vec![b'a'; 1000];
        let mut delta = delta_size(1000);
        delta.extend(delta_size(200_000));
        for _ in 0..200 {
            delta.extend(copy_op(0, 1000));
        }
        let (a, b, c) = ([1u8; OID_LEN], [2u8; OID_LEN], [3u8; OID_LEN]);
        let run_entry = blob_entry(&run);
        let rel = run_entry.len() as u64;
        let (pack, offs) = pack_of(&[blob_entry(&filler), run_entry, ofs_entry(rel, &delta)]);
        let idx = idx_of(&[(a, offs[0]), (b, offs[1]), (c, offs[2])]);
        let p = ParsedPack::parse(&pack, &idx).unwrap();
        assert!(p.object_bytes(&c).is_err());
        assert_eq!(p.object_bytes(&a).unwrap().1, filler);
        assert_eq!(p.object_bytes(&b).unwrap().1, run);
        // As the span read of the same chain is.
        let obj = p.object(&c).unwrap().clone();
        let start = (obj.end() - obj.delta_chain_span) as usize;
        let slice = &pack[start..obj.end() as usize];
        assert!(p.reconstruct_from_span(&obj, slice).is_err());
    }

    #[test]
    fn an_honest_deepest_chain_of_a_large_file_still_reads() {
        // 64 KiB of text, then git's deepest chain of versions, each changing one byte.
        let mut text = Vec::new();
        let mut line = 0;
        while text.len() < 64 * 1024 {
            text.extend(
                format!("line {line} of a file that changes a little each version\n").bytes(),
            );
            line += 1;
        }
        text.truncate(64 * 1024);
        let len = text.len();
        let mut pk = Packer::default();
        pk.blob(&text);
        for v in 0..MAX_DELTA_DEPTH as usize {
            let at = (v * 997) % (len - 2) + 1;
            let mut d = delta_size(len as u64);
            d.extend(delta_size(len as u64));
            d.extend(copy_op(0, at));
            d.extend([1, b'#']);
            d.extend(copy_op(at + 1, len - at - 1));
            let mut content = pk.contents.last().unwrap().clone();
            content[at] = b'#';
            let rel = pk.next_off() - pk.offs.last().unwrap();
            pk.raw(ofs_entry(rel, &d), content);
        }
        let (pack, idx, oids) = pk.finish();
        let p = ParsedPack::parse(&pack, &idx).unwrap();
        let want = pk.contents.last().unwrap();
        let oid = oids.last().unwrap();
        assert_eq!(&p.object_bytes(oid).unwrap().1, want);
        let obj = p.object(oid).unwrap().clone();
        assert_eq!(obj.delta_depth, MAX_DELTA_DEPTH);
        let start = (obj.end() - obj.delta_chain_span) as usize;
        let slice = &pack[start..obj.end() as usize];
        assert_eq!(&p.reconstruct_from_span(&obj, slice).unwrap().1, want);
    }
}
