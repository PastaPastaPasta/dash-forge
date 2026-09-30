//! Collaboration types and document codecs shared by the forge-collab services.
//!
//! [`v2::Collab`] is the service: issues, pull requests, comments, reviews, events, releases,
//! labels, stars and follows on a forge-v2 repository. This module holds what it and the
//! importer share: the release and label shapes, importer provenance ([`Imported`]), the
//! stored numeric event kinds, and the text-length checks run before anything is signed.

pub mod parity;
pub mod private;
pub mod v2;

use std::collections::BTreeMap;

use crate::error::{Error, Result};
use crate::keystore::BridgeIdentity;
use crate::platform::{self, FieldValue, LoadedIdentity, PlatformClient, WriteEngine};
use crate::rules::EventKind;

// The verdict mapping is a cross-client rule (both ports render a PR's review history
// from it), so it lives in `rules` with the other shared mappings and is re-exported here
// for the service API that returns it.
pub use crate::rules::Verdict;

/// The page size a caller-supplied `limit` of 0 means: "one page of the server default".
/// Drive's own default and maximum are both 100 rows.
pub(crate) const DEFAULT_PAGE: u32 = 100;

/// Build a HIGH-key document write/delete engine over `client` for `identity`.
///
/// Document create/delete accept a HIGH auth key (S0.7), falling back to CRITICAL.
pub(crate) fn doc_engine<'a>(
    client: &'a PlatformClient,
    identity: &'a LoadedIdentity,
    bridge: &'a BridgeIdentity,
) -> Result<WriteEngine<'a>> {
    WriteEngine::new(client, identity, bridge.doc_op_key()?)
}

/// Fail fast on a text field that exceeds its contract `maxLength`, before spending a
/// broadcast on a create consensus will reject. Counts Unicode scalar values (the
/// client-side approximation; consensus is authoritative).
pub(crate) fn check_len(field: &str, value: &str, max: usize) -> Result<()> {
    let len = value.chars().count();
    if len > max {
        return Err(Error::Config(format!(
            "{field} too long: {len} chars (max {max})"
        )));
    }
    Ok(())
}

/// [`check_len`] plus the contract's `maxBytes` (UTF-8 bytes): a non-ASCII text under the
/// character limit can still be over the byte limit, and consensus refuses it.
pub(crate) fn check_text(
    field: &str,
    value: &str,
    max_chars: usize,
    max_bytes: usize,
) -> Result<()> {
    check_len(field, value, max_chars)?;
    if value.len() > max_bytes {
        return Err(Error::Config(format!(
            "{field} too long: {} bytes as UTF-8 (max {max_bytes})",
            value.len()
        )));
    }
    Ok(())
}

/// Importer provenance (the `imported` object on `issue` / `patch` / `comment` / `review`
/// documents, forge-v2.md §2): the original author login, the original creation time
/// (unix seconds), and the source URL. Recorded because Platform `$createdAt` is consensus
/// time, not the original artifact's time — clients render this provenance for migrated
/// docs and (via the gist-claim flow, PRD 06) can later attribute a placeholder `author`
/// login to a real Dash identity.
#[derive(Debug, Clone, Default)]
pub struct Imported {
    /// Original author handle (e.g. a GitHub login), ≤ 120 chars.
    pub author: String,
    /// Original creation time, unix seconds.
    pub created_at: u64,
    /// Source URL of the original artifact, ≤ 300 chars.
    pub url: String,
}

impl Imported {
    /// Build the nested `imported` object field, validating the string lengths.
    fn to_field(&self) -> Result<FieldValue> {
        check_len("imported author", &self.author, 120)?;
        check_len("imported url", &self.url, 300)?;
        let mut map = BTreeMap::new();
        if !self.author.is_empty() {
            map.insert("author".to_string(), FieldValue::text(&self.author));
        }
        // Full-width u64: `createdAt` is an unbounded nested-object integer that Drive stores
        // as U64; a minimal-width encoding fails proof verification (see FieldValue::Uint64).
        map.insert("createdAt".to_string(), FieldValue::uint64(self.created_at));
        if !self.url.is_empty() {
            map.insert("url".to_string(), FieldValue::text(&self.url));
        }
        Ok(FieldValue::Object(map))
    }
}

