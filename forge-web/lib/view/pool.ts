/** Bounded-concurrency helper for view reads that fan out over many objects, and a bounded-memo trim. */

/** Drop a memo's oldest entries (insertion order) until it holds at most `keep`. */
export function trimOldest<K, V>(map: Map<K, V>, keep: number): void {
  while (map.size > keep) map.delete(map.keys().next().value as K)
}

/**
 * Map `items` through `fn` with at most `limit` calls in flight, preserving input order in the
 * result. Browse reads are ranged network fetches; firing hundreds at once would stall every
 * one of them behind the browser's per-host connection limit. Once any call rejects, no further
 * item is started, and the pool rejects with the first rejection once the calls already in
 * flight have settled: a failed window of a whole-artifact load must not be followed by the rest
 * of the artifact, nor overlap whatever the caller tries next.
 */
export async function mapPooled<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  let failure: { readonly error: unknown } | null = null
  const worker = async (): Promise<void> => {
    while (failure === null && next < items.length) {
      const i = next++
      try {
        out[i] = await fn(items[i] as T, i)
      } catch (error) {
        failure ??= { error }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  if (failure !== null) throw (failure as { readonly error: unknown }).error
  return out
}
