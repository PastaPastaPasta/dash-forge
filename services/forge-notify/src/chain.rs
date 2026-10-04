//! What the service reads from Platform besides the repo streams the relay polls: who follows
//! what, review requests and assignments addressed to a subscriber, and when a private
//! repository last had activity. Every read is a proved query through forge-core; behind the
//! [`Chain`] trait so the router and pollers are tested offline.
//!
//! | Question | Read |
//! |---|---|
//! | repos I watch | forge-community `watch` by `$ownerId` |
//! | repos I own or belong to | forge-core `repo` by `$ownerId`, `maintainer` / `writer` by `memberId`; forge-collab `repoKey` by `memberId` (private repos' members) |
//! | review requests, assignments | forge-community `event` and `authorEvent` by `refId` (the sparse `addressee (refId, $createdAt)` index), past a cursor |
//! | a private repo's last activity | the newest `$createdAt` of `refUpdate`, `issue`, `patch`, `transition` and `event` by `repoId` (public metadata only) |

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use forge_core::platform::{
    decode_identifier, encode_identifier, FetchedDocument, FieldValue, LoadedContract,
    PlatformClient, QueryFilter, QueryOp, QueryOrder,
};
use forge_core::rules::v2::Visibility;

use crate::error::Result;

/// A boxed read.
pub type Read<'a, T> = Pin<Box<dyn Future<Output = Result<T>> + Send + 'a>>;

/// A repository, as a notice names it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoInfo {
    /// The repo id.
    pub id: String,
    /// The owner's identity id.
    pub owner: String,
    /// The repo name.
    pub name: String,
    /// Whether it is private (its content is sealed).
    pub private: bool,
}

/// An `event` or `authorEvent` addressed to someone.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Addressed {
    /// The document id.
    pub doc_id: String,
    /// The event kind (6 assign, 13 review request, ...).
    pub kind: u64,
    /// The repository.
    pub repo_id: String,
    /// The issue or PR.
    pub target_id: String,
    /// Who wrote it.
    pub author: String,
    /// When (ms).
    pub created_at: u64,
}

/// An issue or PR.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TargetInfo {
    /// A pull request (else an issue).
    pub is_pr: bool,
    /// Its number.
    pub number: u64,
    /// Its title; `None` when sealed (a private repo).
    pub title: Option<String>,
}

/// The reads the service needs.
pub trait Chain: Send + Sync {
    /// The repos `identity` watches (public `watch` documents).
    fn watched(&self, identity: &str) -> Read<'_, Vec<String>>;
    /// The repos `identity` owns or is a member of.
    fn member_repos(&self, identity: &str) -> Read<'_, Vec<String>>;
    /// A repository.
    fn repo(&self, repo_id: &str) -> Read<'_, Option<RepoInfo>>;
    /// Assignments and review requests addressed to `identity` after `since` (ms), oldest
    /// first, at most 50.
    fn addressed(&self, identity: &str, since: u64) -> Read<'_, Vec<Addressed>>;
    /// An issue or PR by document id.
    fn target(&self, target_id: &str) -> Read<'_, Option<TargetInfo>>;
    /// The newest activity in a repo: `(created_at ms, writer)`.
    fn latest_activity(&self, repo_id: &str) -> Read<'_, Option<(u64, String)>>;
    /// The identity's DPNS label (`alice`), if it has one.
    fn dpns_label(&self, identity: &str) -> Read<'_, Option<String>>;
}

/// The event kinds the service turns into notices.
pub const KIND_ASSIGN: u64 = 6;
/// A review request.
pub const KIND_REVIEW_REQUEST: u64 = 13;

/// The forge-v2 contracts, loaded.
#[derive(Clone)]
struct Contracts {
    core: LoadedContract,
    collab: LoadedContract,
    community: LoadedContract,
}

/// [`Chain`] over Platform.
pub struct PlatformChain {
    client: Arc<PlatformClient>,
    contracts: Contracts,
}

fn id_value(id: &str) -> Result<FieldValue> {
    Ok(FieldValue::identifier(decode_identifier(id)?))
}

fn id_field(d: &FetchedDocument, name: &str) -> Option<String> {
    d.field_bytes32(name).map(encode_identifier)
}

const MEMBER_READ_MAX: usize = 200;

impl PlatformChain {
    /// Load the forge-v2 contracts of the client's network.
    pub async fn connect(client: Arc<PlatformClient>) -> Result<Self> {
        let forge = client.target().v2.clone().ok_or_else(|| {
            crate::error::NotifyError::Config(format!(
                "forge-v2 is not deployed on {}",
                client.target().network
            ))
        })?;
        let contracts = Contracts {
            core: client.fetch_contract(&forge.core).await?,
            collab: client.fetch_contract(&forge.collab).await?,
            community: client.fetch_contract(&forge.community).await?,
        };
        Ok(Self { client, contracts })
    }

    async fn ids_by(
        &self,
        contract: &LoadedContract,
        doc_type: &str,
        field: &str,
        identity: &str,
        out_field: Option<&str>,
    ) -> Result<Vec<String>> {
        let filter = [QueryFilter::eq(field, id_value(identity)?)];
        let docs = self
            .client
            .query_documents_up_to(contract, doc_type, &filter, &[], MEMBER_READ_MAX)
            .await?;
        Ok(docs
            .iter()
            .take(MEMBER_READ_MAX)
            .filter_map(|d| match out_field {
                Some(f) => id_field(d, f),
                None => Some(d.id.clone()),
            })
            .collect())
    }

