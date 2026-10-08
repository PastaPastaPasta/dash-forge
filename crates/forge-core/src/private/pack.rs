//! Sealed artifacts (`docs/security/private-repos.md` §3): every pack, objectLocator and
//! flatIndex of a private repository is stored as a 36-byte header followed by AES-256-GCM
//! segments of `S = 2^L` plaintext bytes (the STREAM construction), so a reader decrypts any byte
//! range without the rest of the file.
//!
//! The segment nonce `u64(i) ‖ 00 00 00 ‖ final` is built by hand (not `aead::stream`, whose
//! layout differs from the TypeScript side), under a key used for one file only.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};

use super::keys::{rnd32, sha256, EpochKeys};
use super::PrivateError;

/// `"DFPK"`.
pub const MAGIC: [u8; 4] = *b"DFPK";
/// The header version, also part of the per-file key's domain string (§3.3).
pub const VERSION: u8 = 0x01;
/// The header length.
pub const HEADER_LEN: usize = 36;
/// The segment size writers use: `L = 14`, 16 KiB.
pub const WRITE_SEG_LOG2: u8 = 14;

/// The size `plain` bytes take sealed (the header plus a 16-byte tag per segment of
/// `2^WRITE_SEG_LOG2` bytes, `36 + n + 16·nSeg`): what a private repository stores, and prices.
pub fn sealed_upper_bound(plain: u64) -> u64 {
    let segments = plain.div_ceil(1 << WRITE_SEG_LOG2).max(1);
    plain + HEADER_LEN as u64 + 16 * segments
}
const MIN_SEG_LOG2: u8 = 10;
const MAX_SEG_LOG2: u8 = 20;
const TAG_LEN: u64 = 16;

/// What the first bytes of a stored artifact say it is (§3.2, `docs/security/private-repos.md`
/// §18.2): a reader checks them before it hands bytes to git, and, in a converted repository,
/// before it downloads a pack written while the repository was private.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Head {
    /// Not a sealed artifact: no `DFPK` magic (a git pack starts `PACK`).
    Plain,
    /// A version-0x01 sealed artifact under key epoch `epoch`.
    Sealed {
        /// The header's epoch.
        epoch: u32,
    },
    /// A `DFPK` header of another version: specific people (0x02) or a layout this client does
    /// not know. Skipped, never fatal.
    OtherVersion(u8),
    /// Too short to tell (fewer than the 12 bytes up to the epoch).
    Short,
}

/// [`Head`] of an artifact from its first bytes (at least 12 to read a version-0x01 epoch).
#[must_use]
pub fn sniff(head: &[u8]) -> Head {
    let n = head.len().min(MAGIC.len());
    if head[..n] != MAGIC[..n] {
        return Head::Plain;
    }
    match head.get(4) {
        None => Head::Short,
        Some(&VERSION) => head.get(8..12).map_or(Head::Short, |e| Head::Sealed {
            epoch: u32::from_be_bytes(e.try_into().expect("4 bytes")),
        }),
        Some(&v) => Head::OtherVersion(v),
    }
}

/// A parsed, length-checked sealed-artifact header. Its fields are read-only views of the 36
/// raw bytes (which are the AD of every segment), so they can never drift apart.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PackHeader {
    raw: [u8; HEADER_LEN],
    seg_log2: u8,
    epoch: u32,
    plaintext_len: u64,
    file_id: [u8; 16],
}

impl PackHeader {
    fn build(seg_log2: u8, epoch: u32, plaintext_len: u64, file_id: [u8; 16]) -> Self {
        let mut raw = [0u8; HEADER_LEN];
        raw[..4].copy_from_slice(&MAGIC);
        raw[4] = VERSION;
        raw[5] = seg_log2;
        raw[8..12].copy_from_slice(&epoch.to_be_bytes());
        raw[12..20].copy_from_slice(&plaintext_len.to_be_bytes());
        raw[20..36].copy_from_slice(&file_id);
        Self {
            raw,
            seg_log2,
            epoch,
            plaintext_len,
            file_id,
        }
    }

