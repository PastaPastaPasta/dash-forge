/**
 * Repo facts (F-5): the LICENSE and the language bar the About card shows, worked out once per
 * commit from what the repo home reads, and kept for the session.
 *
 * The home owns the browse reader; the rail's About card does not. So the home computes the facts
 * (after its own list, README and commit column have settled) and publishes them here, keyed by
 * repo and tip, and the card subscribes. One file walk per tip ({@link repoFilesWalk}): the
 * language bar and Go to file share it, and a second visit reuses it.
 *
 * A private repo's keys carry its decryption session (`repoId#session`) and its facts name
 * decrypted paths: they go when the session ends, as the browse caches do.
 *
 * The card's release count and repo size are proved sums the rail reads itself
 * ({@link readAboutTotals}).
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { MODE_GITLINK, MODE_TREE, ObjectTooLargeError } from '../browse'
import type { Network } from '../constants'
import { repoKey, type RepoRef } from '../repo/contract'
import { readGitPackBytes, type GitPackBytes } from '../repo/packs'
import { onPrivateSessionEnded } from '../repo/private-session'
import { onRepoContentWritten } from '../repo/push'
import { readReleaseCount, readReleases, releaseCountOf } from '../repo/releases'
import { invalidateSessionCache, sessionCached } from './session-cache'
import { historyWalker } from './commit-log'
import { historyOf } from './history-source'
import { readBlob, type ObjectReader } from './tree-nav'
import { decodeTextBlob, type TreeEntry } from './git-objects'
import { formatBytes } from './format'
import { detectLicense, isLicenseFile, LICENSE_MAX_BYTES, type RepoLicense } from './license'
import { languageStats, type LanguageStats } from './languages'
import { mapPooled, trimOldest } from './pool'
import { FILE_WALK_FILES, FILE_WALK_TREES, walkFiles, type FileWalk } from './zip'

export interface RepoFacts {
  /** null: no license file; undefined: not known yet (a failed read stays unknown and is tried again). */
  readonly license: RepoLicense | null | undefined
  readonly languages: LanguageStats | null | undefined
}

const UNKNOWN: RepoFacts = { license: undefined, languages: undefined }
const facts = new Map<string, RepoFacts>()
const listeners = new Set<() => void>()
const walks = new Map<string, Promise<FileWalk>>()
/** Tips whose facts are kept (small), and whose file walks are (up to 5,000 paths each). */
const KEEP_FACTS = 50
const KEEP_WALKS = 10
/** License files read at once. */
const LICENSE_READ_POOL = 8
/** License files read in all (a real repo has one to three; a root of hundreds is not read whole). */
const LICENSE_FILES_MAX = 16

const keyOf = (repoKey: string, tipOid: string): string => `${repoKey}\0${tipOid}`

function publish(key: string, next: Partial<RepoFacts>): void {
  facts.set(key, { ...(facts.get(key) ?? UNKNOWN), ...next })
  trimOldest(facts, KEEP_FACTS)
  for (const l of listeners) l()
}

onPrivateSessionEnded((id) => {
  let dropped = false
  for (const m of [facts, walks]) {
    for (const k of [...m.keys()]) {
      if (k.includes(`#${id}\0`)) {
        m.delete(k)
        dropped = true
      }
    }
  }
  if (dropped) for (const l of listeners) l()
})

/** The facts known for this repo at this tip (a stable reference until they change). */
export function repoFacts(repoKey: string, tipOid: string | null): RepoFacts {
  return tipOid === null ? UNKNOWN : (facts.get(keyOf(repoKey, tipOid)) ?? UNKNOWN)
}

export function subscribeRepoFacts(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * The walk of the repo's files at this tip (up to {@link FILE_WALK_FILES} files, and a safety cap of
 * {@link FILE_WALK_TREES} trees so a push of many empty directories cannot make it read without
 * end; no real repo reaches it before the file bound, so Go to file keeps its reach), started once per tip and
 * shared with the language bar, through a read-ahead walker (a pack keeps its trees together). Not
 * cancellable: the next caller wants the same walk.
 */
export function repoFilesWalk(
  repoKey: string,
  tipOid: string,
  reader: ObjectReader,
  rootTree: string,
  { maxTrees = FILE_WALK_TREES }: { readonly maxTrees?: number } = {},
): Promise<FileWalk> {
  const key = keyOf(repoKey, tipOid)
  let walk = walks.get(key)
  if (walk === undefined) {
    const walker = historyWalker(reader)
    const started = walkFiles(walker, rootTree, { maxTrees, maxFiles: FILE_WALK_FILES }).finally(() => walker.flush?.())
    walk = started
    walks.set(key, started)
    // A failed walk is forgotten (the next caller tries again), unless a newer one took the key.
    started.catch(() => {
      if (walks.get(key) === started) walks.delete(key)
    })
    trimOldest(walks, KEEP_WALKS)
  }
  return walk
}

/**
 * Whether the history index of `tipOid` lists its files exactly: a full index of that very tip,
 * not a delta (which can still name a file deleted since its base). Go to file then needs no tree
 * walk, which on a large repo reads its whole object index (QW3-001: 9.65 MB on dashpay/dash).
 */
