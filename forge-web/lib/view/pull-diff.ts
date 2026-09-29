/**
 * Reconstruct a pull request comparison from its base and source repository objects.
 *
 * A PR's head commit is pushed to the contributor's own repo (`sourceRepoId`), while
 * the base history lives in the repo being viewed. The comparison therefore reads through two
 * readers: head-side objects prefer the source repo, base-side objects prefer the target repo,
 * and each falls back to the other. Falling back is safe because objects are content-addressed
 * and every read is hash-verified against the oid asked for — a repo cannot answer with the
 * wrong bytes, only fail to answer.
 */

import { diffTrees, type DiffSides, type TreeDiff } from './commit-log'
import type { ReadObjectOptions } from '../browse'
import { readCommit, type ObjectReader } from './tree-nav'

/**
 * Commits read while looking for a merge base before giving up. The walk reads commits through
 * {@link historyReader}'s block read-ahead, a few hundred commits per ranged read, so this is a
 * runaway guard rather than a cost limit: 50,000 commits is about 150 reads (D-040).
 */
export const MERGE_BASE_COMMIT_CAP = 50_000

/** Progress and cancellation for a merge-base search. */
export interface MergeBaseOptions {
  readonly cap?: number
  /** Aborting stops the search with {@link MergeBaseCancelledError}. */
  readonly signal?: AbortSignal
  /** Told how many commits have been read so far (at most every {@link PROGRESS_EVERY}). */
  readonly onProgress?: (commitsRead: number) => void
}

const PROGRESS_EVERY = 100

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
  /**
   * An imported PR's base commit at the source (the merge base GitHub or GitLab diffs from),
   * recorded in its provenance block by forge-import (FG-6, L-36), or `''`.
   */
  readonly sourceBaseOid?: string
}

export interface PullComparison extends TreeDiff {
  /** The commit the head is compared against; `''` for an empty tree (a root head commit). */
  readonly comparedBaseOid: string
  /** Why the comparison is not the plain merge-base diff against the current base tip. */
  readonly comparisonNote: string | null
  /** The readers the comparison used — per-file patches must read through the same ones. */
  readonly sides: DiffSides
  /** The user stopped the merge-base search; the view offers to search again. */
  readonly searchStopped?: true
  /** No merge base was found: `comparedBaseOid` is the head's first parent, not the merge base. */
  readonly fellBack?: true
}

/**
 * A reader for one walk over many commits: each side's read-ahead view where it has one,
 * preferring `primary` as {@link preferring} does. `done` frees nothing by itself (the walker
 * is dropped with the caller's reference) but passes on the walk's batched verdicts.
 */
export function historyWalker(primary: ObjectReader, fallback: ObjectReader): { reader: ObjectReader; done: () => void } {
  const a = primary.forHistoryWalk?.()
  const b = primary === fallback ? a : fallback.forHistoryWalk?.()
  return {
    reader: preferring(a ?? primary, b ?? fallback),
    done: () => {
      a?.flush()
      if (b !== a) b?.flush()
    },
  }
}

/**
 * Read from `primary`, falling back to `fallback` when it does not hold the object. An object
 * only `fallback` indexes is read there directly: a miss in `primary` would have it re-resolve
 * its repo first (`BrowseReaderOptions.onMiss`), which is for objects neither side holds.
 */
