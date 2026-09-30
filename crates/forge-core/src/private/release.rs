//! Sealed releases of a private repository (`docs/security/private-repos.md` §16): the keyed
//! `tagName` (§16.1), the `enc` TLV and its AD (§16.2), [`open`] (§16.4), the sealed kind-4
//! asset manifest (§16.5) and the reader's [`fold`] over a tag's revisions (§16.3).
//!
//! The `private_release_*` conformance vectors hold this module byte for byte against
//! `tools/private-repos-vectors/gen.py` and forge-web's `lib/private/release.ts`.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::doc::{OpenContext, Unreadable};
use super::keys::{ct_eq, sha256, EpochKeys};
use super::{pack, PrivateError};

/// forge-core `$defs.enc.maxItems` minus the v0x01 framing (§4.1): 1507 bytes of TLV.
pub const MAX_PLAINTEXT: usize = 1536 - 29;
const AD_DOMAIN: &[u8] = b"dash-forge/v2/doc\0";
const MAX_SAFE_INT: u64 = (1 << 53) - 1;

const NOTES: u8 = 2;
const IMPORTED_AUTHOR: u8 = 13;
const IMPORTED_URL: u8 = 14;
const TAG: u8 = 16;
const NAME: u8 = 17;
const TARGET_OID: u8 = 18;
const FLAGS: u8 = 19;
const IMPORTED_CREATED_AT: u8 = 20;
const ASSET_MANIFEST: u8 = 21;
const FIRST_EXTENSION: u8 = 64;
const PAD_BUCKET: usize = 32;
/// A reader refuses a kind-4 manifest whose `sizeBytes` is larger (§16.5).
pub const MAX_MANIFEST_BYTES: u64 = 1 << 20;

const PRERELEASE: u8 = 0x01;
const DRAFT: u8 = 0x02;
const YANKED: u8 = 0x04;
const UNPUBLISHED: u8 = 0x08;
const NOTES_CONTINUE: u8 = 0x10;
const ALL_FLAGS: u8 = 0x1f;

/// A release's sealed fields (§16.2), in the vectors' JSON shape (one boolean per flag bit).
#[allow(clippy::struct_excessive_bools)]
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReleaseFields {
    /// TLV 16.
    pub tag: String,
    /// TLV 17.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// TLV 2: the whole notes, or their prefix when [`Self::notes_continue`] is set.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    /// TLV 18 (hex).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_oid: Option<String>,
    /// TLV 19 bit 0x01.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub prerelease: bool,
    /// TLV 19 bit 0x02.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub draft: bool,
    /// TLV 19 bit 0x04.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub yanked: bool,
    /// TLV 19 bit 0x08.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub unpublished: bool,
    /// TLV 19 bit 0x10: the full notes are the manifest's `notes`.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub notes_continue: bool,
    /// TLV 13.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub imported_author: Option<String>,
    /// TLV 14.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub imported_url: Option<String>,
    /// TLV 20.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub imported_created_at: Option<u64>,
    /// TLV 21 (hex): the `packHash` of the sealed kind-4 manifest.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asset_manifest: Option<String>,
}

impl ReleaseFields {
    fn flags(&self) -> u8 {
        [
            (self.prerelease, PRERELEASE),
            (self.draft, DRAFT),
            (self.yanked, YANKED),
            (self.unpublished, UNPUBLISHED),
            (self.notes_continue, NOTES_CONTINUE),
        ]
        .iter()
        .filter(|(on, _)| *on)
        .fold(0, |acc, (_, bit)| acc | bit)
    }

    /// TLV 21 as bytes.
    #[must_use]
    pub fn asset_manifest_hash(&self) -> Option<[u8; 32]> {
        hex::decode(self.asset_manifest.as_deref()?)
            .ok()?
            .try_into()
            .ok()
    }
}

/// The plaintext `tagName`: unpadded base64url of `HMAC-SHA256(K_tag,e, tag)`, 43 characters
/// (§16.1).
#[must_use]
pub fn tag_name(keys: &EpochKeys, tag: &str) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(keys.release_tag_hash(tag))
}

/// The §4.4 AD with `docType = "release"` and `bind = tagName` (its ASCII bytes).
#[must_use]
pub fn ad(keys: &EpochKeys, owner: &[u8; 32], tag_name: &str) -> Vec<u8> {
    let mut ad = AD_DOMAIN.to_vec();
    ad.push(0x01);
    ad.extend_from_slice(keys.repo_id());
    ad.extend_from_slice(owner);
    ad.extend_from_slice(&keys.epoch().to_be_bytes());
    ad.extend_from_slice(b"release\0");
    ad.extend_from_slice(tag_name.as_bytes());
    ad
}

