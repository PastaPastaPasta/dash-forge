//! Key letters (kind 10, mixed-visibility DESIGN §4.3 "Branch keys for CI and people", §4.9
//! "Key letters", `docs/security/private-repos.md` §20): keys handed to specific people, sealed to
//! them as a DFPK 0x02 artifact ([`named::seal_artifact`]) and stored as a kind-10
//! `packManifest`.
//!
//! The artifact plaintext is a typed JSON object, the same canonical form as an environment
//! snapshot: keys sorted by code point, no whitespace, strings with exactly the escapes `\"`,
//! `\\`, `\b`, `\f`, `\n`, `\r`, `\t` and a lowercase `\u00xx` for every other C0 control (every
//! other character raw UTF-8), integers only (`0 ..= 2^53 − 1`), `true`, `false` and `null`;
//! padded with spaces to a multiple of [`BUCKET`] bytes. A reader takes only those exact bytes
//! ([`TypedLetter::decode`]). Two keys are always there: `type` (which letter) and `v` (its
//! version). Each type is its own struct with `to_typed` and `from_typed`; a reader skips a
//! type or version it does not know.
//!
//! The types: `branch` ([`BranchLetter`], this module: one members-only branch as it is now),
//! `branchKey` (phase 3F: a narrower branch's key generations), `read` and `postKey` (phase 4B).
//!
//! Who may write one: consensus admits a kind-10 manifest from a maintainer or a Write member
//! only; readers take a letter only from a **current** one ([`trusted_sender`]), and only after
//! its bytes hash to the manifest's `packHash` ([`open`]).

use std::fmt::Write as _;

use hmac::{Hmac, Mac};
use serde_json::{Map, Value};
use sha2::Sha256;
use zeroize::Zeroizing;

use super::blind::{self, Salt};
use super::keys::{ct_eq, sha256};
use super::named::{self, ArtifactError, OwnerKey, Reader, Recipient};
use super::PrivateError;
use crate::envelope::PrivateKey;

/// The plaintext is padded with spaces to a multiple of this many bytes.
pub const BUCKET: usize = 512;
/// The largest letter plaintext, padded (a branch letter holds about 450 packs).
pub const MAX_LETTER: usize = 64 * 1024;
/// The largest integer a letter carries (JavaScript's safe integers, so both stacks agree).
pub const MAX_INT: u64 = (1 << 53) - 1;

/// `"type": "branch"`.
pub const TYPE_BRANCH: &str = "branch";
/// The case of the `key_letter__*` conformance vectors (the rules harnesses skip it).
pub const VECTOR_CASE: &str = "key_letter";

#[cfg(test)]
mod conformance;
mod read;

pub use read::{LetterDoc, ReadLetter, ReadTarget, TYPE_READ};

/// A key letter's typed body: `type`, `v` and every other field.
#[derive(Clone, PartialEq)]
pub struct TypedLetter {
    /// `type`: which letter (`branch`, `branchKey`, `read`, `postKey`).
    pub kind: String,
    /// `v`: the type's version.
    pub v: u64,
    /// Every field but `type` and `v`.
    pub fields: Map<String, Value>,
}

/// It carries keys: `Debug` shows the type and the field names only.
impl std::fmt::Debug for TypedLetter {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TypedLetter")
            .field("kind", &self.kind)
            .field("v", &self.v)
            .field("fields", &self.fields.keys().collect::<Vec<_>>())
            .finish()
    }
}

/// Why a letter cannot be written.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum LetterError {
    /// Over [`MAX_LETTER`] bytes once encoded.
    #[error("the letter is {0} bytes once encoded; at most {MAX_LETTER} fit")]
    TooLarge(usize),
    /// A value the canonical form has no spelling for (a float, a negative or too large
    /// integer), or `type`/`v` among the fields.
    #[error("{0}")]
    Invalid(&'static str),
}

/// Append `s` as a JSON string with exactly the canonical escapes.
fn push_str(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

/// Append `v` in the canonical form, or refuse a value it has no spelling for.
fn push_value(out: &mut String, v: &Value) -> Result<(), LetterError> {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => match n.as_u64() {
            Some(i) if i <= MAX_INT => {
                let _ = write!(out, "{i}");
            }
            _ => {
                return Err(LetterError::Invalid(
                    "a letter's numbers are integers from 0 to 2^53 - 1",
                ))
            }
        },
        Value::String(s) => push_str(out, s),
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                push_value(out, item)?;
            }
            out.push(']');
        }
        Value::Object(map) => push_object(out, map.iter())?,
    }
    Ok(())
}

