//! forge-v2 membership: the `maintainer` and `writer` documents of a repository.
//!
//! On forge-v2 access is a document, not a token (`docs/contracts/forge-v2.md` §2):
//!
//! * **grant** = the repo owner creates a `writer` or `maintainer` document
//!   `{repoId, memberId}` (a `writer` document also carries `role`: 1 writer, 2 triage,
//!   3 reader; RC2 member roles). Consensus admits it only from the repo's owner
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
//! **Roles (RC2 `member_roles`).** A `writer` document is immutable, so a role change is the
//! owner deleting it and writing a new one (the member's consent must still exist). Every
//! role-gated member write carries `r`, which the contract's writer leaf proves equal to the
//! signer's `role` ([`claimed_role`]): triage (2) may close, reopen and lock, label, assign,
//! set milestones, request reviews and resolve threads; a reader (3, private repositories
//! only) may read, comment, review and open issues and PRs, nothing role-gated.
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

/// The document type that grants `role` (writer, triage and reader are all `writer`
/// documents, told apart by their `role`).
pub fn doc_type(role: Role) -> &'static str {
    match role {
        Role::Maintainer => "maintainer",
        Role::Writer | Role::Triage | Role::Reader => "writer",
    }
}

/// The `writer` document's role property (RC2 member roles: 1 writer, 2 triage, 3 reader).
pub const WRITER_ROLE: &str = "role";

/// The property a role-gated write claims its signer's role in (RC2 member roles): on
/// `refUpdate`, `packManifest`, `chunk` and `checkRun` (always 1), and `label`, `milestone`,
/// `transition` and `event` (1 or 2). The contract's writer leaf proves it equals the signer's
/// `writer.role`; the maintainer, author and runner operands prove nothing about it.
pub const CLAIMED_ROLE: &str = "r";

/// The document types that carry [`CLAIMED_ROLE`].
pub const ROLE_GATED_TYPES: [&str; 8] = [
    "refUpdate",
    "packManifest",
    "chunk",
    "checkRun",
    "label",
    "milestone",
    "transition",
    "event",
];

/// The `r` a role-gated write claims ([`CLAIMED_ROLE`]): 1 when the signer writes as a
/// maintainer (the repo owner included, through its maintainer document), as the target's
/// author (a transition with `asAuthor` > 0) or as a runner (`via_other_operand`); else the
/// signer's `writer` document role (1 writer, 2 triage, 3 reader — a reader's write is refused
/// by the pre-checks before it gets here, and by consensus if it does). A non-member claims 1
/// (consensus refuses the write for want of any operand, which is the useful refusal).
#[must_use]
pub fn claimed_role(signer_role: Option<Role>, via_other_operand: bool) -> u64 {
    if via_other_operand {
        return 1;
    }
    signer_role.and_then(Role::writer_role_code).unwrap_or(1)
}

/// Add `r` = `claimed` to a `doc_type` write's properties when the registered `contract` has
/// it (an RC2 `member_roles` contract); a contract without it (RC1) gets none, as
/// `transition.reason` is feature-detected.
pub fn stamp_claimed_role(
    contract: &LoadedContract,
    doc_type: &str,
    props: &mut std::collections::BTreeMap<String, FieldValue>,
    claimed: u64,
) {
    if contract.has_property(doc_type, CLAIMED_ROLE) {
        props.insert(CLAIMED_ROLE.to_string(), FieldValue::integer(claimed));
    }
}

/// The least role an `event` of `kind` needs as a member write: a writer for retarget (8),
/// review dismiss (15), head update (16), pin and unpin (19, 20) and policy bypass (23) (the
/// contract's `t_triageKinds` needs `r` 1), triage for every other kind.
#[must_use]
pub fn event_needs(kind: crate::rules::EventKind) -> Role {
    use crate::rules::EventKind as K;
    match kind {
        K::Retarget | K::ReviewDismiss | K::HeadUpdate | K::Pin | K::Unpin | K::PolicyBypass => {
            Role::Writer
        }
        _ => Role::Triage,
    }
}

