//! forge-v2 membership: the `maintainer` and `writer` documents of a repository.
//!
//! On forge-v2 access is a document, not a token (`docs/contracts/forge-v2.md` §2):
//!
//! * **grant** = the repo owner creates a `writer` or `maintainer` document
//!   `{repoId, memberId}`. Consensus admits it only from the repo's owner
//!   (`repoId → repo` with `propertyAgreement {"$ownerId": "$ownerId"}`), and the
//!   `(repoId, memberId)` index is unique, so each role is held at most once.
//! * **revoke** = the owner deletes that document. The member's next gated write
//!   (`refUpdate`, `packManifest`, `chunk`, ...) is refused at consensus with 40120.
//! * **list** = the repo's current documents of both types. A revoked member's document is
//!   gone, so the list is exactly who can write now ([`crate::rules::v2::RoleOracle`]).
//!
//! There is no suspend: revocation takes effect immediately, and re-adding creates a new
//! document whose membership starts at its own `$createdAt`.

use crate::error::{Error, Result};
use crate::keystore::BridgeIdentity;
use crate::platform::{
    self, FetchedDocument, FieldValue, LoadedContract, LoadedIdentity, PlatformClient, QueryFilter,
    QueryOrder, WriteEngine,
};
use crate::rules::v2::{Membership, Role, RoleOracle};
use crate::scope::RepoRef;

/// The document type that grants `role`.
pub fn doc_type(role: Role) -> &'static str {
    match role {
        Role::Maintainer => "maintainer",
        Role::Writer => "writer",
    }
}

/// One current membership document.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Member {
    /// The member identity (base58).
    pub identity_id: String,
    /// The role the document grants.
    pub role: Role,
    /// The membership document's id (what a revoke deletes).
    pub document_id: String,
    /// Consensus `$createdAt` (ms).
    pub created_at: u64,
}

impl Member {
    fn from_doc(doc: &FetchedDocument, role: Role) -> Option<Self> {
        let member = doc.field_bytes32("memberId")?;
        Some(Self {
            identity_id: platform::encode_identifier(member),
            role,
            document_id: doc.id.clone(),
            created_at: doc.created_at.unwrap_or(0),
        })
    }
}

/// The oracle over a repository's current members (the input the v2 rules take).
pub fn oracle(members: &[Member]) -> RoleOracle {
    RoleOracle::new(
        members
            .iter()
            .map(|m| Membership {
                identity: m.identity_id.clone(),
                role: m.role,
                created_at: m.created_at,
            })
            .collect(),
    )
}

/// `repo`'s document scope and the forge-core contract its membership lives in; refuses v1.
async fn core(
    client: &PlatformClient,
    repo: &RepoRef,
) -> Result<(crate::scope::DocScope, LoadedContract)> {
    let forge = repo.require_v2()?;
    Ok((repo.scope()?, client.fetch_contract(&forge.core).await?))
}

/// Read access to forge-v2 membership: needs only a client.
pub struct MemberReader<'a> {
    client: &'a PlatformClient,
}

impl<'a> MemberReader<'a> {
    /// A reader over `client`.
    pub fn new(client: &'a PlatformClient) -> Self {
        Self { client }
    }

    /// Every current `maintainer` and `writer` document of `repo`, complete.
    pub async fn list(&self, repo: &RepoRef) -> Result<Vec<Member>> {
        let (scope, core) = core(self.client, repo).await?;
        let mut out = Vec::new();
        for role in [Role::Maintainer, Role::Writer] {
            let docs = self
                .client
                .query_all_documents(
                    &core,
                    doc_type(role),
                    &scope.filters([]),
                    &[QueryOrder::asc("memberId")],
                )
                .await?;
            out.extend(docs.iter().filter_map(|d| Member::from_doc(d, role)));
        }
        Ok(out)
    }

    /// `identity`'s current `role` document in `repo`, if any (the index is unique).
    pub async fn role_doc(
        &self,
        repo: &RepoRef,
        identity: &str,
        role: Role,
    ) -> Result<Option<Member>> {
        let (scope, core) = core(self.client, repo).await?;
        let member = FieldValue::identifier(platform::decode_identifier(identity)?);
        let docs = self
            .client
            .query_documents(
                &core,
                doc_type(role),
                &scope.filters([QueryFilter::eq("memberId", member)]),
                &[],
                1,
                None,
            )
            .await?;
        Ok(docs.iter().find_map(|d| Member::from_doc(d, role)))
    }

    /// `identity`'s current membership documents in `repo` (at most one per role).
    pub async fn roles_of(&self, repo: &RepoRef, identity: &str) -> Result<Vec<Member>> {
        let mut out = Vec::new();
        for role in [Role::Maintainer, Role::Writer] {
            out.extend(self.role_doc(repo, identity, role).await?);
        }
        Ok(out)
    }
}

/// Membership writes, signed by the repository owner.
pub struct MemberService<'a> {
    client: &'a PlatformClient,
    identity: &'a LoadedIdentity,
    bridge: &'a BridgeIdentity,
}

impl<'a> MemberService<'a> {
    /// Bind to the owner identity and its keys.
    pub fn new(
        client: &'a PlatformClient,
        identity: &'a LoadedIdentity,
        bridge: &'a BridgeIdentity,
    ) -> Self {
        Self {
            client,
            identity,
            bridge,
        }
    }

