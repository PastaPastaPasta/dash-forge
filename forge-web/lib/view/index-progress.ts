/**
 * How much of a repo's browse index is read so far, while it is read whole (QW3-001): a private
 * repo's, a fork's parent's, or one whose row counts do not add up, are still downloaded before
 * the first row shows. The browse boundary shows the bytes instead of a bare spinner.
 *
 * Keyed by `repoKey`, then by artifact (`packHash`); an artifact leaves once it is read (or its
 * read is given up), so what is listed is only what is still coming.
 */

export interface IndexProgress {
  readonly fetched: number
  readonly total: number
}

const reads = new Map<string, Map<string, IndexProgress>>()
const listeners = new Set<() => void>()
/** The summed progress per repo, rebuilt on change: a stable reference for `useSyncExternalStore`. */
const sums = new Map<string, IndexProgress>()

function changed(key: string): void {
  const of = reads.get(key)
  if (of === undefined || of.size === 0) {
    reads.delete(key)
    sums.delete(key)
  } else {
    let fetched = 0
    let total = 0
    for (const p of of.values()) {
      fetched += p.fetched
      total += p.total
    }
    sums.set(key, { fetched, total })
  }
  for (const l of listeners) l()
}

/** `fetched` of `total` bytes of artifact `packHash` of repo `key` are in. */
export function noteIndexProgress(key: string, packHash: string, fetched: number, total: number): void {
  let of = reads.get(key)
  if (of === undefined) {
    of = new Map()
    reads.set(key, of)
  }
  if (fetched >= total) of.delete(packHash)
  else of.set(packHash, { fetched, total })
  changed(key)
}

/** The read of artifact `packHash` of repo `key` ended (done or failed). */
export function endIndexProgress(key: string, packHash: string): void {
  if (reads.get(key)?.delete(packHash) === true) changed(key)
}

/** What is still being read of repo `key`'s index, summed; undefined when nothing is. */
export function indexProgress(key: string): IndexProgress | undefined {
  return sums.get(key)
}

export function subscribeIndexProgress(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