/// Insert the `imported` provenance object into `props` when present (no-op for `None`).
pub(crate) fn insert_imported(
    props: &mut BTreeMap<String, FieldValue>,
    imported: Option<&Imported>,
) -> Result<()> {
    if let Some(i) = imported {
        props.insert("imported".to_string(), i.to_field()?);
    }
    Ok(())
}

/// Map a [`crate::rules::EventKind`] to its stored numeric `kind` (forge-v2.md §3).
pub(crate) fn event_kind_to_u64(kind: EventKind) -> u64 {
    match kind {
        EventKind::Close => 1,
        EventKind::Reopen => 2,
        EventKind::Merge => 3,
        EventKind::LabelAdd => 4,
        EventKind::LabelRemove => 5,
        EventKind::Assign => 6,
        EventKind::Unassign => 7,
        EventKind::Retarget => 8,
        EventKind::Draft => 9,
        EventKind::Ready => 10,
        EventKind::ThreadResolve => 11,
        EventKind::ThreadUnresolve => 12,
        EventKind::ReviewRequest => 13,
        EventKind::ReviewRequestRemove => 14,
        EventKind::ReviewDismiss => 15,
        EventKind::HeadUpdate => 16,
        EventKind::MilestoneSet => 17,
        EventKind::MilestoneClear => 18,
        EventKind::Pin => 19,
        EventKind::Unpin => 20,
        EventKind::Lock => 21,
        EventKind::Unlock => 22,
    }
}

/// Map a stored numeric `kind` back to a [`crate::rules::EventKind`] (unknown → `None`).
pub(crate) fn u64_to_event_kind(kind: u64) -> Option<EventKind> {
    Some(match kind {
        1 => EventKind::Close,
        2 => EventKind::Reopen,
        3 => EventKind::Merge,
        4 => EventKind::LabelAdd,
        5 => EventKind::LabelRemove,
        6 => EventKind::Assign,
        7 => EventKind::Unassign,
        8 => EventKind::Retarget,
        9 => EventKind::Draft,
        10 => EventKind::Ready,
        11 => EventKind::ThreadResolve,
        12 => EventKind::ThreadUnresolve,
        13 => EventKind::ReviewRequest,
        14 => EventKind::ReviewRequestRemove,
        15 => EventKind::ReviewDismiss,
        16 => EventKind::HeadUpdate,
        17 => EventKind::MilestoneSet,
        18 => EventKind::MilestoneClear,
        19 => EventKind::Pin,
        20 => EventKind::Unpin,
        21 => EventKind::Lock,
        22 => EventKind::Unlock,
        _ => return None,
    })
}

/// Optional review/inline anchor for a [`v2::Collab::comment`].
#[derive(Debug, Clone, Default)]
pub struct CommentAnchor {
    /// Parent comment `$id` (a threaded reply).
    pub reply_to: Option<String>,
    /// Anchored commit oid.
    pub commit_oid: Option<Vec<u8>>,
    /// Anchored file path.
    pub path: Option<String>,
    /// Anchored line.
    pub line: Option<u64>,
    /// Diff side (0/1).
    pub side: Option<u64>,
    /// First line of a multi-line range (`line` is the last); needs `line`.
    pub start_line: Option<u64>,
    /// The `review` this comment belongs to (a pending review's batched comments). Consensus
    /// requires the review to be the signer's and on the same PR.
    pub review_id: Option<String>,
}

// ===========================================================================
// Releases
// ===========================================================================

