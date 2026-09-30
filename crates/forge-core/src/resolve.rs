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
use crate::user_error::{codes, UserError};

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

/// Whether `s` is plausibly a base58 identity id (a 32-byte id is 40-44 base58 characters,
/// an alphabet without `0`, `O`, `I` and `l`), rather than a DPNS name. A DPNS label is at
/// most 63 characters of `a-z0-9-` and may be as long, so an all-lowercase 40+ character
/// string that also decodes as an id is ambiguous: the id reading wins, as in `dg`.
pub fn looks_like_identity_id(s: &str) -> bool {
    (40..=44).contains(&s.len())
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() && !matches!(c, '0' | 'O' | 'I' | 'l'))
        && platform::decode_identifier(s).is_ok()
}

/// The DPNS label `owner` names (`alice` for `alice` or `alice.dash`, the suffix matched
/// case-insensitively as DPNS does), or `None` when it cannot be a DPNS name.
pub fn dpns_label(owner: &str) -> Option<&str> {
    let label = match owner.len().checked_sub(5) {
        Some(at) if owner.is_char_boundary(at) && owner[at..].eq_ignore_ascii_case(".dash") => {
            &owner[..at]
        }
        _ => owner,
    };
    (!label.is_empty()
        && label
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-'))
    .then_some(label)
}

/// The identity id `owner` names: `owner` itself when it is a base58 identity id, else a
/// DPNS name (`alice`, `alice.dash`) resolved to the identity its `domain` record points at
/// (proof-verified). An unregistered name is E102 naming it; a string that is neither is
/// E203.
pub async fn resolve_owner(client: &PlatformClient, owner: &str) -> Result<String> {
    if looks_like_identity_id(owner) {
        return Ok(owner.to_string());
    }
    let Some(label) = dpns_label(owner) else {
        return Err(UserError::new(
            codes::INVALID_REPO_REF,
            format!("owner {owner:?} is neither an identity id nor a DPNS name"),
        )
        .cause("a DPNS name is letters, digits and '-', optionally ending in .dash")
        .fix("use the owner's base58 identity id or DPNS username, e.g. `alice/project`")
        .into());
    };
    client.resolve_dpns_name(label).await?.ok_or_else(|| {
        let id_shaped = owner.len() >= 40;
        UserError::new(
            codes::NOT_FOUND,
            if id_shaped {
                format!("owner {owner:?} is neither a valid identity id nor a registered DPNS name")
            } else {
                format!("no DPNS name {label}.dash is registered")
            },
        )
        .fix("check the spelling, or use the owner's base58 identity id")
        .into()
    })
}

/// Resolve `owner/name`; `owner` is a base58 identity id or a DPNS name ([`resolve_owner`]).
pub async fn resolve_named(client: &PlatformClient, owner: &str, name: &str) -> Result<RepoRef> {
    let slug = repo_slug(name)?;
    let owner = resolve_owner(client, owner).await?;
    let owner_bytes = platform::decode_identifier(&owner)?;
    let forge = client.target().require_v2()?;
    find_named(client, forge, owner_bytes, &slug)
        .await?
        .ok_or(Error::NotFound)
}

/// The repo `owner` named `slug`, if it exists (proved either way).
pub async fn find_named(
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
    let forge = client.target().require_v2()?;
    if forge.contains(id) {
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

/// The `description` of a repo's `repo` document, as [`list_owned`] reads it (`""` when it
/// has none).
pub async fn repo_description(client: &PlatformClient, repo: &RepoRef) -> Result<String> {
    let core = client.fetch_contract(&repo.forge.core).await?;
    Ok(client
        .fetch_document(&core, DOC_REPO, &repo.repo_id)
        .await?
        .and_then(|d| d.field_str("description"))
        .unwrap_or_default())
}

/// Every repository `owner` has, by name.
pub async fn list_owned(client: &PlatformClient, owner: &str) -> Result<Vec<RepoSummary>> {
    let owner_bytes = platform::decode_identifier(owner)?;
    let forge = client.target().require_v2()?;
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
    use super::{dpns_label, looks_like_identity_id, repo_slug};

    #[test]
    fn dpns_labels_strip_the_suffix_case_insensitively() {
        assert_eq!(dpns_label("alice"), Some("alice"));
        assert_eq!(dpns_label("alice.dash"), Some("alice"));
        assert_eq!(dpns_label("alice.DASH"), Some("alice"));
        assert_eq!(dpns_label(".dash"), None);
        assert_eq!(dpns_label("al ice"), None);
        assert_eq!(dpns_label("a_b"), None);
    }

    #[test]
    fn identity_ids_and_dpns_names_are_told_apart() {
        assert!(looks_like_identity_id(
            "9cBMULwtQUMtxhBkgaTKb4tJtoczd8TEQ8gmiroDWf4F"
        ));
        for name in ["alice", "alice.dash", "pasta", "a-b-c", &"x".repeat(44)] {
            assert!(!looks_like_identity_id(name), "{name:?} is a DPNS name");
        }
    }

    #[test]
    fn identity_id_length_boundary_is_40_to_44() {
        // 39 and 45 base58 characters are outside the range a 32-byte id decodes to.
        assert!(!looks_like_identity_id(&"a".repeat(39)));
        assert!(!looks_like_identity_id(&"a".repeat(45)));
        // Inside the range but containing a base58-excluded character (`0`, `O`, `I`, `l`)
        // is still not id-shaped, so it is tried as a DPNS name instead.
        let mut excluded = "a".repeat(39);
        excluded.push('0');
        assert_eq!(excluded.len(), 40);
        assert!(!looks_like_identity_id(&excluded));
    }

    #[test]
    fn an_id_shaped_string_wins_over_the_dpns_reading() {
        // `resolve_owner`'s doc comment promises the id reading wins when a string is both
        // id-shaped and a legal DPNS label (an all-lowercase 40+ character string of
        // `a-z0-9-`, e.g. a 44-char label, decodes as an id too): `looks_like_identity_id`
        // must be checked before `dpns_label` is even consulted, which `resolve_owner` does.
        let ambiguous = "9cBMULwtQUMtxhBkgaTKb4tJtoczd8TEQ8gmiroDWf4F";
        assert!(looks_like_identity_id(ambiguous));
        assert!(dpns_label(ambiguous).is_some());
    }

    #[test]
    fn slugs_follow_the_contract_pattern() {
        assert_eq!(repo_slug("Dash-Forge").unwrap(), "dash-forge");
        assert_eq!(repo_slug("a.b_c-1").unwrap(), "a.b_c-1");
        for bad in ["", ".x", "-x", "has space", "é", "a/b", &"x".repeat(64)] {
            assert!(repo_slug(bad).is_err(), "{bad:?} should be refused");
        }
    }
}
