//! Narrower branches (mixed-visibility DESIGN §4.3 "Narrower branches (phase 3F)", D34, D39;
//! `docs/security/private-repos.md` §20): a branch whose audience is narrower than All members
//! (Maintainers, Writers and maintainers, a group plus people, or people) has its own **branch
//! key**, in generations chained like the epoch chain.
//!
//! ```text
//! K_br,g      = 32 random bytes, generation g = 0, 1, …
//! PRK_br,g    = HKDF-Extract(salt = repoId, IKM = K_br,g)
//! KCV_br,g    = HKDF-Expand(PRK_br,g, "dash-forge/v2/br-kcv" ‖ 0x00, 14)
//! refNameHash = HMAC-SHA256(HKDF-Expand(PRK_br,g, "dash-forge/v2/br-ref" ‖ 0x00, 32), name)
//! ref update  = enc v0x06 = 0x06 ‖ KCV_br,g[0..4] ‖ nonce(12) ‖ COMMIT_obj(32) ‖ AES-256-GCM(…) ‖ tag(16)
//!               (v0x03's framing with PRK_br,g for PRK_e and u32(g) for u32(e) in the `K_obj`
//!               info and the AD's epoch field; the document's `epoch` is g)            (65 B)
//! packs       = DFPK header 0x03: as 0x01, with KCV_br,g[0..4] where 0x01 carries the epoch,
//!               K_pack = HKDF-Expand(PRK_br,g, "dash-forge/v2/pack" ‖ 0x00 ‖ 0x03 ‖ fileId, 32)
//! ```
//!
//! A branch's keys reach its audience in **`branchKey` letters** (a kind-10 key letter, DFPK 0x02 to
//! each recipient): `{"type":"branchKey","v":1,"name","gen","keys":[K_br,0 … K_br,g],"group",
//! "people"}`. A letter carries every generation, not only the newest two: a joiner never
//! received the earlier letters, and there is no on-chain anchor per generation to walk. Readers
//! fold the letters they open into a [`BranchRing`]: per name, the first letter starts the chain
//! and a later one counts only when it agrees with it on every generation both carry, so a
//! writer outside the audience (who does not hold the keys) cannot redirect a branch by sending
//! its members a letter for a new generation of its own.
//!
//! The audience grows: the actor letters the joiner the current generation (it reads the whole
//! history). It shrinks: generation g+1, whose letter carries the earlier keys, goes to the
//! remaining recipients, and the next push uses it; a write under an older generation after the
//! newer one was issued (plus [`super::GRACE_BLOCKS`]) by someone outside the current audience is
//! late and never folded.

use std::collections::{BTreeMap, BTreeSet};

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::Sha256;
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

use super::blind;
use super::doc::{DocHeader, Opened, Unreadable, NONCE_LEN, TAG_LEN};
use super::key_letter::TypedLetter;
use super::keys::{ct_eq, rnd32, sha256, ObjKeys};
use super::members_ref::{self, RefUpdateIn, SealedRefUpdate};
use super::pack::{HEADER_LEN, MAGIC, WRITE_SEG_LOG2};
use super::{tlv, DocKind, Fields, PrivateError, GRACE_BLOCKS};
use crate::env::{Audience, Group};
use crate::rules::v2::Visibility;

/// `enc` version of a narrower branch's ref update.
pub const V6: u8 = 0x06;
/// Smallest v0x06 `enc`: version, KCV prefix, nonce, `COMMIT_obj` and tag.
pub const MIN_V6: usize = 1 + 4 + NONCE_LEN + 32 + TAG_LEN;
/// The DFPK header version of an artifact sealed under a branch key.
pub const PACK_VERSION: u8 = 0x03;
/// The kind-10 key letter type that carries a branch's keys.
pub const LETTER_TYPE: &str = "branchKey";
/// The most generations a letter carries (a branch whose audience shrank this often is re-made).
pub const MAX_GENERATIONS: usize = 256;
/// The most people a letter lists (DFPK 0x02 holds 64 slots, the writer's among them).
pub const MAX_PEOPLE: usize = 63;
const MIN_SEG_LOG2: u8 = 10;
const MAX_SEG_LOG2: u8 = 20;

/// A 32-byte branch key `K_br,g`. Zeroized on drop; its `Debug` never shows the bytes, its
/// equality is constant-time.
#[derive(Clone, Zeroize, ZeroizeOnDrop)]
pub struct BranchKey([u8; 32]);

impl PartialEq for BranchKey {
    fn eq(&self, other: &Self) -> bool {
        ct_eq(&self.0, &other.0)
    }
}

impl Eq for BranchKey {}

impl std::fmt::Debug for BranchKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("BranchKey(<redacted>)")
    }
}

impl BranchKey {
    /// A fresh key from the OS CSPRNG: a new branch, or a new generation of one.
    pub fn generate() -> Result<Self, PrivateError> {
        Ok(Self(rnd32()?))
    }

    /// Wrap raw key bytes (a letter's).
    #[must_use]
    pub fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    /// A key from 64 lower-case hex characters (a letter's spelling); `None` otherwise.
    #[must_use]
    pub fn from_hex(s: &str) -> Option<Self> {
        if s.len() != 64
            || !s
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return None;
        }
        let bytes = Zeroizing::new(hex::decode(s).ok()?);
        <[u8; 32]>::try_from(bytes.as_slice()).ok().map(Self)
    }

    /// The raw bytes, for a letter's body only.
    #[must_use]
    pub fn expose(&self) -> &[u8; 32] {
        &self.0
    }

    /// The letter's spelling (lower-case hex).
    #[must_use]
    pub fn to_hex(&self) -> Zeroizing<String> {
        Zeroizing::new(hex::encode(self.0))
    }
}

