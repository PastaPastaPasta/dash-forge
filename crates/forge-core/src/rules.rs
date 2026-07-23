//! `FORGE_RULES_V1` — the cross-client-parity heart of Dash Forge.
//!
//! Dash Platform enforces token spend, schema, and uniqueness at consensus, but it
//! has **no CAS**, cannot read glob patterns, and cannot fold an append-only event log
//! into "is this issue open". Those decisions are made *client-side*, and every
//! conforming client must make them **identically** — otherwise two people looking at
//! the same repo see two different branch tips, two different issue states, two
//! different protected-ref verdicts. This module is the Rust half of that shared
//! logic; a TypeScript port (`forge-web`) is the other half.
//!
//! Parity is held by a versioned spec (`docs/contracts/data-contracts.md` §4) plus
//! **shared JSON conformance vectors** in `forge-contracts/vectors/`. Both language
//! ports run the exact same vectors and must produce the exact same `expected`. The
//! test at the bottom of this file is that suite for the Rust side.
//!
//! Everything here is **pure**: no SDK, no network, no funds, no clock. Callers fetch
//! the documents (refUpdate / config / event / token-history / flatIndex) and hand
//! them in as plain structs; these functions resolve. The only "clock" available is
//! the consensus `$createdAt` carried on every document (data-contracts §0), so every
//! as-of-time decision is a comparison of those timestamps.
//!
//! ## What lives here
//!
//! * [`resolve_ref`] — fold a ref's `refUpdate`/`protectedRefUpdate` history into a
//!   [`RefState`], honoring as-of-time protected-pattern config and same-`prevOid`
//!   divergence (§2.3, §4).
//! * [`matches_protected`] — git-fnmatch protected-pattern matching (§2.3).
//! * [`fold_issue_state`] / [`fold_pr_state`] — fold the `event` log into issue/PR
//!   state, with actor authorization evaluated **as-of** each event's `$createdAt`.
//! * [`holdings_as_of`] — reconstruct a WRITE/MAINTAIN holding from token-history
//!   mint/freeze/destroy records at a point in time.
//! * [`overlay_tree`] — apply the tree diffs of the ≤ 20 commits since a flatIndex's
//!   indexed tip on top of it, so browse views stay fresh without a full re-walk
//!   (the S0.5 cold-load correction).

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

/// The versioned rules identifier shared with forge-web and the conformance vectors.
///
/// Any behavioral change to the functions in this module is a new version: bump this,
/// re-freeze the vectors, and port both sides together.
pub const FORGE_RULES_V1: &str = "FORGE_RULES_V1";

/// A git object id, hex-encoded (the JSON-friendly representation the vectors use).
///
/// The wire/document form is a 20–32 byte `byteArray` (data-contracts §0); the rules
/// layer never does byte math on an oid — it only compares equality and consults the
/// caller-supplied ancestry predicate — so a hex string is the natural pure-logic type
/// and round-trips through JSON vectors unchanged. An all-zero oid (any length of
/// `'0'`, or the empty string) is the git "null oid": a create (`prevOid`) or a delete
/// (`newOid`).
pub type Oid = String;

/// True for the git null oid — all-zero hex, or empty. Create `prevOid` / delete
/// `newOid` both use it.
fn is_null_oid(oid: &str) -> bool {
    oid.is_empty() || oid.bytes().all(|b| b == b'0')
}

// ===========================================================================
// Ancestry
// ===========================================================================

/// The commit-graph ancestry relation, supplied by the caller.
///
/// The rules layer has no git object store, so ancestry ("does commit *B* descend from
/// commit *A*") is an **input**: a precomputed set of `(ancestor, descendant)` pairs
/// (typically the transitive closure over the relevant commits). This keeps ref
/// resolution and merge-reachability pure and lets the vectors pin exactly which
/// ancestry facts are in play. [`resolve_ref`]/[`fold_pr_state`] also accept any
/// `Fn(&str, &str) -> bool` directly for callers that have a real graph.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Ancestry {
    /// `[ancestor, descendant]` pairs. `is_ancestor(a, b)` is true iff `a == b` or
    /// `[a, b]` is present.
    pub pairs: Vec<(Oid, Oid)>,
}

impl Ancestry {
    /// Reflexive ancestry: `a` is an ancestor of `b` iff they are equal or the pair
    /// `[a, b]` is present in the closure.
    #[must_use]
    pub fn is_ancestor(&self, ancestor: &str, descendant: &str) -> bool {
        ancestor == descendant
            || self
                .pairs
                .iter()
                .any(|(a, d)| a == ancestor && d == descendant)
    }
}

// ===========================================================================
// Ref resolution
// ===========================================================================

