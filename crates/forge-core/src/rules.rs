//! The shared client rules — the cross-client-parity heart of Dash Forge.
//!
//! Dash Platform enforces membership, schema, and uniqueness at consensus, but it
//! has **no CAS**, cannot read glob patterns, and cannot fold an append-only event log
//! into "is this issue open". Those decisions are made *client-side*, and every
//! conforming client must make them **identically** — otherwise two people looking at
//! the same repo see two different branch tips, two different issue states, two
//! different protected-ref verdicts. This module is the Rust half of that shared
//! logic; a TypeScript port (`forge-web`) is the other half.
//!
//! Parity is held by a versioned spec (`docs/contracts/forge-v2.md` §6) plus
//! **shared JSON conformance vectors** in `forge-contracts/vectors/`. Both language
//! ports run the exact same vectors and must produce the exact same `expected`. The
//! test at the bottom of this file is that suite for the Rust side.
//!
//! What that proves, precisely: every vector hands these functions a ready-made input
//! array, so the suite establishes that the two ports FOLD identically given identical
//! input. It does not establish that each client FETCHES identical input. A divergence in
//! the read layer — one client paging a history to exhaustion while the other stops at
//! Drive's 100-row default — yields two different answers from two green conformance runs.
//! That class of bug belongs to the readers (`repo.rs`, `collab/`) and their own tests.
//!
//! Everything here is **pure**: no SDK, no network, no funds, no clock. Callers fetch
//! the documents (refUpdate / config / event / flatIndex) and hand
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
//! * the event model ([`Event`], [`IssueState`], [`PrState`]) and the per-kind effects the
//!   issue/PR folds in [`v2`] apply.
//! * [`overlay_tree`] — apply the tree diffs of the ≤ 20 commits since a flatIndex's
//!   indexed tip on top of it, so browse views stay fresh without a full re-walk
//!   (the S0.5 cold-load correction).
//!
//! [`v2`] holds the rest of `FORGE_RULES_V2`: membership, the issue/PR folds, numbering,
//! approvals, pack-copy selection and well-formedness. The base-rule vectors (no `rules` field)
//! and the `"rules": "v2"` vectors together are its conformance suite.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

pub mod ci_rerun;
pub mod codeowners;
pub mod long_body;
pub mod merge_check;
pub mod mirror;
pub mod moderation;
pub mod parity;
pub mod profile;
pub mod provenance;
pub mod ref_collision;
pub mod review;
pub mod search;
pub mod signature;
pub mod transition;
pub mod v2;

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
/// ancestry facts are in play. [`resolve_ref`]/[`v2::pr_state_v2`] also accept any
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
/// ## Algorithm (normative)
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
/// 2. **Order** valid updates by the *causal order* ([`causal_order`]): ascending
///    `createdAt`, and within one `createdAt` the prevOid chain (an update that recorded
///    another's tip as its `prevOid` comes after it), then `id`.
/// 3. If none remain → [`RefState::Unborn`]. If the newest valid update is a deletion
///    (null `newOid`) → [`RefState::Unborn`].
/// 4. **Live heads.** A valid update `u` (non-null tip) is *superseded* by a valid update
///    `v` strictly later in the causal order when any holds:
///    * `v` is a deletion or a force (it clears/replaces the ref outright), or
///    * `v.prevOid == u.newOid` (someone fast-forwarded directly off `u`'s tip), or
///    * `is_ancestor(u.newOid, v.newOid)` (later history descends from `u`'s tip).
///
///    The **live heads** are the non-superseded, non-null updates, deduplicated by tip.
///    Supersession only looks forward in a total order, so the newest update is always a
///    head: a non-null newest update never resolves to Unborn.
/// 5. Exactly one live head → [`RefState::Resolved`]. Two or more (a concurrent race
///    nothing has merged past) → [`RefState::Diverged`], heads newest-first.
///
/// **Why the clock comes first.** A `prevOid` names a commit, not a document, and a ref can
/// point at the same commit more than once (`A → B → force A`, or a delete and a recreate).
/// A chain match against a *newer* document is then no causal link: the old `A → B` update's
/// `prevOid` equals the newest tip `A`. Letting such a match override the clock made the old
/// update supersede the newest one while the newest superseded it back, leaving no head, so
/// the ref read as deleted (D-600). `$createdAt` is consensus block time and is required on
/// both ref update types, so it orders every pair of updates from different blocks; the
/// chain is only consulted inside one block, where the clock cannot tell them apart.
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
    let mut heads = live_heads(updates, config_history, ref_name_hash, is_ancestor);
    // (5) resolve. `heads[0]` is the provisional read-only tip of a diverged ref (§2.3).
    match heads.len() {
        0 => RefState::Unborn,
        1 => {
            let h = heads.pop().expect("len checked");
            RefState::Resolved {
                oid: h.oid,
                author: h.author,
                created_at: h.created_at,
            }
        }
        _ => RefState::Diverged { heads },
    }
}

/// Steps 1–4 of [`resolve_ref`]: the ref's live heads, newest first, each with the `$id` of
/// the update that set it. Empty when the ref is unborn or deleted. For a reader that must
/// name the document behind a tip (a mirror's manifest, `dg verify-mirror`), which
/// [`RefState::Resolved`] does not carry.
pub fn live_heads(
    updates: &[RefUpdate],
    config_history: &[ConfigDoc],
    ref_name_hash: &str,
    is_ancestor: impl Fn(&str, &str) -> bool,
) -> Vec<RefHead> {
    // (1) validity filter, keeping only this ref's updates; (2) the causal order.
    let valid = valid_updates(updates, config_history, ref_name_hash);

    // (3) unborn / deleted.
    let Some(newest) = valid.last() else {
        return Vec::new();
    };
    if is_null_oid(&newest.new_oid) {
        return Vec::new();
    }

    // (4) live heads: `v` (later in the causal order) supersedes `u`.
    let supersedes = |u: &RefUpdate, v: &RefUpdate| -> bool {
        is_null_oid(&v.new_oid) || v.force || builds_on(v, u) || is_ancestor(&u.new_oid, &v.new_oid)
    };

    // Heads newest-first: walking the causal order backwards, the first occurrence of a tip
    // is its newest, and a later duplicate of the same tip is one head, not two.
    let mut heads: Vec<RefHead> = Vec::new();
    for (i, u) in valid.iter().enumerate().rev() {
        if is_null_oid(&u.new_oid) || heads.iter().any(|h| h.oid == u.new_oid) {
            continue;
        }
        if valid[i + 1..].iter().any(|v| supersedes(u, v)) {
            continue;
        }
        heads.push(RefHead {
            id: u.id.clone(),
            oid: u.new_oid.clone(),
            author: u.author.clone(),
            created_at: u.created_at,
        });
    }
    heads
}

/// Every tip `ref_name_hash` has validly pointed at (non-null `newOid` of a valid update), and
/// the `$createdAt` of its newest valid update (a deletion included): what a mirror served
/// from an older snapshot can show, and since when it is out of date.
pub fn valid_tips(
    updates: &[RefUpdate],
    config_history: &[ConfigDoc],
    ref_name_hash: &str,
) -> (std::collections::BTreeSet<Oid>, Option<u64>) {
    let valid = valid_updates(updates, config_history, ref_name_hash);
    let newest = valid.last().map(|u| u.created_at);
    let tips = valid
        .into_iter()
        .filter(|u| !is_null_oid(&u.new_oid))
        .map(|u| u.new_oid.clone())
        .collect();
    (tips, newest)
}

/// Whether `v` recorded `u`'s tip as its `prevOid` (a fast-forward, or a force naming the
/// tip it replaced) and moved the ref somewhere else.
fn builds_on(v: &RefUpdate, u: &RefUpdate) -> bool {
    !is_null_oid(&v.prev_oid) && v.prev_oid == u.new_oid && v.new_oid != u.new_oid
}

/// Sort one ref's updates into the causal order [`resolve_ref`] folds in: ascending
/// `created_at`; within one `created_at` (one block), an update that [`builds_on`] another
/// comes after it; remaining ties, and chain cycles (`A → B` and `B → A` in one block), by
/// ascending `id`.
///
/// Within a block this is Kahn's topological sort with the smallest `id` picked first: take
/// the smallest-`id` unplaced update that builds on no other unplaced update of the block;
/// when there is none, every unplaced update waits on a cycle, so take the smallest-`id` one
/// that waits on nothing outside its own cycle ([`cycle_to_break`]). An update is never
/// placed before one it builds on unless that one builds back on it. Deterministic, total, the
/// same in every client (parity: forge-web `causalOrder`); O(n²) in the block size, O(n²) more
/// per cycle broken.
fn causal_order(mut updates: Vec<&RefUpdate>) -> Vec<&RefUpdate> {
    updates.sort_by(|a, b| (a.created_at, &a.id).cmp(&(b.created_at, &b.id)));
    let mut out = Vec::with_capacity(updates.len());
    for block in updates.chunk_by(|a, b| a.created_at == b.created_at) {
        let len = block.len();
        // `waiting[v]`: how many unplaced updates of the block `v` builds on (never itself:
        // `builds_on` needs a different tip).
        let mut waiting: Vec<usize> = block
            .iter()
            .map(|&v| block.iter().filter(|&&u| builds_on(v, u)).count())
            .collect();
        let mut placed = vec![false; len];
        for _ in 0..len {
            let unplaced = || (0..len).filter(|&i| !placed[i]);
            let next = unplaced()
                .find(|&i| waiting[i] == 0)
                .unwrap_or_else(|| cycle_to_break(block, &placed));
            placed[next] = true;
            out.push(block[next]);
            for v in 0..len {
                if !placed[v] && builds_on(block[v], block[next]) {
                    waiting[v] -= 1;
                }
            }
        }
    }
    out
}

/// The update of `block` to place when every unplaced one waits on another: the smallest-index
/// (so smallest-`id`) unplaced update all of whose unplaced predecessors (the updates it
/// [`builds_on`]) build back on it — they share its strongly connected component, so it waits
/// on nothing outside its own cycle. One exists: the components form a DAG, and every member
/// of one that waits on no other qualifies.
///
/// Components by Tarjan's algorithm, iterative (no recursion depth to exhaust on a hostile
/// block): O(n²) in the block size. Parity: forge-web `cycleToBreak`.
fn cycle_to_break(block: &[&RefUpdate], placed: &[bool]) -> usize {
    const NONE: usize = usize::MAX;
    let n = block.len();
    let edge = |v: usize, u: usize| !placed[u] && builds_on(block[v], block[u]);
    let (mut index, mut low, mut comp) = (vec![NONE; n], vec![0; n], vec![NONE; n]);
    let mut on_stack = vec![false; n];
    let (mut stack, mut next_index, mut comps) = (Vec::new(), 0, 0);
    for root in (0..n).filter(|&r| !placed[r]) {
        if index[root] != NONE {
            continue;
        }
        // (node, next neighbour to look at)
        let mut call: Vec<(usize, usize)> = vec![(root, 0)];
        index[root] = next_index;
        low[root] = next_index;
        next_index += 1;
        stack.push(root);
        on_stack[root] = true;
        while let Some(&(v, from)) = call.last() {
            let next = (from..n).find(|&u| edge(v, u) && (index[u] == NONE || on_stack[u]));
            if let Some(u) = next {
                call.last_mut().expect("v is on the call stack").1 = u + 1;
                if index[u] == NONE {
                    index[u] = next_index;
                    low[u] = next_index;
                    next_index += 1;
                    stack.push(u);
                    on_stack[u] = true;
                    call.push((u, 0));
                } else {
                    low[v] = low[v].min(index[u]);
                }
                continue;
            }
            call.pop();
            if let Some(&(parent, _)) = call.last() {
                low[parent] = low[parent].min(low[v]);
            }
            if low[v] == index[v] {
                while let Some(w) = stack.pop() {
                    on_stack[w] = false;
                    comp[w] = comps;
                    if w == v {
                        break;
                    }
                }
                comps += 1;
            }
        }
    }
    (0..n)
        .find(|&v| !placed[v] && (0..n).all(|u| !edge(v, u) || comp[u] == comp[v]))
        .expect("a component the others do not wait on has every member's predecessors inside")
}

