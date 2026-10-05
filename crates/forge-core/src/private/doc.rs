//! Encrypted document fields (`docs/security/private-repos.md` §4) and the key-dependent read
//! layer [`open_content`] (§8.1).

use std::collections::{BTreeMap, BTreeSet};

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use serde::{Deserialize, Serialize};

use super::keys::{ct_eq, rnd32, sha256, EpochKeys, ObjKeys};
use super::tlv::{self, Fields};
use super::{DocKind, PrivateError, GRACE_BLOCKS};
use crate::rules::v2::Visibility;

/// `enc` version of the content types of a private repository.
pub const V1: u8 = 0x01;
/// `enc` version of `config`, which carries `COMMIT_e` (§4.2).
pub const V2: u8 = 0x02;
/// `enc` version of members-only content in a public repository: a per-object key bound to the
/// AD, with a key commitment (§4.1). Never in a private repository.
pub const V3: u8 = 0x03;
/// `enc` version of a specific-people letter (§4.1, [`super::named`]), in either kind of
/// repository, always under `epoch = 0`.
pub const V4: u8 = 0x04;
pub(crate) const NONCE_LEN: usize = 12;
pub(crate) const TAG_LEN: usize = 16;
/// Smallest v0x01 `enc`: version, nonce and tag.
pub const MIN_V1: usize = 1 + NONCE_LEN + TAG_LEN;
/// Smallest v0x02 `enc`: version, commitment, nonce and tag.
pub const MIN_V2: usize = 1 + 32 + NONCE_LEN + TAG_LEN;
/// Smallest v0x03 `enc` (and its framing): version, nonce, `COMMIT_obj` and tag.
pub const MIN_V3: usize = 1 + NONCE_LEN + 32 + TAG_LEN;
const AD_DOMAIN: &[u8] = b"dash-forge/v2/doc\0";

fn private_vis() -> Visibility {
    Visibility::Private
}

#[allow(clippy::trivially_copy_pass_by_ref)]
fn is_private(v: &Visibility) -> bool {
    *v == Visibility::Private
}

/// The plaintext identity of a document that the AD binds (§4.4): everything a reader needs
/// besides `enc` to open it. Serialized in the conformance vectors' shape.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocHeader {
    /// The document type.
    #[serde(rename = "type")]
    pub kind: DocKind,
    /// The document's `vis`, which consensus holds equal to its repository's visibility. It
    /// decides which content envelopes a reader admits: v0x01 only in a private repository,
    /// v0x03 only in a public one (v0x04 in either; config is v0x02 in both). Defaults to
    /// `private`, so a caller that never sets it refuses members-only content rather than
    /// misreading it.
    #[serde(default = "private_vis", skip_serializing_if = "is_private")]
    pub vis: Visibility,
    /// `$ownerId` (32 bytes, hex).
    #[serde(with = "hex32")]
    pub owner_id: [u8; 32],
    /// `epoch`.
    pub epoch: u32,
    /// issue / patch `number`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub number: Option<u32>,
    /// comment `targetId`.
    #[serde(default, skip_serializing_if = "Option::is_none", with = "opt_hex32")]
    pub target_id: Option<[u8; 32]>,
    /// review `patchId`.
    #[serde(default, skip_serializing_if = "Option::is_none", with = "opt_hex32")]
    pub patch_id: Option<[u8; 32]>,
    /// ref update `refNameHash`.
    #[serde(default, skip_serializing_if = "Option::is_none", with = "opt_hex32")]
    pub ref_name_hash: Option<[u8; 32]>,
    /// ref update `newOid`.
    #[serde(default, skip_serializing_if = "Option::is_none", with = "opt_hex")]
    pub new_oid: Option<Vec<u8>>,
    /// ref update `prevOid`.
    #[serde(default, skip_serializing_if = "Option::is_none", with = "opt_hex")]
    pub prev_oid: Option<Vec<u8>>,
    /// ref update `force`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub force: Option<bool>,
    /// patch `baseRefNameHash`.
    #[serde(default, skip_serializing_if = "Option::is_none", with = "opt_hex32")]
    pub base_ref_name_hash: Option<[u8; 32]>,
    /// patch `sourceRefNameHash`.
    #[serde(default, skip_serializing_if = "Option::is_none", with = "opt_hex32")]
    pub source_ref_name_hash: Option<[u8; 32]>,
    /// release `tagName`: the AD binds the string itself (§16.2), never its decoding.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tag_name: Option<String>,
    /// The document `$id`, 32 bytes (configs need it to know whether they are the anchor).
    #[serde(default, skip_serializing_if = "Option::is_none", with = "opt_hex32")]
    pub id: Option<[u8; 32]>,
    /// `$createdAtBlockHeight` (the late-content rule).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at_block_height: Option<u64>,
    /// `$updatedAtBlockHeight` of a replaceable document (issue, patch, comment): an edit is
    /// judged by the late-content rule too (§8.2 "edits are judged too").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at_block_height: Option<u64>,
}