/// A single append-only `refUpdate` / `protectedRefUpdate` document, flattened to the
/// fields resolution needs. Callers fetch these (via the §2.3 skip-scan + §3
/// completeness fallback) and hand the slice in.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefUpdate {
    /// Document `$id` — the deterministic tiebreak when two updates share `$createdAt`.
    pub id: String,
    /// `sha256(refName)`, hex — the indexed key a ref is looked up by.
    pub ref_name_hash: String,
    /// The ref name itself, e.g. `refs/heads/main` — matched against protected globs.
    pub ref_name: String,
    /// Recorded previous tip (hex; null = create). The pivot for divergence detection.
    #[serde(default)]
    pub prev_oid: Oid,
    /// New tip (hex; null = delete).
    pub new_oid: Oid,
    /// The pusher set the force flag.
    #[serde(default)]
    pub force: bool,
    /// `true` iff this arrived via the MAINTAIN-gated `protectedRefUpdate` type.
    /// A plain `refUpdate` naming a protected ref has this `false` and is inert (§4).
    #[serde(default)]
    pub protected: bool,
    /// Document `$ownerId` — the pusher, surfaced as the resolved tip's author.
    pub author: String,
    /// Consensus `$createdAt` (ms). The clock for ordering and as-of protection.
    pub created_at: u64,
}

/// A `config` document, flattened to what protection resolution needs.
///
/// `config` is append-only and non-deletable (§2.2), so the config history is a total,
/// gap-free timeline: "the patterns in force when update *u* landed" is always
/// well-defined.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigDoc {
    /// Document `$id` — tiebreak when two configs share `$createdAt`.
    #[serde(default)]
    pub id: String,
    /// Consensus `$createdAt` (ms).
    pub created_at: u64,
    /// git-fnmatch globs (§2.3); empty means nothing is protected as-of this config.
    #[serde(default)]
    pub protected_patterns: Vec<String>,
}

/// One live tip of a diverged ref.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefHead {
    /// The tip commit.
    pub oid: Oid,
    /// Pusher of the update that set this tip.
    pub author: String,
    /// `$createdAt` of that update.
    pub created_at: u64,
}

/// The resolved state of a single ref after folding its update history.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum RefState {
    /// The ref does not exist — no valid update, or the newest valid update is a
    /// deletion. (A deleted ref and a never-created ref are indistinguishable as
    /// *current* state, and the reflog history carries the difference.)
    Unborn,
    /// The ref points at a single tip.
    #[serde(rename_all = "camelCase")]
    Resolved {
        /// Current tip.
        oid: Oid,
        /// Pusher of the winning update.
        author: String,
        /// `$createdAt` of the winning update.
        created_at: u64,
    },
    /// A lost same-`prevOid` race left ≥ 2 tips live at consensus (no CAS exists, so
    /// both pushes landed). The ref stays provisional until a later update supersedes
    /// every head — a merge that descends from all of them, or an explicit force
    /// (§2.3). `heads[0]` is the provisional read-only tip (newest by `$createdAt`).
    Diverged {
        /// Competing live tips, newest first.
        heads: Vec<RefHead>,
    },
}

