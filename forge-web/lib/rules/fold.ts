/**
 * Event fold — issue / PR state.
 *
 * Ports `fold_issue_state` / `fold_pr_state` / `actor_authorized` / `ordered_events`
 * from `crates/forge-core/src/rules.rs`. Events may be unordered and may include spam
 * from non-holders; they are ordered by `(createdAt, id)` and each is applied only if
 * its actor is authorized as-of the event's `createdAt`.
 *
 * The per-kind effects (`applyIssueEvent`, `applyPrEvent`) and merge reachability
 * (`mergeReachable`) are shared with the FORGE_RULES_V2 fold in `./v2`, as in Rust.
 */

import { AuthzResolver, holdingsAny } from './holdings'
import { compareKey, compareStrings, isLegalRefName } from './oid'
import type { Event, IsAncestor, IssueState, PrState } from './types'

/** Order events deterministically by `(createdAt, id)`. */
function orderedEvents(events: readonly Event[]): Event[] {
  return [...events].sort(compareKey)
}

const NO_ANCESTRY: IsAncestor = () => false

/**
 * Whether a `merge` event's `oid` is reachable from (an ancestor of, or equal to) the base
 * tip. No merge oid or no base tip: reachability cannot be proven, so the merge is inert.
 */
export function mergeReachable(
  e: Event,
  baseTip: string | undefined,
  isAncestor: IsAncestor,
): boolean {
  const oid = e.oid ?? undefined
  if (oid === undefined || baseTip === undefined) return false
  return isAncestor(oid, baseTip)
}

/** Is event `e`'s actor authorized to apply it, evaluated as-of `e.createdAt`? */
function actorAuthorized(
  e: Event,
  targetAuthor: string,
  authz: AuthzResolver,
  baseTip: string | undefined,
  isAncestor: IsAncestor,
): boolean {
  const holder = holdingsAny(authz.holdingsAsOf(e.actor, e.createdAt))
  switch (e.kind) {
    case 'close':
    case 'reopen':
      return holder || e.actor === targetAuthor
    case 'merge':
      return holder && mergeReachable(e, baseTip, isAncestor)
    default:
      return holder
  }
}

/** Mutable issue state while folding. */
export interface IssueAcc {
  open: boolean
  readonly labels: Set<string>
  readonly assignees: Set<string>
}

/** Mutable PR state while folding. */
export interface PrAcc extends IssueAcc {
  merged: boolean
  draft: boolean
  baseRef: string | null
}

export function newIssueAcc(): IssueAcc {
  return { open: true, labels: new Set(), assignees: new Set() }
}

export function newPrAcc(): PrAcc {
  return { ...newIssueAcc(), merged: false, draft: false, baseRef: null }
}

/** Apply one authorized event to an issue (both rule versions). PR-only kinds do nothing. */
export function applyIssueEvent(s: IssueAcc, e: Event): void {
  switch (e.kind) {
    case 'close':
      s.open = false
      break
    case 'reopen':
      s.open = true
      break
    case 'labelAdd':
      if (e.value != null) s.labels.add(e.value)
      break
    case 'labelRemove':
      if (e.value != null) s.labels.delete(e.value)
      break
    case 'assign':
      if (e.value != null) s.assignees.add(e.value)
      break
    case 'unassign':
      if (e.value != null) s.assignees.delete(e.value)
      break
    case 'merge':
    case 'retarget':
    case 'draft':
    case 'ready':
      break
  }
}

/** Apply one authorized event to a PR (both rule versions). */
export function applyPrEvent(s: PrAcc, e: Event): void {
  switch (e.kind) {
    case 'reopen':
      // A merged PR cannot be reopened; reopen only revives a plain close.
      if (!s.merged) s.open = true
      break
    case 'merge':
      s.merged = true
      s.open = false
      break
    case 'retarget':
      // Defense-in-depth: an illegal base ref name (injection shape) is inert.
      if (e.value != null && isLegalRefName(e.value)) s.baseRef = e.value
      break
    case 'draft':
      s.draft = true
      break
    case 'ready':
      s.draft = false
      break
    default:
      applyIssueEvent(s, e)
  }
}

export function issueStateOf(s: IssueAcc): IssueState {
  return { open: s.open, labels: sorted(s.labels), assignees: sorted(s.assignees) }
}

export function prStateOf(s: PrAcc): PrState {
  return {
    open: s.open,
    merged: s.merged,
    draft: s.draft,
    baseRef: s.baseRef,
    labels: sorted(s.labels),
    assignees: sorted(s.assignees),
  }
}

/** Fold an issue's `event` log into its {@link IssueState}. */
export function foldIssueState(
  events: readonly Event[],
  targetAuthor: string,
  authz: AuthzResolver,
): IssueState {
  const s = newIssueAcc()
  for (const e of orderedEvents(events)) {
    if (actorAuthorized(e, targetAuthor, authz, undefined, NO_ANCESTRY)) applyIssueEvent(s, e)
  }
  return issueStateOf(s)
}

/** Fold a PR's `event` log into its {@link PrState}. */
export function foldPrState(
  events: readonly Event[],
  targetAuthor: string,
  authz: AuthzResolver,
  baseTip: string | undefined,
  isAncestor: IsAncestor,
): PrState {
  const s = newPrAcc()
  for (const e of orderedEvents(events)) {
    if (actorAuthorized(e, targetAuthor, authz, baseTip, isAncestor)) applyPrEvent(s, e)
  }
  return prStateOf(s)
}

/** Sort + dedupe a set into a stable array (mirrors Rust's BTreeSet ordering: code points). */
export function sorted(set: ReadonlySet<string>): string[] {
  return [...set].sort(compareStrings)
}
