//! Shared command helpers: `owner/name` parsing and repo resolution.

use anyhow::{Context as _, Result};

use forge_core::platform::{LoadedIdentity, PlatformClient};
use forge_core::scope::RepoRef as Repo;
use forge_core::user_error::{codes, UserError};

/// A parsed `owner/name` (or bare `name`) repository reference.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoRef {
    /// The owner: a base58 identity id (DPNS labels are not yet resolvable). `None` when the
    /// caller passed a bare `name` and the signing identity should be used.
    pub owner: Option<String>,
    /// The repository name.
    pub name: String,
}

impl RepoRef {
    /// Parse an `owner/name` reference, or a bare `name` (owner defaults to the signing
    /// identity). A `owner` that is not plausibly a base58 identity id is rejected with an
    /// actionable message (DPNS resolution is a documented follow-up).
    pub fn parse(s: &str) -> Result<Self> {
        let Some((owner, name)) = s.split_once('/') else {
            if s.is_empty() {
                return Err(invalid_ref(s, "the repository reference is empty"));
            }
            return Ok(Self {
                owner: None,
                name: s.to_string(),
            });
        };
        if owner.is_empty() || name.is_empty() {
            return Err(invalid_ref(s, "expected `owner/name`"));
        }
        if !looks_like_identity_id(owner) {
            return Err(invalid_ref(
                s,
                &format!(
                    "owner {owner:?} is not a base58 identity id (DPNS name resolution is not yet wired)"
                ),
            ));
        }
        Ok(Self {
            owner: Some(owner.to_string()),
            name: name.to_string(),
        })
    }

    /// The effective owner: the parsed owner, or `default_owner` for a bare name.
    pub fn owner_or<'a>(&'a self, default_owner: &'a str) -> &'a str {
        self.owner.as_deref().unwrap_or(default_owner)
    }

    /// The repo id, when the reference is a bare base58 id (a forge-v2 repo id or a v1
    /// repo contract id, as `dash://<id>` takes). Repo names are lowercase, so a base58
    /// id — which mixes cases — can never be mistaken for one.
    pub fn contract_id(&self) -> Option<&str> {
        (self.owner.is_none()
            && looks_like_identity_id(&self.name)
            && self.name.chars().any(|c| c.is_ascii_uppercase()))
        .then_some(self.name.as_str())
    }
}

/// E203 for an unusable `owner/name`.
fn invalid_ref(input: &str, why: &str) -> anyhow::Error {
    UserError::new(
        codes::INVALID_REPO_REF,
        format!("invalid repository reference {input:?}"),
    )
    .cause(why)
    .fix("use `<owner identity id>/<name>`, e.g. `8hJmcHWTsdvkHyCrk4UgjbyugDAmE7QfuCTQXpXAc7nB/project`, a bare `<name>` for your own repositories, or the repo's contract id")
    .into()
}

/// Whether `s` is plausibly a base58 identity id (32-byte id ≈ 42-44 base58 chars, no
/// `0OIl` and no `/`). Used to distinguish an identity owner from a DPNS label.
fn looks_like_identity_id(s: &str) -> bool {
    (40..=44).contains(&s.len())
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() && !matches!(c, '0' | 'O' | 'I' | 'l'))
}

/// Resolve a [`RepoRef`]: a bare id as a forge-v2 repo id or a v1 contract id; otherwise
/// `owner/name` as a forge-v2 repo, falling back to a (read-only) v1 registry listing.
pub async fn resolve(
    client: &PlatformClient,
    identity: &LoadedIdentity,
    repo_ref: &RepoRef,
) -> Result<Repo> {
    if let Some(id) = repo_ref.contract_id() {
        return forge_core::resolve::resolve_id(client, id)
            .await
            .with_context(|| format!("resolving repo {id}"));
    }
    let owner = repo_ref.owner_or(&identity.id()).to_string();
    // `with_context`, not a flattened message: the typed forge-core error must survive for
    // the error renderer (NotFound → E102, a network failure → E701).
    forge_core::resolve::resolve_named(client, &owner, &repo_ref.name)
        .await
        .with_context(|| format!("resolving {owner}/{}", repo_ref.name))
}

#[cfg(test)]
mod tests {
    use super::{looks_like_identity_id, RepoRef};

    // A real testnet identity id shape (DEPLOYER).
    const ID: &str = "8hJmcHWTsdvkHyCrk4UgjbyugDAmE7QfuCTQXpXAc7nB";

    #[test]
    fn parses_owner_slash_name() {
        let r = RepoRef::parse(&format!("{ID}/m1-75299")).unwrap();
        assert_eq!(r.owner.as_deref(), Some(ID));
        assert_eq!(r.name, "m1-75299");
    }

    #[test]
    fn parses_bare_name_as_default_owner() {
        let r = RepoRef::parse("just-a-name").unwrap();
        assert!(r.owner.is_none());
        assert_eq!(r.name, "just-a-name");
        assert_eq!(r.owner_or("owner-x"), "owner-x");
    }

    #[test]
    fn a_bare_contract_id_is_a_contract_reference() {
        let r = RepoRef::parse(ID).unwrap();
        assert_eq!(r.contract_id(), Some(ID));
        assert_eq!(RepoRef::parse("my-repo").unwrap().contract_id(), None);
        assert_eq!(
            RepoRef::parse(&format!("{ID}/my-repo"))
                .unwrap()
                .contract_id(),
            None
        );
    }

    #[test]
    fn rejects_dpns_owner() {
        let err = RepoRef::parse("alice/project").unwrap_err();
        assert!(err.to_string().contains("DPNS"));
    }

    #[test]
    fn identity_id_shape_detection() {
        assert!(looks_like_identity_id(ID));
        assert!(!looks_like_identity_id("alice"));
        assert!(!looks_like_identity_id(
            "has space in it xxxxxxxxxxxxxxxxxxx"
        ));
    }
}
