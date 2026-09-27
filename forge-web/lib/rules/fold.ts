/**
 * Event fold building blocks — issue / PR state.
 *
 * The per-kind effects (`applyIssueEvent`, `applyPrEvent`), merge reachability
 * (`mergeReachable`) and the state accumulators the FORGE_RULES_V2 fold in `./v2` applies,
 * ported from `crates/forge-core/src/rules.rs`.
 */

import { compareStrings, isLegalRefName } from './oid'
import type { Event, IsAncestor, IssueState, PrState } from './types'

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

export function newPrAcc(draft = false): PrAcc {
  return { ...newIssueAcc(), merged: false, draft, baseRef: null }
}

/** Apply one authorized event to an issue. PR-only kinds do nothing. */
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
    default:
      // PR-only kinds (merge, retarget, draft, ready) and the review kinds (11–18,
      // `foldPrReviewV2`) do nothing to an issue.
      break
  }
}

/** Apply one authorized event to a PR. */
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
      // close and the label / assignee kinds; review kinds (11–18) are no-ops there.
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

/** Sort + dedupe a set into a stable array (mirrors Rust's BTreeSet ordering: code points). */
export function sorted(set: ReadonlySet<string>): string[] {
  return [...set].sort(compareStrings)
}
