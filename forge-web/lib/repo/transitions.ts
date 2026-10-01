/**
 * Issue and PR state on chain: `transition` documents (forge-collab; `forge-v2.md` §3, the
 * fresh-registration design `STATE-COUNTS.md` §2 and §4).
 *
 * Consensus accepts a transition only as a legal move from the target's current state, so the
 * sum of `delta` over a target's transitions, mod 16, IS its state code, and a sum of 16 or more
 * means the thread is locked (`lib/rules/transition.ts`). Reads here:
 *
 * - a target's own transitions (who closed it, when; the merge oid), from the `perTarget`
 *   index (`targetId ==`);
 * - the state codes of a list page: one proved sum query, `targetId in [page]` grouped by
 *   `targetId` on `perTarget` (`summable: delta`); an absent target is state 0;
 * - the repo's open / closed / merged / draft totals: the `issue` and `patch` totals
 *   (`perRepo`) and one count of `transition` by `kind` (`perRepoKind`), three proved requests.
 *
 * Writes: {@link writeTransition}, the move {@link nextTransition} picks from the current code
 * (an issue close says why, QW-069: `reason` and a duplicate's `dupNumber`, where the registered
 * contract has them); {@link writeLock}, a member's lock or unlock.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'
import { hexToBytes } from '@noble/hashes/utils.js'

import { decodeIdentifier } from '../auth/base58'
import { compareKey } from '../rules/oid'
import {
  CLOSE_REASON_CODE,
  ISSUE_CLOSE,
  LOCK_DELTA,
  PR_MERGE,
  TRANSITION_KINDS,
  currentCloseReason,
  nextTransition,
  refusedRule,
  repoCounts,
  statusOfCode,
  threadStateOf,
  type Actor,
  type ClosedAs,
  type RepoCounts,
  type StateAction,
  type ThreadState,
  type Transition,
  type TransitionMove,
  type TransitionTarget,
} from '../rules/transition'
import {
  ConsensusRefusal,
  GATE_REFUSED_CODE,
  previewCredits,
  RULE_REFUSED_CODE,
  countDocumentsGrouped,
  queryAllDocuments,
  sumDocumentsGrouped,
  uintOfGroupKey,
  type PlainDocument,
  type WriteAuth,
  type WriteResult,
} from '../sdk'
import { DOC, asIdentifierString, byteFieldToHex, num, str, type RepoRef } from './contract'
import { contractHasProperty } from './contract-shape'
import { readTargetCounts } from './social'
import { repoSource } from './source'

/** A `transition` document, flattened (the rules' {@link Transition} plus what a timeline shows). */
export interface TransitionView extends Transition {
  readonly id: string
  readonly targetId: string
  readonly kind: number
  readonly actor: string
  readonly asAuthor: number
  readonly createdAt: number
}

/** A `transition` document as a {@link TransitionView}. */
export function transitionOf(d: PlainDocument): TransitionView {
  const oid = byteFieldToHex(d, 'oid')
  const reason = d['reason']
  const dupNumber = d['dupNumber']
  return {
    id: str(d, '$id'),
    targetId: asIdentifierString(d['targetId']),
    kind: num(d, 'kind'),
    actor: str(d, '$ownerId'),
    asAuthor: num(d, 'asAuthor'),
    createdAt: num(d, '$createdAt'),
    ...(oid !== '' ? { oid } : {}),
    ...(typeof reason === 'number' ? { reason } : {}),
    ...(typeof dupNumber === 'number' ? { dupNumber } : {}),
  }
}

/** Transitions oldest first, by `($createdAt, $id)`. */
export function sortTransitions(rows: readonly TransitionView[]): TransitionView[] {
  return [...rows].sort(compareKey)
}

/** Every transition of one target, oldest first (`perTarget`, keyed by `targetId` alone; a target's history is short). */
export async function readTransitions(sdk: EvoSDK, repo: RepoRef, targetId: string): Promise<TransitionView[]> {
  const docs = await queryAllDocuments(
    sdk,
    repoSource(repo).targetQuery(DOC.transition, { where: [['targetId', '==', targetId]], orderBy: [['targetId', 'asc']] }),
  )
  return sortTransitions(docs.map(transitionOf))
}

/** The proved `in` clause limit: a sum query names at most this many targets. */
const IN_MAX = 100

