//! Sealed collaboration documents (`docs/security/private-repos.md` §4, §8): an `issue`,
//! `patch`, `comment` or `review` of a private repository carries its free text inside `enc`
//! instead of in plaintext properties.
//!
//! Both directions are pure over the property maps the public writer produces and a fetched
//! document carries, so the CLI and the web app's private writes (web PR #67) seal
//! byte-for-byte alike (conformance case `private_collab_seal`):
//!
//! * [`seal_props`] moves every present sealed field (issue `title`/`body`; patch `title`,
//!   `body`, `baseRefName`, `sourceRefName`; comment `body`/`path`; review `body`; and on any
//!   of them an importer's `imported.author` / `imported.url`) into the TLV, re-keys a patch's
//!   ref-name hashes to `HMAC(K_ref,e, name)` (§4.5), and adds `epoch` and `enc`. Everything
//!   else is copied unchanged (`imported.createdAt` stays, alone in its object).
//! * [`open_doc`] is the inverse for a reader: the decrypted fields are put back where the
//!   public codecs read them, so every fold and view downstream is unchanged.

use std::collections::BTreeMap;

use crate::error::{Error, Result};
use crate::platform::{FetchedDocument, FieldValue};
use crate::private::doc::DocHeader;
use crate::private::{DocKind, EpochKeys, Fields, Opened, PrivateError};

/// The per-type limit on the sealed text, in UTF-8 bytes: the `enc` cap (5120) minus the v0x01
/// framing (29) minus 3 bytes per TLV record the type carries (§4.3 combined sizes).
#[must_use]
pub fn text_cap(kind: DocKind) -> usize {
    kind.max_enc() - crate::private::doc::MIN_V1 - 3 * records_of(kind)
}

/// [`text_cap`] of a members-only document of a public repository (`enc` v0x03, whose framing
/// is 32 bytes longer; its padding is dropped when it does not fit).
#[must_use]
pub fn members_text_cap(kind: DocKind) -> usize {
    kind.max_enc() - crate::private::doc::MIN_V3 - 3 * records_of(kind)
}

fn records_of(kind: DocKind) -> usize {
    match kind {
        DocKind::Issue | DocKind::Comment => 2,
        DocKind::Patch => 4,
        _ => 1,
    }
}

fn take_text(props: &mut BTreeMap<String, FieldValue>, name: &str) -> Option<String> {
    match props.remove(name) {
        Some(FieldValue::Text(s)) => Some(s),
        _ => None,
    }
}

/// Take `imported.author` and `imported.url` out of the `imported` object (its `createdAt`
/// stays plaintext). A top-level `upstreamNumber` (the source forge's number, D-2) and the
/// `tk` target-kind tag are not touched: both are indexed (the sparse `upstream` index, the
/// `transition` agreement), and an indexed property cannot be sealed. They say no more than
/// the plaintext `number` beside them.
fn take_imported(props: &mut BTreeMap<String, FieldValue>, fields: &mut Fields) {
    if let Some(FieldValue::Object(m)) = props.get_mut("imported") {
        let mut take = |name: &str| match m.remove(name) {
            Some(FieldValue::Text(s)) => Some(s),
            _ => None,
        };
        fields.imported_author = take("author");
        fields.imported_url = take("url");
    }
}

fn id32(props: &BTreeMap<String, FieldValue>, name: &str) -> Option<[u8; 32]> {
    props
        .get(name)
        .and_then(FieldValue::as_bytes)
        .and_then(|b| <[u8; 32]>::try_from(b).ok())
}

/// Seal the properties of a new (or re-sealed) `kind` document owned by `owner`, under `keys`
/// (the epoch the document is written under), with a hedged random nonce (§3.6).
pub fn seal_props(
    keys: &EpochKeys,
    kind: DocKind,
    owner: [u8; 32],
    props: BTreeMap<String, FieldValue>,
) -> Result<BTreeMap<String, FieldValue>> {
    seal_props_inner(
        epoch_hashing(keys),
        kind,
        owner,
        props,
        &Members::default(),
        |h, f| crate::private::doc::seal(keys, h, f),
    )
}

/// An epoch's number and its ref-name hash (`HMAC(K_ref,e, name)`, §4.5), for
/// [`seal_props_inner`].
fn epoch_hashing(keys: &EpochKeys) -> (u32, impl Fn(&str) -> [u8; 32] + '_) {
    (keys.epoch(), move |n: &str| keys.ref_name_hash(n))
}

/// [`seal_props`] for a **letter** (`enc` v0x04, DESIGN §4.2): the same transform, sealed by
/// [`crate::private::named::seal`] from `sender` (its ENCRYPTION key, id `sender_key_id`) to
/// `recipients` (slot order, the sender first) in the repository `repo_id`, under `epoch = 0`
/// (D20); `group` is the role group the recipients are, when one was chosen (tag 29). A letter's
/// PR names its branches by their public `sha256`.
#[allow(clippy::too_many_arguments)]
pub fn seal_letter_props(
    repo_id: &[u8; 32],
    sender: &crate::envelope::PrivateKey,
    sender_key_id: u32,
    recipients: &[crate::private::named::Recipient],
    group: Option<crate::private::tlv::LetterGroup>,
    kind: DocKind,
    owner: [u8; 32],
    props: BTreeMap<String, FieldValue>,
) -> Result<BTreeMap<String, FieldValue>> {
    let public_hash = |n: &str| crate::private::keys::sha256(n.as_bytes());
    let letter = Members {
        sealed: true,
        ..Members::default()
    };
    seal_props_inner((0, public_hash), kind, owner, props, &letter, |h, f| {
        crate::private::named::seal(repo_id, sender, sender_key_id, h, f, recipients, group)
    })
    .map_err(|e| match e {
        Error::User(u) if u.message.contains(TOO_LARGE_MARK) => {
            letter_too_large(kind, recipients.len())
        }
        other => other,
    })
}

/// A letter whose text does not fit beside its recipients' slots.
fn letter_too_large(kind: DocKind, n: usize) -> Error {
    crate::user_error::UserError::new(
        crate::user_error::codes::USAGE,
        format!(
            "this {} is too long to send to {} {TOO_LARGE_MARK}",
            kind.type_name(),
            crate::rules::letters::people(n)
        ),
    )
    .cause("each person a message goes to takes room from its text (about 100 bytes each)")
    .fix("shorten it, or send it to fewer people")
    .note("nothing was written")
    .into()
}