/// The subkeys of one generation of one branch key of one repository.
#[derive(Clone, Zeroize, ZeroizeOnDrop)]
pub struct BranchKeys {
    #[zeroize(skip)]
    repo_id: [u8; 32],
    #[zeroize(skip)]
    gen: u32,
    prk: [u8; 32],
    ref_key: [u8; 32],
    hedge: [u8; 32],
    #[zeroize(skip)]
    kcv: [u8; 14],
}

impl std::fmt::Debug for BranchKeys {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BranchKeys")
            .field("gen", &self.gen)
            .field("kcv", &hex::encode(&self.kcv[..4]))
            .finish_non_exhaustive()
    }
}

fn hmac(key: &[u8; 32], parts: &[&[u8]]) -> [u8; 32] {
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(key).expect("HMAC takes any key length");
    for p in parts {
        mac.update(p);
    }
    mac.finalize().into_bytes().into()
}

impl BranchKeys {
    /// Derive the subkeys of `key`, generation `gen` of a branch of repository `repo_id`.
    #[must_use]
    pub fn derive(repo_id: &[u8; 32], gen: u32, key: &BranchKey) -> Self {
        let (prk, _) = Hkdf::<Sha256>::extract(Some(repo_id), key.expose());
        let mut keys = Self {
            repo_id: *repo_id,
            gen,
            prk: prk.into(),
            ref_key: [0; 32],
            hedge: [0; 32],
            kcv: [0; 14],
        };
        keys.ref_key = keys.expand(b"dash-forge/v2/br-ref\0");
        // the nonce and fileId hedge (§3.6); a writer's choice, never checked by a reader
        keys.hedge = keys.expand(b"dash-forge/v2/br-hedge\0");
        let kcv = Zeroizing::new(keys.expand(b"dash-forge/v2/br-kcv\0"));
        keys.kcv.copy_from_slice(&kcv[..14]);
        keys
    }

    fn expand(&self, info: &[u8]) -> [u8; 32] {
        let hk = Hkdf::<Sha256>::from_prk(&self.prk).expect("a 32-byte PRK is a valid HKDF PRK");
        let mut okm = [0u8; 32];
        hk.expand(info, &mut okm)
            .expect("32 bytes is a valid HKDF-SHA256 output length");
        okm
    }

    /// The repository.
    #[must_use]
    pub fn repo_id(&self) -> &[u8; 32] {
        &self.repo_id
    }

    /// The generation.
    #[must_use]
    pub fn gen(&self) -> u32 {
        self.gen
    }

    /// `KCV_br,g` (14 bytes): error detection and key selection, never authorization.
    #[must_use]
    pub fn kcv(&self) -> &[u8; 14] {
        &self.kcv
    }

    /// `KCV_br,g[0..4]`, what an `enc` v0x06 and a DFPK 0x03 header carry.
    #[must_use]
    pub fn kcv4(&self) -> [u8; 4] {
        [self.kcv[0], self.kcv[1], self.kcv[2], self.kcv[3]]
    }

    /// `refNameHash = HMAC-SHA256(K_brref,g, name)`.
    #[must_use]
    pub fn ref_name_hash(&self, name: &str) -> [u8; 32] {
        hmac(&self.ref_key, &[name.as_bytes()])
    }

    /// `K_obj = HKDF-Expand(PRK_br,g, "dash-forge/v2/obj" ‖ 0x00 ‖ u32(g) ‖ nonce ‖ SHA-256(AD), 32)`.
    fn obj_key(&self, nonce: &[u8; 12], ad: &[u8]) -> Zeroizing<[u8; 32]> {
        let mut info = b"dash-forge/v2/obj\0".to_vec();
        info.extend_from_slice(&self.gen.to_be_bytes());
        info.extend_from_slice(nonce);
        info.extend_from_slice(&sha256(ad));
        Zeroizing::new(self.expand(&info))
    }

    /// `K_pack = HKDF-Expand(PRK_br,g, "dash-forge/v2/pack" ‖ 0x00 ‖ 0x03 ‖ fileId, 32)`.
    fn pack_key(&self, file_id: &[u8; 16]) -> Zeroizing<[u8; 32]> {
        let mut info = b"dash-forge/v2/pack\0".to_vec();
        info.push(PACK_VERSION);
        info.extend_from_slice(file_id);
        Zeroizing::new(self.expand(&info))
    }

    fn hedged(&self, label: u8, rnd: &[u8; 32], parts: &[&[u8]]) -> [u8; 32] {
        let mut all: Vec<&[u8]> = vec![std::slice::from_ref(&label), rnd];
        all.extend_from_slice(parts);
        hmac(&self.hedge, &all)
    }

    /// The raw subkeys `[PRK, K_brref]`, for the conformance vectors only.
    #[cfg(any(test, feature = "vectors"))]
    #[must_use]
    pub fn raw_subkeys_for_vectors(&self) -> [[u8; 32]; 2] {
        [self.prk, self.ref_key]
    }
}