/// A release asset (serialized into the `assets` JSON-string field):
/// `{name, sha256, sizeBytes, uris}` (`size_bytes`, written by earlier clients, still reads).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseAsset {
    /// Asset file name.
    pub name: String,
    /// Hex SHA-256 of the asset.
    pub sha256: String,
    /// Size in bytes (`size` in the web app's writer, `size_bytes` in older CLIs).
    #[serde(alias = "size_bytes", alias = "size", default)]
    pub size_bytes: u64,
    /// Mirror URIs (≤ 4).
    #[serde(default)]
    pub uris: Vec<String>,
    /// The single `uri` forge-web's writer records; folded into `uris` on read
    /// ([`release_from_doc`]) and never written.
    #[serde(default, skip_serializing)]
    pub uri: Option<String>,
}

/// Input for [`v2::Collab::create_release`].
///
/// A private repository's release is sealed (`private-repos.md` §16) and every revision is a
/// complete statement: an empty `name` or `notes`, and a `None` flag, carry the tag's newest
/// revision forward, and so do its assets, except those a new file of the same name replaces.
#[derive(Debug, Clone, Default)]
pub struct ReleaseInput {
    /// Tag name (the logical key; newest doc per tag wins).
    pub tag_name: String,
    /// Display name.
    pub name: String,
    /// Release notes.
    pub notes: String,
    /// Whether this release is yanked. A public revision states it afresh (`None` is not
    /// yanked); a private one carries the tag's last revision's when `None` (§16.3).
    pub yanked: Option<bool>,
    /// Assets already stored (a public repository; a private one's are [`Self::files`]).
    pub assets: Vec<ReleaseAsset>,
    /// A private repository: the files to seal and store as new assets.
    pub files: Vec<ReleaseFile>,
    /// A private repository: the sealed pre-release flag (§16.2), `None` to carry it forward.
    pub prerelease: Option<bool>,
    /// A private repository: the sealed draft flag, `None` to carry it forward.
    pub draft: Option<bool>,
    /// A private repository: unpublish the tag (flag `0x08`, every field carried forward;
    /// `delta` stays 0, §16.3).
    pub unpublished: bool,
}

/// One file a sealed release stores as an asset (§16.5).
#[derive(Clone)]
pub struct ReleaseFile {
    /// The asset's name.
    pub name: String,
    /// The plaintext bytes.
    pub bytes: Vec<u8>,
}

impl std::fmt::Debug for ReleaseFile {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ReleaseFile")
            .field("name", &self.name)
            .field("len", &self.bytes.len())
            .finish()
    }
}

/// Where a sealed release's files and asset list go: the repository's external storage
/// (release assets are external only), and how many copies must confirm.
pub struct ReleaseStore<'t> {
    /// The targets.
    pub targets: Vec<&'t dyn crate::storage::StorageTarget>,
    /// Confirmations required.
    pub required: usize,
}

/// What [`v2::Collab::create_release_stored`] wrote.
#[derive(Debug, Clone, Default)]
pub struct ReleaseWritten {
    /// The new revision's `$id`.
    pub document_id: String,
    /// A sealed release's asset list, as this revision names it (empty when it was kept
    /// unopened: [`Self::asset_list_kept`]).
    pub sealed_assets: Vec<crate::private::release::ManifestAsset>,
    /// The revision names the previous asset list as it was, unopened.
    pub asset_list_kept: bool,
    /// The revision names the asset list an earlier attempt stored before its release write
    /// failed: nothing was sealed or stored again (§16.5).
    pub asset_list_reused: bool,
    /// What the writer of a sealed revision should know (§16.3): it is not the tag's newest
    /// after the write (another maintainer's concurrent revision, or a clock behind theirs),
    /// or that could not be checked; it carried forward from a view missing a newer revision;
    /// or a rotation during the upload left copies under the old key in storage.
    pub warnings: Vec<String>,
}

