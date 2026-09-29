/**
 * Issue and PR state as `transition` documents — the TypeScript port of
 * `crates/forge-core/src/rules/transition.rs` (`docs/contracts/forge-v2.md` §3).
 *
 * Every state change is one immutable `transition` with a signed `delta`; consensus accepts it
 * only as a legal move from the target's current state, so the running sum of `delta` over a
 * target's transitions is its state code (0 open, 1 closed, 2 merged, 8 open draft, 9 closed
 * draft; bit 0 closed, bit 1 merged, bit 3 draft). The `transition__*` vectors hold the two
 * ports in parity.
 */

import type { Oid } from './types'

export const ISSUE_CLOSE = 1
export const ISSUE_REOPEN = 2
export const PR_CLOSE = 11
export const PR_REOPEN = 12
export const PR_MERGE = 13
export const PR_DRAFT = 14
export const PR_READY = 15
export const PR_DRAFT_CLOSE = 16
export const PR_DRAFT_REOPEN = 17

/** Every `transition.kind` the contract accepts. */
export const TRANSITION_KINDS: readonly number[] = [
  ISSUE_CLOSE, ISSUE_REOPEN, PR_CLOSE, PR_REOPEN, PR_MERGE, PR_DRAFT, PR_READY, PR_DRAFT_CLOSE, PR_DRAFT_REOPEN,
]

/** The `delta` the contract pins for `kind`, or null for a kind it does not have. */
export function deltaOf(kind: number): number | null {
  switch (kind) {
    case ISSUE_CLOSE:
    case PR_CLOSE:
    case PR_DRAFT_CLOSE:
      return 1
    case ISSUE_REOPEN:
    case PR_REOPEN:
    case PR_DRAFT_REOPEN:
      return -1
    case PR_MERGE:
      return 2
    case PR_DRAFT:
      return 8
    case PR_READY:
      return -8
    default:
      return null
  }
}

/** What a transition names: an `issue` (`targetKind` 0) or a `patch` (1). */
export type TransitionTarget = 'issue' | 'patch'

/** A state change a user asks for. */
export type StateAction = 'close' | 'reopen' | 'merge' | 'draft' | 'ready'

/** Who asks: a current member, the target's author (not a member), or anyone else (never admitted). */
export type Actor = 'member' | 'author' | 'other'

/** The `transition` fields a client writes besides `repoId`, `targetId`, `targetNumber`, `oid`. */
export interface TransitionMove {
  readonly kind: number
  readonly delta: number
  readonly targetKind: number
  /** 0 for a member; the target's number for its author (the contract's author operands). */
  readonly asAuthor: number
  /** The state code after the move. */
  readonly after: number
}

const MOVES: Readonly<Record<TransitionTarget, Readonly<Partial<Record<StateAction, Readonly<Record<number, number>>>>>>> = {
  issue: { close: { 0: ISSUE_CLOSE }, reopen: { 1: ISSUE_REOPEN } },
  patch: {
    close: { 0: PR_CLOSE, 8: PR_DRAFT_CLOSE },
    reopen: { 1: PR_REOPEN, 9: PR_DRAFT_REOPEN },
    merge: { 0: PR_MERGE },
    draft: { 0: PR_DRAFT },
    ready: { 8: PR_READY },
  },
}

/**
 * The move that carries out `action` on a target at state `code`, by `actor`; null when
 * consensus would refuse it (a writer no operand admits, an illegal move, or a merge by a
 * non-member). Parity: forge-core `next_transition`.
 */
export function nextTransition(
  target: TransitionTarget,
  code: number,
  action: StateAction,
  actor: Actor,
  targetNumber: number,
): TransitionMove | null {
  if (actor === 'other') return null
  const member = actor === 'member'
  if (action === 'merge' && !member) return null
  const kind = MOVES[target][action]?.[code]
  if (kind === undefined) return null
  const delta = deltaOf(kind) as number
  return { kind, delta, targetKind: target === 'issue' ? 0 : 1, asAuthor: member ? 0 : targetNumber, after: code + delta }
}

