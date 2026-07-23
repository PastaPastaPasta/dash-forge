//! Shared command helpers: `owner/name` parsing and repo resolution.

use anyhow::{anyhow, bail, Result};

use forge_core::keystore::BridgeIdentity;
use forge_core::platform::{LoadedIdentity, PlatformClient};
use forge_core::repo::{RepoHandle, RepoService};

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
                bail!("empty repo reference");
            }
            return Ok(Self {
                owner: None,
                name: s.to_string(),
            });
        };
        if owner.is_empty() || name.is_empty() {
            bail!("invalid repo reference {s:?}: expected `owner/name`");
        }
        if !looks_like_identity_id(owner) {
            bail!(
                "owner {owner:?} is not a base58 identity id — DPNS name resolution is \
                 not yet wired; pass the owner's base58 identity id"
            );
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
}

/// Whether `s` is plausibly a base58 identity id (32-byte id ≈ 42-44 base58 chars, no
/// `0OIl` and no `/`). Used to distinguish an identity owner from a DPNS label.
fn looks_like_identity_id(s: &str) -> bool {
    (40..=44).contains(&s.len())
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() && !matches!(c, '0' | 'O' | 'I' | 'l'))
}

/// Resolve a [`RepoRef`] to a [`RepoHandle`] via the registry.
pub async fn resolve(
    client: &PlatformClient,
    identity: &LoadedIdentity,
    bridge: &BridgeIdentity,
    repo_ref: &RepoRef,
) -> Result<RepoHandle> {
    let owner = repo_ref.owner_or(&identity.id()).to_string();
    let svc = RepoService::new(client, identity, bridge);
    svc.resolve_repo(&owner, &repo_ref.name)
        .await
        .map_err(|e| anyhow!("resolving {owner}/{}: {e}", repo_ref.name))
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
