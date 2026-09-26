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
//! What that proves, precisely: every vector hands these functions a ready-made input
//! array, so the suite establishes that the two ports FOLD identically given identical
//! input. It does not establish that each client FETCHES identical input. A divergence in
//! the read layer — one client paging a history to exhaustion while the other stops at
//! Drive's 100-row default — yields two different answers from two green conformance runs.
//! That class of bug belongs to the readers (`repo.rs`, `collab.rs`) and their own tests.
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
//!
//! [`v2`] holds `FORGE_RULES_V2`, the rules for repositories on the shared forge-v2
//! contracts. It reuses this module's event order and per-kind effects; everything here stays
//! the v1 rule set, so v1 repositories remain readable.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

pub mod v2;

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
/// fields resolution needs. Callers fetch these (via the §2.3 keyset scan, `crate::refs`, + §3
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
    /// Document `$id` of the update that set this tip — carried so that heads sharing a
    /// `$createdAt` (two maintainers racing in the same consensus block) order
    /// deterministically by the same `($createdAt, $id)` total order used everywhere
    /// else in the module. Without it, `heads[0]` (the provisional tip shown to users)
    /// could differ between clients — exactly the parity bug this module prevents.
    pub id: String,
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

/// The tip a ref points at: its resolved oid, a diverged ref's provisional tip
/// (`heads[0]`), or `None` when unborn.
pub fn tip_of(state: &RefState) -> Option<String> {
    match state {
        RefState::Resolved { oid, .. } => Some(oid.clone()),
        RefState::Diverged { heads } => heads.first().map(|h| h.oid.clone()),
        RefState::Unborn => None,
    }
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
        // A direct prevOid chain — `v` recorded `u`'s tip as its `prevOid` — is an
        // *unambiguous causal* "v came after u": whoever authored v had u's tip in hand.
        // This ordering is independent of the `($createdAt, $id)` clock, which matters
        // because Platform only records `$createdAt` when the document type requires the
        // timestamp; where it is absent (0), the clock degrades to arbitrary document-id
        // order and could otherwise let a superseded tip out-rank the update that
        // fast-forwarded off it. The chain is acyclic (v.prevOid==u.newOid and
        // u.prevOid==v.newOid would require each tip to be the other's parent), so hoisting
        // it out of the `v_newer` gate cannot create a supersession cycle. When `$createdAt`
        // *is* present, a chain child always sorts at-or-after its parent, so this changes
        // nothing — it only repairs the degenerate all-equal-timestamp case.
        if !is_null_oid(&v.prev_oid) && v.prev_oid == u.new_oid && v.new_oid != u.new_oid {
            return true;
        }
        // Conversely, if `u` chained off `v` (`u.prevOid == v.newOid`), then `u` is a causal
        // *descendant* of `v` — so `v` must NEVER supersede `u`, not even a force/delete `v`.
        // Without this, the unreliable `($createdAt, $id)` clock can mis-rank an older force
        // push as "newer" than the fast-forward that later built on it, letting a superseded
        // tip clobber its own descendant. Combined with the chain rule above, this makes the
        // prevOid DAG authoritative for causal order (the clock only breaks ties between
        // genuinely unrelated — diverged — updates). The two chain guards can't both fire for
        // one `(u, v)` (that needs a 2-cycle of tips), so there is no contradiction.
        if !is_null_oid(&u.prev_oid) && u.prev_oid == v.new_oid && u.new_oid != v.new_oid {
            return false;
        }

        // The remaining conditions (delete/force/ancestry) do not carry their own causal
        // proof, so they stay gated on `v` being strictly newer by `($createdAt, $id)` —
        // this asymmetry is what stops two competing force pushes from cancelling to Unborn.
        let v_newer = (v.created_at, &v.id) > (u.created_at, &u.id);
        if !v_newer {
            return false;
        }
        if is_null_oid(&v.new_oid) || v.force {
            return true;
        }
        is_ancestor(&u.new_oid, &v.new_oid)
    };

    let mut heads: Vec<RefHead> = Vec::new();
    for u in &valid {
        if is_null_oid(&u.new_oid) {
            continue;
        }
        if valid.iter().any(|v| newer_supersedes(u, v)) {
            continue;
        }
        let candidate = RefHead {
            id: u.id.clone(),
            oid: u.new_oid.clone(),
            author: u.author.clone(),
            created_at: u.created_at,
        };
        // Deduplicate by tip: the same oid pushed more than once is one head, and we
        // keep the newest occurrence by the `($createdAt, $id)` total order. `valid` is
        // sorted ascending, so a later match is always the newer one.
        if let Some(existing) = heads.iter_mut().find(|h| h.oid == candidate.oid) {
            if (candidate.created_at, &candidate.id) > (existing.created_at, &existing.id) {
                *existing = candidate;
            }
        } else {
            heads.push(candidate);
        }
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
            // Newest-first by the `($createdAt, $id)` total order: `heads[0]` is the
            // provisional read-only tip (§2.3), and two heads racing in the same
            // consensus block break ties on `$id` so every client agrees.
            heads.sort_by(|a, b| {
                b.created_at
                    .cmp(&a.created_at)
                    .then_with(|| b.id.cmp(&a.id))
            });
            RefState::Diverged { heads }
        }
    }
}

