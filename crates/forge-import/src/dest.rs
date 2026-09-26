//! The destination: a forge-v2 repository the signer mirrors into. Shared by `import` and
//! `migrate`: resolve (or create) the repository, check the signer can write what the run
//! needs, and read the signing key's limits for the summary.

use std::path::Path;

use anyhow::{bail, Context, Result};

use forge_core::create::{create_repo, default_journal_dir, CreateRepoOpts};
use forge_core::keystore::BridgeIdentity;
use forge_core::members::MemberReader;
use forge_core::platform::{LoadedIdentity, PlatformClient};
use forge_core::resolve::{find_v2, repo_slug, resolve_id};
use forge_core::rules::v2::{Role, Visibility};
use forge_core::scope::RepoRef;

use crate::summary::{KeyInfo, RepoInfo};

/// Estimated cost of creating a repository (`repo` + owner `maintainer` + `config`),
/// credits. Measured on moutai at about 0.0013 DASH; rounded up.
pub const REPO_CREATE_CREDITS: u64 = 200_000_000;

/// The signer.
pub struct Signer {
    /// Key material.
    pub bridge: BridgeIdentity,
    /// The identity on chain.
    pub identity: LoadedIdentity,
}

impl Signer {
    /// Load `source` (an identity file or an inline `dfk1:` key) and fetch the identity.
    pub async fn load(client: &PlatformClient, source: &Path) -> Result<Self> {
        let bridge = BridgeIdentity::load_from_file(source).with_context(|| {
            format!(
                "loading the signing identity from {}",
                forge_core::keystore::describe_key_source(source)
            )
        })?;
        let identity = client
            .fetch_identity(&bridge.identity_id)
            .await
            .with_context(|| format!("fetching identity {}", bridge.identity_id))?;
        Ok(Self { bridge, identity })
    }

    /// The identity id.
    pub fn id(&self) -> String {
        self.identity.id()
    }

    /// The signing key's limits (budget, what is left of it, expiry).
    pub async fn key_info(&self, client: &PlatformClient) -> KeyInfo {
        let Ok(key) = self.bridge.doc_op_key() else {
            return KeyInfo::default();
        };
        let limits = self.identity.key_limits(key.id);
        let budget = limits.and_then(|l| l.total_budget);
        let remaining = match budget {
            Some(_) => client
                .key_remaining_budget(&self.id(), key.id)
                .await
                .ok()
                .flatten(),
            None => None,
        };
        KeyInfo {
            id: Some(key.id),
            budget_credits: budget,
            remaining_credits: remaining,
            expires_at: limits.and_then(|l| l.expires_at),
        }
    }
}

/// Where a run writes: an existing repository, or one it will create.
#[derive(Debug, Clone)]
pub struct DestRepo {
    /// Owner identity.
    pub owner: String,
    /// Slug.
    pub name: String,
    /// The repository, when it exists.
    pub existing: Option<RepoRef>,
}

impl DestRepo {
    /// `dash://owner/name`.
    pub fn url(&self) -> String {
        format!("dash://{}/{}", self.owner, self.name)
    }

    /// The summary's view.
    pub fn info(&self, created: bool) -> RepoInfo {
        RepoInfo {
            owner: self.owner.clone(),
            name: self.name.clone(),
            id: self
                .existing
                .as_ref()
                .map(|r| r.id().to_string())
                .unwrap_or_default(),
            url: self.url(),
            created,
        }
    }
}

/// Resolve `spec` (`owner/name`, `dash://owner/name`, a repo id, or a bare name meaning the
/// signer's) on the destination network. A forge-v1 repository is refused: v1 is read only.
pub async fn resolve(
    client: &PlatformClient,
    signer: Option<&str>,
    spec: &str,
) -> Result<DestRepo> {
    let spec = spec
        .trim()
        .trim_start_matches("dash://")
        .trim_end_matches('/');
    let forge = client
        .target()
        .v2
        .clone()
        .ok_or_else(|| forge_core::Error::V2NotDeployed {
            network: client.target().network.key(),
        })?;
    let looks_like_id = !spec.contains('/')
        && (40..=44).contains(&spec.len())
        && spec.chars().any(|c| c.is_ascii_uppercase());
    if looks_like_id {
        let repo = resolve_id(client, spec)
            .await
            .with_context(|| format!("resolving repo {spec}"))?;
        if repo.is_v1() {
            bail!("{spec} is a forge-v1 repository (read only); mirror into a forge-v2 repository");
        }
        return Ok(DestRepo {
            owner: repo.owner_id().to_string(),
            name: repo.name().to_string(),
            existing: Some(repo),
        });
    }
    let (owner, name) = match spec.split_once('/') {
        Some((o, n)) => (o.to_string(), n.to_string()),
        None => (
            signer
                .ok_or_else(|| {
                    anyhow::anyhow!("a bare repository name needs a signing identity (its owner)")
                })?
                .to_string(),
            spec.to_string(),
        ),
    };
    let name = repo_slug(&name)?;
    let owner_bytes = forge_core::platform::decode_identifier(&owner)
        .with_context(|| format!("owner {owner:?} is not an identity id"))?;
    let existing = find_v2(client, &forge, owner_bytes, &name).await?;
    Ok(DestRepo {
        owner,
        name,
        existing,
    })
}

/// Create `dest` (the signer must be its owner). Resumable: an interrupted create finishes
/// without paying twice. Returns whether this call created anything.
pub async fn create(
    client: &PlatformClient,
    signer: &Signer,
    dest: &mut DestRepo,
    description: &str,
    default_branch: &str,
    backend_mode: u8,
) -> Result<bool> {
    if dest.owner != signer.id() {
        bail!(
            "{} does not exist, and only its owner ({}) can create it; create it as the owner \
             first, or mirror into a repository of your own",
            dest.url(),
            dest.owner
        );
    }
    let opts = CreateRepoOpts {
        name: dest.name.clone(),
        display_name: String::new(),
        description: crate::model::clip(description, 500, 2000),
        default_branch: if default_branch.is_empty() {
            "main".into()
        } else {
            default_branch.to_string()
        },
        backend_mode,
        visibility: Visibility::Public,
        fork_of: None,
    };
    let res = create_repo(
        client,
        &signer.identity,
        &signer.bridge,
        &opts,
        &default_journal_dir()?,
    )
    .await
    .with_context(|| format!("creating {}", dest.url()))?;
    let created = !res.already_existed();
    dest.existing = Some(res.repo);
    Ok(created)
}

/// The signer's role in `repo`, refusing a signer that is not a member (nothing could be
/// written; say who can fix it).
pub async fn require_member(client: &PlatformClient, repo: &RepoRef, signer: &str) -> Result<Role> {
    let role = MemberReader::new(client)
        .roles_of(repo, signer)
        .await?
        .iter()
        .map(|m| m.role)
        .min();
    role.ok_or_else(|| {
        anyhow::anyhow!(
            "{signer} is not a member of {}: the mirror identity writes pushes and issue state, \
             so it must be a maintainer (or a writer, without releases). The owner can run \
             `dg collab add {} {signer} --role maintainer`",
            repo.display(),
            repo.display()
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dest_urls_and_info() {
        let d = DestRepo {
            owner: "O".into(),
            name: "n".into(),
            existing: None,
        };
        assert_eq!(d.url(), "dash://O/n");
        let i = d.info(false);
        assert!(i.id.is_empty() && !i.created);
    }
}
