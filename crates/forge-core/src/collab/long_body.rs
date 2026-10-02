//! Long bodies (`docs/contracts/forge-v2.md` §6.3), the I/O half: a text longer than its field
//! holds is stored as a kind-6 artifact on the writer's storage (Platform `chunk` documents or
//! storage of their own, sealed in a private repository), and the field keeps a prefix and a
//! trailer naming it; readers fetch the artifact, check it and show the whole text. The pure
//! rule (the trailer, the prefix cut, the checks), shared with forge-web through the
//! `long_body__*` vectors, is [`crate::rules::long_body`].
//!
//! Storing an artifact is a `packManifest` write, which consensus admits only from a
//! maintainer or a role-1 writer (forge-v2.md §2.1), so only they can write a long body; anyone
//! else is refused before anything is stored.

use crate::collab::v2::Collab;
use crate::collab::Imported;
use crate::error::{Error, Result};
use crate::private::DocKind;
use crate::repo::{order_copies, PackManifestInfo, RepoService};
use crate::rules::long_body::{self, LongBody};
use crate::rules::v2::{Role, Visibility};
use crate::scope::RepoRef;
use crate::storage::{PackReader, StorageTarget};
use crate::user_error::{codes, UserError};

/// A field's public cap (`body`, `notes`: 5,120 characters and bytes).
pub const FIELD_MAX: usize = 5120;

/// The field a text is written to, with the other text a sealed document carries beside it:
/// what a private document's `enc` leaves for the body depends on it.
#[derive(Debug, Clone, Copy)]
pub enum BodyField<'s> {
    /// An issue's body, beside its title.
    Issue {
        /// The title.
        title: &'s str,
    },
    /// A pull request's body, beside its title and branch names.
    Patch {
        /// The title.
        title: &'s str,
        /// The base branch's full name.
        base_ref_name: &'s str,
        /// The source branch's full name.
        source_ref_name: &'s str,
    },
    /// A comment's body, beside an inline comment's path.
    Comment {
        /// The inline comment's path.
        path: Option<&'s str>,
    },
    /// A review's body.
    Review,
    /// A release's notes (5,120 bytes public or sealed: a sealed release continues its notes in
    /// its asset list, `docs/security/private-repos.md` §16.5, under the same cap).
    Release,
}

impl BodyField<'_> {
    /// How many UTF-8 bytes of text the field holds in a `visibility` repository, next to the
    /// document's other sealed text and an importer's `imported` author and URL (sealed too).
    #[must_use]
    pub fn room(&self, visibility: Visibility, imported: Option<&Imported>) -> usize {
        let kind = match self {
            _ if visibility == Visibility::Public => return FIELD_MAX,
            Self::Release => return FIELD_MAX,
            Self::Issue { .. } => DocKind::Issue,
            Self::Patch { .. } => DocKind::Patch,
            Self::Comment { .. } => DocKind::Comment,
            Self::Review => DocKind::Review,
        };
        // Every present text is one TLV record: 3 bytes of tag and length, then the value
        // (`docs/security/private-repos.md` §4.3).
        let record = |s: &str| if s.is_empty() { 0 } else { 3 + s.len() };
        let others = match self {
            Self::Issue { title } => record(title),
            Self::Patch {
                title,
                base_ref_name,
                source_ref_name,
            } => record(title) + record(base_ref_name) + record(source_ref_name),
            Self::Comment { path } => path.map_or(0, record),
            Self::Review | Self::Release => 0,
        };
        let provenance = imported.map_or(0, |i| record(&i.author) + record(&i.url));
        (kind.max_enc() - crate::private::doc::MIN_V1)
            .saturating_sub(3 + others + provenance)
            .min(FIELD_MAX)
    }
}

/// Where a long body's artifact goes: storage of the writer's own and/or Platform `chunk`
/// documents, as a storage policy names them.
pub struct BodyStore<'t> {
    /// External targets, in policy order.
    pub external: Vec<&'t dyn StorageTarget>,
    /// Also store it as Platform `chunk` documents.
    pub platform: bool,
    /// Copies that must confirm (clamped to `1..=` the targets).
    pub required: usize,
}

impl BodyStore<'_> {
    /// Platform `chunk` documents only: what a repository with no storage policy of its own
    /// gets, and what every reader can fetch.
    #[must_use]
    pub fn platform() -> Self {
        Self {
            external: Vec::new(),
            platform: true,
            required: 1,
        }
    }
}

/// A field's text as a reader shows it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BodyRead {
    /// The whole text: the field itself, or the artifact its trailer names, checked.
    Whole(String),
    /// Only the field's prefix: the rest could not be read (`reason`).
    Partial {
        /// The text before the trailer.
        prefix: String,
        /// Why the rest is missing, for the reader.
        reason: String,
    },
}