fn rec(out: &mut Vec<u8>, tag: u8, value: &[u8]) {
    out.push(tag);
    out.extend_from_slice(&u16::try_from(value.len()).unwrap_or(u16::MAX).to_be_bytes());
    out.extend_from_slice(value);
}

/// The tag-64 record that pads a TLV of `n` bytes to a multiple of [`PAD_BUCKET`] within
/// [`MAX_PLAINTEXT`] (§16.2); nothing when not even an empty record fits.
fn pad(out: &mut Vec<u8>) {
    let n = out.len();
    if n + 3 > MAX_PLAINTEXT {
        return;
    }
    let r = ((PAD_BUCKET - (n + 3) % PAD_BUCKET) % PAD_BUCKET).min(MAX_PLAINTEXT - 3 - n);
    rec(out, FIRST_EXTENSION, &vec![0; r]);
}

/// The TLV records of `f`, ascending, without padding (§16.2). `None` when a hex field does
/// not decode.
fn encode(f: &ReleaseFields) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    if let Some(n) = &f.notes {
        rec(&mut out, NOTES, n.as_bytes());
    }
    if let Some(a) = &f.imported_author {
        rec(&mut out, IMPORTED_AUTHOR, a.as_bytes());
    }
    if let Some(u) = &f.imported_url {
        rec(&mut out, IMPORTED_URL, u.as_bytes());
    }
    rec(&mut out, TAG, f.tag.as_bytes());
    if let Some(n) = &f.name {
        rec(&mut out, NAME, n.as_bytes());
    }
    if let Some(o) = &f.target_oid {
        rec(&mut out, TARGET_OID, &hex::decode(o).ok()?);
    }
    // always written, 0x00 included: a flag change never changes the length
    rec(&mut out, FLAGS, &[f.flags()]);
    if let Some(t) = f.imported_created_at {
        rec(&mut out, IMPORTED_CREATED_AT, &t.to_be_bytes());
    }
    if let Some(m) = &f.asset_manifest {
        rec(&mut out, ASSET_MANIFEST, &hex::decode(m).ok()?);
    }
    Some(out)
}

fn text_ok(s: &str, min: usize, chars: usize, bytes: usize) -> bool {
    s.len() >= min && s.len() <= bytes && s.chars().count() <= chars
}

/// Parse a release TLV with §4.3's strictness and §16.2's table. `None` is `Malformed`.
#[must_use]
pub fn parse(pt: &[u8]) -> Option<ReleaseFields> {
    let mut f = ReleaseFields::default();
    let mut tag_seen = false;
    let mut flags_seen = false;
    let mut last: Option<u8> = None;
    let mut rest = pt;
    while !rest.is_empty() {
        let (&t, tail) = rest.split_first()?;
        let len = usize::from(u16::from_be_bytes(tail.get(..2)?.try_into().ok()?));
        let v = tail.get(2..2 + len)?;
        rest = &tail[2 + len..];
        if last.is_some_and(|p| t <= p) {
            return None;
        }
        last = Some(t);
        if t >= FIRST_EXTENSION {
            continue;
        }
        let text = |min, chars, bytes| -> Option<Option<String>> {
            let s = std::str::from_utf8(v).ok()?;
            if s.len() > bytes || s.chars().count() > chars {
                return None;
            }
            // a zero-length record for a minLength-1 field counts as absent
            Some((s.len() >= min).then(|| s.to_owned()))
        };
        match t {
            NOTES => f.notes = text(0, 5120, 5120)?,
            IMPORTED_AUTHOR => f.imported_author = text(1, 120, 480)?,
            IMPORTED_URL => f.imported_url = text(1, 300, 300)?,
            TAG => {
                if let Some(s) = text(1, 63, 63)? {
                    if !crate::rules::is_legal_tag_name(&s) {
                        return None;
                    }
                    f.tag = s;
                    tag_seen = true;
                }
            }
            NAME => f.name = text(1, 120, 480)?,
            TARGET_OID => {
                if v.len() != 20 && v.len() != 32 {
                    return None;
                }
                f.target_oid = Some(hex::encode(v));
            }
            FLAGS => {
                let [b] = v else { return None };
                if b & !ALL_FLAGS != 0 {
                    return None;
                }
                flags_seen = true;
                f.prerelease = b & PRERELEASE != 0;
                f.draft = b & DRAFT != 0;
                f.yanked = b & YANKED != 0;
                f.unpublished = b & UNPUBLISHED != 0;
                f.notes_continue = b & NOTES_CONTINUE != 0;
            }
            IMPORTED_CREATED_AT => {
                let t = u64::from_be_bytes(v.try_into().ok()?);
                if t > MAX_SAFE_INT {
                    return None;
                }
                f.imported_created_at = Some(t);
            }
            ASSET_MANIFEST => {
                if v.len() != 32 {
                    return None;
                }
                f.asset_manifest = Some(hex::encode(v));
            }
            _ => return None, // reserved, or a tag that is not a release field
        }
    }
    let provenance_without_url = (f.imported_author.is_some() || f.imported_created_at.is_some())
        && f.imported_url.is_none();
    if !tag_seen
        || !flags_seen
        || (f.notes_continue && f.asset_manifest.is_none())
        || provenance_without_url
    {
        return None;
    }
    Some(f)
}

