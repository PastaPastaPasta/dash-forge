//! An organization's owner actions as unsigned writes, built from the same property builders a
//! personal owner's writes use, so an organization's documents are identical to anyone's.

use std::collections::{BTreeMap, BTreeSet};

use crate::create::{
    config_props, owner_maintainer_props, protect_problem, repo_props, validated, CreateRepoOpts,
};
use crate::error::{Error, Result};
use crate::members::{
    check_grant, consent_doc, doc_type, member_doc_props, owner_row_refusal, scoped, MemberReader,
};
use crate::network::ForgeIds;
use crate::platform::org::{NonceState, OrgWriter, UnsignedWrite};
use crate::platform::{self, FieldValue, LoadedIdentity, PlatformClient, QueryFilter};
use crate::refs::DOC_CONFIG;
use crate::resolve::{find_named, DOC_REPO};
use crate::rules::v2::{Role, Visibility};
use crate::scope::{DocScope, RepoRef};

use super::transport::{Roster, DOC_ORG};

/// Hands out identity-contract nonces: the lowest ones above the identity's current one that no
/// open request of the organization holds. Platform accepts nonces out of order within its
/// window, so one request holding a far nonce blocks nothing. A nonce beyond the window is
/// refused.
pub struct Nonces<'a> {
    writer: &'a OrgWriter<'a>,
    held: BTreeMap<String, BTreeSet<u64>>,
    last: BTreeMap<String, (NonceState, u64)>,
}

impl<'a> Nonces<'a> {
    pub fn new(writer: &'a OrgWriter<'a>, held: BTreeMap<String, BTreeSet<u64>>) -> Self {
        Self {
            writer,
            held,
            last: BTreeMap::new(),
        }
    }

    pub async fn take(&mut self, contract_id: &str) -> Result<u64> {
        let (current, last) = if let Some(v) = self.last.get(contract_id) {
            *v
        } else {
            let current = self.writer.current_nonce(contract_id).await?;
            (current, current.tip())
        };
        let held = self.held.get(contract_id);
        let next = free_after(last, held);
        if current.too_far(next) {
            return Err(Error::Config(
                "the organization's open requests hold every nonce Platform accepts: finish some first"
                    .into(),
            ));
        }
        self.last.insert(contract_id.to_string(), (current, next));
        Ok(next)
    }
}

fn free_after(last: u64, held: Option<&BTreeSet<u64>>) -> u64 {
    let mut n = last + 1;
    while held.is_some_and(|h| h.contains(&n)) {
        n += 1;
    }
    n
}

/// The organization acting as owner: its connection, its writer and its display label.
pub struct Owner<'a> {
    pub client: &'a PlatformClient,
    pub org: &'a LoadedIdentity,
    pub writer: &'a OrgWriter<'a>,
    pub label: &'a str,
}

/// A request to make: its title and its writes, in order. No writes: nothing to change.
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
    if let Some(problem) = protect_problem(&opts) {
        return Err(problem);
    }
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

/// Whether `repo` has members-only content or environments: an organization can't change its
/// members yet, since those changes re-share keys and re-save environments, which a request does
/// not carry.
pub async fn keyed(client: &PlatformClient, repo: &RepoRef) -> Result<bool> {
    if crate::keyring::has_members_key(client, repo).await? {
        return Ok(true);
    }
    Ok(crate::repo::RepoService::reader(client)
        .read_pack_manifests(repo)
        .await?
        .iter()
        .any(|m| m.kind == u64::from(crate::pack::KIND_ENV_SNAPSHOT)))
}

