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
import { mapPooled } from './pool'
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

function trim<V>(map: Map<string, V>, keep: number): void {
  while (map.size > keep) map.delete(map.keys().next().value as string)
}

function publish(key: string, next: Partial<RepoFacts>): void {
  facts.set(key, { ...(facts.get(key) ?? UNKNOWN), ...next })
  trim(facts, KEEP_FACTS)
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
    trim(walks, KEEP_WALKS)
  }
  return walk
}

/**
 * Work out and publish the facts for this tip: the license from the root's license files (a few
 * KiB each, through the page's reader), then the language bar from the shared file walk. Facts
 * already known are not read again; a fact whose read failed stays unknown, so the next visit
 * tries again.
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
  // Both facts sit below the fold: read nothing until a viewer has the About card's facts in view
  // (S-1). The walk may already be running for Go to file; the license read is a few KiB.
  if (known.license === undefined || known.languages === undefined) await whenFactsWanted(repoKey, signal)
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
    signal?.throwIfAborted()
    publish(key, { license: detectLicense(texts) })
  }
  if (known.languages === undefined) {
    const walk = await repoFilesWalk(repoKey, tipOid, reader, rootTree)
    signal?.throwIfAborted()
    publish(key, { languages: languageStats(walk) })
  }
}

/**
 * Per repo, a latch that opens when a viewer has its facts in view. The facts cost a tree read per
 * directory (the language bar's walk: 47 requests on dashpay/dash) and the license files, and the
 * About card is below the fold, so the home works them out only once they are wanted (S-1).
 */
const factsWanted = new Map<string, { readonly opened: Promise<void>; readonly open: () => void }>()

function latchOf(repoKey: string): { readonly opened: Promise<void>; readonly open: () => void } {
  let latch = factsWanted.get(repoKey)
  if (latch === undefined) {
    let open!: () => void
    const opened = new Promise<void>((resolve) => (open = resolve))
    latch = { opened, open }
    factsWanted.set(repoKey, latch)
  }
  return latch
}

/** The About card's facts came into view: the home may work them out. */
export function wantRepoFacts(repoKey: string): void {
  latchOf(repoKey).open()
}

/** Resolves once {@link wantRepoFacts} was called for the repo; rejects when `signal` aborts. */
function whenFactsWanted(repoKey: string, signal?: AbortSignal): Promise<void> {
  const { opened } = latchOf(repoKey)
  if (signal === undefined) return opened
  return new Promise((resolve, reject) => {
    const stop = (): void => reject(signal.reason)
    if (signal.aborted) return stop()
    signal.addEventListener('abort', stop, { once: true })
    void opened.then(() => {
      signal.removeEventListener('abort', stop)
      resolve()
    })
  })
}

/** Test hook. */
export function resetRepoFacts(): void {
  facts.clear()
  walks.clear()
  factsWanted.clear()
  for (const l of listeners) l()
}