/// A release document, flattened (newest per `tagName`).
#[derive(Debug, Clone)]
pub struct Release {
    /// Document `$id`.
    pub document_id: String,
    /// Tag name.
    pub tag_name: String,
    /// Display name.
    pub name: String,
    /// Notes.
    pub notes: String,
    /// Yanked flag.
    pub yanked: bool,
    /// Assets (parsed from the `assets` JSON-string field).
    pub assets: Vec<ReleaseAsset>,
    /// Who published this revision (`$ownerId`). Always shown: readers name the publisher
    /// of each revision.
    pub publisher: String,
    /// Consensus `$createdAt` (ms).
    pub created_at: u64,
    /// `release.delta` (RC1 `release_ledger`): `+1` publishes the tag, `0` edits, yanks or
    /// seals it, `-1` unpublishes it. A tag is live while its revisions sum to 1; releases
    /// cannot be deleted.
    pub delta: i64,
    /// A private repository's sealed revision (§16): its epoch and every field it states.
    /// `None` on a public release.
    pub sealed: Option<SealedRelease>,
}

/// What a sealed release revision states besides the fields [`Release`] flattens.
#[derive(Debug, Clone)]
pub struct SealedRelease {
    /// The key epoch it was sealed under.
    pub epoch: u32,
    /// The opened TLV: the tag, flags, target, provenance and the asset manifest's hash.
    pub fields: crate::private::release::ReleaseFields,
}

impl Release {
    /// A draft: a sealed-only label, never access control (§16.3).
    #[must_use]
    pub fn is_draft(&self) -> bool {
        self.sealed.as_ref().is_some_and(|s| s.fields.draft)
    }

    /// A pre-release: its tag has a pre-release suffix, or a sealed revision sets the flag
    /// (§16.2: never less of a pre-release than the public rule makes it).
    #[must_use]
    pub fn is_prerelease(&self) -> bool {
        self.sealed.as_ref().is_some_and(|s| s.fields.prerelease)
            || v2::is_prerelease(&self.tag_name)
    }
}

/// Every release of a repository as a reader sees it (§16.3 for a private one).
#[derive(Debug, Clone, Default)]
pub struct ReleaseList {
    /// The release of each live tag, in [`v2::release_order`].
    pub current: Vec<Release>,
    /// The other revisions, an unpublished tag's included, newest first.
    pub previous: Vec<Release>,
    /// Release revisions that could not be read (§16.3 "n release revisions could not be
    /// read"); on a public repository, any carrying `enc`.
    pub hidden: usize,
    /// Of `hidden`, revisions sealed under an earlier use of their epoch number: "sealed under
    /// a key this repository no longer uses", not tampering (§16.3).
    pub earlier_use: usize,
    /// Revisions ignored as copies of an earlier `enc` (§16.3).
    pub replays: usize,
    /// Tags whose newest revision could not be read: their state is unknown.
    pub unknown_tags: Vec<String>,
    /// Newer revisions are under a key this reader does not hold yet.
    pub stale: bool,
}

impl ReleaseList {
    /// The releases count: live tags whose release is not a draft (a yanked one counts).
    #[must_use]
    pub fn count(&self) -> usize {
        self.current.iter().filter(|r| !r.is_draft()).count()
    }
}

/// Build a [`Release`] from a fetched document.
pub(crate) fn release_from_doc(d: &platform::FetchedDocument) -> Release {
    let assets = d
        .field_str("assets")
        .and_then(|s| match serde_json::from_str::<Vec<ReleaseAsset>>(&s) {
            Ok(a) => Some(a),
            Err(e) => {
                tracing::warn!(release = %d.id, error = %e, "release assets unreadable; listing none");
                None
            }
        })
        .unwrap_or_default()
        .into_iter()
        .map(|mut a| {
            if let Some(u) = a.uri.take() {
                if !a.uris.contains(&u) {
                    a.uris.push(u);
                }
            }
            a
        })
        .collect();
    Release {
        document_id: d.id.clone(),
        tag_name: d.field_str("tagName").unwrap_or_default(),
        name: d.field_str("name").unwrap_or_default(),
        notes: d.field_str("notes").unwrap_or_default(),
        yanked: d.field_bool("yanked"),
        assets,
        publisher: d.owner_id.clone(),
        created_at: d.created_at.unwrap_or(0),
        delta: d
            .fields
            .get("delta")
            .and_then(FieldValue::as_i64)
            .unwrap_or(0),
        sealed: None,
    }
}