/// Whether a ref name is one the RC1 contract accepts on `refUpdate` / `protectedRefUpdate`
/// (and `patch.baseRefName` / `sourceRefName`): the `$defs.refName` pattern (`refs/` then
/// the git check-ref-format grammar, `@{` included), at most 255 bytes, and the `noLock`
/// rule (no trailing `.lock`).
///
/// It is also the fold's and the helper's rule: a ref name reaches the git wire protocol,
/// so one carrying a newline (`refs/heads/x\n<oid> refs/heads/main`) would **inject a
/// spoofed ref-advertisement line** into every clone/fetch, and a NUL/space would corrupt
/// parsing. Anything outside the contract's grammar is inert on read, including a sealed
/// private ref name (consensus cannot see inside `enc`). forge-web's `isLegalRefName` must
/// apply the same predicate (PR-4).
#[must_use]
pub fn is_legal_ref_name(name: &str) -> bool {
    name.len() <= MAX_REF_NAME_BYTES
        && name.strip_prefix("refs/").is_some_and(is_legal_ref_path)
        && !name.as_bytes().ends_with(b".lock")
}

/// [`is_legal_ref_name`] plus the one rule of `git check-ref-format` the contract's regex
/// cannot express: no component may end with `.lock`. What a client refuses before it signs
/// a ref update (git itself could never create such a ref).
#[must_use]
pub fn is_git_ref_name(name: &str) -> bool {
    is_legal_ref_name(name) && !name.split('/').any(|c| c.as_bytes().ends_with(b".lock"))
}

/// Whether `branch` is a legal `repo.defaultBranch` / `config.defaultBranch` (RC1
/// `$defs.branch`): the ref grammar without the `refs/` prefix, at most 255 bytes, no leading
/// `-` (it would read as a git option), and a first component that is not only `@`s (`@` is
/// git's name for `HEAD`).
#[must_use]
pub fn is_legal_branch_name(branch: &str) -> bool {
    let after_ats = branch.trim_start_matches('@');
    let only_ats = after_ats.len() < branch.len()
        && (after_ats.is_empty() || after_ats.starts_with(['.', '/']));
    branch.len() <= MAX_REF_NAME_BYTES
        && !branch.starts_with('-')
        && !only_ats
        && is_legal_ref_path(branch)
}

/// Whether `tag` is a legal `release.tagName` (RC1): the ref grammar without the `refs/`
/// prefix, 1-63 bytes. A leading `-` is allowed (a private repository's keyed tag hash is
/// base64url).
#[must_use]
pub fn is_legal_tag_name(tag: &str) -> bool {
    tag.len() <= MAX_TAG_NAME_BYTES && is_legal_ref_path(tag)
}

/// The longest ref name (and default branch) the contract stores, in bytes.
pub const MAX_REF_NAME_BYTES: usize = 255;
/// The longest `release.tagName`, in bytes.
pub const MAX_TAG_NAME_BYTES: usize = 63;

/// The contract's ref grammar after `refs/` (`C(?:(?:\.?/|\.)C)*`, where a component `C` is a
/// non-empty run without `.`, `/`, control bytes, space, DEL, `~^:?*[\` or `@{`): components
/// split by `/` are non-empty and do not start with `.`; no `..`; no trailing `.`.
fn is_legal_ref_path(path: &str) -> bool {
    const FORBIDDEN: &[u8] = b"~^:?*[\\";
    !path.is_empty()
        && !path.contains("..")
        && !path.contains("@{")
        && !path.ends_with('.')
        && !path
            .bytes()
            .any(|b| b <= 0x20 || b == 0x7f || FORBIDDEN.contains(&b))
        && path
            .split('/')
            .all(|c| !c.is_empty() && !c.starts_with('.'))
}

/// Whether `h` is a SHA-256 rendered as 64 hex digits (either case): a real content hash,
/// as every live `refNameHash` is (a `bytes32` field) and every release asset records.
/// Symbolic test keys (short non-hex strings) are not, so the fold-side preimage check below
/// only binds real data.
#[must_use]
pub fn is_sha256_hex(h: &str) -> bool {
    h.len() == 64 && h.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Whether `refNameHash` is exactly `sha256(refName)` — the normative invariant binding
/// the indexed key to the name it claims to hash.
///
/// Public because callers that only want to *display* a ref must apply the same predicate
/// the fold does. `refName` is caller-supplied content and only `refNameHash` is indexed, so
/// a writer can post an update carrying a name that does not hash to the key it is
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
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum Verdict {
    /// Approve (1).
    Approve,
    /// Request changes (2).
    RequestChanges,
    /// Comment only, no verdict (3).
    Comment,
    /// A non-member's approval (4): shown, never counted. The contract refuses it with
    /// `asMember` (`memberVerdict`), so a member's approval is always 1.
    ApproveNonMember,
    /// A non-member's request for changes (5): shown, never counted.
    RequestChangesNonMember,
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
            4 => Self::ApproveNonMember,
            5 => Self::RequestChangesNonMember,
            other => Self::Unknown(other),
        }
    }

    /// The on-chain integer.
    pub fn code(self) -> u64 {
        match self {
            Self::Approve => 1,
            Self::RequestChanges => 2,
            Self::Comment => 3,
            Self::ApproveNonMember => 4,
            Self::RequestChangesNonMember => 5,
            Self::Unknown(c) => c,
        }
    }

    /// A short label for display.
    pub fn label(self) -> &'static str {
        match self {
            Self::Approve => "approved",
            Self::RequestChanges => "changes requested",
            Self::Comment => "commented",
            Self::ApproveNonMember => "approved (not a member)",
            Self::RequestChangesNonMember => "changes requested (not a member)",
            Self::Unknown(_) => "unknown verdict",
        }
    }

    /// The code this verdict is written as by a signer who is (`member`) or is not a proved
    /// member: members' approve / request changes are 1 / 2 (with `asMember`), everyone
    /// else's 4 / 5 (without). A comment is 3 either way.
    #[must_use]
    pub fn as_written_by(self, member: bool) -> Self {
        match (self, member) {
            (Self::Approve | Self::ApproveNonMember, true) => Self::Approve,
            (Self::Approve | Self::ApproveNonMember, false) => Self::ApproveNonMember,
            (Self::RequestChanges | Self::RequestChangesNonMember, true) => Self::RequestChanges,
            (Self::RequestChanges | Self::RequestChangesNonMember, false) => {
                Self::RequestChangesNonMember
            }
            (other, _) => other,
        }
    }

    /// Whether this verdict must carry `asMember` (1 and 2, `memberVerdict`).
    #[must_use]
    pub fn needs_member_proof(self) -> bool {
        matches!(self, Self::Approve | Self::RequestChanges)
    }
}

/// The name to DISPLAY for the ref keyed by `ref_name_hash`: the `refName` of the newest
/// update (on the `(created_at, id)` total order) whose name actually hashes to that key.
///
/// This is a shared rule, not a reader convenience, because the two halves of the ref
/// document are trusted differently: `refNameHash` is the indexed key, while `refName` is
/// caller-supplied content. A writer may therefore file an update under `main`'s hash
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

/// A PR's base ref as merge verification sees it: see [`merge_base_tips`].
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeBaseTips {
    /// Every commit a VALID update has set the ref to (deletions excluded), oldest first in
    /// [`resolve_ref`]'s causal order, each once. A merge counts iff its `oid` is one of them.
    pub historical: Vec<Oid>,
    /// The newest of `historical`, or `None` when the ref never had a valid tip. A deletion
    /// does not clear it: a PR merged into a branch stays merged after the branch is deleted.
    /// This is the base tip the PR fold takes.
    pub tip: Option<Oid>,
    /// Where the ref points now: the newest valid update's `newOid`, `None` when that update
    /// deleted the ref (or there is none). What a merge builds on; not a fold input.
    pub current: Option<Oid>,
}

impl MergeBaseTips {
    /// Whether `oid` has been a valid tip of the base (the merge-reachability predicate).
    #[must_use]
    pub fn contains(&self, oid: &str) -> bool {
        self.historical.iter().any(|t| t == oid)
    }
}

/// The base-ref history a PR merge is verified against (§4 routing, §6 merge reachability).
///
/// Only a *valid* update moves a ref ([`resolve_ref`] step 1): its `refName` is legal and
/// hashes to its key, and on a ref protected by the config in force when it was written,
/// it came through the MAINTAIN-gated `protectedRefUpdate` type. A plain `refUpdate`
/// naming a protected ref is inert, so the commit it names was never on the branch and a
/// merge event naming that commit must not count. Without this filter, a writer (or on v1
/// any WRITE holder) could flip any PR to "merged" on a protected branch they cannot push
/// to: post a plain update to it naming the PR head, then a merge event.
///
/// `updates` may hold other refs' updates; only those keyed `ref_name_hash` count. Used by
/// both rule versions (the fold then takes `tip` as the base tip and [`MergeBaseTips::contains`]
/// as the ancestry predicate).
#[must_use]
pub fn merge_base_tips(
    updates: &[RefUpdate],
    config_history: &[ConfigDoc],
    ref_name_hash: &str,
) -> MergeBaseTips {
    let valid = valid_updates(updates, config_history, ref_name_hash);
    let mut historical: Vec<Oid> = Vec::new();
    for u in &valid {
        if !is_null_oid(&u.new_oid) && !historical.contains(&u.new_oid) {
            historical.push(u.new_oid.clone());
        }
    }
    // `valid` is in causal order: the newest non-null tip, and the newest update's own tip.
    let tip = valid
        .iter()
        .rev()
        .find(|u| !is_null_oid(&u.new_oid))
        .map(|u| u.new_oid.clone());
    let current = valid
        .last()
        .filter(|u| !is_null_oid(&u.new_oid))
        .map(|u| u.new_oid.clone());
    MergeBaseTips {
        historical,
        tip,
        current,
    }
}

/// The base history a PR opened at `opened_at` (its `$createdAt`) is folded against: the
/// PR's base must have been a branch when the PR was opened (D-501).
///
/// [`merge_base_tips`], except that when the base had no valid tip at `opened_at` (never
/// created, or deleted then) `historical` is empty and `tip` is `None`, so no merge event
/// counts, whatever is pushed to that name later. `current` is kept: it is where the ref
/// points now, which a merge tool reports. Without this a PR opened against a name that was no
/// branch (a typo) could be "merged" by creating the branch with the PR head, and a merged PR
/// cannot be reopened. Updates at exactly `opened_at` count as before it (same block).
#[must_use]
pub fn pr_base_tips(
    updates: &[RefUpdate],
    config_history: &[ConfigDoc],
    ref_name_hash: &str,
    opened_at: u64,
) -> MergeBaseTips {
    let tips = merge_base_tips(updates, config_history, ref_name_hash);
    let before: Vec<RefUpdate> = updates
        .iter()
        .filter(|u| u.created_at <= opened_at)
        .cloned()
        .collect();
    if merge_base_tips(&before, config_history, ref_name_hash)
        .current
        .is_some()
    {
        return tips;
    }
    MergeBaseTips {
        historical: Vec::new(),
        tip: None,
        ..tips
    }
}

