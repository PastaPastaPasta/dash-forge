/**
 * The ancestry a fork's "Sync fork" decides on (P1-4, `syncDecision` in `lib/repo/fork.ts`):
 * the fork's branch tip against its parent's, through one reader of both repos' objects (the
 * fork's packs, then the parent's), as `git merge-base` and `git rev-list --count` answer it for
 * `dg repo sync`.
 */

import { newCommits, WalkLimitError } from '../merge/objects'
import { findMergeBases, type MergeBaseOptions } from './pull-diff'
import type { ObjectReader } from './tree-nav'

/** How the two tips stand: the decision's ancestry, and the commits each side has alone. */
export interface SyncAncestry {
  readonly forkInParent: boolean
  readonly parentInFork: boolean
  /** No common commit at all. */
  readonly unrelated: boolean
  /** Commits the parent's tip has that the fork's lacks (null: more than the walk counts). */
  readonly behind: number | null
  /** Commits the fork's tip has that the parent's lacks (null: more than the walk counts). */
  readonly ahead: number | null
}

/** Commits a sync counts on each side before it says "more than". */
export const SYNC_COUNT_CAP = 1000

/**
 * The ancestry of `forkTip` and `parentTip`, read through `reader` (both repos' objects):
 * `git merge-base` (the merge-base walk the PR pages use), then each side's own commits counted
 * up to {@link SYNC_COUNT_CAP}.
 */
export async function syncAncestry(reader: ObjectReader, forkTip: string, parentTip: string, options: MergeBaseOptions = {}): Promise<SyncAncestry> {
  const bases = await findMergeBases(reader, forkTip, parentTip, options)
  const base = bases.length === 1 ? (bases[0] as string) : null
  const count = async (tip: string, have: string): Promise<number | null> => {
    try {
      return (await newCommits(reader, tip, [have], SYNC_COUNT_CAP)).length
    } catch (e) {
      if (e instanceof WalkLimitError) return null
      throw e
    }
  }
  const forkInParent = base === forkTip
  const parentInFork = base === parentTip
  const [behind, ahead] = await Promise.all([forkInParent || !parentInFork ? count(parentTip, forkTip) : 0, parentInFork || !forkInParent ? count(forkTip, parentTip) : 0])
  return { forkInParent, parentInFork, unrelated: bases.length === 0, behind, ahead }
}