    fn engine(&self) -> Result<WriteEngine<'a>> {
        WriteEngine::new(self.client, self.identity, self.bridge.doc_op_key()?)
    }

    /// Only the repo owner can grant or revoke (consensus enforces it; this fails first,
    /// with a message instead of a consensus code).
    fn require_owner(&self, repo: &RepoRef) -> Result<()> {
        repo.require_v2()?;
        if repo.owner_id() != self.identity.id() {
            return Err(Error::Config(format!(
                "only the owner of {} ({}) can change its members",
                repo.display(),
                repo.owner_id()
            )));
        }
        Ok(())
    }

    /// Grant `role` to `member`. Idempotent: when the member already holds the role, the
    /// existing document is returned and nothing is written.
    pub async fn grant(&self, repo: &RepoRef, member: &str, role: Role) -> Result<Member> {
        self.require_owner(repo)?;
        // Consensus checks `memberId` is an identity; checking here gives a clear error.
        self.client
            .fetch_identity(member)
            .await
            .map_err(|e| match e {
                Error::NotFound => {
                    Error::Config(format!("{member} is not an identity on this network"))
                }
                other => other,
            })?;
        let reader = MemberReader::new(self.client);
        if let Some(existing) = reader.role_doc(repo, member, role).await? {
            return Ok(existing);
        }
        let (scope, core) = core(self.client, repo).await?;
        let props = scope.props([(
            "memberId",
            FieldValue::identifier(platform::decode_identifier(member)?),
        )]);
        let document_id = match self
            .engine()?
            .create_document(&core, doc_type(role), props)
            .await
        {
            Ok(id) => id,
            // A concurrent grant of the same role won the unique index; read it back.
            Err(Error::DuplicateUniqueIndex(_)) => {
                return reader
                    .role_doc(repo, member, role)
                    .await?
                    .ok_or(Error::NotFound)
            }
            Err(e) => return Err(e),
        };
        Ok(Member {
            identity_id: member.to_string(),
            role,
            document_id,
            created_at: 0,
        })
    }

    /// Revoke `role` from `member` by deleting its document. Returns whether one existed.
    pub async fn revoke(&self, repo: &RepoRef, member: &str, role: Role) -> Result<bool> {
        self.require_owner(repo)?;
        let Some(existing) = MemberReader::new(self.client)
            .role_doc(repo, member, role)
            .await?
        else {
            return Ok(false);
        };
        let (_, core) = core(self.client, repo).await?;
        self.engine()?
            .delete_document(&core, doc_type(role), &existing.document_id)
            .await?;
        Ok(true)
    }
}

/// The advisory push pre-check's verdict for `pusher` against `members`: `None` when the
/// pusher holds a role (consensus will admit the write), else the refusal to show.
///
/// Advisory only: consensus (`ownerRefersTo`) is the authority. This exists so a
/// non-member learns why before a pack is built and chunk writes are refused one by one.
pub fn push_denied_reason(members: &[Member], pusher: &str, repo: &RepoRef) -> Option<String> {
    if members.iter().any(|m| m.identity_id == pusher) {
        return None;
    }
    Some(format!(
        "you are not a writer of {repo} — ask its owner to run `dg collab add {repo} {pusher} \
         --role writer`, or push to your own repo (`dg repo create <name>`) and open a pull \
         request",
        repo = repo.display()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::network::ForgeIds;
    use crate::rules::v2::Visibility;

    fn repo() -> RepoRef {
        RepoRef::V2 {
            forge: ForgeIds {
                core: "C".into(),
                collab: "L".into(),
                group: "G".into(),
            },
            repo_id: "R".into(),
            owner_id: "alice".into(),
            name: "proj".into(),
            visibility: Visibility::Public,
        }
    }

    fn member(id: &str, role: Role, at: u64) -> Member {
        Member {
            identity_id: id.into(),
            role,
            document_id: format!("doc-{id}-{at}"),
            created_at: at,
        }
    }

    #[test]
    fn a_member_passes_the_precheck_and_a_stranger_is_pointed_at_collab_add() {
        let members = [
            member("bob", Role::Writer, 10),
            member("alice", Role::Maintainer, 1),
        ];
        assert_eq!(push_denied_reason(&members, "bob", &repo()), None);
        assert_eq!(push_denied_reason(&members, "alice", &repo()), None);
        let why = push_denied_reason(&members, "carol", &repo()).unwrap();
        assert!(why.contains("not a writer of alice/proj"), "{why}");
        assert!(
            why.contains("dg collab add alice/proj carol --role writer"),
            "{why}"
        );
    }

    #[test]
    fn a_revoked_member_is_simply_absent() {
        // Revoke deletes the document, so the list no longer names them.
        let members = [member("alice", Role::Maintainer, 1)];
        assert!(push_denied_reason(&members, "bob", &repo()).is_some());
    }

    #[test]
    fn oracle_ranks_maintainer_over_writer() {
        let members = [
            member("bob", Role::Writer, 10),
            member("bob", Role::Maintainer, 20),
        ];
        let o = oracle(&members);
        assert_eq!(o.current_role("bob"), Some(Role::Maintainer));
        assert_eq!(o.role_at("bob", 15), Some(Role::Writer));
        assert_eq!(o.current_role("carol"), None);
    }

    #[test]
    fn doc_types_match_the_contract() {
        assert_eq!(doc_type(Role::Maintainer), "maintainer");
        assert_eq!(doc_type(Role::Writer), "writer");
    }
}
