/**
 * First-parent history, paged and path-filtered (F-5): the Commits page's "Older" pages and a file
 * or directory's History, over the browse plane.
 *
 * Every walk goes through a {@link historyWalker} (read-ahead blocks, so a page of commits costs a
 * few ranged reads, not one per commit), and walks of one repo share a session memo of commit →
 * the path's entry, so paging on, a second History of the same path, and Blame after History never
 * re-read what was already read. A step reads the commit and the trees along the path only;
 * subtrees off the path are never read.
 */

import { MODE_GITLINK, MODE_TREE } from '../browse'
import { commitSubject, type CommitObject } from './git-objects'
import { historyWalker, type LogEntry, type WalkOptions } from './commit-log'
import { readCommit, readTree, type ObjectReader } from './tree-nav'

/** Commits a page of the log shows. */
export const LOG_PAGE = 40

/**
 * How many commits a path-filtered walk examines before it stops and says so (the spec's cap):
 * a path touched once in a long history must not walk all of it.
 */
export const PATH_WALK_CAP = 2000

/**
 * A path's entry at a commit as `mode:oid` (one string, so two entries compare with `===`), or
 * null when the path is absent. Read it with {@link entryMode} and {@link entryOid}.
 */
export type PathEntry = string | null

/** The mode of a `mode:oid` entry. */
export const entryMode = (entry: string): number => Number(entry.slice(0, entry.indexOf(':')))
/** The oid of a `mode:oid` entry. */
export const entryOid = (entry: string): string => entry.slice(entry.indexOf(':') + 1)
/** A blob mode (a file or a symlink), not a directory or a submodule. */
export const isFileMode = (mode: number): boolean => mode !== MODE_TREE && mode !== MODE_GITLINK

/** Memo per reader: `commitOid\0path` → the path's entry; `commitOid` → the parsed commit. */
interface WalkMemo {
  readonly entries: Map<string, Promise<PathEntry>>
  readonly commits: Map<string, Promise<CommitObject>>
}
const memos = new WeakMap<object, WalkMemo>()
/**
 * Entries kept per map before the oldest are dropped: a parsed commit or a path entry is a few
 * hundred bytes, so a full memo is a few MiB (a long session on a big repo).
 */
const MEMO_MAX = 20_000

/** The memo of `reader`'s scope: every page's reader of one repo context shares it. */
function memoOf(reader: ObjectReader): WalkMemo {
  const scope = reader.memoScope ?? reader
  let m = memos.get(scope)
  if (m === undefined) {
    m = { entries: new Map(), commits: new Map() }
    memos.set(scope, m)
  }
  return m
}

function remember<V>(map: Map<string, Promise<V>>, key: string, load: () => Promise<V>): Promise<V> {
  const hit = map.get(key)
  if (hit !== undefined) return hit
  const p = load()
  map.set(key, p)
  // A failed load is forgotten, so the next read tries again (unless something newer took the key).
  p.catch(() => {
    if (map.get(key) === p) map.delete(key)
  })
  if (map.size > MEMO_MAX) map.delete(map.keys().next().value as string)
  return p
}

/** A reader's parsed commit, through the walker, memoized for the session. */
export function commitVia(reader: ObjectReader, walker: ObjectReader, oid: string): Promise<CommitObject> {
  return remember(memoOf(reader).commits, oid, () => readCommit(walker, oid))
}

/**
 * The entry of `path` (`''` = the root tree) in `treeOid`, reading only the trees along it. The
 * root tree's oid stands for `''`, so a History of the whole repo compares root trees.
 */
async function entryAt(walker: ObjectReader, treeOid: string, segments: readonly string[]): Promise<PathEntry> {
  if (segments.length === 0) return `${MODE_TREE}:${treeOid}`
  let oid = treeOid
  for (let i = 0; i < segments.length; i++) {
    const hit = (await readTree(walker, oid)).find((e) => e.name === segments[i])
    if (hit === undefined) return null
    if (i === segments.length - 1) return `${hit.mode}:${hit.oid}`
    if (hit.mode !== MODE_TREE) return null
    oid = hit.oid
  }
  return null
}

