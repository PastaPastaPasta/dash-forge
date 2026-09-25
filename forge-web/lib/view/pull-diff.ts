/**
 * Reconstruct a pull request comparison from its base and source repository objects.
 *
 * A PR's head commit is pushed to the contributor's own repo (v1 `sourceContractId`, forge-v2
 * `sourceRepoId`), while
 * the base history lives in the repo being viewed. The comparison therefore reads through two
 * readers: head-side objects prefer the source repo, base-side objects prefer the target repo,
 * and each falls back to the other. Falling back is safe because objects are content-addressed
 * and every read is hash-verified against the oid asked for — a repo cannot answer with the
 * wrong bytes, only fail to answer.
 */

import { diffTrees, type DiffSides, type TreeDiff } from './commit-log'
import { readCommit, type ObjectReader } from './tree-nav'

/** Commits read while looking for a merge base before giving up. */
export const MERGE_BASE_COMMIT_CAP = 2000

export interface PullComparisonInput {
  /** The base ref's current tip (`''` when it has none). */
  readonly baseTipOid: string
  /** The base ref's tip when the PR was opened (`''` when it had none). */
  readonly baseOidAtOpen: string
  readonly headOid: string
  /** The PR is merged: its base now contains the head, so compare from the tip at open first. */
  readonly merged: boolean
  /** An archived PR from another forge — never shown with an inexact baseline. */
  readonly imported: boolean
}

export interface PullComparison extends TreeDiff {
  /** The commit the head is compared against; `''` for an empty tree (a root head commit). */
  readonly comparedBaseOid: string
  /** Why the comparison is not the plain merge-base diff against the current base tip. */
  readonly comparisonNote: string | null
  /** The readers the comparison used — per-file patches must read through the same ones. */
  readonly sides: DiffSides
}

/** Read from `primary`, falling back to `fallback` when it does not hold the object. */
export function preferring(primary: ObjectReader, fallback: ObjectReader): ObjectReader {
  if (primary === fallback) return primary
  return {
    async readObject(oid: string) {
      try {
        return await primary.readObject(oid)
      } catch (primaryError) {
        try {
          return await fallback.readObject(oid)
        } catch {
          throw primaryError
        }
      }
    },
    locate(oid: string) {
      return primary.locate?.(oid) ?? fallback.locate?.(oid) ?? null
    },
  }
}

export const IMPORTED_BASE_ERROR = 'the imported record did not preserve its original target commit'

const short = (oid: string): string => oid.slice(0, 7)

type Baseline = 'current tip' | 'tip when opened'

/**
 * Load a PR's comparison: the head against its merge base with the base branch, as a code
 * host shows it.
 *
 * Two baselines are recorded for a PR: the base ref's current tip and its tip when the PR was
 * opened. An unmerged PR is compared from the current tip first. A merged PR is compared from
 * the tip at open first, because the current tip now contains the head — its merge base would
 * be the head itself, an empty diff. When neither baseline works, a native PR falls back to
 * the head commit's first parent, with a note saying so. An imported PR never does: its first
 * parent can omit earlier commits of the original PR, so an inexact diff is worse than linking
 * to the archived upstream comparison.
 */
export async function loadPullComparison(
  raw: DiffSides,
  input: PullComparisonInput,
): Promise<PullComparison> {
  const sides: DiffSides = { base: preferring(raw.base, raw.head), head: preferring(raw.head, raw.base) }
  const { headOid } = input

  let headCommit
  try {
    headCommit = await readCommit(sides.head, headOid)
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e)
    throw new Error(`the PR head ${short(headOid)} could not be read from the source repo (${reason})`)
  }

  const compare = async (baseOid: string, comparisonNote: string | null): Promise<PullComparison> => {
    const baseTree = baseOid === '' ? null : (await readCommit(sides.base, baseOid)).tree
    const diff = await diffTrees(sides, baseTree, headCommit.tree)
    return { ...diff, comparedBaseOid: baseOid, comparisonNote, sides }
  }

  const tip = { oid: input.baseTipOid, which: 'current tip' as Baseline }
  const atOpen = { oid: input.baseOidAtOpen, which: 'tip when opened' as Baseline }
  const candidates = (input.merged ? [atOpen, tip] : [tip, atOpen]).filter(
    (c, i, all) => c.oid !== '' && all.findIndex((d) => d.oid === c.oid) === i,
  )
  const failed: string[] = []
  for (const { oid, which } of candidates) {
    let mergeBase: string | null
    try {
      mergeBase = await findMergeBase(sides.head, oid, headOid)
    } catch (e) {
      failed.push(
        e instanceof MergeBaseSearchLimitError
          ? `${which}: ${e.message}`
          : `${which}: its history could not be read (${e instanceof Error ? e.message : String(e)})`,
      )
      continue
    }
    if (mergeBase === null) {
      failed.push(`${which}: no common ancestor`)
      continue
    }
    if (mergeBase === headOid) {
      failed.push(`${which}: it already contains this head`)
      continue
    }
    const why = failed.length > 0 ? ` (${failed.join('; ')})` : ''
    const note =
      which === 'tip when opened'
        ? `Compared against the base branch as it stood when this PR was opened, ${short(oid)}${why || (input.merged ? ', because the PR is merged' : '')}.`
        : failed.length > 0
          ? `Compared against the base branch's current tip${why}.`
          : null
    return compare(mergeBase, note)
  }

  if (input.imported) throw new Error(IMPORTED_BASE_ERROR)
  const why =
    failed.length > 0
      ? `Could not find where this PR branched from its base (${failed.join('; ')}).`
      : 'The base branch has no recorded tip.'
  const parent = headCommit.parents[0] ?? ''
  const fallback = parent === '' ? 'Showing the root head commit in full.' : 'Showing the head commit against its first parent.'
  return compare(parent, `${why} ${fallback}`)
}

