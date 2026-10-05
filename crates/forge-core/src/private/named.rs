//! Specific-people letters: `enc` v0x04 (`docs/security/private-repos.md` §4.1, mixed-visibility
//! design §4.2), a document sealed to a list of identities chosen by its writer, members or not.
//!
//! ```text
//! enc  = 0x04 ‖ n(u8, 1..16) ‖ senderKeyId(u32) ‖ COMMIT_obj(32) ‖ n × slot(64)
//!        ‖ nonce(12) ‖ AES-256-GCM(K_doc,obj, nonce, TLV, AD') ‖ tag(16)           (66 + 64·n)
//! slot = IV(16) ‖ AES-256-CBC-PKCS7(S, IV, 0x02 ‖ KCV_obj(14) ‖ K_obj(32))
//! S    = SHA-256((y & 1 | 2) ‖ x) of senderEncPriv · recipientEncPub
//! H    = enc[1 .. 38 + 64·n];   AD' = AD(enc[0] = 0x04, epoch = 0) ‖ SHA-256(H)
//! TLV  = content ‖ tag 25 (recipient identity id) × n, in slot order ‖ padding
//! ```
//!
//! `K_obj` is fresh CSPRNG output per seal (and per revision); `PRK_obj`, `K_doc,obj`,
//! `COMMIT_obj` and `KCV_obj` are [`super::keys::ObjKeys`]. A slot is exactly the
//! `encryptedFor` byte string (`ecdh-secp256k1-aes256-cbc`, [`crate::envelope`]) with a fresh IV;
//! its version byte `0x02` keeps it from ever parsing as a `repoKey` wrap (`0x01 ‖ KCV_e ‖ K_e`)
//! and the reverse. The sender always takes slot 0, so it can read its own letter back.
//!
//! **The reader rule.** The sender key is taken only from the document owner's key
//! `senderKeyId`, which must be an `ECDSA_SECP256K1` key of purpose `ENCRYPTION` (disabled is
//! fine for reading); consensus checks none of this. One ECDH per key the reader holds, then every
//! slot is tried; a slot counts only when its padding, version byte, `KCV_obj` prefix and the full
//! `COMMIT_obj` all match. Then GCM, then `count(tag 25) = n` and the reader's own id at its slot
//! index. The recipient list is "as listed by the sender": nothing proves the writer sealed the
//! same key into every slot except the commitment, which is exactly what stops a writer showing
//! two recipients two letters.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use zeroize::Zeroizing;

use super::doc::{self, DocHeader, NONCE_LEN, TAG_LEN, V4};
use super::keys::{ct_eq, sha256, ObjKeys};
use super::tlv::{self, Fields};
use super::PrivateError;
use crate::envelope::{self, PrivateKey, SharedKey};

/// At most this many recipients, the sender included.
pub const MAX_RECIPIENTS: usize = 16;
/// One slot: the IV and three CBC blocks of the 47-byte slot plaintext.
pub const SLOT_LEN: usize = 64;
/// The slot plaintext's version byte: a specific-people slot (a `repoKey` wrap is `0x01`).
pub const SLOT_VERSION: u8 = 0x02;
/// `0x04 ‖ n ‖ senderKeyId ‖ COMMIT_obj`.
const HEAD_LEN: usize = 1 + 1 + 4 + 32;
const SLOT_PLAINTEXT_LEN: usize = 1 + 14 + 32;

/// Platform's purpose number of an `ENCRYPTION` key.
pub const PURPOSE_ENCRYPTION: u8 = 1;
/// Platform's key type number of an `ECDSA_SECP256K1` key.
pub const KEY_TYPE_ECDSA_SECP256K1: u8 = 0;

/// The framing of a letter to `n` recipients: everything but the TLV (`66 + 64·n`).
#[must_use]
pub const fn framing(n: usize) -> usize {
    HEAD_LEN + SLOT_LEN * n + NONCE_LEN + TAG_LEN
}

/// The largest TLV (content, recipient records and padding) a `kind` letter to `n` recipients
/// holds: the type's `enc` cap minus the framing.
#[must_use]
pub fn max_tlv(kind: super::DocKind, n: usize) -> usize {
    kind.max_enc().saturating_sub(framing(n))
}