impl DocHeader {
    /// A header with only the always-present fields.
    #[must_use]
    pub fn new(kind: DocKind, owner_id: [u8; 32], epoch: u32) -> Self {
        Self {
            kind,
            vis: Visibility::Private,
            owner_id,
            epoch,
            number: None,
            target_id: None,
            patch_id: None,
            ref_name_hash: None,
            new_oid: None,
            prev_oid: None,
            force: None,
            base_ref_name_hash: None,
            source_ref_name_hash: None,
            tag_name: None,
            id: None,
            created_at_block_height: None,
            updated_at_block_height: None,
        }
    }

    /// The `bind` of §4.4. `None` when a field the type binds is missing (malformed input), and
    /// for a config without `keys` (its bind is `COMMIT_e`).
    fn bind(&self, keys: Option<&EpochKeys>) -> Option<Vec<u8>> {
        Some(match self.kind {
            DocKind::Issue | DocKind::Patch => self.number?.to_be_bytes().to_vec(),
            DocKind::Comment | DocKind::Event => self.target_id?.to_vec(),
            DocKind::Review => self.patch_id?.to_vec(),
            DocKind::RefUpdate | DocKind::ProtectedRefUpdate => {
                let oidf = |o: &[u8]| -> Option<Vec<u8>> {
                    let mut v = vec![u8::try_from(o.len()).ok()?];
                    v.extend_from_slice(o);
                    Some(v)
                };
                let mut b = self.ref_name_hash?.to_vec();
                b.extend(oidf(self.new_oid.as_deref()?)?);
                b.extend(oidf(self.prev_oid.as_deref().unwrap_or_default())?);
                b.push(u8::from(self.force.unwrap_or(false)));
                b
            }
            DocKind::Config => keys?.commit().to_vec(),
            DocKind::Release => self.tag_name.as_deref()?.as_bytes().to_vec(),
        })
    }

    /// The associated data of §4.4 for `enc` version `version` under the epoch keys `keys`.
    pub(crate) fn ad(&self, keys: &EpochKeys, version: u8) -> Option<Vec<u8>> {
        let bind = self.bind(Some(keys))?;
        Some(self.ad_with(keys.repo_id(), self.epoch, version, &bind))
    }

    /// The associated data of §4.4 with no epoch keys: `repoId` only and the literal
    /// `epoch = 0`, as a specific-people letter (`enc` v0x04) binds it (§4.1). `None` for a
    /// config (its bind is `COMMIT_e`) or a missing bind field.
    #[must_use]
    pub fn ad_without_keys(&self, repo_id: &[u8; 32], version: u8) -> Option<Vec<u8>> {
        let bind = self.bind(None)?;
        Some(self.ad_with(repo_id, 0, version, &bind))
    }

    fn ad_with(&self, repo_id: &[u8; 32], epoch: u32, version: u8, bind: &[u8]) -> Vec<u8> {
        let t = self.kind.type_name().as_bytes();
        let mut ad = Vec::with_capacity(AD_DOMAIN.len() + 1 + 64 + 4 + t.len() + 1 + bind.len());
        ad.extend_from_slice(AD_DOMAIN);
        ad.push(version);
        ad.extend_from_slice(repo_id);
        ad.extend_from_slice(&self.owner_id);
        ad.extend_from_slice(&epoch.to_be_bytes());
        ad.extend_from_slice(t);
        ad.push(0);
        ad.extend_from_slice(bind);
        ad
    }

    fn version(&self) -> u8 {
        if self.kind == DocKind::Config {
            V2
        } else {
            V1
        }
    }
}

