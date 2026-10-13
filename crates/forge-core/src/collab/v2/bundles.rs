//! Maintainers making other people's members-only discussion public (mixed-visibility DESIGN
//! §4.6, D5, §3.5; the format and reader rule are [`crate::private::bundle`]). A maintainer
//! publishes the per-object key `K_obj` of each post revision in a make-public bundle (a kind-7
//! artifact on Platform); every reader opens a bundled post with that key alone and shows it as
//! public, for members too. Readers honour only bundles by a current maintainer (or the owner),
//! only in a public repository, and only keys that commit to the revision they name: a lying entry
//! is an alert ([`BundleAlert`]) and is ignored.
//!
//! After a bundle covers a post, its author's later edits are written as Public
//! ([`Collab::bundled_edit`]), so the public and members never see different current text; a
//! post whose author sealed it again shows "edited after it was made public"
//! ([`PublicationState::EditedAfter`]).

use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex, PoisonError};

use super::{
    doc_kind, is_sealed, open_with, Collab, DocKeys, MembersOnly, DOC_COMMENT, DOC_ISSUE,
    DOC_REVIEW,
};
use crate::error::{Error, Result};
use crate::platform::{self, FetchedDocument, FieldValue};
use crate::private::bundle::{self, BundleRead, DocEntries};
use crate::private::{doc, named, DocKind, EpochKey, Opened};
use crate::rules::v2::{ContentKind, Role, Visibility};
use crate::scope::RepoRef;
use crate::user_error::{codes, UserError};

/// The most earlier revisions of one issue "Also publish earlier edits" reads.
const MAX_HISTORY: usize = 100;

/// What maintainers' bundles did to the documents a `Collab` read.
#[derive(Debug, Default)]
pub(super) struct BundleState {
    /// The honoured entries of one repository, by its id, read once.
    entries: Mutex<Option<([u8; 32], Arc<DocEntries>)>>,
    /// What each bundled document read is, by document id.
    publications: Mutex<BTreeMap<String, Publication>>,
    /// The lying entries met.
    alerts: Mutex<Vec<BundleAlert>>,
}

/// How a maintainer's bundle shows a document.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PublicationState {
    /// The revision read is public: shown to everyone as the bundle published it.
    Public,
    /// Its author sealed it again after it was made public (`published_revision` is the newest
    /// revision a bundle published): the current text is members-only.
    EditedAfter {
        /// The newest earlier revision a bundle published.
        published_revision: u32,
    },
}

/// A document a maintainer made public, as read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Publication {
    /// The maintainer whose bundle published it (base58).
    pub by: String,
    /// What the bundle does to the revision read.
    pub state: PublicationState,
}

/// A bundle entry whose key does not commit to the revision it names: ignored, and said.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct BundleAlert {
    /// The document it named (base58).
    pub document_id: String,
    /// The revision it named.
    pub revision: u32,
    /// The bundle's author (base58).
    pub by: String,
}

/// Why a post is left out of a maintainer's bundle.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LeftOutWhy {
    /// It is public already (written public, or a bundle covers its current revision).
    AlreadyPublic,
    /// The maintainer's keys do not open it.
    Unreadable,
    /// A message to specific people the maintainer was not sent.
    NotSent,
    /// Its text continues in a separate members-only artifact, which a bundle does not publish.
    LongBody,
    /// A pull request's own text (members-only PRs come with phase 3; its comments and reviews
    /// are bundled).
    PullRequest,
}

impl LeftOutWhy {
    /// The words for it.
    #[must_use]
    pub fn words(self) -> &'static str {
        match self {
            Self::AlreadyPublic => "it is public already",
            Self::Unreadable => "you can't read it with your keys",
            Self::NotSent => "it's a message that wasn't sent to you",
            Self::LongBody => "it's too long to make public this way",
            Self::PullRequest => "a pull request's own text can't be made public yet",
        }
    }
}

/// A post left out of a bundle, and why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LeftOut {
    /// What it is.
    pub kind: DocKind,
    /// Its document id.
    pub id: String,
    /// Its author.
    pub author: String,
    /// Why.
    pub why: LeftOutWhy,
}