/// The padded TLV of `f`, or what the writer refuses before sealing (§16.2): `Malformed` for
/// content a reader would refuse or the writer's tighter caps, `TooLarge` past 1507 bytes.
pub fn writer_tlv(f: &ReleaseFields) -> Result<Vec<u8>, PrivateError> {
    let bad = !crate::rules::is_legal_tag_name(&f.tag) // 1..=63 bytes of the grammar
        || f.name.as_deref().is_some_and(|n| !text_ok(n, 1, 120, 480))
        || f.notes.as_deref().is_some_and(|n| !text_ok(n, 1, 5120, 5120))
        || f
            .target_oid
            .as_deref()
            .is_some_and(|o| ![40, 64].contains(&o.len()))
        // the release schema's imported caps, tighter than TLV 13's reader cap
        || f.imported_author.as_deref().is_some_and(|a| !text_ok(a, 1, 64, 256))
        || f.imported_url.as_deref().is_some_and(|u| !text_ok(u, 1, 300, 300))
        || f.imported_created_at.is_some_and(|t| t > MAX_SAFE_INT)
        || f.asset_manifest.as_deref().is_some_and(|m| m.len() != 64)
        || (f.notes_continue && f.asset_manifest.is_none())
        || ((f.imported_author.is_some() || f.imported_created_at.is_some())
            && f.imported_url.is_none());
    if f.tag.is_empty() || bad {
        return Err(PrivateError::Malformed);
    }
    let mut pt = encode(f).ok_or(PrivateError::Malformed)?;
    if pt.len() > MAX_PLAINTEXT {
        return Err(PrivateError::TooLarge("release", MAX_PLAINTEXT));
    }
    pad(&mut pt);
    // a writer never emits what a reader refuses
    if parse(&pt).as_ref() != Some(f) {
        return Err(PrivateError::Malformed);
    }
    Ok(pt)
}

/// A sealed release and the intermediate values the vectors pin.
#[cfg(any(test, feature = "vectors"))]
pub struct Sealed {
    /// The plaintext `tagName` (§16.1).
    pub tag_name: String,
    /// The associated data (§16.2).
    pub ad: Vec<u8>,
    /// The TLV plaintext.
    pub tlv: Vec<u8>,
    /// `enc`.
    pub enc: Vec<u8>,
}

/// Seal `f` for `owner` under `keys` with a fixed nonce: the conformance vectors only.
#[cfg(any(test, feature = "vectors"))]
pub fn seal_with_nonce(
    keys: &EpochKeys,
    owner: &[u8; 32],
    f: &ReleaseFields,
    nonce: [u8; 12],
) -> Result<Sealed, PrivateError> {
    let tlv = writer_tlv(f)?;
    let tag_name = tag_name(keys, &f.tag);
    let ad = ad(keys, owner, &tag_name);
    let ct = Aes256Gcm::new(keys.doc_key().into())
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: &tlv,
                aad: &ad,
            },
        )
        .map_err(|_| PrivateError::Malformed)?;
    let mut enc = vec![0x01];
    enc.extend_from_slice(&nonce);
    enc.extend_from_slice(&ct);
    Ok(Sealed {
        tag_name,
        ad,
        tlv,
        enc,
    })
}

/// The result of [`open`], as `doc::Opened` is for the collab types.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Opened {
    /// The decoded fields.
    Readable(Box<ReleaseFields>),
    /// Well-framed but not readable by this reader.
    Unreadable(Unreadable),
    /// A document no honest writer produces.
    Malformed,
}