/// Step 1 of §8.1 for a letter: a kind a letter may carry, `epoch = 0` (D20), `enc[0] = 0x04`,
/// `1 ≤ n ≤ 16` and room for the framing.
#[must_use]
pub fn well_framed(header: &DocHeader, enc: &[u8]) -> bool {
    if header.epoch != 0 || !tlv::letter_kind(header.kind) || enc.len() < HEAD_LEN {
        return false;
    }
    let n = usize::from(enc[1]);
    enc[0] == V4 && (1..=MAX_RECIPIENTS).contains(&n) && enc.len() >= framing(n)
}

/// One recipient of a letter: an identity and the ENCRYPTION public key (33-byte compressed
/// secp256k1) its slot is sealed to: the identity's highest-id usable ENCRYPTION key, never a
/// DECRYPTION key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Recipient {
    /// The identity id, written into the TLV (tag 25) at the recipient's slot index.
    pub identity_id: [u8; 32],
    /// The compressed public key the slot is sealed to.
    pub public_key: [u8; 33],
}

/// A key of the document owner's identity, as the reader fetched it from Platform.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OwnerKey {
    /// The key id (`senderKeyId` names one).
    pub id: u32,
    /// Platform's purpose number ([`PURPOSE_ENCRYPTION`] for a sender key).
    pub purpose: u8,
    /// Platform's key type number ([`KEY_TYPE_ECDSA_SECP256K1`] for a sender key).
    pub key_type: u8,
    /// The public key bytes.
    pub data: Vec<u8>,
}

/// Who is reading: an identity and the ENCRYPTION private keys it holds (usually one; more after
/// a rekey, each tried against every slot).
pub struct Reader<'a> {
    /// The reader's identity id: it must sit at the opened slot's index in the TLV.
    pub identity_id: [u8; 32],
    /// The reader's ENCRYPTION private keys.
    pub keys: &'a [PrivateKey],
}

/// Why a well-framed letter cannot be shown.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LetterUnreadable {
    /// No slot opens to the letter's committed key under the reader's keys.
    NotARecipient,
    /// A slot opened, but AES-GCM failed under `AD'`: the header, a slot or the body changed.
    BadTag,
}

/// A letter's content, opened.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Letter {
    /// The decoded content fields.
    pub fields: Fields,
    /// The recipients in slot order, "as listed by the sender" (slot 0 is the sender).
    pub recipients: Vec<[u8; 32]>,
    /// The slot the reader opened.
    pub slot: usize,
}

/// The result of [`open`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LetterOpened {
    /// The letter, read.
    Readable(Box<Letter>),
    /// Well-framed but not readable by this reader.
    Unreadable(LetterUnreadable),
    /// A letter no honest writer produces (framing, sender key, TLV, recipient list): skipped and
    /// counted.
    Malformed,
}

/// Seal `fields` as a specific-people letter from `sender` (its ENCRYPTION key, id
/// `sender_key_id`) in the repository `repo_id`. `recipients` is the slot order; the first
/// must be the sender itself (its identity is `header.owner_id`, its key `sender`'s public key),
/// and no identity may appear twice. Draws a fresh `K_obj`, a random nonce and a random IV per
/// slot. `header.epoch` must be 0 (D20).
pub fn seal(
    repo_id: &[u8; 32],
    sender: &PrivateKey,
    sender_key_id: u32,
    header: &DocHeader,
    fields: &Fields,
    recipients: &[Recipient],
) -> Result<Vec<u8>, PrivateError> {
    let mut k_obj = Zeroizing::new([0u8; 32]);
    let mut nonce = [0u8; NONCE_LEN];
    getrandom::getrandom(&mut *k_obj).map_err(|_| PrivateError::Rng)?;
    getrandom::getrandom(&mut nonce).map_err(|_| PrivateError::Rng)?;
    seal_inner(
        repo_id,
        sender,
        sender_key_id,
        header,
        fields,
        recipients,
        &k_obj,
        nonce,
        |r, pt| envelope::encrypt(sender, &r.public_key, pt).map_err(|_| PrivateError::Malformed),
    )
}