/// A post a bundle makes public.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BundledPost {
    /// What it is.
    pub kind: DocKind,
    /// Its document id.
    pub id: String,
    /// Its author: whose words become public.
    pub author: String,
    /// An issue's number.
    pub number: Option<u32>,
    /// The revisions published, its current one last.
    pub revisions: Vec<u32>,
    /// A message to specific people (everyone will be able to read it).
    pub letter: bool,
}

/// What a maintainer's bundle will publish, read and checked before anything is signed.
#[derive(Debug, Clone)]
pub struct BundlePlan {
    /// The posts made public.
    pub posts: Vec<BundledPost>,
    /// The posts asked for that are left out.
    pub left_out: Vec<LeftOut>,
    entries: Vec<(u8, [u8; 32], u32, EpochKey)>,
}

impl BundlePlan {
    /// Every author whose words become public, sorted.
    #[must_use]
    pub fn authors(&self) -> BTreeSet<&str> {
        self.posts.iter().map(|p| p.author.as_str()).collect()
    }

    /// How many entries (post revisions) the bundle carries.
    #[must_use]
    pub fn entry_count(&self) -> usize {
        self.entries.len()
    }

    /// The bundle's size in bytes.
    #[must_use]
    pub fn size(&self) -> usize {
        bundle::HEADER_LEN + self.entries.len() * bundle::ENTRY_LEN
    }
}

/// The noun of a post kind.
#[must_use]
pub fn noun(kind: DocKind) -> &'static str {
    match kind {
        DocKind::Issue => "issue",
        DocKind::Patch => "pull request",
        DocKind::Review => "review",
        _ => "comment",
    }
}

/// `d`, a sealed document a bundle opened to `fields`, as the public codecs read a public one:
/// the text set, `enc` and `epoch` gone.
fn as_public(fields: crate::private::Fields, d: FetchedDocument) -> Option<FetchedDocument> {
    let mut out = super::private::open_doc(Opened::Readable(Box::new(fields)), d)?;
    out.fields.remove("enc");
    out.fields.remove("epoch");
    Some(out)
}

/// The revision of a fetched document, as a bundle entry names it.
fn revision_of(d: &FetchedDocument) -> u32 {
    d.revision
        .and_then(|r| u32::try_from(r).ok())
        .unwrap_or_default()
}

/// The outcome of a bundle over one sealed document.
enum Outcome {
    Public(FetchedDocument, String),
    EditedAfter(String, u32),
    None,
}

