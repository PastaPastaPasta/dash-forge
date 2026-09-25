//! `FORGE_RULES_V2` — the client rules for forge-v2 repositories (the shared forge-core /
//! forge-collab contracts, `docs/contracts/forge-v2.md`).
//!
//! On v2, consensus does most of what v1's rules reconstructed: an `event` exists only if its
//! writer held a `maintainer`/`writer` document for the repo when it was written, and an
//! `authorEvent` exists only if its writer authored the target and its kind is close or
//! reopen. What is left client-side, and must be identical in every client, is here:
//!
//! * [`RoleOracle`] — membership as the set of *current* `maintainer`/`writer` documents
//!   (a revoked member's document is deleted, so it is simply absent).
//! * [`fold_issue_state_v2`] / [`fold_pr_state_v2`] — the issue/PR fold over `event` and
//!   `authorEvent` (§3).
//! * [`allocate_number`] — issue/PR numbering that tolerates squatters (§6).
//! * [`order_pack_copies`] / [`select_pack_copy`] / [`pack_read_order`] — the pack reader
//!   rule (§4), over copies whose hash the caller has already checked.
//! * [`count_approvals`] — PR approvals from members only (§6).
//! * [`is_well_formed`] — plaintext xor `enc`, and no plaintext in a private repo (§5).
//! * [`is_valid_repo_name`] / [`normalize_repo_name`] — the `repo.name` slug (§2).
//!
//! v1 rules (the parent module) are untouched: v1 repositories stay readable with them. The
//! event ordering and per-kind state changes are v1's own (`apply_issue_event`,
//! `apply_pr_event`, `event_order`, `merge_reachable` in the parent module), so the two
//! versions cannot drift apart where they are meant to agree.
//!
//! Like v1, every function is pure. The conformance vectors with `"rules": "v2"` in
//! `forge-contracts/vectors/` are the parity suite, shared with `forge-web/lib/rules/v2.ts`.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use super::{
    apply_issue_event, apply_pr_event, event_order, merge_reachable, Event, EventKind, IssueState,
    Oid, PrState, Verdict,
};

/// The versioned rules identifier for forge-v2 repositories.
pub const FORGE_RULES_V2: &str = "FORGE_RULES_V2";

// ===========================================================================
// Membership
// ===========================================================================

/// A membership role: which forge-core document type grants it. Maintainer ranks first.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Role {
    /// A `maintainer` document.
    Maintainer,
    /// A `writer` document.
    Writer,
}

/// One current `maintainer` or `writer` document of a repository, flattened.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Membership {
    /// `memberId`, the identity the document enrols.
    pub identity: String,
    /// Which document type it is.
    pub role: Role,
    /// Consensus `$createdAt` (ms) of the document.
    pub created_at: u64,
}

/// Membership of one repository, answered from its current membership documents.
///
/// Revocation deletes the document, so a revoked member is absent and, as far as this oracle
/// knows, never was a member. A re-added member has a new document with a later
/// `created_at`, so their membership starts again there.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(transparent)]
pub struct RoleOracle {
    /// The repo's current `maintainer` and `writer` documents.
    pub memberships: Vec<Membership>,
}

impl RoleOracle {
    /// Build from the repo's current membership documents.
    #[must_use]
    pub fn new(memberships: Vec<Membership>) -> Self {
        Self { memberships }
    }

    /// The best role `identity` held at `at`: from a current document with `created_at <= at`
    /// (at equal times the document applies). Maintainer outranks writer.
    #[must_use]
    pub fn role_at(&self, identity: &str, at: u64) -> Option<Role> {
        self.memberships
            .iter()
            .filter(|m| m.identity == identity && m.created_at <= at)
            .map(|m| m.role)
            .min()
    }

    /// Whether `identity` was a maintainer or writer at `at`.
    #[must_use]
    pub fn member_at(&self, identity: &str, at: u64) -> bool {
        self.role_at(identity, at).is_some()
    }

    /// The best role `identity` holds now (any current document).
    #[must_use]
    pub fn current_role(&self, identity: &str) -> Option<Role> {
        self.role_at(identity, u64::MAX)
    }
}

