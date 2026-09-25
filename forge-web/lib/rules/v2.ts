/**
 * FORGE_RULES_V2 — the client rules for forge-v2 repositories (TypeScript port).
 *
 * Ports `crates/forge-core/src/rules/v2.rs` function for function; the conformance vectors
 * with `"rules": "v2"` in `forge-contracts/vectors/` hold the two in parity. See the Rust
 * module and `docs/contracts/forge-v2.md` (§3 events, §4 packs, §5 private repos, §6
 * numbering and approvals) for the normative text.
 *
 * The event order and per-kind effects are v1's own (`./fold`), so the two rule versions
 * cannot drift apart where they are meant to agree.
 */

import {
  applyIssueEvent,
  applyPrEvent,
  issueStateOf,
  mergeReachable,
  newIssueAcc,
  newPrAcc,
  prStateOf,
  sorted,
} from './fold'
import { compareKey } from './oid'
import type { Event, IsAncestor, IssueState, Oid, PrState } from './types'

/** The versioned rules identifier for forge-v2 repositories. */
export const FORGE_RULES_V2 = 'FORGE_RULES_V2' as const

// ---------------------------------------------------------------------------
// Membership
// ---------------------------------------------------------------------------

/** A membership role: which forge-core document type grants it. Maintainer ranks first. */
export type Role = 'maintainer' | 'writer'

/** One current `maintainer` or `writer` document of a repository, flattened. */
export interface Membership {
  /** `memberId`. */
  readonly identity: string
  readonly role: Role
  /** Consensus `$createdAt` (ms). */
  readonly createdAt: number
}

function betterRole(a: Role | null, b: Role): Role {
  return a === 'maintainer' || b === 'maintainer' ? 'maintainer' : 'writer'
}

/**
 * Membership of one repository, from its current membership documents. A revoked member's
 * document is deleted, so they are absent; a re-added member's membership starts at their
 * new document's `createdAt`.
 */
export class RoleOracle {
  constructor(readonly memberships: readonly Membership[]) {}

  /** The best role `identity` held at `at` (a current document with `createdAt <= at`). */
  roleAt(identity: string, at: number): Role | null {
    let role: Role | null = null
    for (const m of this.memberships) {
      if (m.identity === identity && m.createdAt <= at) role = betterRole(role, m.role)
    }
    return role
  }

  /** Whether `identity` was a maintainer or writer at `at`. */
  memberAt(identity: string, at: number): boolean {
    return this.roleAt(identity, at) !== null
  }

  /** The best role `identity` holds now (any current document). */
  currentRole(identity: string): Role | null {
    return this.roleAt(identity, Number.POSITIVE_INFINITY)
  }
}

// ---------------------------------------------------------------------------
// Issue / PR fold
// ---------------------------------------------------------------------------

/** An `authorEvent` applies only if it is a close or reopen by the target's author. */
function authorEventApplies(e: Event, targetAuthor: string): boolean {
  return (e.kind === 'close' || e.kind === 'reopen') && e.actor === targetAuthor
}

/** Both document types, applicable ones only, in v1's `(createdAt, id)` order (stable). */
function mergedLog(
  events: readonly Event[],
  authorEvents: readonly Event[],
  targetAuthor: string,
): Event[] {
  return [...events, ...authorEvents.filter((e) => authorEventApplies(e, targetAuthor))].sort(
    compareKey,
  )
}

/** Fold an issue's `event` and `authorEvent` documents into its {@link IssueState}. */
export function foldIssueStateV2(
  events: readonly Event[],
  authorEvents: readonly Event[],
  targetAuthor: string,
): IssueState {
  const s = newIssueAcc()
  for (const e of mergedLog(events, authorEvents, targetAuthor)) applyIssueEvent(s, e)
  return issueStateOf(s)
}