/// A [`Release`] from a sealed revision that opened to `fields`. Its assets are in the sealed
/// kind-4 manifest `fields.asset_manifest` names, read separately (§16.5).
pub(crate) fn release_from_sealed(
    d: &platform::FetchedDocument,
    epoch: u32,
    fields: crate::private::release::ReleaseFields,
) -> Release {
    Release {
        document_id: d.id.clone(),
        tag_name: fields.tag.clone(),
        name: fields.name.clone().unwrap_or_default(),
        notes: fields.notes.clone().unwrap_or_default(),
        yanked: fields.yanked,
        assets: Vec::new(),
        publisher: d.owner_id.clone(),
        created_at: d.created_at.unwrap_or(0),
        delta: 0,
        sealed: Some(SealedRelease { epoch, fields }),
    }
}

// ===========================================================================
// Labels
// ===========================================================================

/// A label definition (newest per `name`).
#[derive(Debug, Clone)]
pub struct Label {
    /// Document `$id`.
    pub document_id: String,
    /// Label name (the logical key).
    pub name: String,
    /// Hex color (e.g. `#ff0000`).
    pub color: String,
    /// Description.
    pub description: String,
    /// Retired flag.
    pub retired: bool,
    /// Consensus `$createdAt` (ms).
    pub created_at: u64,
}

/// Build a [`Label`] from a fetched document.
pub(crate) fn label_from_doc(d: &platform::FetchedDocument) -> Label {
    Label {
        document_id: d.id.clone(),
        name: d.field_str("name").unwrap_or_default(),
        color: d.field_str("color").unwrap_or_default(),
        description: d.field_str("description").unwrap_or_default(),
        retired: d.field_bool("retired"),
        created_at: d.created_at.unwrap_or(0),
    }
}

#[cfg(test)]
mod tests {
    use super::{event_kind_to_u64, u64_to_event_kind, Verdict};
    use crate::rules::EventKind;

    #[test]
    fn verdict_codes_round_trip() {
        for (v, code) in [
            (Verdict::Approve, 1),
            (Verdict::RequestChanges, 2),
            (Verdict::Comment, 3),
            (Verdict::ApproveNonMember, 4),
            (Verdict::RequestChangesNonMember, 5),
        ] {
            assert_eq!(v.code(), code, "{v:?} encodes as {code}");
            assert_eq!(Verdict::from_code(code), v, "{code} decodes as {v:?}");
        }
    }

    #[test]
    fn a_verdict_is_written_as_the_signer_s_membership_allows() {
        use Verdict::{
            Approve, ApproveNonMember, Comment, RequestChanges, RequestChangesNonMember,
        };
        assert_eq!(Approve.as_written_by(false), ApproveNonMember);
        assert_eq!(ApproveNonMember.as_written_by(true), Approve);
        assert_eq!(RequestChanges.as_written_by(false), RequestChangesNonMember);
        assert_eq!(RequestChangesNonMember.as_written_by(true), RequestChanges);
        assert_eq!(Comment.as_written_by(false), Comment);
        assert!(Approve.needs_member_proof() && !ApproveNonMember.needs_member_proof());
    }

    #[test]
    fn unknown_verdict_is_preserved_not_dropped() {
        // A review written by a newer client must still appear in a PR's history rather
        // than vanishing from it, so an unrecognized code round-trips instead of
        // collapsing to a default.
        let v = Verdict::from_code(99);
        assert_eq!(v, Verdict::Unknown(99));
        assert_eq!(v.code(), 99);
        assert_eq!(v.label(), "unknown verdict");
    }

