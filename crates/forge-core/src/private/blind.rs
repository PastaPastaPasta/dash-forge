//! Blinded OIDs (`docs/security/private-repos.md` §19.1, mixed-visibility DESIGN D4, rule C).
//!
//! A members-only ref update, a members-only pull request and its head updates carry their
//! commit ids in plaintext fields the contracts index and fold (`newOid`, `prevOid`, `headOid`, the
//! kind-16 event's `oid`), so those fields hold a **blind** instead: a salted commitment
//!
//! ```text
//! blind(salt, oid) = SHA-256("dash-forge/v2/oid-blind" ‖ 0x00 ‖ salt(32) ‖ oid)[0 .. len(oid)]
//! ```
//!
//! with a fresh 32-byte salt sealed inside the introducing document's `enc` (TLV 27) beside the
//! real value (TLV 22, 23 or 24). Outsiders cannot test a guess without the salt; publishing the
//! salt later lets anyone check what landed. **Rule C**: a blind is computed once, by the document
//! that introduces the commit; every later field naming that commit (the PR's head, its head
//! updates, reviews, inline comments, check runs, a merge into a members-only base) copies those
//! bytes, so every fold compares one byte string per commit, whatever the epoch.
//!
//! A null OID is never blinded: an all-zero `newOid` (a delete) stays all-zero, an absent
//! `prevOid` (a create) stays absent, so that a members-only branch was created or deleted is
//! public (DESIGN §2.3).
//!
//! Readers check every blind against its real value ([`check`]): a mismatch, or a blind whose
//! width is not the real OID's (`oidWidth` checks each field alone, so consensus admits it), keeps
//! the document and raises an [`Alert`], so members and the public never fold different documents.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::keys::{ct_eq, rnd32, sha256};
use super::PrivateError;

const DOMAIN: &[u8] = b"dash-forge/v2/oid-blind\0";

/// The salt of one introducing document's blinds (TLV 27).
pub type Salt = [u8; 32];

/// A fresh salt from the OS CSPRNG.
pub fn fresh_salt() -> Result<Salt, PrivateError> {
    rnd32()
}

/// Whether `oid` is a git OID width (SHA-1 or SHA-256).
#[must_use]
pub fn is_oid_width(len: usize) -> bool {
    len == 20 || len == 32
}

/// Whether `oid` is the null OID: empty, or all zero bytes.
#[must_use]
pub fn is_null(oid: &[u8]) -> bool {
    oid.iter().all(|&b| b == 0)
}

/// The blind of the real `oid` (20 or 32 bytes) under `salt`. `None` for any other width.
#[must_use]
pub fn blind(salt: &Salt, oid: &[u8]) -> Option<Vec<u8>> {
    if !is_oid_width(oid.len()) {
        return None;
    }
    let mut msg = Vec::with_capacity(DOMAIN.len() + 32 + oid.len());
    msg.extend_from_slice(DOMAIN);
    msg.extend_from_slice(salt);
    msg.extend_from_slice(oid);
    Some(sha256(&msg)[..oid.len()].to_vec())
}

/// The plaintext a writer puts in an OID field for the real `oid`: the null OID as it is, else
/// its blind under `salt`.
#[must_use]
pub fn plaintext_of(salt: &Salt, oid: &[u8]) -> Option<Vec<u8>> {
    if is_null(oid) {
        Some(oid.to_vec())
    } else {
        blind(salt, oid)
    }
}

/// How one plaintext OID field reads against the real value and salt sealed beside it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Check {
    /// The blind of the real value under the salt.
    Ok,
    /// A null OID with no real value: nothing is blinded.
    Null,
    /// The plaintext is not the blind of the real value: alert, keep the document.
    Mismatch,
    /// The plaintext's width is not the real value's: alert, keep the document.
    Width,
    /// A blind without its real value or salt, or a real value for a null OID: no honest writer
    /// produces it.
    Malformed,
}

/// Judge the plaintext OID `plain` against the `real` value and `salt` sealed beside it.
#[must_use]
pub fn check(plain: &[u8], real: Option<&[u8]>, salt: Option<&Salt>) -> Check {
    if is_null(plain) {
        return if real.is_none() {
            Check::Null
        } else {
            Check::Malformed
        };
    }
    let (Some(real), Some(salt)) = (real, salt) else {
        return Check::Malformed;
    };
    if real.len() != plain.len() {
        return Check::Width;
    }
    match blind(salt, real) {
        Some(b) if ct_eq(&b, plain) => Check::Ok,
        Some(_) => Check::Mismatch,
        None => Check::Malformed,
    }
}

/// Which plaintext field an [`Alert`] is about.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OidField {
    /// A ref update's `newOid`.
    NewOid,
    /// A ref update's `prevOid`.
    PrevOid,
    /// A PR's `headOid`, or a head update's `oid`.
    HeadOid,
}

/// The kind of a blind a reader could not confirm.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AlertKind {
    /// Not the blind of its real value.
    Mismatch,
    /// Not the real value's width.
    Width,
}

/// A blind that does not match the real value sealed beside it. The document is kept: members
/// fold a ref update on its real values and a PR on its blinds as written, like the public, and
/// show the alert (a writer that lies about a blind lies to the public, not to members).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Alert {
    /// The field.
    pub field: OidField,
    /// What is wrong with it.
    pub kind: AlertKind,
}

impl Alert {
    /// The alert [`check`]'s result raises, if any.
    #[must_use]
    pub fn of(field: OidField, c: Check) -> Option<Self> {
        let kind = match c {
            Check::Mismatch => AlertKind::Mismatch,
            Check::Width => AlertKind::Width,
            Check::Ok | Check::Null | Check::Malformed => return None,
        };
        Some(Self { field, kind })
    }
}