/// The ref-name hash check of §4.5 (H3), after decryption: each hash field present on the
/// document must equal the keyed hash of the name inside `enc`. A members (v0x03) patch may
/// instead carry the public `sha256(name)` of a public branch (its base or source, §4.4 of the
/// mixed-visibility design); a members ref update is always keyed.
fn ref_names_match(header: &DocHeader, fields: &Fields, keys: &EpochKeys, version: u8) -> bool {
    // a present hash requires its name (§4.5): a patch indexed under a branch it does not name
    // is the reader disagreement the check exists to prevent; an absent hash is not checked
    let check = |hash: Option<[u8; 32]>, name: Option<&String>, public_ok: bool| match (hash, name)
    {
        (Some(h), Some(n)) => {
            ct_eq(&h, &keys.ref_name_hash(n)) || (public_ok && ct_eq(&h, &sha256(n.as_bytes())))
        }
        (Some(_), None) => false,
        (None, _) => true,
    };
    match header.kind {
        DocKind::RefUpdate | DocKind::ProtectedRefUpdate => {
            check(header.ref_name_hash, fields.ref_name.as_ref(), false)
        }
        DocKind::Patch => {
            let public_ok = version == V3;
            check(
                header.base_ref_name_hash,
                fields.base_ref_name.as_ref(),
                public_ok,
            ) && check(
                header.source_ref_name_hash,
                fields.source_ref_name.as_ref(),
                public_ok,
            )
        }
        _ => true,
    }
}

/// Whether a `config` must carry tags 8 and 9: every config of an epoch `e ≥ 1`, anchor or
/// not (§4.3). Any of an epoch's configs may become its anchor when an earlier one's author
/// stops being a maintainer (§5.3), and it must then still chain to the previous epoch. They
/// are refused everywhere else. `_is_anchor` is kept for the call sites' documentation value.
fn anchor_with_prev(header: &DocHeader, _is_anchor: bool) -> bool {
    header.kind == DocKind::Config && header.epoch >= 1
}

/// Seal `fields` for the document `header` under `keys` (the keys of `header.epoch`) with a
/// hedged random nonce (§3.6). A config is sealed as a non-anchor unless `fields` carries tags 8
/// and 9 (then as the anchor of an `e ≥ 1` epoch).
pub fn seal(
    keys: &EpochKeys,
    header: &DocHeader,
    fields: &Fields,
) -> Result<Vec<u8>, PrivateError> {
    let anchor = header.kind == DocKind::Config && fields.prev_epoch.is_some();
    let rnd = rnd32()?;
    seal_inner(keys, header, fields, anchor, |ad, pt| {
        keys.hedged_nonce(&rnd, ad, pt)
    })
}

/// [`seal`] with a caller-chosen nonce and anchor flag: the conformance vectors only.
#[cfg(any(test, feature = "vectors"))]
pub fn seal_with_nonce(
    keys: &EpochKeys,
    header: &DocHeader,
    fields: &Fields,
    is_anchor: bool,
    nonce: [u8; 12],
) -> Result<Vec<u8>, PrivateError> {
    seal_inner(keys, header, fields, is_anchor, |_, _| nonce)
}

fn seal_inner(
    keys: &EpochKeys,
    header: &DocHeader,
    fields: &Fields,
    is_anchor: bool,
    nonce: impl FnOnce(&[u8], &[u8]) -> [u8; 12],
) -> Result<Vec<u8>, PrivateError> {
    // a public repository's content is never v0x01 (its configs are v0x02 in both)
    if header.epoch != keys.epoch()
        || (header.vis == Visibility::Public && header.kind != DocKind::Config)
    {
        return Err(PrivateError::Malformed);
    }
    let pt = tlv::encode(fields);
    // a writer never emits what a reader refuses: the same parse, and the same hash check
    let parsed = tlv::parse(&pt, header.kind, anchor_with_prev(header, is_anchor))
        .ok_or(PrivateError::Malformed)?;
    if !ref_names_match(header, &parsed, keys, V1) {
        return Err(PrivateError::Malformed);
    }
    let version = header.version();
    let overhead = if version == V2 { MIN_V2 } else { MIN_V1 };
    let max = header.kind.max_enc() - overhead;
    if pt.len() > max {
        return Err(PrivateError::TooLarge(header.kind.type_name(), max));
    }
    let ad = header.ad(keys, version).ok_or(PrivateError::Malformed)?;
    let n = nonce(&ad, &pt);
    let ct = Aes256Gcm::new(keys.doc_key().into())
        .encrypt(Nonce::from_slice(&n), Payload { msg: &pt, aad: &ad })
        .map_err(|_| PrivateError::Malformed)?;
    let mut enc = Vec::with_capacity(overhead + pt.len());
    enc.push(version);
    if version == V2 {
        enc.extend_from_slice(keys.commit());
    }
    enc.extend_from_slice(&n);
    enc.extend_from_slice(&ct);
    Ok(enc)
}

