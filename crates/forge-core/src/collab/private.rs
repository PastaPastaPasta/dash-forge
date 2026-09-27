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
/// stays plaintext).
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

/// The fetched private document `d` as the public codecs read it, given what opening it gave:
/// its decrypted fields put back in place, or `None` when it did not open.
#[must_use]
pub fn open_doc(opened: Opened, mut d: FetchedDocument) -> Option<FetchedDocument> {
    let Opened::Readable(f) = opened else {
        return None;
    };
    let Fields {
        title,
        body,
        base_ref_name,
        source_ref_name,
        path,
        imported_author,
        imported_url,
        ..
    } = *f;
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
    ] {
        if let Some(v) = v {
            d.fields.insert(name.into(), FieldValue::text(v));
        }
    }
    Some(d)
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
            ("title".to_string(), FieldValue::text("Imported")),
            ("imported".to_string(), imported.clone()),
        ]
        .into();
        let sealed = seal_props(&keys(), DocKind::Issue, OWNER, public).unwrap();
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
