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
    let records = match kind {
        DocKind::Issue | DocKind::Comment => 2,
        DocKind::Patch => 4,
        _ => 1,
    };
    kind.max_enc() - crate::private::doc::MIN_V1 - 3 * records
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
    seal_props_inner(keys, kind, owner, props, |h, f| {
        crate::private::doc::seal(keys, h, f)
    })
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
    seal_props_inner(keys, kind, owner, props, |h, f| {
        crate::private::doc::seal_with_nonce(keys, h, f, false, nonce)
    })
}

fn seal_props_inner(
    keys: &EpochKeys,
    kind: DocKind,
    owner: [u8; 32],
    mut props: BTreeMap<String, FieldValue>,
    seal: impl FnOnce(&DocHeader, &Fields) -> std::result::Result<Vec<u8>, PrivateError>,
) -> Result<BTreeMap<String, FieldValue>> {
    let epoch = keys.epoch();
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
                let hash = |name: &Option<String>| name.as_deref().map(|n| keys.ref_name_hash(n));
                header.base_ref_name_hash = hash(&fields.base_ref_name);
                header.source_ref_name_hash = hash(&fields.source_ref_name);
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
        }
        DocKind::RefUpdate | DocKind::ProtectedRefUpdate | DocKind::Config => {
            return Err(Error::Config(format!(
                "{} is not a collaboration document",
                kind.type_name()
            )))
        }
    }
    take_imported(&mut props, &mut fields);
    let enc = seal(&header, &fields).map_err(|e| sealing_error(kind, e))?;
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
fn sealing_error(kind: DocKind, e: PrivateError) -> Error {
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
                    "a private {}'s {what} is at most {} bytes {TOO_LARGE_MARK}",
                    kind.type_name(),
                    text_cap(kind)
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

    fn ctx() -> OpenContext {
        OpenContext {
            keys: [(0, keys())].into(),
            anchors: [(
                0,
                AnchorRef {
                    id: [9; 32],
                    height: 1,
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
