//! An organization's owner actions as unsigned writes, built from the same property builders a
//! personal owner's writes use, so an organization's documents are identical to anyone's.

use std::collections::BTreeMap;

use crate::create::{config_props, owner_maintainer_props, repo_props, validated, CreateRepoOpts};
use crate::error::{Error, Result};
use crate::members::{
    check_grant, consent_doc, doc_type, member_doc_props, owner_row_refusal, scoped, MemberReader,
};
use crate::network::ForgeIds;
use crate::platform::org::{OrgWriter, UnsignedWrite};
use crate::platform::{self, LoadedIdentity, PlatformClient};
use crate::refs::DOC_CONFIG;
use crate::resolve::{find_named, DOC_REPO};
use crate::rules::v2::{Role, Visibility};
use crate::scope::{DocScope, RepoRef};

/// Hands out identity-contract nonces: above the identity's current one and above every nonce
/// an open request of the organization already holds, consecutive within one request. An open
/// nonce further ahead than Platform accepts is ignored (it can never land), and a nonce that
/// would be is refused.
pub struct Nonces<'a> {
    writer: &'a OrgWriter<'a>,
    floor: BTreeMap<String, u64>,
    next: BTreeMap<String, u64>,
}

impl<'a> Nonces<'a> {
    pub fn new(writer: &'a OrgWriter<'a>, floor: BTreeMap<String, u64>) -> Self {
        Self {
            writer,
            floor,
            next: BTreeMap::new(),
        }
    }

    pub async fn take(&mut self, contract_id: &str) -> Result<u64> {
        let next = if let Some(n) = self.next.get(contract_id) {
            *n
        } else {
            let current = self.writer.current_nonce(contract_id).await?;
            let floor = self
                .floor
                .get(contract_id)
                .copied()
                .filter(|n| !current.too_far(*n))
                .unwrap_or(0);
            let next = current.tip().max(floor) + 1;
            if current.too_far(next) {
                return Err(Error::Config(
                    "the organization has too many open requests: finish or decline some first"
                        .into(),
                ));
            }
            next
        };
        self.next.insert(contract_id.to_string(), next + 1);
        Ok(next)
    }
}

/// The organization acting as owner: its connection, its writer and its display label.
pub struct Owner<'a> {
    pub client: &'a PlatformClient,
    pub org: &'a LoadedIdentity,
    pub writer: &'a OrgWriter<'a>,
    pub label: &'a str,
}

/// A request to make: its title and its writes, in order.
#[derive(Debug, Clone)]
pub struct Planned {
    pub title: String,
    pub writes: Vec<UnsignedWrite>,
}

fn forge_of(client: &PlatformClient) -> Result<ForgeIds> {
    Ok(client.target().require_v2()?.clone())
}

/// Create a public repository owned by the organization: `repo`, the organization's own
/// `maintainer`, then the first `config` (§2 "Create a repository").
pub async fn repo_create(
    owner: &Owner<'_>,
    nonces: &mut Nonces<'_>,
    opts: &CreateRepoOpts,
) -> Result<Planned> {
    let Owner {
        client,
        org,
        writer,
        label,
    } = *owner;
    if opts.visibility == Visibility::Private {
        return Err(Error::Config(
            "an organization's repositories are public for now".into(),
        ));
    }
    let opts = validated(&CreateRepoOpts {
        members_only: false,
        ..opts.clone()
    })?;
    let forge = forge_of(client)?;
    let owner_id = platform::decode_identifier(&org.id())?;
    if find_named(client, &forge, owner_id, &opts.name)
        .await?
        .is_some()
    {
        return Err(Error::Config(format!(
            "{label}/{} already exists",
            opts.name
        )));
    }
    let core = client.fetch_contract(&forge.core).await?;
    let repo = writer
        .create(
            &core,
            DOC_REPO,
            repo_props(&opts),
            nonces.take(&forge.core).await?,
        )
        .await?;
    let scope = DocScope {
        contract_id: forge.core.clone(),
        repo_id: platform::decode_identifier(&repo.document_id)?,
    };
    let maintainer = writer
        .create(
            &core,
            doc_type(Role::Maintainer),
            owner_maintainer_props(&scope, owner_id, opts.visibility),
            nonces.take(&forge.core).await?,
        )
        .await?;
    let config = writer
        .create(
            &core,
            DOC_CONFIG,
            scope.scoped(config_props(&opts)),
            nonces.take(&forge.core).await?,
        )
        .await?;
    Ok(Planned {
        title: format!("Create {label}/{}", opts.name),
        writes: vec![repo, maintainer, config],
    })
}

