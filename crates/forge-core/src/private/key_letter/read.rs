//! The `read` key letter (version 1, mixed-visibility DESIGN §4.9 "Key letters",
//! `docs/security/private-repos.md` §22.3): one pull request, issue or branch as it was when a
//! member asked a bot to work on it, for that one job.
//!
//! ```text
//! {"asOf":ms,"checkNameKey":hex32|null,"docs":[[id,revision,kObj],…],"heads":[[blind,oid,salt],…],
//!  "job":hex32,"packs":[[packHash,key],…],"target":{"pr":n}|{"issue":n}|{"branch":hex32},
//!  "type":"read","v":1}
//! ```
//!
//! - `job` is the request's `event` id (kind 27): a letter counts for that request only.
//! - `docs` are the members-only documents of the thread the asker opened when asking (the
//!   thread itself, its comments and reviews, the request event), each at the revision it had
//!   then, with its per-object key `K_obj` (`private::doc::read_obj_key`): a key opens that one
//!   revision and nothing else, so an edit or a comment written later is not covered. Sorted by
//!   (id, revision), each once.
//! - `packs` are members-only packs (kind 64, kind 70) with their file keys, sorted by
//!   `packHash`, each once (none when the thread has no members-only code or long text).
//! - `heads` are the members-only commits the letter covers (a PR's head as its blind, real
//!   commit and salt); `checkNameKey` is the check-name key of the first head's salt, or null
//!   with no head.
//! - `asOf` is when the letter was written (ms).

use serde_json::{Map, Value};
use zeroize::Zeroizing;

use super::{check_name_key, hex32, hex_exact, LetterHead, LetterPack, TypedLetter, MAX_INT};
use crate::private::blind;
use crate::private::keys::ct_eq;

/// `"type": "read"`.
pub const TYPE_READ: &str = "read";

/// What a `read` letter covers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReadTarget {
    /// A pull request, by number.
    Pr(u32),
    /// An issue, by number.
    Issue(u32),
    /// A members-only branch, by the `refNameHash` of its ref updates.
    Branch([u8; 32]),
}

impl ReadTarget {
    fn to_value(self) -> Value {
        let mut m = Map::new();
        match self {
            Self::Pr(n) => m.insert("pr".into(), Value::from(n)),
            Self::Issue(n) => m.insert("issue".into(), Value::from(n)),
            Self::Branch(h) => m.insert("branch".into(), Value::String(hex::encode(h))),
        };
        Value::Object(m)
    }

    fn from_value(v: &Value) -> Option<Self> {
        let m = v.as_object()?;
        let (k, v) = m.iter().next().filter(|_| m.len() == 1)?;
        let number = || {
            v.as_u64()
                .and_then(|n| u32::try_from(n).ok())
                .filter(|n| *n >= 1)
        };
        match k.as_str() {
            "pr" => Some(Self::Pr(number()?)),
            "issue" => Some(Self::Issue(number()?)),
            "branch" => Some(Self::Branch(hex32(v)?)),
            _ => None,
        }
    }
}

/// One members-only document revision a `read` letter opens.
#[derive(Clone, PartialEq, Eq)]
pub struct LetterDoc {
    /// The document `$id` (32 bytes).
    pub id: [u8; 32],
    /// Its `$revision` when the letter was written.
    pub revision: u64,
    /// That revision's per-object key `K_obj`.
    pub key: Zeroizing<[u8; 32]>,
}

/// A `read` letter (version 1): see the module documentation.
#[derive(Clone, PartialEq, Eq)]
pub struct ReadLetter {
    /// The request event's id.
    pub job: [u8; 32],
    /// When the letter was written (ms).
    pub as_of: u64,
    /// What it covers.
    pub target: ReadTarget,
    /// The document revisions it opens, sorted by (id, revision), each once.
    pub docs: Vec<LetterDoc>,
    /// The members-only packs it opens, sorted by `packHash`, each once.
    pub packs: Vec<LetterPack>,
    /// The members-only commits it covers, the head first.
    pub heads: Vec<LetterHead>,
}

/// It carries keys: `Debug` shows counts only.
impl std::fmt::Debug for ReadLetter {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ReadLetter")
            .field("target", &self.target)
            .field("docs", &self.docs.len())
            .field("packs", &self.packs.len())
            .field("heads", &self.heads.len())
            .finish_non_exhaustive()
    }
}

