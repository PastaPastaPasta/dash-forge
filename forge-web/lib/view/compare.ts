/**
 * Compare two commits of one repo (L-30): `/repo/compare?base=<ref>&head=<ref>`, GitHub's
 * `base...head`. The diff is from the merge base to the head (`git diff base...head`, with rename
 * detection as `-M`), and the commits are those the head has and the base does not
 * (`git log base..head`). Either side may be a branch, a tag or a commit id.
 *
 * Both walks (the merge-base search, then the commit list) read through one read-ahead walker,
 * so the commits the search read are not fetched again for the list.
 *
 * Also the ref-param helpers the New PR form shares: `?base=master&head=develop` short names.
 */

import type { ResolvedRef } from '../repo'
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
export async function loadComparison(reader: ObjectReader, baseOid: string, headOid: string, options: MergeBaseOptions = {}): Promise<Comparison> {
  if (baseOid === headOid) return { kind: 'identical' }
  const walker = historyWalker(reader)
  try {
    const mergeBase = await findMergeBase(walker, baseOid, headOid, options)
    if (mergeBase === null) return { kind: 'unrelated' }
    if (mergeBase === headOid) return { kind: 'up-to-date' }
    const [baseTree, headTree] = await Promise.all([readCommit(reader, mergeBase), readCommit(reader, headOid)])
    const [diff, commits] = await Promise.all([
      diffTreesWithRenames({ base: reader, head: reader }, baseTree.tree, headTree.tree),
      // The search read every commit between them; the list re-reads them from the walker's blocks.
      prCommits(walker, [baseOid], headOid, MERGE_BASE_COMMIT_CAP),
    ])
    return { kind: 'diff', mergeBase, diff, commits }
  } finally {
    walker.flush?.()
  }
}

/** A branch name as a ref name: `develop`, `heads/develop` or `refs/heads/develop` → `refs/heads/develop`. */
export function branchRefName(param: string): string {
  const name = param.trim().replace(/^(refs\/)?heads\//, '')
  return name === '' ? '' : `refs/heads/${name}`
}

/**
 * The New PR form's head key (`<repoId>:refs/heads/<name>`) for a `?head=` param: a short or full
 * branch name of this repo, or already a key (`<repoId>:<branch>`, a fork's branch).
 */
export function headKeyOf(param: string, repoId: string): string {
  const p = param.trim()
  if (p === '') return ''
  const colon = p.indexOf(':')
  // A key names a repo id (base58, no slash) before the colon; a ref name never holds one.
  if (colon > 0 && !p.slice(0, colon).includes('/')) return `${p.slice(0, colon)}:${branchRefName(p.slice(colon + 1))}`
  return `${repoId}:${branchRefName(p)}`
}

/** Branches for a picker: the default branch first, then by name. */
export function sortBranches<T extends Pick<ResolvedRef, 'refName'>>(branches: readonly T[], defaultBranch: string): T[] {
  const def = `refs/heads/${defaultBranch}`
  return [...branches].sort((a, b) => (a.refName === def ? -1 : b.refName === def ? 1 : a.refName < b.refName ? -1 : a.refName > b.refName ? 1 : 0))
}
