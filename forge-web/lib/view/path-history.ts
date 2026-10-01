/**
 * First-parent history, paged and path-filtered (F-5): the Commits page's "Older" pages and a file
 * or directory's History, over the browse plane.
 *
 * A path's versions ({@link pathVersions}: History and Blame) come from the push-time history
 * index's version lists (kind 5) when they cover the start commit (`docs/design/history-index.md`): its list for the
 * path names each change's commit, author, subject and blob, so no commit or tree is read. Past
 * the list's end, or with no index, they come from a walk.
 *
 * Every walk goes through a {@link historyWalker} (read-ahead blocks, so a page of commits costs a
 * few ranged reads, not one per commit), and walks of one repo share a session memo of commit →
 * the path's entry, so paging on, a second History of the same path, and Blame after History never
 * re-read what was already read. A step reads the commit and the trees along the path only;
 * subtrees off the path are never read.
 */

import { MODE_GITLINK, MODE_TREE } from '../browse'
import type { VersionList } from '../browse/history-index'
import { commitSubject, type CommitObject } from './git-objects'
import { historyWalker, type LogEntry, type PrefixReader, type WalkOptions } from './commit-log'
import { historyOf, type HistorySource } from './history-source'
import { readCommit, readTree, type ObjectReader } from './tree-nav'
import { trimOldest } from './pool'

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

/**
 * Memo per reader: `commitOid\0path` → the path's entry; `commitOid` → the parsed commit;
 * `commitOid\0path` → where that version sits in a list the history index served, so a page
 * that starts there (History's "Older", Blame's next page) goes on from the list.
 */
interface WalkMemo {
  readonly entries: Map<string, Promise<PathEntry>>
  readonly commits: Map<string, Promise<CommitObject>>
  readonly listed: Map<string, ListedAt>
  /** `tip\0path` of the newest index's lists already served for a walk to join ({@link serveNewestList}). */
  readonly joined: Set<string>
}

/** A version inside a list the index served. */
interface ListedAt {
  readonly list: ServedList
  readonly at: number
}

/** A path's version list as served: log entries with their `mode:oid` where it resolved. */
interface ServedList {
  readonly versions: readonly PathVersion[]
  /** Each version's mode and blob oid prefix as the index gives them: what a start is checked against. */
  readonly claims: readonly VersionClaim[]
  readonly complete: boolean
}

/** What the index says a path's entry is after a commit (no oid for a directory or a gitlink). */
interface VersionClaim {
  readonly mode: number
  readonly oidPrefix: string
}

/**
 * Whether the path's entry at a commit is what the index claims. For a file the blob oid prefix
 * is compared; for a directory or a gitlink only the mode (the index stores no oid for them).
 */
const matches = (here: PathEntry, claim: VersionClaim): boolean =>
  here !== null && entryMode(here) === claim.mode && entryOid(here).startsWith(claim.oidPrefix)
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
    m = { entries: new Map(), commits: new Map(), listed: new Map(), joined: new Set() }
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
  trimOldest(map, MEMO_MAX)
  return p
}

/** A reader's parsed commit, through the walker, memoized for the session. */
export function commitVia(reader: ObjectReader, walker: ObjectReader, oid: string): Promise<CommitObject> {
  return remember(memoOf(reader).commits, oid, () => readCommit(walker, oid))
}

/**
 * Read a view's tip commit through `reader` itself into the session memo, so the walks that start
 * there (the log, a History, Blame, the commit column) do not read it again through a cold
 * read-ahead walker. The tip resolver reads it first anyway.
 */