/// Whether a ref name is legal to advertise on the git wire protocol.
///
/// `refName` is stored as an arbitrary Platform string (≤255 chars) and never passed
/// `git check-ref-format`, so a hostile WRITE holder could store a name containing a
/// newline (`refs/heads/x\n<oid> refs/heads/main`) to **inject a spoofed
/// ref-advertisement line** into every clone/fetch, or a NUL/space to corrupt parsing.
/// The security-critical rule (shared by the write guard, the fold side, and the helper
/// emission): non-empty, no leading `-` (would read as a git option), and no ASCII
/// whitespace or control byte (`b <= 0x20`, covering space/tab/newline/NUL, plus DEL).
#[must_use]
pub fn is_legal_ref_name(name: &str) -> bool {
    !name.is_empty() && !name.starts_with('-') && !name.bytes().any(|b| b <= 0x20 || b == 0x7f)
}

/// Whether `h` is a real 32-byte content hash rendered as 64 lowercase-or-upper hex chars
/// (as every live `refNameHash` is — a `bytes32` field). Symbolic test keys (short
/// non-hex strings) are not, so the fold-side preimage check below only binds real data.
fn is_content_hash(h: &str) -> bool {
    h.len() == 64 && h.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Whether `refNameHash` is exactly `sha256(refName)` — the normative invariant binding
/// the indexed key to the name it claims to hash.
///
/// Public because callers that only want to *display* a ref must apply the same predicate
/// the fold does. `refName` is caller-supplied content and only `refNameHash` is indexed, so
/// a token holder can post an update carrying a name that does not hash to the key it is
/// filed under. `resolve_ref` already ignores such an update, and any client naming a ref
/// from one would show a different branch name for the same ref than a client that does not.
pub fn ref_name_hash_matches(ref_name: &str, ref_name_hash: &str) -> bool {
    use sha2::{Digest as _, Sha256};
    let mut h = Sha256::new();
    h.update(ref_name.as_bytes());
    hex::encode(h.finalize()).eq_ignore_ascii_case(ref_name_hash)
}

/// A review verdict, as recorded on-chain.
///
/// The integer codes are the wire form (`review.verdict`); they match `dg`'s
/// `--verdict` flag. An unrecognized code reads as [`Verdict::Unknown`] rather than being
/// dropped, so a document written by a newer client is still shown rather than silently
/// omitted from a PR's history.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    /// Approve (1).
    Approve,
    /// Request changes (2).
    RequestChanges,
    /// Comment only, no verdict (3).
    Comment,
    /// A code this client does not know.
    Unknown(u64),
}

impl Verdict {
    /// Decode the on-chain integer.
    pub fn from_code(code: u64) -> Self {
        match code {
            1 => Self::Approve,
            2 => Self::RequestChanges,
            3 => Self::Comment,
            other => Self::Unknown(other),
        }
    }

    /// The on-chain integer.
    pub fn code(self) -> u64 {
        match self {
            Self::Approve => 1,
            Self::RequestChanges => 2,
            Self::Comment => 3,
            Self::Unknown(c) => c,
        }
    }

    /// A short label for display.
    pub fn label(self) -> &'static str {
        match self {
            Self::Approve => "approved",
            Self::RequestChanges => "changes requested",
            Self::Comment => "commented",
            Self::Unknown(_) => "unknown verdict",
        }
    }
}

/// The name to DISPLAY for the ref keyed by `ref_name_hash`: the `refName` of the newest
/// update (on the `(created_at, id)` total order) whose name actually hashes to that key.
///
/// This is a shared rule, not a reader convenience, because the two halves of the ref
/// document are trusted differently: `refNameHash` is the indexed key, while `refName` is
/// caller-supplied content. A token holder may therefore file an update under `main`'s hash
/// carrying any legal name. [`resolve_ref`] already ignores such an update when resolving the
/// tip, so a client that named the ref from it would show a different branch name for the
/// same ref than a client that did not — and `git ls-remote` would advertise the tip under a
/// name that no longer matches the `HEAD` symref.
///
/// `None` when no update carries a name matching the key (nothing safe to display).
pub fn display_ref_name<'a>(updates: &'a [RefUpdate], ref_name_hash: &str) -> Option<&'a str> {
    updates
        .iter()
        .filter(|u| {
            u.ref_name_hash == ref_name_hash && ref_name_hash_matches(&u.ref_name, ref_name_hash)
        })
        .max_by(|a, b| {
            a.created_at
                .cmp(&b.created_at)
                .then_with(|| a.id.cmp(&b.id))
        })
        .map(|u| u.ref_name.as_str())
}