/// The least role a member `transition` of `kind` needs: a writer for merge, draft and ready
/// (13, 14, 15; the contract's `e_mergeOid` needs `r` 1), triage for close, reopen and lock.
#[must_use]
pub fn transition_needs(kind: u8) -> Role {
    use crate::rules::transition::{PR_DRAFT, PR_MERGE, PR_READY};
    if matches!(kind, PR_MERGE | PR_DRAFT | PR_READY) {
        Role::Writer
    } else {
        Role::Triage
    }
}

/// The least role a member state change `action` needs ([`transition_needs`] by action):
/// a writer to merge, mark draft or ready, triage to close, reopen, lock and unlock.
#[must_use]
pub fn state_action_needs(action: crate::rules::v2::StateAction) -> Role {
    use crate::rules::v2::StateAction as A;
    match action {
        A::Merge | A::Draft | A::Ready => Role::Writer,
        A::Close | A::Reopen | A::Lock | A::Unlock => Role::Triage,
    }
}

/// What a triage member or reader of `repo` may and may not do: the reason shown when a
/// role-gated write is refused before signing. `None` for a maintainer or writer.
#[must_use]
pub fn role_limits(role: Role, repo: &RepoRef) -> Option<String> {
    match role {
        Role::Maintainer | Role::Writer => None,
        Role::Triage => Some(format!(
            "you are a triage member of {}: triage can close, reopen and lock, label, assign, \
             set milestones, request reviews and resolve threads, but cannot push, merge, mark \
             draft or ready, retarget, dismiss reviews, update heads, pin or post check runs",
            repo.display()
        )),
        Role::Reader => Some(format!(
            "you are a reader of {}: readers can read the private repository and comment, \
             review and open issues and pull requests, but cannot change state (push, label, \
             assign, close or reopen, set milestones or post check runs)",
            repo.display()
        )),
    }
}

/// Refuse a reader role on a public repository: everyone can already read it, and a reader
/// can write nothing a non-member cannot (a client rule; consensus admits the document).
pub fn check_role_for(repo: &RepoRef, role: Role) -> Result<()> {
    if role == Role::Reader && repo.visibility != crate::rules::v2::Visibility::Private {
        return Err(UserError::new(
            codes::REJECTED,
            format!(
                "{} is public: the reader role is for private repositories only",
                repo.display()
            ),
        )
        .cause("everyone can read a public repository, and a reader can write nothing a non-member cannot")
        .fix("add them as `--role triage` or `--role writer` instead")
        .note("nothing was written")
        .into());
    }
    Ok(())
}

/// One current membership document.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Member {
    /// The member identity (base58).
    pub identity_id: String,
    /// The role the document grants (a `writer` document's `role`).
    pub role: Role,
    /// The membership document's id (what a revoke deletes).
    pub document_id: String,
    /// Consensus `$createdAt` (ms).
    pub created_at: u64,
}