/// [`seal_props`] for a **members-only** document of a public repository
/// (`docs/security/private-repos.md` §17): the same transform, sealed in `enc` v0x03 (a
/// per-object key under the members key's epoch `keys`, its commitment, the padding) by
/// [`crate::private::doc::seal_members`]. A pull request or a head update goes through
/// [`seal_members_patch_props`] / [`seal_members_head_update_props`], which say how it names its
/// branches and head.
pub fn seal_members_props(
    lane: &crate::private::Lane,
    kind: DocKind,
    owner: [u8; 32],
    props: BTreeMap<String, FieldValue>,
) -> Result<BTreeMap<String, FieldValue>> {
    let members = Members {
        sealed: true,
        ..Members::default()
    };
    seal_props_inner(
        epoch_hashing(lane.write_keys()),
        kind,
        owner,
        props,
        &members,
        |h, f| lane.seal_doc(h, f),
    )
}

/// The blind a members-only PR's `headOid`, or a head update's `oid`, carries (rule C,
/// `private-repos.md` §19): the caller copies the plaintext from the document that introduced
/// the commit (the source branch's ref update), and seals its real value and that document's salt
/// beside it (TLV 24, 27).
#[derive(Clone, PartialEq, Eq)]
pub struct HeadBlind {
    /// The real head commit.
    pub real: Vec<u8>,
    /// The salt of the document that introduced its blind.
    pub salt: crate::private::blind::Salt,
}

impl std::fmt::Debug for HeadBlind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HeadBlind").finish_non_exhaustive()
    }
}

/// How a members-only pull request names its branches and its head (mixed-visibility DESIGN §4.4):
/// a **public** base or source is named by its public `sha256` (the public can then find the base
/// a merge landed on), a members-only one by its keyed hash; a members-only source's head is a
/// blind ([`HeadBlind`]), a public source's the plain commit.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MembersPatch {
    /// The base branch is public.
    pub base_public: bool,
    /// The source branch is public (then `head` is `None`).
    pub source_public: bool,
    /// The blinded head of a members-only source.
    pub head: Option<HeadBlind>,
}

/// What a sealing call adds to the public writer's transform.
#[derive(Debug, Clone, Default)]
struct Members {
    /// Sealed for members or specific people (a seal error reads as such).
    sealed: bool,
    /// A members-only pull request: how it names its branches and its head.
    patch: Option<MembersPatch>,
    /// The real head behind a head update's `oid`.
    head: Option<HeadBlind>,
}

/// [`seal_members_props`] for a members-only **pull request** (`patch`): its text and branch names
/// in `enc` v0x03, `baseRefNameHash` / `sourceRefNameHash` by [`MembersPatch`], and, for a
/// members-only source, the copied blind `headOid` with the real head and its salt sealed beside
/// it. Refused, before anything is signed, when `headOid` is not the blind of `patch.head`.
pub fn seal_members_patch_props(
    lane: &crate::private::Lane,
    owner: [u8; 32],
    props: BTreeMap<String, FieldValue>,
    patch: &MembersPatch,
) -> Result<BTreeMap<String, FieldValue>> {
    seal_props_inner(
        epoch_hashing(lane.write_keys()),
        DocKind::Patch,
        owner,
        props,
        &Members::patch(patch),
        |h, f| lane.seal_doc(h, f),
    )
}

/// [`seal_members_props`] for the **head update** (`event` kind 16) of a members-only pull request
/// whose source is members-only: `oid` is the blind copied from the ref update that moved the
/// branch, and the real head and that update's salt are sealed in `enc` (TLV 24, 27) under the
/// current epoch, with no value. Refused when `oid` is not the blind of `head`.
pub fn seal_members_head_update_props(
    lane: &crate::private::Lane,
    owner: [u8; 32],
    props: BTreeMap<String, FieldValue>,
    head: &HeadBlind,
) -> Result<BTreeMap<String, FieldValue>> {
    let members = Members {
        sealed: true,
        head: Some(head.clone()),
        ..Members::default()
    };
    seal_props_inner(
        epoch_hashing(lane.write_keys()),
        DocKind::Event,
        owner,
        props,
        &members,
        |h, f| lane.seal_doc(h, f),
    )
}

/// [`seal_members_patch_props`] (a `patch`) / [`seal_members_head_update_props`] (an `event`,
/// whose head is `patch.head`) under the epoch keys `keys` with a caller-chosen nonce: the
/// conformance vectors only.
#[cfg(any(test, feature = "vectors"))]
pub fn seal_members_props_with_nonce(
    keys: &EpochKeys,
    kind: DocKind,
    owner: [u8; 32],
    props: BTreeMap<String, FieldValue>,
    patch: &MembersPatch,
    nonce: [u8; 12],
) -> Result<BTreeMap<String, FieldValue>> {
    seal_props_inner(
        epoch_hashing(keys),
        kind,
        owner,
        props,
        &if kind == DocKind::Event {
            Members {
                sealed: true,
                patch: None,
                head: patch.head.clone(),
            }
        } else {
            Members::patch(patch)
        },
        |h, f| {
            let mut h = h.clone();
            h.vis = crate::rules::v2::Visibility::Public;
            crate::private::doc::seal_members_with_nonce(keys, &h, f, nonce)
        },
    )
}

impl Members {
    fn patch(p: &MembersPatch) -> Self {
        Self {
            sealed: true,
            patch: Some(p.clone()),
            head: None,
        }
    }
}

/// Seal `head`'s real value and salt into `fields` after checking that `plain` (the document's
/// plaintext `headOid` / `oid`) is its blind: a writer never writes what readers alert on.
fn seal_head(
    head: Option<&HeadBlind>,
    plain: Option<&[u8]>,
    fields: &mut Fields,
) -> std::result::Result<(), PrivateError> {
    let Some(h) = head else {
        return Ok(());
    };
    let plain = plain.ok_or(PrivateError::Malformed)?;
    if crate::private::blind::check(plain, Some(&h.real), Some(&h.salt))
        != crate::private::blind::Check::Ok
    {
        return Err(PrivateError::Malformed);
    }
    fields.head_oid = Some(h.real.clone());
    fields.oid_salt = Some(h.salt);
    Ok(())
}

/// [`reseal_edit`] for a members-only issue or comment of a public repository: the whole
/// content re-sealed in `enc` v0x03 ([`seal_members_props`]); only `enc` / `epoch` change.
pub fn reseal_members_edit(
    lane: &crate::private::Lane,
    kind: DocKind,
    owner: [u8; 32],
    opened: &FetchedDocument,
    changes: &BTreeMap<String, Option<String>>,
) -> Result<BTreeMap<String, Option<FieldValue>>> {
    let props = edited_props(opened, changes);
    let sealed = seal_members_props(lane, kind, owner, props)?;
    Ok(enc_and_epoch(&sealed))
}