/** Fold a PR's `event` and `authorEvent` documents; a merge needs a reachable `oid`. */
export function foldPrStateV2(
  events: readonly Event[],
  authorEvents: readonly Event[],
  targetAuthor: string,
  baseTip: string | undefined,
  isAncestor: IsAncestor,
): PrState {
  const s = newPrAcc()
  for (const e of mergedLog(events, authorEvents, targetAuthor)) {
    if (e.kind === 'merge' && !mergeReachable(e, baseTip, isAncestor)) continue
    applyPrEvent(s, e)
  }
  return prStateOf(s)
}

// ---------------------------------------------------------------------------
// Numbering
// ---------------------------------------------------------------------------

const MAX_NUMBER = 0xffff_ffff

/** `min(2 × count + 100, 2^32 − 1)`: taken numbers above it are ignored as squatters. */
export function numberCeiling(count: number): number {
  return Math.min(2 * count + 100, MAX_NUMBER)
}

/**
 * The number to claim for a new issue (or PR), `forge-v2.md` §6: the first free number above
 * `base`, the largest taken number at or below the ceiling (0 if none). `null` when every
 * number from `base + 1` to `2^32 − 1` is taken.
 */
export function allocateNumber(count: number, takenNumbersDesc: readonly number[]): number | null {
  const ceiling = numberCeiling(count)
  const taken = new Set(takenNumbersDesc)
  let base = 0
  for (const n of taken) if (n <= ceiling && n > base) base = n
  let candidate = base + 1
  while (taken.has(candidate)) candidate++
  return candidate <= MAX_NUMBER ? candidate : null
}

// ---------------------------------------------------------------------------
// Pack copies
// ---------------------------------------------------------------------------

/** One writer's `packManifest` for a pack, with whether its bytes verified (caller-checked). */
export interface PackCopy {
  readonly id: string
  readonly packHash: string
  /** The uploader's current role ({@link RoleOracle.currentRole}); null once revoked. */
  readonly ownerRole?: Role | null
  readonly createdAt: number
  readonly verified?: boolean
  readonly supersedes?: readonly string[]
}

function roleRank(role: Role | null | undefined): number {
  return role === 'maintainer' ? 0 : role === 'writer' ? 1 : 2
}

function compareCopies(a: PackCopy, b: PackCopy): number {
  return roleRank(a.ownerRole) - roleRank(b.ownerRole) || compareKey(a, b)
}

/** The order a reader tries a pack's copies in: role, then `createdAt`, then `id`. */
export function orderPackCopies(copies: readonly PackCopy[]): PackCopy[] {
  return [...copies].sort(compareCopies)
}

/** The first verified copy in {@link orderPackCopies} order, or null. */
export function selectPackCopy(copies: readonly PackCopy[]): PackCopy | null {
  return orderPackCopies(copies).find((c) => c.verified === true) ?? null
}

/** One readable pack in {@link packReadOrder}. */
export interface PackPick {
  readonly packHash: string
  readonly copyId: string
  readonly superseded: boolean
}

function compareStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Every readable pack of a repo, in fetch order: per pack hash the selected copy (packs with
 * no verified copy left out); packs a selected copy of another pack supersedes go last, not
 * dropped; then `createdAt`, then `packHash`.
 */
export function packReadOrder(copies: readonly PackCopy[]): PackPick[] {
  const hashes = [...new Set(copies.map((c) => c.packHash))].sort(compareStr)
  const selected: PackCopy[] = []
  for (const hash of hashes) {
    const pick = selectPackCopy(copies.filter((c) => c.packHash === hash))
    if (pick !== null) selected.push(pick)
  }
  const superseded = new Set<string>()
  for (const c of selected) {
    for (const s of c.supersedes ?? []) if (s !== c.packHash) superseded.add(s)
  }
  const isSuperseded = (c: PackCopy) => superseded.has(c.packHash)
  selected.sort(
    (a, b) =>
      Number(isSuperseded(a)) - Number(isSuperseded(b)) ||
      a.createdAt - b.createdAt ||
      compareStr(a.packHash, b.packHash),
  )
  return selected.map((c) => ({ packHash: c.packHash, copyId: c.id, superseded: isSuperseded(c) }))
}

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

