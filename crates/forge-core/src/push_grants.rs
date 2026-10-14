//! Push grants on Platform (phase 4E, D42; `docs/security/private-repos.md` §24): reading,
//! writing and deleting a repository's `pushGrant` documents. Which grant a bot may push under,
//! and how readers mark its pushes, is [`crate::rules::push_grant`].

use crate::error::{Error, Result};
use crate::platform::{self, FieldValue, QueryFilter, QueryOrder};
use crate::rules::push_grant::{PushGrant, DOC_PUSH_GRANT, PREFIX_GRANT};
use crate::scope::RepoRef;

use super::{RepoService, DOC_REF_UPDATE};

/// What a grant covers, as it is written.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GrantScope {
    /// Public refs starting with this prefix (a full `refs/heads/…` name).
    Prefix(String),
    /// One members-only branch: its name hash under the branch key's current generation.
    Exact([u8; 32]),
}

impl RepoService<'_> {
    /// Whether `repo`'s contract has push grants (the mainnet set; sakura's live set has none,
    /// and there a bot cannot push to a repository at all).
    pub async fn push_grants_supported(&self, repo: &RepoRef) -> Result<bool> {
        let (_, contract) = self.readable(repo).await?;
        Ok(contract.has_document_type(DOC_PUSH_GRANT)
            && contract.has_property(DOC_REF_UPDATE, PREFIX_GRANT))
    }

    /// `repo`'s push grants, oldest first: all of them, or `bot`'s (base58) only. Empty where
    /// the contract has none. Documents consensus would not have admitted are left out.
    pub async fn read_push_grants(
        &self,
        repo: &RepoRef,
        bot: Option<&str>,
    ) -> Result<Vec<PushGrant>> {
        let (scope, contract) = self.readable(repo).await?;
        if !contract.has_document_type(DOC_PUSH_GRANT) {
            return Ok(Vec::new());
        }
        let filters = match bot {
            Some(b) => scope.filters([QueryFilter::eq(
                "botId",
                FieldValue::identifier(platform::decode_identifier(b)?),
            )]),
            None => scope.filters([]),
        };
        let order = [QueryOrder::asc("botId"), QueryOrder::asc("$createdAt")];
        let docs = self
            .client
            .query_all_documents(&contract, DOC_PUSH_GRANT, &filters, &order)
            .await?;
        let mut out: Vec<PushGrant> = docs.iter().filter_map(PushGrant::from_doc).collect();
        out.sort_by(|a, b| (a.created_at, &a.id).cmp(&(b.created_at, &b.id)));
        Ok(out)
    }

    /// Write a push grant for `bot` (base58) over `what` until `until` (ms). The caller has
    /// checked who may write it (a maintainer), that `bot` holds a Bot row and the bounds
    /// ([`crate::rules::push_grant::until_for`], [`crate::rules::push_grant::prefix_of`]);
    /// consensus checks them again. Returns the document id.
    pub async fn write_push_grant(
        &self,
        repo: &RepoRef,
        bot: &str,
        what: &GrantScope,
        until: u64,
    ) -> Result<String> {
        let (scope, contract) = self.writable(repo).await?;
        if !contract.has_document_type(DOC_PUSH_GRANT) {
            return Err(Error::Config(
                "this network's contract has no push grants: bots can't push to this repo yet"
                    .into(),
            ));
        }
        let mut props = scope.props([
            (
                "botId",
                FieldValue::identifier(platform::decode_identifier(bot)?),
            ),
            ("until", FieldValue::integer(until)),
        ]);
        match what {
            GrantScope::Prefix(p) => props.insert("prefix".into(), FieldValue::text(p)),
            GrantScope::Exact(h) => props.insert("scope".into(), FieldValue::bytes32(*h)),
        };
        self.doc_engine()?
            .create_document(&contract, DOC_PUSH_GRANT, props)
            .await
    }

    /// Delete push grant `id` (only its writer can: consensus refuses anyone else).
    pub async fn delete_push_grant(&self, repo: &RepoRef, id: &str) -> Result<()> {
        let (_, contract) = self.writable(repo).await?;
        self.doc_engine()?
            .delete_document(&contract, DOC_PUSH_GRANT, id)
            .await
    }
}