/// Whether a members or specific-people document of `kind` pads its TLV (D28): on for the
/// discussion types (issue, PR, comment, review), off for ref updates, events and configs, whose
/// lengths say little and whose `enc` cap is tight.
#[must_use]
pub fn pads(kind: DocKind) -> bool {
    matches!(
        kind,
        DocKind::Issue | DocKind::Patch | DocKind::Comment | DocKind::Review
    )
}

/// Seal `fields` as members-only content of a public repository (`enc` v0x03, §4.1) under the
/// lane's epoch keys `keys`, with a hedged random nonce (§3.6) and the padding of [`pads`]:
///
/// ```text
/// enc = 0x03 ‖ nonce(12) ‖ COMMIT_obj(32) ‖ AES-256-GCM(K_doc,obj, nonce, TLV, AD') ‖ tag(16)
/// K_obj = HKDF-Expand(PRK_e, "dash-forge/v2/obj" ‖ 0x00 ‖ u32(e) ‖ nonce ‖ SHA-256(AD), 32)
/// AD' = AD(enc[0] = 0x03) ‖ COMMIT_obj
/// ```
///
/// Refuses a config (always v0x02) and a release (its own envelope).
pub fn seal_members(
    keys: &EpochKeys,
    header: &DocHeader,
    fields: &Fields,
) -> Result<Vec<u8>, PrivateError> {
    let rnd = rnd32()?;
    seal_members_inner(keys, header, fields, |ad, pt| {
        keys.hedged_nonce(&rnd, ad, pt)
    })
}

/// [`seal_members`] with a caller-chosen nonce: the conformance vectors only.
#[cfg(any(test, feature = "vectors"))]
pub fn seal_members_with_nonce(
    keys: &EpochKeys,
    header: &DocHeader,
    fields: &Fields,
    nonce: [u8; 12],
) -> Result<Vec<u8>, PrivateError> {
    seal_members_inner(keys, header, fields, |_, _| nonce)
}

/// The TLV a members or specific-people document of `kind` seals: `records` (already parsed
/// back by the writer), then the padding record when the kind pads and it fits `max`.
pub(crate) fn padded(kind: DocKind, records: &[u8], max: usize) -> zeroize::Zeroizing<Vec<u8>> {
    let mut pt = zeroize::Zeroizing::new(Vec::with_capacity(records.len() + 3 + tlv::PAD_BUCKET));
    pt.extend_from_slice(records);
    if pads(kind) {
        pt.extend(tlv::pad_record(records.len(), max));
    }
    pt
}

fn seal_members_inner(
    keys: &EpochKeys,
    header: &DocHeader,
    fields: &Fields,
    nonce: impl FnOnce(&[u8], &[u8]) -> [u8; 12],
) -> Result<Vec<u8>, PrivateError> {
    if header.epoch != keys.epoch()
        || header.vis != Visibility::Public
        || matches!(header.kind, DocKind::Config | DocKind::Release)
    {
        return Err(PrivateError::Malformed);
    }
    let records = tlv::encode(fields);
    let parsed = tlv::parse(&records, header.kind, false).ok_or(PrivateError::Malformed)?;
    if !ref_names_match(header, &parsed, keys, V3) {
        return Err(PrivateError::Malformed);
    }
    let max = header.kind.max_enc() - MIN_V3;
    if records.len() > max {
        return Err(PrivateError::TooLarge(header.kind.type_name(), max));
    }
    let pt = padded(header.kind, &records, max);
    let ad = header.ad(keys, V3).ok_or(PrivateError::Malformed)?;
    let n = nonce(&ad, &pt);
    let obj = ObjKeys::derive(keys.repo_id(), &keys.obj_key(&n, &ad));
    let mut ad2 = ad;
    ad2.extend_from_slice(obj.commit());
    let ct = Aes256Gcm::new(obj.doc_key().into())
        .encrypt(
            Nonce::from_slice(&n),
            Payload {
                msg: &pt,
                aad: &ad2,
            },
        )
        .map_err(|_| PrivateError::Malformed)?;
    let mut enc = Vec::with_capacity(MIN_V3 + pt.len());
    enc.push(V3);
    enc.extend_from_slice(&n);
    enc.extend_from_slice(obj.commit());
    enc.extend_from_slice(&ct);
    Ok(enc)
}