/// The local token a narrower branch's commits are recorded under in the clone's ledger and
/// compared by in the publication guard: `branch:` and 16 hex characters of
/// `SHA-256("dash-forge/v2/br-id" ‖ 0x00 ‖ repoId ‖ K_br,0)`, so a branch deleted and made again
/// under the same name is another audience, and the name itself is never written.
#[must_use]
pub fn ledger_token(repo_id: &[u8; 32], first: &BranchKey) -> String {
    let mut pre = b"dash-forge/v2/br-id\0".to_vec();
    pre.extend_from_slice(repo_id);
    pre.extend_from_slice(first.expose());
    let h = sha256(&pre);
    pre.zeroize();
    format!("branch:{}", hex::encode(&h[..8]))
}

// --- ref updates (enc v0x06) ---------------------------------------------------------------------

/// Whether `name` may be a narrower branch: a branch (`refs/heads/…`), not a tag or another ref.
#[must_use]
pub fn is_branch_name(name: &str) -> bool {
    name.strip_prefix("refs/heads/")
        .is_some_and(|b| !b.is_empty())
}

/// Seal a narrower branch's ref update under `keys` (the branch's current generation), with a
/// fresh salt and a hedged nonce. `SealedRefUpdate::epoch` is the generation.
pub fn seal_ref(
    keys: &BranchKeys,
    owner: [u8; 32],
    input: &RefUpdateIn<'_>,
) -> Result<SealedRefUpdate, PrivateError> {
    let salt = blind::fresh_salt()?;
    let rnd = rnd32()?;
    seal_ref_inner(keys, owner, input, salt, |ad, pt| {
        let mac = keys.hedged(0x02, &rnd, &[ad, &sha256(pt)]);
        let mut n = [0u8; 12];
        n.copy_from_slice(&mac[..12]);
        n
    })
}

/// [`seal_ref`] with a caller-chosen salt and nonce: the conformance vectors only.
#[cfg(any(test, feature = "vectors"))]
pub fn seal_ref_with(
    keys: &BranchKeys,
    owner: [u8; 32],
    input: &RefUpdateIn<'_>,
    salt: blind::Salt,
    nonce: [u8; 12],
) -> Result<SealedRefUpdate, PrivateError> {
    seal_ref_inner(keys, owner, input, salt, |_, _| nonce)
}

fn seal_ref_inner(
    keys: &BranchKeys,
    owner: [u8; 32],
    input: &RefUpdateIn<'_>,
    salt: blind::Salt,
    nonce: impl FnOnce(&[u8], &[u8]) -> [u8; 12],
) -> Result<SealedRefUpdate, PrivateError> {
    if !is_branch_name(input.name) {
        return Err(PrivateError::Malformed);
    }
    let (header, fields) = members_ref::header_and_fields(
        keys.ref_name_hash(input.name),
        keys.gen,
        owner,
        input,
        &salt,
    )?;
    let records = tlv::encode(&fields);
    // a writer never emits what a reader refuses: the same parse
    let parsed = tlv::parse_members(&records, header.kind).ok_or(PrivateError::Malformed)?;
    if parsed.ref_name.as_deref() != Some(input.name) {
        return Err(PrivateError::Malformed);
    }
    let max = header.kind.max_enc() - MIN_V6;
    if records.len() > max {
        return Err(PrivateError::TooLarge(header.kind.type_name(), max));
    }
    let ad = header
        .ad_in(&keys.repo_id, V6)
        .ok_or(PrivateError::Malformed)?;
    let n = nonce(&ad, &records);
    let obj = ObjKeys::derive(&keys.repo_id, &keys.obj_key(&n, &ad));
    let mut ad2 = ad;
    ad2.extend_from_slice(obj.commit());
    let ct = Aes256Gcm::new(obj.doc_key().into())
        .encrypt(
            Nonce::from_slice(&n),
            Payload {
                msg: &records,
                aad: &ad2,
            },
        )
        .map_err(|_| PrivateError::Malformed)?;
    let mut enc = Vec::with_capacity(MIN_V6 + records.len());
    enc.push(V6);
    enc.extend_from_slice(&keys.kcv4());
    enc.extend_from_slice(&n);
    enc.extend_from_slice(obj.commit());
    enc.extend_from_slice(&ct);
    Ok(members_ref::sealed(header, salt, enc))
}

// --- packs (DFPK 0x03) ---------------------------------------------------------------------------

/// The KCV prefix of a DFPK 0x03 artifact from its first bytes (12 or more); `None` for anything
/// else (a git pack, the members key's 0x01, a letter's 0x02, a short read).
#[must_use]
pub fn sniff_kcv(head: &[u8]) -> Option<[u8; 4]> {
    (head.len() >= 12 && head[..4] == MAGIC && head[4] == PACK_VERSION)
        .then(|| [head[8], head[9], head[10], head[11]])
}

fn pack_header(keys: &BranchKeys, seg_log2: u8, plain_len: u64, file_id: &[u8; 16]) -> [u8; 36] {
    let mut h = [0u8; HEADER_LEN];
    h[..4].copy_from_slice(&MAGIC);
    h[4] = PACK_VERSION;
    h[5] = seg_log2;
    h[8..12].copy_from_slice(&keys.kcv4());
    h[12..20].copy_from_slice(&plain_len.to_be_bytes());
    h[20..36].copy_from_slice(file_id);
    h
}

fn seg_nonce(i: u64, segments: u64) -> [u8; 12] {
    let mut n = [0u8; 12];
    n[..8].copy_from_slice(&i.to_be_bytes());
    n[11] = u8::from(i + 1 == segments);
    n
}