/// A stored `release` document, as [`open`] reads it.
#[derive(Debug, Clone)]
pub struct StoredRelease {
    /// `$ownerId`.
    pub owner_id: [u8; 32],
    /// `epoch`.
    pub epoch: Option<u32>,
    /// `tagName`.
    pub tag_name: String,
    /// `vis`.
    pub vis: String,
    /// `delta`.
    pub delta: i64,
    /// `enc`.
    pub enc: Option<Vec<u8>>,
    /// Whether any plaintext content field is present: `name`, `notes`, `assets` and
    /// `assetManifest` (the contract's `noPlain`), or `yanked` and `imported` (a client rule:
    /// never written next to `enc`, §16.2).
    pub plaintext: bool,
}

/// Whether `s` has the shape of a sealed `tagName`: 43 characters of the base64url alphabet.
fn tag_name_shaped(s: &str) -> bool {
    s.len() == 43
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// §16.4: well-formedness, framing, epoch, key, AES-GCM, TLV, the tagName check, and the
/// burned clause of the late-content rule (the only part a release can be judged by).
#[must_use]
pub fn open(ctx: &OpenContext, d: &StoredRelease) -> Opened {
    // step 0, key-independent: a private release is sealed, carries no plaintext content, is
    // stamped private, publishes nothing and has a tagName of the sealed shape
    let (Some(enc), Some(epoch)) = (d.enc.as_deref(), d.epoch) else {
        return Opened::Malformed;
    };
    if d.plaintext || d.vis != "private" || d.delta != 0 || !tag_name_shaped(&d.tag_name) {
        return Opened::Malformed;
    }
    if enc.len() < 29 || enc[0] != 0x01 {
        return Opened::Malformed;
    }
    if !ctx.anchors.contains_key(&epoch) {
        return Opened::Unreadable(Unreadable::NoEpoch);
    }
    let Some(keys) = ctx.keys.get(&epoch) else {
        return Opened::Unreadable(Unreadable::NoKey);
    };
    let ad = ad(keys, &d.owner_id, &d.tag_name);
    let (nonce, ct) = enc[1..].split_at(12);
    let Ok(pt) = Aes256Gcm::new(keys.doc_key().into())
        .decrypt(Nonce::from_slice(nonce), Payload { msg: ct, aad: &ad })
    else {
        return Opened::Unreadable(Unreadable::BadTag);
    };
    let pt = zeroize::Zeroizing::new(pt);
    let Some(f) = parse(&pt) else {
        return Opened::Malformed;
    };
    // the string the document carries, compared as bytes: never decoded (§16.1)
    if !ct_eq(tag_name(keys, &f.tag).as_bytes(), d.tag_name.as_bytes()) {
        return Opened::Malformed;
    }
    // §8.2's burned clause needs no height: nothing is written under a burned epoch except by
    // someone its key leaked to
    if ctx.burned.contains(&epoch) && !ctx.members.contains(&d.owner_id) {
        return Opened::Unreadable(Unreadable::Late);
    }
    Opened::Readable(Box::new(f))
}

/// Canonical JSON (§16.5): keys sorted by code point, no insignificant whitespace, non-ASCII
/// characters not escaped.
#[must_use]
pub fn canonical_json(v: &Value) -> String {
    match v {
        Value::Object(m) => {
            let mut keys: Vec<&String> = m.keys().collect();
            keys.sort();
            let body: Vec<String> = keys
                .into_iter()
                .map(|k| {
                    format!(
                        "{}:{}",
                        serde_json::to_string(k).expect("a string serializes"),
                        canonical_json(&m[k])
                    )
                })
                .collect();
            format!("{{{}}}", body.join(","))
        }
        Value::Array(a) => format!(
            "[{}]",
            a.iter().map(canonical_json).collect::<Vec<_>>().join(",")
        ),
        other => serde_json::to_string(other).expect("a scalar serializes"),
    }
}

/// Seal a kind-4 manifest with a fixed fileId: `(canonical, sealed)`. The vectors only.
#[cfg(any(test, feature = "vectors"))]
pub fn seal_manifest_with_file_id(
    keys: &EpochKeys,
    manifest: &Value,
    file_id: [u8; 16],
) -> Result<(String, Vec<u8>), PrivateError> {
    let canonical = canonical_json(manifest);
    let sealed =
        pack::seal_with_file_id(keys, canonical.as_bytes(), file_id, pack::WRITE_SEG_LOG2)?;
    Ok((canonical, sealed))
}

/// Why a manifest does not belong to the release that names it.
#[derive(Debug, PartialEq, Eq)]
pub enum ManifestError {
    /// The copy's hash, the size cap, the tag, the total or an entry disagree (`manifestMismatch`).
    Mismatch,
    /// The sealed artifact failed §3.5.
    Pack(PrivateError),
}

/// One asset of a kind-4 manifest (§16.5).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManifestAsset {
    /// The file name.
    pub name: String,
    /// The plaintext file's SHA-256 (hex; `""` only on an external link).
    pub sha256: String,
    /// The plaintext file's size.
    pub size_bytes: u64,
    /// Where the sealed object (or, for an external link, the file) is stored.
    pub uris: Vec<String>,
    /// The sealed object's SHA-256; absent on an external link.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sealed_sha256: Option<String>,
    /// The sealed object's size; absent on an external link.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sealed_size_bytes: Option<u64>,
}