/// Fold a ref's `refUpdate`/`protectedRefUpdate` history into its [`RefState`].
///
/// `updates` may contain updates for *other* refs; only those whose `refNameHash`
/// equals `ref_name_hash` participate. `config_history` is the repo's full `config`
/// timeline (append-only, so order-independent). `is_ancestor(a, b)` reports whether
/// commit `a` is an ancestor of (or equal to) commit `b`.
///
/// ## Algorithm (normative — `FORGE_RULES_V1`)
///
/// This implements data-contracts §4's protected-ref pseudocode plus the §2.3
/// divergence rule, generalized so that a merge/force "supersedes both" heads exactly
/// as the spec requires.
///
/// 1. **Validity (protection routing, §4).** Keep update `u` iff it is *valid*: let
///    `cfg` be the newest config with `cfg.created_at <= u.created_at` (tie at equal
///    `created_at`: the config applies — conservative; no such config → nothing
///    protected). If `u.refName` matches any `cfg.protectedPatterns`, `u` must be a
///    `protectedRefUpdate` (`protected == true`); a plain `refUpdate` on a protected
///    ref is **inert** and dropped. Un-protected refs admit either type.
/// 2. **Order** valid updates ascending by `(createdAt, id)`.
/// 3. If none remain → [`RefState::Unborn`]. If the newest valid update is a deletion
///    (null `newOid`) → [`RefState::Unborn`].
/// 4. **Live heads.** A valid update `u` (non-null tip) is *superseded* by a strictly
///    newer valid update `v` — newer by `(createdAt, id)` — when any holds:
///    * `v` is a deletion or a force (it clears/replaces the ref outright), or
///    * `v.prevOid == u.newOid` (someone fast-forwarded directly off `u`'s tip), or
///    * `is_ancestor(u.newOid, v.newOid)` (later history descends from `u`'s tip).
///
///    The **live heads** are the non-superseded, non-null updates, deduplicated by tip.
/// 5. Exactly one live head → [`RefState::Resolved`]. Two or more (a concurrent race
///    nothing has merged past) → [`RefState::Diverged`], heads newest-first.
///
/// The "supersedes both" clause falls out of step 4: a merge whose commit descends
/// from every racing head supersedes them all (leaving itself as the sole head), and a
/// force supersedes everything older than it. A push that only fast-forwards *one* side
/// of a race leaves the other side live, so the ref stays diverged — which is the
/// correct, if easily overlooked, reading of §2.3.
pub fn resolve_ref(
    updates: &[RefUpdate],
    config_history: &[ConfigDoc],
    ref_name_hash: &str,
    is_ancestor: impl Fn(&str, &str) -> bool,
) -> RefState {
    // (1) validity filter, keeping only this ref's updates.
    let mut valid: Vec<&RefUpdate> = updates
        .iter()
        .filter(|u| u.ref_name_hash == ref_name_hash && is_update_valid(u, config_history))
        .collect();

    // (2) order ascending by (createdAt, id).
    valid.sort_by(|a, b| {
        a.created_at
            .cmp(&b.created_at)
            .then_with(|| a.id.cmp(&b.id))
    });

    // (3) unborn / deleted.
    let Some(newest) = valid.last() else {
        return RefState::Unborn;
    };
    if is_null_oid(&newest.new_oid) {
        return RefState::Unborn;
    }

    // (4) live heads.
    let newer_supersedes = |u: &RefUpdate, v: &RefUpdate| -> bool {
        // v must be strictly newer than u.
        let v_newer = (v.created_at, &v.id) > (u.created_at, &u.id);
        if !v_newer {
            return false;
        }
        if is_null_oid(&v.new_oid) || v.force {
            return true;
        }
        if !is_null_oid(&v.prev_oid) && v.prev_oid == u.new_oid {
            return true;
        }
        is_ancestor(&u.new_oid, &v.new_oid)
    };

    let mut heads: Vec<RefHead> = Vec::new();
    for u in &valid {
        if is_null_oid(&u.new_oid) {
            continue;
        }
        let superseded = valid.iter().any(|v| newer_supersedes(u, v));
        if superseded {
            continue;
        }
        // Deduplicate by tip: the same oid pushed twice is one head.
        if heads.iter().any(|h| h.oid == u.new_oid) {
            continue;
        }
        heads.push(RefHead {
            oid: u.new_oid.clone(),
            author: u.author.clone(),
            created_at: u.created_at,
        });
    }

    // (5) resolve.
    match heads.len() {
        0 => RefState::Unborn, // unreachable given step 3, but total.
        1 => {
            let h = heads.pop().expect("len checked");
            RefState::Resolved {
                oid: h.oid,
                author: h.author,
                created_at: h.created_at,
            }
        }
        _ => {
            // Newest-first: heads[0] is the provisional read-only tip.
            heads.sort_by(|a, b| {
                b.created_at
                    .cmp(&a.created_at)
                    .then_with(|| b.oid.cmp(&a.oid))
            });
            RefState::Diverged { heads }
        }
    }
}

/// The as-of-time protection check from §4: is update `u` a valid mover of its ref?
fn is_update_valid(u: &RefUpdate, config_history: &[ConfigDoc]) -> bool {
    let cfg = config_as_of(config_history, u.created_at);
    let Some(cfg) = cfg else {
        return true; // no config in force → nothing protected → valid.
    };
    if matches_protected(&u.ref_name, &cfg.protected_patterns) {
        // Protected ref: only a MAINTAIN-gated protectedRefUpdate moves it.
        u.protected
    } else {
        // Unprotected: either type is fine (MAINTAIN holders may protect-push anywhere).
        true
    }
}

/// The `config` in force at time `at`: the newest config with `created_at <= at`.
///
/// Tie at equal `created_at`: the config applies (§4 "conservative" rule), and among
/// equal-`created_at` configs the one with the greatest `$id` wins — the same
/// `(created_at, id)` total order used everywhere else, so it is deterministic.
fn config_as_of(config_history: &[ConfigDoc], at: u64) -> Option<&ConfigDoc> {
    config_history
        .iter()
        .filter(|c| c.created_at <= at)
        .max_by(|a, b| {
            a.created_at
                .cmp(&b.created_at)
                .then_with(|| a.id.cmp(&b.id))
        })
}

// ===========================================================================
// Protected-pattern matching
// ===========================================================================