impl Member {
    /// A fetched membership document as a membership: `doc_role` is [`Role::Maintainer`] for
    /// a `maintainer` document, any other role for a `writer` document, whose own `role` then
    /// decides (absent: writer; an out-of-range code, which consensus admits none of, is
    /// skipped).
    pub fn from_doc(doc: &FetchedDocument, doc_role: Role) -> Option<Self> {
        let member = doc.field_bytes32("memberId")?;
        let role = match doc_role {
            Role::Maintainer => Role::Maintainer,
            _ => Role::from_writer_role_code(doc.field_u64(WRITER_ROLE))?,
        };
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

    /// Every current `maintainer` and `writer` document of `repo` (writers, triage and
    /// readers), complete.
    pub async fn list(&self, repo: &RepoRef) -> Result<Vec<Member>> {
        self.list_roles(repo, &[Role::Maintainer, Role::Writer])
            .await
    }

    /// Every current `maintainer` document of `repo`, complete (no `writer` read).
    pub async fn maintainers(&self, repo: &RepoRef) -> Result<Vec<Member>> {
        self.list_roles(repo, &[Role::Maintainer]).await
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

    /// `identity`'s current document of `role`'s type in `repo`, if any (the index is unique).
    /// For a writer, triage or reader this is their `writer` document, whatever its role: the
    /// returned member's `role` is the document's.
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

    /// `identity`'s current membership documents in `repo` (at most one `maintainer` and one
    /// `writer`).
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
    ///
    /// A member whose `writer` document grants another of writer, triage and reader has it
    /// replaced (a role change: the document is immutable, so it is deleted and a new one
    /// written, after the consent check). A reader is refused on a public repository
    /// ([`check_role_for`]).
    pub async fn grant(&self, repo: &RepoRef, member: &str, role: Role) -> Result<Member> {
        self.require_owner(repo)?;
        check_role_for(repo, role)?;
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
        let existing = reader.role_doc(repo, member, role).await?;
        if let Some(existing) = existing.as_ref().filter(|m| m.role == role) {
            return Ok(existing.clone());
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
        if let Some(code) = role.writer_role_code() {
            if core.has_property(doc_type(role), WRITER_ROLE) {
                props.insert(WRITER_ROLE.to_string(), FieldValue::integer(code));
            } else if role != Role::Writer {
                return Err(Error::Config(format!(
                    "this network's forge-core has no member roles: {member} can be added as a \
                     writer or maintainer only"
                )));
            }
        }
        // A role change: the old `writer` document goes first (the `(repoId, memberId)` index
        // is unique, and the document is immutable).
        let changed_from = existing.as_ref().map(|old| old.role);
        if let Some(old) = existing {
            self.engine()?
                .delete_document(&core, doc_type(role), &old.document_id)
                .await?;
        }
        let document_id = match self
            .engine()?
            .create_document(&core, doc_type(role), props)
            .await
        {
            Ok(id) => id,
            // A concurrent grant won the unique index (or a node has not applied the delete
            // yet): read it back, and succeed only if it grants the role asked for.
            Err(Error::DuplicateUniqueIndex(_)) => {
                return match reader.role_doc(repo, member, role).await? {
                    Some(m) if m.role == role => Ok(m),
                    Some(m) => Err(Error::Config(format!(
                        "{member} holds a {} document of {} now, not {role}: run the add again",
                        m.role,
                        repo.display()
                    ))),
                    None => Err(Error::NotFound),
                }
            }
            Err(e) => {
                let Some(from) = changed_from else {
                    return Err(e);
                };
                // The old document is gone and the new one is not written: the member has no
                // role until the add runs again.
                return Err(UserError::new(
                    codes::REJECTED,
                    format!(
                        "{member}'s {from} document of {} was deleted, but the {role} document \
                         was not written",
                        repo.display()
                    ),
                )
                .cause(e.to_string())
                .fix(format!(
                    "run `dg collab add {} {member} --role {role}` again to finish the role change",
                    repo.display()
                ))
                .note(format!("until then {member} is not a member"))
                .into());
            }
        };
        Ok(Member {
            identity_id: member.to_string(),
            role,
            document_id,
            created_at: 0,
        })
    }

    /// Revoke `role` from `member` by deleting its document. Returns the role the deleted
    /// document granted, if one existed. Writer, triage and reader are one `writer` document:
    /// revoking any of them deletes it, whichever it grants.
    pub async fn revoke(&self, repo: &RepoRef, member: &str, role: Role) -> Result<Option<Role>> {
        self.require_owner(repo)?;
        let Some(existing) = MemberReader::new(self.client)
            .role_doc(repo, member, role)
            .await?
        else {
            return Ok(None);
        };
        let (_, core) = scoped(self.client, repo, doc_type(role)).await?;
        self.engine()?
            .delete_document(&core, doc_type(role), &existing.document_id)
            .await?;
        Ok(Some(existing.role))
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
/// pusher is a maintainer or role-1 writer (consensus will admit the write), else the refusal
/// to show (a triage member or reader is told what their role allows).
///
/// Advisory only: consensus (`ownerRefersTo`, whose writer leaf proves `role == r`, and a
/// push claims `r` 1) is the authority. This exists so a non-member learns why before a pack
/// is built and chunk writes are refused one by one.
pub fn push_denied_reason(members: &[Member], pusher: &str, repo: &RepoRef) -> Option<String> {
    let best = members
        .iter()
        .filter(|m| m.identity_id == pusher)
        .map(|m| m.role)
        .min();
    match best {
        Some(Role::Maintainer | Role::Writer) => return None,
        Some(role) => {
            return role_limits(role, repo).map(|why| {
                format!(
                    "{why} — ask its owner to run `dg collab add {} {pusher} --role writer`",
                    repo.display()
                )
            })
        }
        None => {}
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
        // Best first: maintainer, writer, triage, reader; approvers are the first two.
        assert!(Role::Maintainer < Role::Writer);
        assert!(Role::Writer < Role::Triage);
        assert!(Role::Triage < Role::Reader);
        let o = oracle(&[member("t", Role::Triage, 1), member("r", Role::Reader, 1)]);
        assert!(o.member_at("t", 1) && !o.approver_at("t", 1));
        assert!(o.member_at("r", 1) && !o.current_approver("r"));
        assert_eq!(
            serde_json::to_string(&[Role::Triage, Role::Reader]).unwrap(),
            r#"["triage","reader"]"#
        );
    }

    #[test]
    fn doc_types_match_the_contract() {
        assert_eq!(doc_type(Role::Maintainer), "maintainer");
        assert_eq!(doc_type(Role::Writer), "writer");
        // RC2 member roles: triage and reader are `writer` documents with another `role`.
        assert_eq!(doc_type(Role::Triage), "writer");
        assert_eq!(doc_type(Role::Reader), "writer");
    }

    fn private_repo() -> RepoRef {
        RepoRef {
            visibility: Visibility::Private,
            ..repo()
        }
    }

    fn writer_doc(role: Option<u64>) -> FetchedDocument {
        let mut fields = std::collections::BTreeMap::new();
        fields.insert("memberId".to_string(), FieldValue::identifier([5; 32]));
        if let Some(r) = role {
            fields.insert(WRITER_ROLE.to_string(), FieldValue::integer(r));
        }
        FetchedDocument {
            id: "w1".into(),
            owner_id: "alice".into(),
            created_at: Some(42),
            created_at_block_height: None,
            updated_at_block_height: None,
            fields,
            revision: None,
        }
    }

    #[test]
    fn a_writer_documents_role_decides_the_member_role() {
        let of = |code| Member::from_doc(&writer_doc(code), Role::Writer).map(|m| m.role);
        assert_eq!(
            of(None),
            Some(Role::Writer),
            "absent role reads as a writer"
        );
        assert_eq!(of(Some(1)), Some(Role::Writer));
        assert_eq!(of(Some(2)), Some(Role::Triage));
        assert_eq!(of(Some(3)), Some(Role::Reader));
        assert_eq!(of(Some(4)), None, "no role consensus admits");
        // A maintainer document is a maintainer whatever else it carries.
        let m = Member::from_doc(&writer_doc(Some(2)), Role::Maintainer).unwrap();
        assert_eq!(m.role, Role::Maintainer);
        assert_eq!(m.created_at, 42);
        // The codes round-trip.
        for role in [Role::Writer, Role::Triage, Role::Reader] {
            assert_eq!(
                Role::from_writer_role_code(role.writer_role_code()),
                Some(role)
            );
        }
        assert_eq!(Role::Maintainer.writer_role_code(), None);
    }

    #[test]
    fn the_claimed_role_is_the_writer_role_unless_another_operand_proves_the_write() {
        // Maintainers (the owner included), authors and runners claim 1.
        assert_eq!(claimed_role(Some(Role::Maintainer), false), 1);
        assert_eq!(claimed_role(Some(Role::Triage), true), 1);
        assert_eq!(claimed_role(Some(Role::Reader), true), 1);
        assert_eq!(claimed_role(None, true), 1);
        // A writer document claims its own role.
        assert_eq!(claimed_role(Some(Role::Writer), false), 1);
        assert_eq!(claimed_role(Some(Role::Triage), false), 2);
        assert_eq!(claimed_role(Some(Role::Reader), false), 3);
        // A non-member claims 1 (consensus refuses it for want of an operand).
        assert_eq!(claimed_role(None, false), 1);
        assert_eq!(
            ROLE_GATED_TYPES,
            [
                "refUpdate",
                "packManifest",
                "chunk",
                "checkRun",
                "label",
                "milestone",
                "transition",
                "event"
            ]
        );
    }

    #[test]
    fn the_least_role_follows_the_contracts_triage_rules() {
        use crate::rules::v2::StateAction;
        use crate::rules::EventKind as K;
        // t_triageKinds: 8, 15, 16, 19, 20, 23 need r 1.
        for k in [
            K::Retarget,
            K::ReviewDismiss,
            K::HeadUpdate,
            K::Pin,
            K::Unpin,
            K::PolicyBypass,
        ] {
            assert_eq!(event_needs(k), Role::Writer, "{k:?}");
            assert_eq!(
                event_needs(k),
                event_needs(
                    crate::collab::u64_to_event_kind(crate::collab::event_kind_to_u64(k)).unwrap()
                )
            );
        }
        for k in [
            K::LabelAdd,
            K::LabelRemove,
            K::Assign,
            K::Unassign,
            K::ThreadResolve,
            K::ThreadUnresolve,
            K::ReviewRequest,
            K::ReviewRequestRemove,
            K::MilestoneSet,
            K::MilestoneClear,
        ] {
            assert_eq!(event_needs(k), Role::Triage, "{k:?}");
        }
        // e_mergeOid: merge, draft, ready (13, 14, 15) need r 1.
        for kind in crate::rules::v2::TRANSITION_KINDS {
            let want = if matches!(kind, 13..=15) {
                Role::Writer
            } else {
                Role::Triage
            };
            assert_eq!(transition_needs(kind), want, "kind {kind}");
        }
        for (action, want) in [
            (StateAction::Close, Role::Triage),
            (StateAction::Reopen, Role::Triage),
            (StateAction::Lock, Role::Triage),
            (StateAction::Unlock, Role::Triage),
            (StateAction::Merge, Role::Writer),
            (StateAction::Draft, Role::Writer),
            (StateAction::Ready, Role::Writer),
        ] {
            assert_eq!(state_action_needs(action), want, "{action:?}");
        }
    }

    #[test]
    fn a_reader_is_for_private_repositories_only() {
        let e = check_role_for(&repo(), Role::Reader)
            .unwrap_err()
            .to_string();
        assert!(e.contains("public"), "{e}");
        assert!(check_role_for(&private_repo(), Role::Reader).is_ok());
        for role in [Role::Maintainer, Role::Writer, Role::Triage] {
            assert!(check_role_for(&repo(), role).is_ok(), "{role:?}");
        }
    }

    #[test]
    fn triage_and_readers_are_refused_a_push_with_what_their_role_allows() {
        let members = [
            member("tri", Role::Triage, 10),
            member("rdr", Role::Reader, 10),
            member("both", Role::Triage, 10),
            member("both", Role::Maintainer, 20),
        ];
        let tri = push_denied_reason(&members, "tri", &repo()).unwrap();
        assert!(
            tri.contains(
                "you are a triage member of alice/proj: triage can close, reopen and lock"
            ),
            "{tri}"
        );
        assert!(tri.contains("cannot push, merge"), "{tri}");
        assert!(tri.contains("--role writer"), "{tri}");
        let rdr = push_denied_reason(&members, "rdr", &private_repo()).unwrap();
        assert!(rdr.contains("you are a reader of alice/proj"), "{rdr}");
        assert!(rdr.contains("cannot change state"), "{rdr}");
        // The best role counts: a triage member who is also a maintainer pushes.
        assert_eq!(push_denied_reason(&members, "both", &repo()), None);
        assert_eq!(role_limits(Role::Writer, &repo()), None);
        assert_eq!(role_limits(Role::Maintainer, &repo()), None);
    }
}