/// Append an object with its keys sorted by code point (the map's own order is not trusted:
/// `serde_json` may preserve insertion order).
fn push_object<'a>(
    out: &mut String,
    entries: impl Iterator<Item = (&'a String, &'a Value)>,
) -> Result<(), LetterError> {
    let mut entries: Vec<(&String, &Value)> = entries.collect();
    entries.sort_by(|a, b| a.0.cmp(b.0));
    out.push('{');
    for (i, (k, v)) in entries.into_iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        push_str(out, k);
        out.push(':');
        push_value(out, v)?;
    }
    out.push('}');
    Ok(())
}

impl TypedLetter {
    /// A letter of `kind`, version `v`, with no fields yet.
    #[must_use]
    pub fn new(kind: &str, v: u64) -> Self {
        Self {
            kind: kind.to_owned(),
            v,
            fields: Map::new(),
        }
    }

    /// The canonical JSON (no padding).
    fn canonical(&self) -> Result<Zeroizing<String>, LetterError> {
        if self.fields.contains_key("type") || self.fields.contains_key("v") {
            return Err(LetterError::Invalid("`type` and `v` are not fields"));
        }
        if self.v > MAX_INT {
            return Err(LetterError::Invalid(
                "a letter's version is at most 2^53 - 1",
            ));
        }
        let kind = Value::String(self.kind.clone());
        let v = Value::from(self.v);
        let (type_key, v_key) = ("type".to_owned(), "v".to_owned());
        let mut out = Zeroizing::new(String::with_capacity(512));
        push_object(
            &mut out,
            self.fields.iter().chain([(&type_key, &kind), (&v_key, &v)]),
        )?;
        Ok(out)
    }

    /// The artifact plaintext: the canonical JSON padded with spaces to a multiple of
    /// [`BUCKET`].
    pub fn encode(&self) -> Result<Zeroizing<Vec<u8>>, LetterError> {
        let raw = self.canonical()?;
        let size = raw.len().div_ceil(BUCKET).max(1) * BUCKET;
        if size > MAX_LETTER {
            return Err(LetterError::TooLarge(raw.len()));
        }
        let mut out = Zeroizing::new(Vec::with_capacity(size));
        out.extend_from_slice(raw.as_bytes());
        out.resize(size, b' ');
        Ok(out)
    }

    /// Read a letter plaintext: a bucket length, spaces as padding, a JSON object with a string
    /// `type` and an integer `v`, and exactly the bytes [`Self::encode`] makes of it. `None` is
    /// malformed.
    #[must_use]
    pub fn decode(pt: &[u8]) -> Option<Self> {
        if pt.is_empty() || pt.len() > MAX_LETTER || !pt.len().is_multiple_of(BUCKET) {
            return None;
        }
        let end = pt.iter().rposition(|b| *b != b' ')? + 1;
        let value: Zeroizing<Vec<u8>> = Zeroizing::new(pt[..end].to_vec());
        let Value::Object(mut fields) = serde_json::from_slice::<Value>(&value).ok()? else {
            return None;
        };
        let kind = match fields.remove("type")? {
            Value::String(s) => s,
            _ => return None,
        };
        let v = fields.remove("v")?.as_u64()?;
        let letter = Self { kind, v, fields };
        let again = letter.encode().ok()?;
        (again.as_slice() == pt).then_some(letter)
    }

    /// Field `name` as a string.
    fn str(&self, name: &str) -> Option<&str> {
        self.fields.get(name)?.as_str()
    }
}

/// Lowercase hex of exactly `n` bytes, or `None`.
fn hex_exact(v: &Value, n: usize) -> Option<Vec<u8>> {
    let s = v.as_str()?;
    if s.len() != 2 * n || s.bytes().any(|c| c.is_ascii_uppercase()) {
        return None;
    }
    hex::decode(s).ok()
}

fn hex32(v: &Value) -> Option<[u8; 32]> {
    hex_exact(v, 32)?.try_into().ok()
}

/// The key that names a members-only commit's check runs: `HMAC-SHA256(salt, "dash-forge/v2/
/// check-name")` of the blind's salt (stream 3D, `private::members_check`): a runner and anyone
/// holding the salt resolve the opaque check names of that commit.
#[must_use]
pub fn check_name_key(salt: &Salt) -> Zeroizing<[u8; 32]> {
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(salt).expect("HMAC takes any key length");
    mac.update(b"dash-forge/v2/check-name");
    Zeroizing::new(mac.finalize().into_bytes().into())
}