    /// Parse and check a header against the artifact's sealed length (§3.5 step 2): magic,
    /// version, `10 ≤ L ≤ 20`, reserved zero, and `36 + plaintextLen + 16·nSeg == sealed_len`.
    pub fn parse(bytes: &[u8], sealed_len: u64) -> Result<Self, PrivateError> {
        let raw: [u8; HEADER_LEN] = bytes
            .get(..HEADER_LEN)
            .and_then(|b| b.try_into().ok())
            .ok_or(PrivateError::SealedPackCorrupt)?;
        let seg_log2 = raw[5];
        // A DFPK header of another version (0x02 is sealed to specific people, later versions to
        // keys this client does not know) is not this layout: skipped by readers, never read as
        // corrupt (§3.2).
        if raw[..4] == MAGIC && raw[4] != VERSION {
            return Err(PrivateError::UnknownVersion(raw[4]));
        }
        let ok = raw[..4] == MAGIC
            && (MIN_SEG_LOG2..=MAX_SEG_LOG2).contains(&seg_log2)
            && raw[6..8] == [0, 0];
        if !ok {
            return Err(PrivateError::SealedPackCorrupt);
        }
        let epoch = u32::from_be_bytes(raw[8..12].try_into().expect("4 bytes"));
        let plaintext_len = u64::from_be_bytes(raw[12..20].try_into().expect("8 bytes"));
        let file_id: [u8; 16] = raw[20..36].try_into().expect("16 bytes");
        let h = Self {
            raw,
            seg_log2,
            epoch,
            plaintext_len,
            file_id,
        };
        if h.sealed_len() != Some(sealed_len) {
            return Err(PrivateError::SealedPackCorrupt);
        }
        Ok(h)
    }

    /// The 36 header bytes (the AD of every segment).
    #[must_use]
    pub fn bytes(&self) -> &[u8; HEADER_LEN] {
        &self.raw
    }

    /// `L`: segments are `2^L` plaintext bytes (`10 ≤ L ≤ 20`).
    #[must_use]
    pub fn seg_log2(&self) -> u8 {
        self.seg_log2
    }

    /// The epoch whose key sealed the artifact.
    #[must_use]
    pub fn epoch(&self) -> u32 {
        self.epoch
    }

    /// The exact plaintext length.
    #[must_use]
    pub fn plaintext_len(&self) -> u64 {
        self.plaintext_len
    }

    /// The per-artifact file id.
    #[must_use]
    pub fn file_id(&self) -> &[u8; 16] {
        &self.file_id
    }

    /// `S = 2^L`.
    #[must_use]
    pub fn seg_size(&self) -> u64 {
        1u64 << self.seg_log2
    }

    /// `nSeg = max(1, ceil(plaintextLen / S))`.
    #[must_use]
    pub fn segments(&self) -> u64 {
        self.plaintext_len.div_ceil(self.seg_size()).max(1)
    }

    /// `36 + plaintextLen + 16·nSeg`, `None` on overflow (a hostile header).
    #[must_use]
    pub fn sealed_len(&self) -> Option<u64> {
        (HEADER_LEN as u64)
            .checked_add(self.plaintext_len)?
            .checked_add(TAG_LEN.checked_mul(self.segments())?)
    }

    fn nonce(&self, i: u64) -> [u8; 12] {
        let mut n = [0u8; 12];
        n[..8].copy_from_slice(&i.to_be_bytes());
        n[11] = u8::from(i + 1 == self.segments());
        n
    }

    /// Plaintext bytes in segment `i`.
    fn seg_plain_len(&self, i: u64) -> u64 {
        let start = i * self.seg_size();
        (self.plaintext_len - start.min(self.plaintext_len)).min(self.seg_size())
    }
}

/// A plaintext range mapped onto the sealed file (§3.5).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SealedRange {
    /// First segment, `a >> L`.
    pub first_segment: u64,
    /// Last segment, `(b − 1) >> L`.
    pub last_segment: u64,
    /// Sealed byte range `[start, end)` holding those segments.
    pub start: u64,
    /// End of the sealed byte range (exclusive).
    pub end: u64,
}