/** A target's state, read off its code. */
export interface StateStatus {
  readonly open: boolean
  readonly merged: boolean
  readonly draft: boolean
}

export function statusOfCode(code: number): StateStatus {
  return { open: (code & 3) === 0, merged: (code & 2) !== 0, draft: (code & 8) !== 0 }
}

/** One `transition` document, flattened. */
export interface Transition {
  readonly id?: string
  readonly kind: number
  readonly actor?: string
  readonly oid?: Oid | null
  readonly asAuthor?: number
  readonly createdAt?: number
}

/** The state code a target's transitions sum to (unknown kinds count 0). */
export function stateCode(transitions: readonly Transition[]): number {
  let code = 0
  for (const t of transitions) code += deltaOf(t.kind) ?? 0
  return code
}

/** The target's merge transition (kind 13), if any. */
export function mergeTransition<T extends Transition>(transitions: readonly T[]): T | null {
  return transitions.find((t) => t.kind === PR_MERGE) ?? null
}

/** A repository's issue and PR totals by state. */
export interface RepoCounts {
  readonly issuesOpen: number
  readonly issuesClosed: number
  readonly prsOpen: number
  readonly prsClosed: number
  readonly prsMerged: number
  readonly prsDraft: number
}

const sat = (a: number, b: number): number => Math.max(0, a - b)

/**
 * The totals by state from the proved counts: the `issue` and `patch` totals and the
 * `transition` count grouped by `kind` (absent kinds are 0). Parity: forge-core `repo_counts`.
 */
export function repoCounts(issues: number, patches: number, kinds: ReadonlyMap<number, number>): RepoCounts {
  const c = (k: number): number => kinds.get(k) ?? 0
  const issuesClosed = sat(c(ISSUE_CLOSE), c(ISSUE_REOPEN))
  const draftClosed = sat(c(PR_DRAFT_CLOSE), c(PR_DRAFT_REOPEN))
  const prsClosed = sat(c(PR_CLOSE), c(PR_REOPEN)) + draftClosed
  const prsMerged = c(PR_MERGE)
  return {
    issuesOpen: sat(issues, issuesClosed),
    issuesClosed,
    prsOpen: sat(patches, prsMerged + prsClosed),
    prsClosed,
    prsMerged,
    prsDraft: sat(sat(c(PR_DRAFT), c(PR_READY)), draftClosed),
  }
}

/** The number the next issue or PR must carry (`dense`: the two totals plus the new one). */
export function denseNumber(issues: number, patches: number): number | null {
  const n = issues + patches + 1
  return Number.isSafeInteger(n) && n >= 1 && n <= 0xffff_ffff ? n : null
}

/** The rule that refuses a create whose number is not the dense next one. */
export const DENSE_RULE = 'dense'

/** Whether a consensus refusal's text names the `dense` rule. */
export function namesDenseRule(message: string): boolean {
  return refusedRule(message) === DENSE_RULE
}

/**
 * The `propertyConstraints` rule a 10422 refusal's text names (`… breaks its propertyConstraints
 * rule "c1_closedAfter": …`), quotes plain or escaped; null when it names none.
 */
export function refusedRule(message: string): string | null {
  return /rule \\?"([A-Za-z0-9_]+)\\?"/.exec(message)?.[1] ?? null
}

/** How a timeline says what a transition did (`asAuthor` ≠ 0: written by the target's author). */
export function transitionPhrase(kind: number): string {
  switch (kind) {
    case ISSUE_CLOSE:
    case PR_CLOSE:
    case PR_DRAFT_CLOSE:
      return 'closed this'
    case ISSUE_REOPEN:
    case PR_REOPEN:
    case PR_DRAFT_REOPEN:
      return 'reopened this'
    case PR_MERGE:
      return 'merged this'
    case PR_DRAFT:
      return 'converted this to a draft'
    case PR_READY:
      return 'marked this ready for review'
    default:
      return `changed the state (kind ${kind})`
  }
}