impl Collab<'_> {
    /// The honoured document entries of public `repo`'s bundles, read once per `Collab`. A read
    /// that fails publishes nothing and never fails the page.
    pub(super) async fn doc_entries(&self, repo: &RepoRef) -> Arc<DocEntries> {
        let Ok(scope) = repo.scope() else {
            return Arc::default();
        };
        if repo.visibility != Visibility::Public {
            return Arc::default();
        }
        let cached = self
            .bundles
            .entries
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_ref()
            .filter(|(id, _)| *id == scope.repo_id)
            .map(|(_, e)| Arc::clone(e));
        if let Some(e) = cached {
            return e;
        }
        let entries = match crate::repo::RepoService::reader(self.client)
            .doc_bundle_entries(repo)
            .await
        {
            Ok(e) => Arc::new(e),
            Err(e) => {
                tracing::warn!(error = %e, "the repository's make-public entries could not be read; members-only posts stay as they are");
                Arc::default()
            }
        };
        *self
            .bundles
            .entries
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = Some((scope.repo_id, Arc::clone(&entries)));
        entries
    }

    /// What a maintainer's bundle made of document `id` read by this `Collab`, if anything.
    #[must_use]
    pub fn publication(&self, id: &str) -> Option<Publication> {
        self.bundles
            .publications
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(id)
            .cloned()
    }

    /// The lying bundle entries the reads of this `Collab` met (each once).
    #[must_use]
    pub fn bundle_alerts(&self) -> Vec<BundleAlert> {
        let mut a = self
            .bundles
            .alerts
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        a.sort();
        a.dedup();
        a
    }

    fn note(&self, id: &str, publication: Publication) {
        self.bundles
            .publications
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(id.to_string(), publication);
    }

    /// The sealed `kind` document `d` of a repository with id `repo_id`, through `entries`.
    fn outcome(
        &self,
        repo_id: &[u8; 32],
        entries: &DocEntries,
        kind: DocKind,
        d: &FetchedDocument,
    ) -> Outcome {
        let (Ok(id), Some(enc), Some(header)) = (
            platform::decode_identifier(&d.id),
            d.field_bytes("enc"),
            crate::keyring::header_of(kind, d),
        ) else {
            return Outcome::None;
        };
        let mine = entries.of_doc(kind, &id);
        if mine.is_empty() {
            return Outcome::None;
        }
        let (read, mismatches) =
            bundle::read_revision(repo_id, &header, revision_of(d), &enc, mine);
        if !mismatches.is_empty() {
            let mut alerts = self
                .bundles
                .alerts
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            alerts.extend(mismatches.iter().map(|m| BundleAlert {
                document_id: d.id.clone(),
                revision: m.revision,
                by: platform::encode_identifier(m.by),
            }));
        }
        match read {
            BundleRead::Public { by, fields } => match as_public(*fields, d.clone()) {
                Some(doc) => Outcome::Public(doc, platform::encode_identifier(by)),
                None => Outcome::None,
            },
            BundleRead::EditedAfter { by, revision } => {
                Outcome::EditedAfter(platform::encode_identifier(by), revision)
            }
            BundleRead::None => Outcome::None,
        }
    }

    /// A document of public `repo` as the public codecs read it, per document (the public form
    /// of [`open_with`]): a maintainer's bundle first (a bundled post is public for everyone,
    /// members included), then the reader's own keys, else its placeholder.
    pub(super) fn open_read(
        &self,
        repo_id: &[u8; 32],
        entries: &DocEntries,
        keys: &DocKeys,
        kind: ContentKind,
        d: FetchedDocument,
    ) -> std::result::Result<FetchedDocument, MembersOnly> {
        if !is_sealed(&d) || entries.is_empty() {
            return open_with(keys, kind, d);
        }
        match self.outcome(repo_id, entries, doc_kind(kind), &d) {
            Outcome::Public(doc, by) => {
                self.note(
                    &doc.id,
                    Publication {
                        by,
                        state: PublicationState::Public,
                    },
                );
                Ok(doc)
            }
            Outcome::EditedAfter(by, published_revision) => {
                self.note(
                    &d.id,
                    Publication {
                        by,
                        state: PublicationState::EditedAfter { published_revision },
                    },
                );
                open_with(keys, kind, d)
            }
            Outcome::None => open_with(keys, kind, d),
        }
    }

    /// The text of issue `d` as a maintainer's bundle published it, when its author sealed it
    /// again afterwards (DESIGN §4.6: readers show the bundle's text): the published revision
    /// read from Platform's history of the issue (comments and reviews keep none). `None` when
    /// it is not an issue edited after it was made public, or the revision cannot be read.
    pub(super) async fn published_issue(
        &self,
        repo: &RepoRef,
        d: &FetchedDocument,
    ) -> Option<FetchedDocument> {
        let Some(Publication {
            by,
            state: PublicationState::EditedAfter { published_revision },
        }) = self.publication(&d.id)
        else {
            return None;
        };
        let repo_id = repo.scope().ok()?.repo_id;
        let entries = self.doc_entries(repo).await;
        let collab = self.collab_contract(repo).await.ok()?;
        let history = self
            .client
            .fetch_document_history(&collab, DOC_ISSUE, &d.id, MAX_HISTORY)
            .await
            .ok()?;
        let old = history
            .into_iter()
            .find(|h| revision_of(h) == published_revision)?;
        match self.outcome(&repo_id, &entries, DocKind::Issue, &old) {
            Outcome::Public(doc, _) => {
                self.note(
                    &d.id,
                    Publication {
                        by,
                        state: PublicationState::EditedAfter { published_revision },
                    },
                );
                Some(doc)
            }
            _ => None,
        }
    }

    /// The earlier revisions of issue `id` of public `repo` that maintainers' bundles made
    /// public ("Also publish earlier edits"), oldest first, each opened as the bundle published
    /// it with its maintainer. The current revision is not listed. Empty when none was.
    pub async fn published_issue_history(
        &self,
        repo: &RepoRef,
        id: &str,
    ) -> Result<Vec<(FetchedDocument, String)>> {
        let entries = self.doc_entries(repo).await;
        let Ok(doc_id) = platform::decode_identifier(id) else {
            return Ok(Vec::new());
        };
        if entries.of_doc(DocKind::Issue, &doc_id).is_empty() {
            return Ok(Vec::new());
        }
        let repo_id = repo.scope()?.repo_id;
        let collab = self.collab_contract(repo).await?;
        let mut history = self
            .client
            .fetch_document_history(&collab, DOC_ISSUE, id, MAX_HISTORY)
            .await?;
        history.pop();
        Ok(history
            .into_iter()
            .filter(is_sealed)
            .filter_map(|h| match self.outcome(&repo_id, &entries, DocKind::Issue, &h) {
                Outcome::Public(doc, by) => Some((doc, by)),
                _ => None,
            })
            .collect())
    }

    /// Whether a maintainer's bundle covers any revision of the signer's sealed `kind` document
    /// `stored`: then an edit of it is written as Public (DESIGN §4.6, "after a bundle").
    pub(super) async fn bundle_covers(
        &self,
        repo: &RepoRef,
        kind: DocKind,
        stored: &FetchedDocument,
    ) -> Option<String> {
        if repo.visibility != Visibility::Public || !is_sealed(stored) {
            return None;
        }
        let id = platform::decode_identifier(&stored.id).ok()?;
        let entries = self.doc_entries(repo).await;
        entries
            .of_doc(kind, &id)
            .first()
            .map(|e| platform::encode_identifier(e.by))
    }

    /// The changes that write the signer's edit `changes` of their sealed `kind` document
    /// `stored`, which a maintainer's bundle made public (by `by`), as Public: the post opened
    /// (with the signer's keys, else the bundle's key of its current revision), `changes`
    /// applied, then the author's edit to Public ([`crate::rules::v2::make_public_changes`]:
    /// the text set in plaintext, `enc` and `epoch` removed).
    pub(super) async fn bundled_edit(
        &self,
        repo: &RepoRef,
        kind: DocKind,
        stored: &FetchedDocument,
        changes: &BTreeMap<String, Option<FieldValue>>,
        by: &str,
    ) -> Result<BTreeMap<String, Option<FieldValue>>> {
        let ck = super::content_kind_of(kind).ok_or(Error::NotFound)?;
        let opened = match self.lane_keys(repo).await? {
            DocKeys::Held(kr, _) => match kr.open(kind, stored) {
                Opened::Readable(f) => Some(*f),
                _ => None,
            },
            DocKeys::None(_) => None,
        };
        let opened = if let Some(f) = opened {
            f
        } else {
            {
                let repo_id = repo.scope()?.repo_id;
                let entries = self.doc_entries(repo).await;
                match self.outcome(&repo_id, &entries, kind, stored) {
                    Outcome::Public(doc, _) => fields_of(&doc),
                    _ => {
                        return Err(UserError::new(
                            codes::NOT_A_KEY_HOLDER,
                            format!(
                                "this {} can't be read with your keys, so it can't be edited",
                                noun(kind)
                            ),
                        )
                        .note("nothing was written")
                        .into())
                    }
                }
            }
        };
        let mut opened = opened;
        for (k, v) in changes {
            let v = v.as_ref().and_then(FieldValue::as_str).map(str::to_owned);
            match k.as_str() {
                "title" => opened.title = v,
                "body" => opened.body = v,
                _ => {}
            }
        }
        let made = crate::rules::v2::make_public_changes(ck, &opened).map_err(|_| {
            Error::from(
                UserError::new(
                    codes::USAGE,
                    format!(
                        "@{by} made this {} public, so an edit of it is public too, and this one can't be",
                        noun(kind)
                    ),
                )
                .note("checked before anything was signed; nothing was written or paid"),
            )
        })?;
        let mut out: BTreeMap<String, Option<FieldValue>> = made
            .set
            .iter()
            .map(|(k, v)| (k.clone(), Some(FieldValue::text(v))))
            .collect();
        for f in &made.remove {
            out.insert(f.clone(), None);
        }
        Ok(out)
    }

    /// The posts the maintainer's bundle recorded by the kind-7 manifest document `manifest`
    /// made public, each as everyone reads it now (its current revision opened by the bundle's
    /// key), for the authors' notifications (DESIGN §4.6). Empty when the bundle is not one
    /// readers honour (a writer's, or in a private repository), or a post it names has changed
    /// since (its author sealed it again: nothing new is public).
    pub async fn bundle_publications(
        &self,
        repo: &RepoRef,
        manifest: &FetchedDocument,
    ) -> Result<Vec<(DocKind, FetchedDocument)>> {
        let Some(published) = crate::repo::RepoService::reader(self.client)
            .bundle_of_manifest(repo, manifest)
            .await?
        else {
            return Ok(Vec::new());
        };
        let entries = self.doc_entries(repo).await;
        let Ok(parsed) = bundle::parse(&published.bytes) else {
            return Ok(Vec::new());
        };
        let repo_id = repo.scope()?.repo_id;
        let collab = self.collab_contract(repo).await?;
        let mut out = Vec::new();
        let mut seen = BTreeSet::new();
        for e in parsed.entries {
            let (kind, doc_type) = match e.kind {
                bundle::ENTRY_COMMENT => (DocKind::Comment, DOC_COMMENT),
                bundle::ENTRY_ISSUE => (DocKind::Issue, DOC_ISSUE),
                bundle::ENTRY_REVIEW => (DocKind::Review, DOC_REVIEW),
                _ => continue,
            };
            // honoured only when its author is a maintainer: then `entries` holds it
            if !entries
                .of_doc(kind, &e.target)
                .iter()
                .any(|h| h.by == published.owner && h.revision == e.revision)
            {
                continue;
            }
            let id = platform::encode_identifier(e.target);
            if !seen.insert(id.clone()) {
                continue;
            }
            let Some(d) = self.client.fetch_document(&collab, doc_type, &id).await? else {
                continue;
            };
            if let Outcome::Public(doc, by) = self.outcome(&repo_id, &entries, kind, &d) {
                if platform::decode_identifier(&by).ok() == Some(published.owner) {
                    out.push((kind, doc));
                }
            }
        }
        Ok(out)
    }

    // --- writing a bundle --------------------------------------------------------------------

    /// Plan a maintainer's bundle making `posts` (each a document of `repo` and its kind) public:
    /// every post's current revision, and with `history` every earlier members-only revision of
    /// an issue the signer can open (Platform keeps an issue's history). Refused before anything
    /// is signed unless `repo` is public and the signer a current maintainer (or the owner); a
    /// post that is public already, that the signer cannot read (a message not sent to them),
    /// whose text continues in a members-only long-body artifact, or a PR's own text, is left
    /// out ([`BundlePlan::left_out`]). Errors when nothing is left to publish.
    pub async fn bundle_plan(
        &self,
        repo: &RepoRef,
        posts: Vec<(DocKind, FetchedDocument)>,
        history: bool,
    ) -> Result<BundlePlan> {
        self.require_bundle_writer(repo).await?;
        let repo_id = repo.scope()?.repo_id;
        let entries = self.doc_entries(repo).await;
        let keys = self.lane_keys(repo).await?;
        let collab = self.collab_contract(repo).await?;
        let mut plan = BundlePlan {
            posts: Vec::new(),
            left_out: Vec::new(),
            entries: Vec::new(),
        };
        let mut seen = BTreeSet::new();
        for (kind, d) in posts {
            if !seen.insert(d.id.clone()) {
                continue;
            }
            let leave = |why| LeftOut {
                kind,
                id: d.id.clone(),
                author: d.owner_id.clone(),
                why,
            };
            let covered = matches!(
                self.outcome(&repo_id, &entries, kind, &d),
                Outcome::Public(..)
            );
            if !is_sealed(&d) || covered {
                plan.left_out.push(leave(LeftOutWhy::AlreadyPublic));
                continue;
            }
            let Some(entry_kind) = bundle::entry_kind(kind) else {
                plan.left_out.push(leave(LeftOutWhy::PullRequest));
                continue;
            };
            let target = platform::decode_identifier(&d.id)?;
            let letter = d.field_bytes("enc").and_then(|e| e.first().copied()) == Some(doc::V4);
            let key = match self.post_key(repo, &keys, kind, &d).await {
                Ok(k) => k,
                Err(why) => {
                    plan.left_out.push(leave(why));
                    continue;
                }
            };
            let mut revisions = Vec::new();
            if history && kind == DocKind::Issue && !letter {
                let mut old = self
                    .client
                    .fetch_document_history(&collab, DOC_ISSUE, &d.id, MAX_HISTORY)
                    .await?;
                old.retain(|h| revision_of(h) < revision_of(&d) && is_sealed(h));
                for h in old {
                    if let Ok(k) = self.post_key(repo, &keys, kind, &h).await {
                        plan.entries.push((entry_kind, target, revision_of(&h), k));
                        revisions.push(revision_of(&h));
                    }
                }
            }
            plan.entries
                .push((entry_kind, target, revision_of(&d), key));
            revisions.push(revision_of(&d));
            plan.posts.push(BundledPost {
                kind,
                id: d.id.clone(),
                author: d.owner_id.clone(),
                number: d.field_u64("number").and_then(|n| u32::try_from(n).ok()),
                revisions,
                letter,
            });
        }
        if plan.posts.is_empty() {
            let why = plan
                .left_out
                .iter()
                .map(|l| format!("{} {}: {}", noun(l.kind), l.id, l.why.words()))
                .collect::<Vec<_>>()
                .join("; ");
            return Err(UserError::new(codes::USAGE, "there is nothing to make public")
                .cause(why)
                .note("checked before anything was signed; nothing was written or paid")
                .into());
        }
        if plan.entries.len() > bundle::MAX_DOC_ENTRIES {
            return Err(UserError::new(
                codes::USAGE,
                format!(
                    "that is {} posts and earlier versions; at most {} can be made public at once",
                    plan.entries.len(),
                    bundle::MAX_DOC_ENTRIES
                ),
            )
            .fix("make fewer posts public at a time")
            .note("nothing was written")
            .into());
        }
        Ok(plan)
    }

    /// Write the planned bundle: its bytes stored on Platform with a kind-7 manifest. Returns
    /// the manifest's document id. The signer's role is checked again first.
    pub async fn write_bundle(&self, repo: &RepoRef, plan: &BundlePlan) -> Result<String> {
        self.require_bundle_writer(repo).await?;
        let bytes = bundle::encode_doc_bundle(&plan.entries).map_err(|e| {
            Error::from(UserError::new(
                codes::USAGE,
                format!("the posts could not be made public: {e}"),
            ))
        })?;
        let (id, _) = self
            .repo_service()?
            .store_make_public_bundle(repo, &bytes)
            .await?;
        *self
            .bundles
            .entries
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = None;
        Ok(id)
    }

    /// Refuse, before signing, a bundle from anyone but a current maintainer (or the owner) of
    /// public `repo` (DESIGN §3.5: other people's words go public only through a maintainer;
    /// readers ignore anyone else's, and on mainnet consensus refuses it, C3).
    async fn require_bundle_writer(&self, repo: &RepoRef) -> Result<()> {
        if repo.visibility != Visibility::Public {
            return Err(UserError::new(
                codes::USAGE,
                format!(
                    "{} is private: its posts can't be made public one at a time",
                    repo.display()
                ),
            )
            .cause("everything in a private repository is for its members")
            .note("checked before anything was signed; nothing was written or paid")
            .into());
        }
        let me = self.signer_id()?;
        if me == repo.owner_id() || self.signer_role(repo).await? == Some(Role::Maintainer) {
            return Ok(());
        }
        Err(UserError::new(
            codes::NOT_A_WRITER,
            "Only maintainers can make other people's posts public.",
        )
        .fix("ask a maintainer")
        .note("checked before anything was signed; nothing was written or paid")
        .into())
    }

    /// The per-object key of the signer's view of sealed post `d`: a members-only post opened
    /// with the members key, a message to specific people from the signer's own slot; or why it
    /// is left out.
    async fn post_key(
        &self,
        repo: &RepoRef,
        keys: &DocKeys,
        kind: DocKind,
        d: &FetchedDocument,
    ) -> std::result::Result<EpochKey, LeftOutWhy> {
        let enc = d.field_bytes("enc").ok_or(LeftOutWhy::AlreadyPublic)?;
        let key = match enc.first() {
            Some(&doc::V3) => {
                let DocKeys::Held(kr, _) = keys else {
                    return Err(LeftOutWhy::Unreadable);
                };
                if let Opened::Readable(f) = kr.open(kind, d) {
                    if long_body(&f) {
                        return Err(LeftOutWhy::LongBody);
                    }
                }
                kr.obj_key(kind, d).ok_or(LeftOutWhy::Unreadable)?
            }
            Some(&doc::V4) => self
                .letter_key(repo, kind, d, &enc)
                .await
                .ok_or(LeftOutWhy::NotSent)?,
            _ => return Err(LeftOutWhy::Unreadable),
        };
        Ok(EpochKey::from_bytes(*key))
    }

    /// The key of the message `d` (`enc` v0x04) unwrapped from the signer's own slot, after the
    /// whole letter reader rule with its author's keys; `None` when it was not sent to the
    /// signer.
    async fn letter_key(
        &self,
        repo: &RepoRef,
        kind: DocKind,
        d: &FetchedDocument,
        enc: &[u8],
    ) -> Option<zeroize::Zeroizing<[u8; 32]>> {
        let (identity, bridge) = self.signer().ok()?;
        let signer = crate::keyring::PrivateSigner {
            client: self.client,
            identity,
            bridge,
        };
        let secrets = signer.encryption_keys(repo).private_keys();
        let author = self.client.fetch_identity(&d.owner_id).await.ok()?;
        let owner_keys = crate::env::codec::owner_keys(&author.public_keys());
        let header = crate::keyring::header_of(kind, d)?;
        let reader = named::Reader {
            identity_id: platform::decode_identifier(&identity.id()).ok()?,
            keys: &secrets,
        };
        let repo_id = repo.scope().ok()?.repo_id;
        named::letter_obj_key(&repo_id, &header, enc, &owner_keys, &reader)
    }

    /// Every post of the thread of issue or PR `target` (its document) a maintainer's bundle
    /// can make public: the issue itself, and every comment and review on it (a PR's own text
    /// is left out by [`Self::bundle_plan`]).
    pub async fn thread_posts(
        &self,
        repo: &RepoRef,
        kind: DocKind,
        target: FetchedDocument,
    ) -> Result<Vec<(DocKind, FetchedDocument)>> {
        let collab = self.collab_contract(repo).await?;
        let mut out = Vec::new();
        let target_id = target.id.clone();
        out.push((kind, target));
        let comments = self
            .by_target(&collab, DOC_COMMENT, "targetId", &target_id)
            .await?;
        out.extend(comments.into_iter().map(|c| (DocKind::Comment, c)));
        if kind == DocKind::Patch {
            let reviews = self
                .by_target(&collab, DOC_REVIEW, "patchId", &target_id)
                .await?;
            out.extend(reviews.into_iter().map(|r| (DocKind::Review, r)));
        }
        Ok(out)
    }
}

/// Whether opened `fields` carry a text that continues in a separate artifact (a long body's
/// trailer): a bundle publishes the document, not that artifact (DESIGN decision P2B-D4).
fn long_body(fields: &crate::private::Fields) -> bool {
    fields
        .body
        .as_deref()
        .is_some_and(|b| crate::rules::long_body::parse(b) != crate::rules::long_body::LongBody::Plain)
}

/// The content fields of a document in its public form (as [`as_public`] made it).
fn fields_of(d: &FetchedDocument) -> crate::private::Fields {
    crate::private::Fields {
        title: d.field_str("title"),
        body: d.field_str("body"),
        path: d.field_str("path"),
        ..crate::private::Fields::default()
    }
}