/// The `enc` / `epoch` a replace of a private issue, PR or comment sets (the web's
/// `sealEdit`): `opened` is the stored document as [`open_doc`] gave it (its content in
/// place), `changes` the text fields the edit sets (`None` clears one). The whole content is
/// re-sealed under `keys` through [`seal_props`], the transform the `private_collab_seal`
/// vectors pin, so every field the edit does not name (the other text, a comment's `path`,
/// an importer's author and URL) is carried over. A replace never carries plaintext content.
pub fn reseal_edit(
    keys: &EpochKeys,
    kind: DocKind,
    owner: [u8; 32],
    opened: &FetchedDocument,
    changes: &BTreeMap<String, Option<String>>,
) -> Result<BTreeMap<String, Option<FieldValue>>> {
    let props = edited_props(opened, changes);
    let sealed = seal_props(keys, kind, owner, props)?;
    Ok(enc_and_epoch(&sealed))
}

/// [`reseal_edit`] with a caller-chosen nonce: the conformance vectors only.
#[cfg(any(test, feature = "vectors"))]
pub fn reseal_edit_with_nonce(
    keys: &EpochKeys,
    kind: DocKind,
    owner: [u8; 32],
    opened: &FetchedDocument,
    changes: &BTreeMap<String, Option<String>>,
    nonce: [u8; 12],
) -> Result<BTreeMap<String, Option<FieldValue>>> {
    let props = edited_props(opened, changes);
    let sealed = seal_props_with_nonce(keys, kind, owner, props, nonce)?;
    Ok(enc_and_epoch(&sealed))
}

/// The opened document's properties with `changes` applied, ready to seal again.
fn edited_props(
    opened: &FetchedDocument,
    changes: &BTreeMap<String, Option<String>>,
) -> BTreeMap<String, FieldValue> {
    let mut props = opened.fields.clone();
    for k in ["enc", "epoch"] {
        props.remove(k);
    }
    for (k, v) in changes {
        match v.as_deref().filter(|v| !v.is_empty()) {
            Some(v) => props.insert(k.clone(), FieldValue::text(v)),
            None => props.remove(k),
        };
    }
    props
}

/// A private replace's changes: `enc` and `epoch` of `sealed`, nothing else.
fn enc_and_epoch(sealed: &BTreeMap<String, FieldValue>) -> BTreeMap<String, Option<FieldValue>> {
    ["enc", "epoch"]
        .into_iter()
        .map(|k| (k.to_string(), sealed.get(k).cloned()))
        .collect()
}

/// [`seal_props`] with a caller-chosen nonce: the conformance vectors only.
#[cfg(any(test, feature = "vectors"))]
pub fn seal_props_with_nonce(
    keys: &EpochKeys,
    kind: DocKind,
    owner: [u8; 32],
    props: BTreeMap<String, FieldValue>,
    nonce: [u8; 12],
) -> Result<BTreeMap<String, FieldValue>> {
    seal_props_inner(
        epoch_hashing(keys),
        kind,
        owner,
        props,
        &Members::default(),
        |h, f| crate::private::doc::seal_with_nonce(keys, h, f, false, nonce),
    )
}

fn seal_props_inner(
    (epoch, ref_name_hash): (u32, impl Fn(&str) -> [u8; 32]),
    kind: DocKind,
    owner: [u8; 32],
    mut props: BTreeMap<String, FieldValue>,
    extra: &Members,
    seal: impl FnOnce(&DocHeader, &Fields) -> std::result::Result<Vec<u8>, PrivateError>,
) -> Result<BTreeMap<String, FieldValue>> {
    let members = extra.sealed;
    let public_hash = |n: &str| crate::private::keys::sha256(n.as_bytes());
    let mut header = DocHeader::new(kind, owner, epoch);
    let mut fields = Fields::default();
    match kind {
        DocKind::Issue | DocKind::Patch => {
            header.number = props
                .get("number")
                .and_then(FieldValue::as_u64)
                .and_then(|n| u32::try_from(n).ok());
            fields.title = take_text(&mut props, "title");
            fields.body = take_text(&mut props, "body");
            if kind == DocKind::Patch {
                fields.base_ref_name = take_text(&mut props, "baseRefName");
                fields.source_ref_name = take_text(&mut props, "sourceRefName");
                let hash = |name: &Option<String>, public: bool| {
                    name.as_deref().map(|n| {
                        if public {
                            public_hash(n)
                        } else {
                            ref_name_hash(n)
                        }
                    })
                };
                let patch = extra.patch.as_ref();
                let (base_public, source_public) =
                    patch.map_or((false, false), |p| (p.base_public, p.source_public));
                let head = patch.and_then(|p| p.head.as_ref());
                header.base_ref_name_hash = hash(&fields.base_ref_name, base_public);
                header.source_ref_name_hash = hash(&fields.source_ref_name, source_public);
                // a public source has a plain head; a members-only one never does
                if patch.is_some() && source_public == head.is_some() {
                    return Err(sealing_error(kind, members, PrivateError::Malformed));
                }
                let plain = props.get("headOid").and_then(FieldValue::as_bytes);
                seal_head(head, plain.as_deref(), &mut fields)
                    .map_err(|e| sealing_error(kind, members, e))?;
                for (name, h) in [
                    ("baseRefNameHash", header.base_ref_name_hash),
                    ("sourceRefNameHash", header.source_ref_name_hash),
                ] {
                    match h {
                        Some(h) => props.insert(name.into(), FieldValue::bytes32(h)),
                        None => props.remove(name),
                    };
                }
            }
        }
        DocKind::Comment => {
            header.target_id = id32(&props, "targetId");
            fields.body = take_text(&mut props, "body");
            fields.path = take_text(&mut props, "path");
        }
        DocKind::Review => {
            header.patch_id = id32(&props, "patchId");
            fields.body = take_text(&mut props, "body");
        }
        DocKind::Event => {
            header.target_id = id32(&props, "targetId");
            fields.event_value = take_text(&mut props, "value");
            let plain = props.get("oid").and_then(FieldValue::as_bytes);
            seal_head(extra.head.as_ref(), plain.as_deref(), &mut fields)
                .map_err(|e| sealing_error(kind, members, e))?;
        }
        DocKind::RefUpdate | DocKind::ProtectedRefUpdate | DocKind::Config | DocKind::Release => {
            return Err(Error::Config(format!(
                "{} is not a collaboration document",
                kind.type_name()
            )))
        }
    }
    take_imported(&mut props, &mut fields);
    let enc = seal(&header, &fields).map_err(|e| sealing_error(kind, members, e))?;
    props.insert("epoch".into(), FieldValue::integer(u64::from(epoch)));
    props.insert("enc".into(), FieldValue::bytes(enc));
    Ok(props)
}

