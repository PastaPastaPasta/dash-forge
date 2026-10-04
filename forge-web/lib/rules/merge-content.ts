/**
 * Merge integrity: does a recorded merge really contain the pull request? Parity with forge-core
 * `rules::merge_check` (vectors `merge_content__*`).
 *
 * Consensus admits a merge transition from a maintainer or role-1 writer with any `oid`, and a
 * merged PR is final. The fold only checks that the `oid` has been a valid tip of the base
 * (`mergeOnBase`), never that the PR's commits are in it. From git facts the reader gathers (an
 * ancestry walk and three tree-level diffs), {@link mergeContent} labels the merge as containing
 * the PR, as a squash or a rebase of it, or as not containing it. Consensus can never check this
 * (it cannot read git objects), so it stays a reader rule.
 */

import { compareStrings } from './oid'
import type { HeadUpdate } from './review'

/** A tree-level change: each changed path and the blob it ends with (`''` when deleted). */
export type TreeChange = Readonly<Record<string, string>>

/** What a reader found in git about a recorded merge; `null` means it could not be read. */
export interface MergeFacts {
  /** The PR's head when it was merged ({@link headAt}). */
  readonly headOid: string
  /** The merge transition's `oid`. */
  readonly mergeOid: string
  /** The base's valid tip just before `mergeOid` first became one; `''` when there is none. */
  readonly tipBefore?: string
  /** `mergeOid`'s parents, in order. */
  readonly mergeParents?: readonly string[]
  /** `headOid` is `mergeOid` or one of its ancestors. */
  readonly headInMerge?: boolean | null
  /** `tipBefore` is an ancestor of `mergeOid`. */
  readonly tipBeforeInMerge?: boolean | null
  /** `tipBefore` → `mergeOid`. */
  readonly mergeChange?: TreeChange | null
  /** `merge-base(headOid, tipBefore)` → `headOid`. */
  readonly prChange?: TreeChange | null
  /** `merge-base(headOid, tipBefore)` → `tipBefore`. */
  readonly baseChange?: TreeChange | null
}

export type MergeVerdict = 'contains' | 'squash' | 'rebase' | 'missing' | 'unknown'

export interface MergeContent {
  readonly verdict: MergeVerdict
  /** For a squash or a rebase: paths git combined with base changes, sorted. Empty otherwise. */
  readonly combined: readonly string[]
}

/**
 * Whether the merge's change is the PR's: the merge changes no path the PR leaves alone, and each
 * path the PR changes ends with the PR's blob or the base changed it too (git combined both sides,
 * or the base already held the PR's change). The combined paths when it is, `null` when it is
 * not, `'unread'` when a fact needed to decide is missing. Parity: forge-core `same_changes`.
 */
function sameChanges(f: MergeFacts): string[] | null | 'unread' {
  const tipBefore = f.tipBefore ?? ''
  if (tipBefore === '' || f.tipBeforeInMerge === false) return null
  const merge = f.mergeChange ?? null
  const pr = f.prChange ?? null
  if (f.tipBeforeInMerge !== true || merge === null || pr === null) return 'unread'
  if (Object.keys(merge).some((p) => !Object.hasOwn(pr, p))) return null
  const differing = Object.keys(pr)
    .filter((p) => !Object.hasOwn(merge, p) || merge[p] !== pr[p])
    .sort(compareStrings)
  if (differing.length === 0) return differing
  const base = f.baseChange ?? null
  if (base === null) return 'unread'
  if (!differing.every((p) => Object.hasOwn(base, p))) return null
  // The PR's change already on the base, left alone by the merge: not combined.
  return differing.filter((p) => Object.hasOwn(merge, p) || base[p] !== pr[p])
}

/**
 * Label a recorded merge: `contains` (the head is the merge commit or its ancestor), else
 * `squash`/`rebase` (built on the base's previous tip, making exactly the PR's changes, except on
 * paths the base changed too), else `missing` (the head is known not to be in it), else `unknown`.
 */
export function mergeContent(f: MergeFacts): MergeContent {
  if (f.headInMerge === true || (f.headOid !== '' && f.headOid === f.mergeOid)) return { verdict: 'contains', combined: [] }
  const same = sameChanges(f)
  if (Array.isArray(same)) {
    const parents = f.mergeParents ?? []
    const squash = parents.length === 1 && parents[0] === (f.tipBefore ?? '')
    return { verdict: squash ? 'squash' : 'rebase', combined: same }
  }
  if (same === null && f.headInMerge === false) return { verdict: 'missing', combined: [] }
  return { verdict: 'unknown', combined: [] }
}

/**
 * The PR's head when it was merged at `mergedAt`: the newest applied head update written no
 * later, else `initialHead`. Parity with forge-core `merge_check::head_at`.
 */
export function headAt(headUpdates: readonly HeadUpdate[], initialHead: string, mergedAt: number): string {
  let head = initialHead
  for (const u of headUpdates) if (u.createdAt <= mergedAt) head = u.oid
  return head
}