/// A members-only branch's head as a letter names it: the blind its ref update carries, the real
/// commit and the blind's salt.
#[derive(Clone, PartialEq, Eq)]
pub struct LetterHead {
    /// The blind (the ref update's plaintext `newOid`).
    pub blind: Vec<u8>,
    /// The real commit.
    pub oid: Vec<u8>,
    /// The blind's salt.
    pub salt: Salt,
}

/// One members-only pack (kind 64) as a letter hands it on: its `packHash` and its file key
/// (`K_pack,e,fileId`, which opens that one DFPK 0x01 file and nothing else).
#[derive(Clone, PartialEq, Eq)]
pub struct LetterPack {
    /// The manifest's `packHash`.
    pub pack_hash: [u8; 32],
    /// The file key.
    pub key: Zeroizing<[u8; 32]>,
}

/// A `branch` letter (version 1, DESIGN §4.3): one members-only branch as it was when shared,
/// for someone outside its audience. The recipient fetches the head with these packs; a later
/// push is under keys they do not hold.
///
/// ```text
/// {"asOf":ms,"checkNameKey":hex32,"head":[blind,oid,salt],"name":"refs/heads/…",
///  "packs":[[packHash,key],…],"refNameHash":hex32,"type":"branch","v":1}
/// ```
///
/// `packs` is sorted by `packHash`, each once, at least one; `head` is a checked blind of a
/// non-null commit; `checkNameKey` is [`check_name_key`] of the head's salt; `refNameHash` is
/// the keyed name hash of the ref update that set the head (how the recipient finds it).
#[derive(Clone, PartialEq, Eq)]
pub struct BranchLetter {
    /// The full ref name (`refs/heads/fix-auth`).
    pub name: String,
    /// The `refNameHash` of the members-only ref update that set the head.
    pub ref_name_hash: [u8; 32],
    /// The head.
    pub head: LetterHead,
    /// The members-only packs covering the head's history beyond the public branches.
    pub packs: Vec<LetterPack>,
    /// `$createdAt` (ms) of the ref update that set the head.
    pub as_of: u64,
}

/// It carries keys: `Debug` shows the pack count only.
impl std::fmt::Debug for BranchLetter {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BranchLetter")
            .field("packs", &self.packs.len())
            .finish_non_exhaustive()
    }
}

/// Whether `name` is a branch name a letter may carry: `refs/heads/` and a non-empty rest, at
/// most 255 bytes, no control character.
fn valid_branch_name(name: &str) -> bool {
    name.len() <= 255
        && name
            .strip_prefix("refs/heads/")
            .is_some_and(|rest| !rest.is_empty())
        && !name.chars().any(char::is_control)
}

impl BranchLetter {
    /// The typed letter: refused (`None`) for a malformed head, an empty or unsorted pack list,
    /// a name that is not a branch, or `asOf` past [`MAX_INT`].
    #[must_use]
    pub fn to_typed(&self) -> Option<TypedLetter> {
        if !self.well_formed() {
            return None;
        }
        let mut t = TypedLetter::new(TYPE_BRANCH, 1);
        let f = &mut t.fields;
        f.insert("asOf".into(), Value::from(self.as_of));
        f.insert(
            "checkNameKey".into(),
            Value::String(hex::encode(*check_name_key(&self.head.salt))),
        );
        f.insert(
            "head".into(),
            Value::Array(vec![
                Value::String(hex::encode(&self.head.blind)),
                Value::String(hex::encode(&self.head.oid)),
                Value::String(hex::encode(self.head.salt)),
            ]),
        );
        f.insert("name".into(), Value::String(self.name.clone()));
        f.insert(
            "packs".into(),
            Value::Array(
                self.packs
                    .iter()
                    .map(|p| {
                        Value::Array(vec![
                            Value::String(hex::encode(p.pack_hash)),
                            Value::String(hex::encode(*p.key)),
                        ])
                    })
                    .collect(),
            ),
        );
        f.insert(
            "refNameHash".into(),
            Value::String(hex::encode(self.ref_name_hash)),
        );
        Some(t)
    }