/// The valid updates of the ref keyed `ref_name_hash` ([`is_update_valid`]) in the causal
/// order ([`causal_order`]): steps 1 and 2 of [`resolve_ref`], shared with [`merge_base_tips`].
fn valid_updates<'a>(
    updates: &'a [RefUpdate],
    config_history: &[ConfigDoc],
    ref_name_hash: &str,
) -> Vec<&'a RefUpdate> {
    causal_order(
        updates
            .iter()
            .filter(|u| u.ref_name_hash == ref_name_hash && is_update_valid(u, config_history))
            .collect(),
    )
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
    if is_sha256_hex(&u.ref_name_hash) && !ref_name_hash_matches(&u.ref_name, &u.ref_name_hash) {
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
        // Unprotected: either type is fine (maintainers may protect-push anywhere).
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
/// ## Pinned glob semantics
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

/// Every tag, nested ones included (`refs/tags/v1`, `refs/tags/tools/v1`): `**` crosses `/`.
pub const ALL_TAGS_PATTERN: &str = "refs/tags/**";

/// The protected patterns a new repository starts with unless its creator opts out (a client
/// convention, `docs/contracts/forge-v2.md` §6): its default branch and every tag, so only
/// maintainers can move what people build and install from. `default_branch` is the short
/// name (`main`) or the full ref. Parity: `defaultProtectedPatterns` in
/// `forge-web/lib/rules/matchesProtected.ts` (vectors `default_protection__*`).
#[must_use]
pub fn default_protected_patterns(default_branch: &str) -> Vec<String> {
    let short = default_branch
        .strip_prefix("refs/heads/")
        .unwrap_or(default_branch);
    vec![format!("refs/heads/{short}"), ALL_TAGS_PATTERN.to_string()]
}

/// Whether a public ref update is written as the maintainer-gated `protectedRefUpdate` (a client
/// rule, `docs/contracts/forge-v2.md` §6): when the config in force protects `ref_name`; and when
/// no config is readable yet (`patterns` is `None`) and the pusher owns the repository. Every
/// client writes a config at create, and a new repository protects its default branch and tags
/// by default, so the owner's push right after the create (`dg init`) would otherwise go out as
/// a plain update that config makes inert, and the ref would never appear; consensus admits the
/// protected type from the owner, who self-enrols as maintainer at create. Anyone else's update
/// stays plain: nothing they could see protects the ref. Parity: `refUpdateType` in
/// `forge-web/lib/repo/push.ts` (vectors `ref_update_route__*`).
#[must_use]
pub fn routes_protected(
    ref_name: &str,
    patterns: Option<&[String]>,
    pusher_is_owner: bool,
) -> bool {
    match patterns {
        Some(p) => matches_protected(ref_name, p),
        None => pusher_is_owner,
    }
}

/// The patterns that cover every tag ([`missing_default_protection`]). A list, not a test
/// against sample tags: a glob can match any finite sample and still miss a tag
/// (`refs/tags/**/[!q]*` misses `q1`).
const ALL_TAG_PATTERNS: [&str; 3] = ["refs/tags/**", "refs/**", "**"];

/// What of the default protection `patterns` leave uncovered on a repository whose default
/// branch is `default_branch`: the default patterns still needed, empty when existing patterns
/// cover both the branch and every tag. Every tag counts as covered only by a pattern that names
/// them all (`refs/tags/**`, `refs/**`, `**`): `refs/tags/*` misses nested tags and `refs/tags/v*`
/// misses `1.0`, so either still needs `refs/tags/**`. Parity:
/// `missingDefaultProtection` in `forge-web/lib/rules/matchesProtected.ts` (vectors
/// `missing_default_protection__*`).
#[must_use]
pub fn missing_default_protection(default_branch: &str, patterns: &[String]) -> Vec<String> {
    let all_tags = patterns
        .iter()
        .any(|p| ALL_TAG_PATTERNS.contains(&p.as_str()));
    default_protected_patterns(default_branch)
        .into_iter()
        .filter(|d| {
            if d == ALL_TAGS_PATTERN {
                !all_tags
            } else {
                !matches_protected(d, patterns)
            }
        })
        .collect()
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
// Event fold (issue / PR state)
// ===========================================================================

/// A collaboration `event` kind (forge-v2.md §3, numeric kinds 1–25). Kinds 1–10 change the
/// issue/PR state ([`apply_issue_event`], [`apply_pr_event`]); 11–18 are the review state
/// ([`v2::fold_pr_review_v2`]); 17–22 are a thread's milestone, pin and lock
/// ([`parity::fold_thread_meta_v2`]); 23 is an audit record no fold reads; 24–25 are a
/// maintainer's hide and unhide ([`moderation::hidden_items`]). None of 11–25 changes
/// [`PrState`] / [`IssueState`].
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
    /// 11 — a review thread resolved (`ref_id` = the thread's root comment).
    ThreadResolve,
    /// 12 — a review thread unresolved (`ref_id` = the root comment).
    ThreadUnresolve,
    /// 13 — a reviewer requested (`ref_id` = the reviewer's identity).
    ReviewRequest,
    /// 14 — a review request removed (`ref_id` = the reviewer's identity).
    ReviewRequestRemove,
    /// 15 — a review dismissed (`ref_id` = the review; `value` = the reason). Members only.
    ReviewDismiss,
    /// 16 — the PR head moved (`oid` = the new head).
    HeadUpdate,
    /// 17 — a milestone set (`value` = its name). Members only.
    MilestoneSet,
    /// 18 — the milestone cleared. Members only.
    MilestoneClear,
    /// 19 — pinned to the repo's issue or PR list. Members only.
    Pin,
    /// 20 — unpinned. Members only.
    Unpin,
    /// 21 — locked: clients offer the composer to members only. Members only.
    Lock,
    /// 22 — unlocked. Members only.
    Unlock,
    /// 23 — a maintainer merged by bypassing the branch rules (`value` = the rules not met,
    /// `oid` = the merge commit). Members only. The record of the bypass: an `event` is
    /// immutable and non-deletable, so the bypasser cannot erase it (a comment could be).
    PolicyBypass,
    /// 24 — a maintainer hides a comment or review (`ref_id`) or, without `ref_id`, the whole
    /// issue or PR (`value` = an optional reason, [`moderation::HIDE_REASONS`]). Display only:
    /// readers collapse it ([`moderation::hidden_items`]); nothing is deleted.
    Hide,
    /// 25 — a maintainer unhides what kind 24 hid (same `ref_id`).
    Unhide,
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
    /// Document `$ownerId`: the actor (a member for `event`, the author for `authorEvent`).
    pub actor: String,
    /// Kind-dependent payload: label name, assignee id, or retarget base ref.
    #[serde(default)]
    pub value: Option<String>,
    /// Merge commit oid (kind `Merge`) or new head (kind `HeadUpdate`).
    #[serde(default)]
    pub oid: Option<Oid>,
    /// The document or identity a review kind refers to (`refId`, base58): a thread's root
    /// comment (11, 12), a reviewer (13, 14), a review (15). Absent for the other kinds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ref_id: Option<String>,
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
    /// Merged PRs only, when the reader has the merge's `oid`: whether it was a valid tip of the
    /// base (`true`), or not (`false`: shown as "merge commit not found on the base"). `None`
    /// when not merged or the oid is not known.
    pub merge_on_base: Option<bool>,
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
            merge_on_base: None,
        }
    }
}

/// Apply one authorized event to an issue's state. PR-only kinds
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
        // PR-only kinds, and the review kinds (11–18, `v2::fold_pr_review_v2`).
        _ => {}
    }
}

/// Apply one authorized event to a PR's state.
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
        // Review kinds (11–18) are folded by `v2::fold_pr_review_v2`.
        _ => {}
    }
}