impl PackHeader {
    /// The sealed bytes to fetch for plaintext `[a, b)` (§3.5). Checked arithmetic throughout:
    /// a header that passed [`PackHeader::parse`] cannot overflow, but nothing here relies on it.
    pub fn sealed_range(&self, a: u64, b: u64) -> Result<SealedRange, PrivateError> {
        if a >= b || b > self.plaintext_len {
            return Err(PrivateError::OutOfRange);
        }
        let corrupt = || PrivateError::SealedPackCorrupt;
        let seg = self.seg_size().checked_add(TAG_LEN).ok_or_else(corrupt)?;
        let (s0, s1) = (a >> self.seg_log2, (b - 1) >> self.seg_log2);
        let sealed = self.sealed_len().ok_or_else(corrupt)?;
        let at = |segments: u64| {
            segments
                .checked_mul(seg)
                .and_then(|n| n.checked_add(HEADER_LEN as u64))
                .ok_or_else(corrupt)
        };
        Ok(SealedRange {
            first_segment: s0,
            last_segment: s1,
            start: at(s0)?,
            end: at(s1.checked_add(1).ok_or_else(corrupt)?)?.min(sealed),
        })
    }

    /// Plaintext `[a, b)` from `sealed`, which must be exactly the sealed bytes
    /// [`PackHeader::sealed_range`]`(a, b)` names (computed here, never taken from the caller).
    pub fn open_range(
        &self,
        keys: &EpochKeys,
        sealed: &[u8],
        a: u64,
        b: u64,
    ) -> Result<Vec<u8>, PrivateError> {
        let range = self.sealed_range(a, b)?;
        if sealed.len() as u64 != range.end - range.start {
            return Err(PrivateError::SealedPackCorrupt);
        }
        let cipher = self.cipher(keys)?;
        let mut out = zeroize::Zeroizing::new(Vec::new());
        let mut off = 0usize;
        for i in range.first_segment..=range.last_segment {
            let len = usize::try_from(self.seg_plain_len(i) + TAG_LEN)
                .map_err(|_| PrivateError::SealedPackCorrupt)?;
            let end = off
                .checked_add(len)
                .ok_or(PrivateError::SealedPackCorrupt)?;
            let seg = sealed
                .get(off..end)
                .ok_or(PrivateError::SealedPackCorrupt)?;
            out.extend_from_slice(&zeroize::Zeroizing::new(
                self.open_segment(&cipher, i, seg)?,
            ));
            off = end;
        }
        // a >= first_segment·S by construction of first_segment = a >> L
        let skip = usize::try_from(a - (range.first_segment << self.seg_log2))
            .map_err(|_| PrivateError::OutOfRange)?;
        let take = usize::try_from(b - a).map_err(|_| PrivateError::OutOfRange)?;
        out.get(skip..skip + take)
            .map(<[u8]>::to_vec)
            .ok_or(PrivateError::SealedPackCorrupt)
    }

    fn cipher(&self, keys: &EpochKeys) -> Result<Aes256Gcm, PrivateError> {
        if keys.epoch() != self.epoch {
            return Err(PrivateError::NoKey(self.epoch));
        }
        let key = keys.pack_key(&self.file_id);
        Ok(Aes256Gcm::new((&*key).into()))
    }

    fn open_segment(
        &self,
        cipher: &Aes256Gcm,
        i: u64,
        seg: &[u8],
    ) -> Result<Vec<u8>, PrivateError> {
        cipher
            .decrypt(
                Nonce::from_slice(&self.nonce(i)),
                Payload {
                    msg: seg,
                    aad: &self.raw,
                },
            )
            .map_err(|_| PrivateError::SealedPackCorrupt)
    }
}

/// Seal `plaintext` under `keys` with a hedged random `fileId` (§3.6) and `L = 14`.
pub fn seal(keys: &EpochKeys, plaintext: &[u8]) -> Result<Vec<u8>, PrivateError> {
    let file_id = keys.hedged_file_id(&rnd32()?, &sha256(plaintext));
    seal_inner(keys, plaintext, file_id, WRITE_SEG_LOG2)
}

/// [`seal`] with a caller-chosen `fileId` and segment size: the conformance vectors only.
#[cfg(any(test, feature = "vectors"))]
pub fn seal_with_file_id(
    keys: &EpochKeys,
    plaintext: &[u8],
    file_id: [u8; 16],
    seg_log2: u8,
) -> Result<Vec<u8>, PrivateError> {
    seal_inner(keys, plaintext, file_id, seg_log2)
}