export function indexListsTip(reader: { readonly memoScope?: object }, tipOid: string): boolean {
  const entry = historyOf(reader)?.byTip.get(tipOid)
  return entry !== undefined && entry.baseTip === null
}

/** Each history index's file paths, worked out once. */
const indexedFiles = new WeakMap<object, readonly string[]>()

/**
 * The files at `tipOid` as the history index lists them (QW-028), with no tree read: the index the
 * file list's column already loaded names every path of the tip (directories too, which are left
 * out here). Null when no index covers the tip. A delta over a full index can still name a file
 * deleted since that full index (the reader drops such paths when a tree lists names), so a caller
 * takes these as a first answer until the tree walk ({@link repoFilesWalk}) has the exact one.
 */
export async function indexedFilePaths(reader: { readonly memoScope?: object }, tipOid: string): Promise<readonly string[] | null> {
  const history = historyOf(reader)
  if (history === null || !history.covers(tipOid)) return null
  const index = await history.load(tipOid)
  const hit = indexedFiles.get(index)
  if (hit !== undefined) return hit
  const dirs = new Set<string>()
  for (const path of index.paths.keys()) {
    for (let at = path.indexOf('/'); at !== -1; at = path.indexOf('/', at + 1)) dirs.add(path.slice(0, at))
  }
  const files = [...index.paths.keys()].filter((p) => !dirs.has(p)).sort()
  indexedFiles.set(index, files)
  return files
}

/**
 * Work out and publish the facts for this tip: the license from the root's license files (a few
 * KiB each, through the page's reader), then the language bar from the shared file walk. Facts
 * already known are not read again; a fact whose read failed stays unknown, so the next visit
 * tries again.
 *
 * Both facts sit below the fold: nothing is read until a viewer has the About card in view
 * ({@link wantRepoFacts}, S-1). While a load is registered for a tip ({@link repoFactsLoading}) the
 * card shows a placeholder; when none is (a route that works no facts out, an empty repo, a load
 * that failed or was left) it shows nothing, as before.
 */
export async function loadRepoFacts(
  repoKey: string,
  tipOid: string,
  reader: ObjectReader,
  rootTree: string,
  rootEntries: readonly TreeEntry[],
  signal?: AbortSignal,
): Promise<void> {
  const key = keyOf(repoKey, tipOid)
  const known = facts.get(key) ?? UNKNOWN
  if (known.license !== undefined && known.languages !== undefined) return
  setLoading(key, 1)
  try {
    await whenFactsWanted(repoKey, signal)
    if (known.license === undefined) {
      // Files only: a directory named `license/` is not a license.
      const files = rootEntries.filter((e) => isLicenseFile(e.name) && e.mode !== MODE_TREE && e.mode !== MODE_GITLINK).slice(0, LICENSE_FILES_MAX)
      // A few files at a time: a root of many LICENSE-* files must not fire every read at once. A
      // file too large is not placed; any other failure fails the load, so the next visit tries again.
      const texts = await mapPooled(files, LICENSE_READ_POOL, async (e): Promise<readonly [string, string | null]> => {
        try {
          return [e.name, decodeTextBlob(await readBlob(reader, e.oid, LICENSE_MAX_BYTES))]
        } catch (err) {
          if (err instanceof ObjectTooLargeError) return [e.name, null]
          throw err
        }
      })
      // Published even if the home was left meanwhile: facts are keyed by tip, and the placeholder
      // another route shows for this tip ends with them.
      publish(key, { license: detectLicense(texts) })
      signal?.throwIfAborted()
    }
    if (known.languages === undefined) {
      const walk = await repoFilesWalk(repoKey, tipOid, reader, rootTree)
      publish(key, { languages: languageStats(walk) })
    }
  } finally {
    setLoading(key, -1)
  }
}

/** Loads registered per `(repo, tip)`: the card's placeholder shows only while one is. */
const loading = new Map<string, number>()

function setLoading(key: string, delta: 1 | -1): void {
  const n = (loading.get(key) ?? 0) + delta
  if (n > 0) loading.set(key, n)
  else loading.delete(key)
  for (const l of listeners) l()
}

/** Whether a load of this tip's facts is registered (waiting for the card, or reading). */
export function repoFactsLoading(repoKey: string, tipOid: string | null): boolean {
  return tipOid !== null && loading.has(keyOf(repoKey, tipOid))
}

/**
 * Per repo, whether a viewer has its facts in view, and the loads waiting for that. The facts cost
 * a tree read per directory (the language bar's walk: 47 requests on dashpay/dash) and the license
 * files, and the About card is below the fold, so the home works them out only once wanted (S-1).
 * Kept for the {@link KEEP_WANTED} most recent repos; a load that is left removes its waiter.
 */
const wanted = new Map<string, { open: boolean; readonly waiters: Set<() => void> }>()
const KEEP_WANTED = 50