/// The `(createdAt, id)` total order every fold applies events in.
pub(crate) fn event_order(a: &Event, b: &Event) -> std::cmp::Ordering {
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
        ci_rerun, codeowners, default_protected_patterns, display_ref_name, is_legal_ref_name,
        long_body, matches_protected, merge_base_tips, missing_default_protection, overlay_tree,
        pr_base_tips, resolve_ref, routes_protected, v2, Ancestry, ConfigDoc, Event, EventKind,
        FlatIndex, IssueState, MergeBaseTips, PrState, RefState, RefUpdate, TreeDiff, Verdict,
    };
    use serde::{Deserialize, Serialize};
    use std::path::PathBuf;

    /// BLOCKER-1 regression, on the transition reader: a merge whose oid was ever a base tip
    /// stays "on the base" once the base ref advances past it. The service supplies a
    /// monotonic historical-tips membership predicate; the old reflexive `|a,b| a==b` stand-in
    /// flipped it the instant `base_tip != merge_oid`.
    #[test]
    fn pr_merge_stays_merged_after_base_advances() {
        // The merge oid `M` and a later base commit `T` are both historical base tips.
        let historical: std::collections::BTreeSet<String> =
            ["M".to_string(), "T".to_string()].into_iter().collect();
        // State code 2 (merged); the base has advanced to `T` (T != M).
        let good = v2::pr_state_v2(2, Some("M"), &[], Some("T"), |oid, _tip| {
            historical.contains(oid)
        });
        assert!(good.merged, "merged is the chain fact");
        assert!(!good.open, "a merged PR is closed");
        assert_eq!(good.merge_on_base, Some(true), "found on the base");
        // The reflexive stand-in labels it "not found on the base", never un-merges it.
        let bad = v2::pr_state_v2(2, Some("M"), &[], Some("T"), |a, b| a == b);
        assert!(bad.merged);
        assert_eq!(bad.merge_on_base, Some(false));
    }

    /// MAJOR-4 defense-in-depth: an illegal `Retarget` base ref name (injection shape) is
    /// inert in the fold and never overwrites the live base ref.
    #[test]
    fn fold_pr_illegal_retarget_is_inert() {
        let holder = "m1";
        let legal = Event {
            id: "e1".into(),
            target_id: "pr".into(),
            kind: EventKind::Retarget,
            actor: holder.into(),
            value: Some("refs/heads/dev".into()),
            oid: None,
            ref_id: None,
            created_at: 5,
        };
        let illegal = Event {
            id: "e2".into(),
            target_id: "pr".into(),
            kind: EventKind::Retarget,
            actor: holder.into(),
            value: Some("refs/heads/x\n0000 refs/heads/main".into()),
            oid: None,
            ref_id: None,
            created_at: 10,
        };
        let s1 = v2::pr_state_v2(0, None, std::slice::from_ref(&legal), None, |_, _| false);
        assert_eq!(s1.base_ref.as_deref(), Some("refs/heads/dev"));
        // The newer illegal retarget must NOT overwrite with the injection payload.
        let s2 = v2::pr_state_v2(0, None, &[legal, illegal], None, |_, _| false);
        assert_eq!(
            s2.base_ref.as_deref(),
            Some("refs/heads/dev"),
            "illegal retarget value is inert"
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
        /// `"v2"` for the forge-v2 cases; absent for the base rules (ref resolution,
        /// protected-pattern matching, display names, overlay, verdicts).
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

    /// A PR base ref's raw history: the fold's base tip and merge predicate then come from
    /// [`merge_base_tips`] (or, with `openedAt`, [`pr_base_tips`]) instead of a
    /// vector-supplied `baseTip` / `ancestry`.
    #[derive(Debug, Deserialize, Serialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct BaseHistory {
        updates: Vec<RefUpdate>,
        #[serde(default)]
        config_history: Vec<ConfigDoc>,
        ref_name_hash: String,
        /// The PR's `$createdAt`: when present the base is read through [`pr_base_tips`].
        #[serde(default)]
        opened_at: Option<u64>,
    }

    /// [`v2::pr_merge_base`]'s inputs.
    #[derive(Debug, Deserialize, Serialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct PrMergeBaseInput {
        base_ref_name: String,
        opened_at: u64,
        events: Vec<Event>,
        #[serde(default)]
        merged_at: Option<u64>,
    }

    impl BaseHistory {
        fn tips(&self) -> MergeBaseTips {
            match self.opened_at {
                Some(at) => {
                    pr_base_tips(&self.updates, &self.config_history, &self.ref_name_hash, at)
                }
                None => merge_base_tips(&self.updates, &self.config_history, &self.ref_name_hash),
            }
        }
    }

    /// The fold's base tip and ancestry for a vector: as supplied, or from `base_history`
    /// (then `baseTip` / `ancestry` must be absent) as the readers build them — the tip is
    /// [`MergeBaseTips::tip`], and an oid is "an ancestor of the tip" iff it is one of
    /// [`MergeBaseTips::historical`].
    fn fold_base(
        ctx: &str,
        base_history: Option<&BaseHistory>,
        base_tip: Option<&str>,
        ancestry: &Ancestry,
    ) -> (Option<String>, Ancestry) {
        let Some(h) = base_history else {
            return (base_tip.map(str::to_owned), ancestry.clone());
        };
        assert!(
            base_tip.is_none() && ancestry.pairs.is_empty(),
            "vector `{ctx}`: baseHistory replaces baseTip and ancestry"
        );
        let tips = h.tips();
        let pairs = match &tips.tip {
            Some(tip) => tips
                .historical
                .iter()
                .map(|oid| (oid.clone(), tip.clone()))
                .collect(),
            None => Vec::new(),
        };
        (tips.tip, Ancestry { pairs })
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
            "release_provenance"
            | "ref_update_route"
            | "missing_default_protection"
            | "default_protection" => run_protection_case(v),
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
    // `input`), so a vector cannot carry a field, such as a token-era `tokenRecords` or a misspelt
    // `authorEvent` key, that the v2 rules would silently ignore -----------------------------

    /// A target's state code and merge oid, from exactly one of its `transitions` and (a list
    /// row) their proved `delta` `sum` (with `mergeOid` when the row knows it).
    fn state_of(
        ctx: &str,
        transitions: Option<&[v2::Transition]>,
        sum: Option<i64>,
        merge_oid: Option<&String>,
    ) -> (i64, Option<String>) {
        match (transitions, sum) {
            (Some(t), None) => {
                assert!(
                    merge_oid.is_none(),
                    "vector `{ctx}`: mergeOid goes with sum"
                );
                (
                    v2::state_code(t),
                    v2::merge_transition(t).and_then(|m| m.oid.clone()),
                )
            }
            (None, Some(sum)) => (sum, merge_oid.cloned()),
            _ => panic!("vector `{ctx}`: give exactly one of transitions and sum"),
        }
    }

    #[derive(Debug, Deserialize, Serialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct FoldIssueV2Input {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        transitions: Option<Vec<v2::Transition>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        sum: Option<i64>,
        #[serde(default)]
        events: Vec<Event>,
    }

    #[derive(Debug, Deserialize, Serialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct FoldPrV2Input {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        transitions: Option<Vec<v2::Transition>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        sum: Option<i64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        merge_oid: Option<String>,
        #[serde(default)]
        events: Vec<Event>,
        #[serde(default)]
        base_tip: Option<String>,
        #[serde(default)]
        ancestry: Ancestry,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        base_history: Option<BaseHistory>,
    }

    #[derive(Debug, Deserialize, Serialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct TransitionMoveCase {
        target: v2::TransitionTarget,
        code: i64,
        action: v2::StateAction,
        actor: v2::Actor,
        target_number: u32,
    }

    #[derive(Debug, Deserialize, Serialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct TransitionMovesInput {
        cases: Vec<TransitionMoveCase>,
    }

    #[derive(Debug, Deserialize, Serialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct RepoCountsInput {
        issues: u64,
        patches: u64,
        kinds: std::collections::BTreeMap<String, u64>,
    }

    #[derive(Debug, Deserialize, Serialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct UpstreamNumberInput {
        upstream_number: Option<u32>,
        author: String,
        repo_owner: String,
        memberships: Vec<v2::Membership>,
    }

    #[derive(Debug, Deserialize, Serialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct RefNameHashesInput {
        doc: v2::ContentDoc,
        /// The epoch's `K_ref`, hex; absent for a public repo (`sha256`).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        ref_key: Option<String>,
    }

    /// `fork_sync`: the tips and their ancestry (`crate::fork::sync_decision`).
    #[derive(Debug, Deserialize, Serialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct ForkSyncInput {
        fork_tip: Option<String>,
        parent_tip: Option<String>,
        fork_in_parent: bool,
        parent_in_fork: bool,
    }

    /// One ref of a `fork_refs` side.
    #[derive(Debug, Deserialize, Serialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct ForkRef {
        ref_name: String,
        state: RefState,
    }

    /// `fork_refs`: the parent's and the fork's refs (`crate::fork::plan_refs`).
    #[derive(Debug, Deserialize, Serialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct ForkRefsInput {
        parent: Vec<ForkRef>,
        fork: Vec<ForkRef>,
        only_branch: Option<String>,
    }

    /// A planned fork ref, as `expected` names it.
    #[derive(Debug, Deserialize, PartialEq, Eq)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct PlannedRef {
        ref_name: String,
        oid: String,
    }

    /// The fork cases (`fork_sync__*`, `fork_refs__*`): what a fork copies, and what a sync does.
    fn run_fork_case(v: &Vector) {
        let ctx = &v.name;
        match v.case.as_str() {
            "fork_sync" => {
                let inp: ForkSyncInput = input(v);
                let got = crate::fork::sync_decision(
                    inp.fork_tip.as_deref(),
                    inp.parent_tip.as_deref(),
                    inp.fork_in_parent,
                    inp.parent_in_fork,
                );
                assert_eq!(
                    got,
                    expected::<crate::fork::SyncDecision>(v),
                    "vector `{ctx}`"
                );
            }
            "fork_refs" => {
                let inp: ForkRefsInput = input(v);
                let side = |refs: &[ForkRef]| -> Vec<(String, RefState)> {
                    refs.iter()
                        .map(|r| (r.ref_name.clone(), r.state.clone()))
                        .collect()
                };
                let got: Vec<PlannedRef> = crate::fork::plan_refs(
                    &side(&inp.parent),
                    &side(&inp.fork),
                    inp.only_branch.as_deref(),
                )
                .into_iter()
                .map(|(ref_name, oid)| PlannedRef { ref_name, oid })
                .collect();
                assert_eq!(got, expected::<Vec<PlannedRef>>(v), "vector `{ctx}`");
            }
            other => panic!("vector `{ctx}`: not a fork case `{other}`"),
        }
    }

    #[derive(Debug, Deserialize, Serialize)]
    #[serde(deny_unknown_fields)]
    struct PackCopiesInput {
        copies: Vec<v2::PackCopy>,
    }

    #[derive(Debug, Deserialize, Serialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct ApprovalCountInput {
        visibility: v2::Visibility,
        reviews: Vec<v2::ReadReview>,
        memberships: Vec<v2::Membership>,
        head_oid: String,
        #[serde(default, skip_serializing_if = "std::collections::BTreeSet::is_empty")]
        dismissed: std::collections::BTreeSet<String>,
        #[serde(default, skip_serializing_if = "String::is_empty")]
        pr_author: String,
    }

    #[derive(Debug, Deserialize, Serialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct MixedEditInput {
        stored: v2::ContentDoc,
        edited: v2::ContentDoc,
    }

    #[derive(Debug, Deserialize, Serialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct AnchorSettingsInput {
        default_branch: String,
        #[serde(default)]
        protected_patterns: Vec<String>,
        backend_mode: u8,
        archived: bool,
    }

    #[derive(Debug, Deserialize, Serialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct ChainLinkInput {
        prev: u32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        prev_key: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        skip_key: Option<String>,
        #[serde(default)]
        burned: bool,
    }

    #[derive(Debug, Deserialize, Serialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct MixedAnchorInput {
        visibility: v2::Visibility,
        /// The repository's current settings, as the anchor writer is given them.
        current: AnchorSettingsInput,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        link: Option<ChainLinkInput>,
    }

    #[derive(Debug, Deserialize, Serialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct MixedAnchorExpected {
        vis: v2::Visibility,
        /// The plaintext properties beside `repoId`, `enc`, `epoch` and `vis`, by name.
        plaintext: Vec<String>,
        /// The sealed TLV, hex.
        tlv: String,
    }

    /// The members-only-content cases (`private-repos.md` §17): D15's approval count, the
    /// fixed audience of an edit, and the members-key anchor of a public repository.
    fn run_mixed_case(v: &Vector) {
        let ctx = &v.name;
        match v.case.as_str() {
            "approval_count" => {
                let inp: ApprovalCountInput = input(v);
                let oracle = v2::RoleOracle::new(inp.memberships);
                let counted = v2::counted_reviews(&inp.reviews, inp.visibility);
                let got = v2::count_approvals(
                    &counted,
                    &oracle,
                    &inp.head_oid,
                    &inp.dismissed,
                    &inp.pr_author,
                );
                assert_eq!(got, expected::<v2::Approvals>(v), "vector `{ctx}`");
            }
            "mixed_edit" => {
                let inp: MixedEditInput = input(v);
                let got = v2::edit_keeps_audience(&inp.stored, &inp.edited);
                assert_eq!(got, expected::<bool>(v), "vector `{ctx}`");
            }
            "mixed_anchor" => run_mixed_anchor(v),
            other => panic!("vector `{ctx}`: not a mixed case `{other}`"),
        }
    }

    fn run_mixed_anchor(v: &Vector) {
        let ctx = &v.name;
        let inp: MixedAnchorInput = input(v);
        let key = |h: &str| {
            crate::private::EpochKey::from_slice(&hex::decode(h).expect("hex key"))
                .unwrap_or_else(|| panic!("vector `{ctx}`: a key is 32 bytes"))
        };
        let settings = crate::keyring::AnchorSettings {
            default_branch: inp.current.default_branch.clone(),
            protected_patterns: inp.current.protected_patterns.clone(),
            backend: crate::keyring::backend_object(inp.current.backend_mode),
            archived: inp.current.archived,
        };
        let link = inp.link.as_ref().map(|l| crate::keyring::ChainLink {
            prev: l.prev,
            prev_key: l.prev_key.as_deref().map(key),
            skip_key: l.skip_key.as_deref().map(key),
            burned: l.burned,
        });
        let got = crate::keyring::anchor_content(inp.visibility, &settings, link);
        let got = MixedAnchorExpected {
            vis: got.vis,
            plaintext: got.plaintext.keys().cloned().collect(),
            tlv: hex::encode(&*crate::private::tlv::encode(&got.fields)),
        };
        let want: MixedAnchorExpected = expected(v);
        assert_eq!(
            serde_json::to_value(&got).unwrap(),
            serde_json::to_value(&want).unwrap(),
            "vector `{ctx}`"
        );
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
        /// Review ids a `reviewDismiss` names (absent: none).
        #[serde(default, skip_serializing_if = "std::collections::BTreeSet::is_empty")]
        dismissed: std::collections::BTreeSet<String>,
        /// The PR's author, whose own reviews never count (absent: nobody's).
        #[serde(default, skip_serializing_if = "String::is_empty")]
        pr_author: String,
    }

    #[derive(Debug, Deserialize, Serialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct FoldReviewInput {
        #[serde(default)]
        events: Vec<Event>,
        #[serde(default)]
        author_events: Vec<Event>,
        target_author: String,
        initial_head: String,
        #[serde(default)]
        known_roots: std::collections::BTreeSet<String>,
    }

    #[derive(Debug, Deserialize, Serialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct PolicyInput {
        reviews: Vec<v2::Review>,
        memberships: Vec<v2::Membership>,
        head_oid: String,
        #[serde(default, skip_serializing_if = "std::collections::BTreeSet::is_empty")]
        dismissed: std::collections::BTreeSet<String>,
        /// The PR's author, whose own reviews never count (absent: nobody's).
        #[serde(default, skip_serializing_if = "String::is_empty")]
        pr_author: String,
        policy: v2::Policy,
    }

    #[derive(Debug, Deserialize, Serialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct ReviewGroupInput {
        review_id: String,
        reviewer: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        comment_count: Option<u32>,
        comments: Vec<v2::ReviewComment>,
    }

    #[derive(Debug, Deserialize, Serialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct SuggestionInput {
        /// `parse`: a comment body.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        body: Option<String>,
        /// `apply`: the file and the range.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        file: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        start_line: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        end_line: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        text: Option<String>,
    }

    #[derive(Debug, Deserialize, Serialize)]
    #[serde(deny_unknown_fields)]
    struct TextInput {
        text: String,
    }

    #[derive(Debug, Deserialize, Serialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct ChecksInput {
        runs: Vec<v2::CheckRunRow>,
        head_oid: String,
        memberships: Vec<v2::Membership>,
        #[serde(default)]
        runners: std::collections::BTreeSet<String>,
        policy: v2::ChecksPolicy,
    }

    #[derive(Debug, Deserialize, Serialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct EventsInput {
        events: Vec<Event>,
    }

    #[derive(Debug, Deserialize, Serialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct HiddenItemsInput {
        thread_id: String,
        thread_author: String,
        owner: String,
        #[serde(default)]
        maintainers: std::collections::BTreeSet<String>,
        proved: bool,
        events: Vec<Event>,
        #[serde(default)]
        comments: Vec<v2::ThreadItem>,
        #[serde(default)]
        reviews: Vec<v2::ThreadItem>,
    }

    #[derive(Debug, Deserialize, Serialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct MilestonesInput {
        docs: Vec<v2::MilestoneDoc>,
        #[serde(default)]
        items: Vec<v2::MilestoneItem>,
    }

    #[derive(Debug, Deserialize, Serialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct TrendingInput {
        beats: Vec<v2::StarBeat>,
        grid: v2::TimeGrid,
        now: u64,
        selector: v2::TrendingSelector,
        limit: usize,
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
    struct CodeOwnersInput {
        file: String,
        paths: Vec<String>,
    }

    #[derive(Debug, Deserialize, Serialize)]
    #[serde(deny_unknown_fields)]
    struct CodeOwnerRequestsInput {
        tokens: Vec<String>,
        resolved: std::collections::BTreeMap<String, Option<String>>,
        memberships: Vec<v2::Membership>,
        author: String,
    }

    #[derive(Debug, Deserialize, Serialize)]
    #[serde(deny_unknown_fields)]
    struct RoleOracleInput {
        memberships: Vec<v2::Membership>,
        queries: Vec<RoleQuery>,
    }

    #[derive(Deserialize, Serialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct CiRerunInput {
        repo_id: String,
        owner: String,
        memberships: Vec<v2::Membership>,
        events: Vec<ci_rerun::RerunEvent>,
    }

    #[derive(Deserialize, Serialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct CiRerunWriteInput {
        repo_id: String,
        cases: Vec<CiRerunWriteCase>,
    }

    #[derive(Deserialize, Serialize)]
    #[serde(deny_unknown_fields)]
    struct CiRerunWriteCase {
        sha: String,
        #[serde(default)]
        check: Option<String>,
    }

    /// The CI re-run convention (`ci_rerun__*`): which events are requests, which count, and
    /// what a request stores.
    fn run_ci_rerun_case(v: &Vector) {
        let ctx = &v.name;
        let got: Vec<serde_json::Value> = match v.case.as_str() {
            "ci_rerun" => {
                let inp: CiRerunInput = input(v);
                let oracle = v2::RoleOracle::new(inp.memberships);
                inp.events
                    .iter()
                    .map(|e| {
                        let req = ci_rerun::rerun_request(&inp.repo_id, e);
                        let counts = req
                            .as_ref()
                            .map(|r| ci_rerun::rerun_counts(r, &inp.owner, &oracle));
                        serde_json::json!({ "request": req, "counts": counts })
                    })
                    .collect()
            }
            "ci_rerun_write" => {
                let inp: CiRerunWriteInput = input(v);
                inp.cases
                    .iter()
                    .map(|c| {
                        match ci_rerun::rerun_fields(&inp.repo_id, &c.sha, c.check.as_deref()) {
                            Ok(f) => serde_json::to_value(f).expect("fields serialize"),
                            Err(_) => serde_json::json!({ "error": true }),
                        }
                    })
                    .collect()
            }
            other => panic!("vector `{ctx}`: not a ci_rerun case `{other}`"),
        };
        assert_eq!(serde_json::Value::from(got), v.expected, "vector `{ctx}`");
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

    /// `pack_copies`: `expected` names any non-empty subset of the three results; each named
    /// one is checked.
    fn run_pack_copies(v: &Vector) {
        let ctx = &v.name;
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

    /// The review-parity cases (`docs/design/review-parity-spec.md` §5).
    fn run_review_case(v: &Vector) {
        let ctx = &v.name;
        match v.case.as_str() {
            "fold_review" => {
                let inp: FoldReviewInput = input(v);
                let got = v2::fold_pr_review_v2(
                    &inp.events,
                    &inp.author_events,
                    &inp.target_author,
                    &inp.initial_head,
                    &inp.known_roots,
                );
                assert_eq!(got, expected::<v2::PrReviewState>(v), "vector `{ctx}`");
            }
            "policy" => {
                let inp: PolicyInput = input(v);
                let oracle = v2::RoleOracle::new(inp.memberships);
                let approvals = v2::count_approvals(
                    &inp.reviews,
                    &oracle,
                    &inp.head_oid,
                    &inp.dismissed,
                    &inp.pr_author,
                );
                let got = v2::meets_policy(&approvals, &oracle, &inp.policy);
                assert_eq!(got, expected::<v2::PolicyStatus>(v), "vector `{ctx}`");
            }
            "anchor" => {
                let inp: v2::AnchorFields = input(v);
                let got = v2::anchor_of(&inp);
                assert_eq!(got, expected::<Option<v2::Anchor>>(v), "vector `{ctx}`");
            }
            "review_group" => {
                let inp: ReviewGroupInput = input(v);
                let got = v2::group_review_comments(
                    &inp.review_id,
                    &inp.reviewer,
                    inp.comment_count,
                    &inp.comments,
                );
                assert_eq!(got, expected::<v2::ReviewGroup>(v), "vector `{ctx}`");
            }
            "suggestion" => {
                let inp: SuggestionInput = input(v);
                let got = match (&inp.body, &inp.file) {
                    (Some(body), None) => serde_json::json!(v2::parse_suggestions(body)),
                    (None, Some(file)) => {
                        let r = v2::apply_suggestion(
                            file,
                            inp.start_line.expect("startLine"),
                            inp.end_line.expect("endLine"),
                            inp.text.as_deref().unwrap_or(""),
                        );
                        match r {
                            Ok(out) => serde_json::json!({ "ok": out }),
                            Err(e) => serde_json::json!({ "error": e }),
                        }
                    }
                    _ => panic!("vector `{ctx}`: suggestion takes body (parse) or file (apply)"),
                };
                assert_eq!(got, v.expected, "vector `{ctx}`");
            }
            "linked_issues" => {
                let inp: TextInput = input(v);
                let got = v2::linked_issues(&inp.text);
                assert_eq!(got, expected::<Vec<u32>>(v), "vector `{ctx}`");
            }
            other => panic!("vector `{ctx}`: not a review case `{other}`"),
        }
    }

    /// The platform-parity cases (`docs/design/platform-parity-spec.md` §2.6, §1.2, §4).
    fn run_parity_case(v: &Vector) {
        let ctx = &v.name;
        match v.case.as_str() {
            "checks" => {
                let inp: ChecksInput = input(v);
                let oracle = v2::RoleOracle::new(inp.memberships);
                let got =
                    v2::checks_state(&inp.runs, &inp.head_oid, &oracle, &inp.runners, &inp.policy);
                assert_eq!(got, expected::<v2::ChecksState>(v), "vector `{ctx}`");
            }
            "thread_meta" => {
                let inp: EventsInput = input(v);
                let got = v2::fold_thread_meta_v2(&inp.events);
                assert_eq!(got, expected::<v2::ThreadMeta>(v), "vector `{ctx}`");
            }
            "pinned" => {
                let inp: EventsInput = input(v);
                let got = v2::pinned_targets(&inp.events);
                assert_eq!(got, expected::<Vec<v2::PinnedTarget>>(v), "vector `{ctx}`");
            }
            "milestones" => {
                let inp: MilestonesInput = input(v);
                let got = v2::fold_milestones_v2(&inp.docs, &inp.items);
                assert_eq!(got, expected::<Vec<v2::Milestone>>(v), "vector `{ctx}`");
            }
            "hidden_items" => {
                let inp: HiddenItemsInput = input(v);
                let scope = v2::HideScope {
                    thread_id: inp.thread_id,
                    thread_author: inp.thread_author,
                    owner: inp.owner,
                    maintainers: inp.maintainers,
                    proved: inp.proved,
                };
                let got = v2::hidden_items(&inp.events, &scope, &inp.comments, &inp.reviews);
                assert_eq!(got, expected::<v2::HiddenItems>(v), "vector `{ctx}`");
            }
            "trending" => {
                let inp: TrendingInput = input(v);
                let got = serde_json::json!({
                    "window": v2::trending_window(inp.grid, inp.now, inp.selector),
                    "ranking": v2::trending_recount(&inp.beats, inp.grid, inp.now, inp.selector, inp.limit),
                });
                assert_eq!(got, v.expected, "vector `{ctx}`");
            }
            other => panic!("vector `{ctx}`: not a parity case `{other}`"),
        }
    }

    #[derive(Deserialize, Serialize)]
    #[serde(deny_unknown_fields)]
    struct Codes {
        codes: Vec<i64>,
    }

    #[derive(Deserialize, Serialize)]
    #[serde(deny_unknown_fields)]
    struct Sums {
        sums: Vec<i64>,
    }

    #[derive(Deserialize, Serialize)]
    #[serde(deny_unknown_fields)]
    struct Transitions {
        transitions: Vec<v2::Transition>,
    }

    #[derive(Deserialize, Serialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct CloseReasonInput {
        target_number: u32,
        transitions: Vec<v2::Transition>,
    }

    #[derive(Deserialize, Serialize)]
    #[serde(deny_unknown_fields)]
    struct Totals {
        issues: u64,
        patches: u64,
    }

    #[derive(Deserialize, Serialize)]
    #[serde(deny_unknown_fields)]
    struct Messages {
        messages: Vec<String>,
    }

    #[derive(Deserialize, Serialize)]
    #[serde(deny_unknown_fields)]
    struct CheckRunWriteInput {
        stored: Option<v2::StoredRun>,
        report: v2::RunReport,
        now: u64,
    }

    /// The transition, count, numbering and check-run cases (`transition__*`, `dense_number__*`,
    /// `upstream_number__*`, `check_run_write__*`).
    fn run_transition_case(v: &Vector) {
        let ctx = &v.name;
        match v.case.as_str() {
            "transition_moves" => {
                let inp: TransitionMovesInput = input(v);
                let got: Vec<Option<v2::TransitionMove>> = inp
                    .cases
                    .iter()
                    .map(|c| {
                        v2::next_transition(c.target, c.code, c.action, c.actor, c.target_number)
                    })
                    .collect();
                assert_eq!(
                    got,
                    expected::<Vec<Option<v2::TransitionMove>>>(v),
                    "vector `{ctx}`"
                );
            }
            "transition_status" => {
                let inp: Codes = input(v);
                let got: Vec<v2::StateStatus> =
                    inp.codes.iter().map(|&c| v2::status_of_code(c)).collect();
                assert_eq!(got, expected::<Vec<v2::StateStatus>>(v), "vector `{ctx}`");
            }
            "transition_fold" => {
                let inp: Sums = input(v);
                let got: Vec<serde_json::Value> = inp
                    .sums
                    .iter()
                    .map(|&s| {
                        let (code, locked) = v2::fold_sum(s);
                        serde_json::json!({ "code": code, "locked": locked })
                    })
                    .collect();
                assert_eq!(serde_json::Value::from(got), v.expected, "vector `{ctx}`");
            }
            "close_reason" => {
                let inp: CloseReasonInput = input(v);
                assert_eq!(
                    v2::current_close_reason(&inp.transitions, inp.target_number),
                    expected::<Option<v2::ClosedAs>>(v),
                    "vector `{ctx}`"
                );
            }
            "transition_sum" => {
                let inp: Transitions = input(v);
                let got = serde_json::json!({
                    "code": v2::state_code(&inp.transitions),
                    "mergeId": v2::merge_transition(&inp.transitions).map(|t| t.id.clone()),
                });
                assert_eq!(got, v.expected, "vector `{ctx}`");
            }
            "repo_counts" => {
                let inp: RepoCountsInput = input(v);
                let kinds = inp
                    .kinds
                    .iter()
                    .map(|(k, &n)| {
                        let k: u8 = k
                            .parse()
                            .unwrap_or_else(|_| panic!("vector `{ctx}`: kind {k}"));
                        (k, n)
                    })
                    .collect();
                let got = v2::repo_counts(inp.issues, inp.patches, &kinds);
                assert_eq!(got, expected::<v2::RepoCounts>(v), "vector `{ctx}`");
            }
            "dense_number" => {
                let inp: Totals = input(v);
                let got = v2::dense_number(inp.issues, inp.patches);
                assert_eq!(got, expected::<Option<u32>>(v), "vector `{ctx}`");
            }
            "dense_refusal" => {
                let inp: Messages = input(v);
                let got: Vec<bool> = inp
                    .messages
                    .iter()
                    .map(|m| v2::names_dense_rule(m))
                    .collect();
                assert_eq!(got, expected::<Vec<bool>>(v), "vector `{ctx}`");
            }
            "upstream_number" => {
                let inp: UpstreamNumberInput = input(v);
                let oracle = v2::RoleOracle::new(inp.memberships);
                let got = v2::trusted_upstream_number(
                    inp.upstream_number,
                    &inp.author,
                    &inp.repo_owner,
                    &oracle,
                );
                assert_eq!(got, expected::<Option<u32>>(v), "vector `{ctx}`");
            }
            "check_run_write" => {
                let inp: CheckRunWriteInput = input(v);
                let got = v2::check_run_write(inp.stored.as_ref(), &inp.report, inp.now);
                assert_eq!(got, expected::<Option<v2::RunWrite>>(v), "vector `{ctx}`");
            }
            other => panic!("vector `{ctx}`: not a transition case `{other}`"),
        }
    }

    /// The issue / PR state cases (`fold_issue_v2__*`, `fold_pr_v2__*`).
    fn run_fold_case(v: &Vector) {
        let ctx = &v.name;
        match v.case.as_str() {
            "fold_issue" => {
                let inp: FoldIssueV2Input = input(v);
                let (code, _) = state_of(ctx, inp.transitions.as_deref(), inp.sum, None);
                let got = v2::issue_state_v2(code, &inp.events);
                assert_eq!(got, expected::<IssueState>(v), "vector `{ctx}`");
            }
            "fold_pr" => {
                let inp: FoldPrV2Input = input(v);
                let (base_tip, ancestry) = fold_base(
                    ctx,
                    inp.base_history.as_ref(),
                    inp.base_tip.as_deref(),
                    &inp.ancestry,
                );
                let (code, merge_oid) = state_of(
                    ctx,
                    inp.transitions.as_deref(),
                    inp.sum,
                    inp.merge_oid.as_ref(),
                );
                let got = v2::pr_state_v2(
                    code,
                    merge_oid.as_deref(),
                    &inp.events,
                    base_tip.as_deref(),
                    |a, d| ancestry.is_ancestor(a, d),
                );
                assert_eq!(got, expected::<PrState>(v), "vector `{ctx}`");
            }
            other => panic!("vector `{ctx}`: not a fold case `{other}`"),
        }
    }

    /// The code owners cases (`code_owners__*`, `code_owner_requests__*`).
    fn run_code_owners_case(v: &Vector) {
        let ctx = &v.name;
        match v.case.as_str() {
            "code_owners" => {
                let inp: CodeOwnersInput = input(v);
                let parsed = codeowners::parse_code_owners(&inp.file);
                let all = parsed.owners_of_paths(&inp.paths);
                let owners: serde_json::Map<String, serde_json::Value> = inp
                    .paths
                    .iter()
                    .map(|p| (p.clone(), serde_json::json!(parsed.owners_of(p))))
                    .collect();
                let kinds: serde_json::Map<String, serde_json::Value> = all
                    .iter()
                    .map(|t| (t.clone(), serde_json::json!(codeowners::owner_kind(t))))
                    .collect();
                let got = serde_json::json!({
                    "owners": owners,
                    "all": all,
                    "kinds": kinds,
                    "errors": parsed.errors,
                });
                assert_eq!(got, v.expected, "vector `{ctx}`");
            }
            "code_owner_requests" => {
                let inp: CodeOwnerRequestsInput = input(v);
                let got = codeowners::code_owner_requests(
                    &inp.tokens,
                    &inp.resolved,
                    &v2::RoleOracle::new(inp.memberships),
                    &inp.author,
                );
                assert_eq!(
                    got,
                    expected::<codeowners::OwnerRequests>(v),
                    "vector `{ctx}`"
                );
            }
            other => panic!("vector `{ctx}`: not a code owners case `{other}`"),
        }
    }

    /// `pubkey_entry` and `commit_signature`: the signed-commit rules ([`super::signature`]).
    fn run_signature_case(v: &Vector) {
        #[derive(Deserialize, Serialize)]
        #[serde(deny_unknown_fields)]
        struct EntryInput {
            entry: String,
        }
        #[derive(Deserialize, Serialize)]
        #[serde(deny_unknown_fields)]
        struct CommitInput {
            commit: String,
            signers: Vec<super::signature::Signer>,
        }
        #[derive(Deserialize, Serialize)]
        #[serde(deny_unknown_fields)]
        struct TagInput {
            tag: String,
            signers: Vec<super::signature::Signer>,
        }
        let ctx = &v.name;
        let got = if v.case == "pubkey_entry" {
            let inp: EntryInput = input(v);
            serde_json::to_value(super::signature::read_pubkey_entry(&inp.entry))
        } else if v.case == "tag_signature" {
            let inp: TagInput = input(v);
            serde_json::to_value(super::signature::verify_tag_signature(
                inp.tag.as_bytes(),
                &inp.signers,
            ))
        } else {
            let inp: CommitInput = input(v);
            serde_json::to_value(super::signature::verify_commit_signature(
                inp.commit.as_bytes(),
                &inp.signers,
                false,
            ))
        };
        assert_eq!(got.expect("serialize"), v.expected, "vector `{ctx}`");
    }

    /// The protection and release-provenance conventions (epic E5): `default_protection`,
    /// `missing_default_protection`, `ref_update_route` and `release_provenance`.
    fn run_protection_case(v: &Vector) {
        let ctx = &v.name;
        match v.case.as_str() {
            "release_provenance" => {
                #[derive(serde::Deserialize)]
                #[serde(rename_all = "camelCase")]
                struct Input {
                    ref_name_hash: String,
                    updates: Vec<RefUpdate>,
                    configs: Vec<ConfigDoc>,
                    revisions: Vec<super::provenance::ProvenanceRevision>,
                    #[serde(default)]
                    pin: Option<String>,
                    #[serde(default)]
                    target: Option<String>,
                }
                let inp: Input =
                    serde_json::from_value(v.input.clone()).expect("release_provenance input");
                let got = super::provenance::release_provenance(
                    &inp.ref_name_hash,
                    &inp.updates,
                    &inp.configs,
                    &inp.revisions,
                    inp.pin.as_deref(),
                    inp.target.as_deref(),
                );
                assert_eq!(
                    serde_json::to_value(&got).expect("provenance json"),
                    v.expected,
                    "vector `{ctx}`"
                );
            }
            "ref_update_route" => {
                let name = v.input["refName"]
                    .as_str()
                    .expect("ref_update_route input: refName");
                let patterns: Option<Vec<String>> =
                    serde_json::from_value(v.input["patterns"].clone())
                        .expect("ref_update_route input: patterns");
                let owner = v.input["pusherIsOwner"]
                    .as_bool()
                    .expect("ref_update_route input: pusherIsOwner");
                let want = v.expected.as_str().expect("ref_update_route expected");
                let got = if routes_protected(name, patterns.as_deref(), owner) {
                    "protectedRefUpdate"
                } else {
                    "refUpdate"
                };
                assert_eq!(got, want, "vector `{ctx}`");
            }
            "missing_default_protection" => {
                let branch = v.input["defaultBranch"]
                    .as_str()
                    .expect("missing_default_protection input: defaultBranch");
                let patterns: Vec<String> = serde_json::from_value(v.input["patterns"].clone())
                    .expect("missing_default_protection input: patterns");
                let want: Vec<String> = serde_json::from_value(v.expected.clone())
                    .expect("missing_default_protection expected");
                assert_eq!(
                    missing_default_protection(branch, &patterns),
                    want,
                    "vector `{ctx}`"
                );
            }
            "default_protection" => {
                let branch = v.input["defaultBranch"]
                    .as_str()
                    .expect("default_protection input: defaultBranch");
                let want: Vec<String> = serde_json::from_value(v.expected.clone())
                    .expect("default_protection expected");
                assert_eq!(default_protected_patterns(branch), want, "vector `{ctx}`");
            }
            other => unreachable!("not a protection case: {other}"),
        }
    }

    /// `repo_name`: [`v2::is_valid_repo_name`] and [`v2::normalize_repo_name`].
    fn run_repo_name_case(v: &Vector) {
        let inp: RepoNameInput = input(v);
        let got = serde_json::json!({
            "valid": v2::is_valid_repo_name(&inp.name),
            "normalized": v2::normalize_repo_name(&inp.name),
        });
        assert_eq!(got, v.expected, "vector `{}`", v.name);
    }

    /// `mirror_backlink` and `mirror_backlink_file`: the mirror back-link ([`super::mirror`]).
    fn run_mirror_case(v: &Vector) {
        #[derive(Deserialize, Serialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct BacklinkInput {
            file: String,
            repo_id: String,
        }
        #[derive(Deserialize, Serialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct BacklinkFileInput {
            repo_ids: Vec<String>,
        }
        let ctx = &v.name;
        let got = if v.case == "mirror_backlink" {
            let inp: BacklinkInput = input(v);
            serde_json::to_value(super::mirror::read_backlink(&inp.file, &inp.repo_id))
                .expect("serialises")
        } else {
            let inp: BacklinkFileInput = input(v);
            serde_json::json!({ "file": super::mirror::backlink_file(&inp.repo_ids) })
        };
        assert_eq!(got, v.expected, "vector `{ctx}`");
    }

    /// `profile_input` and `avatar_config`: the profile rules ([`super::profile`]).
    fn run_profile_case(v: &Vector) {
        #[derive(Deserialize, Serialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct AvatarConfigInput {
            config: Option<String>,
            identity_id: String,
        }
        let ctx = &v.name;
        if v.case == "profile_bot" {
            #[derive(Deserialize, Serialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct BotInput {
                bot_id: String,
                bot: Option<super::profile::BotClaim>,
                operator: Option<super::profile::BotClaim>,
            }
            let inp: BotInput = input(v);
            let got =
                super::profile::bot_operator(&inp.bot_id, inp.bot.as_ref(), inp.operator.as_ref());
            assert_eq!(got, expected::<Option<String>>(v), "vector `{ctx}`");
            return;
        }
        if v.case == "profile_input" {
            let inp: super::profile::ProfileInput = input(v);
            let got = serde_json::to_value(super::profile::check_profile(&inp)).expect("serialize");
            assert_eq!(got, v.expected, "vector `{ctx}`");
        } else {
            let inp: AvatarConfigInput = input(v);
            let got = super::profile::avatar_spec(inp.config.as_deref(), &inp.identity_id);
            assert_eq!(
                got,
                expected::<super::profile::AvatarSpec>(v),
                "vector `{ctx}`"
            );
        }
    }

    /// The search grammar and matchers (`rules::search`), shared with forge-web's
    /// `issue-query.ts` / `pull-query.ts` / `issue-index.ts`.
    fn run_search_case(v: &Vector) {
        use super::search;
        let ctx = &v.name;
        let inp = &v.input;
        let s = |k: &str| inp[k].as_str().unwrap_or_default().to_string();
        let got = match v.case.as_str() {
            "search_issues" => serde_json::to_value(search::parse_issue_search(
                &s("text"),
                &search::IssueQuery::default(),
            )),
            "search_prs" => serde_json::to_value(search::parse_pull_search(
                &s("text"),
                &search::PullQuery::default(),
            )),
            "search_text" => serde_json::to_value(search::matches_text(
                &s("text"),
                &s("title"),
                inp["number"].as_u64().unwrap_or_default(),
                &s("body"),
                inp["scope"].as_str().unwrap_or("any"),
            )),
            "search_mentions" => {
                serde_json::to_value(search::mentions(&s("body"), &s("id"), inp["name"].as_str()))
            }
            other => panic!("vector `{ctx}`: not a search case `{other}`"),
        }
        .unwrap();
        assert_eq!(got, v.expected, "vector `{ctx}`");
    }

    fn run_approvals_case(v: &Vector) {
        let inp: ApprovalsInput = input(v);
        let oracle = v2::RoleOracle::new(inp.memberships);
        let got = v2::count_approvals(
            &inp.reviews,
            &oracle,
            &inp.head_oid,
            &inp.dismissed,
            &inp.pr_author,
        );
        assert_eq!(got, expected::<v2::Approvals>(v), "vector `{}`", v.name);
    }

    fn run_ref_collision_case(v: &Vector) {
        use super::ref_collision::{collision_reason, ref_collision};
        #[derive(Serialize, Deserialize)]
        struct In {
            existing: Vec<String>,
            name: String,
        }
        let inp: In = input(v);
        let collision = ref_collision(inp.existing.iter().map(String::as_str), &inp.name);
        let reason = collision.as_deref().map(|c| collision_reason(&inp.name, c));
        assert_eq!(
            serde_json::json!({ "collision": collision, "reason": reason }),
            v.expected,
            "vector `{}`",
            v.name
        );
    }

    fn run_merge_content_case(v: &Vector) {
        use super::merge_check;
        let got = merge_check::merge_content(&input::<merge_check::MergeFacts>(v));
        assert_eq!(
            got,
            expected::<merge_check::MergeContent>(v),
            "vector `{}`",
            v.name
        );
    }

    fn run_case_v2(v: &Vector) {
        let ctx = &v.name;
        match v.case.as_str() {
            "fold_issue" | "fold_pr" => run_fold_case(v),
            "transition_moves" | "transition_status" | "transition_sum" | "transition_fold"
            | "repo_counts" | "dense_number" | "dense_refusal" | "upstream_number"
            | "check_run_write" | "close_reason" => {
                run_transition_case(v);
            }
            "pack_copies" => run_pack_copies(v),
            "fork_sync" | "fork_refs" => run_fork_case(v),
            "v2_pack_list" => {
                let inp: V2PackListInput = input(v);
                let got = v2::v2_pack_list(&inp.copies, inp.as_of.as_ref());
                assert_eq!(got, expected::<Vec<v2::V2Pack>>(v), "vector `{ctx}`");
            }
            "approvals" => run_approvals_case(v),
            "well_formed" | "content_well_formed" => {
                let inp: WellFormedInput = input(v);
                let got = v2::content_well_formed(&inp.doc, inp.visibility);
                assert_eq!(got, expected::<bool>(v), "vector `{ctx}`");
            }
            "approval_count" | "mixed_edit" | "mixed_anchor" => run_mixed_case(v),
            "git_plane_well_formed" => {
                let inp: WellFormedInput = input(v);
                assert_eq!(
                    inp.visibility,
                    v2::Visibility::Public,
                    "vector `{ctx}`: the git plane is a public repository's"
                );
                let got = v2::git_plane_well_formed(&inp.doc);
                assert_eq!(got, expected::<bool>(v), "vector `{ctx}`");
            }
            "merge_base_tips" | "pr_base_tips" => {
                let inp: BaseHistory = input(v);
                assert_eq!(
                    inp.opened_at.is_some(),
                    v.case == "pr_base_tips",
                    "vector `{ctx}`: openedAt is given exactly for pr_base_tips"
                );
                assert_eq!(inp.tips(), expected::<MergeBaseTips>(v), "vector `{ctx}`");
            }
            c if c.starts_with("search_") => run_search_case(v),
            "pr_merge_base" => {
                let inp: PrMergeBaseInput = input(v);
                let got = v2::pr_merge_base(
                    &inp.base_ref_name,
                    inp.opened_at,
                    &inp.events,
                    inp.merged_at,
                );
                assert_eq!(got, expected::<v2::MergeBase>(v), "vector `{ctx}`");
            }
            "ref_collision" => run_ref_collision_case(v),
            "merge_content" => run_merge_content_case(v),
            "ref_name_hashes" => {
                let inp: RefNameHashesInput = input(v);
                let key: Option<[u8; 32]> = inp.ref_key.as_deref().map(|k| {
                    hex::decode(k)
                        .ok()
                        .and_then(|b| <[u8; 32]>::try_from(b).ok())
                        .unwrap_or_else(|| panic!("vector `{ctx}`: refKey must be 32 bytes hex"))
                });
                let got = v2::ref_name_hashes_agree(&inp.doc, key.as_ref());
                assert_eq!(got, expected::<bool>(v), "vector `{ctx}`");
            }
            "profile_input" | "avatar_config" | "profile_bot" => run_profile_case(v),
            "closed_by_pr" => {
                #[derive(Deserialize, Serialize)]
                #[serde(rename_all = "camelCase", deny_unknown_fields)]
                struct ClosedByInput {
                    issue: u32,
                    closed_by_pr: Option<u32>,
                    pr: Option<super::transition::ClosingPr>,
                }
                let inp: ClosedByInput = input(v);
                let got =
                    super::transition::closed_by_pr(inp.issue, inp.closed_by_pr, inp.pr.as_ref());
                assert_eq!(got, expected::<Option<u32>>(v), "vector `{}`", v.name);
            }
            "mirror_backlink" | "mirror_backlink_file" => run_mirror_case(v),
            "pubkey_entry" | "commit_signature" | "tag_signature" => run_signature_case(v),
            "repo_name" => run_repo_name_case(v),
            "webhook_url" => run_webhook_url_case(v),
            "role_oracle" => run_role_oracle(v),
            "code_owners" | "code_owner_requests" => run_code_owners_case(v),
            "fold_review" | "policy" | "anchor" | "review_group" | "suggestion"
            | "linked_issues" => run_review_case(v),
            "checks" | "thread_meta" | "pinned" | "milestones" | "trending" | "hidden_items" => {
                run_parity_case(v);
            }
            "long_body" => run_long_body(v),
            "ci_rerun" | "ci_rerun_write" => run_ci_rerun_case(v),
            "key_handoff" | "key_handoff_open" | "copy" => run_key_handoff_case(v),
            other => panic!("vector `{ctx}`: unknown v2 case `{other}`"),
        }
    }

    fn run_role_oracle(v: &Vector) {
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
                    "approverAt": oracle.approver_at(&q.identity, q.at),
                })
            })
            .collect();
        assert_eq!(
            serde_json::Value::from(got),
            v.expected,
            "vector `{}`",
            v.name
        );
    }

    #[derive(Deserialize, Serialize)]
    #[serde(deny_unknown_fields, rename_all = "camelCase")]
    struct KeyHandoffInput {
        network: String,
        browser_secret: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        ephemeral_secret: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        nonce: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        plaintext: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reply: Option<String>,
    }

    #[derive(Deserialize, Serialize)]
    #[serde(deny_unknown_fields)]
    struct CopyInput {
        id: String,
    }

    /// `key_handoff__*` (seal a reply for a request), `key_handoff_open__*` (open one) and
    /// `copy__*` (fixed user-facing text): `crate::browser_key`.
    fn run_key_handoff_case(v: &Vector) {
        use crate::browser_key::{open, request_text, seal_bytes, OpenError, Request};
        let ctx = &v.name;
        if v.case == "copy" {
            let inp: CopyInput = input(v);
            let text = match inp.id.as_str() {
                "recoveryPhraseWarning" => crate::browser_key::RECOVERY_PHRASE_WARNING,
                other => panic!("vector `{ctx}`: unknown copy `{other}`"),
            };
            assert_eq!(
                serde_json::json!({ "text": text }),
                v.expected,
                "vector `{ctx}`"
            );
            return;
        }
        let inp: KeyHandoffInput = input(v);
        let h32 = |s: &str| -> [u8; 32] {
            hex::decode(s)
                .unwrap_or_else(|e| panic!("vector `{ctx}`: {e}"))
                .try_into()
                .unwrap_or_else(|_| panic!("vector `{ctx}`: not 32 bytes"))
        };
        let secret = h32(&inp.browser_secret);
        let opened = |reply: &str| match open(reply, &inp.network, &secret) {
            Ok(p) => serde_json::json!({ "plaintext": String::from_utf8(p.to_vec()).unwrap() }),
            Err(e) => serde_json::json!({ "error": match e {
                OpenError::Malformed => "malformed",
                OpenError::Network => "network",
                OpenError::Unreadable => "unreadable",
            } }),
        };
        if v.case == "key_handoff_open" {
            let reply = inp.reply.as_deref().expect("reply");
            assert_eq!(opened(reply), v.expected, "vector `{ctx}`");
            return;
        }
        let secp = secp256k1::Secp256k1::new();
        let public_key = secp256k1::PublicKey::from_secret_key(
            &secp,
            &secp256k1::SecretKey::from_slice(&secret).unwrap(),
        );
        let request = Request {
            network: inp.network.clone(),
            public_key,
        };
        let plaintext = inp.plaintext.as_deref().expect("plaintext");
        let nonce: [u8; 12] = hex::decode(inp.nonce.as_deref().expect("nonce"))
            .unwrap()
            .try_into()
            .unwrap();
        let reply = seal_bytes(
            &request,
            plaintext.as_bytes(),
            &h32(inp.ephemeral_secret.as_deref().expect("ephemeralSecret")),
            nonce,
        )
        .unwrap();
        let got = serde_json::json!({
            "request": request_text(&inp.network, &public_key),
            "reply": reply,
        });
        assert_eq!(got, v.expected, "vector `{ctx}`");
        assert_eq!(
            opened(&reply),
            serde_json::json!({ "plaintext": plaintext }),
            "vector `{ctx}`: round trip"
        );
    }

    #[derive(Deserialize, Serialize)]
    #[serde(deny_unknown_fields, rename_all = "camelCase")]
    struct LongBodyInput {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        stored: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        full: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        room: Option<usize>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        sha256: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        blob_hex: Option<String>,
    }

    /// `webhook_url`: the secret a webhook URL carries in its path, by its shape.
    fn run_webhook_url_case(v: &Vector) {
        use crate::webhooks::{url_secret, UrlSecret};
        #[derive(Deserialize, Serialize)]
        #[serde(deny_unknown_fields)]
        struct Input {
            url: String,
        }
        let inp: Input = input(v);
        let got = match url_secret(&inp.url) {
            Some(UrlSecret::ChatService(name)) => {
                serde_json::json!({ "secret": "chatService", "service": name })
            }
            Some(UrlSecret::PathToken) => serde_json::json!({ "secret": "pathToken" }),
            None => serde_json::json!({ "secret": null }),
        };
        assert_eq!(got, v.expected, "vector `{}`", v.name);
    }

    /// `long_body__*` (forge-v2.md §6.3): `{stored}` reads a field, `{full, room, sha256}`
    /// stores a text, `{stored, blobHex}` opens a public artifact.
    fn run_long_body(v: &Vector) {
        use long_body::{needs_artifact, open_public, parse, stored_text, LongBody};
        let ctx = &v.name;
        let inp: LongBodyInput = input(v);
        let got = match (&inp.stored, &inp.full, &inp.blob_hex) {
            (Some(stored), None, None) => match parse(stored) {
                LongBody::Plain => serde_json::json!({ "kind": "plain" }),
                LongBody::Continued {
                    prefix,
                    sha256,
                    bytes,
                } => serde_json::json!({
                    "kind": "continued",
                    "prefix": prefix,
                    "sha256": hex::encode(sha256),
                    "bytes": bytes,
                }),
                LongBody::Unsupported { prefix } => {
                    serde_json::json!({ "kind": "unsupported", "prefix": prefix })
                }
            },
            (None, Some(full), None) => {
                let room = inp.room.unwrap_or_else(|| panic!("vector `{ctx}`: room"));
                let mut sha = [0u8; 32];
                hex::decode_to_slice(inp.sha256.as_deref().unwrap_or_default(), &mut sha)
                    .unwrap_or_else(|e| panic!("vector `{ctx}`: sha256: {e}"));
                let needs = needs_artifact(full, room);
                let stored = if needs {
                    stored_text(full, room, &sha)
                } else {
                    None
                };
                serde_json::json!({ "needsArtifact": needs, "stored": stored })
            }
            (Some(stored), None, Some(blob)) => {
                let blob = hex::decode(blob).unwrap_or_else(|e| panic!("vector `{ctx}`: {e}"));
                match open_public(stored, &blob) {
                    Ok(text) => serde_json::json!({ "text": text }),
                    Err(e) => serde_json::json!({ "error": e.as_str() }),
                }
            }
            _ => panic!(
                "vector `{ctx}`: one of {{stored}}, {{full, room, sha256}}, {{stored, blobHex}}"
            ),
        };
        assert_eq!(got, v.expected, "vector `{ctx}`");
    }

    /// Load every `forge-contracts/vectors/*.json` and assert the rules reproduce
    /// `expected`, dispatching on the vector's `rules` (absent means a base rule). This is the suite the
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

        let (mut ran_base, mut ran_v2) = (0usize, 0usize);
        for path in files {
            let bytes = std::fs::read(&path).expect("read vector");
            let v: Vector = serde_json::from_slice(&bytes)
                .unwrap_or_else(|e| panic!("parse {}: {e}", path.display()));
            // the private-repository and mixed-visibility envelope vectors run in
            // `private::conformance`
            if crate::private::conformance::CRYPTO_CASE_PREFIXES
                .iter()
                .any(|p| v.case.starts_with(p))
            {
                continue;
            }
            match v.rules.as_deref() {
                None => {
                    run_case(&v);
                    ran_base += 1;
                }
                Some("v2") => {
                    run_case_v2(&v);
                    ran_v2 += 1;
                }
                Some(other) => panic!("vector `{}`: unknown rules `{other}`", v.name),
            }
        }
        assert!(ran_base >= 45, "ran {ran_base} base vectors, expected 45+");
        assert!(ran_v2 >= 110, "ran {ran_v2} v2 vectors, expected 110+");
        println!("conformance_vectors: {ran_base} base + {ran_v2} v2 vectors green");
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
        // happens to sort *after* C's. Within one block the prevOid chain orders them: the head is C,
        // never Unborn.
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

    /// D-600 as a property: over every short history built from a few tips (fast-forwards,
    /// forces, deletes, with and without `prevOid`, spread over one or two blocks), a ref is
    /// Unborn exactly when its causally newest update is a deletion, and the answer does not
    /// depend on the order the updates were read in.
    #[test]
    fn newest_non_null_update_never_resolves_unborn() {
        const OIDS: [&str; 4] = ["A", "B", "C", "0"];
        let mk = |i: usize, code: usize| -> RefUpdate {
            // code: new (4) x prev (4) x force (2) x block (2)
            let new = OIDS[code % 4];
            let prev = OIDS[(code / 4) % 4];
            RefUpdate {
                id: format!("u{i}"),
                ref_name_hash: "H".into(),
                ref_name: "refs/heads/main".into(),
                prev_oid: prev.into(),
                new_oid: new.into(),
                force: (code / 16) % 2 == 1,
                protected: false,
                author: "a".into(),
                created_at: 100 * (i as u64 / 2 + 1) + 100 * ((code / 32) as u64 % 2),
            }
        };
        let mut checked = 0u32;
        for a in 0..64 {
            for b in 0..64 {
                for c in (0..64).step_by(3) {
                    let ups = vec![mk(0, a), mk(1, b), mk(2, c)];
                    let got = resolve_ref(&ups, &[], "H", |x, y| x == y);
                    let order = super::valid_updates(&ups, &[], "H");
                    let newest = order.last().expect("three updates");
                    assert_eq!(
                        got == RefState::Unborn,
                        super::is_null_oid(&newest.new_oid),
                        "{ups:?}"
                    );
                    let reversed: Vec<RefUpdate> = ups.iter().rev().cloned().collect();
                    assert_eq!(
                        got,
                        resolve_ref(&reversed, &[], "H", |x, y| x == y),
                        "{ups:?}"
                    );
                    checked += 1;
                }
            }
        }
        assert!(checked > 80_000);
    }

    /// The causal order's invariant, exhaustively over one-block histories of five updates on
    /// four tips: an update is placed before one it builds on only when that one builds back
    /// on it, through updates placed no earlier than the first (they share a cycle).
    #[test]
    fn causal_order_places_no_update_before_its_predecessor() {
        const OIDS: [&str; 4] = ["A", "B", "C", "D"];
        let pairs: Vec<(usize, usize)> = (0..4)
            .flat_map(|p| (0..4).map(move |q| (p, q)))
            .filter(|(p, q)| p != q)
            .collect();
        let mut checked = 0u32;
        let mut code = [0usize; 5];
        'all: loop {
            let ups: Vec<RefUpdate> = code
                .iter()
                .enumerate()
                .map(|(i, &c)| RefUpdate {
                    id: ["a", "b", "c", "d", "e"][i].into(),
                    ref_name_hash: "H".into(),
                    ref_name: "refs/heads/main".into(),
                    prev_oid: OIDS[pairs[c].0].into(),
                    new_oid: OIDS[pairs[c].1].into(),
                    force: false,
                    protected: false,
                    author: "a".into(),
                    created_at: 100,
                })
                .collect();
            let order = super::causal_order(ups.iter().collect());
            let reaches = |from: usize, to: usize, within: usize| -> bool {
                // `from` builds on `to` through updates at positions >= `within`
                let mut seen = vec![false; order.len()];
                let mut todo = vec![from];
                while let Some(x) = todo.pop() {
                    for y in within..order.len() {
                        if !seen[y] && super::builds_on(order[x], order[y]) {
                            if y == to {
                                return true;
                            }
                            seen[y] = true;
                            todo.push(y);
                        }
                    }
                }
                false
            };
            for u in 0..order.len() {
                for v in u + 1..order.len() {
                    if super::builds_on(order[u], order[v]) {
                        assert!(
                            reaches(v, u, u),
                            "{:?} placed before its predecessor {:?} in {ups:?}",
                            order[u].id,
                            order[v].id
                        );
                    }
                }
            }
            checked += 1;
            for d in &mut code {
                *d += 1;
                if *d < pairs.len() {
                    continue 'all;
                }
                *d = 0;
            }
            break;
        }
        assert_eq!(checked, 12u32.pow(5));
    }
}