    #[test]
    fn event_kind_numbering_round_trips() {
        for (kind, n) in [
            (EventKind::Close, 1),
            (EventKind::Reopen, 2),
            (EventKind::Merge, 3),
            (EventKind::LabelAdd, 4),
            (EventKind::LabelRemove, 5),
            (EventKind::Assign, 6),
            (EventKind::Unassign, 7),
            (EventKind::Retarget, 8),
            (EventKind::Draft, 9),
            (EventKind::Ready, 10),
            (EventKind::ThreadResolve, 11),
            (EventKind::ThreadUnresolve, 12),
            (EventKind::ReviewRequest, 13),
            (EventKind::ReviewRequestRemove, 14),
            (EventKind::ReviewDismiss, 15),
            (EventKind::HeadUpdate, 16),
            (EventKind::MilestoneSet, 17),
            (EventKind::MilestoneClear, 18),
            (EventKind::Pin, 19),
            (EventKind::Unpin, 20),
            (EventKind::Lock, 21),
            (EventKind::Unlock, 22),
        ] {
            assert_eq!(event_kind_to_u64(kind), n);
            assert_eq!(u64_to_event_kind(n), Some(kind));
        }
        assert_eq!(u64_to_event_kind(0), None);
        assert_eq!(u64_to_event_kind(23), None);
    }

    #[test]
    fn release_assets_read_both_writers_shapes() {
        use super::ReleaseAsset;
        let cli: Vec<ReleaseAsset> = serde_json::from_str(
            r#"[{"name":"a","sha256":"ab","sizeBytes":3,"uris":["https://x/a"]}]"#,
        )
        .unwrap();
        assert_eq!((cli[0].size_bytes, cli[0].uris.len()), (3, 1));
        // forge-web's writer: `size` and a single `uri`.
        let web: Vec<ReleaseAsset> =
            serde_json::from_str(r#"[{"name":"a","sha256":"ab","size":3,"uri":"https://x/a"}]"#)
                .unwrap();
        assert_eq!(web[0].size_bytes, 3);
        assert_eq!(web[0].uri.as_deref(), Some("https://x/a"));
        // Written in the documented shape only.
        let out = serde_json::to_string(&cli).unwrap();
        assert!(
            out.contains("\"sizeBytes\":3") && !out.contains("\"uri\""),
            "{out}"
        );
    }

    #[test]
    fn imported_builds_nested_object_field() {
        use super::Imported;
        use crate::platform::FieldValue;

        let imp = Imported {
            author: "octocat".to_string(),
            created_at: 1_577_934_245,
            url: "https://github.com/o/r/issues/1".to_string(),
        };
        let FieldValue::Object(map) = imp.to_field().unwrap() else {
            panic!("imported must serialize to a nested object");
        };
        assert_eq!(
            map.get("author").and_then(FieldValue::as_str),
            Some("octocat")
        );
        assert_eq!(
            map.get("createdAt").and_then(FieldValue::as_u64),
            Some(1_577_934_245)
        );
        assert!(map.contains_key("url"));

        // Empty author/url are omitted; createdAt always present.
        let bare = Imported {
            author: String::new(),
            created_at: 42,
            url: String::new(),
        };
        let FieldValue::Object(map) = bare.to_field().unwrap() else {
            panic!("object");
        };
        assert!(!map.contains_key("author"));
        assert!(!map.contains_key("url"));
        assert_eq!(map.get("createdAt").and_then(FieldValue::as_u64), Some(42));

        // Over-length author is rejected up front (before any broadcast).
        let too_long = Imported {
            author: "x".repeat(121),
            created_at: 1,
            url: String::new(),
        };
        assert!(too_long.to_field().is_err());
    }
}
