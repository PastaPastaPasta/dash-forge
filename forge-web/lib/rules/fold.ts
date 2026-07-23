/**
 * Event fold — issue / PR state.
 *
 * Ports `fold_issue_state` / `fold_pr_state` / `actor_authorized` / `ordered_events`
 * from `crates/forge-core/src/rules.rs`. Events may be unordered and may include spam
 * from non-holders; they are ordered by `(createdAt, id)` and each is applied only if
 * its actor is authorized as-of the event's `createdAt`.
 */

import { AuthzResolver, holdingsAny } from './holdings'
import { compareKey, isLegalRefName } from './oid'
import type { Event, IsAncestor, IssueState, PrState } from './types'

/** Order events deterministically by `(createdAt, id)`. */
function orderedEvents(events: readonly Event[]): Event[] {
  return [...events].sort(compareKey)
}

const NO_ANCESTRY: IsAncestor = () => false

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
    case 'merge': {
      if (!holder) return false
      const oid = e.oid ?? undefined
      if (oid === undefined || baseTip === undefined) return false
      return isAncestor(oid, baseTip)
    }
    default:
      return holder
  }
}

/** Fold an issue's `event` log into its {@link IssueState}. */
export function foldIssueState(
  events: readonly Event[],
  targetAuthor: string,
  authz: AuthzResolver,
): IssueState {
  let open = true
  const labels = new Set<string>()
  const assignees = new Set<string>()

  for (const e of orderedEvents(events)) {
    if (!actorAuthorized(e, targetAuthor, authz, undefined, NO_ANCESTRY)) continue
    switch (e.kind) {
      case 'close':
        open = false
        break
      case 'reopen':
        open = true
        break
      case 'labelAdd':
        if (e.value != null) labels.add(e.value)
        break
      case 'labelRemove':
        if (e.value != null) labels.delete(e.value)
        break
      case 'assign':
        if (e.value != null) assignees.add(e.value)
        break
      case 'unassign':
        if (e.value != null) assignees.delete(e.value)
        break
      // PR-only kinds do not apply to issues.
      case 'merge':
      case 'retarget':
      case 'draft':
      case 'ready':
        break
    }
  }

  return { open, labels: sorted(labels), assignees: sorted(assignees) }
}

/** Fold a PR's `event` log into its {@link PrState}. */
export function foldPrState(
  events: readonly Event[],
  targetAuthor: string,
  authz: AuthzResolver,
  baseTip: string | undefined,
  isAncestor: IsAncestor,
): PrState {
  let open = true
  let merged = false
  let draft = false
  let baseRef: string | null = null
  const labels = new Set<string>()
  const assignees = new Set<string>()

  for (const e of orderedEvents(events)) {
    if (!actorAuthorized(e, targetAuthor, authz, baseTip, isAncestor)) continue
    switch (e.kind) {
      case 'close':
        open = false
        break
      case 'reopen':
        // A merged PR cannot be reopened; reopen only revives a plain close.
        if (!merged) open = true
        break
      case 'merge':
        merged = true
        open = false
        break
      case 'labelAdd':
        if (e.value != null) labels.add(e.value)
        break
      case 'labelRemove':
        if (e.value != null) labels.delete(e.value)
        break
      case 'assign':
        if (e.value != null) assignees.add(e.value)
        break
      case 'unassign':
        if (e.value != null) assignees.delete(e.value)
        break
      case 'retarget':
        // Defense-in-depth: an illegal base ref name (injection shape) is inert.
        if (e.value != null && isLegalRefName(e.value)) baseRef = e.value
        break
      case 'draft':
        draft = true
        break
      case 'ready':
        draft = false
        break
    }
  }

  return { open, merged, draft, baseRef, labels: sorted(labels), assignees: sorted(assignees) }
}

/** Sort + dedupe a set into a stable array (mirrors Rust's BTreeSet ordering). */
function sorted(set: ReadonlySet<string>): string[] {
  return [...set].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}