/// An opened kind-4 manifest (§16.5).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReleaseManifest {
    /// `1`.
    pub v: u64,
    /// The plaintext tag (TLV 16).
    pub tag: String,
    /// The number of assets.
    pub total: u64,
    /// The import's source release.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    /// The full notes, exactly when the release sets flag `0x10`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    /// The assets.
    pub assets: Vec<ManifestAsset>,
}

fn is_hex64(v: &Value) -> bool {
    v.as_str().is_some_and(|s| {
        s.len() == 64
            && s.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}

/// One asset entry of §16.5: `{name, sha256, sizeBytes, uris}` plus, for a sealed object,
/// `sealedSha256` and `sealedSizeBytes`.
fn entry_ok(e: &Value) -> bool {
    let Some(o) = e.as_object() else {
        return false;
    };
    let keys_ok = o.keys().all(|k| {
        [
            "name",
            "sha256",
            "sizeBytes",
            "uris",
            "sealedSha256",
            "sealedSizeBytes",
        ]
        .contains(&k.as_str())
    });
    let name_ok = e["name"].as_str().is_some_and(|n| !n.is_empty());
    let uris_ok = e["uris"].as_array().is_some_and(|u| {
        (1..=8).contains(&u.len()) && u.iter().all(|x| x.as_str().is_some_and(|x| !x.is_empty()))
    });
    let Some(size) = e["sizeBytes"].as_u64() else {
        return false;
    };
    let sha_ok = is_hex64(&e["sha256"]) || e["sha256"] == "";
    let sealed = match (o.get("sealedSha256"), o.get("sealedSizeBytes")) {
        (None, None) => true,
        // a sealed object: the writer hashed the file it sealed, and the object holds it
        (Some(h), Some(n)) => {
            is_hex64(h)
                && is_hex64(&e["sha256"])
                && n.as_u64()
                    .is_some_and(|n| size.checked_add(52).is_some_and(|min| n >= min))
        }
        _ => false,
    };
    keys_ok && name_ok && uris_ok && sha_ok && sealed
}

/// Open the kind-4 manifest a release names (§16.5): the size cap, the hash, §3.5, then the
/// canonical encoding, the version, tag, total, entries and the notes flag.
pub fn open_manifest<'k>(
    sealed: &[u8],
    size_bytes: u64,
    asset_manifest: &[u8; 32],
    tag: &str,
    notes_continue: bool,
    key_of: impl Fn(u32) -> Option<&'k EpochKeys>,
) -> Result<ReleaseManifest, ManifestError> {
    if size_bytes > MAX_MANIFEST_BYTES || !ct_eq(&sha256(sealed), asset_manifest) {
        return Err(ManifestError::Mismatch);
    }
    let pt = pack::open(sealed, size_bytes, key_of).map_err(ManifestError::Pack)?;
    let m: Value = serde_json::from_slice(&pt).map_err(|_| ManifestError::Mismatch)?;
    // its own canonical re-encoding, byte for byte: whitespace, duplicate keys, escapes and
    // number spellings that two parsers could read differently are all refused
    if canonical_json(&m).as_bytes() != pt.as_slice() {
        return Err(ManifestError::Mismatch);
    }
    let known = m.as_object().is_some_and(|o| {
        o.keys()
            .all(|k| ["v", "tag", "total", "source", "notes", "assets"].contains(&k.as_str()))
    });
    let assets = m["assets"].as_array();
    let ok = known
        && m["v"].as_u64() == Some(1)
        && m["tag"] == tag
        && assets.is_some_and(|a| m["total"].as_u64() == Some(a.len() as u64))
        && assets.is_some_and(|a| a.iter().all(entry_ok))
        && m.get("source")
            .is_none_or(|s| s.as_str().is_some_and(|s| !s.is_empty()))
        && m.get("notes").is_some() == notes_continue
        && m.get("notes").is_none_or(|n| {
            n.as_str()
                .is_some_and(|n| !n.is_empty() && n.len() <= 5120 && n.chars().count() <= 5120)
        });
    if !ok {
        return Err(ManifestError::Mismatch);
    }
    serde_json::from_value(m).map_err(|_| ManifestError::Mismatch)
}

/// One revision as the §16.3 fold sees it, after [`open`].
#[derive(Debug, Clone, Copy)]
pub struct Revision<'a> {
    /// `$id`, compared as its raw bytes (never as base58).
    pub id: &'a [u8],
    /// `$createdAt`.
    pub created_at: u64,
    /// `epoch`.
    pub epoch: u32,
    /// `tagName`.
    pub tag_name: &'a str,
    /// What [`open`] said.
    pub opened: &'a Opened,
    /// `enc` (only equality matters).
    pub enc: &'a [u8],
}