/// Whether `ref_name` matches **any** protected glob in `patterns`.
///
/// ## Pinned glob semantics (`FORGE_RULES_V1`)
///
/// Matching is git-fnmatch via the [`glob_match`](glob_match::glob_match) crate, which
/// implements git's `wildmatch` with the `WM_PATHNAME` flag — the same behavior
/// `git for-each-ref <pattern>` uses. Precisely:
///
/// * `*` matches any run of characters **except** `/` (stays within one ref segment).
/// * `**` matches across `/` (any number of segments), e.g. `refs/heads/**` is "every
///   branch at any depth".
/// * `?` matches a single non-`/` character.
/// * `[abc]` / `[a-z]` character classes and `{a,b}` alternation are supported.
///
/// So `refs/heads/*` protects `refs/heads/main` and `refs/heads/dev` but **not**
/// `refs/heads/release/1.0`; use `refs/heads/release/*` for one level of release
/// branches or `refs/heads/**` to protect every branch including nested ones. This is a
/// deliberate, ported-verbatim contract — see the doc-reconciliation note in the module
/// implementation report; the earlier skeleton used `*`-matches-`/` (POSIX `fnmatch`
/// without `FNM_PATHNAME`) semantics, and this module standardizes on the crate's
/// git-`WM_PATHNAME` behavior instead.
#[must_use]
pub fn matches_protected(ref_name: &str, patterns: &[String]) -> bool {
    patterns.iter().any(|p| glob_match::glob_match(p, ref_name))
}

// ===========================================================================
// Token-history authorization (as-of-time)
// ===========================================================================

/// Which repo token a history record concerns (§2.1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TokenKind {
    /// Position 0 — push / upload / CI.
    Write,
    /// Position 1 — protected refs / releases / labels / webhooks / config.
    Maintain,
}

/// A token-history operation (§2.1 grant/suspend/revoke lifecycle).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TokenOp {
    /// Grant (or re-grant) the token to an identity.
    Mint,
    /// Suspend: the identity keeps the balance but a frozen identity cannot spend, so
    /// gated actions fail at consensus — hence it cannot act, as-of the freeze.
    Freeze,
    /// Lift a freeze (identity can spend again).
    Unfreeze,
    /// Revoke: destroy the frozen balance. The holding is gone from here forward.
    Destroy,
}

/// One record from the system token-history contract: identity *X* had operation *op*
/// applied to token *token* at `created_at`. These reconstruct authorization as-of any
/// past moment (§4: "reconstructed deterministically from the token-history contract").
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenRecord {
    /// Record `$id` — tiebreak for equal `created_at`.
    #[serde(default)]
    pub id: String,
    /// The affected identity.
    pub identity: String,
    /// Which token.
    pub token: TokenKind,
    /// What happened.
    pub op: TokenOp,
    /// Consensus `$createdAt` (ms).
    pub created_at: u64,
}

/// Whether an identity can *spend* WRITE / MAINTAIN at a point in time.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Holdings {
    /// Holds an unfrozen WRITE balance (can push).
    pub write: bool,
    /// Holds an unfrozen MAINTAIN balance (can protected-push / configure).
    pub maintain: bool,
}

impl Holdings {
    /// Holder of either token — the "WRITE/MAINTAIN holder" the enforcement matrix
    /// authorizes for every event kind.
    #[must_use]
    pub fn any(self) -> bool {
        self.write || self.maintain
    }
}

/// Reconstruct an identity's **spendable** WRITE/MAINTAIN holdings as-of time `at`.
///
/// Replays that identity's token-history records with `created_at <= at` (tie at equal
/// `created_at`: the record applies, ordered by `$id`) through a per-token state
/// machine: `Mint` → held & unfrozen, `Freeze` → held but suspended, `Unfreeze` →
/// spendable again, `Destroy` → not held. A token is *spendable* only when held and not
/// frozen — a frozen identity cannot spend at consensus (S0.7: rejected 40702), so it
/// cannot authorize an action at that time.
///
/// Because this is evaluated *as-of the event's* `created_at`, a maintainer who was
/// frozen *after* acting still holds at the earlier moment: their past action stays
/// valid, exactly as §4 requires ("current balances alone would retroactively
/// invalidate a since-revoked maintainer's legitimate past actions").
#[must_use]
pub fn holdings_as_of(records: &[TokenRecord], identity: &str, at: u64) -> Holdings {
    Holdings {
        write: token_spendable_as_of(records, identity, TokenKind::Write, at),
        maintain: token_spendable_as_of(records, identity, TokenKind::Maintain, at),
    }
}

fn token_spendable_as_of(
    records: &[TokenRecord],
    identity: &str,
    token: TokenKind,
    at: u64,
) -> bool {
    let mut relevant: Vec<&TokenRecord> = records
        .iter()
        .filter(|r| r.identity == identity && r.token == token && r.created_at <= at)
        .collect();
    relevant.sort_by(|a, b| {
        a.created_at
            .cmp(&b.created_at)
            .then_with(|| a.id.cmp(&b.id))
    });

    let (mut held, mut frozen) = (false, false);
    for r in relevant {
        match r.op {
            TokenOp::Mint => {
                held = true;
                frozen = false;
            }
            TokenOp::Freeze => frozen = true,
            TokenOp::Unfreeze => frozen = false,
            TokenOp::Destroy => {
                held = false;
                frozen = false;
            }
        }
    }
    held && !frozen
}