fn seal_inner(
    keys: &EpochKeys,
    plaintext: &[u8],
    file_id: [u8; 16],
    seg_log2: u8,
) -> Result<Vec<u8>, PrivateError> {
    let h = PackHeader::build(seg_log2, keys.epoch(), plaintext.len() as u64, file_id);
    let cap = usize::try_from(h.sealed_len().ok_or(PrivateError::OutOfRange)?)
        .map_err(|_| PrivateError::OutOfRange)?;
    let mut out = Vec::with_capacity(cap);
    out.extend_from_slice(&h.raw);
    let mut w = SealWriter::new(keys, h, &mut out)?;
    w.write_all_plain(plaintext)?;
    w.finish()?;
    Ok(out)
}

/// Streaming sealer: plaintext in, sealed bytes out, one segment in memory at a time. The
/// plaintext length (and so the header) must be known up front, as the header is the AD.
pub struct SealWriter<'k, W: Write> {
    header: PackHeader,
    cipher: Aes256Gcm,
    out: W,
    buf: zeroize::Zeroizing<Vec<u8>>,
    next: u64,
    written: u64,
    _keys: std::marker::PhantomData<&'k EpochKeys>,
}

impl<'k, W: Write> SealWriter<'k, W> {
    fn new(keys: &'k EpochKeys, header: PackHeader, out: W) -> Result<Self, PrivateError> {
        let cipher = header.cipher(keys)?;
        Ok(Self {
            cipher,
            out,
            buf: zeroize::Zeroizing::new(Vec::with_capacity(
                usize::try_from(header.seg_size()).unwrap_or(0),
            )),
            next: 0,
            written: 0,
            header,
            _keys: std::marker::PhantomData,
        })
    }

    /// Start sealing a `plaintext_len`-byte artifact into `out` (the header is written first),
    /// with a hedged random `fileId` derived from `plaintext_sha256`.
    pub fn start(
        keys: &'k EpochKeys,
        plaintext_len: u64,
        plaintext_sha256: &[u8; 32],
        mut out: W,
    ) -> Result<Self, PrivateError> {
        let file_id = keys.hedged_file_id(&rnd32()?, plaintext_sha256);
        let h = PackHeader::build(WRITE_SEG_LOG2, keys.epoch(), plaintext_len, file_id);
        out.write_all(&h.raw)
            .map_err(|_| PrivateError::SealedPackCorrupt)?;
        Self::new(keys, h, out)
    }

    fn emit(&mut self) -> Result<(), PrivateError> {
        let ct = self
            .cipher
            .encrypt(
                Nonce::from_slice(&self.header.nonce(self.next)),
                Payload {
                    msg: &self.buf,
                    aad: &self.header.raw,
                },
            )
            .map_err(|_| PrivateError::SealedPackCorrupt)?;
        self.out
            .write_all(&ct)
            .map_err(|_| PrivateError::SealedPackCorrupt)?;
        self.buf.clear();
        self.next += 1;
        Ok(())
    }

    /// Feed plaintext bytes.
    pub fn write_all_plain(&mut self, mut data: &[u8]) -> Result<(), PrivateError> {
        if self.written + data.len() as u64 > self.header.plaintext_len {
            return Err(PrivateError::OutOfRange);
        }
        let seg = usize::try_from(self.header.seg_size()).unwrap_or(usize::MAX);
        while !data.is_empty() {
            // a full segment is emitted only once more data follows, so the last (final) one
            // is always emitted by `finish`
            if self.buf.len() == seg {
                self.emit()?;
            }
            let take = (seg - self.buf.len()).min(data.len());
            self.buf.extend_from_slice(&data[..take]);
            data = &data[take..];
            self.written += take as u64;
        }
        Ok(())
    }

    /// Seal the last (final) segment. Fails if fewer bytes were written than the header says.
    pub fn finish(mut self) -> Result<W, PrivateError> {
        if self.written != self.header.plaintext_len {
            return Err(PrivateError::OutOfRange);
        }
        self.emit()?;
        Ok(self.out)
    }
}