/// The fields of a `read` letter v 1, sorted.
const FIELDS: [&str; 7] = [
    "asOf",
    "checkNameKey",
    "docs",
    "heads",
    "job",
    "packs",
    "target",
];

fn head_value(h: &LetterHead) -> Value {
    Value::Array(vec![
        Value::String(hex::encode(&h.blind)),
        Value::String(hex::encode(&h.oid)),
        Value::String(hex::encode(h.salt)),
    ])
}

fn head_of(v: &Value) -> Option<LetterHead> {
    let [blind_v, oid_v, salt_v] = v.as_array()?.as_slice() else {
        return None;
    };
    let oid = hex_exact(oid_v, oid_v.as_str()?.len() / 2)?;
    Some(LetterHead {
        blind: hex_exact(blind_v, oid.len())?,
        oid,
        salt: hex32(salt_v)?,
    })
}

fn head_checks(h: &LetterHead) -> bool {
    blind::is_oid_width(h.oid.len())
        && !blind::is_null(&h.oid)
        && blind::blind(&h.salt, &h.oid).is_some_and(|b| ct_eq(&b, &h.blind))
}

impl ReadLetter {
    /// The check-name key of the first head's salt, if there is a head.
    #[must_use]
    pub fn check_name_key(&self) -> Option<Zeroizing<[u8; 32]>> {
        self.heads.first().map(|h| check_name_key(&h.salt))
    }

    /// The key of document revision (`id`, `revision`), if the letter opens it.
    #[must_use]
    pub fn doc_key(&self, id: &[u8; 32], revision: u64) -> Option<&[u8; 32]> {
        self.docs
            .binary_search_by(|d| (&d.id, d.revision).cmp(&(id, revision)))
            .ok()
            .map(|i| &*self.docs[i].key)
    }

    /// The typed letter, or `None` for what a writer never makes: unsorted or repeated docs or
    /// packs, a revision 0, a head whose blind does not check, `asOf` past [`MAX_INT`].
    #[must_use]
    pub fn to_typed(&self) -> Option<TypedLetter> {
        if !self.well_formed() {
            return None;
        }
        let mut t = TypedLetter::new(TYPE_READ, 1);
        let f = &mut t.fields;
        f.insert("asOf".into(), Value::from(self.as_of));
        f.insert(
            "checkNameKey".into(),
            self.check_name_key()
                .map_or(Value::Null, |k| Value::String(hex::encode(*k))),
        );
        f.insert(
            "docs".into(),
            Value::Array(
                self.docs
                    .iter()
                    .map(|d| {
                        Value::Array(vec![
                            Value::String(hex::encode(d.id)),
                            Value::from(d.revision),
                            Value::String(hex::encode(*d.key)),
                        ])
                    })
                    .collect(),
            ),
        );
        f.insert(
            "heads".into(),
            Value::Array(self.heads.iter().map(head_value).collect()),
        );
        f.insert("job".into(), Value::String(hex::encode(self.job)));
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
        f.insert("target".into(), self.target.to_value());
        Some(t)
    }

    /// A `read` letter of version 1, or `None`: another type or version, an unknown or missing
    /// field, or anything [`Self::to_typed`] refuses (a `checkNameKey` that is not the first
    /// head's, a target with another key or a number 0).
    #[must_use]
    pub fn from_typed(t: &TypedLetter) -> Option<Self> {
        if t.kind != TYPE_READ || t.v != 1 || t.fields.len() != FIELDS.len() {
            return None;
        }
        if !FIELDS.iter().all(|k| t.fields.contains_key(*k)) {
            return None;
        }
        let docs = t
            .fields
            .get("docs")?
            .as_array()?
            .iter()
            .map(|d| match d.as_array()?.as_slice() {
                [id, revision, key] => Some(LetterDoc {
                    id: hex32(id)?,
                    revision: revision.as_u64()?,
                    key: Zeroizing::new(hex32(key)?),
                }),
                _ => None,
            })
            .collect::<Option<Vec<_>>>()?;
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
        let heads = t
            .fields
            .get("heads")?
            .as_array()?
            .iter()
            .map(head_of)
            .collect::<Option<Vec<_>>>()?;
        let letter = Self {
            job: hex32(t.fields.get("job")?)?,
            as_of: t.fields.get("asOf")?.as_u64()?,
            target: ReadTarget::from_value(t.fields.get("target")?)?,
            docs,
            packs,
            heads,
        };
        let key_ok = match (t.fields.get("checkNameKey")?, letter.check_name_key()) {
            (Value::Null, None) => true,
            (v, Some(k)) => hex32(v).is_some_and(|got| ct_eq(&got, &*k)),
            _ => false,
        };
        (key_ok && letter.well_formed()).then_some(letter)
    }