const TOO_LARGE_MARK: &str = "(they are encrypted together)";

/// Whether a [`seal_props`] error is "the text is over the per-type cap" (§4.3).
#[must_use]
pub fn is_too_large(e: &Error) -> bool {
    matches!(e, Error::User(u) if u.code == crate::user_error::codes::USAGE && u.message.contains(TOO_LARGE_MARK))
}

/// A seal failure as the user reads it.
fn sealing_error(kind: DocKind, members: bool, e: PrivateError) -> Error {
    match e {
        PrivateError::TooLarge(..) => {
            let what = match kind {
                DocKind::Issue => "title + body",
                DocKind::Patch => "title + body + branch names",
                DocKind::Comment => "body + file path",
                _ => "body",
            };
            crate::user_error::UserError::new(
                crate::user_error::codes::USAGE,
                format!(
                    "a {} {}'s {what} is at most {} bytes {TOO_LARGE_MARK}",
                    if members { "members-only" } else { "private" },
                    kind.type_name(),
                    if members {
                        members_text_cap(kind)
                    } else {
                        text_cap(kind)
                    }
                ),
            )
            .fix("shorten it, or split it into several")
            .into()
        }
        other => other.into(),
    }
}

/// What a private repo's member event carries as its `value` once read (§8.1).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EventValue {
    /// No value (close, reopen, merge, …).
    None,
    /// Sealed in `enc` and opened.
    Sealed,
    /// Written in plaintext by an older client: member-gated, so authentic, but not encrypted.
    Plaintext,
    /// Sealed and not readable here: the event is kept, its value is not.
    Hidden,
}

/// A private repo's member event as the folds read it. The event is always kept (its kind and
/// `refId` stand: a dismissed review stays dismissed); only its `value` depends on the read. A
/// sealed value is opened in place with `open`, and one that does not open is dropped, as is a
/// plaintext value next to `enc`. A plaintext value on its own came from an older client and
/// is kept, reported as [`EventValue::Plaintext`]. An empty value is no value.
#[must_use]
pub fn readable_event(
    open: impl FnOnce(&FetchedDocument) -> Opened,
    mut d: FetchedDocument,
) -> (FetchedDocument, EventValue) {
    if d.field_str("value").is_some_and(|v| v.is_empty()) {
        d.fields.remove("value");
    }
    if d.field_bytes("enc").is_none_or(|e| e.is_empty()) {
        let v = if d.fields.contains_key("value") {
            EventValue::Plaintext
        } else {
            EventValue::None
        };
        return (d, v);
    }
    d.fields.remove("value");
    match open(&d) {
        Opened::Readable(f) => (restore(*f, d), EventValue::Sealed),
        _ => (d, EventValue::Hidden),
    }
}

/// The fetched private document `d` as the public codecs read it, given what opening it gave:
/// its decrypted fields put back in place, or `None` when it did not open.
#[must_use]
pub fn open_doc(opened: Opened, d: FetchedDocument) -> Option<FetchedDocument> {
    match opened {
        Opened::Readable(f) => Some(restore(*f, d)),
        _ => None,
    }
}

/// The fetched letter `d` as the public codecs read it, given the opened `letter`: its fields
/// put back in place, and its recipients and group in the `$letterTo` / `$letterGroup` fields
/// ([`super::v2::LETTER_TO_FIELD`]) the views read.
///
/// The group is kept only on a letter that carries `asMember`: anyone may set tag 29, and a
/// stranger's claim that it went to "the maintainers" would otherwise label it so and make a
/// reply re-list the group (DESIGN §4.2: strangers' letters are a display rule, never a group's).
#[must_use]
pub fn open_letter_doc(
    letter: crate::private::named::Letter,
    d: FetchedDocument,
) -> FetchedDocument {
    let crate::private::named::Letter {
        fields,
        recipients,
        group,
        ..
    } = letter;
    let group = group.filter(|_| d.fields.contains_key(crate::layout::AS_MEMBER));
    let mut d = restore(fields, d);
    d.fields.insert(
        super::v2::LETTER_TO_FIELD.into(),
        FieldValue::List(recipients.into_iter().map(FieldValue::Identifier).collect()),
    );
    if let Some(g) = group {
        d.fields.insert(
            super::v2::LETTER_GROUP_FIELD.into(),
            FieldValue::integer(u64::from(g.code())),
        );
    }
    d
}

/// `d` with the decrypted `f` put back where the public codecs read it.
fn restore(f: Fields, mut d: FetchedDocument) -> FetchedDocument {
    let Fields {
        title,
        body,
        base_ref_name,
        source_ref_name,
        path,
        imported_author,
        imported_url,
        event_value,
        ..
    } = f;
    if let Some(FieldValue::Object(m)) = d.fields.get_mut("imported") {
        for (name, v) in [("author", imported_author), ("url", imported_url)] {
            if let Some(v) = v {
                m.insert(name.into(), FieldValue::text(v));
            }
        }
    }
    for (name, v) in [
        ("title", title),
        ("body", body),
        ("baseRefName", base_ref_name),
        ("sourceRefName", source_ref_name),
        ("path", path),
        ("value", event_value),
    ] {
        if let Some(v) = v {
            d.fields.insert(name.into(), FieldValue::text(v));
        }
    }
    d
}

#[cfg(test)]
mod members_pr_tests {
    //! The PR folds on blinds (DESIGN §4.4, S5 V2, V2b, V4): everyone folds the head, the
    //! approvals and the checks on the blinds as written (rule C); members learn the real head of
    //! verified blinds only, and never compare it with a folded field.
    use super::*;
    use crate::private::blind::{self, BlindMap, Head, OidField};
    use crate::private::doc::{open_content, AnchorRef, OpenContext};
    use crate::private::members_ref::{self, RefUpdateIn};
    use crate::private::{EpochKey, EpochResolution, Lane, Opened};
    use crate::rules::parity::{checks_state, CheckRunRow, ChecksPolicy};
    use crate::rules::review::fold_pr_review_v2;
    use crate::rules::v2::{count_approvals, Membership, Review, Role, RoleOracle};
    use crate::rules::{Event, EventKind};
    use std::collections::BTreeSet;

    const REPO: [u8; 32] = [0x11; 32];
    const OWNER: [u8; 32] = [0x22; 32];