    /// A `branch` letter of version 1, or `None`: another type or version, an unknown or
    /// missing field, or anything [`Self::to_typed`] refuses (a blind that does not check, a
    /// check-name key that is not the salt's).
    #[must_use]
    pub fn from_typed(t: &TypedLetter) -> Option<Self> {
        const FIELDS: [&str; 6] = [
            "asOf",
            "checkNameKey",
            "head",
            "name",
            "packs",
            "refNameHash",
        ];
        if t.kind != TYPE_BRANCH || t.v != 1 || t.fields.len() != FIELDS.len() {
            return None;
        }
        if !FIELDS.iter().all(|k| t.fields.contains_key(*k)) {
            return None;
        }
        let head = t.fields.get("head")?.as_array()?;
        let [blind_v, oid_v, salt_v] = head.as_slice() else {
            return None;
        };
        let oid = hex_exact(oid_v, oid_v.as_str()?.len() / 2)?;
        let head = LetterHead {
            blind: hex_exact(blind_v, oid.len())?,
            oid,
            salt: hex32(salt_v)?,
        };
        let packs = t
            .fields
            .get("packs")?
            .as_array()?
            .iter()
            .map(|p| match p.as_array()?.as_slice() {
                [hash, key] => Some(LetterPack {
                    pack_hash: hex32(hash)?,
                    key: Zeroizing::new(hex32(key)?),
                }),
                _ => None,
            })
            .collect::<Option<Vec<_>>>()?;
        let letter = Self {
            name: t.str("name")?.to_owned(),
            ref_name_hash: hex32(t.fields.get("refNameHash")?)?,
            head,
            packs,
            as_of: t.fields.get("asOf")?.as_u64()?,
        };
        let key = hex32(t.fields.get("checkNameKey")?)?;
        (letter.well_formed() && ct_eq(&key, &*check_name_key(&letter.head.salt))).then_some(letter)
    }

    fn well_formed(&self) -> bool {
        let head_checks = blind::is_oid_width(self.head.oid.len())
            && !blind::is_null(&self.head.oid)
            && blind::blind(&self.head.salt, &self.head.oid)
                .is_some_and(|b| ct_eq(&b, &self.head.blind));
        let sorted = !self.packs.is_empty()
            && self
                .packs
                .windows(2)
                .all(|w| w[0].pack_hash < w[1].pack_hash);
        head_checks && sorted && valid_branch_name(&self.name) && self.as_of <= MAX_INT
    }
}

/// Seal `letter` for `recipients` (slot order, the sender first, at most 64) in repository
/// `repo_id`, written by `owner_id` (the `packManifest`'s `$ownerId`): a DFPK 0x02 artifact
/// under a fresh `K_obj`, `fileId` and slot IVs.
pub fn seal(
    repo_id: &[u8; 32],
    sender: &PrivateKey,
    sender_key_id: u32,
    owner_id: &[u8; 32],
    recipients: &[Recipient],
    letter: &TypedLetter,
) -> Result<Vec<u8>, PrivateError> {
    let plain = letter.encode().map_err(|_| PrivateError::Malformed)?;
    named::seal_artifact(repo_id, sender, sender_key_id, owner_id, recipients, &plain)
}

/// The manifest fields a reader checks a letter against.
#[derive(Debug, Clone, Copy)]
pub struct ManifestCheck<'a> {
    /// `packHash`.
    pub pack_hash: &'a [u8; 32],
    /// `sizeBytes`.
    pub size_bytes: u64,
}

/// Why a letter does not open.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, thiserror::Error)]
#[serde(rename_all = "camelCase")]
pub enum OpenError {
    /// The bytes do not hash to the manifest's `packHash`.
    #[error("the letter's bytes do not match its record")]
    PackHashMismatch,
    /// The bytes are not as long as the manifest's `sizeBytes`.
    #[error("the letter's length does not match its record")]
    SizeMismatch,
    /// Not a DFPK 0x02 artifact, or a segment failed its tag.
    #[error("the letter is damaged")]
    SealedPackCorrupt,
    /// The sender key is not the owner's, or the plaintext is not a canonical letter.
    #[error("the letter is malformed")]
    Malformed,
    /// No slot opens under the reader's keys.
    #[error("the letter is not addressed to this reader")]
    NotARecipient,
}

/// A letter that opened.
#[derive(Debug, Clone, PartialEq)]
pub struct Opened {
    /// Its typed body.
    pub letter: TypedLetter,
    /// How many people it is addressed to, the sender included (the header's `n`).
    pub recipients: usize,
}

/// Open `sealed` (one copy of a kind-10 artifact) for `manifest`: the bytes must hash to the
/// owner-signed `packHash` before anything is decrypted, then match its size, then open as a
/// DFPK 0x02 artifact with the manifest owner's keys `owner_keys` as `reader`, then decode.
pub fn open(
    repo_id: &[u8; 32],
    manifest: &ManifestCheck<'_>,
    sealed: &[u8],
    owner_keys: &[OwnerKey],
    reader: &Reader<'_>,
) -> Result<Opened, OpenError> {
    if !ct_eq(&sha256(sealed), manifest.pack_hash) {
        return Err(OpenError::PackHashMismatch);
    }
    let plain = named::open_artifact(repo_id, sealed, manifest.size_bytes, owner_keys, reader)
        .map_err(|e| match e {
            ArtifactError::SizeMismatch => OpenError::SizeMismatch,
            ArtifactError::SealedPackCorrupt => OpenError::SealedPackCorrupt,
            ArtifactError::Malformed => OpenError::Malformed,
            ArtifactError::NotARecipient => OpenError::NotARecipient,
        })?;
    let letter = TypedLetter::decode(&plain).ok_or(OpenError::Malformed)?;
    Ok(Opened {
        letter,
        recipients: usize::from(sealed[8]),
    })
}