impl BodyRead {
    /// The text to show: the whole text, or the prefix.
    #[must_use]
    pub fn text(&self) -> &str {
        match self {
            Self::Whole(t) => t,
            Self::Partial { prefix, .. } => prefix,
        }
    }

    /// Why the text shown is only a prefix, when it is.
    #[must_use]
    pub fn incomplete(&self) -> Option<&str> {
        match self {
            Self::Whole(_) => None,
            Self::Partial { reason, .. } => Some(reason),
        }
    }
}

/// The largest sealed size a long body of `bytes` may take: a §3 header and a tag per segment,
/// at the smallest segment size a reader accepts (1 KiB). A copy claiming more is never fetched.
fn sealed_cap(bytes: u64) -> u64 {
    crate::private::pack::HEADER_LEN as u64 + bytes + 16 * bytes.div_ceil(1024).max(1)
}

impl Collab<'_> {
    /// The text to write into `field` for `full`: `full` itself when it fits, else the
    /// field's prefix and trailer after the full text is stored as a kind-6 artifact on
    /// `store` (sealed under the write epoch in a private repository). The caller writes the
    /// document with it; in a private repository it is then sealed with the rest of the
    /// document, so the trailer, too, is only in `enc`.
    ///
    /// Refused before anything is stored when the text is over 262,144 bytes, or when the
    /// signer is not a maintainer or role-1 writer of `repo` (only they may record artifacts).
    pub async fn store_long_body(
        &self,
        repo: &RepoRef,
        field: BodyField<'_>,
        imported: Option<&Imported>,
        full: &str,
        store: &BodyStore<'_>,
    ) -> Result<String> {
        let room = field.room(repo.visibility, imported);
        if !long_body::needs_artifact(full, room) {
            return Ok(full.to_string());
        }
        if full.len() as u64 > long_body::MAX_BYTES {
            return Err(UserError::new(
                codes::USAGE,
                format!(
                    "the text is {} bytes, and Dash Forge stores at most {} bytes of one text",
                    full.len(),
                    long_body::MAX_BYTES
                ),
            )
            .fix("shorten it, or split it into comments")
            .into());
        }
        self.require_role(
            repo,
            Role::Writer,
            &format!(
                "store a text of {} bytes (a field holds {room}; a longer text is stored as a \
                 repository artifact, which only maintainers and writers may record)",
                full.len()
            ),
        )
        .await?;
        let hash = self
            .repo_service()?
            .store_long_body(
                repo,
                full.as_bytes(),
                &store.external,
                store.platform,
                store.required,
            )
            .await?;
        long_body::stored_text(full, room, &hash).ok_or_else(|| {
            Error::Config(format!(
                "a field of {room} bytes cannot hold the trailer naming the full text"
            ))
        })
    }

    /// `stored` (a field as read: decrypted, in a private repository) as a reader shows it:
    /// the field itself when it has no trailer, else the full text its trailer names, fetched
    /// from any copy by the pack reader rule and checked (hash, length, UTF-8; opened and the
    /// late-content rule applied in a private repository). When that fails, the prefix and why.
    pub async fn read_long_body(&self, repo: &RepoRef, stored: &str) -> BodyRead {
        match long_body::parse(stored) {
            LongBody::Plain => BodyRead::Whole(stored.to_string()),
            LongBody::Unsupported { prefix } => BodyRead::Partial {
                prefix: prefix.to_string(),
                reason: "the rest is stored in a form this version cannot read".to_string(),
            },
            LongBody::Continued {
                prefix,
                sha256,
                bytes,
            } => match self.fetch_long_body(repo, sha256, bytes).await {
                Ok(text) => BodyRead::Whole(text),
                Err(e) => BodyRead::Partial {
                    prefix: prefix.to_string(),
                    reason: format!("the full text ({bytes} bytes) could not be read: {e}"),
                },
            },
        }
    }

    async fn fetch_long_body(
        &self,
        repo: &RepoRef,
        sha256: [u8; 32],
        bytes: u64,
    ) -> Result<String> {
        let private = repo.visibility == Visibility::Private;
        let svc = if self.has_signer() {
            self.repo_service()?
        } else {
            RepoService::reader(self.client())
        };
        let cap = if private { sealed_cap(bytes) } else { bytes };
        let copies: Vec<PackManifestInfo> = svc
            .read_pack_copies(repo, sha256)
            .await?
            .into_iter()
            .filter(|m| {
                m.kind == u64::from(crate::pack::KIND_LONG_BODY)
                    && if private {
                        m.size_bytes <= cap
                    } else {
                        m.size_bytes == cap
                    }
            })
            .collect();
        if copies.is_empty() {
            return Err(Error::Config("no copy of it is recorded".into()));
        }
        let roles = svc.copy_roles(repo).await?;
        let refs: Vec<&PackManifestInfo> = copies.iter().collect();
        let reader = PackReader::from_user_config();
        let mut last = Error::Config("no copy could be read".into());
        for copy in order_copies(&refs, &roles) {
            let stored = match svc.fetch_artifact(repo, copy, &reader).await {
                Ok(b) => b,
                Err(e) => {
                    last = e;
                    continue;
                }
            };
            let plain = match svc
                .open_artifact_of(repo, &[copy], copy.size_bytes, stored)
                .await
            {
                Ok(p) => p,
                Err(e) => {
                    last = e;
                    continue;
                }
            };
            match long_body::open_text(bytes, &plain) {
                Ok(text) => return Ok(text),
                Err(e) => last = Error::Config(e.to_string()),
            }
        }
        Err(last)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_fields_hold_5120() {
        for f in [
            BodyField::Issue { title: "t" },
            BodyField::Comment { path: Some("a.rs") },
            BodyField::Review,
            BodyField::Release,
        ] {
            assert_eq!(f.room(Visibility::Public, None), FIELD_MAX);
        }
        assert_eq!(
            BodyField::Release.room(Visibility::Private, None),
            FIELD_MAX
        );
    }

    /// A field, its sealed kind, and the other plaintext the public writer would set.
    type Case<'s> = (BodyField<'s>, DocKind, &'s [(&'s str, &'s str)]);

    fn imported_field(i: &Imported) -> crate::platform::FieldValue {
        use crate::platform::FieldValue;
        let mut m = std::collections::BTreeMap::new();
        m.insert("author".to_string(), FieldValue::text(&i.author));
        m.insert("createdAt".to_string(), FieldValue::integer(i.created_at));
        m.insert("url".to_string(), FieldValue::text(&i.url));
        FieldValue::Object(m)
    }

    /// The private room is exactly what the sealer accepts: a body of `room` bytes seals, one
    /// byte more is refused.
    #[test]
    fn private_room_is_what_the_sealer_takes() {
        use crate::collab::private::seal_props;
        use crate::platform::FieldValue;
        use std::collections::BTreeMap;
        let keys = crate::private::EpochKeys::derive(
            &[3u8; 32],
            0,
            &crate::private::EpochKey::from_bytes([7u8; 32]),
        );
        let imported = Imported {
            author: "octocat".into(),
            created_at: 1,
            url: "https://github.com/o/r/issues/1".into(),
        };
        let cases: [Case<'_>; 4] = [
            (
                BodyField::Issue { title: "A title" },
                DocKind::Issue,
                &[("title", "A title")],
            ),
            (
                BodyField::Patch {
                    title: "T",
                    base_ref_name: "refs/heads/main",
                    source_ref_name: "refs/heads/feature",
                },
                DocKind::Patch,
                &[
                    ("title", "T"),
                    ("baseRefName", "refs/heads/main"),
                    ("sourceRefName", "refs/heads/feature"),
                ],
            ),
            (
                BodyField::Comment {
                    path: Some("src/lib.rs"),
                },
                DocKind::Comment,
                &[("path", "src/lib.rs")],
            ),
            (BodyField::Review, DocKind::Review, &[]),
        ];
        for (field, kind, others) in cases {
            for prov in [None, Some(&imported)] {
                let room = field.room(Visibility::Private, prov);
                let props = |n: usize| {
                    let mut p = BTreeMap::new();
                    for (k, v) in others {
                        p.insert((*k).to_string(), FieldValue::text(*v));
                    }
                    p.insert("body".to_string(), FieldValue::text("x".repeat(n)));
                    // what the associated data binds: the number, the target, the PR
                    p.insert("number".to_string(), FieldValue::integer(1));
                    p.insert("targetId".to_string(), FieldValue::bytes32([2; 32]));
                    p.insert("patchId".to_string(), FieldValue::bytes32([2; 32]));
                    if let Some(i) = prov {
                        p.insert("imported".to_string(), imported_field(i));
                    }
                    p
                };
                seal_props(&keys, kind, [1; 32], props(room))
                    .unwrap_or_else(|e| panic!("{kind:?} {room}: {e}"));
                assert!(
                    seal_props(&keys, kind, [1; 32], props(room + 1)).is_err(),
                    "{kind:?}: {} bytes sealed",
                    room + 1
                );
            }
        }
    }
}
