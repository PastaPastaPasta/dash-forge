/**
 * Every commit reachable from a tip, in `git log`'s order (QW-006): the Commits page's default
 * list, a page at a time. The first-parent walk ({@link logPage}) lists only the commits made on
 * the branch itself (8,366 of dash's 34,007), so a list that claims to be the history must walk
 * every parent.
 *
 * The order is git's default revision walk (`git log`, `git rev-list` with no ordering option):
 * a queue of commits by committer date, newest first, starting at the tip. Each step takes the
 * newest queued commit, lists it, and queues its parents not seen before (a commit is seen once
 * queued), each placed after every queued commit of the same or a later date (`revision.c`'s
 * `commit_list_insert_by_date`, as `process_parents` calls it). Clock skew is kept as git keeps
 * it: a parent dated after its child is listed where its date puts it among the queued commits.
 *
 * Each step reads the listed commit's parents (to learn their dates), so a page of n commits reads
 * n commits plus the parents they add to the queue, through the history walker's read-ahead blocks
 * and the session memo the first-parent walk shares.
 */

import { historyWalker, type LogEntry, type WalkOptions } from './commit-log'
import type { CommitObject } from './git-objects'
import { commitVia, LOG_PAGE, logEntryOf, PATH_WALK_CAP, pathEntryAt } from './path-history'
import type { ObjectReader } from './tree-nav'

/** A commit waiting in the walk's queue. */
interface Queued {
  readonly oid: string
  readonly commit: CommitObject
}

/**
 * Where a date-ordered walk stands: the queued commits, newest committer date first, and every
 * commit ever queued. A page never changes the walk it starts from (it copies it), so a page that
 * fails or is abandoned leaves the list able to load it again.
 */
export interface DateWalk {
  readonly queue: readonly Queued[]
  readonly seen: ReadonlySet<string>
}

/** One page of the date-ordered log. */
export interface DateLogPage {
  readonly entries: readonly LogEntry[]
  /** Where the next page starts; null once every reachable commit is listed. */
  readonly next: DateWalk | null
  /** Commits read for this page (listed ones and the parents they queued). */
  readonly examined: number
}

/** Queue `item` after every queued commit dated the same or later (git's `commit_list_insert_by_date`). */
function insertByDate(queue: Queued[], item: Queued): void {
  const when = item.commit.committer.when
  let lo = 0
  let hi = queue.length
  // The first queued commit strictly older than `item`: binary search over the date-sorted queue.
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if ((queue[mid] as Queued).commit.committer.when < when) hi = mid
    else lo = mid + 1
  }
  queue.splice(lo, 0, item)
}

/**
 * Up to `limit` commits of `git log <tip>` from `from`: a tip's oid (the first page) or a previous
 * page's {@link DateLogPage.next}.
 */
export async function dateOrderedPage(
  reader: ObjectReader,
  from: string | DateWalk,
  { limit = LOG_PAGE, walker = historyWalker(reader), signal }: WalkOptions & { readonly limit?: number } = {},
): Promise<DateLogPage> {
  const entries: LogEntry[] = []
  let examined = 0
  let queue: Queued[]
  let seen: Set<string>
  try {
    if (typeof from === 'string') {
      queue = [{ oid: from, commit: await commitVia(reader, walker, from) }]
      seen = new Set([from])
      examined += 1
    } else {
      queue = [...from.queue]
      seen = new Set(from.seen)
    }
    while (entries.length < limit && queue.length > 0) {
      signal?.throwIfAborted()
      const { oid, commit } = queue.shift() as Queued
      entries.push(logEntryOf(oid, commit))
      const fresh: string[] = []
      for (const p of commit.parents) {
        if (seen.has(p)) continue
        seen.add(p)
        fresh.push(p)
      }
      // A merge's parents are read together; they are queued in parent order, as git queues them.
      const parents = await Promise.all(fresh.map((p) => commitVia(reader, walker, p)))
      examined += parents.length
      fresh.forEach((p, i) => insertByDate(queue, { oid: p, commit: parents[i] as CommitObject }))
    }
  } finally {
    walker.flush?.()
  }
  return { entries, next: queue.length > 0 ? { queue, seen } : null, examined }
}

/** One page of a path's full history ({@link pathDateOrderedPage}). */
export interface PathDateLogPage extends DateLogPage {
  /** The page stopped at its cap of commits examined without filling up. */
  readonly capped: boolean
}

/**
 * Up to `limit` commits of `git log <tip> -- <path>` from `from` (a tip, or a page's `next`): a
 * file's or a directory's History with every commit, not the first-parent ones alone (QW2-041).
 *
 * git's default history simplification, over the same date-ordered walk as {@link dateOrderedPage}:
 * a commit whose `path` entry equals one parent's is not listed, and the walk follows only the
 * first such parent (a merge that took the file from one side stands for nothing); a commit that
 * differs from every parent changed it (or deleted it), is listed, and the walk goes on through
 * its parents. A root commit is listed when it has the path. Unlike git, the walk does not go on into a parent
 * without the path: the commit that added it ends that line (an earlier life of the same path,
 * deleted then added again, is not listed, as the first-parent History does not list it), so a
 * History never walks the rest of the repository's past. At most `cap` commits are examined.
 */
export async function pathDateOrderedPage(
  reader: ObjectReader,
  from: string | DateWalk,
  path: string,
  { limit = LOG_PAGE, cap = PATH_WALK_CAP, walker = historyWalker(reader), signal }: WalkOptions & { readonly limit?: number; readonly cap?: number } = {},
): Promise<PathDateLogPage> {
  const entries: LogEntry[] = []
  let examined = 0
  let queue: Queued[]
  let seen: Set<string>
  try {
    if (typeof from === 'string') {
      queue = [{ oid: from, commit: await commitVia(reader, walker, from) }]
      seen = new Set([from])
    } else {
      queue = [...from.queue]
      seen = new Set(from.seen)
    }
    while (entries.length < limit && queue.length > 0 && examined < cap) {
      signal?.throwIfAborted()
      const { oid, commit } = queue.shift() as Queued
      examined += 1
      const [here = null, ...there] = await Promise.all([oid, ...commit.parents].map((c) => pathEntryAt(reader, walker, c, path)))
      const same = there.indexOf(here)
      // Unchanged against a parent: not listed, and only that parent's line is followed.
      const follow = same >= 0 ? [commit.parents[same] as string] : commit.parents.filter((_, i) => there[i] !== null)
      // Changed against every parent (a deletion too); a root commit only when it has the path.
      if (same < 0 && (here !== null || commit.parents.length > 0)) entries.push(logEntryOf(oid, commit))
      const fresh = follow.filter((p) => !seen.has(p))
      for (const p of fresh) seen.add(p)
      const parents = await Promise.all(fresh.map((p) => commitVia(reader, walker, p)))
      fresh.forEach((p, i) => insertByDate(queue, { oid: p, commit: parents[i] as CommitObject }))
    }
  } finally {
    walker.flush?.()
  }
  const next = queue.length > 0 ? { queue, seen } : null
  return { entries, next, examined, capped: next !== null && examined >= cap && entries.length < limit }
}