/// Whether a reader takes a key letter written by someone of `role`: a current maintainer (the
/// owner included) or Write member, as consensus admits a kind-10 manifest from (DESIGN §4.9);
/// a letter from anyone else, or from someone no longer in that role, is ignored.
#[must_use]
pub fn trusted_sender(role: Option<crate::rules::v2::Role>) -> bool {
    matches!(
        role,
        Some(crate::rules::v2::Role::Maintainer | crate::rules::v2::Role::Writer)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn letter() -> BranchLetter {
        let salt = [7u8; 32];
        let oid = vec![0xab; 20];
        BranchLetter {
            name: "refs/heads/fix-auth".into(),
            ref_name_hash: [3; 32],
            head: LetterHead {
                blind: blind::blind(&salt, &oid).unwrap(),
                oid,
                salt,
            },
            packs: vec![
                LetterPack {
                    pack_hash: [1; 32],
                    key: Zeroizing::new([9; 32]),
                },
                LetterPack {
                    pack_hash: [2; 32],
                    key: Zeroizing::new([8; 32]),
                },
            ],
            as_of: 1_767_225_600_000,
        }
    }

    #[test]
    fn a_branch_letter_round_trips_through_the_canonical_bytes() {
        let t = letter().to_typed().unwrap();
        let pt = t.encode().unwrap();
        assert_eq!(pt.len() % BUCKET, 0);
        let back = TypedLetter::decode(&pt).unwrap();
        assert_eq!(back, t);
        assert_eq!(BranchLetter::from_typed(&back).unwrap(), letter());
        let s = String::from_utf8(pt.to_vec()).unwrap();
        assert!(
            s.starts_with("{\"asOf\":1767225600000,\"checkNameKey\":\""),
            "{s}"
        );
        assert!(s.trim_end().ends_with("\"type\":\"branch\",\"v\":1}"));
    }

    #[test]
    fn decode_takes_only_the_canonical_bytes() {
        let pt = letter().to_typed().unwrap().encode().unwrap();
        let raw = String::from_utf8(pt.to_vec()).unwrap();
        let pad = |s: &str| {
            let mut b = s.as_bytes().to_vec();
            b.resize(b.len().div_ceil(BUCKET) * BUCKET, b' ');
            b
        };
        assert!(TypedLetter::decode(&pad(&raw.trim_end().replacen(',', ", ", 1))).is_none());
        assert!(TypedLetter::decode(&raw.as_bytes()[..raw.len() - 1]).is_none());
        assert!(TypedLetter::decode(&pad("{\"v\":1,\"type\":\"x\"}")).is_none());
        assert!(TypedLetter::decode(&pad("{\"type\":\"x\",\"v\":1.0}")).is_none());
        assert!(TypedLetter::decode(&pad("{\"type\":\"x\",\"v\":1}")).is_some());
        assert!(TypedLetter::decode(&pad("[1]")).is_none());
    }

    #[test]
    fn a_letter_past_the_cap_is_refused() {
        let mut t = TypedLetter::new("branch", 1);
        t.fields
            .insert("x".into(), Value::String("a".repeat(MAX_LETTER)));
        assert!(matches!(t.encode(), Err(LetterError::TooLarge(_))));
    }

    #[test]
    fn a_branch_letter_refuses_what_a_writer_never_makes() {
        let mut l = letter();
        l.head.blind[0] ^= 1;
        assert!(l.to_typed().is_none());
        let mut l = letter();
        l.packs.reverse();
        assert!(l.to_typed().is_none());
        let mut l = letter();
        l.name = "refs/tags/v1".into();
        assert!(l.to_typed().is_none());
        let mut t = letter().to_typed().unwrap();
        t.fields
            .insert("checkNameKey".into(), Value::String(hex::encode([0u8; 32])));
        assert!(BranchLetter::from_typed(&t).is_none());
        let mut t = letter().to_typed().unwrap();
        t.fields.insert("extra".into(), Value::Null);
        assert!(BranchLetter::from_typed(&t).is_none());
        let mut t = letter().to_typed().unwrap();
        t.v = 2;
        assert!(BranchLetter::from_typed(&t).is_none());
    }
}