/// Seal `plaintext` (a narrower branch's git pack) under `keys`, with a hedged random `fileId`
/// and `L = 14`.
pub fn seal_pack(keys: &BranchKeys, plaintext: &[u8]) -> Result<Vec<u8>, PrivateError> {
    let mac = keys.hedged(0x01, &rnd32()?, &[&sha256(plaintext)]);
    let mut file_id = [0u8; 16];
    file_id.copy_from_slice(&mac[..16]);
    seal_pack_inner(keys, plaintext, &file_id, WRITE_SEG_LOG2)
}

/// [`seal_pack`] with a caller-chosen `fileId` and segment size: the conformance vectors only.
#[cfg(any(test, feature = "vectors"))]
pub fn seal_pack_with(
    keys: &BranchKeys,
    plaintext: &[u8],
    file_id: &[u8; 16],
    seg_log2: u8,
) -> Result<Vec<u8>, PrivateError> {
    seal_pack_inner(keys, plaintext, file_id, seg_log2)
}

fn seal_pack_inner(
    keys: &BranchKeys,
    plaintext: &[u8],
    file_id: &[u8; 16],
    seg_log2: u8,
) -> Result<Vec<u8>, PrivateError> {
    if !(MIN_SEG_LOG2..=MAX_SEG_LOG2).contains(&seg_log2) {
        return Err(PrivateError::Malformed);
    }
    let h = pack_header(keys, seg_log2, plaintext.len() as u64, file_id);
    let cipher = Aes256Gcm::new((&*keys.pack_key(file_id)).into());
    let seg = 1usize << seg_log2;
    let segments = plaintext.len().div_ceil(seg).max(1);
    let mut out = Vec::with_capacity(HEADER_LEN + plaintext.len() + 16 * segments);
    out.extend_from_slice(&h);
    for i in 0..segments {
        let chunk =
            &plaintext[(i * seg).min(plaintext.len())..((i + 1) * seg).min(plaintext.len())];
        let ct = cipher
            .encrypt(
                Nonce::from_slice(&seg_nonce(i as u64, segments as u64)),
                Payload {
                    msg: chunk,
                    aad: &h,
                },
            )
            .map_err(|_| PrivateError::Malformed)?;
        out.extend_from_slice(&ct);
    }
    Ok(out)
}

/// Open a whole DFPK 0x03 artifact: `size_bytes` (the manifest's) first, then the header, then
/// the key the KCV prefix selects among `keys` (every generation of every branch the reader
/// holds), then every tag. `NoKey` (generation 0 here: the header names none) when no key of the
/// reader's matches, which readers skip, never treat as corrupt.
pub fn open_pack<'k>(
    sealed: &[u8],
    size_bytes: u64,
    keys: impl IntoIterator<Item = &'k BranchKeys>,
) -> Result<Vec<u8>, PrivateError> {
    open_pack_with_key(sealed, size_bytes, keys).map(|(bytes, _)| bytes)
}

/// Keep the key that authenticated every segment, so a caller can attribute the pack without
/// treating its four-byte KCV as proof of which branch opened it.
fn open_pack_with_key<'k>(
    sealed: &[u8],
    size_bytes: u64,
    keys: impl IntoIterator<Item = &'k BranchKeys>,
) -> Result<(Vec<u8>, &'k BranchKeys), PrivateError> {
    if sealed.len() as u64 != size_bytes {
        return Err(PrivateError::SizeMismatch);
    }
    let corrupt = || PrivateError::SealedPackCorrupt;
    let h: [u8; HEADER_LEN] = sealed
        .get(..HEADER_LEN)
        .and_then(|b| b.try_into().ok())
        .ok_or_else(corrupt)?;
    let seg_log2 = h[5];
    if h[..4] != MAGIC
        || h[4] != PACK_VERSION
        || h[6..8] != [0, 0]
        || !(MIN_SEG_LOG2..=MAX_SEG_LOG2).contains(&seg_log2)
    {
        return Err(corrupt());
    }
    let plain_len = u64::from_be_bytes(h[12..20].try_into().expect("8 bytes"));
    let file_id: [u8; 16] = h[20..36].try_into().expect("16 bytes");
    let seg = 1u64 << seg_log2;
    let segments = plain_len.div_ceil(seg).max(1);
    let expected = (HEADER_LEN as u64)
        .checked_add(plain_len)
        .and_then(|n| n.checked_add(16u64.checked_mul(segments)?));
    if expected != Some(sealed.len() as u64) {
        return Err(corrupt());
    }
    let candidates: Vec<&BranchKeys> = keys.into_iter().filter(|k| k.kcv4() == h[8..12]).collect();
    if candidates.is_empty() {
        return Err(PrivateError::NoKey(0));
    }
    'key: for k in candidates {
        let cipher = Aes256Gcm::new((&*k.pack_key(&file_id)).into());
        let mut out = Zeroizing::new(Vec::with_capacity(usize::try_from(plain_len).unwrap_or(0)));
        let mut at = HEADER_LEN;
        for i in 0..segments {
            let len =
                usize::try_from((plain_len - i * seg).min(seg) + 16).map_err(|_| corrupt())?;
            let Some(ct) = sealed.get(at..at + len) else {
                return Err(corrupt());
            };
            let Ok(pt) = cipher.decrypt(
                Nonce::from_slice(&seg_nonce(i, segments)),
                Payload { msg: ct, aad: &h },
            ) else {
                continue 'key;
            };
            out.extend_from_slice(&Zeroizing::new(pt));
            at += len;
        }
        return Ok((out.to_vec(), k));
    }
    Err(corrupt())
}

// --- the branchKey letter --------------------------------------------------------------------------