// ===========================================================================
// Issue / PR fold
// ===========================================================================

/// Whether an `authorEvent` applies: it must be a close or reopen by the target's author.
///
/// Consensus already guarantees both (the schema limits the kind to 1..=2, and the gate is the
/// author lookup), so this is defense in depth against a reader handing in the wrong
/// documents. An `event` needs no check: its existence proves a maintainer or writer wrote it,
/// and revoking them later does not undo that.
fn author_event_applies(e: &Event, target_author: &str) -> bool {
    matches!(e.kind, EventKind::Close | EventKind::Reopen) && e.actor == target_author
}

/// The applicable documents of both types, in v1's `(createdAt, id)` order. `events` come
/// first in the input, so two documents with the same key keep that order (the sort is
/// stable; real `$id`s never collide across document types).
fn merged_log<'a>(
    events: &'a [Event],
    author_events: &'a [Event],
    target_author: &str,
) -> Vec<&'a Event> {
    let mut log: Vec<&Event> = events
        .iter()
        .chain(
            author_events
                .iter()
                .filter(|e| author_event_applies(e, target_author)),
        )
        .collect();
    log.sort_by(|a, b| event_order(a, b));
    log
}

/// Fold an issue's `event` and `authorEvent` documents into its [`IssueState`].
///
/// * Every `event` applies, whoever wrote it and whatever has happened to their membership
///   since (PR-only kinds do nothing to an issue).
/// * An `authorEvent` applies only if it is a close or reopen by `target_author`.
/// * Both are applied as one log ordered by `(createdAt, id)`, with v1's per-kind effects.
#[must_use]
pub fn fold_issue_state_v2(
    events: &[Event],
    author_events: &[Event],
    target_author: &str,
) -> IssueState {
    let mut state = IssueState::default();
    for e in merged_log(events, author_events, target_author) {
        apply_issue_event(&mut state, e);
    }
    state
}

/// Fold a PR's `event` and `authorEvent` documents into its [`PrState`].
///
/// As [`fold_issue_state_v2`], and a `merge` (which can only come from `event`) applies only
/// if its `oid` is reachable from `base_tip`, v1's predicate. A merged PR cannot be reopened.
#[must_use]
pub fn fold_pr_state_v2(
    events: &[Event],
    author_events: &[Event],
    target_author: &str,
    base_tip: Option<&str>,
    is_ancestor: impl Fn(&str, &str) -> bool,
) -> PrState {
    let mut state = PrState::default();
    for e in merged_log(events, author_events, target_author) {
        if e.kind == EventKind::Merge && !merge_reachable(e, base_tip, &is_ancestor) {
            continue;
        }
        apply_pr_event(&mut state, e);
    }
    state
}

// ===========================================================================
// Numbering
// ===========================================================================

/// The numbering ceiling for a repo with `count` issues (or PRs): `min(2 × count + 100,
/// 2^32 − 1)`. Taken numbers above it are ignored as squatters.
#[must_use]
pub fn number_ceiling(count: u64) -> u64 {
    count
        .saturating_mul(2)
        .saturating_add(100)
        .min(u64::from(u32::MAX))
}

/// The number to claim for a new issue (or PR), `forge-v2.md` §6.
///
/// `count` is the provable count of the repo's issues (the rangeCountable `number` index).
/// `taken_numbers_desc` are claimed numbers as the `number` index returns them (descending;
/// the order is not relied on). It must hold every taken number from `base` (below) upward.
///
/// 1. `ceiling = min(2 × count + 100, 2^32 − 1)`.
/// 2. `base` = the largest taken number `≤ ceiling`, or 0.
/// 3. Claim the first number `> base` that is not taken. Below the ceiling that is always
///    `base + 1`. Only when `base` is the ceiling itself can squatters just above it be in
///    the way, and the probe steps over them.
///
/// `None` when every number from `base + 1` to `2^32 − 1` is taken. Gaps below `base` are never
/// filled.
#[must_use]
pub fn allocate_number(count: u64, taken_numbers_desc: &[u32]) -> Option<u32> {
    let ceiling = number_ceiling(count);
    let taken: BTreeSet<u64> = taken_numbers_desc.iter().map(|&n| u64::from(n)).collect();
    let base = taken.range(..=ceiling).next_back().copied().unwrap_or(0);
    let mut candidate = base + 1;
    while taken.contains(&candidate) {
        candidate += 1;
    }
    u32::try_from(candidate).ok()
}