    fn lane(epoch: u32) -> Lane {
        let mut res = EpochResolution::default();
        res.keys.insert(0, EpochKey::from_bytes([3; 32]));
        res.keys.insert(1, EpochKey::from_bytes([4; 32]));
        res.write_epoch = Some(epoch);
        Lane::from_resolution(&REPO, &res).unwrap()
    }

    fn ctx() -> OpenContext {
        let anchor = |h| AnchorRef {
            id: [u8::try_from(h).unwrap(); 32],
            height: h,
            stated_height: h,
        };
        OpenContext {
            keys: [
                (0, lane(0).write_keys().clone()),
                (1, lane(1).write_keys().clone()),
            ]
            .into(),
            anchors: [(0, anchor(1)), (1, anchor(2))].into(),
            ..OpenContext::default()
        }
    }

    /// A push of `real` to the members-only source branch under `epoch`: the introducing
    /// document, whose blind and salt everything downstream copies.
    fn push(epoch: u32, real: [u8; 20]) -> members_ref::SealedRefUpdate {
        let l = lane(epoch);
        members_ref::seal(
            l.write_keys(),
            OWNER,
            &RefUpdateIn {
                kind: DocKind::RefUpdate,
                name: "refs/heads/sec/fix",
                new_oid: &real,
                prev_oid: None,
                force: false,
            },
        )
        .unwrap()
    }

    fn opened_head(kind: DocKind, props: &BTreeMap<String, FieldValue>, plain: &str) -> Head {
        let d = FetchedDocument {
            id: crate::platform::encode_identifier([0x5a; 32]),
            owner_id: crate::platform::encode_identifier(OWNER),
            created_at: Some(1),
            created_at_block_height: Some(5),
            updated_at_block_height: None,
            updated_at: None,
            fields: props.clone(),
            revision: Some(1),
        };
        let mut header = crate::keyring::header_of(kind, &d).unwrap();
        header.vis = crate::rules::v2::Visibility::Public;
        let Opened::Readable(f) = open_content(&ctx(), &header, &d.field_bytes("enc").unwrap())
        else {
            panic!("opens");
        };
        blind::head_of(
            &d.field_bytes(plain).unwrap(),
            f.head_oid.as_deref(),
            f.oid_salt.as_ref(),
        )
        .unwrap()
    }

    fn head_update(
        epoch: u32,
        push: &members_ref::SealedRefUpdate,
        real: [u8; 20],
    ) -> BTreeMap<String, FieldValue> {
        let mut p = BTreeMap::new();
        p.insert("targetId".into(), FieldValue::bytes(vec![0x33; 32]));
        p.insert("kind".into(), FieldValue::integer(16));
        p.insert("oid".into(), FieldValue::bytes(push.new_oid.clone()));
        let head = HeadBlind {
            real: real.to_vec(),
            salt: push.salt,
        };
        seal_members_head_update_props(&lane(epoch), OWNER, p, &head).unwrap()
    }

    #[test]
    #[allow(clippy::too_many_lines)]
    fn approvals_and_checks_fold_on_blinds_across_a_rotation() {
        let (h1, h2, h3) = ([1u8; 20], [2u8; 20], [3u8; 20]);
        let (p1, p2) = (push(0, h1), push(0, h2));
        // a rotation: the branch moves on under epoch 1, the PR keeps its epoch 0
        let p3 = push(1, h3);
        let mut props = BTreeMap::new();
        for (k, v) in [
            ("number", FieldValue::integer(12)),
            ("title", FieldValue::text("Fix the leak")),
            ("baseRefName", FieldValue::text("refs/heads/main")),
            ("sourceRefName", FieldValue::text("refs/heads/sec/fix")),
            ("sourceRepoId", FieldValue::bytes(REPO.to_vec())),
            ("headOid", FieldValue::bytes(p1.new_oid.clone())),
        ] {
            props.insert(k.to_string(), v);
        }
        let members = MembersPatch {
            base_public: true,
            source_public: false,
            head: Some(HeadBlind {
                real: h1.to_vec(),
                salt: p1.salt,
            }),
        };
        let patch = seal_members_patch_props(&lane(0), OWNER, props.clone(), &members).unwrap();
        // the public can find the public base; the source is keyed
        assert_eq!(
            patch["baseRefNameHash"].as_bytes().unwrap(),
            crate::backends::sha256(b"refs/heads/main")
        );
        assert_ne!(
            patch["sourceRefNameHash"].as_bytes().unwrap(),
            crate::backends::sha256(b"refs/heads/sec/fix")
        );
        let hu2 = head_update(0, &p2, h2);
        let hu3 = head_update(1, &p3, h3);
        // members: a verified blind -> real map from the PR and its head updates
        let mut map = BlindMap::new();
        for (kind, d, plain) in [
            (DocKind::Patch, &patch, "headOid"),
            (DocKind::Event, &hu2, "oid"),
            (DocKind::Event, &hu3, "oid"),
        ] {
            let Head::Real { real, salt } = opened_head(kind, d, plain) else {
                panic!("verified");
            };
            assert!(map
                .learn(
                    OidField::HeadOid,
                    &d.field_bytes_of(plain),
                    Some(&real),
                    Some(&salt)
                )
                .is_none());
        }
        // everyone folds the head on the blinds as written
        let hex = |b: &[u8]| hex::encode(b);
        let ev = |id: &str, oid: &[u8], at| Event {
            id: id.into(),
            target_id: "pr".into(),
            kind: EventKind::HeadUpdate,
            actor: "alice".into(),
            value: None,
            oid: Some(hex(oid)),
            ref_id: None,
            created_at: at,
        };
        let state = fold_pr_review_v2(
            &[ev("e2", &p2.new_oid, 20), ev("e3", &p3.new_oid, 40)],
            &[],
            "alice",
            &hex(&p1.new_oid),
            &BTreeSet::new(),
        );
        assert_eq!(state.head, hex(&p3.new_oid));
        assert_eq!(map.real_of(&state.head), Some(hex(&h3).as_str()));
        // rule C: carol copies the folded head; dave writes the real head (the S5 V2 bug a
        // member would make by putting the real head in the folded field)
        let oracle = RoleOracle::new(
            ["bob", "carol", "dave"]
                .into_iter()
                .map(|w| Membership {
                    identity: w.into(),
                    role: Role::Maintainer,
                    created_at: 0,
                })
                .collect(),
        );
        let review = |id: &str, who: &str, commit: String, at| Review {
            id: id.into(),
            reviewer: who.into(),
            verdict: 1,
            commit_oid: commit,
            created_at: at,
        };
        let approvals = count_approvals(
            &[
                review("r1", "bob", hex(&p2.new_oid), 30),
                review("r2", "carol", state.head.clone(), 50),
                review("r3", "dave", hex(&h3), 51),
            ],
            &oracle,
            &state.head,
            &BTreeSet::new(),
            "alice",
        );
        assert_eq!(
            approvals.approvers.into_iter().collect::<Vec<_>>(),
            ["carol"]
        );
        let run = |id: &str, head: String| CheckRunRow {
            id: id.into(),
            head_oid: head,
            name: "build".into(),
            status: "completed".into(),
            conclusion: Some("success".into()),
            reporter: "bob".into(),
            created_at: 60,
            updated_at: None,
        };
        let policy = ChecksPolicy {
            required_checks: vec!["build".into()],
            ..ChecksPolicy::default()
        };
        let runners = BTreeSet::new();
        assert!(
            checks_state(
                &[run("c1", state.head.clone())],
                &state.head,
                &oracle,
                &runners,
                &policy
            )
            .met
        );
        assert!(
            !checks_state(
                &[run("c2", hex(&h3))],
                &state.head,
                &oracle,
                &runners,
                &policy
            )
            .met,
            "a run on the real head never attaches"
        );
    }

