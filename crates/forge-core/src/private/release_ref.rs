//! Test-only reference of sealed releases (`docs/security/private-repos.md` §16): the
//! `private_release_seal` / `private_release_open` vectors are reproduced here byte for byte from
//! the existing primitives (the epoch's HKDF-SHA256 PRK, HMAC-SHA256, AES-256-GCM under
//! `K_doc,e` with the §4.4 AD, and the §3 sealed-artifact format). It is not the client
//! implementation: nothing outside the conformance test calls it, and production `seal` APIs
//! still refuse releases on private repositories until the CLI and the web implement §16.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine as _;
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::Sha256;

use super::doc::{OpenContext, Unreadable};
use super::keys::{ct_eq, sha256, EpochKeys};
use super::{pack, PrivateError};

/// forge-core `$defs.enc.maxItems` minus the v0x01 framing (§4.1).
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
    /// TLV 2.
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
    /// TLV 19 bit 0x10.
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
    /// TLV 21 (hex).
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
}

/// `K_tag,e = HKDF-Expand(PRK_e, "dash-forge/v2/tag" ‖ 0x00 ‖ u32(e), 32)` (§16.1).
pub fn tag_key(keys: &EpochKeys) -> [u8; 32] {
    let [prk, ..] = keys.raw_subkeys_for_vectors();
    let mut info = b"dash-forge/v2/tag\0".to_vec();
    info.extend_from_slice(&keys.epoch().to_be_bytes());
    let mut okm = [0u8; 32];
    Hkdf::<Sha256>::from_prk(&prk)
        .expect("32-byte PRK")
        .expand(&info, &mut okm)
        .expect("32-byte OKM");
    okm
}

fn hmac32(key: &[u8], msg: &[u8]) -> [u8; 32] {
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(key).expect("any key length");
    mac.update(msg);
    mac.finalize().into_bytes().into()
}

/// `HMAC-SHA256(K_tag,e, tag)`.
pub fn tag_hash(keys: &EpochKeys, tag: &str) -> [u8; 32] {
    hmac32(&tag_key(keys), tag.as_bytes())
}

/// The plaintext `tagName`: unpadded base64url of [`tag_hash`], 43 characters.
pub fn tag_name(keys: &EpochKeys, tag: &str) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(tag_hash(keys, tag))
}

/// The §4.4 AD with `docType = "release"` and `bind = tagName` (its ASCII bytes).
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

/// The TLV of `f`, ascending (§16.2).
pub fn encode(f: &ReleaseFields) -> Vec<u8> {
    let mut out = Vec::new();
    let hex_ = |h: &str| hex::decode(h).expect("hex");
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
        rec(&mut out, TARGET_OID, &hex_(o));
    }
    if f.flags() != 0 {
        rec(&mut out, FLAGS, &[f.flags()]);
    }
    if let Some(t) = f.imported_created_at {
        rec(&mut out, IMPORTED_CREATED_AT, &t.to_be_bytes());
    }
    if let Some(m) = &f.asset_manifest {
        rec(&mut out, ASSET_MANIFEST, &hex_(m));
    }
    out
}

fn text_ok(s: &str, min: usize, chars: usize, bytes: usize) -> bool {
    s.len() >= min && s.len() <= bytes && s.chars().count() <= chars
}

/// Parse a release TLV with §4.3's strictness and §16.2's table. `None` is `Malformed`.
pub fn parse(pt: &[u8]) -> Option<ReleaseFields> {
    let mut f = ReleaseFields::default();
    let mut tag_seen = false;
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
                if *b == 0 || b & !ALL_FLAGS != 0 {
                    return None;
                }
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
    if !tag_seen || (f.notes_continue && f.asset_manifest.is_none()) {
        return None;
    }
    Some(f)
}

/// What the writer refuses before sealing (§16.2): `Malformed` or `TooLarge`.
pub fn writer_check(f: &ReleaseFields) -> Result<Vec<u8>, PrivateError> {
    let bad = !crate::rules::is_legal_tag_name(&f.tag) // 1..=63 bytes of the grammar
        || f.name.as_deref().is_some_and(|n| !text_ok(n, 1, 120, 480))
        || f.notes.as_deref().is_some_and(|n| !text_ok(n, 1, 5120, 5120))
        || f
            .target_oid
            .as_deref()
            .is_some_and(|o| ![20, 32].contains(&(o.len() / 2)))
        // the release schema's imported caps, tighter than TLV 13's reader cap
        || f.imported_author.as_deref().is_some_and(|a| !text_ok(a, 1, 64, 256))
        || f.imported_url.as_deref().is_some_and(|u| !text_ok(u, 1, 300, 300))
        || f.imported_created_at.is_some_and(|t| t > MAX_SAFE_INT)
        || f.asset_manifest.as_deref().is_some_and(|m| m.len() != 64)
        || (f.notes_continue && f.asset_manifest.is_none());
    if f.tag.is_empty() || bad {
        return Err(PrivateError::Malformed);
    }
    let pt = encode(f);
    if pt.len() > MAX_PLAINTEXT {
        return Err(PrivateError::TooLarge("release", MAX_PLAINTEXT));
    }
    // a writer never emits what a reader refuses
    if parse(&pt).as_ref() != Some(f) {
        return Err(PrivateError::Malformed);
    }
    Ok(pt)
}

