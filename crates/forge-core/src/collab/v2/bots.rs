//! Bot access (mixed-visibility DESIGN §4.9, D33; `docs/security/private-repos.md` §22): the
//! access notices maintainers write (kind 11, [`crate::private::access_notice`]), asking a bot to
//! work on an issue or pull request (event kind 27, [`crate::rules::agent_request`]) with the
//! `read` key letter (kind 10, [`ReadLetter`]) that hands it the thread as it is at that moment,
//! and the bot's side: the requests addressed to it and the thread a letter opens.
//!
//! The default stays: a bot reads nothing members-only. A `read` letter carries the per-object
//! key of each members-only revision the asker opened (and of the request itself), so the bot
//! opens exactly those revisions; a comment written or edited later is under a key it was never
//! given.

use std::collections::{BTreeMap, BTreeSet};

use super::{is_sealed, Collab, DocKeys, Target, TargetKind, TargetRead, DOC_EVENT};
use crate::error::{Error, Result};
use crate::key_letters::{self, LetterReader};
use crate::platform::{self, FetchedDocument, FieldValue, QueryFilter, QueryOrder};
use crate::private::access_notice::{AccessNotice, NoticeEntry, MAY_READ_ON_REQUEST};
use crate::private::key_letter::{
    self, LetterDoc, LetterHead, LetterPack, ReadLetter, ReadTarget, TypedLetter,
};
use crate::private::named::{self, Recipient};
use crate::private::pack::{self as sealed_pack, Head};
use crate::private::{doc, DocKind, Fields, Opened};
use crate::rules::agent_request::{self, AgentRequest, AskRefusal, RequestEvent};
use crate::rules::v2::{Audience, Role, Visibility};
use crate::scope::RepoRef;
use crate::user_error::{codes, UserError};

/// A repository's access notices as this reader reads them.
#[derive(Debug, Clone, Default)]
pub struct Notices {
    /// Every notice that read, whoever wrote it, oldest first.
    pub all: Vec<NoticeEntry>,
    /// The notice that counts for each bot (by its id): the newest from a current maintainer.
    pub current: BTreeMap<[u8; 32], NoticeEntry>,
    /// Kind-11 manifests this reader could not read: sealed for others, damaged, malformed.
    pub unreadable: usize,
}

impl Notices {
    /// The notice that counts for bot `bot` (base58), if any.
    #[must_use]
    pub fn for_bot(&self, bot: &str) -> Option<&NoticeEntry> {
        let id = platform::decode_identifier(bot).ok()?;
        self.current.get(&id)
    }
}

/// Why a members-only post of the thread is not in a `read` letter.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum NotShared {
    /// A message to specific people: never forwarded to a bot (DESIGN §4.9, review-rev4 M-11).
    Letter,
    /// Written under the repository's older envelope (v0x01), which has no key of its own.
    Older,
    /// The asker cannot open it.
    Unreadable,
}

/// The members-only code a `read` letter hands on: a members-only branch's head and the packs
/// that hold its commits beyond the public branches, with their file keys (built in a clone, as
/// `dg branch share` builds a `branch` letter).
#[derive(Clone)]
pub struct SharedCode {
    /// The branch's short name.
    pub branch: String,
    /// Its head.
    pub head: LetterHead,
    /// The packs, sorted by `packHash`.
    pub packs: Vec<LetterPack>,
}

/// It carries file keys: `Debug` shows the branch and the pack count only.
impl std::fmt::Debug for SharedCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SharedCode")
            .field("branch", &self.branch)
            .field("packs", &self.packs.len())
            .finish_non_exhaustive()
    }
}

/// What asking a bot will write, planned before anything is signed ([`Collab::plan_ask`]).
#[derive(Debug, Clone)]
pub struct AskPlan {
    /// The issue or pull request.
    pub target: Target,
    /// The bot (base58).
    pub bot: String,
    /// The task.
    pub task: String,
    /// Whether the thread itself is members-only (the task is then sealed).
    pub members_only: bool,
    /// The AI service the bot's notice names.
    pub processor: Option<String>,
    /// The `read` letter, when the bot may read on request and the thread holds members-only
    /// posts or code.
    pub letter: Option<LetterPlan>,
}

