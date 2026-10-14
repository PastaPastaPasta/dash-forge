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
use std::sync::Arc;

use super::{is_sealed, Collab, DocKeys, Target, TargetKind, TargetRead, DOC_EVENT};
use crate::error::{Error, Result};
use crate::key_letters::{self, LetterReader};
use crate::members::MemberReader;
use crate::platform::{self, FetchedDocument, FieldValue, QueryFilter, QueryOrder};
use crate::private::access_notice::{
    AccessNotice, NoticeEntry, MAY_CI_MEMBERS_BRANCHES, MAY_READ_ON_REQUEST,
};
use crate::private::key_letter::{
    self, LetterDoc, LetterHead, LetterPack, ReadLetter, ReadTarget, TypedLetter,
};
use crate::private::named::{self, Recipient};
use crate::private::pack::{self as sealed_pack, Head};
use crate::private::{doc, DocKind, Fields, Opened};
use crate::rules::agent_request::{self, AgentRequest, AskRefusal, RequestEvent};
use crate::rules::long_body::{self, LongBody};
use crate::rules::v2::{Audience, ContentKind, Role, Visibility};
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

/// A `branch` letter a members-only push wrote to a runner bot ([`Collab::letter_ci_bots`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CiLetter {
    /// The branch (full name).
    pub branch: String,
    /// The bot (base58).
    pub bot: String,
    /// The letter's manifest id.
    pub letter: String,
    /// The head it hands on (hex).
    pub head: String,
}

/// What [`Collab::letter_ci_bots`] wrote, and what it could not: `(branch, bot, why)`, either
/// left out when the failure was not about one.
#[derive(Debug, Clone, Default)]
pub struct CiLetters {
    /// The letters written.
    pub written: Vec<CiLetter>,
    /// What was not written, and why.
    pub failed: Vec<(Option<String>, Option<String>, String)>,
    /// Branches (and the tip pushed) whose push the repository did not show yet: nothing was
    /// written for them, and asking again a little later may.
    pub lagging: Vec<(String, String)>,
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
    /// Commits those packs hold that are not on the branch (stored with its commits by another
    /// members-only branch or an earlier push): handed on too.
    pub extra_commits: usize,
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
    /// Whether the bot's notice lets it read the threads it is asked about.
    pub reads: bool,
    /// A pull request from a fork or from someone outside the members: nothing members-only of
    /// it is handed on.
    pub foreign: bool,
    /// The thread's members-only posts the bot does not get, and why.
    pub left_out: Vec<(DocKind, String, NotShared)>,
    /// The `read` letter: on a members-only thread, or when the thread holds members-only posts
    /// or code the bot may read.
    pub letter: Option<LetterPlan>,
}

impl AskPlan {
    /// Refuse, before anything is signed, a letter too large to write (the request's own key
    /// counted).
    fn check_size(&self) -> Result<()> {
        let Some(l) = &self.letter else {
            return Ok(());
        };
        let mut docs = l.letter_docs();
        docs.push(LetterDoc {
            id: [0xff; 32],
            revision: 1,
            key: zeroize::Zeroizing::new([0; 32]),
        });
        sort_dedup_docs(&mut docs);
        let trial = ReadLetter {
            job: [0; 32],
            as_of: crate::cache::now_ms(),
            target: ReadTarget::Pr(self.target.number.max(1)),
            docs,
            packs: l.packs(),
            heads: l.heads(),
        };
        match trial.to_typed().map(|t| t.encode()) {
            Some(Ok(_)) => Ok(()),
            _ => Err(UserError::new(
                codes::USAGE,
                format!(
                    "#{} is too large to share with a bot at once ({} posts{})",
                    self.target.number,
                    l.docs.len(),
                    l.code.as_ref().map_or_else(String::new, |c| format!(
                        ", {} stored pushes",
                        c.packs.len()
                    ))
                ),
            )
            .note("checked before anything was signed; nothing was sent to the bot")
            .into()),
        }
    }
}

/// The `read` letter of an [`AskPlan`].
#[derive(Clone)]
pub struct LetterPlan {
    /// The members-only revisions it opens, with their kinds.
    pub docs: Vec<(DocKind, LetterDoc)>,
    /// The members-only code.
    pub code: Option<SharedCode>,
    /// The members-only long bodies (kind 70) of its documents, with their file keys.
    pub bodies: Vec<LetterPack>,
    /// The bot's encryption key.
    bot_key: [u8; 33],
}

/// It carries keys: `Debug` shows counts only.
impl std::fmt::Debug for LetterPlan {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LetterPlan")
            .field("docs", &self.docs.len())
            .field("code", &self.code)
            .finish_non_exhaustive()
    }
}

impl LetterPlan {
    /// Every pack it hands on (the code's and the long bodies'), sorted, each once.
    fn packs(&self) -> Vec<LetterPack> {
        let mut packs: Vec<LetterPack> = self
            .code
            .iter()
            .flat_map(|c| c.packs.iter().cloned())
            .chain(self.bodies.iter().cloned())
            .collect();
        sort_dedup_packs(&mut packs);
        packs
    }

    /// The document revisions it opens, as planned (not yet sorted).
    fn letter_docs(&self) -> Vec<LetterDoc> {
        self.docs.iter().map(|(_, d)| d.clone()).collect()
    }