    #[test]
    fn a_mismatched_head_is_refused_by_writers_and_kept_with_an_alert_by_readers() {
        let p2 = push(0, [2; 20]);
        let mut props = BTreeMap::new();
        props.insert("targetId".into(), FieldValue::bytes(vec![0x33; 32]));
        props.insert("kind".into(), FieldValue::integer(16));
        props.insert("oid".into(), FieldValue::bytes(p2.new_oid.clone()));
        let wrong = HeadBlind {
            real: vec![9; 20],
            salt: p2.salt,
        };
        assert!(seal_members_head_update_props(&lane(0), OWNER, props.clone(), &wrong).is_err());
        // a members-only source without its blind would put the real head in plaintext
        let mut patch = BTreeMap::new();
        for (k, v) in [
            ("number", FieldValue::integer(1)),
            ("title", FieldValue::text("t")),
            ("baseRefName", FieldValue::text("refs/heads/main")),
            ("sourceRefName", FieldValue::text("refs/heads/sec/fix")),
            ("headOid", FieldValue::bytes(vec![2; 20])),
        ] {
            patch.insert(k.to_string(), v);
        }
        let unblinded = MembersPatch {
            base_public: true,
            source_public: false,
            head: None,
        };
        assert!(seal_members_patch_props(&lane(0), OWNER, patch, &unblinded).is_err());
        // another client writes it anyway: readers keep it, fold the blind, alert, trust nothing
        let mut header = crate::private::doc::DocHeader::new(DocKind::Event, OWNER, 0);
        header.vis = crate::rules::v2::Visibility::Public;
        header.target_id = Some([0x33; 32]);
        let fields = Fields {
            head_oid: Some(vec![9; 20]),
            oid_salt: Some(p2.salt),
            ..Fields::default()
        };
        let enc = lane(0).seal_doc(&header, &fields).unwrap();
        props.insert("enc".into(), FieldValue::bytes(enc));
        props.insert("epoch".into(), FieldValue::integer(0));
        let Head::Alert(a) = opened_head(DocKind::Event, &props, "oid") else {
            panic!("alert");
        };
        assert_eq!(a.field, OidField::HeadOid);
        let mut map = BlindMap::new();
        assert!(map
            .learn(
                OidField::HeadOid,
                &p2.new_oid,
                Some(&[9; 20]),
                Some(&p2.salt)
            )
            .is_some());
        assert!(map.is_empty());
    }

    trait BytesOf {
        fn field_bytes_of(&self, name: &str) -> Vec<u8>;
    }