/** `path`'s entry at `commitOid` (memoized per reader). */
export function pathEntryAt(reader: ObjectReader, walker: ObjectReader, commitOid: string, path: string): Promise<PathEntry> {
  const segments = path.split('/').filter((s) => s !== '')
  return remember(memoOf(reader).entries, `${commitOid}\0${segments.join('/')}`, async () =>
    entryAt(walker, (await commitVia(reader, walker, commitOid)).tree, segments),
  )
}

/** One page of a (path-filtered) log. */
export interface LogPage {
  readonly entries: readonly LogEntry[]
  /** Where the next page starts (the first commit not yet examined), or null at the root. */
  readonly next: string | null
  /** Commits examined for this page (all of them when unfiltered). */
  readonly examined: number
  /** The page stopped at {@link PATH_WALK_CAP} commits examined without filling up. */
  readonly capped: boolean
}

/**
 * Up to `limit` first-parent commits from `startOid` (a tip, or a page's `next`), newest first.
 * With a `path`, only the commits whose change touched it (its entry differs from the parent's;
 * a root commit touches what it adds), examining at most `cap` commits; the walk ends at the
 * commit that added the path.
 */
export async function logPage(
  reader: ObjectReader,
  startOid: string,
  { path = '', limit = LOG_PAGE, cap = PATH_WALK_CAP, walker = historyWalker(reader), signal }: WalkOptions & {
    readonly path?: string
    readonly limit?: number
    readonly cap?: number
  } = {},
): Promise<LogPage> {
  const entries: LogEntry[] = []
  const filtered = path.split('/').some((s) => s !== '')
  let oid: string | undefined = startOid
  let examined = 0
  const seen = new Set<string>()
  try {
    while (oid !== undefined && entries.length < limit && !seen.has(oid)) {
      if (filtered && examined >= cap) break
      signal?.throwIfAborted()
      seen.add(oid)
      examined += 1
      const commit: CommitObject = await commitVia(reader, walker, oid)
      const parent: string | undefined = commit.parents[0]
      if (!filtered) {
        entries.push({ oid, subject: commitSubject(commit.message), commit })
      } else {
        const here = await pathEntryAt(reader, walker, oid, path)
        const there = parent === undefined ? null : await pathEntryAt(reader, walker, parent, path)
        if (here !== there) entries.push({ oid, subject: commitSubject(commit.message), commit })
        // The commit that added the path ends its History: nothing older can have changed it
        // (an earlier life of the same path, deleted then re-added, is not listed).
        if (here !== null && there === null) {
          oid = undefined
          break
        }
      }
      oid = parent
    }
  } finally {
    walker.flush?.()
  }
  const capped = filtered && examined >= cap && oid !== undefined && entries.length < limit
  return { entries, next: oid ?? null, examined, capped }
}

/** Commits {@link pathVersions} examines per step: short, so the progress it reports moves while nothing is found. */
const VERSIONS_STRIDE = 50

/** One page of a path's versions: the commits that changed it, newest first. */
export interface PathVersionsPage {
  readonly entries: readonly LogEntry[]
  /** Where the next page starts, or null when the path's history ended (its adding commit). */
  readonly next: string | null
  /** Commits examined for this page. */
  readonly examined: number
}

/**
 * The commits that changed `path`, newest first, from `startOid`: the one lookup Blame (and a
 * file's History) needs, behind a single function so a push-time index can answer it later
 * (`docs/design/last-change-index-v2.md`) without the views changing. Today it walks first-parent
 * history ({@link logPage}); `onExamined` is told the running count of commits examined, so a long
 * search shows progress before any version is found.
 */
export async function pathVersions(
  reader: ObjectReader,
  startOid: string,
  path: string,
  {
    limit = LOG_PAGE,
    cap = PATH_WALK_CAP,
    walker = historyWalker(reader),
    signal,
    onExamined,
  }: WalkOptions & { readonly limit?: number; readonly cap?: number; readonly onExamined?: (examined: number) => void } = {},
): Promise<PathVersionsPage> {
  const entries: LogEntry[] = []
  let examined = 0
  let next: string | null = startOid
  while (next !== null && entries.length < limit && examined < cap) {
    const page = await logPage(reader, next, { path, limit: limit - entries.length, cap: Math.min(VERSIONS_STRIDE, cap - examined), walker, signal })
    entries.push(...page.entries)
    examined += page.examined
    next = page.next
    onExamined?.(examined)
  }
  return { entries, next, examined }
}
