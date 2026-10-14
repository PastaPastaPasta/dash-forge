//! A bot's push access (phase 4E; mixed-visibility DESIGN §4.9 "Pushing", D42;
//! `docs/security/private-repos.md` §24): the grants, the bot's member row, the maintainers and
//! the bot's access notice read together, so a client, the helper and the runner judge a push
//! the same way ([`crate::rules::push_grant`]).

use std::collections::BTreeSet;

use super::Collab;
use crate::error::Result;
use crate::members::MemberReader;
use crate::private::access_notice::NoticeEntry;
use crate::rules::push_grant::{self, GrantContext, NoGrant, PushGrant, PushTarget, Unusable};
use crate::rules::v2::Role;
use crate::scope::RepoRef;

/// A bot's push access to one repository as clients read it now.
#[derive(Debug, Clone)]
pub struct BotPushAccess {
    /// The bot (base58).
    pub bot: String,
    /// Whether the contract has push grants at all (the mainnet set).
    pub supported: bool,
    /// Every grant naming the bot, oldest first, usable or not.
    pub grants: Vec<PushGrant>,
    /// When the bot's current Bot row was written; `None` when it holds none.
    pub bot_row_at: Option<u64>,
    /// The current maintainers (base58): a grant counts only while its granter is one.
    pub maintainers: BTreeSet<String>,
    /// The bot's current access notice, if any.
    pub notice: Option<NoticeEntry>,
    /// When this was read (ms).
    pub now: u64,
}

impl BotPushAccess {
    /// What [`push_grant::usable`] judges against.
    #[must_use]
    pub fn ctx(&self) -> GrantContext<'_> {
        GrantContext {
            now: self.now,
            bot_row_at: self.bot_row_at,
            maintainers: &self.maintainers,
        }
    }

    /// Whether a maintainer suspended the bot's pushes: its current notice does not allow
    /// pushing (a notice that has ended allows nothing). With no notice at all the grants alone
    /// decide.
    #[must_use]
    pub fn suspended(&self) -> bool {
        self.notice
            .as_ref()
            .is_some_and(|n| !n.notice.live_at(self.now) || !n.notice.allows_push())
    }

    /// Whether grant `g` can be pushed under now.
    pub fn usable(&self, g: &PushGrant) -> std::result::Result<(), Unusable> {
        push_grant::usable(g, &self.ctx())
    }

    /// The grants that can be pushed under now.
    pub fn live(&self) -> impl Iterator<Item = &PushGrant> {
        self.grants.iter().filter(|g| self.usable(g).is_ok())
    }

    /// The grant to push `target` under ([`push_grant::pick`]).
    pub fn pick(&self, target: &PushTarget<'_>) -> std::result::Result<&PushGrant, NoGrant> {
        push_grant::pick(&self.grants, target, &self.ctx())
    }
}

impl Collab<'_> {
    /// Whether the signer writes push-class documents as a bot in `repo`: it holds a Bot row
    /// there and the contract admits a bot's packs (`packManifest.r` up to 4, the mainnet set).
    /// Then its public long bodies (kind 6) and its pushes claim `r` 4.
    pub async fn bot_writes_packs(&self, repo: &RepoRef) -> Result<bool> {
        if self.signer_role(repo).await? != Some(Role::Bot) {
            return Ok(false);
        }
        let contract = self
            .client
            .fetch_contract(&repo.scope()?.contract_id)
            .await?;
        Ok(contract
            .property_maximum(crate::repo::DOC_PACK_MANIFEST, crate::members::CLAIMED_ROLE)
            .is_some_and(|max| max >= 4))
    }

    /// `bot`'s (base58) push access to `repo` now: its grants, its Bot row, the maintainers and
    /// its current notice. Where the contract has no push grants (sakura's live set) `supported`
    /// is false and nothing else is read.
    pub async fn bot_push_access(&self, repo: &RepoRef, bot: &str) -> Result<BotPushAccess> {
        let svc = match self.signer {
            Some(_) => self.repo_service()?,
            None => crate::repo::RepoService::reader(self.client),
        };
        let now = crate::cache::now_ms();
        let mut access = BotPushAccess {
            bot: bot.to_owned(),
            supported: svc.push_grants_supported(repo).await?,
            grants: Vec::new(),
            bot_row_at: None,
            maintainers: BTreeSet::new(),
            notice: None,
            now,
        };
        if !access.supported {
            return Ok(access);
        }
        let reader = MemberReader::new(self.client);
        access.grants = svc.read_push_grants(repo, Some(bot)).await?;
        access.bot_row_at = reader
            .role_doc(repo, bot, Role::Bot)
            .await?
            .filter(|m| m.role == Role::Bot)
            .map(|m| m.created_at);
        access.maintainers = reader
            .maintainers(repo)
            .await?
            .into_iter()
            .map(|m| m.identity_id)
            .collect();
        access.notice = self.access_notices(repo).await?.for_bot(bot).cloned();
        Ok(access)
    }
}

/// One grant a maintainer asks for: what it covers and how the product names it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GrantRequest {
    /// What it covers.
    pub scope: crate::repo::GrantScope,
    /// The branch or prefix as the copy names it (`bot/ci-bot/`, `fix-auth`).
    pub label: String,
}

/// A members-only branch a maintainer can grant one bot: shared with it (a narrower branch whose
/// audience includes it), with its name hash under each generation of its key.
#[derive(Debug, Clone)]
pub struct GrantableBranch {
    /// The full ref name.
    pub name: String,
    /// Its name hash under the current generation (what a new exact grant names).
    pub current: [u8; 32],
    /// Its name hashes under earlier generations (what a stale grant names).
    pub earlier: Vec<[u8; 32]>,
    /// Who it is for now (base58).
    pub audience_now: BTreeSet<String>,
}

impl Collab<'_> {
    /// The narrower branches the signer holds the key of, with their name hashes per generation
    /// (an exact grant names the current one; a grant naming an earlier one is stale since a
    /// new generation and is re-issued by `dg bot renew`). Empty for a private repository.
    pub async fn grantable_branches(&self, repo: &RepoRef) -> Result<Vec<GrantableBranch>> {
        if repo.visibility != crate::rules::v2::Visibility::Public {
            return Ok(Vec::new());
        }
        let svc = self.repo_service()?;
        let members = MemberReader::new(self.client).list(repo).await?;
        let ring = crate::narrow::read_ring(&svc, repo, &members).await?;
        let repo_id = repo.scope()?.repo_id;
        Ok(ring
            .branches()
            .values()
            .map(|b| {
                let hashes: Vec<[u8; 32]> = b
                    .keys()
                    .iter()
                    .enumerate()
                    .map(|(g, k)| {
                        let g = u32::try_from(g).unwrap_or(u32::MAX);
                        crate::private::branch_key::BranchKeys::derive(&repo_id, g, k)
                            .ref_name_hash(&b.name)
                    })
                    .collect();
                let (current, earlier) = hashes
                    .split_last()
                    .map(|(c, e)| (*c, e.to_vec()))
                    .unwrap_or_default();
                GrantableBranch {
                    name: b.name.clone(),
                    current,
                    earlier,
                    audience_now: crate::narrow::resolve_now(
                        &b.audience,
                        repo.owner_id(),
                        &members,
                    ),
                }
            })
            .collect())
    }
}