/// A token-history-backed authorization resolver, as named in the module spec. Thin
/// wrapper over [`holdings_as_of`] so callers can pass one `&AuthzResolver` around
/// instead of threading the record slice.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthzResolver {
    /// The token-history records (mint/freeze/unfreeze/destroy).
    pub records: Vec<TokenRecord>,
}

impl AuthzResolver {
    /// Build from token-history records.
    #[must_use]
    pub fn new(records: Vec<TokenRecord>) -> Self {
        Self { records }
    }

    /// [`holdings_as_of`] against the wrapped records.
    #[must_use]
    pub fn holdings_as_of(&self, identity: &str, at: u64) -> Holdings {
        holdings_as_of(&self.records, identity, at)
    }
}

// ===========================================================================
// Event fold (issue / PR state)
// ===========================================================================

/// A collaboration `event` kind (§2.3 numeric kinds 1–10).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EventKind {
    /// 1 — issue/PR closed.
    Close,
    /// 2 — reopened.
    Reopen,
    /// 3 — PR merged (`oid` = merge commit).
    Merge,
    /// 4 — label added (`value` = label name).
    LabelAdd,
    /// 5 — label removed (`value` = label name).
    LabelRemove,
    /// 6 — assignee added (`value` = identity).
    Assign,
    /// 7 — assignee removed (`value` = identity).
    Unassign,
    /// 8 — PR base retargeted (`value` = new base ref name).
    Retarget,
    /// 9 — PR marked draft.
    Draft,
    /// 10 — PR marked ready for review.
    Ready,
}

/// A single `event` document (§2.3), flattened for the fold.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    /// Document `$id` — tiebreak for equal `created_at`.
    #[serde(default)]
    pub id: String,
    /// The issue/PR this event targets.
    #[serde(default)]
    pub target_id: String,
    /// What happened.
    pub kind: EventKind,
    /// Document `$ownerId` — the actor whose authorization is checked as-of `created_at`.
    pub actor: String,
    /// Kind-dependent payload: label name, assignee id, or retarget base ref.
    #[serde(default)]
    pub value: Option<String>,
    /// Merge commit oid (kind `Merge` only).
    #[serde(default)]
    pub oid: Option<Oid>,
    /// Consensus `$createdAt` (ms).
    pub created_at: u64,
}

/// Resolved issue state after folding its `event` log.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueState {
    /// Open (default) vs closed.
    pub open: bool,
    /// Applied labels (sorted, deduplicated).
    pub labels: BTreeSet<String>,
    /// Assignees (sorted, deduplicated).
    pub assignees: BTreeSet<String>,
}

impl Default for IssueState {
    fn default() -> Self {
        Self {
            open: true,
            labels: BTreeSet::new(),
            assignees: BTreeSet::new(),
        }
    }
}

/// Resolved PR state after folding its `event` log.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrState {
    /// Open vs closed. Merging closes.
    pub open: bool,
    /// A valid `merge` event landed.
    pub merged: bool,
    /// Currently marked draft.
    pub draft: bool,
    /// Current base ref name (after any retargets), if any retarget/creation set one.
    pub base_ref: Option<String>,
    /// Applied labels.
    pub labels: BTreeSet<String>,
    /// Assignees.
    pub assignees: BTreeSet<String>,
}

impl Default for PrState {
    fn default() -> Self {
        Self {
            open: true,
            merged: false,
            draft: false,
            base_ref: None,
            labels: BTreeSet::new(),
            assignees: BTreeSet::new(),
        }
    }
}

/// Is event `e`'s actor authorized to apply it, evaluated as-of `e.created_at`?
///
/// Per the §4 enforcement matrix: any WRITE/MAINTAIN holder is authorized for every
/// kind; the target's author may additionally close/reopen their own issue/PR; a
/// `merge` additionally requires the merge `oid` to be reachable from the base tip
/// (an ancestor of it). Everything else from a non-holder is **inert** — the event
/// exists on-chain (the spammer paid fees) but the fold ignores it.
fn actor_authorized(
    e: &Event,
    target_author: &str,
    authz: &AuthzResolver,
    base_tip: Option<&str>,
    is_ancestor: &impl Fn(&str, &str) -> bool,
) -> bool {
    let holder = authz.holdings_as_of(&e.actor, e.created_at).any();
    match e.kind {
        EventKind::Close | EventKind::Reopen => holder || e.actor == target_author,
        EventKind::Merge => {
            if !holder {
                return false;
            }
            match (e.oid.as_deref(), base_tip) {
                (Some(oid), Some(tip)) => is_ancestor(oid, tip),
                // No merge oid or no base tip ⇒ cannot prove reachability ⇒ inert.
                _ => false,
            }
        }
        _ => holder,
    }
}