/// The `read` letter of an [`AskPlan`].
#[derive(Clone)]
pub struct LetterPlan {
    /// The members-only revisions it opens, with their kinds.
    pub docs: Vec<(DocKind, LetterDoc)>,
    /// The members-only code.
    pub code: Option<SharedCode>,
    /// The members-only posts left out, and why.
    pub left_out: Vec<(DocKind, String, NotShared)>,
    /// The bot's encryption key.
    bot_key: [u8; 33],
}

/// It carries keys: `Debug` shows counts only.
impl std::fmt::Debug for LetterPlan {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LetterPlan")
            .field("docs", &self.docs.len())
            .field("code", &self.code)
            .field("left_out", &self.left_out.len())
            .finish_non_exhaustive()
    }
}

impl LetterPlan {
    /// How many of its documents are of `kind`.
    #[must_use]
    pub fn count(&self, kind: DocKind) -> usize {
        self.docs.iter().filter(|(k, _)| *k == kind).count()
    }
}

/// What [`Collab::write_ask`] wrote.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Asked {
    /// The request's event id (the job).
    pub event: String,
    /// The `read` letter's manifest id, if one was written.
    pub letter: Option<String>,
}

/// One post of a job's thread as the bot reads it.
#[derive(Debug, Clone)]
pub struct JobPost {
    /// What it is.
    pub kind: DocKind,
    /// Its document id.
    pub id: String,
    /// Its author.
    pub author: String,
    /// When it was written (ms).
    pub created_at: u64,
    /// What the bot reads of it.
    pub content: JobContent,
}

/// What the bot reads of one post.
#[derive(Debug, Clone)]
pub enum JobContent {
    /// The text: public, or members-only and opened with the letter's key.
    Text {
        /// The fields.
        fields: Box<Fields>,
        /// Whether it was members-only.
        members_only: bool,
    },
    /// Members-only and not in the letter: written or edited after the request, or never
    /// shared.
    NotShared,
    /// Public, but written after the request: not part of the job.
    After,
}

/// A `read` letter addressed to the reader.
#[derive(Clone)]
pub struct ReceivedRead {
    /// Its manifest id.
    pub id: String,
    /// Who wrote it.
    pub sender: String,
    /// When (ms).
    pub created_at: u64,
    /// The letter.
    pub letter: ReadLetter,
}

/// It carries keys: `Debug` shows the letter's counts only.
impl std::fmt::Debug for ReceivedRead {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ReceivedRead")
            .field("id", &self.id)
            .field("letter", &self.letter)
            .finish_non_exhaustive()
    }
}

/// A job as its bot reads it ([`Collab::read_job`]).
#[derive(Debug, Clone)]
pub struct JobRead {
    /// The request, its task opened with the letter when it is members-only.
    pub request: AgentRequest,
    /// The newest `read` letter from the asker naming this job, if any.
    pub letter: Option<ReceivedRead>,
    /// The thread: the issue or pull request first, then its comments and reviews, oldest
    /// first.
    pub posts: Vec<JobPost>,
}

/// The E813 error for `refusal` of asking `bot` (as the copy names it, `@ci-bot`), before
/// anything was signed.
#[must_use]
pub fn ask_refused(refusal: &AskRefusal, bot: &str, repo: &RepoRef) -> Error {
    let until = match refusal {
        AskRefusal::Ended { until } => crate::private::access_notice::date_words(*until),
        _ => String::new(),
    };
    let (msg, fix) = refusal.words(bot, &repo.display(), &until);
    UserError::new(codes::AGENT_NOT_ALLOWED, msg)
        .fix(fix)
        .note("checked before anything was signed; nothing was sent to the bot")
        .into()
}

/// A plaintext document's text fields.
fn text_fields(d: &FetchedDocument) -> Fields {
    Fields {
        title: d.field_str("title"),
        body: d.field_str("body"),
        path: d.field_str("path"),
        event_value: d.field_str("value"),
        ..Fields::default()
    }
}

