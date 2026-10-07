/**
 * Review parity rules — the TypeScript port of `crates/forge-core/src/rules/review.rs`
 * (`docs/design/review-parity-spec.md` §5, part of FORGE_RULES_V2). The `"rules": "v2"` vectors
 * `fold_review_v2__*`, `policy__*`, `anchor__*`, `review_group__*`, `suggestion__*` and
 * `linked_issues__*` hold the two in parity.
 *
 * Every function is pure.
 */

import { compareKey, compareStrings } from './oid'
import type { Approvals, RoleOracle } from './v2'
import type { Event, EventKind, Oid } from './types'

// ---------------------------------------------------------------------------
// The review fold
// ---------------------------------------------------------------------------

/** The `authorEvent` kind enum (11–14, 16); an author's close, reopen, draft and ready are transitions. */
const AUTHOR_KINDS: ReadonlySet<EventKind> = new Set<EventKind>([
  'threadResolve',
  'threadUnresolve',
  'reviewRequest',
  'reviewRequestRemove',
  'headUpdate',
])

/** The kinds an `authorEvent` may carry (the forge-collab schema's `kind` enum). */
export function isAuthorKind(kind: EventKind): boolean {
  return AUTHOR_KINDS.has(kind)
}

/** An `authorEvent` applies only if it is an author kind by the target's author. */
export function authorEventApplies(e: Event, targetAuthor: string): boolean {
  return isAuthorKind(e.kind) && e.actor === targetAuthor
}

/** Both document types, applicable ones only, in `(createdAt, id)` order (stable). */
export function mergedLog(events: readonly Event[], authorEvents: readonly Event[], targetAuthor: string): Event[] {
  return [...events, ...authorEvents.filter((e) => authorEventApplies(e, targetAuthor))].sort(compareKey)
}

/** One applied `headUpdate`. */
export interface HeadUpdate {
  readonly oid: Oid
  readonly actor: string
  readonly createdAt: number
  readonly id: string
}

/** A standing review request. */
export interface RequestedReviewer {
  readonly identity: string
  readonly requestedAt: number
}

/** A dismissed review. */
export interface Dismissal {
  readonly reviewId: string
  readonly actor: string
  readonly reason: string
  readonly createdAt: number
}

/** A PR's review state ({@link foldPrReviewV2}). */
export interface PrReviewState {
  /** The newest applied `headUpdate`'s oid, else the patch's `headOid`. */
  readonly head: Oid
  /** Applied head updates, oldest first. */
  readonly headUpdates: readonly HeadUpdate[]
  /** Standing requests, by identity (code-point order). */
  readonly requestedReviewers: readonly RequestedReviewer[]
  /** Resolved thread roots (code-point order), only roots in `knownRoots`. */
  readonly resolvedThreads: readonly string[]
  /** Dismissed reviews by review id (code-point order); the first dismissal stands. */
  readonly dismissedReviews: readonly Dismissal[]
  readonly milestone: string | null
}

function present(v: string | null | undefined): string | null {
  return v == null || v === '' ? null : v
}

/** Sort a map's entries by key in code-point order (Rust's `BTreeMap` order). */
function byKey<T>(m: Map<string, T>): [string, T][] {
  return [...m.entries()].sort(([a], [b]) => compareStrings(a, b))
}

/**
 * Fold a PR's `event` and `authorEvent` documents into its {@link PrReviewState} (the Rust
 * `fold_pr_review_v2`): `(createdAt, id)` order, `event`s first at equal keys; an
 * `authorEvent` applies only for an author kind by `targetAuthor`. Kinds 11–18 without their
 * payload are inert; a resolve naming a root outside `knownRoots` is inert.
 */
