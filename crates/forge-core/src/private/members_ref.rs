//! Members-only ref updates of a public repository (`docs/security/private-repos.md` §19.2,
//! mixed-visibility DESIGN §4.3).
//!
//! A members-only branch is written as an ordinary `refUpdate` / `protectedRefUpdate` with
//! `refName` absent, `refNameHash = HMAC(K_ref,e, name)` under the members key's epoch, `vis:
//! "public"`, and `newOid` / `prevOid` holding blinds ([`super::blind`]) under a fresh salt of this
//! document; the name, the real OIDs and the salt are sealed in `enc` v0x03 (TLV 3, 22, 23, 27).
//! Null OIDs stay plain: a create has no `prevOid`, a delete an all-zero `newOid`. `prevOid` is
//! blinded under the update's **own** salt, never copied from the update that introduced the
//! commit, so the public cannot chain a members-only branch's updates (only its name hash, which
//! groups them within an epoch, and `force` stay visible).
//!
//! Readers open the update ([`super::open_content`]: commitment, AES-GCM, TLV, the name hash
//! check, the late rule) and then take its real values ([`real_values`]): each blind is checked
//! against the value sealed beside it, a mismatch keeps the update and raises an
//! [`super::blind::Alert`], and members fold the real values over the union of public and
//! members-only updates of one name (`crate::refs::members_updates_of`). The public never folds
//! a sealed update (`git_plane_well_formed`).

use std::collections::BTreeMap;

use super::blind::{self, Alert, Check, OidField, Salt};
use super::doc::{self, DocHeader, OpenContext, Opened, Unreadable};
use super::keys::EpochKeys;
use super::{DocKind, Fields, PrivateError};
use crate::platform::FieldValue;
use crate::rules::v2::Visibility;

/// One members-only ref update to seal.
#[derive(Debug, Clone, Copy)]
pub struct RefUpdateIn<'a> {
    /// `refUpdate` or `protectedRefUpdate`.
    pub kind: DocKind,
    /// The full ref name (`refs/heads/sec/fix`).
    pub name: &'a str,
    /// The real new tip; all zero for a delete.
    pub new_oid: &'a [u8],
    /// The real previous tip; `None` for a create.
    pub prev_oid: Option<&'a [u8]>,
    /// A forced update.
    pub force: bool,
}

/// A sealed members-only ref update: the plaintext fields its document carries.
#[derive(Clone, PartialEq, Eq)]
pub struct SealedRefUpdate {
    /// `refUpdate` or `protectedRefUpdate`.
    pub kind: DocKind,
    /// `HMAC(K_ref,e, name)`.
    pub ref_name_hash: [u8; 32],
    /// The blind of the new tip (or the null OID of a delete).
    pub new_oid: Vec<u8>,
    /// The blind of the previous tip, absent for a create.
    pub prev_oid: Option<Vec<u8>>,
    /// `force`.
    pub force: bool,
    /// The members key's epoch it is sealed under.
    pub epoch: u32,
    /// `enc` v0x03.
    pub enc: Vec<u8>,
    /// The salt of its blinds, which rule C copies into the PR head and head updates that name
    /// the same commit (a members-only write path holds it; it is never published by itself).
    pub salt: Salt,
}

impl std::fmt::Debug for SealedRefUpdate {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SealedRefUpdate")
            .field("kind", &self.kind)
            .field("epoch", &self.epoch)
            .field("force", &self.force)
            .field("enc_len", &self.enc.len())
            .finish_non_exhaustive()
    }
}

impl SealedRefUpdate {
    /// The document's properties this module decides (`refNameHash`, `newOid`, `prevOid`,
    /// `force`, `epoch`, `enc`, `vis`); the caller adds `repoId` and whatever else its type
    /// carries.
    #[must_use]
    pub fn props(&self) -> BTreeMap<String, FieldValue> {
        let mut p = BTreeMap::new();
        p.insert(
            "refNameHash".into(),
            FieldValue::bytes32(self.ref_name_hash),
        );
        p.insert("newOid".into(), FieldValue::bytes(self.new_oid.clone()));
        if let Some(prev) = &self.prev_oid {
            p.insert("prevOid".into(), FieldValue::bytes(prev.clone()));
        }
        p.insert("force".into(), FieldValue::Bool(self.force));
        p.insert("epoch".into(), FieldValue::integer(u64::from(self.epoch)));
        p.insert("enc".into(), FieldValue::bytes(self.enc.clone()));
        p.insert("vis".into(), FieldValue::text(Visibility::Public.as_str()));
        p
    }
}

