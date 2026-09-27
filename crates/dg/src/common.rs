//! Shared command helpers: `owner/name` parsing and repo resolution.

use anyhow::{Context as _, Result};

use forge_core::platform::{LoadedIdentity, PlatformClient};
use forge_core::scope::RepoRef as Repo;
use forge_core::user_error::{codes, UserError};

/// A parsed `owner/name` (or bare `name`) repository reference.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoRef {
    /// The owner: a base58 identity id or a DPNS name (`alice`, `alice.dash`), resolved by
    /// `forge_core::resolve::resolve_owner`. `None` when the caller passed a bare `name` and
    /// the signing identity should be used.
    pub owner: Option<String>,
    /// The repository name.
    pub name: String,
}

impl RepoRef {
    /// Parse an `owner/name` reference, or a bare `name` (owner defaults to the signing
    /// identity). The owner is a base58 identity id or a DPNS name; anything else is
    /// rejected with an actionable message.
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
        if !looks_like_identity_id(owner) && forge_core::resolve::dpns_label(owner).is_none() {
            return Err(invalid_ref(
                s,
                &format!("owner {owner:?} is neither a base58 identity id nor a DPNS name"),
            ));
        }
        Ok(Self {
            owner: Some(owner.to_string()),
            name: name.to_string(),
        })
    }

    /// The repo id, when the reference is a bare base58 id (a forge-v2 repo document id, as
    /// `dash://<id>` takes). Repo names are lowercase, so a base58 id — which mixes cases —
    /// can never be mistaken for one.
    pub fn repo_id(&self) -> Option<&str> {
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
    .fix("use `<owner>/<name>` with the owner's identity id or DPNS name, e.g. `alice/project` or `8hJmcHWTsdvkHyCrk4UgjbyugDAmE7QfuCTQXpXAc7nB/project`, a bare `<name>` for your own repositories, or the repo's id")
    .into()
}

/// Whether `s` is plausibly a base58 identity id (32-byte id ≈ 42-44 base58 chars, no
/// `0OIl` and no `/`). Used to distinguish an identity owner from a DPNS label.
fn looks_like_identity_id(s: &str) -> bool {
    forge_core::resolve::looks_like_identity_id(s)
}

/// Resolve a [`RepoRef`]: a bare id as a repo document id; otherwise `owner/name`.
pub async fn resolve(
    client: &PlatformClient,
    identity: &LoadedIdentity,
    repo_ref: &RepoRef,
) -> Result<Repo> {
    resolve_for(client, Some(&identity.id()), repo_ref).await
}

/// [`resolve`] for a command that may run without an identity: a bare `name` needs
/// `default_owner` (the signer), else it is a usage error.
pub async fn resolve_for(
    client: &PlatformClient,
    default_owner: Option<&str>,
    repo_ref: &RepoRef,
) -> Result<Repo> {
    if let Some(id) = repo_ref.repo_id() {
        return forge_core::resolve::resolve_id(client, id)
            .await
            .with_context(|| format!("resolving repo {id}"));
    }
    let owner = repo_ref
        .owner
        .as_deref()
        .or(default_owner)
        .ok_or_else(|| crate::errors::usage("name the repository as `<owner>/<name>`"))?
        .to_string();
    // `with_context`, not a flattened message: the typed forge-core error must survive for
    // the error renderer (NotFound → E102, a network failure → E701).
    forge_core::resolve::resolve_named(client, &owner, &repo_ref.name)
        .await
        .with_context(|| format!("resolving {owner}/{}", repo_ref.name))
}

/// A connected signer and the repository a command acts on.
pub struct Session {
    /// The connection.
    pub client: PlatformClient,
    /// The signing key material.
    pub bridge: forge_core::keystore::BridgeIdentity,
    /// The signing identity.
    pub identity: LoadedIdentity,
    /// The resolved repository.
    pub repo: Repo,
}

impl Session {
    /// Parse `repo`, connect, fetch the signer and resolve the repository.
    pub async fn open(ctx: &crate::context::Ctx, repo: &str) -> Result<Self> {
        let repo_ref = RepoRef::parse(repo)?;
        let (client, bridge, identity) = ctx.connect_with_identity().await?;
        let repo = resolve(&client, &identity, &repo_ref).await?;
        Ok(Self {
            client,
            bridge,
            identity,
            repo,
        })
    }

    /// The forge-v2 collaboration service, signing as this session's identity.
    pub fn collab(&self) -> forge_core::collab::v2::Collab<'_> {
        forge_core::collab::v2::Collab::new(&self.client, &self.identity, &self.bridge)
    }

    /// Credits spent since `before` (0 when the balance cannot be read). A write that just
    /// landed can be read from a node a block behind, which still shows the old balance, so
    /// the balance is read a few times until it moves.
    pub async fn spent_since(&self, before: u64) -> u64 {
        for attempt in 0..4 {
            if let Ok(after) = self.client.get_balance(&self.identity.id()).await {
                if after < before || attempt == 3 {
                    return before.saturating_sub(after);
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
        }
        0
    }

    /// The signer's balance now (0 when unreadable), for [`Self::spent_since`].
    pub async fn balance(&self) -> u64 {
        self.client
            .get_balance(&self.identity.id())
            .await
            .unwrap_or(0)
    }
}

/// An issue / PR number as the contract stores it (1..=2^32-1), or a usage error.
pub fn number_arg(n: u64) -> Result<u32> {
    u32::try_from(n).ok().filter(|n| *n > 0).ok_or_else(|| {
        crate::errors::usage(format!("{n} is not an issue or PR number (1-4294967295)"))
    })
}

#[cfg(test)]
mod tests {
    use super::{looks_like_identity_id, RepoRef};

    // A real testnet identity id shape (DEPLOYER).
    const ID: &str = "8hJmcHWTsdvkHyCrk4UgjbyugDAmE7QfuCTQXpXAc7nB";

    #[test]
    fn parses_owner_slash_name() {
        let r = RepoRef::parse(&format!("{ID}/my-repo")).unwrap();
        assert_eq!(r.owner.as_deref(), Some(ID));
        assert_eq!(r.name, "my-repo");
    }

    #[test]
    fn parses_bare_name_as_default_owner() {
        let r = RepoRef::parse("just-a-name").unwrap();
        assert!(r.owner.is_none());
        assert_eq!(r.name, "just-a-name");
    }

    #[test]
    fn a_bare_contract_id_is_a_contract_reference() {
        let r = RepoRef::parse(ID).unwrap();
        assert_eq!(r.repo_id(), Some(ID));
        assert_eq!(RepoRef::parse("my-repo").unwrap().repo_id(), None);
        assert_eq!(
            RepoRef::parse(&format!("{ID}/my-repo")).unwrap().repo_id(),
            None
        );
    }

    #[test]
    fn accepts_a_dpns_owner_and_refuses_junk() {
        for (input, owner) in [
            ("alice/project", "alice"),
            ("alice.dash/project", "alice.dash"),
        ] {
            let r = RepoRef::parse(input).unwrap();
            assert_eq!(r.owner.as_deref(), Some(owner));
            assert_eq!(r.name, "project");
        }
        for bad in ["al ice/project", "a_b/project", ".dash/project"] {
            assert!(RepoRef::parse(bad).is_err(), "{bad:?} should be refused");
        }
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