/// The as-of-time protection check from §4: is update `u` a valid mover of its ref? A legal
/// `refName` that hashes to its `refNameHash`, and — when the config in force at its
/// `$createdAt` protects the ref — a `protectedRefUpdate`. Public so that anything reporting a
/// single update (the relay's `push` webhook) applies the fold's own rule.
pub fn is_update_valid(u: &RefUpdate, config_history: &[ConfigDoc]) -> bool {
    // (0) Injection / key-decoupling defense (fold-side enforcement of the normative
    // invariant, defense-in-depth with the write guard): an illegal `refName` is inert,
    // and — when a real 32-byte `refNameHash` is present — it MUST be `sha256(refName)`.
    // A hostile alt-client that bypasses the write-side check by decoupling the indexed
    // key from the advertised name is thereby made inert on read/fold too. (Symbolic
    // conformance-vector keys are not content hashes, so they skip the preimage bind.)
    if !is_legal_ref_name(&u.ref_name) {
        return false;
    }
    if is_content_hash(&u.ref_name_hash) && !ref_name_hash_matches(&u.ref_name, &u.ref_name_hash) {
        return false;
    }

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
/// Matching is git **`wildmatch`** with the `WM_PATHNAME` flag — the same behavior
/// `git for-each-ref <pattern>` uses. Precisely:
///
/// * `*` matches any run of characters **except** `/` (stays within one ref segment).
/// * `**` matches across `/` (any number of segments), e.g. `refs/heads/**` is "every
///   branch at any depth".
/// * `?` matches a single non-`/` character.
/// * `[abc]` / `[a-z]` / `[!abc]` character classes are supported.
/// * `\x` escapes `x` to a literal.
/// * **Every other character, including `{`, `}`, `,`, and a leading `!`, is a
///   literal.** git `wildmatch` has neither `{a,b}` brace alternation nor leading-`!`
///   negation.
///
/// So `refs/heads/*` protects `refs/heads/main` and `refs/heads/dev` but **not**
/// `refs/heads/release/1.0`; use `refs/heads/release/*` for one release level or
/// `refs/heads/**` for every branch including nested ones.
///
/// ### Implementation note — neutralizing the backing crate's extensions
///
/// The engine is the [`glob_match`](glob_match::glob_match) crate, whose `*`/`**`/`?`/
/// `[]`/`\` handling matches git `wildmatch`, **but which additionally implements
/// `{a,b}` alternation and leading-`!` negation that git `wildmatch` does not have**.
/// Left unchecked those are parity-critical: a `protectedPatterns` entry like
/// `!refs/heads/temp/*` would *invert* the protection set (match everything else), and
/// `refs/heads/{main,dev}` would silently alternate. [`neutralize_wildmatch`] escapes a
/// leading run of `!` and every `{`/`}` before matching, so both are treated as the
/// literals git `wildmatch` would use. Ported clients must apply the identical
/// neutralization (or a true `wildmatch`).
///
/// This standardizes away from the original skeleton's `*`-matches-`/` (POSIX `fnmatch`
/// without `FNM_PATHNAME`) semantics — flagged for doc reconciliation.
#[must_use]
pub fn matches_protected(ref_name: &str, patterns: &[String]) -> bool {
    patterns
        .iter()
        .any(|p| glob_match::glob_match(&neutralize_wildmatch(p), ref_name))
}

/// Escape the two constructs the backing glob crate supports but git `wildmatch` does
/// not — a leading run of `!` (negation) and every `{`/`}` (brace alternation) — so
/// they are matched as literals. Preserves UTF-8 (ref names are UTF-8, data-contracts
/// §0) and leaves `*`/`**`/`?`/`[]`/existing `\` escapes untouched.
fn neutralize_wildmatch(pattern: &str) -> String {
    let mut out = String::with_capacity(pattern.len() + 4);
    let mut chars = pattern.chars().peekable();
    // A leading run of `!` toggles negation in the crate; git wildmatch treats each as
    // a literal.
    while chars.peek() == Some(&'!') {
        chars.next();
        out.push('\\');
        out.push('!');
    }
    for c in chars {
        if c == '{' || c == '}' {
            out.push('\\');
        }
        out.push(c);
    }
    out
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
///
/// This is the v1 rule only. forge-v2 splits events by gate (`event` for members,
/// `authorEvent` for the target's author, close/reopen only), so its fold
/// ([`v2::fold_issue_state_v2`], [`v2::fold_pr_state_v2`]) needs no actor check.
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
        EventKind::Merge => holder && merge_reachable(e, base_tip, is_ancestor),
        _ => holder,
    }
}

