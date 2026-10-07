/**
 * The git side of the merge integrity rule (`lib/rules/merge-content.ts`, parity with `dg`'s
 * `pr/verify.rs`): read, through a comparison's readers, the facts that say whether a recorded
 * merge contains its pull request. What cannot be read stays `null`, and the rule then answers
 * `unknown`, never `missing`.
 */

import { diffTrees, type DiffSides } from './commit-log'
import { findMergeBase, historyWalker, type MergeBaseOptions } from './pull-diff'
import { readCommit, type ObjectReader } from './tree-nav'
import { mergeContent, type MergeContent, type MergeFacts, type TreeChange } from '../rules/merge-content'

export interface MergeCheckInput {
  /** The PR head when it was merged (`headAt`). */
  readonly headOid: string
  /** The merge transition's commit. */
  readonly mergeOid: string
  /** The base's tip just before the merge (`PullView.baseOidAtMerge`), or `''`. */
  readonly tipBefore: string
}

/** `a` → `b` as a path → new blob map (`''` for a deletion); `null` when it cannot be read whole. */
async function treeChange(sides: DiffSides, a: string, b: string): Promise<TreeChange | null> {
  try {
    const [from, to] = await Promise.all([readCommit(sides.base, a), readCommit(sides.head, b)])
    const diff = await diffTrees(sides, from.tree, to.tree)
    if (diff.truncated) return null
    const out: Record<string, string> = {}
    for (const c of diff.changes) out[c.path] = c.headOid ?? ''
    return out
  } catch {
    return null
  }
}

/** Whether `ancestor` is `oid` or one of its ancestors; `null` when the walk could not finish. */
async function contains(reader: ObjectReader, oid: string, ancestor: string, search: MergeBaseOptions): Promise<boolean | null> {
  try {
    return (await findMergeBase(reader, oid, ancestor, search)) === ancestor
  } catch {
    return null
  }
}

/** Gather the facts about a recorded merge from `sides` (see {@link MergeFacts}). */
export async function mergeFacts(sides: DiffSides, input: MergeCheckInput, search: MergeBaseOptions = {}): Promise<MergeFacts> {
  const { headOid, mergeOid, tipBefore } = input
  const walk = historyWalker(sides.base, sides.head)
  try {
    const mergeParents = await readCommit(walk.reader, mergeOid).then(
      (c) => c.parents,
      () => [],
    )
    const headInMerge = headOid === mergeOid ? true : await contains(walk.reader, mergeOid, headOid, search)
    const facts: MergeFacts = { headOid, mergeOid, tipBefore, mergeParents, headInMerge }
    if (tipBefore === '' || headInMerge === true) return facts
    const tipBeforeInMerge = await contains(walk.reader, mergeOid, tipBefore, search)
    // Not built on the base: no tree comparison can make it a squash or a rebase.
    if (tipBeforeInMerge === false) return { ...facts, tipBeforeInMerge }
    const mergeBase = await findMergeBase(walk.reader, tipBefore, headOid, search).catch(() => null)
    const base: DiffSides = { base: sides.base, head: sides.base }
    const [mergeChange, prChange, baseChange] = await Promise.all([
      treeChange(base, tipBefore, mergeOid),
      mergeBase === null ? null : treeChange(sides, mergeBase, headOid),
      mergeBase === null ? null : treeChange(base, mergeBase, tipBefore),
    ])
    return { ...facts, tipBeforeInMerge, mergeChange, prChange, baseChange }
  } finally {
    walk.done()
  }
}

/** Whether a recorded merge contains its PR, read through `sides`. */
export async function checkMerge(sides: DiffSides, input: MergeCheckInput, search: MergeBaseOptions = {}): Promise<MergeContent> {
  return mergeContent(await mergeFacts(sides, input, search))
}

/** How far back from the base tip {@link unrecordedMergeLikely} walks to find the tip before it. */
const RECORD_WALK = 50

/**
 * A cheap first look before the full merge check of an open PR's base tip ("Record merge of …"):
 * whether the tip could be this PR's unrecorded merge.
 *
 * - `tipContainsHead` (the comparison's own merge-base walk found the head in the tip): yes, the
 *   full check will say it contains the PR.
 * - Else, along first parents from the tip back to `prev` (the base's tip before), both
 *   included, at most {@link RECORD_WALK} commits: yes when one of them is the head or has it as a
 *   parent (a merge commit, perhaps followed by other merges or pushes).
 * - Else a squash or a rebase can only change paths the PR changes: yes when the change from
 *   `prev` to the tip does (`prPaths`; null when the PR's own list is unknown, then yes).
 *
 * No when `prev` is not reached within the walk: a base that moved more than that since is not
 * offered (record the merge with `dg pr merge --event-only`).
 */
export async function unrecordedMergeLikely(
  sides: DiffSides,
  input: {
    readonly tip: string
    readonly prev: string
    readonly head: string
    readonly prPaths: ReadonlySet<string> | null
    readonly tipContainsHead?: boolean
  },
): Promise<boolean> {
  const { tip, prev, head, prPaths } = input
  if (input.tipContainsHead === true) return true
  try {
    const top = await readCommit(sides.base, tip)
    let at = tip
    let commit = top
    // From the tip back to the tip before it, both included.
    for (let i = 0; ; i++) {
      if (at === head || commit.parents.includes(head)) return true
      if (at === prev) break
      const parent = commit.parents[0]
      if (parent === undefined || i >= RECORD_WALK) return false
      at = parent
      commit = await readCommit(sides.base, at)
    }
    if (prPaths === null) return true
    const before = commit
    const base: DiffSides = { base: sides.base, head: sides.base }
    const diff = await diffTrees(base, before.tree, top.tree)
    if (diff.truncated) return true
    return diff.changes.length > 0 && diff.changes.every((c) => prPaths.has(c.path))
  } catch {
    return false
  }
}