/// Why a well-framed document cannot be shown (§8.1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Unreadable {
    /// The epoch has no anchor, so it does not exist (§5.3).
    NoEpoch,
    /// The epoch exists but the reader holds no key for it.
    NoKey,
    /// A config whose commitment is not the reader's key's (§4.2): a split view. Also a members
    /// (v0x03) document whose `COMMIT_obj` is not the key the reader derives (§4.1): tampered, or
    /// built from a revealed key by someone who does not hold the epoch key. Never dropped
    /// silently: readers count and say it.
    CommitMismatch,
    /// AES-GCM failed under the §4.4 AD: tampered, an outsider's bytes, or a copy-paste.
    BadTag,
    /// Written under a superseded epoch after the grace period by a non-member (§8.2).
    Late,
    /// Created in time, but **edited** after the grace period by an author who is no longer a
    /// member (§8.2 "edits are judged too"). A replace keeps only the latest text, so the
    /// original cannot be shown instead: the reader says so rather than let history vanish
    /// silently.
    LateEdit,
    /// Sealed under an earlier use of this epoch number (one that stopped existing when its
    /// anchor's maintainer was removed, §5.3) and older than the number's current anchor: a
    /// different key, never this repository's current content. Set by the reading layer, not by
    /// [`open_content`].
    EarlierUse,
    /// A well-framed specific-people letter (`enc` v0x04): the epoch keys cannot open it; the
    /// letter reader ([`super::named::open`]) can, for its recipients.
    Letter,
}

/// The result of [`open_content`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Opened {
    /// The decoded fields.
    Readable(Box<Fields>),
    /// Well-framed but not readable by this reader.
    Unreadable(Unreadable),
    /// A document no honest writer produces; skipped and counted.
    Malformed,
}

/// One epoch's anchor, as [`open_content`] needs it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AnchorRef {
    /// The anchor config's `$id` (32 bytes, compared as bytes).
    pub id: [u8; 32],
    /// Its `$createdAtBlockHeight`.
    pub height: u64,
    /// The block height of stated(e) (§5.3): the first config, by anyone, carrying this anchor's
    /// commitment, i.e. when the epoch's key was first stated on chain. Never above `height`,
    /// and a re-anchor (same commitment, later height) does not move it. The late-content
    /// cut-off of the epoch below counts from it (§8.2), never from `height`.
    pub stated_height: u64,
}

/// What a reader knows when opening content: its keys, the anchors of the existing epochs, and
/// the current members (whose late content is still shown).
#[derive(Debug, Clone, Default)]
pub struct OpenContext {
    /// Subkeys of every epoch the reader can read.
    pub keys: BTreeMap<u32, EpochKeys>,
    /// Anchor of every existing epoch.
    pub anchors: BTreeMap<u32, AnchorRef>,
    /// Identities with a current `maintainer` or `writer` document.
    pub members: BTreeSet<[u8; 32]>,
    /// Readable epochs whose anchor is burned (§5.3): nothing is written under them.
    pub burned: BTreeSet<u32>,
}

impl OpenContext {
    /// Whether content under `epoch` at block height `height` by `owner` is late (§8.2): after
    /// stated(next(epoch)) plus [`GRACE_BLOCKS`], or under a burned epoch at any height, by
    /// someone who is not a current member.
    #[must_use]
    pub fn is_late(&self, epoch: u32, height: u64, owner: &[u8; 32]) -> bool {
        is_late(
            &self.anchors,
            &self.burned,
            epoch,
            height,
            self.members.contains(owner),
        )
    }
}