impl Revision<'_> {
    fn key(&self) -> (u64, &[u8]) {
        (self.created_at, self.id)
    }

    fn fields(&self) -> Option<&ReleaseFields> {
        match self.opened {
            Opened::Readable(f) => Some(f),
            _ => None,
        }
    }
}

/// The §16.3 fold, as indexes into the revisions it was given.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Fold {
    /// The release of each live tag (its newest revision), in tag byte order.
    pub live: Vec<usize>,
    /// Every other readable revision that is not a replay, newest first.
    pub history: Vec<usize>,
    /// Live tags whose release is not a draft.
    pub count: usize,
    /// Readable revisions whose `enc` repeats an earlier one's: ignored.
    pub replays: Vec<usize>,
    /// Tags with a newer revision under one of their `(epoch, tagName)` that does not open.
    pub unknown_tags: Vec<String>,
    /// A revision under a key the reader lacks is newer than every readable one.
    pub stale: bool,
    /// Revisions that did not open.
    pub hidden: usize,
}

/// The §16.3 fold: live tags, history, the count, replays, tags whose state is unknown, and
/// whether the list may be stale.
#[must_use]
pub fn fold(revs: &[Revision<'_>]) -> Fold {
    use std::collections::{BTreeMap, BTreeSet};
    let mut by_time: Vec<usize> = (0..revs.len()).collect();
    by_time.sort_by(|&a, &b| revs[a].key().cmp(&revs[b].key()));

    let mut out = Fold::default();
    let mut seen_enc = BTreeSet::new();
    let mut by_tag: BTreeMap<&str, Vec<usize>> = BTreeMap::new();
    for &i in &by_time {
        let Some(f) = revs[i].fields() else {
            out.hidden += 1;
            continue;
        };
        // honest writers never repeat a hedged nonce, so an equal enc is a copy
        if !seen_enc.insert(revs[i].enc) {
            out.replays.push(i);
            continue;
        }
        by_tag.entry(f.tag.as_str()).or_default().push(i);
    }
    for (tag, group) in &by_tag {
        let (&newest, older) = group.split_last().expect("a group has a revision");
        let nf = revs[newest]
            .fields()
            .expect("grouped revisions are readable");
        if nf.unpublished {
            out.history.extend(group);
        } else {
            out.live.push(newest);
            out.count += usize::from(!nf.draft);
            out.history.extend(older);
        }
        // a newer revision that shares an (epoch, tagName) with this tag but does not open
        let names: BTreeSet<(u32, &str)> = group
            .iter()
            .map(|&i| (revs[i].epoch, revs[i].tag_name))
            .collect();
        let shadowed = revs.iter().any(|u| {
            matches!(
                u.opened,
                Opened::Unreadable(Unreadable::BadTag) | Opened::Malformed
            ) && names.contains(&(u.epoch, u.tag_name))
                && u.key() > revs[newest].key()
        });
        if shadowed {
            out.unknown_tags.push((*tag).to_string());
        }
    }
    out.history
        .sort_by(|&a, &b| revs[b].key().cmp(&revs[a].key()));
    let newest_readable = revs
        .iter()
        .filter(|r| r.fields().is_some())
        .map(Revision::key)
        .max();
    out.stale = revs.iter().any(|r| {
        matches!(r.opened, Opened::Unreadable(Unreadable::NoKey))
            && newest_readable.is_none_or(|n| r.key() > n)
    });
    out
}