export function foldPrReviewV2(
  events: readonly Event[],
  authorEvents: readonly Event[],
  targetAuthor: string,
  initialHead: string,
  knownRoots: ReadonlySet<string>,
): PrReviewState {
  const log = mergedLog(events, authorEvents, targetAuthor)
  const headUpdates: HeadUpdate[] = []
  const requested = new Map<string, number | null>()
  const resolved = new Map<string, boolean>()
  const dismissed = new Map<string, Dismissal>()
  let milestone: string | null = null
  for (const e of log) {
    const ref = present(e.refId)
    switch (e.kind) {
      case 'headUpdate': {
        const oid = present(e.oid)?.toLowerCase() ?? null
        if (oid !== null && HEX_OID.test(oid)) headUpdates.push({ oid, actor: e.actor, createdAt: e.createdAt, id: e.id ?? '' })
        break
      }
      case 'reviewRequest':
      case 'reviewRequestRemove':
        if (ref !== null) requested.set(ref, e.kind === 'reviewRequest' ? e.createdAt : null)
        break
      case 'threadResolve':
      case 'threadUnresolve':
        if (ref !== null && knownRoots.has(ref)) resolved.set(ref, e.kind === 'threadResolve')
        break
      case 'reviewDismiss':
        if (ref !== null && !dismissed.has(ref)) {
          dismissed.set(ref, { reviewId: ref, actor: e.actor, reason: e.value ?? '', createdAt: e.createdAt })
        }
        break
      case 'milestoneSet': {
        const v = present(e.value)
        if (v !== null) milestone = v
        break
      }
      case 'milestoneClear':
        milestone = null
        break
      default:
        break
    }
  }
  return {
    head: headUpdates.at(-1)?.oid ?? initialHead,
    headUpdates,
    requestedReviewers: byKey(requested).flatMap(([identity, at]) => (at === null ? [] : [{ identity, requestedAt: at }])),
    resolvedThreads: byKey(resolved).flatMap(([root, r]) => (r ? [root] : [])),
    dismissedReviews: byKey(dismissed).map(([, d]) => d),
    milestone,
  }
}

// ---------------------------------------------------------------------------
// Branch policy
// ---------------------------------------------------------------------------

/** A `policy` document, flattened (the newest by `(createdAt, id)` is in force). */
export interface Policy {
  readonly requiredApprovals: number
  /** 0 any approver (a maintainer or role-1 writer), 1 maintainers only. */
  readonly approverRole?: number
  readonly requireChecks?: boolean
  /** 1 ff, 2 merge commit, 4 squash, 8 rebase; 0 any. */
  readonly mergeMethods?: number
  /** Checks that must pass by name (set by `dg`; the web keeps them on a rewrite). */
  readonly requiredChecks?: readonly string[]
  /** Each required check's source, a runner or maintainer id (base58), paired by position; empty: any. */
  readonly requiredCheckSources?: readonly string[]
  /**
   * `requireCodeOwners` (UPDATE-1; absent on a version-1 policy: off): every changed file with code
   * owners needs one of its owners' approval (`codeOwnerReview`).
   */
  readonly requireCodeOwners?: boolean
}

export interface PolicyStatus {
  /** `have >= need`, and no approver's standing request for changes blocks the merge. */
  readonly met: boolean
  readonly have: number
  readonly need: number
  /**
   * Reviewers whose standing request for changes blocks the merge (sorted): when the policy
   * requires approvals, a request for changes from someone whose approval would count blocks it,
   * as on GitHub, until they approve or it is dismissed (event kind 15).
   */
  readonly blockedBy: readonly string[]
}

/**
 * Whether `approvals` (from `countApprovals` on the current head, dismissed reviews and the PR
 * author's own reviews excluded) meet `policy`: approvers whose current role satisfies `approverRole`
 * (0: a maintainer or role-1 writer, never triage or reader; 1: maintainers only). When the
 * policy requires approvals, a standing request for changes from a reviewer whose approval would
 * count blocks it (`blockedBy`). Parity: forge-core `meets_policy`.
 */
/**
 * Whether `identity`'s verdict counts toward `policy` now: a current maintainer, or with
 * `approverRole` 0 a current role-1 writer (never triage or a reader). {@link meetsPolicy} and the
 * code owner rule judge approvers alike. Parity: forge-core `counts_for`.
 */
export function countsFor(oracle: RoleOracle, policy: Policy, identity: string): boolean {
  const role = oracle.currentRole(identity)
  return role === 'maintainer' || (role === 'writer' && (policy.approverRole ?? 0) === 0)
}

export function meetsPolicy(approvals: Approvals, oracle: RoleOracle, policy: Policy): PolicyStatus {
  const counts = (id: string): boolean => countsFor(oracle, policy, id)
  const have = approvals.approvers.filter(counts).length
  const blockedBy = policy.requiredApprovals === 0 ? [] : approvals.changesRequested.filter(counts)
  return { met: have >= policy.requiredApprovals && blockedBy.length === 0, have, need: policy.requiredApprovals, blockedBy }
}

// ---------------------------------------------------------------------------
// Anchors
// ---------------------------------------------------------------------------

/** A comment's anchor fields as stored (hex `commitOid`). */
export interface AnchorFields {
  readonly path?: string | null
  readonly line?: number | null
  readonly startLine?: number | null
  readonly side?: number | null
  readonly commitOid?: string | null
}