/// [`seal`] with a caller-chosen `K_obj`, nonce and slot IVs (one per recipient): the
/// conformance vectors only.
#[cfg(any(test, feature = "vectors"))]
#[allow(clippy::too_many_arguments)]
pub fn seal_with(
    repo_id: &[u8; 32],
    sender: &PrivateKey,
    sender_key_id: u32,
    header: &DocHeader,
    fields: &Fields,
    recipients: &[Recipient],
    k_obj: &[u8; 32],
    nonce: [u8; 12],
    ivs: &[[u8; 16]],
) -> Result<Vec<u8>, PrivateError> {
    if ivs.len() != recipients.len() {
        return Err(PrivateError::Malformed);
    }
    let mut next = ivs.iter();
    seal_inner(
        repo_id,
        sender,
        sender_key_id,
        header,
        fields,
        recipients,
        k_obj,
        nonce,
        |r, pt| {
            let iv = next.next().ok_or(PrivateError::Malformed)?;
            envelope::encrypt_with_iv_for_vectors(sender, &r.public_key, pt, iv)
                .map_err(|_| PrivateError::Malformed)
        },
    )
}

/// The slot block `n ‖ senderKeyId ‖ COMMIT_obj ‖ n × slot` of `K_obj` for `recipients`, after
/// the sender-first and no-duplicate checks. Shared by letters and sealed artifacts.
pub(crate) fn slot_block(
    sender: &PrivateKey,
    sender_key_id: u32,
    owner_id: &[u8; 32],
    recipients: &[Recipient],
    obj: &ObjKeys,
    k_obj: &[u8; 32],
    mut wrap: impl FnMut(&Recipient, &[u8]) -> Result<Vec<u8>, PrivateError>,
) -> Result<Vec<u8>, PrivateError> {
    let n = recipients.len();
    let first = recipients.first().ok_or(PrivateError::Malformed)?;
    if n > MAX_RECIPIENTS
        || first.identity_id != *owner_id
        || first.public_key != sender.public_key()
    {
        return Err(PrivateError::Malformed);
    }
    for (i, r) in recipients.iter().enumerate() {
        if recipients[..i]
            .iter()
            .any(|o| o.identity_id == r.identity_id)
        {
            return Err(PrivateError::Malformed);
        }
    }
    let mut slot_pt = Zeroizing::new(Vec::with_capacity(SLOT_PLAINTEXT_LEN));
    slot_pt.push(SLOT_VERSION);
    slot_pt.extend_from_slice(obj.kcv());
    slot_pt.extend_from_slice(k_obj);
    let mut out = Vec::with_capacity(1 + 4 + 32 + SLOT_LEN * n);
    out.push(u8::try_from(n).expect("n <= 16"));
    out.extend_from_slice(&sender_key_id.to_be_bytes());
    out.extend_from_slice(obj.commit());
    for r in recipients {
        let slot = wrap(r, &slot_pt)?;
        if slot.len() != SLOT_LEN {
            return Err(PrivateError::Malformed);
        }
        out.extend(slot);
    }
    Ok(out)
}

#[allow(clippy::too_many_arguments)]
fn seal_inner(
    repo_id: &[u8; 32],
    sender: &PrivateKey,
    sender_key_id: u32,
    header: &DocHeader,
    fields: &Fields,
    recipients: &[Recipient],
    k_obj: &[u8; 32],
    nonce: [u8; NONCE_LEN],
    wrap: impl FnMut(&Recipient, &[u8]) -> Result<Vec<u8>, PrivateError>,
) -> Result<Vec<u8>, PrivateError> {
    let n = recipients.len();
    if header.epoch != 0 || !tlv::letter_kind(header.kind) || n == 0 {
        return Err(PrivateError::Malformed);
    }
    // the content, checked as a reader parses it; ref names in a letter are public sha256
    let records = tlv::encode(fields);
    let parsed = tlv::parse(&records, header.kind, false).ok_or(PrivateError::Malformed)?;
    if !public_ref_names_match(header, &parsed) {
        return Err(PrivateError::Malformed);
    }
    let ids: Vec<[u8; 32]> = recipients.iter().map(|r| r.identity_id).collect();
    let mut body = Zeroizing::new(records.to_vec());
    tlv::push_recipients(&mut body, &ids);
    let max = max_tlv(header.kind, n);
    if body.len() > max {
        return Err(PrivateError::TooLarge(header.kind.type_name(), max));
    }
    let pt = doc::padded(header.kind, &body, max);

    let obj = ObjKeys::derive(repo_id, k_obj);
    let block = slot_block(
        sender,
        sender_key_id,
        &header.owner_id,
        recipients,
        &obj,
        k_obj,
        wrap,
    )?;
    let mut enc = Vec::with_capacity(framing(n) + pt.len());
    enc.push(V4);
    enc.extend_from_slice(&block);
    let ad = letter_ad(repo_id, header, &enc[1..])?;
    let ct = Aes256Gcm::new(obj.doc_key().into())
        .encrypt(Nonce::from_slice(&nonce), Payload { msg: &pt, aad: &ad })
        .map_err(|_| PrivateError::Malformed)?;
    enc.extend_from_slice(&nonce);
    enc.extend_from_slice(&ct);
    Ok(enc)
}

