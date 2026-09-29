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
//!
//! **Consent (RC1 `member_consent`).** Nobody is made a member without agreeing: the member
//! first writes a `consent {repoId}` document of their own ([`ConsentService::accept`], `dg
//! collab accept`), and the owner's grant names it (`consentBy` = the member, which consensus
//! resolves to that consent document: `ownerOrConsented`). Only the owner enrolling itself
//! needs none. A grant without consent is refused here before signing ([`awaiting_consent`]).
//! Every member document carries `vis`, proved against the repository's visibility.

use crate::error::{Error, Result};
use crate::keystore::BridgeIdentity;
use crate::platform::{
    self, FetchedDocument, FieldValue, LoadedContract, LoadedIdentity, PlatformClient, QueryFilter,
    QueryOrder, WriteEngine,
};
use crate::rules::v2::{Membership, Role, RoleOracle};
use crate::scope::RepoRef;
use crate::user_error::{codes, UserError};

/// forge-core: an identity's consent to be made a member of a repository (`{repoId}`, owned by
/// that identity; unique per repository and owner).
pub const DOC_CONSENT: &str = "consent";

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
    /// A fetched `maintainer` (`role` maintainer) or `writer` document as a membership.
    pub fn from_doc(doc: &FetchedDocument, role: Role) -> Option<Self> {
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

/// `repo`'s document scope and the contract `doc_type` lives in (RC1: `maintainer`, `writer`
/// and `consent` in forge-core, `runner` in forge-community).
async fn scoped(
    client: &PlatformClient,
    repo: &RepoRef,
    doc_type: &str,
) -> Result<(crate::scope::DocScope, LoadedContract)> {
    let id = repo
        .forge()
        .contract_id_of(doc_type)
        .ok_or_else(|| Error::Config(format!("{doc_type} is not a forge-v2 document type")))?;
    Ok((repo.scope()?, client.fetch_contract(id).await?))
}

/// Every `doc_type` membership document of `repo` (`maintainer`, `writer`, `runner`), complete.
pub(crate) async fn membership_docs(
    client: &PlatformClient,
    repo: &RepoRef,
    doc_type: &str,
    order: &[QueryOrder],
) -> Result<Vec<FetchedDocument>> {
    let (scope, contract) = scoped(client, repo, doc_type).await?;
    client
        .query_all_documents(&contract, doc_type, &scope.filters([]), order)
        .await
}

/// `identity`'s `doc_type` membership document of `repo`, if any (the `(repoId, memberId)` index
/// is unique).
pub(crate) async fn membership_doc(
    client: &PlatformClient,
    repo: &RepoRef,
    doc_type: &str,
    identity: &str,
) -> Result<Option<FetchedDocument>> {
    doc_naming(client, repo, doc_type, "memberId", identity).await
}

/// `identity`'s `consent` document for `repo`, if any (the `(repoId, $ownerId)` index is
/// unique).
pub async fn consent_doc(
    client: &PlatformClient,
    repo: &RepoRef,
    identity: &str,
) -> Result<Option<FetchedDocument>> {
    doc_naming(client, repo, DOC_CONSENT, "$ownerId", identity).await
}

/// The first `doc_type` document of `repo` whose identifier `field` is `identity`, if any.
async fn doc_naming(
    client: &PlatformClient,
    repo: &RepoRef,
    doc_type: &str,
    field: &str,
    identity: &str,
) -> Result<Option<FetchedDocument>> {
    let (scope, contract) = scoped(client, repo, doc_type).await?;
    let id = FieldValue::identifier(platform::decode_identifier(identity)?);
    let docs = client
        .query_documents(
            &contract,
            doc_type,
            &scope.filters([QueryFilter::eq(field, id)]),
            &[],
            1,
            None,
        )
        .await?;
    Ok(docs.into_iter().next())
}

/// The refusal of a grant to `member`, who has not consented to `repo` yet.
pub fn awaiting_consent(repo: &RepoRef, member: &str) -> Error {
    UserError::new(
        codes::REJECTED,
        format!(
            "{member} has not accepted membership of {} yet",
            repo.display()
        ),
    )
    .cause("a member document must name the member's own consent (member_consent)")
    .fix(format!(
        "ask them to run `dg collab accept {}`, then add them again (or pass `--wait` to wait \
         for it)",
        repo.display()
    ))
    .note("nothing was written")
    .into()
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
        self.list_roles(repo, &[Role::Maintainer, Role::Writer])
            .await
    }

    async fn list_roles(&self, repo: &RepoRef, roles: &[Role]) -> Result<Vec<Member>> {
        let mut out = Vec::new();
        for &role in roles {
            let docs = membership_docs(
                self.client,
                repo,
                doc_type(role),
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
        Ok(membership_doc(self.client, repo, doc_type(role), identity)
            .await?
            .and_then(|d| Member::from_doc(&d, role)))
    }

    /// Whether `identity` has consented to membership of `repo` (holds a `consent` document).
    pub async fn consented(&self, repo: &RepoRef, identity: &str) -> Result<bool> {
        Ok(consent_doc(self.client, repo, identity).await?.is_some())
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
    /// existing document is returned and nothing is written. The member must have consented
    /// first ([`ConsentService::accept`]): without their `consent` document the grant is
    /// refused before signing ([`awaiting_consent`]). The owner enrolling itself needs none.
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
        let member_id = FieldValue::identifier(platform::decode_identifier(member)?);
        let consent_by = if member == repo.owner_id() {
            None
        } else if reader.consented(repo, member).await? {
            Some(member_id.clone())
        } else {
            return Err(awaiting_consent(repo, member));
        };
        let (scope, core) = scoped(self.client, repo, doc_type(role)).await?;
        let mut props = scope.props([("memberId", member_id)]);
        crate::layout::stamp_vis(&mut props, repo.visibility);
        if let Some(c) = consent_by {
            props.insert("consentBy".to_string(), c);
        }
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
        let (_, core) = scoped(self.client, repo, doc_type(role)).await?;
        self.engine()?
            .delete_document(&core, doc_type(role), &existing.document_id)
            .await?;
        Ok(true)
    }
}

/// A member's own consent to repositories, signed by the (future) member.
pub struct ConsentService<'a> {
    client: &'a PlatformClient,
    identity: &'a LoadedIdentity,
    bridge: &'a BridgeIdentity,
}

impl<'a> ConsentService<'a> {
    /// Bind to the consenting identity and its keys.
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

    /// Consent to be made a member of `repo`: write the signer's `consent {repoId}`. Idempotent:
    /// an existing consent is returned (`false`: nothing written). Returns its document id and
    /// whether it was written now. The owner needs none, so accepting one's own repository is
    /// refused.
    pub async fn accept(&self, repo: &RepoRef) -> Result<(String, bool)> {
        let me = self.identity.id();
        if me == repo.owner_id() {
            return Err(Error::Config(format!(
                "you own {}: an owner needs no consent to its own repository",
                repo.display()
            )));
        }
        if let Some(d) = consent_doc(self.client, repo, &me).await? {
            return Ok((d.id, false));
        }
        let (scope, core) = scoped(self.client, repo, DOC_CONSENT).await?;
        match self
            .engine()?
            .create_document(&core, DOC_CONSENT, scope.props([]))
            .await
        {
            Ok(id) => Ok((id, true)),
            // Accepted concurrently (another device): the index is unique.
            Err(Error::DuplicateUniqueIndex(_)) => consent_doc(self.client, repo, &me)
                .await?
                .map(|d| (d.id, false))
                .ok_or(Error::NotFound),
            Err(e) => Err(e),
        }
    }

    /// Withdraw consent to `repo` (delete the signer's `consent`). A membership that already
    /// names it stands until the owner removes it. Returns whether one existed.
    pub async fn withdraw(&self, repo: &RepoRef) -> Result<bool> {
        let Some(d) = consent_doc(self.client, repo, &self.identity.id()).await? else {
            return Ok(false);
        };
        let (_, core) = scoped(self.client, repo, DOC_CONSENT).await?;
        self.engine()?
            .delete_document(&core, DOC_CONSENT, &d.id)
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
        "you are not a writer of {repo} — run `dg collab accept {repo}` and ask its owner to \
         run `dg collab add {repo} {pusher} --role writer`, or push to your own repo (`dg repo \
         create <name>`) and open a pull request",
        repo = repo.display()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::network::ForgeIds;
    use crate::rules::v2::Visibility;

    fn repo() -> RepoRef {
        RepoRef {
            forge: ForgeIds::test_forge(),
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
