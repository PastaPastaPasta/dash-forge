//! Encrypted document fields (`docs/security/private-repos.md` §4) and the key-dependent read
//! layer [`open_content`] (§8.1).

use std::collections::{BTreeMap, BTreeSet};

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use serde::{Deserialize, Serialize};

use super::keys::{ct_eq, rnd32, EpochKeys};
use super::tlv::{self, Fields};
use super::{DocKind, PrivateError, GRACE_BLOCKS};

/// `enc` version of the content types.
pub const V1: u8 = 0x01;
/// `enc` version of `config`, which carries `COMMIT_e` (§4.2).
pub const V2: u8 = 0x02;
const NONCE_LEN: usize = 12;
const TAG_LEN: usize = 16;
/// Smallest v0x01 `enc`: version, nonce and tag.
pub const MIN_V1: usize = 1 + NONCE_LEN + TAG_LEN;
/// Smallest v0x02 `enc`: version, commitment, nonce and tag.
pub const MIN_V2: usize = 1 + 32 + NONCE_LEN + TAG_LEN;
const AD_DOMAIN: &[u8] = b"dash-forge/v2/doc\0";

/// The plaintext identity of a document that the AD binds (§4.4): everything a reader needs
/// besides `enc` to open it. Serialized in the conformance vectors' shape.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocHeader {
    /// The document type.
    #[serde(rename = "type")]
    pub kind: DocKind,
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
    /// The document `$id`, 32 bytes (configs need it to know whether they are the anchor).
    #[serde(default, skip_serializing_if = "Option::is_none", with = "opt_hex32")]
    pub id: Option<[u8; 32]>,
    /// `$createdAtBlockHeight` (the late-content rule).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at_block_height: Option<u64>,
}

impl DocHeader {
    /// A header with only the always-present fields.
    #[must_use]
    pub fn new(kind: DocKind, owner_id: [u8; 32], epoch: u32) -> Self {
        Self {
            kind,
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
            id: None,
            created_at_block_height: None,
        }
    }

    /// The `bind` of §4.4. `None` when a field the type binds is missing (malformed input).
    fn bind(&self, keys: &EpochKeys) -> Option<Vec<u8>> {
        Some(match self.kind {
            DocKind::Issue | DocKind::Patch => self.number?.to_be_bytes().to_vec(),
            DocKind::Comment => self.target_id?.to_vec(),
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
            DocKind::Config => keys.commit().to_vec(),
        })
    }

