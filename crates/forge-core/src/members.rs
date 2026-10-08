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
//! set milestones, request reviews and resolve threads; a reader (3) may read, comment, review
//! (never a counted verdict) and open issues and PRs, nothing role-gated.
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

/// The `event` kinds the contract's `t_triageKinds` refuses below `r` 1: retarget (8), review
/// dismiss (15), head update (16), pin and unpin (19, 20) and policy bypass (23). A deny-list:
/// every other kind, an unknown or future one included, is open to triage.
pub const WRITER_ONLY_EVENT_KINDS: [u64; 6] = [8, 15, 16, 19, 20, 23];

/// The `event` kinds a client convention keeps from triage though consensus admits them (the
/// kind is not on `t_triageKinds`): a CI re-run request (26, `rules::ci_rerun`), which, as on
/// GitHub, needs write access. Readers ignore a triage member's (`ci_rerun::rerun_counts`), so
/// clients refuse it before signing.
pub const CLIENT_WRITER_EVENT_KINDS: [u64; 1] = [crate::rules::ci_rerun::CI_RERUN_KIND];

/// The least role an `event` of stored `kind` needs as a member write: a writer for
/// [`WRITER_ONLY_EVENT_KINDS`] and [`CLIENT_WRITER_EVENT_KINDS`], triage for every other kind
/// (unknown ones included). Hides (24, 25) are maintainer-gated elsewhere (`asMaintainer`, RC2
/// MOD).
#[must_use]
pub fn event_code_needs(kind: u64) -> Role {
    if WRITER_ONLY_EVENT_KINDS.contains(&kind) || CLIENT_WRITER_EVENT_KINDS.contains(&kind) {
        Role::Writer
    } else {
        Role::Triage
    }
}

