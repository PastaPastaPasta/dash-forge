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
 * whether the tip could be this PR's unrecorded merge. True when the tip is a merge commit with
 * the PR head as a parent, or when the commits from `prev` (the base's tip before) to the tip,
 * along first parents and at most {@link RECORD_WALK} of them, change only paths the PR changes
 * (`prPaths`; null when the PR's own list is incomplete: then true). A few object reads and one
 * tree diff, against the full check's ancestry walk.
 */
export async function unrecordedMergeLikely(
  sides: DiffSides,
  input: { readonly tip: string; readonly prev: string; readonly head: string; readonly prPaths: ReadonlySet<string> | null },
): Promise<boolean> {
  const { tip, prev, head, prPaths } = input
  try {
    const top = await readCommit(sides.base, tip)
    if (top.parents.includes(head)) return true
    let at = tip
    let commit = top
    for (let i = 0; at !== prev; i++) {
      const parent = commit.parents[0]
      if (parent === undefined || i >= RECORD_WALK) return false
      at = parent
      if (at !== prev) commit = await readCommit(sides.base, at)
    }
    if (prPaths === null) return true
    const before = await readCommit(sides.base, prev)
    const base: DiffSides = { base: sides.base, head: sides.base }
    const diff = await diffTrees(base, before.tree, top.tree)
    if (diff.truncated) return true
    return diff.changes.length > 0 && diff.changes.every((c) => prPaths.has(c.path))
  } catch {
    return false
  }
}