/// A `branchKey` letter's body: every generation of one branch's key, its audience, and who the
/// writer sealed it to.
#[derive(Clone, PartialEq, Eq)]
pub struct BranchKeyLetter {
    /// The full ref name (`refs/heads/sec/embargo`).
    pub name: String,
    /// `K_br,0 … K_br,g`.
    pub keys: Vec<BranchKey>,
    /// Who the branch is for (a group, a group plus people, or people; base58).
    pub audience: Audience,
    /// Every recipient (the writer among them; base58, ascending): what the next re-lettering
    /// compares with the audience as it is then (D34).
    pub to: Vec<String>,
}

impl std::fmt::Debug for BranchKeyLetter {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BranchKeyLetter")
            .field("gen", &self.gen())
            .field("audience", &self.audience)
            .finish_non_exhaustive()
    }
}

/// Why a letter was not folded.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Ignored {
    /// A `branchKey` v1 body that breaks a rule.
    Malformed,
    /// It names a branch already keyed by another chain (a generation both carry differs).
    OtherChain,
    /// Its sender is not in the audience as it resolves now (its own, for a branch's first letter;
    /// the branch's, for a later one).
    Sender,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BodyIn {
    #[serde(rename = "type")]
    _kind: String,
    #[serde(rename = "v")]
    _v: u64,
    name: String,
    gen: u64,
    keys: Vec<String>,
    group: Option<String>,
    people: Vec<String>,
    to: Vec<String>,
}

/// Whether `ids` are canonical base58 identity ids in ascending order, none twice, at most `max`.
fn ids_ok(ids: &[String], max: usize) -> bool {
    ids.len() <= max
        && ids.windows(2).all(|w| w[0] < w[1])
        && ids.iter().all(|p| {
            crate::platform::decode_identifier(p)
                .is_ok_and(|id| crate::platform::encode_identifier(id) == *p)
        })
}

impl BranchKeyLetter {
    /// The generation it carries the key of (`keys.len() − 1`).
    #[must_use]
    pub fn gen(&self) -> u32 {
        u32::try_from(self.keys.len().saturating_sub(1)).unwrap_or(u32::MAX)
    }

    /// The typed letter (kind 10) carrying it.
    #[must_use]
    pub fn to_typed(&self) -> TypedLetter {
        let mut t = TypedLetter::new(LETTER_TYPE, 1);
        let f = &mut t.fields;
        f.insert("name".into(), Value::String(self.name.clone()));
        f.insert("gen".into(), Value::from(self.gen()));
        f.insert(
            "keys".into(),
            Value::Array(
                self.keys
                    .iter()
                    .map(|k| Value::String(k.to_hex().to_string()))
                    .collect(),
            ),
        );
        f.insert(
            "group".into(),
            self.audience
                .group
                .map_or(Value::Null, |g| Value::String(g.as_str().into())),
        );
        f.insert(
            "people".into(),
            Value::Array(
                self.audience
                    .also
                    .iter()
                    .cloned()
                    .map(Value::String)
                    .collect(),
            ),
        );
        f.insert(
            "to".into(),
            Value::Array(self.to.iter().cloned().map(Value::String).collect()),
        );
        t
    }

    /// [`Self::parse`] of a typed letter.
    pub fn from_typed(t: &TypedLetter) -> Result<Option<Self>, Ignored> {
        let mut body = t.fields.clone();
        body.insert("type".into(), Value::String(t.kind.clone()));
        body.insert("v".into(), Value::from(t.v));
        Self::parse(&Value::Object(body))
    }

    /// Parse a body: `Ok(None)` for another letter type or version (skipped, never fatal),
    /// `Err(Malformed)` for a `branchKey` v1 body that breaks a rule: a name outside
    /// `refs/heads/`, `gen` not the last index of 1..=256 distinct lower-case hex keys, an
    /// unknown group, people that are not canonical base58 identity ids in ascending order, none
    /// twice and fewer than 64, no audience at all, `to` not 1..=64 such ids, or any other field.
    pub fn parse(body: &Value) -> Result<Option<Self>, Ignored> {
        let is = |k: &str, v: Value| body.get(k) == Some(&v);
        if !is("type", LETTER_TYPE.into()) || !is("v", 1.into()) {
            return Ok(None);
        }
        // every field is required, `group` too (null for people only)
        if body.get("group").is_none() {
            return Err(Ignored::Malformed);
        }
        let b: BodyIn = serde_json::from_value(body.clone()).map_err(|_| Ignored::Malformed)?;
        let keys: Vec<BranchKey> = b
            .keys
            .iter()
            .map(|k| BranchKey::from_hex(k))
            .collect::<Option<_>>()
            .ok_or(Ignored::Malformed)?;
        let distinct = keys.iter().enumerate().all(|(i, k)| !keys[..i].contains(k));
        let group = match b.group.as_deref() {
            None => None,
            Some(g) => Some(Group::parse(g).ok_or(Ignored::Malformed)?),
        };
        let people_ok = ids_ok(&b.people, MAX_PEOPLE)
            && !b.to.is_empty()
            && ids_ok(&b.to, crate::private::named::MAX_ARTIFACT_RECIPIENTS);
        if !is_branch_name(&b.name)
            || keys.is_empty()
            || keys.len() > MAX_GENERATIONS
            || !distinct
            || b.gen != keys.len() as u64 - 1
            || !people_ok
            || (group.is_none() && b.people.is_empty())
        {
            return Err(Ignored::Malformed);
        }
        Ok(Some(Self {
            name: b.name,
            keys,
            audience: Audience {
                group,
                also: b.people,
            },
            to: b.to,
        }))
    }
}