    /// The associated data of §4.4 for `enc` version `version`.
    pub(crate) fn ad(&self, keys: &EpochKeys, version: u8) -> Option<Vec<u8>> {
        let bind = self.bind(keys)?;
        let t = self.kind.type_name().as_bytes();
        let mut ad = Vec::with_capacity(AD_DOMAIN.len() + 1 + 64 + 4 + t.len() + 1 + bind.len());
        ad.extend_from_slice(AD_DOMAIN);
        ad.push(version);
        ad.extend_from_slice(keys.repo_id());
        ad.extend_from_slice(&self.owner_id);
        ad.extend_from_slice(&self.epoch.to_be_bytes());
        ad.extend_from_slice(t);
        ad.push(0);
        ad.extend_from_slice(&bind);
        Some(ad)
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
/// document must equal the keyed hash of the name inside `enc`.
fn ref_names_match(header: &DocHeader, fields: &Fields, keys: &EpochKeys) -> bool {
    // a present hash requires its name (§4.5): a patch indexed under a branch it does not name
    // is the reader disagreement the check exists to prevent; an absent hash is not checked
    let check = |hash: Option<[u8; 32]>, name: Option<&String>| match (hash, name) {
        (Some(h), Some(n)) => ct_eq(&h, &keys.ref_name_hash(n)),
        (Some(_), None) => false,
        (None, _) => true,
    };
    match header.kind {
        DocKind::RefUpdate | DocKind::ProtectedRefUpdate => {
            check(header.ref_name_hash, fields.ref_name.as_ref())
        }
        DocKind::Patch => {
            check(header.base_ref_name_hash, fields.base_ref_name.as_ref())
                && check(header.source_ref_name_hash, fields.source_ref_name.as_ref())
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
    if header.epoch != keys.epoch() {
        return Err(PrivateError::Malformed);
    }
    let pt = tlv::encode(fields);
    // a writer never emits what a reader refuses: the same parse, and the same hash check
    let parsed = tlv::parse(&pt, header.kind, anchor_with_prev(header, is_anchor))
        .ok_or(PrivateError::Malformed)?;
    if !ref_names_match(header, &parsed, keys) {
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

/// Why a well-framed document cannot be shown (§8.1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Unreadable {
    /// The epoch has no anchor, so it does not exist (§5.3).
    NoEpoch,
    /// The epoch exists but the reader holds no key for it.
    NoKey,
    /// A config whose commitment is not the reader's key's (§4.2): a split view.
    CommitMismatch,
    /// AES-GCM failed under the §4.4 AD: tampered, an outsider's bytes, or a copy-paste.
    BadTag,
    /// Written under a superseded epoch after the grace period by a non-member (§8.2).
    Late,
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
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AnchorRef {
    /// The anchor config's `$id` (32 bytes, compared as bytes).
    #[serde(with = "hex32")]
    pub id: [u8; 32],
    /// Its `$createdAtBlockHeight`.
    pub height: u64,
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
}

impl OpenContext {
    /// Whether content under `epoch` at block height `height` by `owner` is late (§8.2): after
    /// the next existing epoch's anchor plus [`GRACE_BLOCKS`], by someone who is not a current
    /// member.
    #[must_use]
    pub fn is_late(&self, epoch: u32, height: u64, owner: &[u8; 32]) -> bool {
        is_late(&self.anchors, epoch, height, self.members.contains(owner))
    }
}

/// The late-content rule over anchor heights (§8.2).
pub(crate) fn is_late(
    anchors: &BTreeMap<u32, AnchorRef>,
    epoch: u32,
    height: u64,
    current_member: bool,
) -> bool {
    if current_member {
        return false;
    }
    let next = epoch
        .checked_add(1)
        .and_then(|from| anchors.range(from..).next());
    next.is_some_and(|(_, a)| height > a.height.saturating_add(GRACE_BLOCKS))
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

/// Step 1 of §8.1: the `enc` length and version byte for the document's kind.
fn well_framed(header: &DocHeader, enc: &[u8]) -> bool {
    match header.kind {
        DocKind::Config => enc.len() >= MIN_V2 && enc[0] == V2,
        _ => enc.len() >= MIN_V1 && enc[0] == V1,
    }
}

fn decrypt(keys: &EpochKeys, header: &DocHeader, enc: &[u8], is_anchor: bool) -> Opened {
    let version = enc[0];
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
    if !ref_names_match(header, &fields, keys) {
        return Opened::Malformed;
    }
    Opened::Readable(Box::new(fields))
}

/// `open_content(doc, keys, epochs)` of §8.1, in the normative order: framing, epoch existence,
/// key, commitment (config), AES-GCM, TLV, ref-name hash, late content.
#[must_use]
pub fn open_content(ctx: &OpenContext, header: &DocHeader, enc: &[u8]) -> Opened {
    if !well_framed(header, enc) {
        return Opened::Malformed;
    }
    let Some(anchor) = ctx.anchors.get(&header.epoch) else {
        return Opened::Unreadable(Unreadable::NoEpoch);
    };
    let Some(keys) = ctx.keys.get(&header.epoch) else {
        return Opened::Unreadable(Unreadable::NoKey);
    };
    let is_anchor = header.id == Some(anchor.id);
    match decrypt(keys, header, enc, is_anchor) {
        Opened::Readable(fields) => {
            // step 7; `$createdAtBlockHeight` is required by the schema (§13), and without it
            // the late rule cannot be judged
            let Some(height) = header.created_at_block_height else {
                return Opened::Malformed;
            };
            if ctx.is_late(header.epoch, height, &header.owner_id) {
                Opened::Unreadable(Unreadable::Late)
            } else {
                Opened::Readable(fields)
            }
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
            },
        );
        assert_eq!(
            open_content(&ctx, &header, &first),
            Opened::Readable(Box::new(fields))
        );
    }

    #[test]
    fn seal_refuses_a_header_of_another_epoch() {
        let (mut h, f) = issue();
        h.epoch = 1;
        assert_eq!(seal(&keys(), &h, &f), Err(PrivateError::Malformed));
    }
}