    fn well_formed(&self) -> bool {
        let docs = self.docs.iter().all(|d| d.revision >= 1 && d.revision <= MAX_INT)
            && self
                .docs
                .windows(2)
                .all(|w| (&w[0].id, w[0].revision) < (&w[1].id, w[1].revision));
        let packs = self
            .packs
            .windows(2)
            .all(|w| w[0].pack_hash < w[1].pack_hash);
        let target = match self.target {
            ReadTarget::Pr(n) | ReadTarget::Issue(n) => n >= 1,
            ReadTarget::Branch(_) => true,
        };
        docs && packs && target && self.heads.iter().all(head_checks) && self.as_of <= MAX_INT
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn letter() -> ReadLetter {
        let salt = [7u8; 32];
        let oid = vec![0xab; 20];
        ReadLetter {
            job: [5; 32],
            as_of: 1_767_225_600_000,
            target: ReadTarget::Pr(42),
            docs: vec![
                LetterDoc {
                    id: [1; 32],
                    revision: 1,
                    key: Zeroizing::new([9; 32]),
                },
                LetterDoc {
                    id: [1; 32],
                    revision: 2,
                    key: Zeroizing::new([8; 32]),
                },
                LetterDoc {
                    id: [2; 32],
                    revision: 1,
                    key: Zeroizing::new([7; 32]),
                },
            ],
            packs: vec![LetterPack {
                pack_hash: [3; 32],
                key: Zeroizing::new([6; 32]),
            }],
            heads: vec![LetterHead {
                blind: blind::blind(&salt, &oid).unwrap(),
                oid,
                salt,
            }],
        }
    }

    #[test]
    fn a_read_letter_round_trips() {
        let t = letter().to_typed().unwrap();
        let back = TypedLetter::decode(&t.encode().unwrap()).unwrap();
        assert_eq!(ReadLetter::from_typed(&back).unwrap(), letter());
        assert_eq!(letter().doc_key(&[1; 32], 2), Some(&[8; 32]));
        assert_eq!(letter().doc_key(&[1; 32], 3), None);
    }

    #[test]
    fn a_read_letter_without_code_has_no_check_name_key() {
        let mut l = letter();
        l.heads.clear();
        l.packs.clear();
        l.target = ReadTarget::Issue(7);
        let t = l.to_typed().unwrap();
        assert_eq!(t.fields["checkNameKey"], Value::Null);
        assert_eq!(ReadLetter::from_typed(&t).unwrap(), l);
    }

    #[test]
    fn a_read_letter_refuses_what_a_writer_never_makes() {
        let mut l = letter();
        l.docs.swap(0, 1);
        assert!(l.to_typed().is_none());
        let mut l = letter();
        l.docs[0].revision = 0;
        assert!(l.to_typed().is_none());
        let mut l = letter();
        l.target = ReadTarget::Pr(0);
        assert!(l.to_typed().is_none());
        let mut l = letter();
        l.heads[0].blind[0] ^= 1;
        assert!(l.to_typed().is_none());
        let mut t = letter().to_typed().unwrap();
        t.fields
            .insert("checkNameKey".into(), Value::String(hex::encode([0u8; 32])));
        assert!(ReadLetter::from_typed(&t).is_none());
        let mut t = letter().to_typed().unwrap();
        t.fields.insert("checkNameKey".into(), Value::Null);
        assert!(ReadLetter::from_typed(&t).is_none());
        let mut t = letter().to_typed().unwrap();
        let mut two = Map::new();
        two.insert("pr".into(), Value::from(1));
        two.insert("issue".into(), Value::from(1));
        t.fields.insert("target".into(), Value::Object(two));
        assert!(ReadLetter::from_typed(&t).is_none());
    }
}
