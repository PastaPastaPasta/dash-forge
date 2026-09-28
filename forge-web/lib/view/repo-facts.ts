/**
 * Repo facts (F-5): the LICENSE and the language bar the About card shows, worked out once per
 * commit from what the repo home reads, and kept for the session.
 *
 * The home owns the browse reader; the rail's About card does not. So the home computes the facts
 * (after its own list, README and commit column have settled) and publishes them here, keyed by
 * repo and tip, and the card subscribes. One file walk per tip ({@link repoFilesWalk}): the
 * language bar and Go to file share it, and a second visit reuses it.
 */

import { historyWalker } from './commit-log'
import { readBlob, type ObjectReader } from './tree-nav'
import { decodeTextBlob, type TreeEntry } from './git-objects'
import { detectLicense, isLicenseFile, LICENSE_MAX_BYTES, type RepoLicense } from './license'
import { languageStats, walkRepoFiles, type LanguageStats, type RepoFiles } from './languages'

export interface RepoFacts {
  /** null: no license file (or unreadable); undefined: not known yet. */
  readonly license: RepoLicense | null | undefined
  readonly languages: LanguageStats | null | undefined
}

const UNKNOWN: RepoFacts = { license: undefined, languages: undefined }
const facts = new Map<string, RepoFacts>()
const listeners = new Set<() => void>()
const walks = new Map<string, Promise<RepoFiles>>()
/** Tips kept (a long session visiting many repos keeps only the recent ones). */
const KEEP = 50

const keyOf = (repoKey: string, tipOid: string): string => `${repoKey}\0${tipOid}`

function trim<V>(map: Map<string, V>): void {
  if (map.size > KEEP) map.delete(map.keys().next().value as string)
}

function publish(key: string, next: Partial<RepoFacts>): void {
  facts.set(key, { ...(facts.get(key) ?? UNKNOWN), ...next })
  trim(facts)
  for (const l of listeners) l()
}

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
 * The walk of the repo's files at this tip, started once per tip and shared, through a read-ahead
 * walker (a pack keeps its trees together). Not cancellable: the next caller wants the same walk.
 */
export function repoFilesWalk(repoKey: string, tipOid: string, reader: ObjectReader, rootTree: string): Promise<RepoFiles> {
  const key = keyOf(repoKey, tipOid)
  let walk = walks.get(key)
  if (walk === undefined) {
    const walker = historyWalker(reader)
    walk = walkRepoFiles(walker, rootTree).finally(() => walker.flush?.())
    walks.set(key, walk)
    walk.catch(() => walks.delete(key))
    trim(walks)
  }
  return walk
}

/**
 * Work out and publish the facts for this tip: the license from the root's license files (a few
 * KiB each, through the page's reader), then the language bar from the shared file walk. Facts
 * already known are not read again. A failure publishes null for that fact.
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
    const files = rootEntries.filter((e) => isLicenseFile(e.name))
    const texts = await Promise.all(
      files.map(async (e): Promise<readonly [string, string | null]> => {
        try {
          return [e.name, decodeTextBlob(await readBlob(reader, e.oid, LICENSE_MAX_BYTES))]
        } catch {
          return [e.name, null] // a directory named LICENSE, too large, unreadable: not placed
        }
      }),
    )
    signal?.throwIfAborted()
    publish(key, { license: detectLicense(texts) })
  }
  if (known.languages === undefined) {
    let languages: LanguageStats | null
    try {
      languages = languageStats(await repoFilesWalk(repoKey, tipOid, reader, rootTree))
    } catch {
      languages = null
    }
    signal?.throwIfAborted()
    publish(key, { languages })
  }
}

/** Test hook. */
export function resetRepoFacts(): void {
  facts.clear()
  walks.clear()
  for (const l of listeners) l()
}
