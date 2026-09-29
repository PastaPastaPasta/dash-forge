/**
 * Compare two commits of one repo (L-30): `/repo/compare?base=<ref>&head=<ref>`, GitHub's
 * `base...head`. The diff is from the merge base to the head (`git diff base...head`, with rename
 * detection as `-M`), and the commits are those the head has and the base does not
 * (`git log base..head`). Either side may be a branch, a tag or a commit id.
 *
 * Both walks (the merge-base search, then the commit list) read through one read-ahead walker,
 * so the commits the search read are not fetched again for the list.
 */

import { diffTreesWithRenames, historyWalker, type TreeDiff } from './commit-log'
import { prCommits, type PrCommits } from './pr-commits'
import { findMergeBase, MERGE_BASE_COMMIT_CAP, type MergeBaseOptions } from './pull-diff'
import { readCommit, type ObjectReader } from './tree-nav'

export type Comparison =
  /** Base and head are the same commit. */
  | { readonly kind: 'identical' }
  /** The histories share no commit. */
  | { readonly kind: 'unrelated' }
  /** The base already contains the head: nothing to compare. */
  | { readonly kind: 'up-to-date' }
  | {
      readonly kind: 'diff'
      readonly mergeBase: string
      readonly diff: TreeDiff
      readonly commits: PrCommits
    }

/**
 * {@link Comparison} of `baseOid` and `headOid` (full commit ids). Rejects with the merge-base
 * search's errors (its cap, a cancel through `options.signal`).
 */
export async function loadComparison(
  reader: ObjectReader,
  baseOid: string,
  headOid: string,
  options: MergeBaseOptions & { readonly onMergeBase?: () => void } = {},
): Promise<Comparison> {
  if (baseOid === headOid) return { kind: 'identical' }
  const walker = historyWalker(reader)
  try {
    const mergeBase = await findMergeBase(walker, baseOid, headOid, options)
    options.onMergeBase?.()
    if (mergeBase === null) return { kind: 'unrelated' }
    if (mergeBase === headOid) return { kind: 'up-to-date' }
    const [baseTree, headTree] = await Promise.all([readCommit(reader, mergeBase), readCommit(reader, headOid)])
    const [diff, commits] = await Promise.all([
      diffTreesWithRenames({ base: reader, head: reader }, baseTree.tree, headTree.tree),
      // The search read every commit between them; the list re-reads them from the walker's blocks.
      // The merge base too, as the PR's list stops at it: a skewed clock cannot walk past it.
      prCommits(walker, [baseOid, mergeBase], headOid, MERGE_BASE_COMMIT_CAP),
    ])
    return { kind: 'diff', mergeBase, diff, commits }
  } finally {
    walker.flush?.()
  }
}
