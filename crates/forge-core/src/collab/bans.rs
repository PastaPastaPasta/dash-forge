//! Maintainer bans (UPDATE-1 `ban`, `docs/contracts/forge-v2.md` §3.2): ban and lift, read the
//! standing bans, and refuse a banned identity's writes before signing. A fourth `impl` of
//! [`super::v2::Collab`]; the reader rule is [`crate::rules::bans`].
//!
//! A `ban` (forge-collab) is maintainer-gated at consensus (`ownerRefersTo` forge-core
//! `maintainer`), unique per `(repoId, identityId, $ownerId)` and deletable by its writer (a
//! lift). On a contract without the type every read is empty and a ban is refused.

use std::collections::{BTreeMap, BTreeSet};

use super::v2::Collab;
use crate::error::{Error, Result};
use crate::members::MemberReader;
use crate::platform::{self, FetchedDocument, FieldValue, QueryFilter, QueryOrder};
use crate::rules::bans::{standing_bans, Ban, BanScope};
use crate::rules::v2::Role;
use crate::scope::RepoRef;
use crate::user_error::{codes, UserError};

/// forge-collab: a maintainer's per-repo ban (UPDATE-1 `repo_ban`).
pub const DOC_BAN: &str = "ban";

/// A `ban` document as a [`Ban`]; `None` when it names no identity.
#[must_use]
pub fn ban_from_doc(d: &FetchedDocument) -> Option<Ban> {
    Some(Ban {
        id: d.id.clone(),
        identity: d
            .field_bytes32("identityId")
            .map(platform::encode_identifier)?,
        by: d.owner_id.clone(),
        reason: d.field_u64("reason").and_then(|r| u8::try_from(r).ok()),
        created_at: d.created_at.unwrap_or_default(),
    })
}

impl Collab<'_> {
    /// Every `ban` document of `repo` (`identity`: only those naming it), as stored: nothing
    /// judged yet. Empty on a contract without the type.
    pub async fn bans(&self, repo: &RepoRef, identity: Option<&str>) -> Result<Vec<Ban>> {
        let collab = self.collab_contract(repo).await?;
        if !collab.has_document_type(DOC_BAN) {
            return Ok(Vec::new());
        }
        let mut filters = vec![Self::repo_filter(repo)?];
        if let Some(id) = identity {
            filters.push(QueryFilter::eq(
                "identityId",
                FieldValue::identifier(platform::decode_identifier(id)?),
            ));
        }
        let docs = self
            .client()
            .query_all_documents(&collab, DOC_BAN, &filters, &[QueryOrder::asc("identityId")])
            .await?;
        Ok(docs.iter().filter_map(ban_from_doc).collect())
    }

    /// Whose bans count in `repo`: its owner and its maintainers now (one read).
    pub async fn ban_scope(&self, repo: &RepoRef) -> Result<BanScope> {
        let maintainers: BTreeSet<String> = MemberReader::new(self.client())
            .maintainers(repo)
            .await?
            .into_iter()
            .map(|m| m.identity_id)
            .collect();
        Ok(BanScope {
            owner: repo.owner_id().to_string(),
            maintainers,
        })
    }

    /// The standing ban of each banned identity of `repo` ([`standing_bans`]): one read of the
    /// bans, and of the maintainers only when there is one. A failed read is no ban (a reader
    /// never fails over it).
    pub async fn standing_bans(&self, repo: &RepoRef) -> BTreeMap<String, Ban> {
        let Ok(bans) = self.bans(repo, None).await else {
            return BTreeMap::new();
        };
        if bans.is_empty() {
            return BTreeMap::new();
        }
        match self.ban_scope(repo).await {
            Ok(scope) => standing_bans(&bans, &scope),
            Err(_) => BTreeMap::new(),
        }
    }

    /// E610 before anything is signed when the signer is banned from `repo` (`action`: what was
    /// not done, "comment not posted"). Advisory like the role pre-checks: a failed read
    /// proceeds, and consensus would accept the write either way.
    pub async fn refuse_if_banned(&self, repo: &RepoRef, action: &str) -> Result<()> {
        let me = self.signer_id()?;
        let Ok(bans) = self.bans(repo, Some(&me)).await else {
            return Ok(());
        };
        if bans.is_empty() {
            return Ok(());
        }
        let Ok(scope) = self.ban_scope(repo).await else {
            return Ok(());
        };
        let Some(ban) = standing_bans(&bans, &scope).remove(&me) else {
            return Ok(());
        };
        Err(banned_refusal(repo, action, &ban).into())
    }

    /// Ban `identity` from `repo` (maintainers), with a reason code (`None`: none). Refused
    /// before signing for the owner and a current maintainer (readers ignore such a ban), for
    /// one this signer already holds, and on a contract without bans. Returns the ban's id.
    pub async fn ban(&self, repo: &RepoRef, identity: &str, reason: Option<u8>) -> Result<String> {
        platform::decode_identifier(identity)?;
        let collab = self.collab_contract(repo).await?;
        if !collab.has_document_type(DOC_BAN) {
            return Err(Error::Config(
                "this network's Forge doesn't support bans yet".into(),
            ));
        }
        self.require_role(repo, Role::Maintainer, "ban someone")
            .await?;
        let scope = self.ban_scope(repo).await?;
        if scope.moderates(identity) {
            return Err(Error::InvalidInput(format!(
                "{identity} is the owner or a maintainer of {}: a ban of them would be ignored",
                repo.display()
            )));
        }
        let me = self.signer_id()?;
        if self
            .bans(repo, Some(identity))
            .await?
            .iter()
            .any(|b| b.by == me)
        {
            return Err(Error::InvalidInput(format!(
                "you have already banned {identity} from {}",
                repo.display()
            )));
        }
        let mut props = BTreeMap::new();
        props.insert(
            "identityId".to_string(),
            FieldValue::identifier(platform::decode_identifier(identity)?),
        );
        if let Some(r) = reason.filter(|r| *r != 0) {
            props.insert("reason".to_string(), FieldValue::integer(u64::from(r)));
        }
        self.write(repo, &collab, DOC_BAN, props).await
    }

    /// Lift this signer's ban of `identity` from `repo`: delete its `ban`. `Ok(None)` when the
    /// signer holds none (another maintainer's ban only its writer can lift). Returns the
    /// deleted ban's id.
    pub async fn unban(&self, repo: &RepoRef, identity: &str) -> Result<Option<String>> {
        let me = self.signer_id()?;
        let Some(mine) = self
            .bans(repo, Some(identity))
            .await?
            .into_iter()
            .find(|b| b.by == me)
        else {
            return Ok(None);
        };
        let collab = self.collab_contract(repo).await?;
        self.engine()?
            .delete_document(&collab, DOC_BAN, &mine.id)
            .await?;
        Ok(Some(mine.id))
    }
}

/// E610: the signer is banned from `repo`, so `action` was not done.
#[must_use]
pub fn banned_refusal(repo: &RepoRef, action: &str, ban: &Ban) -> UserError {
    let why = crate::rules::bans::ban_reason_label(ban.reason)
        .map_or_else(String::new, |r| format!(" (reason: {r})"));
    UserError::new(
        codes::BANNED,
        format!("{action}: a maintainer banned you from {}", repo.display()),
    )
    .cause(format!(
        "{} banned this identity{why}; Forge apps hide a banned identity's issues, pull requests, comments and reviews there",
        ban.by
    ))
    .fix("ask a maintainer of the repository to lift the ban")
    .note("checked before anything was signed; nothing was written or paid")
}