// ===========================================================================
// Pack copies
// ===========================================================================

/// One writer's `packManifest` for a pack, flattened, with whether its reassembled bytes
/// verified against `pack_hash` (checked by the caller; a copy never fetched is `false`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackCopy {
    /// Document `$id` of the manifest.
    pub id: String,
    /// The pack's content hash, hex.
    pub pack_hash: String,
    /// The uploader's current role in the repo ([`RoleOracle::current_role`]); `None` once
    /// their membership is revoked (the gate admitted them when they uploaded).
    #[serde(default)]
    pub owner_role: Option<Role>,
    /// Consensus `$createdAt` (ms).
    pub created_at: u64,
    /// This copy's bytes hash to `pack_hash`.
    #[serde(default)]
    pub verified: bool,
    /// Pack hashes this manifest says the pack consolidates (`supersedes`, hex).
    #[serde(default)]
    pub supersedes: Vec<String>,
}

/// Maintainers' copies, then writers', then everyone else's.
fn role_rank(role: Option<Role>) -> u8 {
    match role {
        Some(Role::Maintainer) => 0,
        Some(Role::Writer) => 1,
        None => 2,
    }
}

fn sort_copies(copies: &mut [&PackCopy]) {
    copies.sort_by(|a, b| {
        role_rank(a.owner_role)
            .cmp(&role_rank(b.owner_role))
            .then_with(|| a.created_at.cmp(&b.created_at))
            .then_with(|| a.id.cmp(&b.id))
    });
}

/// The order a reader tries a pack's copies in: owner role (maintainer, writer, other), then
/// `created_at` ascending, then `id` ascending.
#[must_use]
pub fn order_pack_copies(copies: &[PackCopy]) -> Vec<&PackCopy> {
    let mut ordered: Vec<&PackCopy> = copies.iter().collect();
    sort_copies(&mut ordered);
    ordered
}

/// The copy to read a pack from: the first verified copy in [`order_pack_copies`] order.
/// `copies` are the manifests of one `pack_hash`. `None` when no copy verifies.
#[must_use]
pub fn select_pack_copy(copies: &[PackCopy]) -> Option<&PackCopy> {
    order_pack_copies(copies).into_iter().find(|c| c.verified)
}

/// One readable pack in [`pack_read_order`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackPick {
    /// The pack.
    pub pack_hash: String,
    /// The copy selected for it ([`select_pack_copy`]).
    pub copy_id: String,
    /// The selected copy of another readable pack lists this pack in `supersedes`.
    pub superseded: bool,
}