/// Open a whole sealed artifact: `size_bytes` (the manifest's) is checked first, before any
/// allocation (§3.5 step 1), then the header (step 2), then the key (step 3), then every tag.
pub fn open<'k>(
    sealed: &[u8],
    size_bytes: u64,
    keys_for: impl Fn(u32) -> Option<&'k EpochKeys>,
) -> Result<Vec<u8>, PrivateError> {
    if sealed.len() as u64 != size_bytes {
        return Err(PrivateError::SizeMismatch);
    }
    let mut out = Vec::new();
    open_streaming(sealed, size_bytes, keys_for, &mut out)?;
    Ok(out)
}

/// Open a sealed artifact from a reader into a writer, one segment at a time (the in-browser
/// fallback clone and multi-hundred-MB packs). A failure may leave a prefix of verified
/// plaintext in `out`; callers discard it.
pub fn open_streaming<'k, R: Read, W: Write>(
    mut sealed: R,
    size_bytes: u64,
    keys_for: impl Fn(u32) -> Option<&'k EpochKeys>,
    mut out: W,
) -> Result<u64, PrivateError> {
    let mut head = [0u8; HEADER_LEN];
    sealed.read_exact(&mut head).map_err(|_| {
        if size_bytes < HEADER_LEN as u64 {
            PrivateError::SealedPackCorrupt
        } else {
            PrivateError::SizeMismatch
        }
    })?;
    let h = PackHeader::parse(&head, size_bytes)?;
    let keys = keys_for(h.epoch).ok_or(PrivateError::NoKey(h.epoch))?;
    let cipher = h.cipher(keys)?;
    let mut seg = vec![
        0u8;
        usize::try_from(h.seg_size() + TAG_LEN)
            .map_err(|_| PrivateError::SealedPackCorrupt)?
    ];
    for i in 0..h.segments() {
        let len = usize::try_from(h.seg_plain_len(i) + TAG_LEN)
            .map_err(|_| PrivateError::SealedPackCorrupt)?;
        sealed
            .read_exact(&mut seg[..len])
            .map_err(|_| PrivateError::SizeMismatch)?;
        let pt = zeroize::Zeroizing::new(h.open_segment(&cipher, i, &seg[..len])?);
        out.write_all(&pt)
            .map_err(|_| PrivateError::SealedPackCorrupt)?;
    }
    let mut extra = [0u8; 1];
    if sealed
        .read(&mut extra)
        .map_err(|_| PrivateError::SealedPackCorrupt)?
        != 0
    {
        return Err(PrivateError::SizeMismatch);
    }
    Ok(h.plaintext_len)
}

/// Why a ranged read failed: the storage fetch, or the sealed bytes.
#[derive(Debug)]
pub enum RangeError<E> {
    /// The caller's fetch failed.
    Fetch(E),
    /// The sealed artifact failed a check (§3.5).
    Sealed(PrivateError),
}

impl<E> From<PrivateError> for RangeError<E> {
    fn from(e: PrivateError) -> Self {
        Self::Sealed(e)
    }
}

/// One storage copy of a sealed artifact, as a ranged read names it.
#[derive(Debug, Clone, Copy)]
pub struct PackCopy<'a> {
    /// The manifest's `packHash`.
    pub pack_hash: &'a [u8; 32],
    /// A stable id of this copy (its manifest `$id`, or its URI).
    pub copy: &'a str,
    /// The manifest's `sizeBytes`.
    pub size_bytes: u64,
}

/// Sealed-artifact headers cached for the session per `(packHash, copy)` (§3.5): a ranged
/// reader reads a copy's header once and never derives a key or nonce from one it has not read.
///
/// A ranged read cannot check `packHash`, so a header is cached only after a segment tag has
/// verified under it (the header is every segment's AD: a verified tag authenticates it), after
/// it was checked against the manifest's `sizeBytes`; a copy that turns out corrupt is evicted.
/// One hostile copy can therefore never poison the pack's other copies.
#[derive(Debug, Default)]
pub struct HeaderCache {
    headers: Mutex<HashMap<([u8; 32], String), PackHeader>>,
}