/// [`event_code_needs`] for a known [`crate::rules::EventKind`].
#[must_use]
pub fn event_needs(kind: crate::rules::EventKind) -> Role {
    event_code_needs(crate::collab::event_kind_to_u64(kind))
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

/// How a role refusal names the signer's own role ("you are a writer of alice/proj"). Every
/// refusal of a member for their role starts with it ([`role_limits`], `role_refusal`), so the
/// E601 fix can tell a member, who needs another role, from a stranger, who must accept first
/// ([`refused_member`]).
#[must_use]
pub fn you_are(role: Role, repo: &RepoRef) -> String {
    format!("you are {} of {}", role.noun(), repo.display())
}

/// Whether a refusal `reason` names the signer's own role ([`you_are`]): they are a member.
#[must_use]
pub fn refused_member(reason: &str) -> bool {
    [Role::Maintainer, Role::Writer, Role::Triage, Role::Reader]
        .iter()
        .any(|r| reason.starts_with(&format!("you are {} of ", r.noun())))
}

/// What a triage member or reader of `repo` may and may not do: the reason shown when a
/// role-gated write is refused before signing. `None` for a maintainer or writer.
#[must_use]
pub fn role_limits(role: Role, repo: &RepoRef) -> Option<String> {
    match role {
        Role::Maintainer | Role::Writer => None,
        Role::Triage => Some(format!(
            "{}: triage can close, reopen and lock, label, assign, set milestones, request \
             reviews and resolve threads, but cannot push, merge, mark draft or ready, \
             retarget, dismiss reviews, update heads, pin, post check runs or re-run them",
            you_are(role, repo)
        )),
        Role::Reader => Some(format!(
            "{}: readers can read members-only content, comment, review with comments and open \
             issues and pull requests, but cannot change state (push, label, assign, close or \
             reopen, set milestones, post check runs or re-run them) or approve",
            you_are(role, repo)
        )),
    }
}

/// Whether a member with `role` receives a repository's members key (key wraps, rotations,
/// repairs), in private and public repositories alike: every human role does (owner,
/// maintainers, writers, triage and readers; DESIGN §3.5). Runners are never in it: a `runner`
/// document (forge-community) is not a membership, so it is never listed by
/// [`MemberReader::list`] and never receives a wrap. The match is exhaustive so that a role
/// that must not hold the key (the Bot role of phase 4) has to say so here.
#[must_use]
pub fn holds_members_key(role: Role) -> bool {
    match role {
        Role::Maintainer | Role::Writer | Role::Triage | Role::Reader => true,
    }
}

/// Refuse, before signing, an approve or request-changes `verdict` from a member whose `role`
/// is not an approver (Read or Triage access; DESIGN §3.5, D15): only Write and Maintain approve
/// or request changes, so the review is offered as a comment instead. `None` for an approver,
/// a non-member (whose verdict is written as 4 or 5 and shown as not counting) and a comment.
/// Callers add the fix that names their own way to post a comment.
#[must_use]
pub fn verdict_refusal(
    role: Option<Role>,
    verdict: crate::rules::Verdict,
    repo: &RepoRef,
) -> Option<UserError> {
    use crate::rules::Verdict as V;
    let role = role.filter(|r| !r.is_approver())?;
    let what = match verdict {
        V::Approve | V::ApproveNonMember => "approve",
        V::RequestChanges | V::RequestChangesNonMember => "request changes",
        V::Comment | V::Unknown(_) => return None,
    };
    Some(
        UserError::new(
            codes::NOT_A_WRITER,
            format!("Only people with Write access or more can {what}."),
        )
        .cause(format!(
            "you have {} access to {}",
            role.label(),
            repo.display()
        ))
        .note("checked before anything was signed; nothing was written or paid"),
    )
}

/// Refuse a grant of `role` to `member` the clients do not make: the repo owner giving itself a
/// triage or reader `writer` document (the owner already holds every right through its
/// ownership and its maintainer document; forge-web refuses it too). A reader is allowed on a
/// public repository too: there it reads the members-only content (DESIGN §4.1).
pub fn check_grant(repo: &RepoRef, member: &str, role: Role) -> Result<()> {
    if member == repo.owner_id() && matches!(role, Role::Triage | Role::Reader) {
        return Err(UserError::new(
            codes::REJECTED,
            format!(
                "you own {}: the owner cannot take {} access",
                repo.display(),
                role.label()
            ),
        )
        .cause("the owner holds every right through its ownership and maintainer document")
        .fix("give the owner Maintain or Write access, or give this access to another identity")
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
    /// decides (absent: writer; a value that is not an integer, or an out-of-range code, which
    /// consensus admits none of, is skipped).
    pub fn from_doc(doc: &FetchedDocument, doc_role: Role) -> Option<Self> {
        let member = doc.field_bytes32("memberId")?;
        let role = match doc_role {
            Role::Maintainer => Role::Maintainer,
            // Absent: a writer. Present but not an integer, or out of range: no role at all
            // (as forge-web `writerRoleOf`), never read as a writer.
            _ => match doc.fields.get(WRITER_ROLE) {
                None => Role::Writer,
                Some(v) => Role::from_writer_role_code(Some(v.as_u64()?))?,
            },
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

/// A role change of `member` from `from` to `to` that stopped after its delete landed
/// (`deleted`), or may have (its delete failed: a timeout may still land): the member has no
/// membership now, and the error says how to finish the change, or how to make their removal
/// final.
fn role_change_interrupted(
    repo: &RepoRef,
    member: &str,
    from: Role,
    to: Role,
    cause: &Error,
    deleted: bool,
    keyed: bool,
) -> Error {
    let repo_name = repo.display();
    let (headline, state) = if deleted {
        (
            format!(
                "{member}'s {from} document of {repo_name} was deleted, but the {to} document \
                 was not written"
            ),
            format!("{member} currently has no membership of {repo_name}"),
        )
    } else {
        (
            format!(
                "changing {member}'s role in {repo_name} from {from} to {to} stopped at the \
                 delete of the {from} document, which may still land"
            ),
            format!(
                "{member} may currently have no membership of {repo_name}: `dg collab list \
                 {repo_name}` shows whether the {from} document is gone"
            ),
        )
    };
    let finish = format!(
        "run `dg collab add {repo_name} {member} --role {to}` again to finish the role change"
    );
    let mut u = UserError::new(codes::REJECTED, headline)
        .cause(cause.to_string())
        .fix(finish);
    // a repository with a members key (private, or public with members-only content) must
    // rotate it away from someone who is not coming back
    u = if keyed {
        u.fix(format!(
            "or, if {member} should not be re-added, run `dg collab remove {repo_name} {member}` \
             (or `dg repo keys repair {repo_name}`) so the key rotates away from them"
        ))
    } else {
        u.fix(format!(
            "or, if {member} should not be re-added, leave them removed"
        ))
    };
    u.note(state).into()
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

    /// `identity`'s best current role in `repo` ([`best_role`] over [`Self::roles_of`]).
    pub async fn best_role(&self, repo: &RepoRef, identity: &str) -> Result<Option<Role>> {
        Ok(best_role(&self.roles_of(repo, identity).await?, identity))
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
    /// written, after the consent check).
    #[allow(clippy::too_many_lines)] // one grant: consent, the role change, its recoveries
    pub async fn grant(&self, repo: &RepoRef, member: &str, role: Role) -> Result<Member> {
        self.require_owner(repo)?;
        check_grant(repo, member, role)?;
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
        // How an interrupted role change is finished depends on whether a members key exists
        // (read only for a role change; an unreadable answer is taken as yes).
        let keyed = if changed_from.is_some() {
            crate::keyring::has_members_key(self.client, repo)
                .await
                .unwrap_or(true)
        } else {
            false
        };
        if let Some(old) = existing {
            // A failed delete (a timeout included) may still have landed: say so.
            if let Err(e) = self
                .engine()?
                .delete_document(&core, doc_type(role), &old.document_id)
                .await
            {
                return Err(role_change_interrupted(
                    repo, member, old.role, role, &e, false, keyed,
                ));
            }
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
                return match reader.role_doc(repo, member, role).await {
                    Ok(Some(m)) if m.role == role => Ok(m),
                    Ok(Some(m)) => Err(Error::Config(format!(
                        "{member} holds a {} document of {} now, not {role}: run the add again",
                        m.role,
                        repo.display()
                    ))),
                    Ok(None) => Err(match changed_from {
                        Some(from) => role_change_interrupted(
                            repo,
                            member,
                            from,
                            role,
                            &Error::NotFound,
                            true,
                            keyed,
                        ),
                        None => Error::NotFound,
                    }),
                    Err(e) => Err(match changed_from {
                        Some(from) => {
                            role_change_interrupted(repo, member, from, role, &e, true, keyed)
                        }
                        None => e,
                    }),
                }
            }
            // The old document is gone and the new one is not written: the member has no
            // role until the add runs again.
            Err(e) => {
                return Err(match changed_from {
                    Some(from) => {
                        role_change_interrupted(repo, member, from, role, &e, true, keyed)
                    }
                    None => e,
                })
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

/// `identity`'s best role among `members` (maintainer, writer, triage, reader), if it holds
/// any. Writes are judged by it: a maintainer who also holds a triage document is a
/// maintainer.
#[must_use]
pub fn best_role(members: &[Member], identity: &str) -> Option<Role> {
    members
        .iter()
        .filter(|m| m.identity_id == identity)
        .map(|m| m.role)
        .min()
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
    fn the_best_role_is_the_highest_document_held() {
        let members = [
            member("bob", Role::Writer, 10),
            member("alice", Role::Maintainer, 1),
            member("both", Role::Triage, 10),
            member("both", Role::Maintainer, 20),
        ];
        assert_eq!(best_role(&members, "bob"), Some(Role::Writer));
        assert_eq!(best_role(&members, "alice"), Some(Role::Maintainer));
        // A triage member who is also a maintainer writes as the maintainer.
        assert_eq!(best_role(&members, "both"), Some(Role::Maintainer));
        // Revoke deletes the document, so the list no longer names them.
        assert_eq!(best_role(&members, "carol"), None);
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
            updated_at: None,
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
        assert_eq!(of(Some(0)), None);
        // Present but not an integer: skipped, never read as a writer.
        let mut text = writer_doc(None);
        text.fields
            .insert(WRITER_ROLE.to_string(), FieldValue::text("writer"));
        assert_eq!(Member::from_doc(&text, Role::Writer), None);
        let mut negative = writer_doc(None);
        negative
            .fields
            .insert(WRITER_ROLE.to_string(), FieldValue::signed(-1));
        assert_eq!(Member::from_doc(&negative, Role::Writer), None);
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
        // Every code outside the deny-list is open to triage, unknown ones included, but for
        // the client convention a reader never counts from triage (26, a CI re-run request).
        for code in 0..64u64 {
            let want = if matches!(code, 8 | 15 | 16 | 19 | 20 | 23 | 26) {
                Role::Writer
            } else {
                Role::Triage
            };
            assert_eq!(event_code_needs(code), want, "kind {code}");
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
    fn the_owner_cannot_take_triage_or_reader() {
        for role in [Role::Triage, Role::Reader] {
            let e = check_grant(&private_repo(), "alice", role)
                .unwrap_err()
                .to_string();
            assert!(e.contains("the owner cannot take"), "{e}");
            assert!(check_grant(&private_repo(), "bob", role).is_ok());
        }
        for role in [Role::Maintainer, Role::Writer] {
            assert!(check_grant(&repo(), "alice", role).is_ok());
        }
        // A reader on a public repository is allowed: it reads the members-only content.
        assert!(check_grant(&repo(), "bob", Role::Reader).is_ok());
    }

    #[test]
    fn every_human_role_holds_the_members_key() {
        for role in [Role::Maintainer, Role::Writer, Role::Triage, Role::Reader] {
            assert!(holds_members_key(role), "{role:?}");
        }
    }

    #[test]
    fn triage_and_readers_are_told_what_their_role_allows() {
        let tri = role_limits(Role::Triage, &repo()).unwrap();
        assert!(
            tri.contains(
                "you are a triage member of alice/proj: triage can close, reopen and lock"
            ),
            "{tri}"
        );
        assert!(tri.contains("cannot push, merge"), "{tri}");
        let rdr = role_limits(Role::Reader, &private_repo()).unwrap();
        assert!(rdr.contains("you are a reader of alice/proj"), "{rdr}");
        assert!(rdr.contains("cannot change state"), "{rdr}");
        assert_eq!(role_limits(Role::Writer, &repo()), None);
        assert_eq!(role_limits(Role::Maintainer, &repo()), None);
    }
}