async fn refuse_keyed(client: &PlatformClient, repo: &RepoRef, label: &str) -> Result<()> {
    if crate::keyring::has_members_key(client, repo).await? {
        return Err(Error::Config(format!(
            "{label} has members-only content, and an organization can't change its members yet"
        )));
    }
    Ok(())
}

/// Give `member` `role` in the organization's `repo` (a role change deletes the old `writer`
/// document first). The member must have accepted (`dg collab accept`).
pub async fn grant(
    owner: &Owner<'_>,
    nonces: &mut Nonces<'_>,
    repo: &RepoRef,
    member: &str,
    member_name: &str,
    role: Role,
) -> Result<Planned> {
    let Owner {
        client,
        writer,
        label,
        ..
    } = *owner;
    check_grant(repo, member, role)?;
    refuse_keyed(client, repo, label).await?;
    client.fetch_identity(member).await.map_err(|e| match e {
        Error::NotFound => Error::Config(format!("{member} is not an identity on this network")),
        other => other,
    })?;
    let reader = MemberReader::new(client);
    let existing = reader.role_doc(repo, member, role).await?;
    if existing.as_ref().is_some_and(|m| m.role == role) {
        return Err(Error::Config(format!(
            "{member_name} already has {} access to {label}",
            role.label()
        )));
    }
    let consent_by = if member == repo.owner_id() {
        None
    } else if consent_doc(client, repo, member).await?.is_some() {
        Some(platform::FieldValue::identifier(
            platform::decode_identifier(member)?,
        ))
    } else {
        return Err(crate::members::awaiting_consent(repo, member));
    };
    let (scope, contract) = scoped(client, repo, doc_type(role)).await?;
    let props = member_doc_props(&contract, &scope, repo, member, role, consent_by)?;
    let mut writes = Vec::new();
    if let Some(old) = existing {
        writes.push(
            writer
                .delete(
                    &contract,
                    doc_type(role),
                    &old.document_id,
                    nonces.take(&scope.contract_id).await?,
                )
                .await?,
        );
    }
    writes.push(
        writer
            .create(
                &contract,
                doc_type(role),
                props,
                nonces.take(&scope.contract_id).await?,
            )
            .await?,
    );
    Ok(Planned {
        title: format!("Give {member_name} {} access to {label}", role.label()),
        writes,
    })
}

/// Remove `member`'s `role` document from the organization's `repo`.
pub async fn revoke(
    owner: &Owner<'_>,
    nonces: &mut Nonces<'_>,
    repo: &RepoRef,
    member: &str,
    member_name: &str,
    role: Role,
) -> Result<Planned> {
    let Owner {
        client,
        writer,
        label,
        ..
    } = *owner;
    if let Some(e) = owner_row_refusal(repo, member, role) {
        return Err(e.into());
    }
    refuse_keyed(client, repo, label).await?;
    let Some(existing) = MemberReader::new(client)
        .role_doc(repo, member, role)
        .await?
    else {
        return Err(Error::Config(format!(
            "{member_name} has no {} access to {label}",
            role.label()
        )));
    };
    let (scope, contract) = scoped(client, repo, doc_type(role)).await?;
    let delete = writer
        .delete(
            &contract,
            doc_type(role),
            &existing.document_id,
            nonces.take(&scope.contract_id).await?,
        )
        .await?;
    Ok(Planned {
        title: format!(
            "Remove {member_name}'s {} access to {label}",
            existing.role.label()
        ),
        writes: vec![delete],
    })
}