    impl BytesOf for BTreeMap<String, FieldValue> {
        fn field_bytes_of(&self, name: &str) -> Vec<u8> {
            self[name].as_bytes().unwrap().clone()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keyring::header_of;
    use crate::private::doc::{open_content, AnchorRef, OpenContext};
    use crate::private::EpochKey;
    use crate::rules::v2::{ContentKind, Visibility};

    const REPO: [u8; 32] = [0x11; 32];
    const OWNER: [u8; 32] = [0x22; 32];

    fn keys() -> EpochKeys {
        EpochKeys::derive(&REPO, 0, &EpochKey::from_bytes([3; 32]))
    }

    fn lane() -> crate::private::Lane {
        let mut res = crate::private::EpochResolution::default();
        res.keys.insert(0, EpochKey::from_bytes([3; 32]));
        res.write_epoch = Some(0);
        crate::private::Lane::from_resolution(&REPO, &res).unwrap()
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

    fn fetched(props: BTreeMap<String, FieldValue>) -> FetchedDocument {
        FetchedDocument {
            id: crate::platform::encode_identifier([0x5a; 32]),
            owner_id: crate::platform::encode_identifier(OWNER),
            created_at: Some(1),
            created_at_block_height: Some(10),
            updated_at_block_height: None,
            updated_at: None,
            fields: props,
            revision: None,
        }
    }

    #[test]
    fn a_sealed_patch_carries_no_plaintext_and_opens_back_to_the_public_shape() {
        let public: BTreeMap<String, FieldValue> = [
            ("number".to_string(), FieldValue::integer(3)),
            ("title".to_string(), FieldValue::text("Add the feature")),
            ("body".to_string(), FieldValue::text("Closes #7.")),
            (
                "baseRefName".to_string(),
                FieldValue::text("refs/heads/main"),
            ),
            (
                "sourceRefName".to_string(),
                FieldValue::text("refs/heads/feature"),
            ),
            ("sourceRepoId".to_string(), FieldValue::identifier(REPO)),
            ("headOid".to_string(), FieldValue::bytes(vec![0xaa; 20])),
            ("draft".to_string(), FieldValue::boolean(true)),
        ]
        .into();
        let sealed = seal_props(&keys(), DocKind::Patch, OWNER, public.clone()).unwrap();
        for f in ["title", "body", "baseRefName", "sourceRefName"] {
            assert!(!sealed.contains_key(f), "{f} left in plaintext");
        }
        assert_eq!(
            sealed.get("baseRefNameHash").and_then(FieldValue::as_bytes),
            Some(keys().ref_name_hash("refs/heads/main").to_vec()),
            "the base hash is keyed per epoch, never sha256"
        );
        let d = fetched(sealed);
        assert!(crate::collab::v2::well_formed(
            ContentKind::Patch,
            &d,
            Visibility::Private
        ));
        let header = header_of(DocKind::Patch, &d).unwrap();
        let opened = open_content(&ctx(), &header, &d.field_bytes("enc").unwrap());
        let back = open_doc(opened, d).unwrap();
        for f in ["title", "body", "baseRefName", "sourceRefName"] {
            assert_eq!(back.fields.get(f), public.get(f), "{f}");
        }
        assert!(back.field_bool("draft"), "plaintext fields are untouched");
    }

    /// §17: a members-only comment of a public repository is sealed in `enc` v0x03 with no
    /// plaintext left, is well-formed public content, opens for a member (the header says the
    /// repository is public), and an edit re-seals it as v0x03 again.
    #[test]
    fn a_members_only_comment_seals_opens_and_reseals_as_v03() {
        let public: BTreeMap<String, FieldValue> = [
            ("targetId".to_string(), FieldValue::identifier([7; 32])),
            ("body".to_string(), FieldValue::text("members only")),
            ("path".to_string(), FieldValue::text("src/a.rs")),
        ]
        .into();
        let sealed = seal_members_props(&lane(), DocKind::Comment, OWNER, public).unwrap();
        assert!(!sealed.contains_key("body") && !sealed.contains_key("path"));
        let d = fetched(sealed);
        assert_eq!(
            d.field_bytes("enc").unwrap()[0],
            crate::private::doc::V3,
            "members-only content is enc v0x03"
        );
        assert!(crate::collab::v2::well_formed(
            ContentKind::Comment,
            &d,
            Visibility::Public
        ));
        let mut header = header_of(DocKind::Comment, &d).unwrap();
        // read as a private repository's document, v0x03 opens too (DESIGN D38's reader half)
        assert!(matches!(
            open_content(&ctx(), &header, &d.field_bytes("enc").unwrap()),
            crate::private::Opened::Readable(_)
        ));
        header.vis = Visibility::Public;
        let back = open_doc(
            open_content(&ctx(), &header, &d.field_bytes("enc").unwrap()),
            d.clone(),
        )
        .unwrap();
        assert_eq!(back.field_str("body").as_deref(), Some("members only"));
        assert_eq!(back.field_str("path").as_deref(), Some("src/a.rs"));
        let changes = BTreeMap::from([("body".to_string(), Some("edited".to_string()))]);
        let replace =
            reseal_members_edit(&lane(), DocKind::Comment, OWNER, &back, &changes).unwrap();
        assert_eq!(replace.keys().collect::<Vec<_>>(), ["enc", "epoch"]);
        let enc = replace["enc"]
            .as_ref()
            .and_then(FieldValue::as_bytes)
            .unwrap();
        assert_eq!(enc[0], crate::private::doc::V3);
        let mut after = d;
        after
            .fields
            .insert("enc".into(), FieldValue::bytes(enc.clone()));
        let back = open_doc(open_content(&ctx(), &header, &enc), after).unwrap();
        assert_eq!(back.field_str("body").as_deref(), Some("edited"));
        assert_eq!(back.field_str("path").as_deref(), Some("src/a.rs"));
    }

    #[test]
    fn an_edit_reseals_the_whole_content_and_replaces_only_enc_and_epoch() {
        let public: BTreeMap<String, FieldValue> = [
            ("number".to_string(), FieldValue::integer(7)),
            ("title".to_string(), FieldValue::text("Old title")),
            ("body".to_string(), FieldValue::text("Old body")),
            (
                "imported".to_string(),
                FieldValue::Object(
                    [
                        ("author".to_string(), FieldValue::text("octocat")),
                        ("createdAt".to_string(), FieldValue::uint64(1)),
                    ]
                    .into(),
                ),
            ),
        ]
        .into();
        let sealed = seal_props(&keys(), DocKind::Issue, OWNER, public).unwrap();
        let d = fetched(sealed);
        let header = header_of(DocKind::Issue, &d).unwrap();
        let opened = open_doc(
            open_content(&ctx(), &header, &d.field_bytes("enc").unwrap()),
            d.clone(),
        )
        .unwrap();
        // change the title only: the body and the importer's author are carried over
        let changes = BTreeMap::from([("title".to_string(), Some("New title".to_string()))]);
        let replace = reseal_edit(&keys(), DocKind::Issue, OWNER, &opened, &changes).unwrap();
        assert_eq!(
            replace.keys().collect::<Vec<_>>(),
            ["enc", "epoch"],
            "a private replace sets only enc and epoch: nothing in plaintext"
        );
        let mut after = d;
        for (k, v) in replace {
            match v {
                Some(v) => after.fields.insert(k, v),
                None => after.fields.remove(&k),
            };
        }
        let back = open_doc(
            open_content(&ctx(), &header, &after.field_bytes("enc").unwrap()),
            after,
        )
        .unwrap();
        assert_eq!(back.field_str("title").as_deref(), Some("New title"));
        assert_eq!(back.field_str("body").as_deref(), Some("Old body"));
        let Some(FieldValue::Object(imp)) = back.fields.get("imported") else {
            panic!("imported kept")
        };
        assert_eq!(imp.get("author"), Some(&FieldValue::text("octocat")));
        // an empty body clears it
        let clear = BTreeMap::from([("body".to_string(), None)]);
        let replace = reseal_edit(&keys(), DocKind::Issue, OWNER, &opened, &clear).unwrap();
        let enc = replace["enc"]
            .as_ref()
            .and_then(FieldValue::as_bytes)
            .unwrap();
        let fields = match open_content(&ctx(), &header, &enc) {
            Opened::Readable(f) => f,
            other => panic!("{other:?}"),
        };
        assert_eq!(
            (fields.title.as_deref(), fields.body),
            (Some("Old title"), None)
        );
    }

    #[test]
    fn imported_provenance_is_sealed_and_restored() {
        let imported = FieldValue::Object(
            [
                ("author".to_string(), FieldValue::text("octocat")),
                ("createdAt".to_string(), FieldValue::uint64(1_700_000_000)),
                (
                    "url".to_string(),
                    FieldValue::text("https://github.com/acme/secret/issues/12"),
                ),
            ]
            .into(),
        );
        let public: BTreeMap<String, FieldValue> = [
            ("number".to_string(), FieldValue::integer(12)),
            ("tk".to_string(), FieldValue::integer(0)),
            ("upstreamNumber".to_string(), FieldValue::integer(7761)),
            ("title".to_string(), FieldValue::text("Imported")),
            ("imported".to_string(), imported.clone()),
        ]
        .into();
        let sealed = seal_props(&keys(), DocKind::Issue, OWNER, public).unwrap();
        // indexed, so plaintext (D-2): the upstream number and the target kind tag
        assert_eq!(
            sealed.get("upstreamNumber"),
            Some(&FieldValue::integer(7761))
        );
        assert_eq!(sealed.get("tk"), Some(&FieldValue::integer(0)));
        // the source org, repo and people never reach the chain in plaintext
        let Some(FieldValue::Object(left)) = sealed.get("imported") else {
            panic!("imported kept")
        };
        assert_eq!(left.keys().collect::<Vec<_>>(), ["createdAt"]);
        let d = fetched(sealed);
        let header = header_of(DocKind::Issue, &d).unwrap();
        let opened = open_content(&ctx(), &header, &d.field_bytes("enc").unwrap());
        let back = open_doc(opened, d).unwrap();
        assert_eq!(back.fields.get("imported"), Some(&imported));
    }

    #[test]
    fn an_event_value_is_sealed_bound_to_its_target_and_restored() {
        let public: BTreeMap<String, FieldValue> = [
            ("targetId".to_string(), FieldValue::identifier([0x33; 32])),
            ("targetNumber".to_string(), FieldValue::integer(7)),
            ("kind".to_string(), FieldValue::integer(4)),
            ("value".to_string(), FieldValue::text("security")),
        ]
        .into();
        let sealed = seal_props(&keys(), DocKind::Event, OWNER, public.clone()).unwrap();
        assert!(
            !sealed.contains_key("value"),
            "the label name left plaintext"
        );
        assert_eq!(sealed.get("kind"), public.get("kind"), "the kind stays");
        let d = fetched(sealed.clone());
        let header = header_of(DocKind::Event, &d).unwrap();
        let back = open_doc(
            open_content(&ctx(), &header, &d.field_bytes("enc").unwrap()),
            d,
        )
        .unwrap();
        assert_eq!(back.field_str("value").as_deref(), Some("security"));
        // moved onto another issue, the AD (targetId) no longer matches
        let mut moved = sealed;
        moved.insert("targetId".into(), FieldValue::identifier([0x34; 32]));
        let d = fetched(moved);
        let header = header_of(DocKind::Event, &d).unwrap();
        let opened = open_content(&ctx(), &header, &d.field_bytes("enc").unwrap());
        assert!(open_doc(opened, d).is_none());
    }

    fn label_event(value: Option<&str>, enc: Option<Vec<u8>>) -> FetchedDocument {
        let mut p: BTreeMap<String, FieldValue> = [
            ("targetId".to_string(), FieldValue::identifier([0x33; 32])),
            ("kind".to_string(), FieldValue::integer(4)),
        ]
        .into();
        if let Some(v) = value {
            p.insert("value".into(), FieldValue::text(v));
        }
        if let Some(e) = enc {
            p.insert("epoch".into(), FieldValue::integer(0));
            p.insert("enc".into(), FieldValue::bytes(e));
        }
        fetched(p)
    }

    fn open_with_ctx(d: &FetchedDocument) -> Opened {
        let header = header_of(DocKind::Event, d).unwrap();
        open_content(&ctx(), &header, &d.field_bytes("enc").unwrap())
    }

    #[test]
    fn a_private_event_is_kept_whatever_its_value() {
        let sealed = seal_props(
            &keys(),
            DocKind::Event,
            OWNER,
            label_event(Some("security"), None).fields,
        )
        .unwrap();
        let enc = sealed.get("enc").and_then(FieldValue::as_bytes).unwrap();
        // sealed and readable: the value is restored
        let (d, v) = readable_event(open_with_ctx, label_event(None, Some(enc.clone())));
        assert_eq!(
            (d.field_str("value").as_deref(), v),
            (Some("security"), EventValue::Sealed)
        );
        // sealed but not readable (another target's enc): the event stays, its value does not
        let mut moved = label_event(None, Some(enc.clone()));
        moved
            .fields
            .insert("targetId".into(), FieldValue::identifier([0x34; 32]));
        let (d, v) = readable_event(open_with_ctx, moved);
        assert_eq!((d.field_str("value"), v), (None, EventValue::Hidden));
        assert_eq!(d.field_u64("kind"), Some(4), "the event itself is kept");
        // a plaintext value next to enc is never trusted: the sealed one wins
        let (d, v) = readable_event(open_with_ctx, label_event(Some("planted"), Some(enc)));
        assert_eq!(
            (d.field_str("value").as_deref(), v),
            (Some("security"), EventValue::Sealed)
        );
        // an older client's plaintext value (member-gated, so authentic) is kept, marked
        let (d, v) = readable_event(open_with_ctx, label_event(Some("legacy"), None));
        assert_eq!(
            (d.field_str("value").as_deref(), v),
            (Some("legacy"), EventValue::Plaintext)
        );
        // no value at all (close, merge…): nothing to open
        let (_, v) = readable_event(open_with_ctx, label_event(None, None));
        assert_eq!(v, EventValue::None);
        // an empty plaintext value is no value (L5)
        let (d, v) = readable_event(open_with_ctx, label_event(Some(""), None));
        assert_eq!((d.field_str("value"), v), (None, EventValue::None));
    }

    /// What `open_content` exempting events from the late rule relies on (§8.1 step 7, §15).
    #[test]
    fn event_schema_is_member_gated_and_append_only() {
        let text = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../forge-contracts/contracts/forge-community.json"
        ));
        let c: serde_json::Value = serde_json::from_str(text).unwrap();
        // `event` is a forge-community type (RC1 layout O-01)
        let e = c.get("documentSchemas").unwrap_or(&c)["event"].clone();
        assert_eq!(e["documentsMutable"], false);
        assert_eq!(e["canBeDeleted"], false);
        let mut gates: Vec<&str> = e["ownerRefersTo"]["anyOf"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|g| g["documentType"].as_str())
            .collect();
        gates.sort_unstable();
        assert_eq!(gates, ["maintainer", "writer"]);
    }

    #[test]
    fn text_over_the_per_type_cap_is_refused_with_the_number() {
        let over = "x".repeat(text_cap(DocKind::Review) + 1);
        let props: BTreeMap<String, FieldValue> = [
            ("patchId".to_string(), FieldValue::identifier([4; 32])),
            ("body".to_string(), FieldValue::text(over)),
        ]
        .into();
        let err = seal_props(&keys(), DocKind::Review, OWNER, props).unwrap_err();
        assert!(err.to_string().contains("5088"), "{err}");
        assert_eq!(text_cap(DocKind::Patch), 5079);
        assert_eq!(text_cap(DocKind::Issue), 5085);
    }
}