/// `AD' = AD(enc[0] = 0x04, epoch = 0) ‖ SHA-256(H)`, with `H = enc[1 .. 38 + 64·n]`.
fn letter_ad(repo_id: &[u8; 32], header: &DocHeader, h: &[u8]) -> Result<Vec<u8>, PrivateError> {
    let mut ad = header
        .ad_without_keys(repo_id, V4)
        .ok_or(PrivateError::Malformed)?;
    ad.extend_from_slice(&sha256(h));
    Ok(ad)
}

/// A letter's PR names its branches by their public `sha256` (a specific-people PR comes from a
/// public branch of a fork): each present hash must name the branch in the TLV.
fn public_ref_names_match(header: &DocHeader, fields: &Fields) -> bool {
    let check = |hash: Option<[u8; 32]>, name: Option<&String>| match (hash, name) {
        (Some(h), Some(n)) => ct_eq(&h, &sha256(n.as_bytes())),
        (Some(_), None) => false,
        (None, _) => true,
    };
    check(header.base_ref_name_hash, fields.base_ref_name.as_ref())
        && check(header.source_ref_name_hash, fields.source_ref_name.as_ref())
}

/// The sender's public key under the reader rule: the owner's key `sender_key_id`, which must be
/// an `ECDSA_SECP256K1` `ENCRYPTION` key (disabled or not). `None` is `Malformed`.
pub(crate) fn sender_key(owner_keys: &[OwnerKey], sender_key_id: u32) -> Option<&[u8]> {
    owner_keys
        .iter()
        .find(|k| k.id == sender_key_id)
        .filter(|k| k.purpose == PURPOSE_ENCRYPTION && k.key_type == KEY_TYPE_ECDSA_SECP256K1)
        .map(|k| k.data.as_slice())
}

/// Find the slot of `block` (`n ‖ senderKeyId ‖ COMMIT_obj ‖ slots`) that opens under one of
/// `reader`'s keys with `sender_public`, and return its index and `K_obj` with its keys. `Err` is
/// `Malformed` (a sender key that is not a valid point).
pub(crate) fn find_slot(
    repo_id: &[u8; 32],
    block: &[u8],
    n: usize,
    sender_public: &[u8],
    reader: &Reader<'_>,
) -> Result<Option<(usize, ObjKeys)>, ()> {
    let commit = &block[5..37];
    let slots = &block[37..37 + SLOT_LEN * n];
    for key in reader.keys {
        let shared = SharedKey::derive(key, sender_public).map_err(|_| ())?;
        for (i, slot) in slots.as_chunks::<SLOT_LEN>().0.iter().enumerate() {
            let Some(pt) = shared.decrypt(slot) else {
                continue;
            };
            let pt = pt.expose();
            if pt.len() != SLOT_PLAINTEXT_LEN
                || pt[0] != SLOT_VERSION
                || !ct_eq(&pt[1..15], &commit[..14])
            {
                continue;
            }
            let k_obj: [u8; 32] = pt[15..].try_into().expect("47-byte slot plaintext");
            let k_obj = Zeroizing::new(k_obj);
            let obj = ObjKeys::derive(repo_id, &k_obj);
            if ct_eq(obj.commit(), commit) {
                return Ok(Some((i, obj)));
            }
        }
    }
    Ok(None)
}