async fn refuse_keyed(client: &PlatformClient, repo: &RepoRef, label: &str) -> Result<()> {
    if keyed(client, repo).await? {
        return Err(Error::Config(format!(
            "{label} has members-only content or environments, and an organization can't change its members yet"
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

/// The longest relay URL an `org` document holds (a longer one is left out).
const MAX_RELAY: usize = 200;

/// "Publish organization" (§10.5): the `org` roster of the signing ceremony, and the
/// organization's `profile` with the declared link (other profile fields kept), each only when
/// it differs from what is stored.
pub async fn publish(
    owner: &Owner<'_>,
    nonces: &mut Nonces<'_>,
    org_contract: &str,
    roster: &Roster,
) -> Result<Planned> {
    let Owner {
        client,
        org,
        writer,
        label,
    } = *owner;
    let forge = forge_of(client)?;
    let network = client.network().key();
    let contract = client.fetch_contract(org_contract).await?;
    let owner_id = platform::decode_identifier(&org.id())?;
    let stored = client
        .query_documents(
            &contract,
            DOC_ORG,
            &[QueryFilter::eq(
                "$ownerId",
                FieldValue::identifier(owner_id),
            )],
            &[],
            1,
            None,
        )
        .await?
        .into_iter()
        .next();
    let mut writes = Vec::new();
    let current = stored
        .as_ref()
        .and_then(|d| Roster::from_props(&d.fields))
        .is_some_and(|r| r.same_key(roster));
    if !current {
        let mut published = roster.clone();
        published.relay = roster
            .relay
            .clone()
            .filter(|r| !r.is_empty() && r.len() <= MAX_RELAY);
        let props = published.props();
        let nonce = nonces.take(org_contract).await?;
        writes.push(match &stored {
            Some(d) => {
                writer
                    .replace(
                        &contract,
                        DOC_ORG,
                        &d.id,
                        d.revision.unwrap_or(1),
                        props,
                        nonce,
                    )
                    .await?
            }
            None => writer.create(&contract, DOC_ORG, props, nonce).await?,
        });
    }
    let link = super::owner::declared_org_link(
        &network,
        u32::try_from(roster.threshold).unwrap_or(u32::MAX),
        u32::try_from(roster.members.len()).unwrap_or(u32::MAX),
    );
    let doc = crate::profile::read_profile_doc(client, &forge, &org.id()).await?;
    let mut fields = doc
        .as_ref()
        .map(|d| crate::profile::profile_from_doc(d).fields)
        .unwrap_or_default();
    let before = fields.links.clone().unwrap_or_default();
    let declared: Vec<&String> = before
        .iter()
        .filter(|l| super::owner::parse_declared_org(l, &network).is_some())
        .collect();
    if declared != [&link] {
        let mut links: Vec<String> = before
            .iter()
            .filter(|l| super::owner::parse_declared_org(l, &network).is_none())
            .cloned()
            .collect();
        links.push(link);
        if links.len() > crate::rules::profile::MAX_LINKS {
            return Err(Error::Config(format!(
                "{label}'s profile already has {} links: remove one first (`dg profile set --owner {label}`)",
                crate::rules::profile::MAX_LINKS
            )));
        }
        fields.links = Some(links);
        writes.push(profile_write(owner, nonces, &forge, doc.as_ref(), &fields).await?);
    }
    Ok(Planned {
        title: format!("Publish {label} on Platform"),
        writes,
    })
}

/// The organization's profile write: a create, or a replace of `stored` keeping its other
/// properties (the personal builders' properties).
async fn profile_write(
    owner: &Owner<'_>,
    nonces: &mut Nonces<'_>,
    forge: &ForgeIds,
    stored: Option<&crate::platform::FetchedDocument>,
    fields: &crate::rules::profile::ProfileFields,
) -> Result<UnsignedWrite> {
    let home = forge.home(crate::profile::DOC_PROFILE).to_string();
    let contract = owner.client.fetch_contract(&home).await?;
    let nonce = nonces.take(&home).await?;
    match stored {
        Some(d) => {
            owner
                .writer
                .replace(
                    &contract,
                    crate::profile::DOC_PROFILE,
                    &d.id,
                    d.revision.unwrap_or(1),
                    crate::profile::replaced_props(&d.fields, fields),
                    nonce,
                )
                .await
        }
        None => {
            owner
                .writer
                .create(
                    &contract,
                    crate::profile::DOC_PROFILE,
                    crate::profile::created_props(fields),
                    nonce,
                )
                .await
        }
    }
}

/// Set the organization's profile to `fields` (already normalized). A declared link it holds
/// must name the organization's N of M; one it drops is the members' choice.
pub async fn profile_set(
    owner: &Owner<'_>,
    nonces: &mut Nonces<'_>,
    fields: &crate::rules::profile::ProfileFields,
) -> Result<Planned> {
    let forge = forge_of(owner.client)?;
    let doc = crate::profile::read_profile_doc(owner.client, &forge, &owner.org.id()).await?;
    let unchanged = match &doc {
        Some(d) => crate::profile::profile_from_doc(d).fields == *fields,
        None => *fields == crate::rules::profile::ProfileFields::default(),
    };
    if unchanged {
        return Ok(Planned {
            title: format!("Update {}'s profile", owner.label),
            writes: Vec::new(),
        });
    }
    let write = profile_write(owner, nonces, &forge, doc.as_ref(), fields).await?;
    Ok(Planned {
        title: format!("Update {}'s profile", owner.label),
        writes: vec![write],
    })
}

/// Enrol `member` as a CI runner of the organization's `repo`.
pub async fn runner_add(
    owner: &Owner<'_>,
    nonces: &mut Nonces<'_>,
    repo: &RepoRef,
    member: &str,
    member_name: &str,
) -> Result<Planned> {
    if crate::ci::RunnerReader::new(owner.client)
        .get(repo, member)
        .await?
        .is_some()
    {
        return Ok(Planned {
            title: format!("Add {member_name} as a CI runner of {}", owner.label),
            writes: Vec::new(),
        });
    }
    owner
        .client
        .fetch_identity(member)
        .await
        .map_err(|e| match e {
            Error::NotFound => {
                Error::Config(format!("{member} is not an identity on this network"))
            }
            other => other,
        })?;
    let community = owner.client.fetch_contract(&repo.forge().community).await?;
    let write = owner
        .writer
        .create(
            &community,
            crate::ci::DOC_RUNNER,
            crate::ci::runner_props(repo, member)?,
            nonces.take(&repo.forge().community).await?,
        )
        .await?;
    Ok(Planned {
        title: format!("Add {member_name} as a CI runner of {}", owner.label),
        writes: vec![write],
    })
}

/// Revoke `member`'s CI runner membership of the organization's `repo`.
pub async fn runner_remove(
    owner: &Owner<'_>,
    nonces: &mut Nonces<'_>,
    repo: &RepoRef,
    member: &str,
    member_name: &str,
) -> Result<Planned> {
    let Some(existing) = crate::ci::RunnerReader::new(owner.client)
        .get(repo, member)
        .await?
    else {
        return Ok(Planned {
            title: format!("Remove the CI runner {member_name} from {}", owner.label),
            writes: Vec::new(),
        });
    };
    let community = owner.client.fetch_contract(&repo.forge().community).await?;
    let write = owner
        .writer
        .delete(
            &community,
            crate::ci::DOC_RUNNER,
            &existing.document_id,
            nonces.take(&repo.forge().community).await?,
        )
        .await?;
    Ok(Planned {
        title: format!("Remove the CI runner {member_name} from {}", owner.label),
        writes: vec![write],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_new_request_takes_the_lowest_free_nonces() {
        let held: BTreeSet<u64> = [11, 12, 34].into();
        assert_eq!(free_after(10, Some(&held)), 13);
        assert_eq!(free_after(13, Some(&held)), 14);
        assert_eq!(free_after(33, Some(&held)), 35);
        assert_eq!(free_after(10, None), 11);
    }
}