/// Fold an issue's `event` log into its [`IssueState`].
///
/// `events` may be unordered and may include spam from non-holders; they are ordered by
/// `(createdAt, id)` and each is applied only if [`actor_authorized`] passes as-of its
/// `createdAt`. Only close/reopen/label/assign kinds affect an issue; PR-only kinds
/// (merge/retarget/draft/ready) are ignored here.
#[must_use]
pub fn fold_issue_state(
    events: &[Event],
    target_author: &str,
    authz: &AuthzResolver,
) -> IssueState {
    let ordered = ordered_events(events);
    let mut state = IssueState::default();
    let no_ancestry = |_: &str, _: &str| false;

    for e in ordered {
        if !actor_authorized(e, target_author, authz, None, &no_ancestry) {
            continue;
        }
        match e.kind {
            EventKind::Close => state.open = false,
            EventKind::Reopen => state.open = true,
            EventKind::LabelAdd => {
                if let Some(v) = &e.value {
                    state.labels.insert(v.clone());
                }
            }
            EventKind::LabelRemove => {
                if let Some(v) = &e.value {
                    state.labels.remove(v);
                }
            }
            EventKind::Assign => {
                if let Some(v) = &e.value {
                    state.assignees.insert(v.clone());
                }
            }
            EventKind::Unassign => {
                if let Some(v) = &e.value {
                    state.assignees.remove(v);
                }
            }
            // PR-only kinds do not apply to issues.
            EventKind::Merge | EventKind::Retarget | EventKind::Draft | EventKind::Ready => {}
        }
    }
    state
}

/// Fold a PR's `event` log into its [`PrState`].
///
/// Like [`fold_issue_state`], plus: `merge` (holder + reachable `oid`) sets
/// `merged`+closed; `retarget` (holder) updates `base_ref`; `draft`/`ready` (holder)
/// toggle the draft flag. `base_tip` is the current tip of the PR's base ref, used for
/// merge reachability; `is_ancestor` is the commit-graph predicate.
#[must_use]
pub fn fold_pr_state(
    events: &[Event],
    target_author: &str,
    authz: &AuthzResolver,
    base_tip: Option<&str>,
    is_ancestor: impl Fn(&str, &str) -> bool,
) -> PrState {
    let ordered = ordered_events(events);
    let mut state = PrState::default();

    for e in ordered {
        if !actor_authorized(e, target_author, authz, base_tip, &is_ancestor) {
            continue;
        }
        match e.kind {
            EventKind::Close => state.open = false,
            EventKind::Reopen => {
                // A merged PR cannot be reopened; reopen only revives a plain close.
                if !state.merged {
                    state.open = true;
                }
            }
            EventKind::Merge => {
                state.merged = true;
                state.open = false;
            }
            EventKind::LabelAdd => {
                if let Some(v) = &e.value {
                    state.labels.insert(v.clone());
                }
            }
            EventKind::LabelRemove => {
                if let Some(v) = &e.value {
                    state.labels.remove(v);
                }
            }
            EventKind::Assign => {
                if let Some(v) = &e.value {
                    state.assignees.insert(v.clone());
                }
            }
            EventKind::Unassign => {
                if let Some(v) = &e.value {
                    state.assignees.remove(v);
                }
            }
            EventKind::Retarget => state.base_ref.clone_from(&e.value),
            EventKind::Draft => state.draft = true,
            EventKind::Ready => state.draft = false,
        }
    }
    state
}

/// Order events deterministically by `(createdAt, id)`.
fn ordered_events(events: &[Event]) -> Vec<&Event> {
    let mut v: Vec<&Event> = events.iter().collect();
    v.sort_by(|a, b| {
        a.created_at
            .cmp(&b.created_at)
            .then_with(|| a.id.cmp(&b.id))
    });
    v
}

// ===========================================================================
// Staleness overlay (flatIndex freshness)
// ===========================================================================

/// One row of a `flatIndex` browse artifact: a full recursive tree listing entry
/// (§2.3). `mode 160000` rows are gitlink/submodule entries.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlatIndexEntry {
    /// Repo-relative path.
    pub path: String,
    /// Object id at that path.
    pub oid: Oid,
    /// git file mode (e.g. `100644`, `100755`, `40000`, `160000`).
    pub mode: u32,
    /// Blob size in bytes (0 for trees/gitlinks).
    #[serde(default)]
    pub size: u64,
}

/// A `flatIndex` snapshot: the recursive tree at `tip`, path-sorted.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlatIndex {
    /// The commit whose tree this indexes.
    pub tip: Oid,
    /// Path-sorted entries.
    pub entries: Vec<FlatIndexEntry>,
}