export function primeCommit(reader: ObjectReader, oid: string): Promise<CommitObject> {
  return commitVia(reader, reader, oid)
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

/** A log row from a parsed commit. */
export const logEntryOf = (oid: string, commit: CommitObject): LogEntry => ({
  oid,
  subject: commitSubject(commit.message),
  author: commit.author,
  committedAt: commit.committer.when,
})

/**
 * Up to `limit` first-parent commits from `startOid` (a tip, or a page's `next`), newest first.
 * With a `path`, only the commits whose change touched it (its entry differs from the parent's;
 * a root commit touches what it adds), examining at most `cap` commits; the walk ends at the
 * commit that added the path. `stopAt`: a commit (other than `startOid`) where the walk stops
 * before examining it, returned as `next` (one a history index covers).
 */
export async function logPage(
  reader: ObjectReader,
  startOid: string,
  { path = '', limit = LOG_PAGE, cap = PATH_WALK_CAP, walker = historyWalker(reader), signal, stopAt }: WalkOptions & {
    readonly path?: string
    readonly limit?: number
    readonly cap?: number
    readonly stopAt?: (oid: string) => boolean
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
      if (oid !== startOid && stopAt?.(oid) === true) break
      signal?.throwIfAborted()
      seen.add(oid)
      examined += 1
      const commit: CommitObject = await commitVia(reader, walker, oid)
      const parent: string | undefined = commit.parents[0]
      if (!filtered) {
        entries.push(logEntryOf(oid, commit))
      } else {
        const here = await pathEntryAt(reader, walker, oid, path)
        const there = parent === undefined ? null : await pathEntryAt(reader, walker, parent, path)
        if (here !== there) entries.push(logEntryOf(oid, commit))
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

/** A version of a path: the commit that changed it, and the path's `mode:oid` after it when known without reading trees. */
export interface PathVersion extends LogEntry {
  /** The path's `mode:oid` after this commit, when the history index named it (and its oid resolved). */
  readonly entry?: string
}

/** Commits {@link pathVersions} examines per step: short, so the progress it reports moves while nothing is found. */
const VERSIONS_STRIDE = 50

/** One page of a path's versions: the commits that changed it, newest first. */
export interface PathVersionsPage extends LogPage {
  readonly entries: readonly PathVersion[]
  /** How many of the entries the history index listed (no walk). */
  readonly indexed: number
}

/**
 * The commits that changed `path`, newest first, from `startOid`: the lookup Blame and a path's
 * History need, behind one function (`docs/design/last-change-index-v2.md`).
 *
 * 1. When a history index covers `startOid` (or `startOid` is inside a list one already served),
 *    its list for the path answers with no walk: each entry's commit, author and subject, and the
 *    path's `mode:oid` resolved from the blob oid prefix through the locator. The list is used
 *    only when the path's entry at `startOid` is what it claims there: the blob oid prefix for a
 *    file; for a directory or a gitlink only the mode, since the index stores no oid for them.
 * 2. Past the end of a list that does not reach the path's first commit, the walk goes on from
 *    the oldest listed commit's parent.
 * 3. Otherwise it walks first-parent history ({@link logPage}), and stops where an index covers
 *    a commit to go on from its list (an index a few pushes behind), or where it reaches a version
 *    listed by the newest index (QW2-036): before its first walk it serves that index's list of
 *    the path, so a tag or a branch whose first-parent history joins the default branch's walks
 *    only to the first version on the shared part. A version in that list is on the indexed
 *    tip's first-parent chain, so every older one is too, and the list from there is this
 *    history's as well (checked against the trees at the version, as any served list is).
 *
 * An index that is missing, fails to load or does not match leaves the walk as the answer, and
 * so does a list naming a commit that cannot be read (from the last position the trees checked).
 * `onExamined` is told the running count of commits examined, so a long search shows progress
 * before any version is found.
 */
export async function pathVersions(
  reader: PrefixReader,
  startOid: string,
  path: string,
  {
    limit = LOG_PAGE,
    listLimit = limit,
    cap = PATH_WALK_CAP,
    walker = historyWalker(reader),
    signal,
    onExamined,
  }: WalkOptions & {
    readonly limit?: number
    /**
     * How many entries a page the index answers may hold (default `limit`). The list is already
     * in hand, so a caller that consumes versions rather than showing pages (Blame) takes it
     * whole: each later page would check the trees at its start again.
     */
    readonly listLimit?: number
    readonly cap?: number
    readonly onExamined?: (examined: number) => void
  } = {},
): Promise<PathVersionsPage> {
  const key = path.split('/').filter((s) => s !== '').join('/')
  const history = key === '' ? null : historyOf(reader)
  const entries: PathVersion[] = []
  let examined = 0
  let indexed = 0
  let next: string | null = startOid
  // Set when a list named a commit this repository cannot read: the rest of this call walks.
  let distrusted = key === ''
  const most = Math.max(limit, listLimit)
  const served = memoOf(reader).listed
  // Whether the newest index's list of the path was served for this call's walk (once a call).
  let joined = false
  while (next !== null && entries.length < limit && examined < cap) {
    signal?.throwIfAborted()
    const listed: ListedAt | null = distrusted ? null : await listedAt(reader, walker, next, key)
    if (listed !== null) {
      const { list, at }: ListedAt = listed
      const taken: readonly PathVersion[] = list.versions.slice(at, at + most - entries.length)
      const end: number = at + taken.length
      let after: string | null
      try {
        after =
          list.versions[end]?.oid ??
          (list.complete ? null : ((await commitVia(reader, walker, (taken[taken.length - 1] as PathVersion).oid)).parents[0] ?? null))
      } catch (e) {
        if (signal?.aborted === true) throw e
        // The list names a commit that cannot be read: it is not believed. Walk from this page's
        // start, which was checked against the trees, and find these versions again.
        forgetList(memoOf(reader), list, key)
        distrusted = true
        continue
      }
      entries.push(...taken)
      indexed += taken.length
      next = after
      continue
    }
    const from: string = next
    if (history !== null && !joined && !distrusted) {
      joined = true
      await serveNewestList(reader, walker, history, from, key)
      signal?.throwIfAborted()
      // `from` is itself a version the list holds: go on from the list, not the walk.
      if (served.has(`${from}\0${key}`)) continue
    }
    const page = await logPage(reader, from, {
      path,
      limit: limit - entries.length,
      cap: Math.min(VERSIONS_STRIDE, cap - examined),
      walker,
      signal,
      ...(history !== null
        ? { stopAt: (oid: string) => history.coversVersions(oid) || (!distrusted && served.has(`${oid}\0${key}`)) }
        : {}),
    })
    entries.push(...page.entries)
    examined += page.examined
    next = page.next
    onExamined?.(examined)
  }
  walker.flush?.()
  const capped = examined >= cap && next !== null && entries.length < limit
  return { entries, next, examined, capped, indexed }
}

/**
 * Where `start` sits in a version list of `path` the history index answers: a list served
 * before that holds it, or the list of the index covering `start`. Null when no index answers.
 */
async function listedAt(reader: PrefixReader, walker: ObjectReader, start: string, path: string): Promise<ListedAt | null> {
  const memo = memoOf(reader)
  // The path's entry here, or null when it cannot be read (the walk then says why).
  const entryHere = (): Promise<PathEntry> => pathEntryAt(reader, walker, start, path).catch(() => null)
  const hit = memo.listed.get(`${start}\0${path}`)
  if (hit !== undefined) {
    // A list served before holds `start`: believed here only if the trees agree (a list's commits
    // are keys for every view of this repo, so a wrong one must not answer another branch). One
    // that misstates a version is not believed anywhere: no later walk stops to resume in it.
    if (matches(await entryHere(), hit.list.claims[hit.at] as VersionClaim)) return hit
    forgetList(memo, hit.list, path)
    return null
  }
  const history = historyOf(reader)
  if (history === null || !history.coversVersions(start)) return null
  let got: VersionList | undefined
  try {
    got = (await history.loadVersions(start)).versions?.get(path)
  } catch {
    return null
  }
  const newest = got?.versions[0]
  if (got === undefined || newest === undefined) return null
  // The list must describe this commit's tree: its newest version is the path's entry here.
  const here = await entryHere()
  if (here === null || !matches(here, newest)) return null
  const versions = await Promise.all(
    got.versions.map(async (v, i): Promise<PathVersion> => {
      const entry = i === 0 ? here : await resolveEntry(reader, v.mode, v.oidPrefix)
      return { oid: v.commit.oid, subject: v.commit.subject, author: { name: v.commit.author, when: v.commit.when }, ...(entry !== undefined ? { entry } : {}) }
    }),
  )
  const list: ServedList = { versions, claims: got.versions, complete: got.complete }
  versions.forEach((v, at) => {
    memo.listed.set(`${v.oid}\0${path}`, { list, at })
  })
  trimOldest(memo.listed, MEMO_MAX)
  return { list, at: 0 }
}

/**
 * Serve the newest index's list of `path` (once per session: {@link listedAt} memoizes it), so a
 * walk from `start`, which no index covers, can stop at the first version it shares with that
 * history. Best effort: a list that does not load or does not match leaves the walk as it is.
 */
async function serveNewestList(reader: PrefixReader, walker: ObjectReader, history: HistorySource, start: string, path: string): Promise<void> {
  const tip = history.versionTips?.[0]
  if (tip === undefined || tip === start) return
  const joined = memoOf(reader).joined
  const key = `${tip}\0${path}`
  if (joined.has(key)) return
  joined.add(key)
  await listedAt(reader, walker, tip, path).catch(() => null)
}

/** Drop a list that turned out wrong, so no later page resumes in it. */
function forgetList(memo: WalkMemo, list: ServedList, path: string): void {
  for (const v of list.versions) {
    const k = `${v.oid}\0${path}`
    if (memo.listed.get(k)?.list === list) memo.listed.delete(k)
  }
}

/**
 * A version's `mode:oid` from its blob oid prefix: the one object of the locator it names (the
 * reader hash-checks whatever it then reads). Undefined for a directory or a gitlink, or when
 * the prefix does not name exactly one object (the caller reads the trees instead).
 */
async function resolveEntry(reader: PrefixReader, mode: number, prefix: string): Promise<string | undefined> {
  if (!isFileMode(mode) || prefix === '') return undefined
  // An index slice that cannot be read leaves it unresolved too.
  const found = (await reader.findByPrefix?.(prefix, 2).catch(() => undefined)) ?? []
  return found.length === 1 ? `${mode}:${found[0] as string}` : undefined
}