/// What the plaintext head of a members-only PR (`headOid`) or head update (`oid`) reads as, given
/// the real head and salt its `enc` carries (TLV 24, 27).
#[derive(Clone, PartialEq, Eq)]
pub enum Head {
    /// Nothing sealed: the plaintext is the commit itself (a PR from a public branch).
    Plain,
    /// The verified real head and the salt of its blind.
    Real {
        /// The real commit.
        real: Vec<u8>,
        /// The salt.
        salt: Salt,
    },
    /// A blind that does not check: everyone folds the plaintext as written, and no real value is
    /// trusted for it.
    Alert(Alert),
}

impl std::fmt::Debug for Head {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Plain => f.write_str("Plain"),
            Self::Real { .. } => f.write_str("Real(..)"),
            Self::Alert(a) => f.debug_tuple("Alert").field(a).finish(),
        }
    }
}

/// Judge a plaintext head against the real head and salt opened beside it. `None` is malformed
/// (a real value for a null head).
#[must_use]
pub fn head_of(plain: &[u8], real: Option<&[u8]>, salt: Option<&Salt>) -> Option<Head> {
    let Some(r) = real else {
        return Some(Head::Plain);
    };
    let c = check(plain, Some(r), salt);
    match (c, salt) {
        (Check::Ok, Some(s)) => Some(Head::Real {
            real: r.to_vec(),
            salt: *s,
        }),
        (Check::Mismatch | Check::Width, _) => Alert::of(OidField::HeadOid, c).map(Head::Alert),
        _ => None,
    }
}

/// A members reader's map from a blind (lowercase hex, as the folds compare OIDs) to the real
/// commit it hides. Only verified pairs go in: a blind whose check failed has no trusted real
/// value, and the fold keeps folding the blind as written.
///
/// Members never put a real value into a folded field (`PatchView.head`, the review and check-run
/// lookups): every write path that copies the folded head (a review's `commitOid`, a check run's
/// `headOid`, `pr_sync`'s head update) must copy the blind. The real value is for git: diff,
/// fetch, checkout, merge and display.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BlindMap {
    real: BTreeMap<String, String>,
}

impl BlindMap {
    /// An empty map.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Learn the pair (`plain`, `real`) when `plain` checks as the blind of `real` under `salt`;
    /// otherwise return the alert it raises (`None` when nothing was blinded).
    pub fn learn(
        &mut self,
        field: OidField,
        plain: &[u8],
        real: Option<&[u8]>,
        salt: Option<&Salt>,
    ) -> Option<Alert> {
        let c = check(plain, real, salt);
        if c == Check::Ok {
            if let Some(r) = real {
                self.real.insert(hex::encode(plain), hex::encode(r));
            }
        }
        Alert::of(field, c)
    }

    /// The real commit (hex) behind the blind `plain_hex`, if a verified document named it.
    #[must_use]
    pub fn real_of(&self, plain_hex: &str) -> Option<&str> {
        self.real
            .get(&plain_hex.to_ascii_lowercase())
            .map(String::as_str)
    }

    /// The real commit behind `oid_hex`, or `oid_hex` itself when it is no known blind (a plain
    /// OID of a public source).
    #[must_use]
    pub fn real_or_plain<'a>(&'a self, oid_hex: &'a str) -> &'a str {
        self.real_of(oid_hex).unwrap_or(oid_hex)
    }

    /// How many blinds are known.
    #[must_use]
    pub fn len(&self) -> usize {
        self.real.len()
    }

    /// Whether no blind is known.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.real.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn widths_follow_the_real_oid_and_nulls_stay_plain() {
        let s = [7; 32];
        assert_eq!(blind(&s, &[1; 20]).unwrap().len(), 20);
        assert_eq!(blind(&s, &[1; 32]).unwrap().len(), 32);
        assert!(blind(&s, &[1; 21]).is_none());
        assert_eq!(plaintext_of(&s, &[0; 20]).unwrap(), vec![0; 20]);
        assert_ne!(plaintext_of(&s, &[1; 20]).unwrap(), vec![1; 20]);
        // another salt, another blind: two documents never link one commit
        assert_ne!(blind(&s, &[1; 20]), blind(&[8; 32], &[1; 20]));
    }

    #[test]
    fn the_check_and_the_map() {
        let s = [7; 32];
        let real = [1u8; 20];
        let b = blind(&s, &real).unwrap();
        assert_eq!(check(&b, Some(&real), Some(&s)), Check::Ok);
        assert_eq!(check(&b, Some(&[2; 20]), Some(&s)), Check::Mismatch);
        assert_eq!(check(&b, Some(&[1; 32]), Some(&s)), Check::Width);
        assert_eq!(check(&b, None, Some(&s)), Check::Malformed);
        assert_eq!(check(&[0; 20], None, None), Check::Null);
        assert_eq!(check(&[0; 20], Some(&real), Some(&s)), Check::Malformed);
        let mut m = BlindMap::new();
        assert_eq!(m.learn(OidField::HeadOid, &b, Some(&real), Some(&s)), None);
        assert_eq!(
            m.real_of(&hex::encode(&b)),
            Some(hex::encode(real).as_str())
        );
        let bad = blind(&[9; 32], &real).unwrap();
        assert_eq!(
            m.learn(OidField::HeadOid, &bad, Some(&real), Some(&s)),
            Some(Alert {
                field: OidField::HeadOid,
                kind: AlertKind::Mismatch
            })
        );
        assert_eq!(m.real_of(&hex::encode(&bad)), None, "never trusted");
        assert_eq!(m.real_or_plain("ab"), "ab");
    }
}
