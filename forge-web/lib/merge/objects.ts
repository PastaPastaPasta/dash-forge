/**
 * The objects a merge must push: everything reachable from the new tip that the base repo
 * does not already have (`git rev-list --objects <tip> ^<have>…`), for a **non-thin** pack.
 *
 * Commits: a date-ordered walk from the tip that paints every commit reachable from a "have"
 * commit (the base tip; for a same-repo PR the head too, whose objects are in the base repo's
 * packs already) as uninteresting, and stops once only uninteresting commits are left — git's
 * `limit_list`. A commit painted late (a skewed clock) is dropped at the end, so nothing the
 * base repo holds is counted as new; a commit mistaken the other way only makes the pack
 * larger, never incomplete.
 *
 * Trees and blobs: each new commit's tree is compared with its parents' trees path by path,
 * and only entries that differ from every parent at that path are taken (recursing into
 * differing subtrees). An entry equal to a parent's is either in the base repo (the parent
 * is a "have" commit) or taken by that parent's own walk, so the set is complete; a file that
 * only moved is taken again, which costs bytes, not correctness.
 */

import { MODE_GITLINK, MODE_TREE, type GitObject } from '../browse'
import { parseCommit, parseTree, type TreeEntry } from '../view/git-objects'
import type { ObjectReader } from '../view/tree-nav'

/** Commits a walk may read before it gives up (a runaway or corrupt history). */
export const WALK_COMMIT_CAP = 5000

export class WalkLimitError extends Error {
  constructor(readonly cap: number) {
    super(`the history walk stopped at its ${cap}-commit limit; merge with the CLI instead`)
  }
}

interface CommitInfo {
  readonly when: number
  readonly tree: string
  readonly parents: readonly string[]
}

/** The commits reachable from `tip` and from none of `have`, newest first. */
export async function newCommits(reader: ObjectReader, tip: string, have: readonly string[], cap = WALK_COMMIT_CAP): Promise<string[]> {
  const info = new Map<string, CommitInfo>()
  const load = async (oid: string): Promise<CommitInfo> => {
    const known = info.get(oid)
    if (known) return known
    if (info.size >= cap) throw new WalkLimitError(cap)
    const obj = await reader.readObject(oid)
    if (obj.type !== 'commit') throw new Error(`${oid.slice(0, 9)} is a ${obj.type}, not a commit`)
    const c = parseCommit(obj.bytes)
    const value = { when: c.committer.when, tree: c.tree, parents: c.parents }
    info.set(oid, value)
    return value
  }
  const uninteresting = new Set<string>()
  const queued = new Set<string>()
  const queue: { oid: string; when: number }[] = []
  const enqueue = async (oid: string): Promise<void> => {
    if (queued.has(oid)) return
    queued.add(oid)
    queue.push({ oid, when: (await load(oid)).when })
  }
  for (const h of have) {
    if (h === '') continue
    uninteresting.add(h)
    await enqueue(h)
  }
  await enqueue(tip)
  const out: string[] = []
  while (queue.some((q) => !uninteresting.has(q.oid))) {
    let best = 0
    for (let i = 1; i < queue.length; i++) if ((queue[i] as { when: number }).when > (queue[best] as { when: number }).when) best = i
    const { oid } = queue.splice(best, 1)[0] as { oid: string }
    const c = await load(oid)
    const bad = uninteresting.has(oid)
    if (!bad) out.push(oid)
    for (const p of c.parents) {
      if (bad) uninteresting.add(p)
      await enqueue(p)
    }
  }
  // A commit painted after it was taken (clock skew) is in the base repo after all.
  return out.filter((oid) => !uninteresting.has(oid))
}

async function readTreeEntries(reader: ObjectReader, oid: string): Promise<TreeEntry[]> {
  const obj = await reader.readObject(oid)
  if (obj.type !== 'tree') throw new Error(`${oid.slice(0, 9)} is a ${obj.type}, not a tree`)
  return parseTree(obj.bytes)
}

/**
 * Every object a pack must carry for `commits` (from {@link newCommits}): the commits, and
 * the trees and blobs of theirs no parent has at the same path. Submodule entries (gitlinks)
 * name commits of another repository and are never packed.
 */
export async function objectsToPack(reader: ObjectReader, commits: readonly string[]): Promise<GitObject[]> {
  const taken = new Set<string>()
  const out: GitObject[] = []
  const take = async (oid: string): Promise<GitObject | null> => {
    if (taken.has(oid)) return null
    taken.add(oid)
    const obj = await reader.readObject(oid)
    out.push(obj)
    return obj
  }
  // `parents` are the same-path tree oids of every parent (absent ones left out).
  const walkTree = async (oid: string, parents: readonly string[]): Promise<void> => {
    if (parents.includes(oid) || taken.has(oid)) return
    await take(oid)
    const entries = await readTreeEntries(reader, oid)
    const parentEntries = await Promise.all(parents.map((p) => readTreeEntries(reader, p)))
    for (const e of entries) {
      if (e.mode === MODE_GITLINK) continue
      const same = parentEntries.map((pe) => pe.find((x) => x.name === e.name)).filter((x): x is TreeEntry => x !== undefined)
      if (same.some((x) => x.oid === e.oid)) continue
      if (e.mode === MODE_TREE) {
        await walkTree(e.oid, same.filter((x) => x.mode === MODE_TREE).map((x) => x.oid))
      } else {
        await take(e.oid)
      }
    }
  }
  for (const c of commits) {
    const obj = await take(c)
    if (obj === null) continue
    const commit = parseCommit(obj.bytes)
    const parentTrees = await Promise.all(
      commit.parents.map(async (p) => {
        const po = await reader.readObject(p)
        return parseCommit(po.bytes).tree
      }),
    )
    await walkTree(commit.tree, parentTrees)
  }
  return out
}