/// The header and TLV fields of `input` under `keys` with `salt`: refused (`Malformed`) for a
/// kind that is not a ref update, an OID that is not 20 or 32 bytes, a `prevOid` of another width
/// than `newOid`, and an update that names no commit at all (a null create).
fn header_and_fields(
    keys: &EpochKeys,
    owner: [u8; 32],
    input: &RefUpdateIn<'_>,
    salt: &Salt,
) -> Result<(DocHeader, Fields), PrivateError> {
    let RefUpdateIn {
        kind,
        name,
        new_oid,
        prev_oid,
        force,
    } = *input;
    if !matches!(kind, DocKind::RefUpdate | DocKind::ProtectedRefUpdate)
        || !blind::is_oid_width(new_oid.len())
        || prev_oid.is_some_and(|p| p.len() != new_oid.len())
        || (blind::is_null(new_oid) && prev_oid.is_none_or(blind::is_null))
    {
        return Err(PrivateError::Malformed);
    }
    let real = |o: &[u8]| (!blind::is_null(o)).then(|| o.to_vec());
    let fields = Fields {
        ref_name: Some(name.to_owned()),
        new_oid: real(new_oid),
        prev_oid: prev_oid.and_then(real),
        oid_salt: Some(*salt),
        ..Fields::default()
    };
    let mut header = DocHeader::new(kind, owner, keys.epoch());
    header.vis = Visibility::Public;
    header.ref_name_hash = Some(keys.ref_name_hash(name));
    header.new_oid = Some(blind::plaintext_of(salt, new_oid).ok_or(PrivateError::Malformed)?);
    header.prev_oid = match prev_oid {
        Some(p) => Some(blind::plaintext_of(salt, p).ok_or(PrivateError::Malformed)?),
        None => None,
    };
    header.force = Some(force);
    Ok((header, fields))
}

fn sealed(header: DocHeader, salt: Salt, enc: Vec<u8>) -> SealedRefUpdate {
    SealedRefUpdate {
        kind: header.kind,
        ref_name_hash: header.ref_name_hash.expect("set by header_and_fields"),
        new_oid: header.new_oid.expect("set by header_and_fields"),
        prev_oid: header.prev_oid,
        force: header.force.unwrap_or(false),
        epoch: header.epoch,
        enc,
        salt,
    }
}

/// Seal a members-only ref update under the members key's write epoch `keys`, with a fresh salt
/// and a hedged nonce.
pub fn seal(
    keys: &EpochKeys,
    owner: [u8; 32],
    input: &RefUpdateIn<'_>,
) -> Result<SealedRefUpdate, PrivateError> {
    let salt = blind::fresh_salt()?;
    let (header, fields) = header_and_fields(keys, owner, input, &salt)?;
    let enc = doc::seal_members(keys, &header, &fields)?;
    Ok(sealed(header, salt, enc))
}

/// [`seal`] with a caller-chosen salt and nonce: the conformance vectors only.
#[cfg(any(test, feature = "vectors"))]
pub fn seal_with(
    keys: &EpochKeys,
    owner: [u8; 32],
    input: &RefUpdateIn<'_>,
    salt: Salt,
    nonce: [u8; 12],
) -> Result<SealedRefUpdate, PrivateError> {
    let (header, fields) = header_and_fields(keys, owner, input, &salt)?;
    let enc = doc::seal_members_with_nonce(keys, &header, &fields, nonce)?;
    Ok(sealed(header, salt, enc))
}