/// Every readable pack of a repo, in the order a reader fetches them.
///
/// `copies` are all the repo's pack manifests (any number of packs). Per pack hash the copy is
/// [`select_pack_copy`]'s; a pack with no verified copy is left out. A pack is *superseded*
/// when the selected copy of another readable pack lists it in `supersedes`: a `supersedes`
/// claim is honoured only if the pack making it verifies, and only from the copy actually read.
///
/// Superseded packs are ordered after the rest, not dropped. A consolidated pack is tried
/// first, and the older packs remain a fallback for any object it lacks: hash verification
/// proves a pack's bytes, not that it holds everything it claims to supersede, so dropping
/// them would let one writer hide a repository's history. Within each group the order is the
/// selected copy's `created_at`, then `pack_hash`, ascending.
#[must_use]
pub fn pack_read_order(copies: &[PackCopy]) -> Vec<PackPick> {
    let hashes: BTreeSet<&str> = copies.iter().map(|c| c.pack_hash.as_str()).collect();
    let mut selected: Vec<&PackCopy> = hashes
        .into_iter()
        .filter_map(|hash| {
            let mut of_pack: Vec<&PackCopy> =
                copies.iter().filter(|c| c.pack_hash == hash).collect();
            sort_copies(&mut of_pack);
            of_pack.into_iter().find(|c| c.verified)
        })
        .collect();
    let superseded: BTreeSet<&str> = selected
        .iter()
        .flat_map(|c| {
            c.supersedes
                .iter()
                .filter(move |s| **s != c.pack_hash)
                .map(String::as_str)
        })
        .collect();
    let is_superseded = |c: &PackCopy| superseded.contains(c.pack_hash.as_str());
    selected.sort_by(|a, b| {
        is_superseded(a)
            .cmp(&is_superseded(b))
            .then_with(|| a.created_at.cmp(&b.created_at))
            .then_with(|| a.pack_hash.cmp(&b.pack_hash))
    });
    selected
        .into_iter()
        .map(|c| PackPick {
            pack_hash: c.pack_hash.clone(),
            copy_id: c.id.clone(),
            superseded: is_superseded(c),
        })
        .collect()
}

// ===========================================================================
// Approvals
// ===========================================================================

/// A `review` document, flattened.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Review {
    /// Document `$id`.
    pub id: String,
    /// Document `$ownerId`.
    pub reviewer: String,
    /// The `verdict` code (1 approve, 2 request changes, 3 comment).
    pub verdict: u64,
    /// The commit reviewed, hex.
    pub commit_oid: Oid,
    /// Consensus `$createdAt` (ms).
    pub created_at: u64,
}

/// The reviewers whose verdict stands on a PR's current head.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Approvals {
    /// Reviewers whose standing verdict is approve (sorted). The approval count is its length.
    pub approvers: BTreeSet<String>,
    /// Reviewers whose standing verdict is request changes (sorted).
    pub changes_requested: BTreeSet<String>,
}

/// Count a PR's approvals, `forge-v2.md` §6.
///
/// A review counts only if it is on `head_oid` (a push after it resets it) and its reviewer
/// was a maintainer or writer at the review's `created_at` ([`RoleOracle::member_at`]). A
/// reviewer's standing verdict is their newest counting approve or request-changes review by
/// `(created_at, id)`. Comment reviews (3) and unknown codes neither approve nor clear an
/// earlier verdict.
///
/// Unlike an `event`, a `review` is un-gated, so nothing on chain proves its writer was a
/// member; the oracle does. A revoked reviewer's document is gone, so their reviews stop
/// counting, which is what a merge decision made now should see.
#[must_use]
pub fn count_approvals(reviews: &[Review], oracle: &RoleOracle, head_oid: &str) -> Approvals {
    let mut counting: Vec<(&Review, Verdict)> = reviews
        .iter()
        .map(|r| (r, Verdict::from_code(r.verdict)))
        .filter(|(r, v)| {
            matches!(v, Verdict::Approve | Verdict::RequestChanges)
                && r.commit_oid == head_oid
                && oracle.member_at(&r.reviewer, r.created_at)
        })
        .collect();
    counting.sort_by(|(a, _), (b, _)| {
        a.created_at
            .cmp(&b.created_at)
            .then_with(|| a.id.cmp(&b.id))
    });
    let mut out = Approvals::default();
    for (r, verdict) in counting {
        let (add, clear) = if verdict == Verdict::Approve {
            (&mut out.approvers, &mut out.changes_requested)
        } else {
            (&mut out.changes_requested, &mut out.approvers)
        };
        clear.remove(&r.reviewer);
        add.insert(r.reviewer.clone());
    }
    out
}

// ===========================================================================
// Well-formedness (private repositories)
// ===========================================================================

/// A repository's `visibility`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Visibility {
    /// `public`.
    Public,
    /// `private`: content is under `enc` (§5).
    Private,
}