function wantedOf(repoKey: string): { open: boolean; readonly waiters: Set<() => void> } {
  let w = wanted.get(repoKey)
  if (w === undefined) {
    w = { open: false, waiters: new Set() }
    wanted.set(repoKey, w)
    // Trim the oldest entries nobody waits on.
    for (const [k, v] of wanted) {
      if (wanted.size <= KEEP_WANTED) break
      if (k !== repoKey && v.waiters.size === 0) wanted.delete(k)
    }
  }
  return w
}

/** The About card's facts came into view: the home may work them out. */
export function wantRepoFacts(repoKey: string): void {
  const w = wantedOf(repoKey)
  w.open = true
  for (const wake of w.waiters) wake()
  w.waiters.clear()
}

/** Resolves once {@link wantRepoFacts} was called for the repo; rejects when `signal` aborts. */
function whenFactsWanted(repoKey: string, signal?: AbortSignal): Promise<void> {
  const w = wantedOf(repoKey)
  if (w.open) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const stop = (): void => {
      w.waiters.delete(wake)
      reject(signal?.reason)
    }
    const wake = (): void => {
      signal?.removeEventListener('abort', stop)
      resolve()
    }
    if (signal?.aborted) return stop()
    w.waiters.add(wake)
    signal?.addEventListener('abort', stop, { once: true })
  })
}

/** The About card's proved totals; null: that read failed (the row says so, the other still shows). */
export interface AboutTotals {
  /** Tags with a live release ({@link readReleaseCount}). */
  readonly releases: number | null
  /** Stored git pack bytes ({@link readGitPackBytes}). */
  readonly gitPacks: GitPackBytes | null
}

/** How long a total is kept for the session (as the releases list is). */
const TOTALS_TTL_MS = 60_000
/** The size's cache prefix: keyed repo first, so a write drops it on every network's key. */
const GIT_PACK_BYTES = 'gitPackBytes:'

/**
 * The About card's release count and repo size: two proved sums, sent together once the card is
 * in view (S-1), whatever the repo's size. Unlike the facts above they are Platform reads of the
 * repo, not of a tip, so the rail reads them itself. Neither fits the chrome's composite, which
 * already carries the protocol's 10 sub-queries and takes documents and counts only.
 *
 * Each is kept for the session on its own ({@link sessionCached}) and its failure caught after the
 * cache, which drops a rejected read: a failed total reads again next time, never kept as null.
 * The count is keyed under the releases list's prefix, so a publish or an unpublish (which drop
 * that prefix) drops it too; the size goes when this tab writes the repo's content (a push).
 *
 * A private repo's count is never the proved sum: a sealed release carries `delta` 0
 * (`private-repos.md` §16.3), so the sum says 0 whatever it holds. A member's is counted from the
 * decrypted list instead (the releases list's own cache entry), and a reader without keys gets none.
 */
export async function readAboutTotals(sdk: EvoSDK, repo: RepoRef, network: Network): Promise<AboutTotals> {
  const [releases, gitPacks] = await Promise.all([
    readReleaseTotal(sdk, repo, network),
    sessionCached(`${GIT_PACK_BYTES}${repoKey(repo)}:${network}`, TOTALS_TTL_MS, () => readGitPackBytes(sdk, repo)).catch(() => null),
  ])
  return { releases, gitPacks }
}

/** {@link readAboutTotals}'s release count: `null` when it cannot be read. */
async function readReleaseTotal(sdk: EvoSDK, repo: RepoRef, network: Network): Promise<number | null> {
  const listKey = `releases:${network}:${repoKey(repo)}`
  if (repo.visibility !== 'private') {
    return sessionCached(`${listKey}:count`, TOTALS_TTL_MS, () => readReleaseCount(sdk, repo)).catch(() => null)
  }
  if (repo.session === undefined) return null
  return sessionCached(listKey, TOTALS_TTL_MS, () => readReleases(sdk, repo)).then(releaseCountOf, () => null)
}

// This tab stored a pack or moved a ref in the repo: its size is read again.
onRepoContentWritten((repo) => invalidateSessionCache(`${GIT_PACK_BYTES}${repo.repoId}`))

/**
 * The About card's repo size, GitHub-style: the git packs (kind 0) on Platform and external, which
 * is what GitHub's size measures too (the objects, not a checkout). The proved sum counts every
 * manifest, so a pack a later push superseded, or a second member's copy, counts again; the tooltip
 * says "stored" and why. Null for a repo with no packs (GitHub shows no size for an empty one).
 */
export function repoSizeOf(packs: GitPackBytes): { readonly text: string; readonly tooltip: string } | null {
  const total = packs.platform + packs.external
  if (total === 0) return null
  const where: string[] = []
  if (packs.platform > 0) where.push(`${formatBytes(packs.platform)} on Platform`)
  if (packs.external > 0) where.push(`${formatBytes(packs.external)} external`)
  return {
    text: formatBytes(total),
    tooltip: `Git packs stored for this repo: ${where.join(', ')}. Every pack pushed counts, including ones a later push superseded.`,
  }
}

/** Test hook. */
export function resetRepoFacts(): void {
  facts.clear()
  walks.clear()
  wanted.clear()
  loading.clear()
  for (const l of listeners) l()
}