/** A `review` document, flattened. */
export interface Review {
  readonly id: string
  readonly reviewer: string
  /** 1 approve, 2 request changes, 3 comment. */
  readonly verdict: number
  readonly commitOid: Oid
  readonly createdAt: number
}

/** The reviewers whose verdict stands on a PR's current head (each sorted). */
export interface Approvals {
  readonly approvers: readonly string[]
  readonly changesRequested: readonly string[]
}

/**
 * Count a PR's approvals, `forge-v2.md` §6: only reviews on `headOid` by a reviewer who was
 * a member at the review's `createdAt`; a reviewer's newest approve / request-changes review
 * by `(createdAt, id)` stands; comment and unknown verdicts are ignored.
 */
export function countApprovals(
  reviews: readonly Review[],
  oracle: RoleOracle,
  headOid: string,
): Approvals {
  const approvers = new Set<string>()
  const changesRequested = new Set<string>()
  const counting = reviews
    .filter(
      (r) =>
        (r.verdict === 1 || r.verdict === 2) &&
        r.commitOid === headOid &&
        oracle.memberAt(r.reviewer, r.createdAt),
    )
    .sort(compareKey)
  for (const r of counting) {
    const [add, clear] = r.verdict === 1 ? [approvers, changesRequested] : [changesRequested, approvers]
    clear.delete(r.reviewer)
    add.add(r.reviewer)
  }
  return { approvers: sorted(approvers), changesRequested: sorted(changesRequested) }
}

// ---------------------------------------------------------------------------
// Well-formedness
// ---------------------------------------------------------------------------

export type Visibility = 'public' | 'private'

export type ContentKind = 'issue' | 'patch' | 'comment' | 'review' | 'refUpdate'

/** A document's content fields. An absent field and an empty string are the same. */
export interface ContentDoc {
  readonly kind: ContentKind
  readonly title?: string | null
  readonly body?: string | null
  readonly refName?: string | null
  readonly baseRefName?: string | null
  readonly sourceRefName?: string | null
  /** `enc`, hex. */
  readonly enc?: string | null
  readonly epoch?: number | null
}

function present(s: string | null | undefined): boolean {
  return s != null && s.length > 0
}

/**
 * Plaintext xor `enc`, and the visibility says which: a public repo's document has no `enc`
 * and its kind's required plaintext field; a private repo's has a non-empty `enc`, an `epoch`
 * and none of its kind's plaintext fields.
 */
export function isWellFormed(doc: ContentDoc, visibility: Visibility): boolean {
  const [required, others]: [string | null | undefined, (string | null | undefined)[]] =
    doc.kind === 'issue'
      ? [doc.title, [doc.body]]
      : doc.kind === 'patch'
        ? [doc.title, [doc.body, doc.baseRefName, doc.sourceRefName]]
        : doc.kind === 'refUpdate'
          ? [doc.refName, []]
          : [doc.body, []]
  const encrypted = present(doc.enc)
  if (visibility === 'public') return !encrypted && present(required)
  return encrypted && doc.epoch != null && !present(required) && !others.some(present)
}

// ---------------------------------------------------------------------------
// Repository names
// ---------------------------------------------------------------------------

const REPO_NAME = /^[a-z0-9][a-z0-9._-]{0,62}$/

/** Whether `name` is a valid `repo.name` (the contract's pattern). */
export function isValidRepoName(name: string): boolean {
  return REPO_NAME.test(name)
}

/** ASCII letters lowercased, nothing else changed; null when the result is not valid. */
export function normalizeRepoName(input: string): string | null {
  const lowered = input.replace(/[A-Z]/g, (c) => c.toLowerCase())
  return isValidRepoName(lowered) ? lowered : null
}
