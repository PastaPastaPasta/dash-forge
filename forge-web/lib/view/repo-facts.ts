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
 */

import { MODE_GITLINK, MODE_TREE, ObjectTooLargeError } from '../browse'
import { onPrivateSessionEnded } from '../repo/private-session'
import { historyWalker } from './commit-log'
import { readBlob, type ObjectReader } from './tree-nav'
import { decodeTextBlob, type TreeEntry } from './git-objects'
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

/** Test hook. */
export function resetRepoFacts(): void {
  facts.clear()
  walks.clear()
  wanted.clear()
  loading.clear()
  for (const l of listeners) l()
}
