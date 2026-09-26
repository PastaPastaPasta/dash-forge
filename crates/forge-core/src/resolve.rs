//! Resolving a repository reference (`owner/name`, or an id) to a [`RepoRef`].
//!
//! * `owner/name`: the name is checked and normalized as a slug
//!   ([`crate::rules::v2::normalize_repo_name`]), then looked up as a forge-core `repo`
//!   through its unique `($ownerId, name)` index (proof-verified: a proved absence is
//!   [`Error::NotFound`], a failed lookup is an error).
//! * an id: a forge-core `repo` document id, proof-verified.
//!
//! A network with no forge-v2 deployment resolves nothing: [`Error::V2NotDeployed`].

use crate::error::{Error, Result};
use crate::network::ForgeIds;
use crate::platform::{self, FetchedDocument, FieldValue, PlatformClient, QueryFilter, QueryOrder};
use crate::rules::v2::normalize_repo_name;
use crate::scope::{visibility_of, RepoRef};

/// The forge-core document type of a repository.
pub const DOC_REPO: &str = "repo";

/// The `repo.name` slug `input` names, or a configuration error explaining the rule.
pub fn repo_slug(input: &str) -> Result<String> {
    normalize_repo_name(input).ok_or_else(|| {
        Error::Config(format!(
            "invalid repo name {input:?}: use 1-63 of a-z, 0-9, '.', '_', '-', starting with a \
             letter or digit (upper-case letters are folded to lower-case)"
        ))
    })
}

/// A forge-core `repo` document as a [`RepoRef`].
pub fn repo_ref_from_doc(forge: &ForgeIds, doc: &FetchedDocument) -> Result<RepoRef> {
    Ok(RepoRef {
        forge: forge.clone(),
        repo_id: doc.id.clone(),
        owner_id: doc.owner_id.clone(),
        name: doc
            .field_str("name")
            .ok_or_else(|| Error::Platform(format!("repo {} has no name", doc.id)))?,
        visibility: visibility_of(doc),
    })
}

/// The network's forge-v2 contracts, or [`Error::V2NotDeployed`].
fn deployed(client: &PlatformClient) -> Result<&ForgeIds> {
    let target = client.target();
    target.v2.as_ref().ok_or_else(|| Error::V2NotDeployed {
        network: target.network.key(),
    })
}

/// Resolve `owner/name` (owner a base58 identity id).
pub async fn resolve_named(client: &PlatformClient, owner: &str, name: &str) -> Result<RepoRef> {
    let slug = repo_slug(name)?;
    let owner_bytes = platform::decode_identifier(owner)?;
    let forge = deployed(client)?;
    find_v2(client, forge, owner_bytes, &slug)
        .await?
        .ok_or(Error::NotFound)
}

/// The forge-v2 repo `owner` named `slug`, if it exists (proved either way).
pub async fn find_v2(
    client: &PlatformClient,
    forge: &ForgeIds,
    owner: [u8; 32],
    slug: &str,
) -> Result<Option<RepoRef>> {
    let core = client.fetch_contract(&forge.core).await?;
    let docs = client
        .query_documents(
            &core,
            DOC_REPO,
            &[
                QueryFilter::eq("$ownerId", FieldValue::identifier(owner)),
                QueryFilter::eq("name", FieldValue::text(slug)),
            ],
            &[],
            1,
            None,
        )
        .await?;
    docs.first()
        .map(|d| repo_ref_from_doc(forge, d))
        .transpose()
}

/// Resolve a bare id: a forge-core `repo` document id.
pub async fn resolve_id(client: &PlatformClient, id: &str) -> Result<RepoRef> {
    platform::decode_identifier(id)?;
    let forge = deployed(client)?;
    if id == forge.core || id == forge.collab {
        return Err(Error::Config(format!(
            "{id} is a forge-v2 contract, not a repository; address a repo as \
             dash://<owner>/<name> or by its repo id"
        )));
    }
    let core = client.fetch_contract(&forge.core).await?;
    match client.fetch_document(&core, DOC_REPO, id).await? {
        Some(doc) => repo_ref_from_doc(forge, &doc),
        None => Err(Error::NotFound),
    }
}

/// The forks of the forge-v2 repo `parent_id` (the `forkOf` index), optionally only those
/// `owner` holds.
pub async fn find_forks(
    client: &PlatformClient,
    forge: &ForgeIds,
    parent_id: &str,
    owner: Option<&str>,
) -> Result<Vec<RepoRef>> {
    let core = client.fetch_contract(&forge.core).await?;
    let docs = client
        .query_all_documents(
            &core,
            DOC_REPO,
            &[QueryFilter::eq(
                "forkOf",
                FieldValue::identifier(platform::decode_identifier(parent_id)?),
            )],
            &[QueryOrder::asc("forkOf")],
        )
        .await?;
    docs.iter()
        .filter(|d| owner.is_none_or(|o| d.owner_id == o))
        .map(|d| repo_ref_from_doc(forge, d))
        .collect()
}

/// The `forkOf` of a repo, if it is a fork.
pub async fn fork_parent(client: &PlatformClient, repo: &RepoRef) -> Result<Option<String>> {
    let core = client.fetch_contract(&repo.forge.core).await?;
    Ok(client
        .fetch_document(&core, DOC_REPO, &repo.repo_id)
        .await?
        .and_then(|d| d.field_bytes32("forkOf"))
        .map(platform::encode_identifier))
}

/// Every repository `owner` has, by name.
pub async fn list_owned(client: &PlatformClient, owner: &str) -> Result<Vec<RepoSummary>> {
    let owner_bytes = platform::decode_identifier(owner)?;
    let forge = deployed(client)?;
    let core = client.fetch_contract(&forge.core).await?;
    let docs = client
        .query_all_documents(
            &core,
            DOC_REPO,
            &[QueryFilter::eq(
                "$ownerId",
                FieldValue::identifier(owner_bytes),
            )],
            &[QueryOrder::asc("name")],
        )
        .await?;
    docs.iter()
        .map(|d| {
            Ok(RepoSummary {
                repo: repo_ref_from_doc(forge, d)?,
                description: d.field_str("description").unwrap_or_default(),
            })
        })
        .collect()
}

/// One row of [`list_owned`].
#[derive(Debug, Clone)]
pub struct RepoSummary {
    /// The repository.
    pub repo: RepoRef,
    /// Its `repo.description`.
    pub description: String,
}

#[cfg(test)]
mod tests {
    use super::repo_slug;

    #[test]
    fn slugs_follow_the_contract_pattern() {
        assert_eq!(repo_slug("Dash-Forge").unwrap(), "dash-forge");
        assert_eq!(repo_slug("a.b_c-1").unwrap(), "a.b_c-1");
        for bad in ["", ".x", "-x", "has space", "é", "a/b", &"x".repeat(64)] {
            assert!(repo_slug(bad).is_err(), "{bad:?} should be refused");
        }
    }
}