/// The late-content rule (§8.2), and burned epochs (§5.3). The cut-off `H` is the height at
/// which the next existing epoch's key was first stated on chain (its anchor's
/// [`AnchorRef::stated_height`]), not the selected anchor's own height: a re-anchor of that
/// epoch after its first anchor's author left repeats the commitment at a later height, and
/// must not reopen the window for a removed member's content under `epoch`.
pub(crate) fn is_late(
    anchors: &BTreeMap<u32, AnchorRef>,
    burned: &BTreeSet<u32>,
    epoch: u32,
    height: u64,
    current_member: bool,
) -> bool {
    if current_member {
        return false;
    }
    // nothing is ever sealed under a burned epoch: whatever is, whenever, came from someone the
    // key leaked to
    if burned.contains(&epoch) {
        return true;
    }
    let next = epoch
        .checked_add(1)
        .and_then(|from| anchors.range(from..).next());
    next.is_some_and(|(_, a)| height > a.stated_height.saturating_add(GRACE_BLOCKS))
}

/// Decrypt and parse `enc` of `header` under `keys`, as the anchor or not. Steps 1, 3–6 of §8.1
/// (no epoch-existence or late checks): what the chain walk needs to open an anchor.
pub(crate) fn open_with(
    keys: &EpochKeys,
    header: &DocHeader,
    enc: &[u8],
    is_anchor: bool,
) -> Opened {
    if !well_framed(header, enc) {
        return Opened::Malformed;
    }
    decrypt(keys, header, enc, is_anchor)
}

/// Step 1 of §8.1: the `enc` length and version byte for the document's kind and `vis`. A
/// private repository's content is v0x01, a public repository's members-only content v0x03; a
/// v0x01 `enc` in a public repository, or a v0x03 one in a private repository, is malformed
/// (`mixed_doc_open__v01_relabelled_refused`). A letter (v0x04) is framed by
/// [`super::named::well_framed`].
fn well_framed(header: &DocHeader, enc: &[u8]) -> bool {
    let Some(&version) = enc.first() else {
        return false;
    };
    match header.kind {
        DocKind::Config => enc.len() >= MIN_V2 && version == V2,
        // a release has its own TLV and open (`private::release`, §16.4)
        DocKind::Release => false,
        _ => match (version, header.vis) {
            (V1, Visibility::Private) => enc.len() >= MIN_V1,
            (V3, Visibility::Public) => enc.len() >= MIN_V3,
            (V4, _) => super::named::well_framed(header, enc),
            _ => false,
        },
    }
}

fn decrypt(keys: &EpochKeys, header: &DocHeader, enc: &[u8], is_anchor: bool) -> Opened {
    let version = enc[0];
    match version {
        V3 => return decrypt_members(keys, header, enc),
        V4 => return Opened::Unreadable(Unreadable::Letter),
        _ => {}
    }
    let body = if version == V2 {
        // the commitment is compared before GCM runs: a mismatch is CommitMismatch, never BadTag
        if !keys.commits_to(&enc[1..33]) {
            return Opened::Unreadable(Unreadable::CommitMismatch);
        }
        &enc[33..]
    } else {
        &enc[1..]
    };
    let Some(ad) = header.ad(keys, version) else {
        return Opened::Malformed;
    };
    let (nonce, ct) = body.split_at(NONCE_LEN);
    let Ok(pt) = Aes256Gcm::new(keys.doc_key().into())
        .decrypt(Nonce::from_slice(nonce), Payload { msg: ct, aad: &ad })
    else {
        return Opened::Unreadable(Unreadable::BadTag);
    };
    let pt = zeroize::Zeroizing::new(pt);
    let Some(fields) = tlv::parse(&pt, header.kind, anchor_with_prev(header, is_anchor)) else {
        return Opened::Malformed;
    };
    if !ref_names_match(header, &fields, keys, version) {
        return Opened::Malformed;
    }
    Opened::Readable(Box::new(fields))
}

/// Open a v0x03 `enc` (§4.1): derive `K_obj` from the nonce and the AD, compare the commitment
/// before GCM runs (a mismatch is `CommitMismatch`, never `BadTag`), then GCM under `K_doc,obj`
/// with `AD' = AD ‖ COMMIT_obj`, the TLV (padding skipped) and the ref-name hashes.
fn decrypt_members(keys: &EpochKeys, header: &DocHeader, enc: &[u8]) -> Opened {
    let Some(ad) = header.ad(keys, V3) else {
        return Opened::Malformed;
    };
    let (nonce, rest) = enc[1..].split_at(NONCE_LEN);
    let nonce: [u8; NONCE_LEN] = nonce.try_into().expect("framed");
    let (commit, ct) = rest.split_at(32);
    let obj = ObjKeys::derive(keys.repo_id(), &keys.obj_key(&nonce, &ad));
    if !ct_eq(obj.commit(), commit) {
        return Opened::Unreadable(Unreadable::CommitMismatch);
    }
    let mut ad2 = ad;
    ad2.extend_from_slice(commit);
    let Ok(pt) = Aes256Gcm::new(obj.doc_key().into())
        .decrypt(Nonce::from_slice(&nonce), Payload { msg: ct, aad: &ad2 })
    else {
        return Opened::Unreadable(Unreadable::BadTag);
    };
    let pt = zeroize::Zeroizing::new(pt);
    let Some(fields) = tlv::parse(&pt, header.kind, false) else {
        return Opened::Malformed;
    };
    if !ref_names_match(header, &fields, keys, V3) {
        return Opened::Malformed;
    }
    Opened::Readable(Box::new(fields))
}