/// Whether a `merge` event's `oid` is reachable from (an ancestor of, or equal to) the base
/// tip. No merge oid or no base tip means reachability cannot be proven, so the merge is inert.
/// Shared by both rule versions.
fn merge_reachable(
    e: &Event,
    base_tip: Option<&str>,
    is_ancestor: &impl Fn(&str, &str) -> bool,
) -> bool {
    match (e.oid.as_deref(), base_tip) {
        (Some(oid), Some(tip)) => is_ancestor(oid, tip),
        _ => false,
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
        if actor_authorized(e, target_author, authz, None, &no_ancestry) {
            apply_issue_event(&mut state, e);
        }
    }
    state
}

/// Apply one authorized event to an issue's state (both rule versions). PR-only kinds
/// (merge/retarget/draft/ready) do not apply to issues.
fn apply_issue_event(state: &mut IssueState, e: &Event) {
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
        EventKind::Merge | EventKind::Retarget | EventKind::Draft | EventKind::Ready => {}
    }
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
        if actor_authorized(e, target_author, authz, base_tip, &is_ancestor) {
            apply_pr_event(&mut state, e);
        }
    }
    state
}

/// Apply one authorized event to a PR's state (both rule versions).
fn apply_pr_event(state: &mut PrState, e: &Event) {
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
        EventKind::Retarget => {
            // Defense-in-depth (mirrors `resolve_ref`'s `is_legal_ref_name` gate): a
            // retarget's `value` is a base ref name; an illegal one (newline/NUL/leading
            // dash) could spoof a ref-advertisement line when rendered, so it is inert.
            if let Some(v) = &e.value {
                if is_legal_ref_name(v) {
                    state.base_ref = Some(v.clone());
                }
            }
        }
        EventKind::Draft => state.draft = true,
        EventKind::Ready => state.draft = false,
    }
}

/// Order events deterministically by `(createdAt, id)`.
fn ordered_events(events: &[Event]) -> Vec<&Event> {
    let mut v: Vec<&Event> = events.iter().collect();
    v.sort_by(|a, b| event_order(a, b));
    v
}

