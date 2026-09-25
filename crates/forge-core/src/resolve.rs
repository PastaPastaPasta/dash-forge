//! Resolving a repository reference (`owner/name`, or an id) to a [`RepoRef`].
//!
//! * `owner/name`: the name is checked and normalized as a forge-v2 slug
//!   ([`crate::rules::v2::normalize_repo_name`]), then looked up as a forge-core `repo`
//!   through its unique `($ownerId, name)` index. Only when that lookup *proves* there is no
//!   such repo does it fall back to the v1 registry listing (read-only repositories). A
//!   failed lookup is an error, never a fallback, so a flaky node cannot send a push to a
//!   different repository than the name means.
//! * an id: a forge-core `repo` document id first, then a v1 repo contract id. Both lookups
//!   are proof-verified; the ids are 32-byte hashes of different preimages, so at most one
//!   can exist, and the forge contracts themselves are refused as "repo contracts".
//!
//! A network with no forge-v2 deployment resolves v1 repositories only; one with no
//! registry resolves v2 repositories only.

use crate::error::{Error, Result};
use crate::network::ForgeIds;
use crate::platform::{self, FetchedDocument, FieldValue, PlatformClient, QueryFilter, QueryOrder};
use crate::rules::v2::normalize_repo_name;
use crate::scope::{visibility_of, RepoRef};

/// The forge-core document type of a repository.
pub const DOC_REPO: &str = "repo";
/// The v1 registry listing type.
const DOC_REPO_LISTING: &str = "repoListing";

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
    Ok(RepoRef::V2 {
        forge: forge.clone(),
        repo_id: doc.id.clone(),
        owner_id: doc.owner_id.clone(),
        name: doc
            .field_str("name")
            .ok_or_else(|| Error::Platform(format!("repo {} has no name", doc.id)))?,
        visibility: visibility_of(doc),
    })
}

/// Resolve `owner/name` (owner a base58 identity id): v2 first, then the v1 registry.
pub async fn resolve_named(client: &PlatformClient, owner: &str, name: &str) -> Result<RepoRef> {
    let slug = repo_slug(name)?;
    let owner_bytes = platform::decode_identifier(owner)?;
    let target = client.target();
    if let Some(forge) = &target.v2 {
        if let Some(repo) = find_v2(client, forge, owner_bytes, &slug).await? {
            return Ok(repo);
        }
    }
    match (&target.registry, &target.v2) {
        (Some(_), _) => find_v1(client, owner, owner_bytes, &slug)
            .await?
            .ok_or(Error::NotFound),
        (None, Some(_)) => Err(Error::NotFound),
        (None, None) => Err(Error::V2NotDeployed {
            network: target.network.key(),
        }),
    }
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

/// The v1 repo `owner` listed as `slug` in the registry, if any.
async fn find_v1(
    client: &PlatformClient,
    owner: &str,
    owner_bytes: [u8; 32],
    slug: &str,
) -> Result<Option<RepoRef>> {
    let registry = client.fetch_registry().await?;
    let docs = client
        .query_documents(
            &registry,
            DOC_REPO_LISTING,
            &[
                QueryFilter::eq("$ownerId", FieldValue::identifier(owner_bytes)),
                QueryFilter::eq("normalizedName", FieldValue::text(slug)),
            ],
            &[],
            1,
            None,
        )
        .await?;
    let Some(listing) = docs.into_iter().next() else {
        return Ok(None);
    };
    let contract = listing
        .field_bytes32("repoContractId")
        .ok_or_else(|| Error::Platform("repoListing missing repoContractId".into()))?;
    Ok(Some(RepoRef::V1 {
        contract_id: platform::encode_identifier(contract),
        owner_id: owner.to_string(),
        name: listing
            .field_str("name")
            .unwrap_or_else(|| slug.to_string()),
    }))
}

/// Resolve a bare id: a forge-v2 `repo` document id, else a v1 repo contract id.
pub async fn resolve_id(client: &PlatformClient, id: &str) -> Result<RepoRef> {
    platform::decode_identifier(id)?;
    let target = client.target();
    if let Some(forge) = &target.v2 {
        let core = client.fetch_contract(&forge.core).await?;
        if let Some(doc) = client.fetch_document(&core, DOC_REPO, id).await? {
            return repo_ref_from_doc(forge, &doc);
        }
        if id == forge.core || id == forge.collab {
            return Err(Error::Config(format!(
                "{id} is a forge-v2 contract, not a repository; address a repo as \
                 dash://<owner>/<name> or by its repo id"
            )));
        }
    }
    let contract = client.fetch_contract(id).await?;
    // A v1 repo contract carries the git data-plane types itself; any other contract
    // (DPNS, the registry, forge-collab) is not a repository.
    if !contract.has_document_type("refUpdate") || contract.has_document_type(DOC_REPO) {
        return Err(Error::Config(format!(
            "{id} is a data contract but not a Dash Forge v1 repository"
        )));
    }
    Ok(RepoRef::V1 {
        contract_id: contract.id(),
        owner_id: contract.owner_id(),
        name: contract.id(),
    })
}

/// Every repository `owner` has: forge-v2 repos (when deployed), then v1 registry listings
/// (when a registry is deployed), each by name.
pub async fn list_owned(client: &PlatformClient, owner: &str) -> Result<Vec<RepoSummary>> {
    let owner_bytes = platform::decode_identifier(owner)?;
    let target = client.target();
    let mut out = Vec::new();
    if let Some(forge) = &target.v2 {
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
        for d in &docs {
            out.push(RepoSummary {
                repo: repo_ref_from_doc(forge, d)?,
                description: d.field_str("description").unwrap_or_default(),
            });
        }
    }
    if target.registry.is_some() {
        let registry = client.fetch_registry().await?;
        let docs = client
            .query_all_documents(
                &registry,
                DOC_REPO_LISTING,
                &[QueryFilter::eq(
                    "$ownerId",
                    FieldValue::identifier(owner_bytes),
                )],
                &[QueryOrder::asc("normalizedName")],
            )
            .await?;
        for d in &docs {
            let Some(contract) = d.field_bytes32("repoContractId") else {
                continue;
            };
            out.push(RepoSummary {
                repo: RepoRef::V1 {
                    contract_id: platform::encode_identifier(contract),
                    owner_id: owner.to_string(),
                    name: d
                        .field_str("normalizedName")
                        .or_else(|| d.field_str("name"))
                        .unwrap_or_default(),
                },
                description: d.field_str("description").unwrap_or_default(),
            });
        }
    }
    Ok(out)
}

/// One row of [`list_owned`].
#[derive(Debug, Clone)]
pub struct RepoSummary {
    /// The repository.
    pub repo: RepoRef,
    /// Its description (v2 `repo.description`, v1 listing description).
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