    /// The members-only commits it covers: the code's head, if there is code.
    fn heads(&self) -> Vec<LetterHead> {
        self.code
            .as_ref()
            .map_or_else(Vec::new, |c| vec![c.head.clone()])
    }

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
    /// Whether the task is members-only (the request is sealed): whatever reads it has read
    /// members-only content.
    pub task_members_only: bool,
    /// For a pull request: whether it comes from a fork or from someone outside the members
    /// (as they are now). A runner works on such a request in public mode only.
    pub foreign_pull: Option<bool>,
    /// Whether the request was allowed when written: a runner works only on one that was.
    pub allowed: bool,
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

/// `docs` sorted by (id, revision), each once: the order a `read` letter keeps.
fn sort_dedup_docs(docs: &mut Vec<LetterDoc>) {
    docs.sort_by(|a, b| (&a.id, a.revision).cmp(&(&b.id, b.revision)));
    docs.dedup_by(|a, b| a.id == b.id && a.revision == b.revision);
}

/// `packs` sorted by `packHash`, each once.
fn sort_dedup_packs(packs: &mut Vec<LetterPack>) {
    packs.sort_by_key(|p| p.pack_hash);
    packs.dedup_by(|a, b| a.pack_hash == b.pack_hash);
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
    #[allow(clippy::too_many_lines)] // one pass: fetch, check, open each form, decode
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
        // a member whose keys did not load counts the members' copies as unreadable; a
        // non-member (a bot) holds no members key and skips them
        let keyring = if private {
            Some(self.keyring(repo).await.map_err(|_| ()))
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
                Head::Sealed { .. } if private => match &keyring {
                    Some(Ok(kr)) if kr.resolution().keys.is_empty() => continue,
                    Some(Ok(kr)) => kr
                        .open_pack(repo, &bytes, m.size_bytes)
                        .ok()
                        .map(zeroize::Zeroizing::new),
                    _ => None,
                },
                Head::OtherVersion(named::ARTIFACT_VERSION) if private => {
                    let Some((id, keys)) = &reader else {
                        continue;
                    };
                    let Ok(owner_keys) = self.owner_keys_of(&m.owner_id).await else {
                        out.unreadable += 1;
                        continue;
                    };
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
                // the writer reads both copies of a private repository's notice: one counts
                Some(notice)
                    if out
                        .all
                        .iter()
                        .any(|e| e.writer == m.owner_id && e.notice == notice) => {}
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
        let members =
            crate::private::pack::seal(kr.writer(repo)?.write_keys(), &plain).map_err(|e| {
                Error::Config(format!(
                    "the access notice could not be prepared for members: {e}"
                ))
            })?;
        let bot = platform::encode_identifier(notice.bot);
        // taking access away from a bot that has no key left reaches members only: their
        // clients stop honouring the old notice, which is what a revocation is for
        let to_bot = match self.recipient_key_of(repo, &bot).await? {
            Some(key) => Some(self.seal_to_bot(repo, &bot, key, &plain, false)?),
            None if notice.may.is_empty() => None,
            None => Some(self.seal_to_bot(
                repo,
                &bot,
                self.bot_key(repo, &bot).await?,
                &plain,
                false,
            )?),
        };
        let (first, hash) = svc.store_access_notice(repo, &members).await?;
        let mut ids = vec![first];
        if let Some(to_bot) = to_bot {
            ids.push(svc.store_access_notice(repo, &to_bot).await?.0);
        }
        Ok((ids, hash))
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
        sealed.map_err(|e| Error::Config(format!("this could not be prepared for the bot: {e}")))
    }

    /// The bots (base58) whose current access notice in `repo` lets them run checks on
    /// members-only branches now (`ciMembersBranches`, §22.1): the newest notice from a current
    /// maintainer, live and listing that ability.
    pub async fn ci_bots(&self, repo: &RepoRef) -> Result<Vec<String>> {
        let notices = self.access_notices(repo).await?;
        let now = crate::cache::now_ms();
        Ok(notices
            .current
            .iter()
            .filter(|(_, e)| e.notice.live_at(now) && e.notice.may(MAY_CI_MEMBERS_BRANCHES))
            .map(|(bot, _)| platform::encode_identifier(*bot))
            .collect())
    }

    /// After a members-only push of `branches` (full names of members-key branches of public
    /// `repo`, each with the tip pushed), a `branch` letter of each branch as it is now (at that
    /// tip, else it is `lagging`) to every runner bot whose access lets it run checks on
    /// members-only branches (DESIGN §4.9, `private-repos.md` §22.4): the snapshot
    /// `dg branch share` hands on ([`crate::members_git::share::snapshot`]), read in the clone at
    /// `cwd` with the members key `kr`, sealed to the signer and the bot. Only a maintainer's or a
    /// Write member's letter counts for its bot, so anyone else writes none. It never fails the
    /// push it follows: what was written and what was not are returned.
    #[allow(clippy::too_many_lines)] // one pass: the bots, their keys, each branch, each letter
    pub async fn letter_ci_bots(
        &self,
        repo: &RepoRef,
        kr: &std::sync::Arc<crate::keyring::Keyring>,
        cwd: &std::path::Path,
        branches: &[(String, String)],
        progress: &dyn Fn(&str),
    ) -> CiLetters {
        let mut out = CiLetters::default();
        if branches.is_empty() || repo.visibility != Visibility::Public {
            return out;
        }
        let bots = match self.ci_bots(repo).await {
            Ok(b) if b.is_empty() => return out,
            Ok(b) => b,
            Err(e) => {
                out.failed.push((None, None, e.to_string()));
                return out;
            }
        };
        match self.asker_role(repo).await {
            Ok(Some(Role::Maintainer | Role::Writer)) => {}
            Ok(_) => {
                out.failed.push((
                    None,
                    None,
                    "only members with Write or Maintain access can share a members-only branch"
                        .into(),
                ));
                return out;
            }
            Err(e) => {
                out.failed.push((None, None, e.to_string()));
                return out;
            }
        }
        let mut keys = Vec::new();
        for bot in bots {
            match self.recipient_key_of(repo, &bot).await {
                Ok(Some(k)) => keys.push((bot, k)),
                Ok(None) => out
                    .failed
                    .push((None, Some(bot), "it has no encryption key".into())),
                Err(e) => out.failed.push((None, Some(bot), e.to_string())),
            }
        }
        if keys.is_empty() {
            return out;
        }
        let svc = match self.repo_service() {
            Ok(s) => s,
            Err(e) => {
                out.failed.push((None, None, e.to_string()));
                return out;
            }
        };
        for (branch, pushed) in branches {
            progress(&format!(
                "Sharing {} with {} runner bot(s) for their checks…",
                crate::repo::short_branch_name(branch),
                keys.len()
            ));
            let snap =
                match crate::members_git::share::snapshot(&svc, repo, kr, cwd, branch, progress)
                    .await
                {
                    Ok(s) if !s.tip.eq_ignore_ascii_case(pushed) => {
                        out.lagging.push((branch.clone(), pushed.clone()));
                        continue;
                    }
                    Ok(s) => s,
                    Err(e) => {
                        out.failed.push((Some(branch.clone()), None, e.to_string()));
                        continue;
                    }
                };
            let Some(typed) = snap.letter.to_typed() else {
                out.failed
                    .push((Some(branch.clone()), None, "its head did not check".into()));
                continue;
            };
            let plain = match typed.encode() {
                Ok(p) => p,
                Err(e) => {
                    out.failed.push((Some(branch.clone()), None, e.to_string()));
                    continue;
                }
            };
            for (bot, key) in &keys {
                let written = match self.seal_to_bot(repo, bot, *key, &plain, true) {
                    Ok(sealed) => svc.store_key_letter(repo, &sealed).await.map(|(id, _)| id),
                    Err(e) => Err(e),
                };
                match written {
                    Ok(letter) => out.written.push(CiLetter {
                        branch: branch.clone(),
                        bot: bot.clone(),
                        letter,
                        head: snap.tip.clone(),
                    }),
                    Err(e) => {
                        out.failed
                            .push((Some(branch.clone()), Some(bot.clone()), e.to_string()));
                    }
                }
            }
        }
        out
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
    pub async fn require_notice_writer(&self, repo: &RepoRef) -> Result<()> {
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
    /// request `number` of `repo` (§22.2). Refused before anything is signed (E813) when its
    /// current notice does not allow it ([`agent_request::check_ask`]), when the thread is a
    /// message to specific people, when it is members-only and nothing of it can be handed on
    /// (a private repository's older envelope), or when a members-only pull request comes from
    /// a fork or from outside the members. Otherwise what will be written: the request, and,
    /// when the notice lets the bot read on request, the `read` letter with the per-object key
    /// of every members-only post revision the signer opens now (never messages to specific
    /// people, nor posts under the older envelope, which have no key of their own). A public
    /// pull request from a fork or from outside the members gets no letter. Members-only code
    /// is added by [`Self::plan_with_code`].
    pub async fn plan_ask(
        &self,
        repo: &RepoRef,
        kind: TargetKind,
        number: u32,
        (bot, name): (&str, &str),
        task: &str,
    ) -> Result<AskPlan> {
        let refuse = |msg: String| -> Error {
            UserError::new(codes::AGENT_NOT_ALLOWED, msg)
                .note("checked before anything was signed; nothing was sent to the bot")
                .into()
        };
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
        if matches!(read, TargetRead::MembersOnly(_)) {
            return Err(refuse(format!(
                "you can't read #{number}, so you can't ask {name} to work on it"
            )));
        }
        let target = read.target(kind, number);
        let audience = self.target_audience(repo, &target.id).await?;
        if audience == Audience::SpecificPeople {
            return Err(refuse(format!(
                "#{number} is a message to specific people: {name} can't be asked about it"
            )));
        }
        let members_only = repo.visibility == Visibility::Private || audience != Audience::Public;
        let notices = self.access_notices(repo).await?;
        let notice = notices.for_bot(bot).map(|e| &e.notice);
        let role = self.asker_role(repo).await?;
        agent_request::check_ask(notice, role, number, members_only, crate::cache::now_ms())
            .map_err(|r| ask_refused(&r, name, repo))?;
        let reads = notice.is_some_and(|n| n.may(MAY_READ_ON_REQUEST));
        // a private repository whose contract has no members-only envelope of its own (D38)
        // writes the older one, which no letter can hand on: the bot could not even read the
        // task
        if reads
            && repo.visibility == Visibility::Private
            && !self
                .collab_contract(repo)
                .await?
                .has_property(super::DOC_ISSUE, "aud")
        {
            return Err(refuse(format!(
                "{name} can't be given this private repository's posts yet: older items in this repo can't be shared one at a time"
            )));
        }
        // the asking client never hands a fork's or an outsider's pull request to a bot (§4.9)
        let foreign = kind == TargetKind::Patch
            && match self.patch(repo, number).await? {
                Some(p) => {
                    p.source_repo_id != repo.id()
                        || (p.author != repo.owner_id()
                            && MemberReader::new(self.client)
                                .best_role(repo, &p.author)
                                .await?
                                .is_none())
                }
                None => false,
            };
        if foreign && members_only {
            return Err(refuse(format!(
                "#{number} comes from a fork or from someone outside the members: its members-only content can't be shared with {name}"
            )));
        }
        let (letter, left_out) = if reads && !foreign {
            // the thread as stored (sealed posts with their `enc`), not as opened
            let stored = self
                .target_doc(repo, kind, number)
                .await?
                .ok_or(Error::NotFound)?;
            self.letter_plan(repo, kind, stored, bot, members_only)
                .await?
        } else {
            (None, Vec::new())
        };
        let plan = AskPlan {
            target,
            bot: bot.to_owned(),
            task: task.to_owned(),
            members_only,
            processor: notice.and_then(|n| n.processor.clone()),
            reads,
            foreign,
            left_out,
            letter,
        };
        plan.check_size()?;
        Ok(plan)
    }

    /// `plan` with a members-only pull request's `code` added to its letter (one is planned when
    /// there was none). Refused when the bot may not read on request, or the thread's
    /// members-only content may not be shared with it.
    pub async fn plan_with_code(
        &self,
        repo: &RepoRef,
        mut plan: AskPlan,
        code: SharedCode,
    ) -> Result<AskPlan> {
        if !plan.reads || plan.foreign {
            return Ok(plan);
        }
        match &mut plan.letter {
            Some(l) => l.code = Some(code),
            None => {
                plan.letter = Some(LetterPlan {
                    docs: Vec::new(),
                    code: Some(code),
                    bodies: Vec::new(),
                    bot_key: self.bot_key(repo, &plan.bot).await?,
                });
            }
        }
        plan.check_size()?;
        Ok(plan)
    }

    /// The `read` letter of a thread whose issue or PR is `d`: the per-object key of each
    /// members-only post revision the signer opens, and the members-only posts left out. No
    /// letter when the thread is public and holds nothing members-only the signer can hand on;
    /// on a members-only thread there is always one (it carries the request's own key).
    async fn letter_plan(
        &self,
        repo: &RepoRef,
        kind: TargetKind,
        d: FetchedDocument,
        bot: &str,
        members_only: bool,
    ) -> Result<(Option<LetterPlan>, Vec<(DocKind, String, NotShared)>)> {
        let kind = match kind {
            TargetKind::Issue => DocKind::Issue,
            TargetKind::Patch => DocKind::Patch,
        };
        let posts = self.thread_posts(repo, kind, d).await?;
        let mut docs = Vec::new();
        let mut left_out = Vec::new();
        let mut continued: Vec<[u8; 32]> = Vec::new();
        if posts.iter().any(|(_, d)| is_sealed(d)) {
            let keys = self.lane_keys(repo).await?;
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
                if let (Some(_), DocKeys::Held(kr, _)) = (&key, &keys) {
                    if let Opened::Readable(f) = kr.open(*kind, d) {
                        if let Some(LongBody::Continued { sha256, .. }) =
                            f.body.as_deref().map(long_body::parse)
                        {
                            continued.push(sha256);
                        }
                    }
                }
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
        }
        if docs.is_empty() && !members_only {
            return Ok((None, left_out));
        }
        let bot_key = self.bot_key(repo, bot).await?;
        let bodies = if continued.is_empty() {
            Vec::new()
        } else {
            self.long_body_keys(repo, &continued).await?
        };
        Ok((
            Some(LetterPlan {
                docs,
                code: None,
                bodies,
                bot_key,
            }),
            left_out,
        ))
    }

    /// The file keys of the members-only long bodies (kind 70) named `hashes` (their trailers'
    /// SHA-256, which is their `packHash`), each from the first stored copy whose header this
    /// reader's members key opens. A body with no such copy is left out: the bot then reads its
    /// prefix, as any reader who cannot fetch it does.
    async fn long_body_keys(&self, repo: &RepoRef, hashes: &[[u8; 32]]) -> Result<Vec<LetterPack>> {
        let svc = self.repo_service()?;
        let kr = self.keyring(repo).await?;
        let manifests = svc.read_pack_manifests(repo).await?;
        let store = crate::storage::PackReader::from_user_config();
        let kind = u64::from(crate::pack::KIND_MEMBERS_LONG_BODY);
        let mut out: Vec<LetterPack> = Vec::new();
        for hash in hashes {
            for m in manifests
                .iter()
                .filter(|m| m.kind == kind && m.pack_hash == *hash)
            {
                let Ok(sealed) = svc.fetch_artifact(repo, m, &store).await else {
                    continue;
                };
                let key = crate::private::PackHeader::parse(&sealed, sealed.len() as u64)
                    .ok()
                    .and_then(|h| h.file_key(kr.epoch_keys(h.epoch())?).ok());
                if let Some(key) = key {
                    out.push(LetterPack {
                        pack_hash: *hash,
                        key,
                    });
                    break;
                }
            }
        }
        sort_dedup_packs(&mut out);
        Ok(out)
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
                UserError::new(codes::USAGE, format!("the request was written, but {what}"))
                    .cause(format!("request {event}"))
                    .fix("ask again: the bot works only from a request with its letter"),
            )
        };
        let mut docs = lp.letter_docs();
        // the request itself, when it was sealed: the bot reads its task with this key (read
        // back, with a few tries while a lagging node catches up)
        let mut written = None;
        for attempt in 0..4u64 {
            if attempt > 0 {
                tokio::time::sleep(std::time::Duration::from_secs(2 * attempt)).await;
            }
            if let Ok(Some(d)) = self
                .client
                .fetch_document(&community, DOC_EVENT, &event)
                .await
            {
                written = Some(d);
                break;
            }
        }
        let written =
            written.ok_or_else(|| unfinished("it could not be read back to share its task"))?;
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
        sort_dedup_docs(&mut docs);
        let letter = ReadLetter {
            job: platform::decode_identifier(&event)?,
            as_of: crate::cache::now_ms(),
            target: match plan.target.kind {
                TargetKind::Issue => ReadTarget::Issue(plan.target.number),
                TargetKind::Patch => ReadTarget::Pr(plan.target.number),
            },
            docs,
            packs: lp.packs(),
            heads: lp.heads(),
        };
        let encoded = letter
            .to_typed()
            .ok_or_else(|| unfinished("its letter was not well formed"))?
            .encode()
            .map_err(|e| unfinished(&format!("its letter could not be written: {e}")))?;
        let sealed = self
            .seal_to_bot(repo, &plan.bot, lp.bot_key, &encoded, true)
            .map_err(|e| {
                unfinished(&format!(
                    "its letter could not be prepared for the bot: {e}"
                ))
            })?;
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
    /// repository: other repositories' events are left out), each with whether it was allowed
    /// when written ([`Self::request_allowed`]). A sealed task this reader cannot open is `None`.
    pub async fn bot_requests(
        &self,
        repo: &RepoRef,
        bot: &str,
        since: u64,
    ) -> Result<Vec<(AgentRequest, bool)>> {
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
        let requests: Vec<AgentRequest> = docs
            .iter()
            .filter_map(|d| {
                let mut e = request_event_of(d);
                e.value_hidden = sealed.contains(&d.id) && e.value.is_none();
                agent_request::agent_request(&repo_id, &e)
            })
            .collect();
        if requests.is_empty() {
            return Ok(Vec::new());
        }
        let notices = self.access_notices(repo).await?;
        let oracle = self.member_oracle(repo).await?;
        let mut out = Vec::with_capacity(requests.len());
        for r in requests {
            let allowed = self.request_allowed(repo, &notices, &oracle, &r).await?;
            out.push((r, allowed));
        }
        Ok(out)
    }

    /// Whether request `r` was allowed when it was written (§22.2,
    /// [`agent_request::request_allowed`]): against the notice that counted for its bot then
    /// (the newest by a current maintainer or the owner written before it) and the asker's role
    /// then (`oracle`, the current memberships), on its thread as stored.
    async fn request_allowed(
        &self,
        repo: &RepoRef,
        notices: &Notices,
        oracle: &crate::rules::v2::RoleOracle,
        r: &AgentRequest,
    ) -> Result<bool> {
        let owner = repo.owner_id();
        let then: Vec<NoticeEntry> = notices
            .all
            .iter()
            .filter(|e| e.created_at <= r.created_at)
            .cloned()
            .collect();
        let current = crate::private::access_notice::current(&then, |w| {
            w == owner || oracle.role_at(w, u64::MAX) == Some(Role::Maintainer)
        });
        let notice = platform::decode_identifier(&r.bot)
            .ok()
            .and_then(|b| current.get(&b).map(|e| &e.notice));
        let role = if r.asker == owner {
            Some(Role::Maintainer)
        } else {
            oracle.role_at(&r.asker, r.created_at)
        };
        let members_only = repo.visibility == Visibility::Private
            || self.target_audience(repo, &r.target_id).await? != Audience::Public;
        Ok(agent_request::request_allowed(
            r,
            notice,
            role,
            members_only,
        ))
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
            &BTreeSet::new(),
        )
        .await?;
        Ok(received
            .letters
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
    /// request (and whether it was allowed when written), the newest `read` letter from its
    /// asker naming it, and the thread: public posts written up to the request as they are, and
    /// members-only revisions the letter covers opened with their keys (a post edited since is
    /// read at the revision the letter names; its long body from the letter's packs). Anything
    /// else members-only is marked not shared. Refused when the event is not a request to the
    /// signer in `repo`.
    pub async fn read_job(&self, repo: &RepoRef, job: &str) -> Result<JobRead> {
        self.read_job_as(repo, job, true).await
    }

    /// [`Self::read_job`], with `letters` false for what everyone reads: no `read` letter is
    /// looked up or opened, so a members-only task or post stays unread (forge-runner's public
    /// mode, DESIGN §4.9 "Run only proper requests").
    #[allow(clippy::too_many_lines)] // one pass: the request, its letter, the thread
    pub async fn read_job_as(&self, repo: &RepoRef, job: &str, letters: bool) -> Result<JobRead> {
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
        let task_members_only = is_sealed(&d);
        if task_members_only {
            e.value = None;
            e.value_hidden = true;
        }
        let mut request = agent_request::agent_request(repo.id(), &e)
            .filter(|r| r.bot == me)
            .ok_or_else(not_yours)?;
        let notices = self.access_notices(repo).await?;
        let oracle = self.member_oracle(repo).await?;
        let allowed = self
            .request_allowed(repo, &notices, &oracle, &request)
            .await?;
        let job_id = platform::decode_identifier(job)?;
        let received = if letters {
            self.read_letters(repo).await?
        } else {
            Vec::new()
        };
        let letter = received.into_iter().rfind(|r| {
            r.letter.job == job_id
                && r.sender == request.asker
                && match r.letter.target {
                    ReadTarget::Pr(n) | ReadTarget::Issue(n) => n == request.number,
                    ReadTarget::Branch(_) => false,
                }
        });
        let repo_id = repo.scope()?.repo_id;
        if request.task.is_none() {
            request.task = letter
                .as_ref()
                .and_then(|l| open_listed(&repo_id, &l.letter, DocKind::Event, &d))
                .and_then(|f| f.event_value);
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
        // the runner works on a fork's or an outsider's pull request in public mode only (§4.9);
        // `sourceRepoId` and the author are in the clear even on a members-only one
        let foreign_pull = if kind == DocKind::Patch {
            let source = target
                .field_bytes32("sourceRepoId")
                .map(platform::encode_identifier)
                .unwrap_or_default();
            Some(
                source != repo.id()
                    || (target.owner_id != repo.owner_id()
                        && MemberReader::new(self.client)
                            .best_role(repo, &target.owner_id)
                            .await?
                            .is_none()),
            )
        } else {
            None
        };
        let bodies = LongBodies::default();
        let mut posts = Vec::new();
        for (kind, d) in self.thread_posts(repo, kind, target).await? {
            let thread_root = matches!(kind, DocKind::Issue | DocKind::Patch);
            let content = if is_sealed(&d) {
                let fields = match &letter {
                    Some(l) => {
                        self.open_as_listed(&collab, &repo_id, &l.letter, kind, &d)
                            .await
                    }
                    None => None,
                };
                match (fields, &letter) {
                    (Some(mut f), Some(l)) => {
                        if let Some(body) = &f.body {
                            if let Some(full) = bodies.read(self, repo, &l.letter, body).await {
                                f.body = Some(full);
                            }
                        }
                        JobContent::Text {
                            fields: Box::new(f),
                            members_only: true,
                        }
                    }
                    _ => JobContent::NotShared,
                }
            } else if !thread_root && d.created_at.unwrap_or(0) > request.created_at {
                JobContent::After
            } else {
                JobContent::Text {
                    fields: Box::new(text_fields(&d)),
                    members_only: false,
                }
            };
            posts.push(JobPost {
                kind,
                id: d.id.clone(),
                author: d.owner_id.clone(),
                created_at: d.created_at.unwrap_or(0),
                content,
            });
        }
        Ok(JobRead {
            request,
            task_members_only,
            foreign_pull,
            allowed,
            letter,
            posts,
        })
    }

    /// The `read` letter the bot signer replies on thread `target` of `repo` with (§22.3, §23):
    /// the newest from a current maintainer or Write member that names `target`, whose request
    /// (its `job`) is one to this bot about that thread asked by the letter's writer. With `job`
    /// (a request's event id, as a runner passes it), that request's letter only, and refused
    /// before anything else is read when `job` is not a request to the signer about `target`.
    /// `None` when no such letter reached it.
    pub async fn reply_letter(
        &self,
        repo: &RepoRef,
        target: ReadTarget,
        job: Option<&str>,
    ) -> Result<Option<ReceivedRead>> {
        let number = match target {
            ReadTarget::Pr(n) | ReadTarget::Issue(n) => n,
            ReadTarget::Branch(_) => return Ok(None),
        };
        let asked = match job {
            Some(j) => {
                let r = self
                    .request_to_signer(repo, j)
                    .await?
                    .filter(|r| r.number == number)
                    .ok_or_else(|| not_a_request(j, target, repo))?;
                // issues and pull requests are numbered apart: the request's thread is this kind
                let (kind, _) = self.target_doc_by_id(repo, &r.target_id).await?;
                if !matches!(
                    (kind, target),
                    (ContentKind::Patch, ReadTarget::Pr(_))
                        | (ContentKind::Issue, ReadTarget::Issue(_))
                ) {
                    return Err(not_a_request(j, target, repo));
                }
                Some((platform::decode_identifier(j)?, r.asker))
            }
            None => None,
        };
        let received = self.read_letters(repo).await?;
        // newest first
        let mut naming = received
            .into_iter()
            .rev()
            .filter(|l| l.letter.target == target);
        if let Some((job_id, asker)) = asked {
            return Ok(naming.find(|l| l.letter.job == job_id && l.sender == asker));
        }
        for l in naming {
            let job = platform::encode_identifier(l.letter.job);
            if self
                .request_to_signer(repo, &job)
                .await?
                .is_some_and(|r| r.number == number && r.asker == l.sender)
            {
                return Ok(Some(l));
            }
        }
        Ok(None)
    }

    /// Request `job` of `repo` when it is one to the signer (a members-only task left unread),
    /// else `None`.
    async fn request_to_signer(&self, repo: &RepoRef, job: &str) -> Result<Option<AgentRequest>> {
        let community = self.community_contract(repo).await?;
        let Some(d) = self
            .client
            .fetch_document(&community, DOC_EVENT, job)
            .await?
        else {
            return Ok(None);
        };
        let mut e = request_event_of(&d);
        if is_sealed(&d) {
            e.value = None;
            e.value_hidden = true;
        }
        let me = self.signer_id()?;
        Ok(agent_request::agent_request(repo.id(), &e).filter(|r| r.bot == me))
    }

    /// Open, from now on in what this `Collab` reads of `repo`, the members-only revisions
    /// `letter` lists (a `read` letter to the bot signer, [`Self::reply_letter`]), with their
    /// keys, as [`Self::read_job`] opens them: so a bot reads, and replies on, the thread it was
    /// asked about without the members key (§22.3, §23). Nothing it does not list opens.
    pub fn use_read_letter(&self, repo: &RepoRef, letter: &ReadLetter) -> Result<()> {
        *crate::history::lock(&self.read_letter) =
            Some((repo.scope()?.repo_id, Arc::new(letter.clone())));
        Ok(())
    }

    /// The letter [`Self::use_read_letter`] gave for the repository `repo_id`.
    pub(super) fn shared_letter(&self, repo_id: &[u8; 32]) -> Option<Arc<ReadLetter>> {
        crate::history::lock(&self.read_letter)
            .as_ref()
            .filter(|(id, _)| id == repo_id)
            .map(|(_, l)| Arc::clone(l))
    }

    /// Issue or pull request `d` of `repo` opened with [`Self::shared_letter`] at the revision
    /// it lists, read from its history when it was edited since ([`Self::open_as_listed`]).
    pub(super) async fn open_shared_target(
        &self,
        repo: &RepoRef,
        kind: TargetKind,
        d: &FetchedDocument,
    ) -> Option<FetchedDocument> {
        let repo_id = repo.scope().ok()?.repo_id;
        let letter = self.shared_letter(&repo_id)?;
        let collab = self.collab_contract(repo).await.ok()?;
        let kind = match kind {
            TargetKind::Issue => DocKind::Issue,
            TargetKind::Patch => DocKind::Patch,
        };
        let f = self
            .open_as_listed(&collab, &repo_id, &letter, kind, d)
            .await?;
        crate::collab::private::open_doc(Opened::Readable(Box::new(f)), d.clone())
    }

    /// Sealed post `d` (of `kind`) opened at the revision `letter` lists for it: the current
    /// one, or, when it was edited since, the listed one from its history (issues, pull requests
    /// and comments keep theirs). `None` when the letter lists none of its revisions.
    async fn open_as_listed(
        &self,
        collab: &crate::platform::LoadedContract,
        repo_id: &[u8; 32],
        letter: &ReadLetter,
        kind: DocKind,
        d: &FetchedDocument,
    ) -> Option<Fields> {
        if let Some(f) = open_listed(repo_id, letter, kind, d) {
            return Some(f);
        }
        let id = platform::decode_identifier(&d.id).ok()?;
        let listed = letter.docs.iter().find(|x| x.id == id)?.revision;
        let doc_type = match kind {
            DocKind::Issue => super::DOC_ISSUE,
            DocKind::Patch => super::DOC_PATCH,
            DocKind::Comment => super::DOC_COMMENT,
            _ => return None,
        };
        let history = self
            .client
            .fetch_document_history(collab, doc_type, &d.id, 100)
            .await
            .ok()?;
        let mut old = history.into_iter().find(|h| revision_of(h) == listed)?;
        // a history row is the same document: its creation stays the current one's
        if old.created_at_block_height.is_none() {
            old.created_at_block_height = d.created_at_block_height;
        }
        open_listed(repo_id, letter, kind, &old)
    }
}

/// Sealed document `d` (of `kind`) opened with the key `letter` lists for its id and revision.
fn open_listed(
    repo_id: &[u8; 32],
    letter: &ReadLetter,
    kind: DocKind,
    d: &FetchedDocument,
) -> Option<Fields> {
    let id = platform::decode_identifier(&d.id).ok()?;
    let key = letter.doc_key(&id, revision_of(d))?;
    let header = crate::keyring::header_of(kind, d)?;
    match doc::open_shared_with_key(repo_id, &header, &d.field_bytes("enc")?, key) {
        Opened::Readable(f) => Some(*f),
        _ => None,
    }
}

/// [`open_listed`] as the public codecs read `d`: its fields put back in place.
pub(super) fn open_listed_doc(
    repo_id: &[u8; 32],
    letter: &ReadLetter,
    kind: DocKind,
    d: FetchedDocument,
) -> Option<FetchedDocument> {
    let f = open_listed(repo_id, letter, kind, &d)?;
    crate::collab::private::open_doc(Opened::Readable(Box::new(f)), d)
}

/// E102 for `job`, which is not a request to the signer about `target` of `repo`.
fn not_a_request(job: &str, target: ReadTarget, repo: &RepoRef) -> Error {
    UserError::new(
        codes::NOT_FOUND,
        format!(
            "{job} is not a request to you about {} in {}",
            thread_words(target),
            repo.display()
        ),
    )
    .fix(format!(
        "`dg bot jobs {}` lists the requests to you",
        repo.display()
    ))
    .note("checked before anything was signed; nothing was written or paid")
    .into()
}

/// "pull request #3" / "issue #3".
fn thread_words(target: ReadTarget) -> String {
    match target {
        ReadTarget::Pr(n) => format!("pull request #{n}"),
        ReadTarget::Issue(n) => format!("issue #{n}"),
        ReadTarget::Branch(_) => "a branch".into(),
    }
}

/// E311 for a bot replying on members-only `target` of `repo` with no `read` letter for it
/// ([`Collab::reply_letter`]; for the request `job` when one was given): a bot reads, and
/// replies on, a members-only conversation only once it was asked there (§22.3, §23).
#[must_use]
pub fn not_asked_here(repo: &RepoRef, target: ReadTarget, job: Option<&str>) -> Error {
    let what = thread_words(target);
    let flag = match target {
        ReadTarget::Issue(n) => format!("--issue {n}"),
        ReadTarget::Pr(n) => format!("--pr {n}"),
        ReadTarget::Branch(_) => String::new(),
    };
    let e = UserError::new(
        codes::NO_KEY_SHARED,
        format!(
            "nothing members-only in {what} of {} has been shared with you",
            repo.display()
        ),
    );
    let e = match job {
        Some(job) => e.cause(format!(
            "request {job} shared nothing members-only with you, or whoever asked can no longer share it"
        )),
        None => e.cause(
            "a bot reads members-only posts, and replies to them, only once someone with Write access asks it there",
        ),
    };
    e.fix(format!(
        "someone with Write access asks you there: `dg bot ask {} @<you> \"<task>\" {flag}`",
        repo.display()
    ))
    .note("checked before anything was signed; nothing was written or paid")
    .into()
}

/// The members-only long bodies a `read` letter hands on, read once per job.
#[derive(Default)]
struct LongBodies {
    manifests: tokio::sync::OnceCell<Vec<crate::repo::PackManifestInfo>>,
}

impl LongBodies {
    /// The whole text of a members-only `body` whose trailer names a long body (kind 70) the
    /// letter hands on: fetched and checked against the trailer's SHA-256 (the stored
    /// artifact's `packHash`), opened with its file key alone, and checked against the
    /// trailer's length. `None` keeps the prefix (any reader who cannot fetch it
    /// reads the same).
    async fn read(
        &self,
        collab: &Collab<'_>,
        repo: &RepoRef,
        letter: &ReadLetter,
        body: &str,
    ) -> Option<String> {
        let LongBody::Continued { sha256, bytes, .. } = long_body::parse(body) else {
            return None;
        };
        let key = &letter.packs.iter().find(|p| p.pack_hash == sha256)?.key;
        let svc = collab.repo_service().ok()?;
        let manifests = self
            .manifests
            .get_or_try_init(|| svc.read_pack_manifests(repo))
            .await
            .ok()?;
        let store = crate::storage::PackReader::from_user_config();
        let kind = u64::from(crate::pack::KIND_MEMBERS_LONG_BODY);
        for m in manifests
            .iter()
            .filter(|m| m.kind == kind && m.pack_hash == sha256)
        {
            // the trailer names the stored (sealed) artifact by its packHash; the text inside
            // is checked by its length, as members read it (`long_body::open_text`)
            let Ok(sealed) = svc.fetch_artifact(repo, m, &store).await else {
                continue;
            };
            if crate::private::keys::sha256(&sealed) != sha256 {
                continue;
            }
            let Ok(plain) = crate::private::pack::open_with_file_key(&sealed, m.size_bytes, key)
            else {
                continue;
            };
            if let Ok(text) = long_body::open_text(bytes, &plain) {
                return Some(text);
            }
        }
        None
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::private::{EpochKey, EpochResolution, Lane};

    const REPO: [u8; 32] = [0x11; 32];
    const OWNER: [u8; 32] = [0x22; 32];
    const ID: [u8; 32] = [0x5a; 32];

    /// A members-only comment of a public repository at `revision`, and its per-object key as
    /// the asker's `read` letter carries it.
    fn sealed_comment(revision: u64) -> (FetchedDocument, zeroize::Zeroizing<[u8; 32]>) {
        let mut res = EpochResolution::default();
        res.keys.insert(0, EpochKey::from_bytes([3; 32]));
        res.write_epoch = Some(0);
        let lane = Lane::from_resolution(&REPO, &res).unwrap();
        let props: BTreeMap<String, FieldValue> = [
            ("targetId".to_string(), FieldValue::identifier([7; 32])),
            ("body".to_string(), FieldValue::text("members only")),
            ("vis".to_string(), FieldValue::text("public")),
        ]
        .into();
        let sealed =
            crate::collab::private::seal_members_props(&lane, DocKind::Comment, OWNER, props)
                .unwrap();
        let d = FetchedDocument {
            id: platform::encode_identifier(ID),
            owner_id: platform::encode_identifier(OWNER),
            created_at: Some(1),
            created_at_block_height: Some(10),
            updated_at_block_height: None,
            updated_at: None,
            fields: sealed,
            revision: Some(revision),
        };
        let header = crate::keyring::header_of(DocKind::Comment, &d).unwrap();
        let key =
            doc::read_obj_key(lane.write_keys(), &header, &d.field_bytes("enc").unwrap()).unwrap();
        (d, key)
    }

    fn letter(docs: Vec<LetterDoc>) -> ReadLetter {
        ReadLetter {
            job: [0x33; 32],
            as_of: 1,
            target: ReadTarget::Pr(3),
            docs,
            packs: Vec::new(),
            heads: Vec::new(),
        }
    }

    /// A bot replying on a members-only thread reads a post its letter lists with that key
    /// alone, back in the public shape; a revision it does not list stays unread.
    #[test]
    fn a_reply_letter_opens_the_revisions_it_lists_only() {
        let (d, key) = sealed_comment(2);
        let listed = letter(vec![LetterDoc {
            id: ID,
            revision: 2,
            key: key.clone(),
        }]);
        let back = open_listed_doc(&REPO, &listed, DocKind::Comment, d.clone()).unwrap();
        assert_eq!(back.field_str("body").as_deref(), Some("members only"));
        // edited since the request: the current revision is not the one shared
        let older = letter(vec![LetterDoc {
            id: ID,
            revision: 1,
            key,
        }]);
        assert!(open_listed_doc(&REPO, &older, DocKind::Comment, d.clone()).is_none());
        assert!(open_listed_doc(&REPO, &letter(Vec::new()), DocKind::Comment, d.clone()).is_none());
        // another repository's id is bound into the key: it does not open there
        assert!(open_listed_doc(&[0x12; 32], &listed, DocKind::Comment, d).is_none());
    }

    /// The refusal of a bot with no letter for the thread is E311, before signing, in plain
    /// words, and tells how to ask it there.
    #[test]
    fn a_bot_not_asked_on_a_thread_is_refused_in_plain_words() {
        let repo = RepoRef {
            forge: crate::network::ForgeIds::test_forge(),
            repo_id: "R".into(),
            owner_id: "alice".into(),
            name: "proj".into(),
            visibility: Visibility::Public,
        };
        for (target, job, flag) in [
            (ReadTarget::Pr(3), None, "--pr 3"),
            (ReadTarget::Issue(5), Some("Job1"), "--issue 5"),
        ] {
            let Error::User(e) = not_asked_here(&repo, target, job) else {
                panic!("a user error");
            };
            assert_eq!(e.code, codes::NO_KEY_SHARED);
            let all = format!("{e} {}", e.fix.join(" "));
            assert!(all.contains(flag), "{all}");
            for banned in [
                "sealed",
                "lane",
                "named",
                "restricted",
                "reveal",
                "epoch",
                "key letter",
                "disclosure",
            ] {
                assert!(!all.to_lowercase().contains(banned), "{banned} in {all}");
            }
        }
        let Error::User(e) = not_a_request("Job1", ReadTarget::Pr(3), &repo) else {
            panic!("a user error");
        };
        assert_eq!(e.code, codes::NOT_FOUND);
        assert!(e.to_string().contains("pull request #3"));
    }
}