/// Open the letter `enc` of the document `header` in the repository `repo_id`, as `reader`,
/// with the document owner's keys `owner_keys` (the reader rule in the module docs).
#[must_use]
pub fn open(
    repo_id: &[u8; 32],
    header: &DocHeader,
    enc: &[u8],
    owner_keys: &[OwnerKey],
    reader: &Reader<'_>,
) -> LetterOpened {
    if !well_framed(header, enc) {
        return LetterOpened::Malformed;
    }
    let n = usize::from(enc[1]);
    let sender_key_id = u32::from_be_bytes(enc[2..6].try_into().expect("framed"));
    let Some(sender_public) = sender_key(owner_keys, sender_key_id) else {
        return LetterOpened::Malformed;
    };
    let head = HEAD_LEN + SLOT_LEN * n;
    let Ok(found) = find_slot(repo_id, &enc[1..head], n, sender_public, reader) else {
        return LetterOpened::Malformed;
    };
    let Some((slot, obj)) = found else {
        return LetterOpened::Unreadable(LetterUnreadable::NotARecipient);
    };
    let Ok(ad) = letter_ad(repo_id, header, &enc[1..head]) else {
        return LetterOpened::Malformed;
    };
    let (nonce, ct) = enc[head..].split_at(NONCE_LEN);
    let Ok(pt) = Aes256Gcm::new(obj.doc_key().into())
        .decrypt(Nonce::from_slice(nonce), Payload { msg: ct, aad: &ad })
    else {
        return LetterOpened::Unreadable(LetterUnreadable::BadTag);
    };
    let pt = Zeroizing::new(pt);
    let Some((fields, recipients)) = tlv::parse_letter(&pt, header.kind) else {
        return LetterOpened::Malformed;
    };
    if recipients.len() != n
        || recipients[slot] != reader.identity_id
        || !public_ref_names_match(header, &fields)
    {
        return LetterOpened::Malformed;
    }
    LetterOpened::Readable(Box::new(Letter {
        fields,
        recipients,
        slot,
    }))
}

// --- sealed artifacts under a specific-people header (DFPK version 0x02) ---------------------

/// The header version of a sealed artifact whose key is a per-artifact `K_obj` wrapped to
/// specific people, instead of an epoch key (`private-repos.md` §3.2): the Maintainers and
/// Specific-people environments, branch grants.
pub const ARTIFACT_VERSION: u8 = 0x02;
/// The segment size writers use (`L = 14`, as for DFPK version 0x01).
pub const ARTIFACT_SEG_LOG2: u8 = 14;
const ARTIFACT_MIN_SEG_LOG2: u8 = 10;
const ARTIFACT_MAX_SEG_LOG2: u8 = 20;

/// The header length of an artifact sealed to `n` recipients:
/// `magic(4) ‖ 0x02 ‖ L ‖ reserved(2) ‖ n ‖ senderKeyId(4) ‖ COMMIT_obj(32) ‖ n × slot(64) ‖
/// plaintextLen(8) ‖ fileId(16)` = `69 + 64·n`. The slot block stands where version 0x01 has its
/// epoch; every other field keeps its meaning.
#[must_use]
pub const fn artifact_header_len(n: usize) -> usize {
    8 + 37 + SLOT_LEN * n + 8 + 16
}

/// Why a sealed artifact under a specific-people header cannot be read.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ArtifactError {
    /// The bytes are not as long as the manifest's `sizeBytes`.
    SizeMismatch,
    /// The header or a segment failed its checks (§3.5): as a copy that failed `packHash`.
    SealedPackCorrupt,
    /// The sender key is not the owner's ECDSA_SECP256K1 ENCRYPTION key `senderKeyId`.
    Malformed,
    /// No slot opens to the committed key under the reader's keys.
    NotARecipient,
}

/// Seal `plaintext` as an artifact for `recipients` (slot order, the sender first, as for
/// [`seal`]) in the repository `repo_id`, written by `owner_id` (the `packManifest`'s
/// `$ownerId`). Draws a fresh `K_obj`, `fileId` and slot IVs.
pub fn seal_artifact(
    repo_id: &[u8; 32],
    sender: &PrivateKey,
    sender_key_id: u32,
    owner_id: &[u8; 32],
    recipients: &[Recipient],
    plaintext: &[u8],
) -> Result<Vec<u8>, PrivateError> {
    let mut k_obj = Zeroizing::new([0u8; 32]);
    let mut file_id = [0u8; 16];
    getrandom::getrandom(&mut *k_obj).map_err(|_| PrivateError::Rng)?;
    getrandom::getrandom(&mut file_id).map_err(|_| PrivateError::Rng)?;
    seal_artifact_inner(
        repo_id,
        sender,
        sender_key_id,
        owner_id,
        recipients,
        plaintext,
        &k_obj,
        file_id,
        ARTIFACT_SEG_LOG2,
        |r, pt| envelope::encrypt(sender, &r.public_key, pt).map_err(|_| PrivateError::Malformed),
    )
}