/// A members-only ref update as members fold it: its real values.
#[derive(Clone, PartialEq, Eq)]
pub struct RealRefUpdate {
    /// The full ref name, from TLV 3.
    pub name: String,
    /// The real new tip (all zero for a delete).
    pub new_oid: Vec<u8>,
    /// The real previous tip, absent for a create.
    pub prev_oid: Option<Vec<u8>>,
    /// Blinds that did not check against their real values (the update is kept).
    pub alerts: Vec<Alert>,
}

impl std::fmt::Debug for RealRefUpdate {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RealRefUpdate")
            .field("alerts", &self.alerts)
            .finish_non_exhaustive()
    }
}

/// The real values of a members-only (`enc` v0x03) ref update whose plaintext is `header` and
/// whose opened content is `fields`. `None` (malformed) when a non-null plaintext OID has no real
/// value or salt beside it, or a null one carries a real value; a blind that does not check is
/// kept with an alert.
#[must_use]
pub fn real_values(header: &DocHeader, fields: &Fields) -> Option<RealRefUpdate> {
    let name = fields.ref_name.clone()?;
    let salt = fields.oid_salt.as_ref();
    let mut alerts = Vec::new();
    let mut judge = |field, plain: &[u8], real: Option<&Vec<u8>>| -> Option<Vec<u8>> {
        let c = blind::check(plain, real.map(Vec::as_slice), salt);
        if c == Check::Malformed {
            return None;
        }
        alerts.extend(Alert::of(field, c));
        Some(real.cloned().unwrap_or_else(|| plain.to_vec()))
    };
    let new_oid = judge(
        OidField::NewOid,
        header.new_oid.as_deref()?,
        fields.new_oid.as_ref(),
    )?;
    let prev_oid = match header.prev_oid.as_deref() {
        Some(p) => Some(judge(OidField::PrevOid, p, fields.prev_oid.as_ref())?),
        None if fields.prev_oid.is_some() => return None,
        None => None,
    };
    // one repository, one object format: a writer never mixes widths; and an update names a
    // commit (a create that is also a delete is no writer's)
    if let (Some(n), Some(p)) = (&fields.new_oid, &fields.prev_oid) {
        if n.len() != p.len() {
            return None;
        }
    }
    if blind::is_null(&new_oid) && prev_oid.as_deref().is_none_or(blind::is_null) {
        return None;
    }
    Some(RealRefUpdate {
        name,
        new_oid,
        prev_oid,
        alerts,
    })
}

/// Every `sourceRefNameHash` / `baseRefNameHash` a pull request naming `name` may carry for a
/// reader holding `held` epochs: the public `sha256(name)` and `HMAC(K_ref,e, name)` per held
/// epoch, so `pr_sync` and the PR lookups find a members-only PR by its branch under whatever
/// epoch it was opened (a PR keeps its epoch, `private-repos.md` §4.5).
#[must_use]
pub fn name_hashes<'k>(name: &str, held: impl IntoIterator<Item = &'k EpochKeys>) -> Vec<[u8; 32]> {
    let mut out = vec![super::keys::sha256(name.as_bytes())];
    out.extend(held.into_iter().map(|k| k.ref_name_hash(name)));
    out.sort_unstable();
    out.dedup();
    out
}

/// How a reader sees one members-only ref update.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RefOpened {
    /// Its real values.
    Readable(RealRefUpdate),
    /// Well-framed, not readable here.
    Unreadable(Unreadable),
    /// No honest writer produces it.
    Malformed,
}

impl RefOpened {
    /// A ref update `open_content` gave `opened`, taken to its real values.
    #[must_use]
    pub fn from_opened(header: &DocHeader, opened: Opened) -> Self {
        match opened {
            Opened::Readable(f) => real_values(header, &f).map_or(Self::Malformed, Self::Readable),
            Opened::Unreadable(u) => Self::Unreadable(u),
            Opened::Malformed => Self::Malformed,
        }
    }
}