    async fn addressed_of(
        &self,
        doc_type: &str,
        identity: &str,
        since: u64,
    ) -> Result<Vec<Addressed>> {
        let filters = [
            QueryFilter::eq("refId", id_value(identity)?),
            QueryFilter {
                field: "$createdAt".into(),
                op: QueryOp::Gt,
                value: FieldValue::uint64(since),
            },
        ];
        let docs = self
            .client
            .query_documents(
                &self.contracts.community,
                doc_type,
                &filters,
                &[QueryOrder::asc("$createdAt")],
                50,
                None,
            )
            .await?;
        Ok(docs
            .iter()
            .filter_map(|d| {
                Some(Addressed {
                    doc_id: d.id.clone(),
                    kind: d.field_u64("kind")?,
                    repo_id: id_field(d, "repoId")?,
                    target_id: id_field(d, "targetId")?,
                    author: d.owner_id.clone(),
                    created_at: d.created_at?,
                })
            })
            .collect())
    }
}

impl Chain for PlatformChain {
    fn watched(&self, identity: &str) -> Read<'_, Vec<String>> {
        let identity = identity.to_string();
        Box::pin(async move {
            self.ids_by(
                &self.contracts.community,
                "watch",
                "$ownerId",
                &identity,
                Some("repoId"),
            )
            .await
        })
    }

    fn member_repos(&self, identity: &str) -> Read<'_, Vec<String>> {
        let identity = identity.to_string();
        Box::pin(async move {
            let c = &self.contracts;
            let mut out = self
                .ids_by(&c.core, "repo", "$ownerId", &identity, None)
                .await?;
            for doc_type in ["maintainer", "writer"] {
                out.extend(
                    self.ids_by(&c.core, doc_type, "memberId", &identity, Some("repoId"))
                        .await?,
                );
            }
            // A private repo's members hold its key wraps (`repoKey.byMember`); not every
            // network's forge-collab has the index, so a failed read only loses those.
            match self
                .ids_by(&c.collab, "repoKey", "memberId", &identity, Some("repoId"))
                .await
            {
                Ok(ids) => out.extend(ids),
                Err(e) => tracing::debug!(error = %e, "repoKey by member: not read"),
            }
            out.sort();
            out.dedup();
            Ok(out)
        })
    }

    fn repo(&self, repo_id: &str) -> Read<'_, Option<RepoInfo>> {
        let repo_id = repo_id.to_string();
        Box::pin(async move {
            let Some(d) = self
                .client
                .fetch_document(&self.contracts.core, "repo", &repo_id)
                .await?
            else {
                return Ok(None);
            };
            Ok(Some(RepoInfo {
                id: repo_id,
                owner: d.owner_id.clone(),
                name: d.field_str("name").unwrap_or_default(),
                private: forge_core::scope::visibility_of(&d) == Visibility::Private,
            }))
        })
    }

    fn addressed(&self, identity: &str, since: u64) -> Read<'_, Vec<Addressed>> {
        let identity = identity.to_string();
        Box::pin(async move {
            let mut out = self.addressed_of("event", &identity, since).await?;
            match self.addressed_of("authorEvent", &identity, since).await {
                Ok(more) => out.extend(more),
                Err(e) => tracing::debug!(error = %e, "authorEvent by addressee: not read"),
            }
            out.sort_by_key(|a| a.created_at);
            Ok(out)
        })
    }

    fn target(&self, target_id: &str) -> Read<'_, Option<TargetInfo>> {
        let target_id = target_id.to_string();
        Box::pin(async move {
            for (doc_type, is_pr) in [("patch", true), ("issue", false)] {
                if let Some(d) = self
                    .client
                    .fetch_document(&self.contracts.collab, doc_type, &target_id)
                    .await?
                {
                    // A private repo's thread seals its title (`enc`): no title then.
                    let sealed = d.fields.contains_key("enc");
                    return Ok(Some(TargetInfo {
                        is_pr,
                        number: d.field_u64("number").unwrap_or(0),
                        title: if sealed { None } else { d.field_str("title") },
                    }));
                }
            }
            Ok(None)
        })
    }

    fn latest_activity(&self, repo_id: &str) -> Read<'_, Option<(u64, String)>> {
        let repo_id = repo_id.to_string();
        Box::pin(async move {
            let c = &self.contracts;
            let filter = [QueryFilter::eq("repoId", id_value(&repo_id)?)];
            let mut newest: Option<(u64, String)> = None;
            for (contract, doc_type) in [
                (&c.core, "refUpdate"),
                (&c.collab, "issue"),
                (&c.collab, "patch"),
                (&c.collab, "transition"),
                (&c.community, "event"),
            ] {
                let docs = self
                    .client
                    .query_documents(
                        contract,
                        doc_type,
                        &filter,
                        &[QueryOrder::desc("$createdAt")],
                        1,
                        None,
                    )
                    .await?;
                if let Some(d) = docs.first() {
                    let t = d.created_at.unwrap_or(0);
                    if newest.as_ref().is_none_or(|(n, _)| t > *n) {
                        newest = Some((t, d.owner_id.clone()));
                    }
                }
            }
            Ok(newest)
        })
    }

    fn dpns_label(&self, identity: &str) -> Read<'_, Option<String>> {
        let identity = identity.to_string();
        Box::pin(async move {
            let names = self.client.dpns_names_of(&identity).await?;
            Ok(names
                .into_iter()
                .next()
                .map(|n| n.strip_suffix(".dash").unwrap_or(&n).to_string()))
        })
    }
}