/// The `(createdAt, id)` total order every fold applies events in.
fn event_order(a: &Event, b: &Event) -> std::cmp::Ordering {
    a.created_at
        .cmp(&b.created_at)
        .then_with(|| a.id.cmp(&b.id))
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
        display_ref_name, fold_issue_state, fold_pr_state, holdings_as_of, is_legal_ref_name,
        matches_protected, overlay_tree, resolve_ref, v2, Ancestry, AuthzResolver, ConfigDoc,
        Event, EventKind, FlatIndex, Holdings, IssueState, PrState, RefState, RefUpdate, TokenKind,
        TokenOp, TokenRecord, TreeDiff, Verdict,
    };
    use serde::{Deserialize, Serialize};
    use std::path::PathBuf;

    /// A minted-at-genesis WRITE holder record (the common authz fixture).
    fn write_mint(identity: &str) -> TokenRecord {
        TokenRecord {
            id: format!("mint-{identity}"),
            identity: identity.into(),
            token: TokenKind::Write,
            op: TokenOp::Mint,
            created_at: 0,
        }
    }

    /// A merge event by `actor` on `target` with merge commit `oid`.
    fn merge_event(actor: &str, target: &str, oid: &str, created_at: u64) -> Event {
        Event {
            id: format!("merge-{oid}"),
            target_id: target.into(),
            kind: EventKind::Merge,
            actor: actor.into(),
            value: None,
            oid: Some(oid.into()),
            created_at,
        }
    }

    /// BLOCKER-1 regression: a merge whose oid was ever a base tip must stay `merged` once
    /// the base ref advances past it. The service supplies a monotonic historical-tips
    /// membership predicate; the old reflexive `|a,b| a==b` stand-in wrongly flipped it back
    /// to open the instant `base_tip != merge_oid`.
    #[test]
    fn pr_merge_stays_merged_after_base_advances() {
        let holder = "maint1";
        let authz = AuthzResolver::new(vec![write_mint(holder)]);
        let events = vec![merge_event(holder, "pr1", "M", 10)];

        // The merge oid `M` and a later base commit `T` are both historical base tips.
        let historical: std::collections::BTreeSet<String> =
            ["M".to_string(), "T".to_string()].into_iter().collect();

        // Base has advanced to `T` (T != M). Monotonic predicate keeps the PR merged.
        let good = fold_pr_state(&events, "author1", &authz, Some("T"), |oid, _tip| {
            historical.contains(oid)
        });
        assert!(good.merged, "merge stays merged after base advances");
        assert!(!good.open, "a merged PR is closed");

        // The buggy reflexive stand-in rejects the merge once base_tip != merge_oid.
        let bad = fold_pr_state(&events, "author1", &authz, Some("T"), |a, b| a == b);
        assert!(
            !bad.merged,
            "reflexive a==b wrongly un-merges once the base advances (the fixed bug)"
        );
    }

    /// MAJOR-4 defense-in-depth: an illegal `Retarget` base ref name (injection shape) is
    /// inert in the fold and never overwrites the live base ref.
    #[test]
    fn fold_pr_illegal_retarget_is_inert() {
        let holder = "m1";
        let authz = AuthzResolver::new(vec![write_mint(holder)]);
        let legal = Event {
            id: "e1".into(),
            target_id: "pr".into(),
            kind: EventKind::Retarget,
            actor: holder.into(),
            value: Some("refs/heads/dev".into()),
            oid: None,
            created_at: 5,
        };
        let illegal = Event {
            id: "e2".into(),
            target_id: "pr".into(),
            kind: EventKind::Retarget,
            actor: holder.into(),
            value: Some("refs/heads/x\n0000 refs/heads/main".into()),
            oid: None,
            created_at: 10,
        };
        let s1 = fold_pr_state(std::slice::from_ref(&legal), "a", &authz, None, |_, _| {
            false
        });
        assert_eq!(s1.base_ref.as_deref(), Some("refs/heads/dev"));
        // The newer illegal retarget must NOT overwrite with the injection payload.
        let s2 = fold_pr_state(&[legal, illegal], "a", &authz, None, |_, _| false);
        assert_eq!(
            s2.base_ref.as_deref(),
            Some("refs/heads/dev"),
            "illegal retarget value is inert"
        );
    }

    /// MAJOR-3 support: `holdings_as_of` must observe a freeze applied to the repo OWNER —
    /// the service now fetches the owner's freeze history unconditionally, so a frozen owner
    /// reads as un-spendable as-of the freeze (not perpetually unfrozen).
    #[test]
    fn holdings_observes_owner_freeze() {
        let owner = "owner1";
        let records = vec![
            write_mint(owner),
            TokenRecord {
                id: "freeze".into(),
                identity: owner.into(),
                token: TokenKind::Write,
                op: TokenOp::Freeze,
                created_at: 100,
            },
        ];
        assert!(
            holdings_as_of(&records, owner, 50).write,
            "owner is spendable before the freeze"
        );
        assert!(
            !holdings_as_of(&records, owner, 150).write,
            "owner is NOT spendable after the freeze (must be observed)"
        );
    }

    /// The parity contract: one file per scenario, dispatched by `case`.
    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Vector {
        name: String,
        #[allow(dead_code)]
        description: String,
        case: String,
        /// `"v1"` or `"v2"`; absent means v1 (every vector written before v2).
        #[serde(default)]
        rules: Option<String>,
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

    #[derive(Deserialize)]
    struct VerdictInput {
        code: u64,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct DisplayRefNameInput {
        updates: Vec<RefUpdate>,
        ref_name_hash: String,
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
            "verdict_label" => {
                let inp: VerdictInput =
                    serde_json::from_value(v.input.clone()).expect("verdict_label input");
                let verdict = Verdict::from_code(inp.code);
                let got = serde_json::json!({ "label": verdict.label(), "code": verdict.code() });
                assert_eq!(got, v.expected, "vector `{ctx}`");
            }
            "display_ref_name" => {
                let inp: DisplayRefNameInput =
                    serde_json::from_value(v.input.clone()).expect("display_ref_name input");
                let got = display_ref_name(&inp.updates, &inp.ref_name_hash);
                let want: Option<String> =
                    serde_json::from_value(v.expected.clone()).expect("display_ref_name expected");
                assert_eq!(got.map(str::to_owned), want, "vector `{ctx}`");
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

    // --- FORGE_RULES_V2 input envelopes. Unknown keys are refused at every depth (see
    // `input`), so a vector cannot carry a field, such as v1's `tokenRecords` or a misspelt
    // `authorEvent` key, that the v2 rules would silently ignore -----------------------------

    #[derive(Debug, Deserialize, Serialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct FoldIssueV2Input {
        #[serde(default)]
        events: Vec<Event>,
        #[serde(default)]
        author_events: Vec<Event>,
        target_author: String,
    }

    #[derive(Debug, Deserialize, Serialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct FoldPrV2Input {
        #[serde(default)]
        events: Vec<Event>,
        #[serde(default)]
        author_events: Vec<Event>,
        target_author: String,
        #[serde(default)]
        base_tip: Option<String>,
        #[serde(default)]
        ancestry: Ancestry,
    }

    #[derive(Debug, Deserialize, Serialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct AllocateNumberInput {
        count: u64,
        taken_numbers_desc: Vec<u32>,
    }

    #[derive(Debug, Deserialize, Serialize)]
    #[serde(deny_unknown_fields)]
    struct PackCopiesInput {
        copies: Vec<v2::PackCopy>,
    }

    #[derive(Debug, Deserialize, Serialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct V2PackListInput {
        copies: Vec<v2::PackCopyRow>,
        #[serde(default)]
        as_of: Option<v2::CopyKey>,
    }

    #[derive(Debug, Deserialize, Serialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct ApprovalsInput {
        reviews: Vec<v2::Review>,
        memberships: Vec<v2::Membership>,
        head_oid: String,
    }

    #[derive(Debug, Deserialize, Serialize)]
    #[serde(deny_unknown_fields)]
    struct WellFormedInput {
        doc: v2::ContentDoc,
        visibility: v2::Visibility,
    }

    #[derive(Debug, Deserialize, Serialize)]
    #[serde(deny_unknown_fields)]
    struct RepoNameInput {
        name: String,
    }

    #[derive(Debug, Deserialize, Serialize)]
    #[serde(deny_unknown_fields)]
    struct RoleQuery {
        identity: String,
        at: u64,
    }

    #[derive(Debug, Deserialize, Serialize)]
    #[serde(deny_unknown_fields)]
    struct RoleOracleInput {
        memberships: Vec<v2::Membership>,
        queries: Vec<RoleQuery>,
    }

    /// Every key of `given` (the vector's JSON) must survive a parse + re-serialize into
    /// `parsed`, at every depth. A key the rule types do not have would be dropped by serde's
    /// default (ignore unknown fields) on the nested public types, so a typo there would
    /// otherwise pass silently.
    fn assert_no_unknown_keys(given: &serde_json::Value, parsed: &serde_json::Value, at: &str) {
        match (given, parsed) {
            (serde_json::Value::Object(g), serde_json::Value::Object(p)) => {
                for (k, gv) in g {
                    let pv = p
                        .get(k)
                        .unwrap_or_else(|| panic!("unknown input key `{at}.{k}`"));
                    assert_no_unknown_keys(gv, pv, &format!("{at}.{k}"));
                }
            }
            (serde_json::Value::Array(g), serde_json::Value::Array(p)) => {
                for (i, (gv, pv)) in g.iter().zip(p).enumerate() {
                    assert_no_unknown_keys(gv, pv, &format!("{at}[{i}]"));
                }
            }
            _ => {}
        }
    }

    fn input<T: serde::de::DeserializeOwned + Serialize>(v: &Vector) -> T {
        let parsed: T = serde_json::from_value(v.input.clone())
            .unwrap_or_else(|e| panic!("vector `{}`: {} input: {e}", v.name, v.case));
        let again = serde_json::to_value(&parsed).expect("re-serialize input");
        assert_no_unknown_keys(&v.input, &again, &format!("{} input", v.name));
        parsed
    }

    fn expected<T: serde::de::DeserializeOwned>(v: &Vector) -> T {
        serde_json::from_value(v.expected.clone())
            .unwrap_or_else(|e| panic!("vector `{}`: {} expected: {e}", v.name, v.case))
    }

    fn run_case_v2(v: &Vector) {
        let ctx = &v.name;
        match v.case.as_str() {
            "fold_issue" => {
                let inp: FoldIssueV2Input = input(v);
                let got =
                    v2::fold_issue_state_v2(&inp.events, &inp.author_events, &inp.target_author);
                assert_eq!(got, expected::<IssueState>(v), "vector `{ctx}`");
            }
            "fold_pr" => {
                let inp: FoldPrV2Input = input(v);
                let got = v2::fold_pr_state_v2(
                    &inp.events,
                    &inp.author_events,
                    &inp.target_author,
                    inp.base_tip.as_deref(),
                    |a, d| inp.ancestry.is_ancestor(a, d),
                );
                assert_eq!(got, expected::<PrState>(v), "vector `{ctx}`");
            }
            "allocate_number" => {
                let inp: AllocateNumberInput = input(v);
                let got = v2::allocate_number(inp.count, &inp.taken_numbers_desc);
                assert_eq!(got, expected::<Option<u32>>(v), "vector `{ctx}`");
            }
            "pack_copies" => {
                // `expected` names any non-empty subset of the three results; each named is checked
                let inp: PackCopiesInput = input(v);
                let want = v
                    .expected
                    .as_object()
                    .expect("pack_copies expected is an object");
                assert!(
                    !want.is_empty()
                        && want
                            .keys()
                            .all(|k| ["order", "selected", "readOrder"].contains(&k.as_str())),
                    "vector `{ctx}`: expected must name some of order / selected / readOrder"
                );
                if let Some(order) = want.get("order") {
                    let got: Vec<&str> = v2::order_pack_copies(&inp.copies)
                        .into_iter()
                        .map(|c| c.id.as_str())
                        .collect();
                    assert_eq!(serde_json::json!(got), *order, "vector `{ctx}` order");
                }
                if let Some(selected) = want.get("selected") {
                    let got = v2::select_pack_copy(&inp.copies).map(|c| c.id.as_str());
                    assert_eq!(serde_json::json!(got), *selected, "vector `{ctx}` selected");
                }
                if let Some(read_order) = want.get("readOrder") {
                    let got = v2::pack_read_order(&inp.copies);
                    assert_eq!(
                        serde_json::json!(got),
                        *read_order,
                        "vector `{ctx}` readOrder"
                    );
                }
            }
            "v2_pack_list" => {
                let inp: V2PackListInput = input(v);
                let got = v2::v2_pack_list(&inp.copies, inp.as_of.as_ref());
                assert_eq!(got, expected::<Vec<v2::V2Pack>>(v), "vector `{ctx}`");
            }
            "approvals" => {
                let inp: ApprovalsInput = input(v);
                let oracle = v2::RoleOracle::new(inp.memberships);
                let got = v2::count_approvals(&inp.reviews, &oracle, &inp.head_oid);
                assert_eq!(got, expected::<v2::Approvals>(v), "vector `{ctx}`");
            }
            "well_formed" => {
                let inp: WellFormedInput = input(v);
                let got = v2::is_well_formed(&inp.doc, inp.visibility);
                assert_eq!(got, expected::<bool>(v), "vector `{ctx}`");
            }
            "repo_name" => {
                let inp: RepoNameInput = input(v);
                let got = serde_json::json!({
                    "valid": v2::is_valid_repo_name(&inp.name),
                    "normalized": v2::normalize_repo_name(&inp.name),
                });
                assert_eq!(got, v.expected, "vector `{ctx}`");
            }
            "role_oracle" => {
                let inp: RoleOracleInput = input(v);
                let oracle = v2::RoleOracle::new(inp.memberships);
                let got: Vec<serde_json::Value> = inp
                    .queries
                    .iter()
                    .map(|q| {
                        serde_json::json!({
                            "roleAt": oracle.role_at(&q.identity, q.at),
                            "memberAt": oracle.member_at(&q.identity, q.at),
                            "currentRole": oracle.current_role(&q.identity),
                        })
                    })
                    .collect();
                assert_eq!(serde_json::Value::from(got), v.expected, "vector `{ctx}`");
            }
            other => panic!("vector `{ctx}`: unknown v2 case `{other}`"),
        }
    }

    /// Load every `forge-contracts/vectors/*.json` and assert the rules reproduce
    /// `expected`, dispatching on the vector's `rules` (absent means v1). This is the suite the
    /// TypeScript port also runs.
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

        let (mut ran_v1, mut ran_v2) = (0usize, 0usize);
        for path in files {
            let bytes = std::fs::read(&path).expect("read vector");
            let v: Vector = serde_json::from_slice(&bytes)
                .unwrap_or_else(|e| panic!("parse {}: {e}", path.display()));
            match v.rules.as_deref() {
                None | Some("v1") => {
                    run_case(&v);
                    ran_v1 += 1;
                }
                Some("v2") => {
                    run_case_v2(&v);
                    ran_v2 += 1;
                }
                Some(other) => panic!("vector `{}`: unknown rules `{other}`", v.name),
            }
        }
        assert!(ran_v1 >= 70, "ran {ran_v1} v1 vectors, expected 70+");
        assert!(ran_v2 >= 110, "ran {ran_v2} v2 vectors, expected 110+");
        println!("conformance_vectors: {ran_v1} v1 + {ran_v2} v2 vectors green");
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

        // A leading `!` is a LITERAL, not negation: it must not invert the set.
        assert!(!matches_protected(
            "refs/heads/main",
            &["!refs/heads/temp/*".into()]
        ));
        assert!(matches_protected(
            "!refs/heads/temp/x",
            &["!refs/heads/temp/*".into()]
        ));
        // Braces are LITERAL, not alternation.
        assert!(!matches_protected(
            "refs/heads/main",
            &["refs/heads/{main,dev}".into()]
        ));
        assert!(matches_protected(
            "refs/heads/{main,dev}",
            &["refs/heads/{main,dev}".into()]
        ));
    }

    #[test]
    fn unborn_when_no_updates() {
        assert_eq!(
            resolve_ref(&[], &[], "deadbeef", |_, _| false),
            RefState::Unborn
        );
    }

    // --- injection / key-decoupling defense (MAJOR 2 conformance) ----------

    fn sha256_hex(s: &str) -> String {
        use sha2::{Digest as _, Sha256};
        let mut h = Sha256::new();
        h.update(s.as_bytes());
        hex::encode(h.finalize())
    }

    fn ref_update(ref_name: &str, ref_name_hash: &str, new_oid: &str) -> RefUpdate {
        RefUpdate {
            id: "d1".into(),
            ref_name_hash: ref_name_hash.into(),
            ref_name: ref_name.into(),
            prev_oid: String::new(),
            new_oid: new_oid.into(),
            force: false,
            protected: false,
            author: "author1".into(),
            created_at: 100,
        }
    }

    #[test]
    fn is_legal_ref_name_rejects_injection_shapes() {
        assert!(is_legal_ref_name("refs/heads/main"));
        assert!(is_legal_ref_name("refs/tags/v1.0"));
        // Newline injection (spoof a ref-advertisement / HEAD line): inert.
        assert!(!is_legal_ref_name("refs/heads/x\n0000 refs/heads/main"));
        assert!(!is_legal_ref_name("refs/heads/x\t")); // tab
        assert!(!is_legal_ref_name("refs/heads/ x")); // space
        assert!(!is_legal_ref_name("refs/heads/x\0y")); // NUL
        assert!(!is_legal_ref_name("-oops")); // leading dash → git option
        assert!(!is_legal_ref_name("")); // empty
    }

    #[test]
    fn illegal_ref_name_is_inert_in_resolve() {
        let name = "refs/heads/x\n1111111111111111111111111111111111111111 refs/heads/main";
        let hash = sha256_hex(name);
        let u = ref_update(name, &hash, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        // Even with a *correct* preimage hash, an illegal name never becomes a live head.
        assert_eq!(
            resolve_ref(&[u], &[], &hash, |_, _| false),
            RefState::Unborn
        );
    }

    #[test]
    fn ref_name_hash_preimage_mismatch_is_inert() {
        // A 64-hex (real) refNameHash that is NOT sha256(refName): a decoupled key/name
        // forged by an alt-client bypassing the write guard. Inert on the fold side.
        let wrong_hash = sha256_hex("refs/heads/victim"); // hash of a DIFFERENT name
        let u = ref_update(
            "refs/heads/attacker",
            &wrong_hash,
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        );
        assert_eq!(
            resolve_ref(&[u], &[], &wrong_hash, |_, _| false),
            RefState::Unborn
        );
    }

    #[test]
    fn chained_force_in_middle_resolves_to_chain_tip_with_zero_timestamps() {
        // Regression: all `$createdAt` == 0 (the deployed refUpdate type doesn't record the
        // timestamp), history is A -> B(force) -> C via prevOid chains, and B's document id
        // happens to sort *after* C's. The prevOid DAG must win: the head is C, never Unborn.
        let hash = sha256_hex("refs/heads/main");
        let a = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let b = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        let c = "cccccccccccccccccccccccccccccccccccccccc";
        let mk = |id: &str, new: &str, prev: &str, force: bool| RefUpdate {
            id: id.into(),
            ref_name_hash: hash.clone(),
            ref_name: "refs/heads/main".into(),
            prev_oid: prev.into(),
            new_oid: new.into(),
            force,
            protected: false,
            author: "auth".into(),
            created_at: 0, // the degenerate case
        };
        // Document ids deliberately ordered so the middle force (B) sorts newest by id.
        let ua = mk("id_A", a, "", false);
        let ub = mk("id_Z_force", b, a, true); // force, id sorts last
        let uc = mk("id_M", c, b, false);
        let got = resolve_ref(&[ua, ub, uc], &[], &hash, |x, y| x == y);
        assert_eq!(
            got,
            RefState::Resolved {
                oid: c.into(),
                author: "auth".into(),
                created_at: 0,
            },
            "chain tip C must win despite the middle force sorting newest by id"
        );
    }

    #[test]
    fn ref_name_hash_matching_preimage_resolves() {
        // The honest case: refNameHash == sha256(refName) → the update is valid.
        let name = "refs/heads/main";
        let hash = sha256_hex(name);
        let oid = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let u = ref_update(name, &hash, oid);
        assert_eq!(
            resolve_ref(&[u], &[], &hash, |_, _| false),
            RefState::Resolved {
                oid: oid.into(),
                author: "author1".into(),
                created_at: 100,
            }
        );
    }
}