/// [`seal_artifact`] with a caller-chosen `K_obj`, `fileId`, segment size and slot IVs: the
/// conformance vectors only.
#[cfg(any(test, feature = "vectors"))]
#[allow(clippy::too_many_arguments)]
pub fn seal_artifact_with(
    repo_id: &[u8; 32],
    sender: &PrivateKey,
    sender_key_id: u32,
    owner_id: &[u8; 32],
    recipients: &[Recipient],
    plaintext: &[u8],
    k_obj: &[u8; 32],
    file_id: [u8; 16],
    seg_log2: u8,
    ivs: &[[u8; 16]],
) -> Result<Vec<u8>, PrivateError> {
    if ivs.len() != recipients.len() {
        return Err(PrivateError::Malformed);
    }
    let mut next = ivs.iter();
    seal_artifact_inner(
        repo_id,
        sender,
        sender_key_id,
        owner_id,
        recipients,
        plaintext,
        k_obj,
        file_id,
        seg_log2,
        |r, pt| {
            let iv = next.next().ok_or(PrivateError::Malformed)?;
            envelope::encrypt_with_iv_for_vectors(sender, &r.public_key, pt, iv)
                .map_err(|_| PrivateError::Malformed)
        },
    )
}

fn artifact_nonce(i: u64, segments: u64) -> [u8; 12] {
    let mut n = [0u8; 12];
    n[..8].copy_from_slice(&i.to_be_bytes());
    n[11] = u8::from(i + 1 == segments);
    n
}

#[allow(clippy::too_many_arguments)]
fn seal_artifact_inner(
    repo_id: &[u8; 32],
    sender: &PrivateKey,
    sender_key_id: u32,
    owner_id: &[u8; 32],
    recipients: &[Recipient],
    plaintext: &[u8],
    k_obj: &[u8; 32],
    file_id: [u8; 16],
    seg_log2: u8,
    wrap: impl FnMut(&Recipient, &[u8]) -> Result<Vec<u8>, PrivateError>,
) -> Result<Vec<u8>, PrivateError> {
    if !(ARTIFACT_MIN_SEG_LOG2..=ARTIFACT_MAX_SEG_LOG2).contains(&seg_log2) {
        return Err(PrivateError::Malformed);
    }
    let obj = ObjKeys::derive(repo_id, k_obj);
    let block = slot_block(
        sender,
        sender_key_id,
        owner_id,
        recipients,
        &obj,
        k_obj,
        wrap,
    )?;
    let mut out = Vec::with_capacity(artifact_header_len(recipients.len()) + plaintext.len() + 16);
    out.extend_from_slice(&super::pack::MAGIC);
    out.extend_from_slice(&[ARTIFACT_VERSION, seg_log2, 0, 0]);
    out.extend_from_slice(&block);
    out.extend_from_slice(&(plaintext.len() as u64).to_be_bytes());
    out.extend_from_slice(&file_id);
    let header = out.clone();
    let pack_key = obj.pack_key(&file_id);
    let cipher = Aes256Gcm::new((&*pack_key).into());
    let seg = 1usize << seg_log2;
    let segments = plaintext.len().div_ceil(seg).max(1);
    for i in 0..segments {
        let chunk =
            &plaintext[(i * seg).min(plaintext.len())..((i + 1) * seg).min(plaintext.len())];
        let ct = cipher
            .encrypt(
                Nonce::from_slice(&artifact_nonce(i as u64, segments as u64)),
                Payload {
                    msg: chunk,
                    aad: &header,
                },
            )
            .map_err(|_| PrivateError::SealedPackCorrupt)?;
        out.extend_from_slice(&ct);
    }
    Ok(out)
}