/// `open_content(doc, keys, epochs)` of §8.1, in the normative order: framing, epoch existence,
/// key, commitment (config, v0x03), AES-GCM, TLV, ref-name hash, late content. Dispatches on
/// `enc[0]` and the document's `vis` (see [`DocHeader::vis`]). A specific-people letter (v0x04)
/// needs the reader's encryption keys and the sender's public key, which an [`OpenContext`] does
/// not hold: a well-framed one is `Unreadable(Letter)` here and opens through
/// [`super::named::open`].
#[must_use]
pub fn open_content(ctx: &OpenContext, header: &DocHeader, enc: &[u8]) -> Opened {
    if !well_framed(header, enc) {
        return Opened::Malformed;
    }
    if enc[0] == V4 {
        return Opened::Unreadable(Unreadable::Letter);
    }
    let Some(anchor) = ctx.anchors.get(&header.epoch) else {
        return Opened::Unreadable(Unreadable::NoEpoch);
    };
    let Some(keys) = ctx.keys.get(&header.epoch) else {
        return Opened::Unreadable(Unreadable::NoKey);
    };
    let is_anchor = header.id == Some(anchor.id);
    match decrypt(keys, header, enc, is_anchor) {
        // a member `event` is gated at consensus (a removed member cannot write one), so the
        // late rule, which is about un-gated writes under a superseded key, does not apply;
        // its schema does not carry `$createdAtBlockHeight` either (§8.1 step 7)
        Opened::Readable(fields) if header.kind == DocKind::Event => Opened::Readable(fields),
        Opened::Readable(fields) => {
            // step 7; `$createdAtBlockHeight` is required by the schema (§13), and without it
            // the late rule cannot be judged
            let Some(created) = header.created_at_block_height else {
                return Opened::Malformed;
            };
            // an edit re-seals the text: it is as late as its last write (§8.2)
            if ctx.is_late(header.epoch, created, &header.owner_id) {
                return Opened::Unreadable(Unreadable::Late);
            }
            let edited = header.updated_at_block_height.filter(|u| *u > created);
            if edited.is_some_and(|u| ctx.is_late(header.epoch, u, &header.owner_id)) {
                return Opened::Unreadable(Unreadable::LateEdit);
            }
            Opened::Readable(fields)
        }
        other => other,
    }
}

pub(crate) mod hex32 {
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(v: &[u8; 32], s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&hex::encode(v))
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<[u8; 32], D::Error> {
        let bytes = hex::decode(String::deserialize(d)?).map_err(serde::de::Error::custom)?;
        <[u8; 32]>::try_from(bytes).map_err(|_| serde::de::Error::custom("expected 32 bytes"))
    }
}

pub(crate) mod opt_hex32 {
    use serde::{Deserializer, Serializer};

    #[allow(clippy::ref_option)]
    pub fn serialize<S: Serializer>(v: &Option<[u8; 32]>, s: S) -> Result<S::Ok, S::Error> {
        match v {
            Some(v) => s.serialize_str(&hex::encode(v)),
            None => s.serialize_none(),
        }
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Option<[u8; 32]>, D::Error> {
        super::hex32::deserialize(d).map(Some)
    }
}

pub(crate) mod opt_hex {
    use serde::{Deserialize, Deserializer, Serializer};