/// The document types that carry either plaintext or `enc`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ContentKind {
    /// `issue`: plaintext `title` (required), `body`.
    Issue,
    /// `patch`: plaintext `title` (required), `body`, `baseRefName`, `sourceRefName`.
    Patch,
    /// `comment`: plaintext `body` (required).
    Comment,
    /// `review`: plaintext `body` (required).
    Review,
    /// `refUpdate` or `protectedRefUpdate`: plaintext `refName` (required).
    RefUpdate,
}

/// The content fields of a document, flattened. An absent field and an empty string are the
/// same.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentDoc {
    /// Which document type.
    pub kind: ContentKind,
    /// `title`.
    #[serde(default)]
    pub title: Option<String>,
    /// `body`.
    #[serde(default)]
    pub body: Option<String>,
    /// `refName` (ref updates).
    #[serde(default)]
    pub ref_name: Option<String>,
    /// `baseRefName` (patches).
    #[serde(default)]
    pub base_ref_name: Option<String>,
    /// `sourceRefName` (patches).
    #[serde(default)]
    pub source_ref_name: Option<String>,
    /// `enc`, hex.
    #[serde(default)]
    pub enc: Option<String>,
    /// `epoch`.
    #[serde(default)]
    pub epoch: Option<u32>,
}

fn present(s: Option<&String>) -> bool {
    s.is_some_and(|s| !s.is_empty())
}

/// Whether a document is well-formed for its repository, `forge-v2.md` §5. Readers skip a
/// malformed document.
///
/// Plaintext xor `enc`, and the repository's visibility says which:
///
/// * **public**: no `enc`, and the kind's required plaintext field is present ([`ContentKind`]);
/// * **private**: a non-empty `enc` with an `epoch`, and none of the kind's plaintext fields.
///
/// So a document with neither, or both, is malformed, and so is plaintext in a private repo
/// (including a private ref update's `refName`) or ciphertext in a public one. A `review`
/// needs a `body` like a `comment`: a bare verdict is written with a body (or `enc`).
#[must_use]
pub fn is_well_formed(doc: &ContentDoc, visibility: Visibility) -> bool {
    let (required, others): (Option<&String>, &[Option<&String>]) = match doc.kind {
        ContentKind::Issue => (doc.title.as_ref(), &[doc.body.as_ref()]),
        ContentKind::Patch => (
            doc.title.as_ref(),
            &[
                doc.body.as_ref(),
                doc.base_ref_name.as_ref(),
                doc.source_ref_name.as_ref(),
            ],
        ),
        ContentKind::Comment | ContentKind::Review => (doc.body.as_ref(), &[]),
        ContentKind::RefUpdate => (doc.ref_name.as_ref(), &[]),
    };
    let encrypted = present(doc.enc.as_ref());
    match visibility {
        Visibility::Public => !encrypted && present(required),
        Visibility::Private => {
            encrypted
                && doc.epoch.is_some()
                && !present(required)
                && !others.iter().any(|s| present(*s))
        }
    }
}

// ===========================================================================
// Repository names
// ===========================================================================

/// The longest `repo.name`, in characters (every valid name is ASCII).
pub const MAX_REPO_NAME_LEN: usize = 63;

/// Whether `name` is a valid `repo.name`: the contract's pattern `^[a-z0-9][a-z0-9._-]{0,62}$`.
#[must_use]
pub fn is_valid_repo_name(name: &str) -> bool {
    let alnum = |b: u8| b.is_ascii_lowercase() || b.is_ascii_digit();
    match name.as_bytes().split_first() {
        Some((&first, rest)) => {
            name.len() <= MAX_REPO_NAME_LEN
                && alnum(first)
                && rest
                    .iter()
                    .all(|&b| alnum(b) || matches!(b, b'.' | b'_' | b'-'))
        }
        None => false,
    }
}

/// The `repo.name` a user's input names: ASCII letters lowercased (the contract admits only
/// lowercase, so `Dash-Forge` and `dash-forge` are one name), nothing else changed. `None`
/// when the result is not a valid name.
#[must_use]
pub fn normalize_repo_name(input: &str) -> Option<String> {
    let lowered = input.to_ascii_lowercase();
    is_valid_repo_name(&lowered).then_some(lowered)
}