/** Where an inline comment points. `line`, `startLine`, `side` null: file-level. */
export interface Anchor {
  readonly path: string
  readonly line: number | null
  readonly startLine: number | null
  readonly side: 0 | 1 | null
  /** Lowercase hex, or `''`. */
  readonly commitOid: string
}

const HEX_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

/**
 * A comment's anchor, or null for a general comment (a malformed anchor is null too): `path`
 * non-empty; `line` ⇒ `side` ∈ {0, 1}; `side` without `line` malformed; `startLine` ⇒ `line`
 * and `startLine ≤ line`; `commitOid` empty or 40/64 hex.
 */
export function anchorOf(f: AnchorFields): Anchor | null {
  const path = present(f.path)
  if (path === null) return null
  const commitOid = (f.commitOid ?? '').toLowerCase()
  if (commitOid !== '' && !HEX_OID.test(commitOid)) return null
  const line = f.line ?? null
  const side = f.side ?? null
  const start = f.startLine ?? null
  if (line === null && side === null && start === null) {
    return { path, line: null, startLine: null, side: null, commitOid }
  }
  if (line === null || (side !== 0 && side !== 1)) return null
  const startLine = start ?? line
  if (startLine > line) return null
  return { path, line, startLine, side, commitOid }
}

// ---------------------------------------------------------------------------
// A review's comments
// ---------------------------------------------------------------------------

export interface ReviewComment {
  readonly id: string
  readonly owner: string
  readonly reviewId?: string | null
  readonly createdAt: number
}

export interface ReviewGroup {
  readonly comments: readonly string[]
  readonly landed: number
  readonly expected: number
}

/**
 * The comments of review `reviewId` by `reviewer`: `reviewId` matches **and** the owner is the
 * reviewer, `(createdAt, id)` order; `expected` is the review's `commentCount` (0 absent).
 */
export function groupReviewComments(
  reviewId: string,
  reviewer: string,
  commentCount: number | null | undefined,
  comments: readonly ReviewComment[],
): ReviewGroup {
  const mine = comments.filter((c) => c.reviewId === reviewId && c.owner === reviewer).sort(compareKey)
  return { comments: mine.map((c) => c.id), landed: mine.length, expected: commentCount ?? 0 }
}

// ---------------------------------------------------------------------------
// Suggestions
// ---------------------------------------------------------------------------

// The parser and the replacement live in `./suggestion` (no imports, so the fuzz worker can load
// it with plain Node).
export { applySuggestion, parseSuggestions, type Suggestion, type SuggestionError } from './suggestion'

// ---------------------------------------------------------------------------
// Linked issues
// ---------------------------------------------------------------------------

const LINK_VERBS: ReadonlySet<string> = new Set(['close', 'closes', 'closed', 'fix', 'fixes', 'fixed', 'resolve', 'resolves', 'resolved'])
const MAX_U32 = 0xffff_ffff

const isWord = (c: string | undefined): boolean => c !== undefined && /[A-Za-z0-9_]/.test(c)
const isAlpha = (c: string | undefined): boolean => c !== undefined && /[A-Za-z]/.test(c)
const isDigit = (c: string | undefined): boolean => c !== undefined && c >= '0' && c <= '9'

/**
 * The issue numbers `text` closes: `close[sd]` / `fix(e[sd])` / `resolve[sd]` (any case, a
 * whole word), optional `:`, whitespace, `#n` (positive, fits u32, not followed by a word
 * character). Deduplicated, ascending (the Rust `linked_issues`).
 */
export function linkedIssues(text: string): number[] {
  const out = new Set<number>()
  let i = 0
  while (i < text.length) {
    if (!isAlpha(text[i]) || (i > 0 && isWord(text[i - 1]))) {
      i++
      continue
    }
    const start = i
    while (i < text.length && isAlpha(text[i])) i++
    const word = text.slice(start, i).toLowerCase()
    if (isWord(text[i]) || !LINK_VERBS.has(word)) continue
    let j = i
    if (text[j] === ':') j++
    const ws = j
    while (text[j] === ' ' || text[j] === '\t') j++
    if (j === ws || text[j] !== '#') continue
    j++
    const digits = j
    while (isDigit(text[j])) j++
    if (j === digits || isWord(text[j])) continue
    // As the Rust `u32` parse: leading zeros are fine, a value past u32 is refused.
    const n = Number(text.slice(digits, j))
    if (n > 0 && n <= MAX_U32) out.add(n)
    i = j
  }
  return [...out].sort((a, b) => a - b)
}