impl HeaderCache {
    /// An empty cache.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    fn get(&self, key: &([u8; 32], String)) -> Option<PackHeader> {
        self.headers
            .lock()
            .expect("header cache poisoned")
            .get(key)
            .copied()
    }

    /// Read plaintext `[a, b)` of `copy`. `fetch(start, end)` returns sealed bytes
    /// `[start, end)` of that copy: the header (`0..36`) on a cache miss, then only the range's
    /// segments.
    pub fn read_range<'k, E>(
        &self,
        copy: &PackCopy<'_>,
        keys_for: impl Fn(u32) -> Option<&'k EpochKeys>,
        mut fetch: impl FnMut(u64, u64) -> Result<Vec<u8>, E>,
        a: u64,
        b: u64,
    ) -> Result<Vec<u8>, RangeError<E>> {
        let key = (*copy.pack_hash, copy.copy.to_owned());
        let cached = self.get(&key);
        let header = if let Some(h) = cached {
            h
        } else {
            let bytes = fetch(0, HEADER_LEN as u64).map_err(RangeError::Fetch)?;
            PackHeader::parse(&bytes, copy.size_bytes)?
        };
        let keys = keys_for(header.epoch).ok_or(PrivateError::NoKey(header.epoch))?;
        let range = header.sealed_range(a, b)?;
        let sealed = fetch(range.start, range.end).map_err(RangeError::Fetch)?;
        match header.open_range(keys, &sealed, a, b) {
            Ok(out) => {
                // the header verified under a segment tag: now it may be cached
                if cached.is_none() {
                    self.headers
                        .lock()
                        .expect("header cache poisoned")
                        .insert(key, header);
                }
                Ok(out)
            }
            Err(e) => {
                if e == PrivateError::SealedPackCorrupt {
                    self.headers
                        .lock()
                        .expect("header cache poisoned")
                        .remove(&key);
                }
                Err(e.into())
            }
        }
    }

    /// How many headers are cached.
    #[must_use]
    pub fn len(&self) -> usize {
        self.headers.lock().expect("header cache poisoned").len()
    }

    /// Whether nothing is cached.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::private::EpochKey;

    fn keys() -> EpochKeys {
        EpochKeys::derive(&[0x11; 32], 0, &EpochKey::from_bytes([5; 32]))
    }

    fn plain(n: usize) -> Vec<u8> {
        (0..n).map(|i| u8::try_from(i % 251).unwrap()).collect()
    }

    #[test]
    fn production_seal_uses_a_fresh_file_id() {
        let k = keys();
        let p = plain(20_000);
        let a = seal(&k, &p).unwrap();
        let b = seal(&k, &p).unwrap();
        assert_ne!(a[20..36], b[20..36]);
        assert_ne!(sha256(&a), sha256(&b), "re-sealing changes packHash");
        assert_eq!(open(&a, a.len() as u64, |_| Some(&k)).unwrap(), p);
    }

    #[test]
    fn streaming_matches_whole() {
        let k = keys();
        for n in [0, 1, 16_384, 16_385, 50_000] {
            let p = plain(n);
            let mut sealed = Vec::new();
            let mut w = SealWriter::start(&k, n as u64, &sha256(&p), &mut sealed).unwrap();
            for chunk in p.chunks(777) {
                w.write_all_plain(chunk).unwrap();
            }
            w.finish().unwrap();
            let h = PackHeader::parse(&sealed, sealed.len() as u64).unwrap();
            assert_eq!(h.plaintext_len(), n as u64);
            let mut out = Vec::new();
            open_streaming(&sealed[..], sealed.len() as u64, |_| Some(&k), &mut out).unwrap();
            assert_eq!(out, p, "n = {n}");
        }
    }

    #[test]
    fn seal_writer_refuses_a_short_or_long_plaintext() {
        let k = keys();
        let mut sink = Vec::new();
        let mut w = SealWriter::start(&k, 10, &[0; 32], &mut sink).unwrap();
        assert_eq!(w.write_all_plain(&[0; 11]), Err(PrivateError::OutOfRange));
        w.write_all_plain(&[0; 5]).unwrap();
        assert!(matches!(w.finish(), Err(PrivateError::OutOfRange)));
    }

    #[allow(clippy::unnecessary_wraps)]
    fn slice(sealed: &[u8], start: u64, end: u64) -> Result<Vec<u8>, ()> {
        Ok(sealed[usize::try_from(start).unwrap()..usize::try_from(end).unwrap()].to_vec())
    }

    fn copy<'a>(pack_hash: &'a [u8; 32], copy: &'a str, size_bytes: u64) -> PackCopy<'a> {
        PackCopy {
            pack_hash,
            copy,
            size_bytes,
        }
    }

    #[test]
    fn header_cache_reads_a_verified_header_once() {
        let k = keys();
        let p = plain(40_000);
        let sealed = seal(&k, &p).unwrap();
        let cache = HeaderCache::new();
        let hash = sha256(&sealed);
        let size = sealed.len() as u64;
        let mut header_reads = 0;
        for _ in 0..3 {
            let out = cache
                .read_range(
                    &copy(&hash, "copy-a", size),
                    |_| Some(&k),
                    |s, e| {
                        header_reads += usize::from(s == 0);
                        slice(&sealed, s, e)
                    },
                    20_000,
                    20_100,
                )
                .unwrap();
            assert_eq!(out, p[20_000..20_100]);
        }
        assert_eq!(header_reads, 1);
        assert_eq!(cache.len(), 1);
    }

    #[test]
    fn a_forged_header_is_never_cached_and_never_poisons_another_copy() {
        let k = keys();
        let p = plain(40_000);
        let honest = seal(&k, &p).unwrap();
        let hash = sha256(&honest);
        let size = honest.len() as u64;
        // a well-formed header with another fileId: parses, but every tag fails under it
        let mut forged = honest.clone();
        forged[20] ^= 1;
        let cache = HeaderCache::new();
        let bad = cache.read_range(
            &copy(&hash, "hostile", size),
            |_| Some(&k),
            |s, e| slice(&forged, s, e),
            0,
            10,
        );
        assert!(matches!(
            bad,
            Err(RangeError::Sealed(PrivateError::SealedPackCorrupt))
        ));
        assert!(cache.is_empty(), "an unauthenticated header is not cached");
        let good = cache
            .read_range(
                &copy(&hash, "honest", size),
                |_| Some(&k),
                |s, e| slice(&honest, s, e),
                0,
                10,
            )
            .unwrap();
        assert_eq!(good, p[..10]);
        // the forged copy's reads keep failing, and never through the honest copy's header
        let again = cache.read_range(
            &copy(&hash, "hostile", size),
            |_| Some(&k),
            |s, e| slice(&forged, s, e),
            0,
            10,
        );
        assert!(again.is_err());
        assert_eq!(cache.len(), 1);
    }

    #[test]
    fn a_size_mismatch_is_refused_before_caching() {
        let k = keys();
        let sealed = seal(&k, &plain(100)).unwrap();
        let cache = HeaderCache::new();
        let r = cache.read_range(
            &copy(&sha256(&sealed), "c", sealed.len() as u64 + 1),
            |_| Some(&k),
            |s, e| slice(&sealed, s, e),
            0,
            1,
        );
        assert!(r.is_err());
        assert!(cache.is_empty());
    }

    #[test]
    fn open_range_refuses_a_range_outside_the_plaintext() {
        let k = keys();
        let sealed = seal(&k, &plain(100)).unwrap();
        let h = PackHeader::parse(&sealed, sealed.len() as u64).unwrap();
        assert_eq!(
            h.open_range(&k, &sealed[36..], 50, 101),
            Err(PrivateError::OutOfRange)
        );
        assert_eq!(
            h.open_range(&k, &sealed[36..], 5, 5),
            Err(PrivateError::OutOfRange)
        );
        assert_eq!(
            h.open_range(&k, &sealed[37..], 0, 100),
            Err(PrivateError::SealedPackCorrupt)
        );
    }

    #[test]
    fn hostile_plaintext_len_does_not_overflow() {
        let mut h = [0u8; HEADER_LEN];
        h[..4].copy_from_slice(&MAGIC);
        h[4] = VERSION;
        h[5] = 10;
        h[12..20].copy_from_slice(&u64::MAX.to_be_bytes());
        assert_eq!(
            PackHeader::parse(&h, 100),
            Err(PrivateError::SealedPackCorrupt)
        );
    }
}