/**
 * Why each closed issue of a list page was closed (QW-069): its transitions, one `targetId in`
 * read on `perTarget` (indexed by `targetId` alone, so at most {@link IN_MAX} issues: a larger
 * page reads none and shows the plain closed icon). An issue whose close says nothing is absent.
 */
export async function readCloseReasons(
  sdk: EvoSDK,
  repo: RepoRef,
  issues: readonly { readonly id: string; readonly number: number }[],
): Promise<Map<string, ClosedAs>> {
  const out = new Map<string, ClosedAs>()
  const ids = [...new Set(issues.map((i) => i.id).filter((id) => id !== ''))]
  if (ids.length === 0 || ids.length > IN_MAX) return out
  const docs = await queryAllDocuments(
    sdk,
    repoSource(repo).targetQuery(DOC.transition, { where: [['targetId', 'in', [...ids].sort()]], orderBy: [['targetId', 'asc']] }),
  )
  const byTarget = new Map<string, TransitionView[]>()
  for (const t of docs.map(transitionOf)) byTarget.set(t.targetId, [...(byTarget.get(t.targetId) ?? []), t])
  for (const issue of issues) {
    const closed = currentCloseReason(byTarget.get(issue.id) ?? [], issue.number)
    if (closed !== null) out.set(issue.id, closed)
  }
  return out
}