fn revision_of(d: &FetchedDocument) -> u64 {
    d.revision.unwrap_or(1)
}

impl Collab<'_> {
    /// The signer's role as the access copy counts it: the owner as a maintainer.
    async fn asker_role(&self, repo: &RepoRef) -> Result<Option<Role>> {
        if self.signer_id()? == repo.owner_id() {
            return Ok(Some(Role::Maintainer));
        }
        self.signer_role(repo).await
    }

    /// The signer as a writer of artifacts to specific people.
    fn private_signer(&self) -> Result<crate::keyring::PrivateSigner<'_>> {
        let (identity, bridge) = self.signer()?;
        Ok(crate::keyring::PrivateSigner {
            client: self.client,
            identity,
            bridge,
        })
    }

    /// Every access notice of `repo` this reader can read (§22.1): the kind-11 artifacts,
    /// checked against their `packHash`, read as plaintext in a public repository, or opened
    /// with the members key (the members' copy) or the reader's own keys (the bot's letter) in a
    /// private one; and the one that counts per bot: the newest by a current maintainer or the
    /// owner.
    pub async fn access_notices(&self, repo: &RepoRef) -> Result<Notices> {
        let svc = self.repo_service()?;
        let kind = u64::from(crate::pack::KIND_ACCESS_NOTICE);
        let manifests: Vec<_> = svc
            .read_pack_manifests(repo)
            .await?
            .into_iter()
            .filter(|m| m.kind == kind)
            .collect();
        if manifests.is_empty() {
            return Ok(Notices::default());
        }
        let roles = svc.copy_roles(repo).await?;
        let store = crate::storage::PackReader::from_user_config();
        let repo_id = repo.scope()?.repo_id;
        let private = repo.visibility == Visibility::Private;
        let keyring = if private {
            self.keyring(repo).await.ok()
        } else {
            None
        };
        let reader = if private {
            self.private_signer()
                .ok()
                .and_then(|s| key_letters::signer_reader_keys(&s, repo).ok())
        } else {
            None
        };
        let mut out = Notices::default();
        // read_pack_manifests is newest first
        for m in manifests.iter().rev() {
            let bytes = match svc.fetch_artifact(repo, m, &store).await {
                Ok(b) if crate::private::keys::sha256(&b) == m.pack_hash => b,
                Ok(_) | Err(_) => {
                    out.unreadable += 1;
                    continue;
                }
            };
            // a copy this reader is not meant to open (the members' copy for a bot, the bot's
            // letter for a member) is skipped, never counted as unreadable
            let plain: Option<zeroize::Zeroizing<Vec<u8>>> = match sealed_pack::sniff(&bytes) {
                Head::Plain if !private => Some(zeroize::Zeroizing::new(bytes)),
                Head::Sealed { .. } if private => {
                    match keyring.as_ref().filter(|kr| !kr.resolution().keys.is_empty()) {
                        Some(kr) => kr.open_pack(repo, &bytes, m.size_bytes).ok().map(zeroize::Zeroizing::new),
                        None => continue,
                    }
                }
                Head::OtherVersion(named::ARTIFACT_VERSION) if private => {
                    let Some((id, keys)) = &reader else {
                        continue;
                    };
                    let owner_keys = self.owner_keys_of(&m.owner_id).await?;
                    match named::open_artifact(
                        &repo_id,
                        &bytes,
                        m.size_bytes,
                        &owner_keys,
                        &named::Reader {
                            identity_id: *id,
                            keys,
                        },
                    ) {
                        Ok(p) => Some(p),
                        Err(named::ArtifactError::NotARecipient) => continue,
                        Err(_) => None,
                    }
                }
                _ => None,
            };
            let notice = plain
                .as_deref()
                .and_then(|p| TypedLetter::decode(p))
                .and_then(|t| AccessNotice::from_typed(&t));
            match notice {
                Some(notice) => out.all.push(NoticeEntry {
                    id: m.document_id.clone(),
                    writer: m.owner_id.clone(),
                    created_at: m.created_at,
                    pack_hash: m.pack_hash,
                    notice,
                }),
                None => out.unreadable += 1,
            }
        }
        let owner = repo.owner_id().to_owned();
        out.current = crate::private::access_notice::current(&out.all, |w| {
            w == owner || roles.get(w) == Some(&Role::Maintainer)
        })
        .into_iter()
        .map(|(bot, e)| (bot, e.clone()))
        .collect();
        Ok(out)
    }

    /// Write `notice` as `repo`'s current access notice for its bot (§22.1): a maintainer or the
    /// owner only (refused before signing otherwise; on the registered contract consensus
    /// refuses anyone else too, C3). Plaintext in a public repository; in a private one, two
    /// kind-11 copies: sealed under the members key, and a letter to the bot and the writer.
    /// Returns the manifest ids (the members' or public copy first) and that copy's `packHash`.
    pub async fn write_access_notice(
        &self,
        repo: &RepoRef,
        notice: &AccessNotice,
    ) -> Result<(Vec<String>, [u8; 32])> {
        self.require_notice_writer(repo).await?;
        let plain = notice.encode().map_err(|e| {
            Error::from(UserError::new(
                codes::USAGE,
                format!("the access could not be written: {e}"),
            ))
        })?;
        let svc = self.repo_service()?;
        if repo.visibility == Visibility::Public {
            let (id, hash) = svc.store_access_notice(repo, &plain).await?;
            return Ok((vec![id], hash));
        }
        let kr = self.keyring(repo).await?;
        let members = crate::private::pack::seal(kr.writer(repo)?.write_keys(), &plain)
            .map_err(|e| Error::Config(format!("sealing the access notice: {e}")))?;
        let bot = platform::encode_identifier(notice.bot);
        let bot_key = self.bot_key(repo, &bot).await?;
        let to_bot = self.seal_to_bot(repo, &bot, bot_key, &plain, false)?;
        let (first, hash) = svc.store_access_notice(repo, &members).await?;
        let (second, _) = svc.store_access_notice(repo, &to_bot).await?;
        Ok((vec![first, second], hash))
    }

    /// Seal `plain` to the signer (slot 0) and `bot`, whose encryption key is `bot_key`: a key
    /// letter (`letter`) or a bot's copy of a notice, both DFPK 0x02 artifacts.
    fn seal_to_bot(
        &self,
        repo: &RepoRef,
        bot: &str,
        bot_key: [u8; 33],
        plain: &[u8],
        letter: bool,
    ) -> Result<Vec<u8>> {
        let signer = self.private_signer()?;
        let enc = signer.encryption_keys(repo);
        let (sender_key_id, sender) = enc
            .sender()
            .ok_or_else(|| crate::keyring::no_members_encryption_key_held("write to the bot"))?;
        let me = platform::decode_identifier(&signer.identity.id())?;
        let recipients = [
            Recipient {
                identity_id: me,
                public_key: sender.public_key(),
            },
            Recipient {
                identity_id: platform::decode_identifier(bot)?,
                public_key: bot_key,
            },
        ];
        let repo_id = repo.scope()?.repo_id;
        let sealed = if letter {
            let typed = TypedLetter::decode(plain)
                .ok_or_else(|| Error::Config("the letter for the bot is not well formed".into()))?;
            key_letter::seal(&repo_id, sender, sender_key_id, &me, &recipients, &typed)
        } else {
            named::seal_artifact(&repo_id, sender, sender_key_id, &me, &recipients, plain)
        };
        sealed.map_err(|e| Error::Config(format!("sealing for the bot: {e}")))
    }

    /// Whether identity `who` has an encryption key anything members-only can be sent to.
    pub async fn has_encryption_key(&self, repo: &RepoRef, who: &str) -> Result<bool> {
        Ok(self.recipient_key_of(repo, who).await?.is_some())
    }

    /// The bot's encryption key, or a refusal before anything is signed.
    async fn bot_key(&self, repo: &RepoRef, bot: &str) -> Result<[u8; 33]> {
        self.recipient_key_of(repo, bot).await?.ok_or_else(|| {
            UserError::new(
                codes::NO_ENCRYPTION_KEY,
                "the bot has no encryption key, so nothing members-only can be sent to it",
            )
            .fix("ask its operator to add one: `dg auth keys add --encryption`")
            .note("checked before anything was signed")
            .into()
        })
    }

    /// Refuse, before signing, a notice from anyone but a current maintainer or the owner.
    async fn require_notice_writer(&self, repo: &RepoRef) -> Result<()> {
        if self.asker_role(repo).await? == Some(Role::Maintainer) {
            return Ok(());
        }
        Err(UserError::new(
            codes::NOT_A_WRITER,
            "Only maintainers can change what a bot may do.",
        )
        .fix("ask a maintainer")
        .note("checked before anything was signed; nothing was written or paid")
        .into())
    }

    /// Plan asking bot `bot` (base58; `name` is how the copy names it) to work on issue or pull
    /// request `number` of `repo` (§22.2): refused before anything is signed (E813) when its
    /// current notice does not allow it ([`agent_request::check_ask`]); otherwise what will be
    /// written: the request, and, when the notice lets the bot read on request and the thread
    /// holds members-only posts or `code`, the `read` letter with the per-object key of every
    /// members-only post revision the signer opens now. Messages to specific people are never
    /// included, nor are posts under the older envelope (no key of their own).
    #[allow(clippy::too_many_arguments)]
    pub async fn plan_ask(
        &self,
        repo: &RepoRef,
        kind: TargetKind,
        number: u32,
        bot: &str,
        name: &str,
        task: &str,
        code: Option<SharedCode>,
    ) -> Result<AskPlan> {
        if !agent_request::is_task(task) {
            return Err(UserError::new(
                codes::USAGE,
                format!(
                    "the task must be 1 to {} characters, at most {} bytes",
                    agent_request::TASK_MAX.0,
                    agent_request::TASK_MAX.1
                ),
            )
            .note("nothing was signed")
            .into());
        }
        let read = self
            .target_read(repo, kind, number)
            .await?
            .ok_or(Error::NotFound)?;
        match &read {
            TargetRead::Readable(_) => {}
            TargetRead::MembersOnly(_) => {
                return Err(UserError::new(
                    codes::AGENT_NOT_ALLOWED,
                    format!("you can't read #{number}, so you can't ask {name} to work on it"),
                )
                .note("checked before anything was signed; nothing was sent to the bot")
                .into())
            }
        }
        let target = read.target(kind, number);
        let members_only = repo.visibility == Visibility::Private
            || self.target_audience(repo, &target.id).await? != Audience::Public;
        let notices = self.access_notices(repo).await?;
        let notice = notices.for_bot(bot).map(|e| &e.notice);
        let role = self.asker_role(repo).await?;
        agent_request::check_ask(notice, role, number, members_only, crate::cache::now_ms())
            .map_err(|r| ask_refused(&r, name, repo))?;
        let processor = notice.and_then(|n| n.processor.clone());
        let letter = if notice.is_some_and(|n| n.may(MAY_READ_ON_REQUEST)) {
            // the thread as stored (sealed posts with their `enc`), not as opened
            let stored = self
                .target_doc(repo, kind, number)
                .await?
                .ok_or(Error::NotFound)?;
            self.letter_plan(repo, kind, stored, code, bot).await?
        } else {
            None
        };
        Ok(AskPlan {
            target,
            bot: bot.to_owned(),
            task: task.to_owned(),
            members_only,
            processor,
            letter,
        })
    }

    /// The `read` letter of a thread whose issue or PR is `d`: the per-object key of each
    /// members-only post revision the signer opens, or `None` when there is nothing
    /// members-only to hand on.
    async fn letter_plan(
        &self,
        repo: &RepoRef,
        kind: TargetKind,
        d: FetchedDocument,
        code: Option<SharedCode>,
        bot: &str,
    ) -> Result<Option<LetterPlan>> {
        let kind = match kind {
            TargetKind::Issue => DocKind::Issue,
            TargetKind::Patch => DocKind::Patch,
        };
        let posts = self.thread_posts(repo, kind, d).await?;
        if !posts.iter().any(|(_, d)| is_sealed(d)) && code.is_none() {
            return Ok(None);
        }
        let keys = self.lane_keys(repo).await?;
        let mut docs = Vec::new();
        let mut left_out = Vec::new();
        for (kind, d) in posts.iter().filter(|(_, d)| is_sealed(d)) {
            let enc = d.field_bytes("enc").unwrap_or_default();
            let why = match enc.first() {
                Some(&doc::V4) => Some(NotShared::Letter),
                Some(&doc::V1) => Some(NotShared::Older),
                _ => None,
            };
            let key = match (&keys, why) {
                (DocKeys::Held(kr, _), None) => kr.read_obj_key(*kind, d),
                _ => None,
            };
            match (key, platform::decode_identifier(&d.id)) {
                (Some(key), Ok(id)) => docs.push((
                    *kind,
                    LetterDoc {
                        id,
                        revision: revision_of(d),
                        key,
                    },
                )),
                _ => left_out.push((*kind, d.id.clone(), why.unwrap_or(NotShared::Unreadable))),
            }
        }
        if docs.is_empty() && code.is_none() {
            return Ok(None);
        }
        let bot_key = self.bot_key(repo, bot).await?;
        Ok(Some(LetterPlan {
            docs,
            code,
            left_out,
            bot_key,
        }))
    }

    /// Write what `plan` planned: the request (an `event` of kind 27 on the thread, `refId` the
    /// bot, the task as its value, sealed when the thread is members-only), then the `read`
    /// letter naming it, with the request's own key, sealed to the signer and the bot.
    pub async fn write_ask(&self, repo: &RepoRef, plan: &AskPlan) -> Result<Asked> {
        let mut props = super::target_props(&plan.target)?;
        props.insert(
            "kind".to_string(),
            FieldValue::integer(agent_request::AGENT_REQUEST_KIND),
        );
        props.insert(
            "refId".to_string(),
            FieldValue::identifier(platform::decode_identifier(&plan.bot)?),
        );
        props.insert("value".to_string(), FieldValue::text(&plan.task));
        let community = self.community_contract(repo).await?;
        let event = self.write(repo, &community, DOC_EVENT, props).await?;
        let Some(lp) = &plan.letter else {
            return Ok(Asked {
                event,
                letter: None,
            });
        };
        let unfinished = |what: &str| {
            Error::from(
                UserError::new(
                    codes::USAGE,
                    format!("the request was written, but {what}"),
                )
                .cause(format!("request {event}"))
                .fix("ask again: the bot works only from a request with its letter"),
            )
        };
        let mut docs: Vec<LetterDoc> = lp.docs.iter().map(|(_, d)| d.clone()).collect();
        // the request itself, when it was sealed: the bot reads its task with this key
        let written = self
            .client
            .fetch_document(&community, DOC_EVENT, &event)
            .await?
            .ok_or_else(|| unfinished("it could not be read back to share its task"))?;
        if is_sealed(&written) {
            let key = self
                .keyring(repo)
                .await?
                .read_obj_key(DocKind::Event, &written)
                .ok_or_else(|| unfinished("its task could not be opened again to share it"))?;
            docs.push(LetterDoc {
                id: platform::decode_identifier(&event)?,
                revision: 1,
                key,
            });
        }
        docs.sort_by(|a, b| (&a.id, a.revision).cmp(&(&b.id, b.revision)));
        docs.dedup_by(|a, b| a.id == b.id && a.revision == b.revision);
        let (heads, packs) = lp.code.as_ref().map_or((Vec::new(), Vec::new()), |c| {
            (vec![c.head.clone()], c.packs.clone())
        });
        let letter = ReadLetter {
            job: platform::decode_identifier(&event)?,
            as_of: crate::cache::now_ms(),
            target: match plan.target.kind {
                TargetKind::Issue => ReadTarget::Issue(plan.target.number),
                TargetKind::Patch => ReadTarget::Pr(plan.target.number),
            },
            docs,
            packs,
            heads,
        };
        let plain = letter
            .to_typed()
            .ok_or_else(|| unfinished("its letter was not well formed"))?
            .encode()
            .map_err(|e| unfinished(&format!("its letter could not be written: {e}")))?;
        let sealed = self
            .seal_to_bot(repo, &plan.bot, lp.bot_key, &plain, true)
            .map_err(|e| unfinished(&format!("its letter could not be sealed: {e}")))?;
        let (id, _) = self
            .repo_service()?
            .store_key_letter(repo, &sealed)
            .await
            .map_err(|e| unfinished(&format!("its letter could not be stored: {e}")))?;
        Ok(Asked {
            event,
            letter: Some(id),
        })
    }

    /// The requests to bot `bot` (base58) in `repo` written at or after `since` (ms), oldest
    /// first, read on the sparse `addressee (refId, $createdAt)` index (it spans every
    /// repository: other repositories' events are left out). A sealed task this reader cannot
    /// open is `None`.
    pub async fn bot_requests(
        &self,
        repo: &RepoRef,
        bot: &str,
        since: u64,
    ) -> Result<Vec<AgentRequest>> {
        let community = self.community_contract(repo).await?;
        let docs = self
            .client
            .query_all_documents(
                &community,
                DOC_EVENT,
                &[
                    QueryFilter::eq(
                        "refId",
                        FieldValue::identifier(platform::decode_identifier(bot)?),
                    ),
                    QueryFilter::gte("$createdAt", FieldValue::uint64(since)),
                ],
                &[QueryOrder::asc("$createdAt")],
            )
            .await?;
        let repo_id = repo.id().to_owned();
        let docs: Vec<FetchedDocument> = docs
            .into_iter()
            .filter(|d| {
                d.field_u64("kind") == Some(agent_request::AGENT_REQUEST_KIND)
                    && super::id_field(d, "repoId").as_deref() == Some(repo_id.as_str())
            })
            .collect();
        let sealed: BTreeSet<String> = docs
            .iter()
            .filter(|d| is_sealed(d))
            .map(|d| d.id.clone())
            .collect();
        let (docs, _, _) = self.readable_events(repo, docs).await?;
        Ok(docs
            .iter()
            .filter_map(|d| {
                let mut e = request_event_of(d);
                e.value_hidden = sealed.contains(&d.id) && e.value.is_none();
                agent_request::agent_request(&repo_id, &e)
            })
            .collect())
    }

    /// The `read` letters addressed to the signer in `repo`, from a current maintainer or
    /// Write member, oldest first.
    pub async fn read_letters(&self, repo: &RepoRef) -> Result<Vec<ReceivedRead>> {
        let svc = self.repo_service()?;
        let manifests = svc.read_pack_manifests(repo).await?;
        let roles = svc.copy_roles(repo).await?;
        let signer = self.private_signer()?;
        let (identity_id, keys) = key_letters::signer_reader_keys(&signer, repo)?;
        let received = key_letters::received(
            &svc,
            self.client,
            repo,
            &manifests,
            &roles,
            &LetterReader {
                identity_id,
                keys: &keys,
            },
        )
        .await?;
        Ok(received
            .into_iter()
            .filter_map(|r| {
                Some(ReceivedRead {
                    letter: ReadLetter::from_typed(&r.letter)?,
                    id: r.manifest.document_id,
                    sender: r.manifest.owner_id,
                    created_at: r.manifest.created_at,
                })
            })
            .collect())
    }

    /// Job `job` (a request's event id) of `repo` as the signer, its bot, reads it (§22.3): the
    /// request, the newest `read` letter from its asker naming it, and the thread: public posts
    /// written up to the request as they are, members-only revisions the letter covers opened
    /// with their keys, and the rest marked. Refused when the event is not a request to the
    /// signer in `repo`.
    pub async fn read_job(&self, repo: &RepoRef, job: &str) -> Result<JobRead> {
        let community = self.community_contract(repo).await?;
        let me = self.signer_id()?;
        let not_yours = || {
            Error::from(UserError::new(
                codes::NOT_FOUND,
                format!("{job} is not a request to you in {}", repo.display()),
            ))
        };
        let d = self
            .client
            .fetch_document(&community, DOC_EVENT, job)
            .await?
            .ok_or_else(not_yours)?;
        let mut e = request_event_of(&d);
        if is_sealed(&d) {
            e.value = None;
            e.value_hidden = true;
        }
        let mut request = agent_request::agent_request(repo.id(), &e)
            .filter(|r| r.bot == me)
            .ok_or_else(not_yours)?;
        let job_id = platform::decode_identifier(job)?;
        let letter = self
            .read_letters(repo)
            .await?
            .into_iter()
            .filter(|r| r.letter.job == job_id && r.sender == request.asker)
            .filter(|r| match r.letter.target {
                ReadTarget::Pr(n) | ReadTarget::Issue(n) => n == request.number,
                ReadTarget::Branch(_) => false,
            })
            .next_back();
        let repo_id = repo.scope()?.repo_id;
        let open = |kind: DocKind, d: &FetchedDocument| -> Option<Fields> {
            let l = letter.as_ref()?;
            let id = platform::decode_identifier(&d.id).ok()?;
            let key = l.letter.doc_key(&id, revision_of(d))?;
            let header = crate::keyring::header_of(kind, d)?;
            match doc::open_shared_with_key(&repo_id, &header, &d.field_bytes("enc")?, key) {
                Opened::Readable(f) => Some(*f),
                _ => None,
            }
        };
        if request.task.is_none() {
            request.task = open(DocKind::Event, &d).and_then(|f| f.event_value);
        }
        let collab = self.collab_contract(repo).await?;
        let mut target = None;
        for (doc_type, kind) in [
            (super::DOC_PATCH, DocKind::Patch),
            (super::DOC_ISSUE, DocKind::Issue),
        ] {
            if let Some(t) = self
                .client
                .fetch_document(&collab, doc_type, &request.target_id)
                .await?
            {
                target = Some((kind, t));
                break;
            }
        }
        let (kind, target) = target.ok_or(Error::NotFound)?;
        let posts = self
            .thread_posts(repo, kind, target)
            .await?
            .into_iter()
            .map(|(kind, d)| {
                let thread_root = matches!(kind, DocKind::Issue | DocKind::Patch);
                let content = if is_sealed(&d) {
                    open(kind, &d).map_or(JobContent::NotShared, |f| JobContent::Text {
                        fields: Box::new(f),
                        members_only: true,
                    })
                } else if !thread_root && d.created_at.unwrap_or(0) > request.created_at {
                    JobContent::After
                } else {
                    JobContent::Text {
                        fields: Box::new(text_fields(&d)),
                        members_only: false,
                    }
                };
                JobPost {
                    kind,
                    id: d.id.clone(),
                    author: d.owner_id.clone(),
                    created_at: d.created_at.unwrap_or(0),
                    content,
                }
            })
            .collect();
        Ok(JobRead {
            request,
            letter,
            posts,
        })
    }
}

/// The request rule's view of a fetched `event`.
fn request_event_of(d: &FetchedDocument) -> RequestEvent {
    RequestEvent {
        id: d.id.clone(),
        repo_id: super::id_field(d, "repoId").unwrap_or_default(),
        target_id: d
            .field_bytes32("targetId")
            .map(platform::encode_identifier)
            .unwrap_or_default(),
        target_number: d.field_u64("targetNumber").unwrap_or_default(),
        kind: d.field_u64("kind").unwrap_or_default(),
        ref_id: super::id_field(d, "refId"),
        value: d.field_str("value"),
        value_hidden: false,
        actor: d.owner_id.clone(),
        created_at: d.created_at.unwrap_or_default(),
    }
}