/// A single path change within a commit's tree diff.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum PathChange {
    /// Path added or modified (an upsert — carries the new object).
    Upsert {
        /// Path affected.
        path: String,
        /// New object id.
        oid: Oid,
        /// New mode.
        mode: u32,
        /// New size.
        #[serde(default)]
        size: u64,
    },
    /// Path removed.
    Delete {
        /// Path removed.
        path: String,
    },
}

/// One commit's worth of tree changes, to be layered on a flatIndex in order.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeDiff {
    /// The commit these changes produce — becomes the overlaid tip once applied.
    pub commit: Oid,
    /// Path add/modify/delete changes introduced by this commit.
    #[serde(default)]
    pub changes: Vec<PathChange>,
}

/// Overlay the tree diffs of the ≤ 20 commits since a flatIndex's indexed tip on top of
/// it, yielding the current tree without re-downloading a fresh flatIndex.
///
/// This is the S0.5 cold-load correction: `flatIndex` is republished only every 20
/// default-branch pushes / 24 h, so a reader that finds the resolved ref ahead of
/// `base.tip` walks the intervening commits via the objectLocator and applies their
/// tree diffs here — never a full re-walk (§2.3 "Readers detect staleness ... and
/// overlay").
///
/// `later_commit_tree_diffs` must be **in commit order** (oldest first). Each `Upsert`
/// adds or replaces a path; each `Delete` removes one. The result is re-sorted by path
/// (flatIndex is path-sorted) and its `tip` is the last diff's commit (unchanged if the
/// slice is empty — the base was already current).
#[must_use]
pub fn overlay_tree(base: &FlatIndex, later_commit_tree_diffs: &[TreeDiff]) -> FlatIndex {
    use std::collections::BTreeMap;

    let mut tree: BTreeMap<String, FlatIndexEntry> = base
        .entries
        .iter()
        .map(|e| (e.path.clone(), e.clone()))
        .collect();

    let mut tip = base.tip.clone();
    for diff in later_commit_tree_diffs {
        for change in &diff.changes {
            match change {
                PathChange::Upsert {
                    path,
                    oid,
                    mode,
                    size,
                } => {
                    tree.insert(
                        path.clone(),
                        FlatIndexEntry {
                            path: path.clone(),
                            oid: oid.clone(),
                            mode: *mode,
                            size: *size,
                        },
                    );
                }
                PathChange::Delete { path } => {
                    tree.remove(path);
                }
            }
        }
        tip.clone_from(&diff.commit);
    }

    FlatIndex {
        tip,
        entries: tree.into_values().collect(),
    }
}

