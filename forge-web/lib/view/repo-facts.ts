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

import { MODE_GITLINK, MODE_TREE } from '../browse'
import { onPrivateSessionEnded } from '../repo/private-session'
import { historyWalker } from './commit-log'
import { readBlob, type ObjectReader } from './tree-nav'
import { decodeTextBlob, type TreeEntry } from './git-objects'
import { detectLicense, isLicenseFile, LICENSE_MAX_BYTES, type RepoLicense } from './license'
import { languageStats, type LanguageStats } from './languages'
import { FILE_WALK_FILES, walkFiles, type FileWalk } from './zip'

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
 * The walk of the repo's files at this tip (up to {@link FILE_WALK_FILES} files, however many
 * directories hold them, so Go to file reaches as far as it always did), started once per tip and
 * shared with the language bar, through a read-ahead walker (a pack keeps its trees together). Not
 * cancellable: the next caller wants the same walk.
 */
export function repoFilesWalk(repoKey: string, tipOid: string, reader: ObjectReader, rootTree: string): Promise<FileWalk> {
  const key = keyOf(repoKey, tipOid)
  let walk = walks.get(key)
  if (walk === undefined) {
    const walker = historyWalker(reader)
    const started = walkFiles(walker, rootTree, { maxFiles: FILE_WALK_FILES }).finally(() => walker.flush?.())
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
  if (known.license === undefined) {
    // Files only: a directory named `license/` is not a license.
    const files = rootEntries.filter((e) => isLicenseFile(e.name) && e.mode !== MODE_TREE && e.mode !== MODE_GITLINK)
    const texts = await Promise.all(
      files.map(async (e): Promise<readonly [string, string | null]> => {
        try {
          return [e.name, decodeTextBlob(await readBlob(reader, e.oid, LICENSE_MAX_BYTES))]
        } catch {
          return [e.name, null] // too large or not text: not placed
        }
      }),
    )
    signal?.throwIfAborted()
    publish(key, { license: detectLicense(texts) })
  }
  if (known.languages === undefined) {
    const walk = await repoFilesWalk(repoKey, tipOid, reader, rootTree)
    signal?.throwIfAborted()
    publish(key, { languages: languageStats(walk) })
  }
}

/** Test hook. */
export function resetRepoFacts(): void {
  facts.clear()
  walks.clear()
  for (const l of listeners) l()
}