    #[allow(clippy::ref_option)]
    pub fn serialize<S: Serializer>(v: &Option<Vec<u8>>, s: S) -> Result<S::Ok, S::Error> {
        match v {
            Some(v) => s.serialize_str(&hex::encode(v)),
            None => s.serialize_none(),
        }
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Vec<u8>>, D::Error> {
        hex::decode(String::deserialize(d)?)
            .map(Some)
            .map_err(serde::de::Error::custom)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::private::EpochKey;

    fn keys() -> EpochKeys {
        EpochKeys::derive(&[0x11; 32], 0, &EpochKey::from_bytes([3; 32]))
    }

    fn issue() -> (DocHeader, Fields) {
        let mut h = DocHeader::new(DocKind::Issue, [0x22; 32], 0);
        h.number = Some(1);
        h.created_at_block_height = Some(5);
        let f = Fields {
            title: Some("t".into()),
            ..Fields::default()
        };
        (h, f)
    }

    #[test]
    fn production_seal_draws_a_fresh_nonce_and_opens() {
        let keys = keys();
        let (header, fields) = issue();
        let first = seal(&keys, &header, &fields).unwrap();
        let second = seal(&keys, &header, &fields).unwrap();
        assert_ne!(
            first[1..13],
            second[1..13],
            "two seals must not share a nonce"
        );
        let mut ctx = OpenContext::default();
        ctx.keys.insert(0, keys);
        ctx.anchors.insert(
            0,
            AnchorRef {
                id: [0xc0; 32],
                height: 1,
                stated_height: 1,
            },
        );
        assert_eq!(
            open_content(&ctx, &header, &first),
            Opened::Readable(Box::new(fields))
        );
    }

    fn ctx0(keys: EpochKeys) -> OpenContext {
        let mut ctx = OpenContext::default();
        ctx.keys.insert(0, keys);
        ctx.anchors.insert(
            0,
            AnchorRef {
                id: [0xc0; 32],
                height: 1,
                stated_height: 1,
            },
        );
        ctx
    }

    #[test]
    fn members_content_round_trips_padded_and_only_in_a_public_repo() {
        let keys = keys();
        let (mut header, fields) = issue();
        // a private repository's header never seals v0x03, nor a public one v0x01
        assert_eq!(
            seal_members(&keys, &header, &fields),
            Err(PrivateError::Malformed)
        );
        header.vis = Visibility::Public;
        assert_eq!(seal(&keys, &header, &fields), Err(PrivateError::Malformed));
        let enc = seal_members(&keys, &header, &fields).unwrap();
        assert_eq!(enc[0], V3);
        assert_eq!((enc.len() - MIN_V3) % tlv::PAD_BUCKET, 0, "padded to 64");
        let ctx = ctx0(keys);
        assert_eq!(
            open_content(&ctx, &header, &enc),
            Opened::Readable(Box::new(fields.clone()))
        );
        // the same bytes read as a private repository's document are malformed
        let mut private = header.clone();
        private.vis = Visibility::Private;
        assert_eq!(open_content(&ctx, &private, &enc), Opened::Malformed);
        // a flipped commitment is CommitMismatch before GCM; a flipped body is BadTag
        let mut bad = enc.clone();
        bad[20] ^= 1;
        assert_eq!(
            open_content(&ctx, &header, &bad),
            Opened::Unreadable(Unreadable::CommitMismatch)
        );
        let mut bad = enc.clone();
        *bad.last_mut().unwrap() ^= 1;
        assert_eq!(
            open_content(&ctx, &header, &bad),
            Opened::Unreadable(Unreadable::BadTag)
        );
        // another issue number derives another K_obj: CommitMismatch, never a silent drop
        let mut other = header.clone();
        other.number = Some(2);
        assert_eq!(
            open_content(&ctx, &other, &enc),
            Opened::Unreadable(Unreadable::CommitMismatch)
        );
    }

    #[test]
    fn events_and_ref_updates_are_not_padded() {
        let keys = keys();
        let mut h = DocHeader::new(DocKind::Event, [0x22; 32], 0);
        h.vis = Visibility::Public;
        h.target_id = Some([0x33; 32]);
        let f = Fields {
            event_value: Some("bug".into()),
            ..Fields::default()
        };
        let enc = seal_members(&keys, &h, &f).unwrap();
        assert_eq!(enc.len(), MIN_V3 + 6);
        assert!(pads(DocKind::Review) && !pads(DocKind::RefUpdate) && !pads(DocKind::Config));
    }

    #[test]
    fn seal_refuses_a_header_of_another_epoch() {
        let (mut h, f) = issue();
        h.epoch = 1;
        assert_eq!(seal(&keys(), &h, &f), Err(PrivateError::Malformed));
    }
}