class CapReached extends Error {}

/**
 * The merge-base search stopped at its commit cap. Distinct from "no common ancestor": the
 * histories may well be related (a candidate may already have been found), the walk just did
 * not finish, so no base can be named with confidence.
 */
export class MergeBaseSearchLimitError extends Error {
  constructor(readonly cap: number) {
    super(`the search for a common ancestor stopped at its ${cap}-commit limit`)
  }
}

/**
 * Find the best merge base of `baseOid` and `headOid` — git's `paint_down_to_common` plus
 * `remove_redundant`. Both histories are walked newest-commit-first, each commit painted with
 * the side(s) it is reachable from; a commit reached from both is a candidate, and its
 * ancestors are marked stale. The walk continues until only stale commits remain, and any
 * candidate that is an ancestor of another is then dropped. Running to completion rather than
 * returning the first candidate is what keeps a skewed committer clock from yielding an older
 * common ancestor than the fork point.
 *
 * `null` when the histories share no commit. Rejects with {@link MergeBaseSearchLimitError}
 * when the walk would have to read more than `cap` commits (so corrupt or enormous history
 * cannot run away) — even if a candidate was already seen, since a later one could be better —
 * and with the read error when a commit cannot be read.
 */
export async function findMergeBase(
  reader: ObjectReader,
  baseOid: string,
  headOid: string,
  cap = MERGE_BASE_COMMIT_CAP,
): Promise<string | null> {
  if (baseOid === headOid) return headOid
  const BASE = 1
  const HEAD = 2
  const STALE = 4

  const commits = new Map<string, { when: number; parents: readonly string[] }>()
  const load = async (oid: string): Promise<{ when: number; parents: readonly string[] }> => {
    const known = commits.get(oid)
    if (known !== undefined) return known
    if (commits.size >= cap) throw new CapReached()
    const commit = await readCommit(reader, oid)
    const value = { when: commit.committer.when, parents: commit.parents }
    commits.set(oid, value)
    return value
  }

  const flags = new Map<string, number>()
  const flagsOf = (oid: string): number => flags.get(oid) ?? 0
  const queue: { oid: string; when: number; seq: number }[] = []
  let seq = 0
  const push = async (oid: string, flag: number): Promise<void> => {
    flags.set(oid, flagsOf(oid) | flag)
    const { when } = await load(oid)
    queue.push({ oid, when, seq: seq++ })
  }

  const candidates: string[] = []
  try {
    await Promise.all([push(baseOid, BASE), push(headOid, HEAD)])
    while (queue.some((q) => (flagsOf(q.oid) & STALE) === 0)) {
      // Newest first; ties in insertion order. The frontier stays small, so a scan is fine.
      let best = 0
      for (let i = 1; i < queue.length; i++) {
        const q = queue[i] as (typeof queue)[number]
        const b = queue[best] as (typeof queue)[number]
        if (q.when > b.when || (q.when === b.when && q.seq < b.seq)) best = i
      }
      const { oid } = queue.splice(best, 1)[0] as (typeof queue)[number]
      let flag = flagsOf(oid) & (BASE | HEAD | STALE)
      if (flag === (BASE | HEAD)) {
        candidates.push(oid)
        flag |= STALE
        flags.set(oid, flagsOf(oid) | STALE)
      }
      const parents = (commits.get(oid) as { parents: readonly string[] }).parents
      // A commit's parents are independent reads — fetch them together.
      await Promise.all(parents.filter((p) => (flagsOf(p) & flag) !== flag).map((p) => push(p, flag)))
    }
  } catch (e) {
    if (e instanceof CapReached) throw new MergeBaseSearchLimitError(cap)
    throw e
  }

  if (candidates.length <= 1) return candidates[0] ?? null
  // Drop a candidate that is an ancestor of another; of what remains, take the newest.
  const isAncestorOf = async (ancestor: string, of: string): Promise<boolean> => {
    const seen = new Set<string>()
    const stack = [of]
    while (stack.length > 0) {
      const oid = stack.pop() as string
      if (oid === ancestor) return true
      if (seen.has(oid)) continue
      seen.add(oid)
      stack.push(...(await load(oid)).parents)
    }
    return false
  }
  const newest = (oids: readonly string[]): string =>
    [...oids].sort((a, b) => (commits.get(b)?.when ?? 0) - (commits.get(a)?.when ?? 0) || (a < b ? -1 : 1))[0] as string
  try {
    const kept: string[] = []
    for (const c of candidates) {
      let redundant = false
      for (const other of candidates) {
        if (other !== c && (await isAncestorOf(c, other))) {
          redundant = true
          break
        }
      }
      if (!redundant) kept.push(c)
    }
    return newest(kept.length > 0 ? kept : candidates)
  } catch (e) {
    // Picking among unreduced candidates would be a guess — the same "inexact baseline" the
    // caller refuses elsewhere — so the cap is reported rather than papered over.
    if (e instanceof CapReached) throw new MergeBaseSearchLimitError(cap)
    throw e
  }
}
