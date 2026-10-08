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
use crate::rules::v2::{Audience, Role, Visibility};
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
    /// document's other sealed text and an importer's `imported` author and URL (sealed too):
    /// [`Self::room_for`] of the repository's own audience (public, or members in a private
    /// repository).
    #[must_use]
    pub fn room(&self, visibility: Visibility, imported: Option<&Imported>) -> usize {
        self.room_for(visibility, Audience::Public, imported)
    }

    /// How many UTF-8 bytes of text the field holds in a document of a `visibility` repository
    /// written for `audience`: 5,120 for public text; the private-repository `enc` (v0x01)'s room
    /// in a private repository whatever `audience` says; and in a public repository a
    /// members-only document's (`enc` v0x03, whose 61 bytes of framing leave 32 bytes less; its
    /// padding is dropped when it does not fit, `private-repos.md` §4.1). A release's notes are
    /// 5,120 either way.
    #[must_use]
    pub fn room_for(
        &self,
        visibility: Visibility,
        audience: Audience,
        imported: Option<&Imported>,
    ) -> usize {
        let members = visibility == Visibility::Public && audience != Audience::Public;
        let kind = match self {
            _ if visibility == Visibility::Public && !members => return FIELD_MAX,
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
        let tlv = kind.max_enc()
            - if members {
                crate::private::doc::MIN_V3
            } else {
                crate::private::doc::MIN_V1
            };
        tlv.saturating_sub(3 + others + provenance).min(FIELD_MAX)
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
    ///
    /// `audience` is who the document carrying the field is for ([`Collab::new_audience`], or
    /// the stored document's for an edit; ignored in a private repository, where everything is
    /// sealed). A members-only text in a public repository is stored only sealed under the
    /// repository's members key, as a kind-70 artifact ([`crate::pack::KIND_MEMBERS_LONG_BODY`]):
    /// never where everyone can read it (DESIGN §4.1). Its field then holds the members-only
    /// room, and the trailer is sealed with the rest of the document.
    pub async fn store_long_body(
        &self,
        repo: &RepoRef,
        field: BodyField<'_>,
        imported: Option<&Imported>,
        full: &str,
        store: &BodyStore<'_>,
        audience: Audience,
    ) -> Result<String> {
        let room = field.room_for(repo.visibility, audience, imported);
        if !long_body::needs_artifact(full, room) {
            return Ok(full.to_string());
        }
        let members = repo.visibility == Visibility::Public && audience != Audience::Public;
        if audience == Audience::SpecificPeople {
            return Err(UserError::new(
                codes::USAGE,
                "writing to specific people is not supported yet",
            )
            .note("nothing was written")
            .into());
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
        // The field must hold the trailer, whose length does not depend on the hash: checked
        // before anything is stored and paid for.
        let no_room = || {
            Error::Config(format!(
                "a field of {room} bytes cannot hold the trailer naming the full text"
            ))
        };
        long_body::stored_text(full, room, &[0; 32]).ok_or_else(no_room)?;
        self.require_role(
            repo,
            Role::Writer,
            &format!(
                "post a text of {} bytes (a field holds {room}; a longer text is stored as a \
                 repository artifact, which only maintainers and writers may record)",
                full.len()
            ),
        )
        .await?;
        let hash = if members {
            // sealed here, under keys read now (§5.3): the plaintext never leaves this process
            let lane = self.members_writer(repo).await?.lane(repo)?;
            let sealed = lane.seal_artifact(full.as_bytes()).map_err(|_| {
                Error::Config("the members-only text could not be encrypted".into())
            })?;
            self.repo_service()?
                .store_members_long_body(
                    repo,
                    sealed,
                    &store.external,
                    store.platform,
                    store.required,
                )
                .await?
        } else {
            self.repo_service()?
                .store_long_body(
                    repo,
                    full.as_bytes(),
                    &store.external,
                    store.platform,
                    store.required,
                )
                .await?
        };
        long_body::stored_text(full, room, &hash).ok_or_else(no_room)
    }

    /// `stored` (a field as read: decrypted, in a private repository) as a reader shows it:
    /// the field itself when it has no trailer, else the full text its trailer names, fetched
    /// from any copy by the pack reader rule and checked (hash, length, UTF-8; opened and the
    /// late-content rule applied in a private repository). When that fails, the prefix and why.
    pub async fn read_long_body(&self, repo: &RepoRef, stored: &str) -> BodyRead {
        self.read_long_bodies(repo, &[stored])
            .await
            .pop()
            .unwrap_or_else(|| BodyRead::Whole(stored.to_string()))
    }

    /// [`Self::read_long_body`] of every field in `stored`, in order. The repository's
    /// manifests and members (what finds and orders the copies) are read once, and only when a
    /// field continues; the artifacts are fetched side by side.
    pub async fn read_long_bodies(&self, repo: &RepoRef, stored: &[&str]) -> Vec<BodyRead> {
        let public: Vec<(&str, Audience)> = stored.iter().map(|s| (*s, Audience::Public)).collect();
        self.read_long_bodies_for(repo, &public).await
    }

    /// [`Self::read_long_bodies`] of fields each read from a document for its audience: in a
    /// public repository a public field's trailer names a public artifact (kind 6) and a
    /// members-only field's names one sealed under the members key (kind 70), opened with the
    /// reader's keys; neither is taken for the other, so members-only text never shows under
    /// a public document. In a private repository the audience changes nothing.
    pub async fn read_long_bodies_for(
        &self,
        repo: &RepoRef,
        stored: &[(&str, Audience)],
    ) -> Vec<BodyRead> {
        let parsed: Vec<LongBody<'_>> = stored.iter().map(|(s, _)| long_body::parse(s)).collect();
        let continued = parsed
            .iter()
            .any(|p| matches!(p, LongBody::Continued { .. }));
        let shared = if continued {
            Some(self.copy_view(repo).await)
        } else {
            None
        };
        let reads = parsed.iter().zip(stored).map(|(p, (s, audience))| {
            let shared = shared.as_ref();
            async move {
                match *p {
                    LongBody::Plain => BodyRead::Whole((*s).to_string()),
                    LongBody::Unsupported { prefix } => BodyRead::Partial {
                        prefix: prefix.to_string(),
                        reason: "the rest is stored in a form this version cannot read".into(),
                    },
                    LongBody::Continued {
                        prefix,
                        sha256,
                        bytes,
                    } => {
                        let text = match shared {
                            Some(Ok(view)) => {
                                self.fetch_long_body(repo, view, (sha256, bytes), *audience)
                                    .await
                            }
                            Some(Err(e)) => Err(Error::Config(e.clone())),
                            None => Err(Error::Config("not read".into())),
                        };
                        match text {
                            Ok(text) => BodyRead::Whole(text),
                            Err(e) => BodyRead::Partial {
                                prefix: prefix.to_string(),
                                reason: format!(
                                    "the full text ({bytes} bytes) could not be read: {e}"
                                ),
                            },
                        }
                    }
                }
            }
        });
        futures::future::join_all(reads).await
    }

    /// What finding and ordering a long body's copies reads, once per page: the service, the
    /// repository's manifests and its members' current roles.
    async fn copy_view(&self, repo: &RepoRef) -> std::result::Result<CopyView<'_>, String> {
        let svc = if self.has_signer() {
            self.repo_service().map_err(|e| e.to_string())?
        } else {
            RepoService::reader(self.client())
        };
        let (manifests, roles) =
            futures::try_join!(svc.read_pack_manifests(repo), svc.copy_roles(repo))
                .map_err(|e| e.to_string())?;
        Ok(CopyView {
            svc,
            manifests,
            roles,
        })
    }

    async fn fetch_long_body(
        &self,
        repo: &RepoRef,
        view: &CopyView<'_>,
        (sha256, bytes): ([u8; 32], u64),
        audience: Audience,
    ) -> Result<String> {
        let private = repo.visibility == Visibility::Private;
        let members = !private && audience != Audience::Public;
        let sealed = private || members;
        let kind = if members {
            crate::pack::KIND_MEMBERS_LONG_BODY
        } else {
            crate::pack::KIND_LONG_BODY
        };
        let cap = if sealed { sealed_cap(bytes) } else { bytes };
        // A members-only document of a repository made public may have been written while it
        // was private (`private-repos.md` §18.1): its long body is then a kind-6 artifact
        // sealed under that era's key, which the same members keys open. A public field never
        // takes a sealed copy (its size is exact).
        let era_kind = members.then_some(u64::from(crate::pack::KIND_LONG_BODY));
        let copies: Vec<&PackManifestInfo> = view
            .manifests
            .iter()
            .filter(|m| {
                m.pack_hash == sha256
                    && (m.kind == u64::from(kind) || Some(m.kind) == era_kind)
                    && if sealed {
                        m.size_bytes <= cap
                    } else {
                        m.size_bytes == cap
                    }
            })
            .collect();
        if copies.is_empty() {
            return Err(Error::Config("no copy of it is recorded".into()));
        }
        let svc = &view.svc;
        let reader = PackReader::from_user_config();
        let mut last = Error::Config("no copy could be read".into());
        for copy in order_copies(&copies, &view.roles) {
            let stored = match svc.fetch_artifact(repo, copy, &reader).await {
                Ok(b) => b,
                Err(e) => {
                    last = e;
                    continue;
                }
            };
            // `fetch_artifact` checked the bytes against this manifest's `packHash` first
            let opened = if members {
                self.open_members_artifact(repo, copy, &stored).await
            } else {
                svc.open_artifact_of(repo, &[copy], copy.size_bytes, stored)
                    .await
            };
            let plain = match opened {
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

impl Collab<'_> {
    /// Open a members-only artifact of public `repo` (`sealed`, the bytes of `copy`, already
    /// checked against its `packHash`) with this reader's members keys, after the late-content
    /// rule: an artifact sealed under an old key by someone no longer a member after the key
    /// was rotated is not read (`docs/security/private-repos.md` §8.2).
    async fn open_members_artifact(
        &self,
        repo: &RepoRef,
        copy: &PackManifestInfo,
        sealed: &[u8],
    ) -> Result<Vec<u8>> {
        let kr = match self.lane_keys(repo).await? {
            super::v2::DocKeys::Held(kr, _) => kr,
            super::v2::DocKeys::None(_) => {
                return Err(Error::Config(
                    "it is members-only, and not readable with your keys".into(),
                ))
            }
        };
        let damaged = || Error::Config("the stored copy is damaged".into());
        let header = crate::private::PackHeader::parse(
            sealed
                .get(..crate::private::pack::HEADER_LEN)
                .ok_or_else(damaged)?,
            copy.size_bytes,
        )
        .map_err(|_| damaged())?;
        let readable = copy.created_at_block_height > 0
            && crate::platform::decode_identifier(&copy.owner_id).is_ok_and(|owner| {
                kr.resolution()
                    .manifest_standing(header.epoch(), copy.created_at_block_height, &owner)
                    .readable
            });
        if !readable {
            return Err(Error::Config(
                "it was stored under an old key after the key was rotated".into(),
            ));
        }
        kr.open_pack(repo, sealed, copy.size_bytes)
            .map_err(|_| Error::Config("it does not open with your keys".into()))
    }
}

/// A repository's manifests and members' roles, read once for every long body a page shows.
struct CopyView<'a> {
    svc: RepoService<'a>,
    manifests: Vec<PackManifestInfo>,
    roles: crate::repo::RoleMap,
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

    /// A members-only long body is kind 70 (64 + 6, DESIGN D6), and what the members key
    /// seals is within the size a reader accepts for a text of its length (`sealed_cap`), and
    /// opens again with that key only.
    #[test]
    fn a_members_only_long_body_is_sealed_within_the_readers_cap() {
        use crate::private::{EpochKey, EpochResolution, Lane};
        assert_eq!(crate::pack::KIND_MEMBERS_LONG_BODY, 70);
        assert_eq!(long_body::MAX_BYTES, 262_144);
        let mut res = EpochResolution::default();
        res.keys.insert(0, EpochKey::from_bytes([4; 32]));
        res.write_epoch = Some(0);
        let lane = Lane::from_resolution(&[8; 32], &res).unwrap();
        for len in [5_200usize, 70_000, 262_144] {
            let text = "m".repeat(len);
            let sealed = lane.seal_artifact(text.as_bytes()).unwrap();
            assert!(sealed.len() as u64 <= sealed_cap(len as u64), "{len}");
            assert!(!sealed.windows(64).any(|w| w == &text.as_bytes()[..64]));
            let opened = lane.open_artifact(&sealed, sealed.len() as u64).unwrap();
            assert_eq!(opened, text.as_bytes());
            let mut other = EpochResolution::default();
            other.keys.insert(0, EpochKey::from_bytes([5; 32]));
            other.write_epoch = Some(0);
            let stranger = Lane::from_resolution(&[8; 32], &other).unwrap();
            assert!(stranger
                .open_artifact(&sealed, sealed.len() as u64)
                .is_err());
        }
    }

    /// A members-only field in a public repository has the members-only room: less than a
    /// public one's, never more than the field.
    #[test]
    fn a_members_only_field_has_the_members_room() {
        let field = BodyField::Comment { path: None };
        let public = field.room_for(Visibility::Public, Audience::Public, None);
        let members = field.room_for(Visibility::Public, Audience::Members, None);
        assert_eq!(public, FIELD_MAX);
        assert!(members < public, "{members}");
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