/** The tree key of an identifier group (its 32 bytes, hex). */
function idKey(id: string): string {
  return [...decodeIdentifier(id)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * The state code and lock bit of each of `targetIds` (base58), from one proved sum query per 100
 * ids: `targetId in [...]` grouped by `targetId`. A target with no transitions has no entry: open
 * and unlocked.
 */
export async function readThreadStates(sdk: EvoSDK, repo: RepoRef, targetIds: readonly string[]): Promise<Map<string, ThreadState>> {
  const ids = [...new Set(targetIds.filter((id) => id !== ''))]
  const out = new Map<string, ThreadState>(ids.map((id) => [id, threadStateOf(0)]))
  const source = repoSource(repo)
  const batches: string[][] = []
  for (let i = 0; i < ids.length; i += IN_MAX) batches.push(ids.slice(i, i + IN_MAX))
  await Promise.all(
    batches.map(async (batch) => {
      const sorted = [...batch].sort()
      const sums = await sumDocumentsGrouped(
        sdk,
        { ...source.targetQuery(DOC.transition, { where: [['targetId', 'in', sorted]], orderBy: [['targetId', 'asc']] }), groupBy: ['targetId'] },
        'delta',
      )
      for (const id of batch) out.set(id, threadStateOf(sums.get(idKey(id)) ?? 0))
    }),
  )
  return out
}

/** The state code (mod 16, the lock bit dropped) of each of `targetIds`: {@link readThreadStates}. */
export async function readStateCodes(sdk: EvoSDK, repo: RepoRef, targetIds: readonly string[]): Promise<Map<string, number>> {
  const states = await readThreadStates(sdk, repo, targetIds)
  return new Map([...states].map(([id, st]) => [id, st.code]))
}

/** The per-kind transition counts of a repo (`perRepoKind`, one proved request). */
export async function readKindCounts(sdk: EvoSDK, repo: RepoRef): Promise<Map<number, number>> {
  const counts = await countDocumentsGrouped(sdk, {
    ...repoSource(repo).repoQuery(DOC.transition, { where: [['kind', 'in', [...TRANSITION_KINDS]]], orderBy: [['kind', 'asc']] }),
    groupBy: ['kind'],
  })
  // Decoded at any width: the kind is a u8 on the registered contract, but a key's width follows
  // the contract's integer sizing, and a mis-sized lookup would read every count as 0.
  const out = new Map<number, number>()
  for (const [key, n] of counts) {
    const k = uintOfGroupKey(key)
    if (k !== null && TRANSITION_KINDS.includes(k)) out.set(k, (out.get(k) ?? 0) + n)
  }
  return out
}

/**
 * The repo's open / closed / merged / draft totals: the issue and PR totals (`perRepo`) and the
 * transition counts by kind, three proved requests in parallel (`STATE-COUNTS.md` §4).
 */
export async function readRepoCounts(sdk: EvoSDK, repo: RepoRef): Promise<RepoCounts & { readonly issues: number; readonly patches: number }> {
  // The totals through `readTargetCounts`: after this browser created an issue or PR it re-reads
  // a node that is a block behind (L-37), so a new issue never shows as a missing open one.
  const [totals, kinds] = await Promise.all([readTargetCounts(sdk, repo.forge, repo.repoId), readKindCounts(sdk, repo)])
  if (totals.issues === null || totals.pulls === null) throw new Error("couldn't read this repo's issue and PR totals")
  return { ...repoCounts(totals.issues, totals.pulls, kinds), issues: totals.issues, patches: totals.pulls }
}

/** The target of a state change. */
export interface StateTarget {
  readonly id: string
  readonly number: number
  readonly type: TransitionTarget
  readonly author: string
}

/** Thrown when the move is not legal from the target's current state (nothing is written). */
export class IllegalTransitionError extends Error {
  constructor(
    readonly action: StateAction,
    readonly code: number,
  ) {
    super(illegalMessage(action, code))
    this.name = 'IllegalTransitionError'
  }
}

function illegalMessage(action: StateAction, code: number): string {
  if ((code & 2) !== 0) return 'this pull request is merged; it cannot be changed any more'
  if (action === 'merge' && (code & 8) !== 0) return 'mark this pull request ready for review before merging it'
  if (action === 'merge' && (code & 1) !== 0) return 'reopen this pull request before merging it'
  if (action === 'merge') return 'only a maintainer or writer can merge'
  if (action === 'close') return 'it is already closed'
  if (action === 'reopen') return 'it is already open'
  if (action === 'draft') return (code & 1) !== 0 ? 'reopen it before converting it to a draft' : 'it is already a draft'
  return 'it is not a draft'
}

/** Whether a refusal names one of the `transition` state rules (`c1`…`c6`): the state moved. */
export function isStaleStateRefusal(e: unknown): boolean {
  return e instanceof ConsensusRefusal && e.code === RULE_REFUSED_CODE && /^c\d_/.test(refusedRule(e.message) ?? '')
}

/** Whether a target at `code` already shows the outcome of `action` (an earlier attempt landed). */
function alreadyDone(action: StateAction, code: number): boolean {
  const { open, merged, draft } = statusOfCode(code)
  switch (action) {
    case 'close':
      return !open && !merged
    case 'reopen':
      return open
    case 'merge':
      return merged
    case 'draft':
      return draft && open
    case 'ready':
      return !draft && open
  }
}

/** The document data of the transition that carries out `action` on `target` at state `code`. */
export function transitionData(
  target: StateTarget,
  code: number,
  action: StateAction,
  actor: Actor,
  oidHex?: string,
): Record<string, unknown> {
  const move = nextTransition(target.type, code, action, actor, target.number)
  if (move === null) throw new IllegalTransitionError(action, code)
  if (move.kind === PR_MERGE && (oidHex === undefined || oidHex === '')) throw new Error('a merge names its commit')
  return { ...moveData(target, move), ...(move.kind === PR_MERGE && oidHex ? { oid: hexToBytes(oidHex) } : {}) }
}

/** The `transition` fields of `move` on `target` (a merge adds its `oid`). */
function moveData(target: StateTarget, move: TransitionMove): Record<string, unknown> {
  return {
    targetId: decodeIdentifier(target.id),
    targetNumber: target.number,
    targetKind: move.targetKind,
    kind: move.kind,
    delta: move.delta,
    asAuthor: move.asAuthor,
  }
}

/** Write one document (injected so this module does not import the write layer's caches). */
export type TransitionWriter = (documentType: string, data: Record<string, unknown>, intent?: string) => Promise<WriteResult>

/**
 * The `reason` / `dupNumber` of an issue close that says why (QW-069; no consensus rule reads
 * them, `closeReasonOf` is the reading). A duplicate names a canonical other than itself.
 */
export function closeReasonData(closed: ClosedAs, targetNumber: number): Record<string, unknown> {
  if (closed.duplicateOf !== null && (closed.reason !== 'duplicate' || closed.duplicateOf === targetNumber || closed.duplicateOf < 1)) {
    throw new Error(closed.reason !== 'duplicate' ? 'only a close as a duplicate names the issue it duplicates' : `issue #${targetNumber} cannot be a duplicate of #${closed.duplicateOf}`)
  }
  return { reason: CLOSE_REASON_CODE[closed.reason], ...(closed.duplicateOf !== null ? { dupNumber: closed.duplicateOf } : {}) }
}

/**
 * Close, reopen, merge, draft or ready `target`: read its current state, write the one legal
 * move as `transition`, by a member (`asAuthor` 0) or by its author (`asAuthor` = its number).
 * An issue close records `closed` (why) when the deployment's forge-collab has
 * `transition.reason`; on one without it the close is written plain.
 *
 * - The intent is the action's (`<intent>:<action>`), not the state's: a retry of a write that
 *   timed out replays the same bytes, and a retry after it landed finds the target already in
 *   the action's end state and returns without writing (an empty `documentId`, nothing spent).
 * - When the gate refuses a member write (the membership read was stale) and the viewer is the
 *   author, it is written again as the author.
 * - When a state rule refuses it (someone moved the target meanwhile), the state is read again
 *   and the move retried once, or refused plainly.
 */
export async function writeTransition(
  sdk: EvoSDK,
  auth: WriteAuth,
  repo: RepoRef,
  write: TransitionWriter,
  input: { target: StateTarget; action: StateAction; isMember: boolean; oidHex?: string; intent?: string; closed?: ClosedAs },
): Promise<WriteResult> {
  const { target, action } = input
  const isAuthor = auth.identityId === target.author
  if (!input.isMember && !isAuthor) throw new Error('only the author or a maintainer or writer can do that')
  if (action === 'merge' && !input.isMember) throw new Error('only a maintainer or writer can merge')
  // Why an issue closes: only where the registered contract records it.
  const why =
    input.closed !== undefined && action === 'close' && target.type === 'issue' && (await contractHasProperty(sdk, repo.forge.collab, DOC.transition, 'reason'))
      ? closeReasonData(input.closed, target.number)
      : null
  let actor: Actor = input.isMember ? 'member' : 'author'
  const codeNow = async (): Promise<number> => (await readStateCodes(sdk, repo, [target.id])).get(target.id) ?? 0
  let staleRetried = false
  // At most: one author fallback and one stale-state retry.
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = await codeNow()
    if (alreadyDone(action, code)) return { documentId: '', confirmed: true, cost: previewCredits(0), actualCredits: 0 }
    // The reason is in the intent: a retry replays the same bytes, never another reason's.
    const reasonKey = why === null ? '' : `:${String(why['reason'])}${why['dupNumber'] !== undefined ? `-${String(why['dupNumber'])}` : ''}`
    const intent = input.intent ? `${input.intent}:${action}:${actor === 'member' ? 'm' : 'a'}${reasonKey}` : undefined
    try {
      const data = transitionData(target, code, action, actor, input.oidHex)
      return await write(DOC.transition, why !== null && data['kind'] === ISSUE_CLOSE ? { ...data, ...why } : data, intent)
    } catch (e) {
      if (e instanceof ConsensusRefusal && e.code === GATE_REFUSED_CODE && actor === 'member' && isAuthor && action !== 'merge') {
        actor = 'author'
        continue
      }
      if (isStaleStateRefusal(e) && !staleRetried) {
        staleRetried = true
        continue
      }
      throw e
    }
  }
  throw new IllegalTransitionError(action, await codeNow())
}

/**
 * Lock or unlock the conversation on `target` (a member's `transition`, kinds 3/4 or 18/19): once
 * locked, consensus refuses a comment or review from anyone who does not prove membership. Reads
 * the lock bit first and writes nothing when it is already in the asked state (a retry after the
 * write landed); a `c6_lockedAfter` refusal (someone else moved it meanwhile) re-reads once.
 */
export async function writeLock(
  sdk: EvoSDK,
  auth: WriteAuth,
  repo: RepoRef,
  write: TransitionWriter,
  input: { target: StateTarget; lock: boolean; isMember: boolean; intent?: string },
): Promise<WriteResult> {
  if (!input.isMember) throw new Error('only a maintainer or writer can lock or unlock a conversation')
  const { target, lock } = input
  const once = async (): Promise<WriteResult> => {
    const state = (await readThreadStates(sdk, repo, [target.id])).get(target.id) ?? threadStateOf(0)
    const sum = state.code + (state.locked ? LOCK_DELTA : 0)
    const move = nextTransition(target.type, sum, lock ? 'lock' : 'unlock', 'member', target.number)
    if (move === null) return { documentId: '', confirmed: true, cost: previewCredits(0), actualCredits: 0 }
    return write(DOC.transition, moveData(target, move), input.intent ? `${input.intent}:${lock ? 'lock' : 'unlock'}` : undefined)
  }
  try {
    return await once()
  } catch (e) {
    if (!isStaleStateRefusal(e)) throw e
  }
  return once()
}