/// One opened letter, as the fold takes it.
#[derive(Debug, Clone)]
pub struct LetterIn {
    /// The kind-10 manifest's `$id` (the fold's tie-break and what an ignored entry names).
    pub id: String,
    /// Its `$createdAtBlockHeight`.
    pub height: u64,
    /// Who wrote it: the manifest's `$ownerId` (base58).
    pub sender: String,
    /// The opened body.
    pub letter: BranchKeyLetter,
}

/// One branch a reader holds keys for.
#[derive(Clone)]
pub struct Branch {
    /// The full ref name.
    pub name: String,
    /// Every generation's key, `K_br,0` first.
    keys: Vec<BranchKey>,
    /// Who the newest counted letter says it is for.
    pub audience: Audience,
    /// The height of the first letter carrying each generation.
    pub issued_at: Vec<u64>,
    /// Who holds the current generation: every recipient of the letters carrying it.
    pub holders: BTreeSet<String>,
    /// The letters counted, in fold order.
    pub letters: Vec<String>,
    /// Keys of letters that do not count (their sender left the audience, or they fork the chain),
    /// by generation, each a generation's key other than the chain's: read-only, never written
    /// under (`BranchRing::open` holds them to the late rule).
    pub read_only: Vec<(u32, BranchKey)>,
}

impl std::fmt::Debug for Branch {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Branch")
            .field("gen", &self.gen())
            .field("audience", &self.audience)
            .field("letters", &self.letters.len())
            .finish_non_exhaustive()
    }
}

impl Branch {
    /// The current generation.
    #[must_use]
    pub fn gen(&self) -> u32 {
        u32::try_from(self.keys.len().saturating_sub(1)).unwrap_or(u32::MAX)
    }

    /// Every generation's key, `K_br,0` first (what a letter re-sends).
    #[must_use]
    pub fn keys(&self) -> &[BranchKey] {
        &self.keys
    }

    /// The letter that adds generation `gen() + 1` with `next` as its key, for `audience`, sealed
    /// to `to`.
    #[must_use]
    pub fn next_generation(
        &self,
        next: BranchKey,
        audience: Audience,
        to: Vec<String>,
    ) -> BranchKeyLetter {
        let mut keys = self.keys.clone();
        keys.push(next);
        BranchKeyLetter {
            name: self.name.clone(),
            keys,
            audience,
            to,
        }
    }

    /// The letter of the current generation, for `audience`, sealed to `to` (joiners, or a
    /// re-send).
    #[must_use]
    pub fn current_letter(&self, audience: Audience, to: Vec<String>) -> BranchKeyLetter {
        BranchKeyLetter {
            name: self.name.clone(),
            keys: self.keys.clone(),
            audience,
            to,
        }
    }

    /// The ledger token of [`ledger_token`].
    #[must_use]
    pub fn ledger_token(&self, repo_id: &[u8; 32]) -> String {
        ledger_token(repo_id, &self.keys[0])
    }
}

/// Fold opened `branchKey` letters (see the module documentation): taken in (height, id) order;
/// per name the first letter starts the chain and a later one counts only when it agrees on every
/// generation both carry, extending the chain when it carries more. A letter counts only when its
/// sender is in the audience as it resolves now (`in_audience(sender, audience)`): the first
/// letter's own audience, a later one's the chain's so far, so someone outside an audience cannot
/// start a branch for it and a holder who leaves cannot keep the branch on a generation they made.
/// Each generation is issued at the height of the first letter carrying it; the audience is the
/// newest counted letter's at the highest generation, and the current generation's holders the
/// union of its letters' `to`. The keys of letters that do not count are kept read-only.
#[must_use]
pub fn fold(
    mut letters: Vec<LetterIn>,
    in_audience: impl Fn(&str, &Audience) -> bool,
) -> (BTreeMap<String, Branch>, Vec<(String, Ignored)>) {
    letters.sort_by(|a, b| a.height.cmp(&b.height).then_with(|| a.id.cmp(&b.id)));
    let mut out: BTreeMap<String, Branch> = BTreeMap::new();
    let mut ignored = Vec::new();
    let mut uncounted: Vec<BranchKeyLetter> = Vec::new();
    for l in letters {
        let LetterIn {
            id,
            height,
            sender,
            letter,
        } = l;
        let Some(cur) = out.get_mut(&letter.name) else {
            if !in_audience(&sender, &letter.audience) {
                ignored.push((id, Ignored::Sender));
                uncounted.push(letter);
                continue;
            }
            out.insert(
                letter.name.clone(),
                Branch {
                    name: letter.name,
                    issued_at: vec![height; letter.keys.len()],
                    holders: letter.to.into_iter().collect(),
                    keys: letter.keys,
                    audience: letter.audience,
                    letters: vec![id],
                    read_only: Vec::new(),
                },
            );
            continue;
        };
        let common = cur.keys.len().min(letter.keys.len());
        if cur.keys[..common] != letter.keys[..common] {
            ignored.push((id, Ignored::OtherChain));
            uncounted.push(letter);
            continue;
        }
        if !in_audience(&sender, &cur.audience) {
            ignored.push((id, Ignored::Sender));
            uncounted.push(letter);
            continue;
        }
        let have = cur.keys.len();
        if letter.keys.len() > have {
            cur.holders = letter.to.into_iter().collect();
        } else if letter.keys.len() == have {
            cur.holders.extend(letter.to);
        }
        if letter.keys.len() >= have {
            cur.issued_at
                .extend(std::iter::repeat_n(height, letter.keys.len() - have));
            cur.keys = letter.keys;
            cur.audience = letter.audience;
        }
        cur.letters.push(id);
    }
    for b in out.values_mut() {
        for u in uncounted.iter().filter(|u| u.name == b.name) {
            for (g, k) in u.keys.iter().enumerate() {
                let g32 = u32::try_from(g).unwrap_or(u32::MAX);
                let chain_has = b.keys.get(g) == Some(k);
                if !chain_has && !b.read_only.iter().any(|(rg, rk)| *rg == g32 && rk == k) {
                    b.read_only.push((g32, k.clone()));
                }
            }
        }
        b.read_only
            .sort_by(|(ga, ka), (gb, kb)| ga.cmp(gb).then_with(|| ka.expose().cmp(kb.expose())));
    }
    (out, ignored)
}

