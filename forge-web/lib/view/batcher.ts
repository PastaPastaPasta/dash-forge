/**
 * Coalesce values that land one by one into batched commits — how the diff view turns
 * per-file patch loads into a few React state updates instead of one re-render per file.
 *
 * The batcher owns its pending map and never hands it out, so a caller cannot hold a stale
 * one. That is the D-005 bug this replaces: `pending.current.set(key, await load())` reads
 * `pending.current` BEFORE the await, so a load that finished after a flush had swapped in a
 * fresh map wrote into the old, already-committed one and was lost for good — the file sat
 * on "Reading file…" forever with nothing in flight.
 */

export interface Batcher<K, V> {
  /** Queue `value` under `key`; it is committed within `delayMs`. */
  add(key: K, value: V): void
  /** Commit whatever is queued now (also on unmount). */
  flush(): void
}

export function createBatcher<K, V>(delayMs: number, commit: (batch: ReadonlyMap<K, V>) => void): Batcher<K, V> {
  let pending = new Map<K, V>()
  let timer: ReturnType<typeof setTimeout> | null = null
  const flush = (): void => {
    if (timer !== null) clearTimeout(timer)
    timer = null
    if (pending.size === 0) return
    const batch = pending
    pending = new Map()
    commit(batch)
  }
  return {
    add(key, value) {
      pending.set(key, value)
      timer ??= setTimeout(flush, delayMs)
    },
    flush,
  }
}