export function preferring(primary: ObjectReader, fallback: ObjectReader): ObjectReader {
  if (primary === fallback) return primary
  return {
    async readObject(oid: string, options?: ReadObjectOptions) {
      if (primary.locate?.(oid) === null && (fallback.locate?.(oid) ?? null) !== null) return fallback.readObject(oid, options)
      try {
        return await primary.readObject(oid, options)
      } catch (primaryError) {
        try {
          return await fallback.readObject(oid, options)
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

const short = (oid: string): string => oid.slice(0, 7)

type Baseline = 'current tip' | 'tip when opened' | 'source base'

/**
 * Load a PR's comparison: the head against its merge base with the base branch, as a code
 * host shows it.
 *
 * Two baselines are recorded for a PR: the base ref's current tip and its tip when the PR was
 * opened. An unmerged PR is compared from the current tip first. A merged PR is compared from
 * the tip at open first, because the current tip now contains the head — its merge base would
 * be the head itself, an empty diff. An imported PR tries first the base commit its source
 * recorded (GitHub's `base.sha`, the base branch's tip when the PR was last updated; GitLab's
 * `diff_refs.base_sha`): its merge base with the head is where the PR branched, even after the
 * mirrored branch moved on. When no baseline works, the head commit's first parent is used, with
 * a note saying so (and, for an imported PR, the page links the source's own diff).
 */
export async function loadPullComparison(
  raw: DiffSides,
  input: PullComparisonInput,
  search: MergeBaseOptions = {},
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
  // An imported PR's source base commit comes first: GitHub's `base.sha` is the base branch's tip
  // when the PR was last updated (not the merge base), so it too goes through the merge-base
  // search, which then names where the PR branched; a merged PR's head is already in the mirror's
  // current base tip, so the source's commit is the one that still predates the merge.
  const recorded = { oid: input.imported ? (input.sourceBaseOid ?? '') : '', which: 'source base' as Baseline }
  const candidates = [recorded, ...(input.merged ? [atOpen, tip] : [tip, atOpen])].filter(
    (c, i, all) => c.oid !== '' && all.findIndex((d) => d.oid === c.oid) === i,
  )
  const failed: string[] = []
  let cancelled: MergeBaseCancelledError | null = null
  // The merge-base walk reads commits only, often thousands of them, through read-ahead. The
  // walker (and its block cache) lives for this comparison only.
  const walk = historyWalker(raw.head, raw.base)
  let found: { oid: string; which: Baseline; mergeBase: string } | null = null
  try {
    for (const { oid, which } of candidates) {
      let mergeBase: string | null
      try {
        mergeBase = await findMergeBase(walk.reader, oid, headOid, search)
      } catch (e) {
        if (e instanceof MergeBaseCancelledError) {
          cancelled = e
          failed.push(`${which}: ${e.message}`)
          break
        }
        failed.push(
          e instanceof MergeBaseSearchLimitError
            ? `${which}: ${e.message}`
            : `${which}: its history could not be read (${e instanceof Error ? e.message : String(e)})`,
        )
        continue
      }
      if (mergeBase === null) failed.push(`${which}: no common ancestor`)
      else if (mergeBase === headOid) failed.push(`${which}: it already contains this head`)
      else {
        found = { oid, which, mergeBase }
        break
      }
    }
  } finally {
    walk.done()
  }

  if (found !== null) {
    const { oid, which, mergeBase } = found
    const why = failed.length > 0 ? ` (${failed.join('; ')})` : ''
    const note =
      which === 'source base'
        ? `Compared from where this PR branched off the base commit its source records, ${short(oid)}${why}.`
        : which === 'tip when opened'
          ? `Compared against the base branch as it stood when this PR was opened, ${short(oid)}${why || (input.merged ? ', because the PR is merged' : '')}.`
          : failed.length > 0
            ? `Compared against the base branch's current tip${why}.`
            : null
    return compare(mergeBase, note)
  }

  const why =
    failed.length > 0
      ? `Could not find where this PR branched from its base (${failed.join('; ')}).`
      : 'The base branch has no recorded tip.'
  const parent = headCommit.parents[0] ?? ''
  const fallback = parent === '' ? 'Showing the root head commit in full.' : 'Showing the head commit against its first parent.'
  const result = { ...(await compare(parent, `${why} ${fallback}`)), fellBack: true as const }
  return cancelled === null ? result : { ...result, searchStopped: true }
}

class CapReached extends Error {}

/** The caller aborted the merge-base search (the "Stop" button). */
export class MergeBaseCancelledError extends Error {
  constructor(readonly commitsRead: number) {
    super(`the search for a common ancestor was stopped after ${commitsRead.toLocaleString('en-US')} commits`)
    this.name = 'MergeBaseCancelledError'
  }
}

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
  options: MergeBaseOptions | number = {},
): Promise<string | null> {
  return (await findMergeBases(reader, baseOid, headOid, options))[0] ?? null
}

/**
 * Every best merge base of `baseOid` and `headOid` (`git merge-base --all`), newest first:
 * more than one for a criss-cross history. Empty when they share no commit; rejects as
 * {@link findMergeBase} does.
 */
export async function findMergeBases(
  reader: ObjectReader,
  baseOid: string,
  headOid: string,
  options: MergeBaseOptions | number = {},
): Promise<string[]> {
  const { cap = MERGE_BASE_COMMIT_CAP, signal, onProgress } = typeof options === 'number' ? { cap: options } : options
  if (baseOid === headOid) return [headOid]
  const BASE = 1
  const HEAD = 2
  const STALE = 4

  const commits = new Map<string, { when: number; parents: readonly string[] }>()
  const load = async (oid: string): Promise<{ when: number; parents: readonly string[] }> => {
    const known = commits.get(oid)
    if (known !== undefined) return known
    if (signal?.aborted) throw new MergeBaseCancelledError(commits.size)
    if (commits.size >= cap) throw new CapReached()
    const commit = await readCommit(reader, oid)
    const value = { when: commit.committer.when, parents: commit.parents }
    commits.set(oid, value)
    if (commits.size % PROGRESS_EVERY === 0) onProgress?.(commits.size)
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

  if (candidates.length <= 1) return candidates
  // Drop a candidate that is an ancestor of another; what remains, newest first.
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
  const newest = (oids: readonly string[]): string[] =>
    [...oids].sort((a, b) => (commits.get(b)?.when ?? 0) - (commits.get(a)?.when ?? 0) || (a < b ? -1 : 1))
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