/// The branches a reader holds keys for, with each generation's subkeys and who each branch's
/// current audience is now (resolved by the caller from the member documents): what opens a
/// narrower branch's ref updates and packs.
#[derive(Default)]
pub struct BranchRing {
    repo_id: [u8; 32],
    branches: BTreeMap<String, Branch>,
    /// Every key held, by branch: `true` for a read-only one.
    derived: Vec<(String, BranchKeys, bool)>,
    audience_now: BTreeMap<String, BTreeSet<[u8; 32]>>,
    ignored: Vec<(String, Ignored)>,
}

impl std::fmt::Debug for BranchRing {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BranchRing")
            .field("branches", &self.branches.len())
            .field("ignored", &self.ignored.len())
            .finish_non_exhaustive()
    }
}

impl BranchRing {
    /// A ring over folded `branches` of repository `repo_id`; `audience_now` resolves a branch's
    /// audience to identity ids as of now (the late rule's "current audience").
    pub fn new(
        repo_id: &[u8; 32],
        (branches, ignored): (BTreeMap<String, Branch>, Vec<(String, Ignored)>),
        audience_now: impl Fn(&Branch) -> BTreeSet<[u8; 32]>,
    ) -> Self {
        let mut derived = Vec::new();
        let mut now = BTreeMap::new();
        for (name, b) in &branches {
            for (g, k) in b.keys.iter().enumerate() {
                let g = u32::try_from(g).unwrap_or(u32::MAX);
                derived.push((name.clone(), BranchKeys::derive(repo_id, g, k), false));
            }
            for (g, k) in &b.read_only {
                derived.push((name.clone(), BranchKeys::derive(repo_id, *g, k), true));
            }
            now.insert(name.clone(), audience_now(b));
        }
        Self {
            repo_id: *repo_id,
            branches,
            derived,
            audience_now: now,
            ignored,
        }
    }

    /// The branches held, by name.
    #[must_use]
    pub fn branches(&self) -> &BTreeMap<String, Branch> {
        &self.branches
    }

    /// The branch `name`, when held.
    #[must_use]
    pub fn get(&self, name: &str) -> Option<&Branch> {
        self.branches.get(name)
    }

    /// Letters left out of the fold.
    #[must_use]
    pub fn ignored(&self) -> &[(String, Ignored)] {
        &self.ignored
    }