/// A sealed release and the intermediate values the vectors pin.
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

/// Seal `f` for `owner` under `keys` with a fixed nonce.
pub fn seal_with_nonce(
    keys: &EpochKeys,
    owner: &[u8; 32],
    f: &ReleaseFields,
    nonce: [u8; 12],
) -> Result<Sealed, PrivateError> {
    let tlv = writer_check(f)?;
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
    Readable(ReleaseFields),
    /// Well-framed but not readable by this reader.
    Unreadable(Unreadable),
    /// A document no honest writer produces.
    Malformed,
}

/// A stored release document as the vectors give it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StoredRelease {
    /// `$ownerId` (hex).
    pub owner_id: String,
    /// `epoch`.
    pub epoch: u32,
    /// `tagName`.
    pub tag_name: String,
    /// `vis`.
    pub vis: String,
    /// `delta`.
    pub delta: i64,
    /// `enc` (hex).
    pub enc: String,
    /// A plaintext `yanked` next to `enc` (never written; Malformed).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub yanked: Option<bool>,
    /// A plaintext `imported` next to `enc` (never written; Malformed).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub imported: Option<Value>,
}

/// §16.4: well-formedness, framing, epoch, key, AES-GCM, TLV, the tagName check; no late rule.
pub fn open(ctx: &OpenContext, d: &StoredRelease) -> Opened {
    let owner: [u8; 32] = match hex::decode(&d.owner_id)
        .ok()
        .and_then(|b| b.try_into().ok())
    {
        Some(o) => o,
        None => return Opened::Malformed,
    };
    let Ok(enc) = hex::decode(&d.enc) else {
        return Opened::Malformed;
    };
    // key-independent: a sealed release carries no plaintext content (the contract's noPlain,
    // plus `yanked` and `imported` by client rule), is stamped private and publishes nothing
    if d.yanked.is_some() || d.imported.is_some() || d.vis != "private" || d.delta != 0 {
        return Opened::Malformed;
    }
    if enc.len() < 29 || enc[0] != 0x01 {
        return Opened::Malformed;
    }
    if !ctx.anchors.contains_key(&d.epoch) {
        return Opened::Unreadable(Unreadable::NoEpoch);
    }
    let Some(keys) = ctx.keys.get(&d.epoch) else {
        return Opened::Unreadable(Unreadable::NoKey);
    };
    let ad = ad(keys, &owner, &d.tag_name);
    let (nonce, ct) = enc[1..].split_at(12);
    let Ok(pt) = Aes256Gcm::new(keys.doc_key().into())
        .decrypt(Nonce::from_slice(nonce), Payload { msg: ct, aad: &ad })
    else {
        return Opened::Unreadable(Unreadable::BadTag);
    };
    let Some(f) = parse(&pt) else {
        return Opened::Malformed;
    };
    // the string the document carries, compared as bytes: never decoded (§16.1)
    if !ct_eq(tag_name(keys, &f.tag).as_bytes(), d.tag_name.as_bytes()) {
        return Opened::Malformed;
    }
    Opened::Readable(f)
}

/// [`open`] as the vectors' `expected`.
pub fn open_json(ctx: &OpenContext, d: &StoredRelease) -> Value {
    match open(ctx, d) {
        Opened::Readable(f) => serde_json::json!({ "status": "readable", "fields": f }),
        Opened::Unreadable(r) => serde_json::json!({ "status": "unreadable", "reason": r }),
        Opened::Malformed => serde_json::json!({ "status": "malformed" }),
    }
}

/// Canonical JSON (§16.5): keys sorted by code point, no insignificant whitespace.
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
                        serde_json::to_string(k).expect("key"),
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
        other => serde_json::to_string(other).expect("scalar"),
    }
}

/// Seal a kind-4 manifest with a fixed fileId: `(canonical, sealed)`.
pub fn seal_manifest(
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
    /// The copy's hash, the tag or the total disagree with the release.
    Mismatch,
    /// The sealed artifact failed §3.5.
    Pack(PrivateError),
}

/// Open the kind-4 manifest a release names (§16.5): hash first, then §3.5, then the JSON's
/// version, tag and total.
pub fn open_manifest<'k>(
    sealed: &[u8],
    size_bytes: u64,
    asset_manifest: &[u8; 32],
    tag: &str,
    key_of: impl Fn(u32) -> Option<&'k EpochKeys>,
) -> Result<Value, ManifestError> {
    if !ct_eq(&sha256(sealed), asset_manifest) {
        return Err(ManifestError::Mismatch);
    }
    let pt = pack::open(sealed, size_bytes, key_of).map_err(ManifestError::Pack)?;
    let m: Value = serde_json::from_slice(&pt).map_err(|_| ManifestError::Mismatch)?;
    let total = m["assets"].as_array().map(Vec::len);
    let ok = m["v"] == 1
        && m["tag"] == tag
        && total.is_some()
        && m["total"].as_u64() == total.map(|t| t as u64);
    if !ok {
        return Err(ManifestError::Mismatch);
    }
    Ok(m)
}