/// Open a members-only ref update (`enc` v0x03) and take its real values.
#[must_use]
pub fn open(ctx: &OpenContext, header: &DocHeader, enc: &[u8]) -> RefOpened {
    RefOpened::from_opened(header, doc::open_content(ctx, header, enc))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::private::doc::AnchorRef;
    use crate::private::EpochKey;

    fn keys() -> EpochKeys {
        EpochKeys::derive(&[0x11; 32], 0, &EpochKey::from_bytes([3; 32]))
    }

    fn ctx() -> OpenContext {
        OpenContext {
            keys: [(0, keys())].into(),
            anchors: [(
                0,
                AnchorRef {
                    id: [9; 32],
                    height: 1,
                    stated_height: 1,
                },
            )]
            .into(),
            ..OpenContext::default()
        }
    }

    fn header_of(s: &SealedRefUpdate) -> DocHeader {
        let mut h = DocHeader::new(s.kind, [0x22; 32], s.epoch);
        h.vis = Visibility::Public;
        h.ref_name_hash = Some(s.ref_name_hash);
        h.new_oid = Some(s.new_oid.clone());
        h.prev_oid.clone_from(&s.prev_oid);
        h.force = Some(s.force);
        h.created_at_block_height = Some(5);
        h
    }

    #[test]
    fn a_sealed_update_opens_to_its_real_values_and_hides_them() {
        let input = RefUpdateIn {
            kind: DocKind::RefUpdate,
            name: "refs/heads/sec/fix",
            new_oid: &[2; 20],
            prev_oid: Some(&[1; 20]),
            force: false,
        };
        let s = seal(&keys(), [0x22; 32], &input).unwrap();
        assert_ne!(s.new_oid, vec![2; 20]);
        assert_ne!(s.prev_oid.as_deref(), Some(&[1u8; 20][..]));
        // two seals of the same update share no blind
        let again = seal(&keys(), [0x22; 32], &input).unwrap();
        assert_ne!(s.new_oid, again.new_oid);
        let RefOpened::Readable(r) = open(&ctx(), &header_of(&s), &s.enc) else {
            panic!("opens");
        };
        assert_eq!(
            (r.name.as_str(), r.new_oid, r.prev_oid, r.alerts.len()),
            ("refs/heads/sec/fix", vec![2; 20], Some(vec![1; 20]), 0)
        );
        // a delete keeps its null newOid plain
        let del = seal(
            &keys(),
            [0x22; 32],
            &RefUpdateIn {
                new_oid: &[0; 20],
                ..input
            },
        )
        .unwrap();
        assert_eq!(del.new_oid, vec![0; 20]);
        assert!(
            matches!(open(&ctx(), &header_of(&del), &del.enc), RefOpened::Readable(r) if r.new_oid == vec![0; 20])
        );
    }

    #[test]
    fn a_branch_is_found_under_every_held_epoch() {
        let k1 = EpochKeys::derive(&[0x11; 32], 1, &EpochKey::from_bytes([4; 32]));
        let hashes = name_hashes("refs/heads/x", [&keys(), &k1]);
        assert_eq!(hashes.len(), 3);
        assert!(hashes.contains(&keys().ref_name_hash("refs/heads/x")));
        assert!(hashes.contains(&super::super::keys::sha256(b"refs/heads/x")));
    }

    #[test]
    fn a_writer_refuses_what_no_reader_takes() {
        let bad = |new: &[u8], prev: Option<&[u8]>, kind| {
            seal(
                &keys(),
                [0x22; 32],
                &RefUpdateIn {
                    kind,
                    name: "refs/heads/x",
                    new_oid: new,
                    prev_oid: prev,
                    force: false,
                },
            )
            .unwrap_err()
        };
        assert_eq!(
            bad(&[1; 20], Some(&[1; 32]), DocKind::RefUpdate),
            PrivateError::Malformed
        );
        assert_eq!(
            bad(&[0; 20], None, DocKind::RefUpdate),
            PrivateError::Malformed
        );
        assert_eq!(
            bad(&[1; 21], None, DocKind::RefUpdate),
            PrivateError::Malformed
        );
        assert_eq!(bad(&[1; 20], None, DocKind::Patch), PrivateError::Malformed);
    }
}