/// Open a sealed artifact under a specific-people header whose manifest says `size_bytes`, as
/// `reader`, with the manifest owner's keys `owner_keys` (the letter reader rule: the sender key
/// is the owner's ECDSA_SECP256K1 ENCRYPTION key `senderKeyId`; a slot counts only when its
/// KCV prefix and full commitment match). The length is checked before anything else.
pub fn open_artifact(
    repo_id: &[u8; 32],
    sealed: &[u8],
    size_bytes: u64,
    owner_keys: &[OwnerKey],
    reader: &Reader<'_>,
) -> Result<Zeroizing<Vec<u8>>, ArtifactError> {
    if sealed.len() as u64 != size_bytes {
        return Err(ArtifactError::SizeMismatch);
    }
    let corrupt = ArtifactError::SealedPackCorrupt;
    if sealed.len() < 8 + 37
        || sealed[..4] != super::pack::MAGIC
        || sealed[4] != ARTIFACT_VERSION
        || !(ARTIFACT_MIN_SEG_LOG2..=ARTIFACT_MAX_SEG_LOG2).contains(&sealed[5])
        || sealed[6..8] != [0, 0]
    {
        return Err(corrupt);
    }
    let n = usize::from(sealed[8]);
    let header_len = artifact_header_len(n);
    if !(1..=MAX_RECIPIENTS).contains(&n) || sealed.len() < header_len {
        return Err(corrupt);
    }
    let header = &sealed[..header_len];
    let block = &header[8..8 + 37 + SLOT_LEN * n];
    let plaintext_len = u64::from_be_bytes(
        header[header_len - 24..header_len - 16]
            .try_into()
            .expect("8 bytes"),
    );
    let file_id: [u8; 16] = header[header_len - 16..].try_into().expect("16 bytes");
    let seg = 1u64 << sealed[5];
    let segments = plaintext_len.div_ceil(seg).max(1);
    let expected = (header_len as u64)
        .checked_add(plaintext_len)
        .and_then(|x| x.checked_add(segments.checked_mul(16)?));
    if expected != Some(sealed.len() as u64) {
        return Err(corrupt);
    }
    let sender_key_id = u32::from_be_bytes(block[1..5].try_into().expect("4 bytes"));
    let sender_public = sender_key(owner_keys, sender_key_id).ok_or(ArtifactError::Malformed)?;
    let (_, obj) = find_slot(repo_id, block, n, sender_public, reader)
        .map_err(|()| ArtifactError::Malformed)?
        .ok_or(ArtifactError::NotARecipient)?;
    let pack_key = obj.pack_key(&file_id);
    let cipher = Aes256Gcm::new((&*pack_key).into());
    let mut out = Zeroizing::new(Vec::with_capacity(
        usize::try_from(plaintext_len).map_err(|_| corrupt)?,
    ));
    let mut at = header_len;
    for i in 0..segments {
        let plain = (plaintext_len - (i * seg).min(plaintext_len)).min(seg);
        let len = usize::try_from(plain + 16).map_err(|_| corrupt)?;
        let pt = cipher
            .decrypt(
                Nonce::from_slice(&artifact_nonce(i, segments)),
                Payload {
                    msg: &sealed[at..at + len],
                    aad: header,
                },
            )
            .map_err(|_| corrupt)?;
        out.extend_from_slice(&Zeroizing::new(pt));
        at += len;
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::private::DocKind;

    fn key(b: u8) -> PrivateKey {
        PrivateKey::from_slice(&[b; 32]).unwrap()
    }

    fn header(owner: [u8; 32]) -> DocHeader {
        let mut h = DocHeader::new(DocKind::Comment, owner, 0);
        h.target_id = Some([0x33; 32]);
        h
    }

    fn body(s: &str) -> Fields {
        Fields {
            body: Some(s.into()),
            ..Fields::default()
        }
    }

    fn owner_keys(k: &PrivateKey) -> Vec<OwnerKey> {
        vec![OwnerKey {
            id: 4,
            purpose: PURPOSE_ENCRYPTION,
            key_type: KEY_TYPE_ECDSA_SECP256K1,
            data: k.public_key().to_vec(),
        }]
    }

    #[test]
    fn every_recipient_and_only_them_read_a_production_letter() {
        let repo = [0x11; 32];
        let (alice, bob, carol, dave) = (key(1), key(2), key(3), key(4));
        let _ = (&bob, &carol);
        let ids = [[0xa1; 32], [0xb2; 32], [0xc3; 32], [0xd4; 32]];
        let recipients: Vec<Recipient> = [&alice, &bob, &carol]
            .iter()
            .zip(ids)
            .map(|(k, id)| Recipient {
                identity_id: id,
                public_key: k.public_key(),
            })
            .collect();
        let h = header(ids[0]);
        let enc = seal(&repo, &alice, 4, &h, &body("hello"), &recipients).unwrap();
        assert_eq!((enc.len() - framing(3)) % 64, 0, "a padded TLV");
        let ok = owner_keys(&alice);
        for i in 0..3u8 {
            let keys = [key(i + 1)];
            let i = usize::from(i);
            let r = Reader {
                identity_id: ids[i],
                keys: &keys,
            };
            match open(&repo, &h, &enc, &ok, &r) {
                LetterOpened::Readable(l) => {
                    assert_eq!(l.slot, i);
                    assert_eq!(l.fields, body("hello"));
                    assert_eq!(l.recipients, ids[..3].to_vec());
                }
                other => panic!("reader {i}: {other:?}"),
            }
        }
        let keys = [dave];
        let outsider = Reader {
            identity_id: ids[3],
            keys: &keys,
        };
        assert_eq!(
            open(&repo, &h, &enc, &ok, &outsider),
            LetterOpened::Unreadable(LetterUnreadable::NotARecipient)
        );
        // a reader claiming another's identity at its slot is refused
        let keys = [key(2)];
        let liar = Reader {
            identity_id: ids[2],
            keys: &keys,
        };
        assert_eq!(open(&repo, &h, &enc, &ok, &liar), LetterOpened::Malformed);
    }

    #[test]
    fn a_production_artifact_opens_for_each_recipient_only() {
        let repo = [0x11; 32];
        let (alice, bob) = (key(1), key(2));
        let recipients = [
            Recipient {
                identity_id: [0xa1; 32],
                public_key: alice.public_key(),
            },
            Recipient {
                identity_id: [0xb2; 32],
                public_key: bob.public_key(),
            },
        ];
        let plain: Vec<u8> = (0..40_000u32).map(|i| (i % 251) as u8).collect();
        let sealed = seal_artifact(&repo, &alice, 4, &[0xa1; 32], &recipients, &plain).unwrap();
        assert_eq!(sealed.len(), artifact_header_len(2) + 40_000 + 3 * 16);
        let ok = owner_keys(&alice);
        for (i, k) in [key(1), key(2)].into_iter().enumerate() {
            let keys = [k];
            let r = Reader {
                identity_id: recipients[i].identity_id,
                keys: &keys,
            };
            let got = open_artifact(&repo, &sealed, sealed.len() as u64, &ok, &r).unwrap();
            assert_eq!(*got, plain);
        }
        let keys = [key(3)];
        let outsider = Reader {
            identity_id: [0xc3; 32],
            keys: &keys,
        };
        assert_eq!(
            open_artifact(&repo, &sealed, sealed.len() as u64, &ok, &outsider),
            Err(ArtifactError::NotARecipient)
        );
    }

    #[test]
    fn the_sender_must_be_slot_zero_and_ids_are_unique() {
        let repo = [0x11; 32];
        let (alice, bob) = (key(1), key(2));
        let a = Recipient {
            identity_id: [0xa1; 32],
            public_key: alice.public_key(),
        };
        let b = Recipient {
            identity_id: [0xb2; 32],
            public_key: bob.public_key(),
        };
        let h = header([0xa1; 32]);
        let f = body("x");
        assert!(seal(&repo, &alice, 4, &h, &f, &[b.clone(), a.clone()]).is_err());
        assert!(seal(&repo, &alice, 4, &h, &f, &[a.clone(), a.clone()]).is_err());
        assert!(seal(&repo, &alice, 4, &h, &f, &[]).is_err());
        let seventeen: Vec<Recipient> = std::iter::once(a.clone())
            .chain((1..17u8).map(|i| Recipient {
                identity_id: [i; 32],
                public_key: key(i + 1).public_key(),
            }))
            .collect();
        assert!(seal(&repo, &alice, 4, &h, &f, &seventeen).is_err());
        let mut h1 = h.clone();
        h1.epoch = 1;
        assert!(seal(&repo, &alice, 4, &h1, &f, std::slice::from_ref(&a)).is_err());
        assert!(seal(&repo, &alice, 4, &h, &f, &[a, b]).is_ok());
    }
}