// ===========================================================================
// Conformance-vector runner
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::{
        fold_issue_state, fold_pr_state, holdings_as_of, matches_protected, overlay_tree,
        resolve_ref, Ancestry, AuthzResolver, ConfigDoc, Event, FlatIndex, Holdings, IssueState,
        PrState, RefState, RefUpdate, TokenRecord, TreeDiff,
    };
    use serde::Deserialize;
    use std::path::PathBuf;

    /// The parity contract: one file per scenario, dispatched by `case`.
    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Vector {
        name: String,
        #[allow(dead_code)]
        description: String,
        case: String,
        input: serde_json::Value,
        expected: serde_json::Value,
    }

    // --- per-case input envelopes -----------------------------------------

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ResolveRefInput {
        updates: Vec<RefUpdate>,
        #[serde(default)]
        config_history: Vec<ConfigDoc>,
        ref_name_hash: String,
        #[serde(default)]
        ancestry: Ancestry,
    }

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct MatchesProtectedInput {
        ref_name: String,
        patterns: Vec<String>,
    }

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct HoldingsInput {
        records: Vec<TokenRecord>,
        identity: String,
        at: u64,
    }

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct FoldIssueInput {
        events: Vec<Event>,
        target_author: String,
        #[serde(default)]
        token_records: Vec<TokenRecord>,
    }

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct FoldPrInput {
        events: Vec<Event>,
        target_author: String,
        #[serde(default)]
        token_records: Vec<TokenRecord>,
        #[serde(default)]
        base_tip: Option<String>,
        #[serde(default)]
        ancestry: Ancestry,
    }

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct OverlayInput {
        base: FlatIndex,
        #[serde(default)]
        diffs: Vec<TreeDiff>,
    }

    fn vectors_dir() -> PathBuf {
        // crates/forge-core/src/rules.rs -> repo root -> forge-contracts/vectors
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../forge-contracts/vectors")
            .canonicalize()
            .expect("vectors dir exists")
    }

    fn run_case(v: &Vector) {
        let ctx = &v.name;
        match v.case.as_str() {
            "resolve_ref" => {
                let inp: ResolveRefInput =
                    serde_json::from_value(v.input.clone()).expect("resolve_ref input");
                let got = resolve_ref(
                    &inp.updates,
                    &inp.config_history,
                    &inp.ref_name_hash,
                    |a, d| inp.ancestry.is_ancestor(a, d),
                );
                let want: RefState =
                    serde_json::from_value(v.expected.clone()).expect("resolve_ref expected");
                assert_eq!(got, want, "vector `{ctx}`");
            }
            "matches_protected" => {
                let inp: MatchesProtectedInput =
                    serde_json::from_value(v.input.clone()).expect("matches_protected input");
                let got = matches_protected(&inp.ref_name, &inp.patterns);
                let want: bool =
                    serde_json::from_value(v.expected.clone()).expect("matches_protected expected");
                assert_eq!(got, want, "vector `{ctx}`");
            }
            "holdings" => {
                let inp: HoldingsInput =
                    serde_json::from_value(v.input.clone()).expect("holdings input");
                let got = holdings_as_of(&inp.records, &inp.identity, inp.at);
                let want: Holdings =
                    serde_json::from_value(v.expected.clone()).expect("holdings expected");
                assert_eq!(got, want, "vector `{ctx}`");
            }
            "fold_issue" => {
                let inp: FoldIssueInput =
                    serde_json::from_value(v.input.clone()).expect("fold_issue input");
                let authz = AuthzResolver::new(inp.token_records);
                let got = fold_issue_state(&inp.events, &inp.target_author, &authz);
                let want: IssueState =
                    serde_json::from_value(v.expected.clone()).expect("fold_issue expected");
                assert_eq!(got, want, "vector `{ctx}`");
            }
            "fold_pr" => {
                let inp: FoldPrInput =
                    serde_json::from_value(v.input.clone()).expect("fold_pr input");
                let authz = AuthzResolver::new(inp.token_records);
                let got = fold_pr_state(
                    &inp.events,
                    &inp.target_author,
                    &authz,
                    inp.base_tip.as_deref(),
                    |a, d| inp.ancestry.is_ancestor(a, d),
                );
                let want: PrState =
                    serde_json::from_value(v.expected.clone()).expect("fold_pr expected");
                assert_eq!(got, want, "vector `{ctx}`");
            }
            "overlay" => {
                let inp: OverlayInput =
                    serde_json::from_value(v.input.clone()).expect("overlay input");
                let got = overlay_tree(&inp.base, &inp.diffs);
                let want: FlatIndex =
                    serde_json::from_value(v.expected.clone()).expect("overlay expected");
                assert_eq!(got, want, "vector `{ctx}`");
            }
            other => panic!("vector `{ctx}`: unknown case `{other}`"),
        }
    }

    /// Load every `forge-contracts/vectors/*.json` and assert the rules reproduce
    /// `expected`. This is the suite the TypeScript port also runs.
    #[test]
    fn conformance_vectors() {
        let dir = vectors_dir();
        let mut files: Vec<PathBuf> = std::fs::read_dir(&dir)
            .expect("read vectors dir")
            .map(|e| e.expect("dir entry").path())
            .filter(|p| p.extension().is_some_and(|x| x == "json"))
            .collect();
        files.sort();
        assert!(
            files.len() >= 20,
            "expected 20+ vectors, found {}",
            files.len()
        );

        let mut ran = 0usize;
        for path in files {
            let bytes = std::fs::read(&path).expect("read vector");
            let v: Vector = serde_json::from_slice(&bytes)
                .unwrap_or_else(|e| panic!("parse {}: {e}", path.display()));
            run_case(&v);
            ran += 1;
        }
        assert!(ran >= 20, "ran {ran} vectors, expected 20+");
        println!("conformance_vectors: {ran} vectors green");
    }

    // --- targeted unit tests for the pinned glob semantics ----------------

    #[test]
    fn protected_glob_semantics_are_pinned() {
        // `*` stays within a ref segment (does not cross `/`).
        assert!(matches_protected(
            "refs/heads/main",
            &["refs/heads/*".into()]
        ));
        assert!(matches_protected(
            "refs/heads/dev",
            &["refs/heads/*".into()]
        ));
        assert!(!matches_protected(
            "refs/heads/release/1.0",
            &["refs/heads/*".into()]
        ));
        // `**` crosses `/`.
        assert!(matches_protected(
            "refs/heads/release/1.0",
            &["refs/heads/**".into()]
        ));
        // One level of release branches.
        assert!(matches_protected(
            "refs/heads/release/1.0",
            &["refs/heads/release/*".into()]
        ));
        // Exact, and any-of.
        assert!(matches_protected(
            "refs/tags/v1.2.3",
            &["refs/heads/main".into(), "refs/tags/v*".into()]
        ));
        assert!(!matches_protected("refs/heads/main", &[]));
    }

    #[test]
    fn unborn_when_no_updates() {
        assert_eq!(
            resolve_ref(&[], &[], "deadbeef", |_, _| false),
            RefState::Unborn
        );
    }
}