    /// Whether the ring holds no branch.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.branches.is_empty()
    }

    /// Branch `name`'s current generation's keys, to write under.
    #[must_use]
    pub fn write_keys(&self, name: &str) -> Option<&BranchKeys> {
        let gen = self.branches.get(name)?.gen();
        self.derived
            .iter()
            .find(|(n, k, ro)| n == name && k.gen == gen && !ro)
            .map(|(_, k, _)| k)
    }

    /// Every key held, read-only ones included (what opens a DFPK 0x03 pack).
    pub fn all_keys(&self) -> impl Iterator<Item = &BranchKeys> {
        self.derived.iter().map(|(_, k, _)| k)
    }

    /// Open a DFPK 0x03 pack and identify the branch whose key authenticated all of it. This
    /// includes older and read-only generations; a KCV collision never selects its audience.
    pub fn open_pack(
        &self,
        sealed: &[u8],
        size_bytes: u64,
    ) -> Result<(Vec<u8>, &Branch), PrivateError> {
        let (bytes, key) = open_pack_with_key(sealed, size_bytes, self.all_keys())?;
        let name = self
            .derived
            .iter()
            .find_map(|(name, candidate, _)| std::ptr::eq(candidate, key).then_some(name))
            .expect("the authenticated key came from this ring");
        Ok((bytes, &self.branches[name]))
    }

    /// The branch whose keys open a DFPK 0x03 artifact with this KCV prefix, if any.
    #[must_use]
    pub fn branch_of_kcv(&self, kcv4: [u8; 4]) -> Option<&str> {
        self.derived
            .iter()
            .find(|(_, k, _)| k.kcv4() == kcv4)
            .map(|(n, _, _)| n.as_str())
    }

    /// Open a narrower branch's ref update (`enc` v0x06) of `header` (a public `refUpdate` or
    /// `protectedRefUpdate`, its `epoch` the generation): framing, the keys of that generation
    /// whose KCV prefix `enc` carries (none: `NoKey`, a branch the reader doesn't have access to),
    /// the commitment (`CommitMismatch` before GCM), GCM, the TLV, the name hash, the branch's own
    /// name (a branch key opens only its branch), and the late rule across generations.
    #[must_use]
    pub fn open(&self, header: &DocHeader, enc: &[u8]) -> Opened {
        if enc.len() < MIN_V6
            || enc[0] != V6
            || header.vis != Visibility::Public
            || !matches!(
                header.kind,
                DocKind::RefUpdate | DocKind::ProtectedRefUpdate
            )
        {
            return Opened::Malformed;
        }
        let Some(ad) = header.ad_in(&self.repo_id, V6) else {
            return Opened::Malformed;
        };
        let nonce: [u8; NONCE_LEN] = enc[5..17].try_into().expect("framed");
        let (commit, ct) = enc[17..].split_at(32);
        let mut any = false;
        let mut hit = None;
        for (name, k, ro) in &self.derived {
            if k.gen != header.epoch || k.kcv4() != enc[1..5] {
                continue;
            }
            any = true;
            let obj = ObjKeys::derive(&self.repo_id, &k.obj_key(&nonce, &ad));
            if ct_eq(obj.commit(), commit) {
                hit = Some((name, k, *ro, obj));
                break;
            }
        }
        if !any {
            return Opened::Unreadable(Unreadable::NoKey);
        }
        let Some((name, k, read_only, obj)) = hit else {
            return Opened::Unreadable(Unreadable::CommitMismatch);
        };
        let mut ad2 = ad;
        ad2.extend_from_slice(commit);
        let Ok(pt) = Aes256Gcm::new(obj.doc_key().into())
            .decrypt(Nonce::from_slice(&nonce), Payload { msg: ct, aad: &ad2 })
        else {
            return Opened::Unreadable(Unreadable::BadTag);
        };
        let pt = Zeroizing::new(pt);
        let Some(fields) = tlv::parse_members(&pt, header.kind) else {
            return Opened::Malformed;
        };
        let named = fields.ref_name.as_deref();
        if named != Some(name.as_str())
            || header
                .ref_name_hash
                .is_none_or(|h| !ct_eq(&h, &k.ref_name_hash(name)))
        {
            return Opened::Malformed;
        }
        if members_ref::real_values(header, &fields).is_none() {
            return Opened::Malformed;
        }
        if self.is_late(name, header, read_only) {
            return Opened::Unreadable(Unreadable::Late);
        }
        Opened::Readable(Box::new(fields))
    }

    /// Written under generation g after generation g+1 was issued plus the grace period, by
    /// someone outside the branch's current audience. A read-only key is superseded by the first
    /// counted generation at or after its own.
    fn is_late(&self, name: &str, header: &DocHeader, read_only: bool) -> bool {
        let Some(b) = self.branches.get(name) else {
            return true;
        };
        let g = usize::try_from(header.epoch).unwrap_or(usize::MAX);
        let next = if read_only {
            b.issued_at.iter().skip(g).min()
        } else {
            g.checked_add(1).and_then(|n| b.issued_at.get(n))
        };
        let height = header.created_at_block_height.unwrap_or(u64::MAX);
        let in_audience = self
            .audience_now
            .get(name)
            .is_some_and(|a| a.contains(&header.owner_id));
        next.is_some_and(|n| height > n.saturating_add(GRACE_BLOCKS)) && !in_audience
    }
}

/// The real values of an opened v0x06 ref update: as a members-only update's
/// ([`members_ref::real_values`]).
#[must_use]
pub fn real_values(header: &DocHeader, fields: &Fields) -> Option<members_ref::RealRefUpdate> {
    members_ref::real_values(header, fields)
}

#[cfg(test)]
#[path = "branch_key_conformance.rs"]
pub(crate) mod conformance;

#[cfg(test)]
mod tests {
    use super::*;

    fn keys(b: u8, gen: u32) -> BranchKeys {
        BranchKeys::derive(&[0x11; 32], gen, &BranchKey::from_bytes([b; 32]))
    }

    #[test]
    fn debug_never_shows_key_material() {
        let k = BranchKey::from_bytes([0xab; 32]);
        assert_eq!(format!("{k:?}"), "BranchKey(<redacted>)");
        assert!(!format!("{:?}", keys(0xab, 0)).contains("abab"));
    }

    #[test]
    fn production_seals_round_trip() {
        let k = keys(3, 0);
        let input = RefUpdateIn {
            kind: DocKind::RefUpdate,
            name: "refs/heads/sec/x",
            new_oid: &[2; 20],
            prev_oid: None,
            force: false,
        };
        let a = seal_ref(&k, [0x22; 32], &input).unwrap();
        let b = seal_ref(&k, [0x22; 32], &input).unwrap();
        assert_ne!(a.enc[5..17], b.enc[5..17], "fresh nonces");
        assert_ne!(a.new_oid, b.new_oid, "fresh salts");
        let p = seal_pack(&k, b"hello").unwrap();
        assert_eq!(open_pack(&p, p.len() as u64, [&k]).unwrap(), b"hello");
        assert_eq!(
            open_pack(&p, p.len() as u64, [&keys(4, 0)]),
            Err(PrivateError::NoKey(0))
        );
        assert_eq!(sniff_kcv(&p), Some(k.kcv4()));
        assert_eq!(
            seal_ref(
                &k,
                [0x22; 32],
                &RefUpdateIn {
                    name: "refs/tags/v1",
                    ..input
                }
            ),
            Err(PrivateError::Malformed)
        );
    }

    #[test]
    fn a_ledger_token_is_per_chain() {
        let a = ledger_token(&[1; 32], &BranchKey::from_bytes([2; 32]));
        assert!(a.starts_with("branch:") && a.len() == 23);
        assert_ne!(a, ledger_token(&[1; 32], &BranchKey::from_bytes([3; 32])));
        assert!(crate::members_git::ledger::EntryAudience::parse(&a).is_some());
    }
}
