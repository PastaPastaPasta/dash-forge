/** Bounded-concurrency helper for view reads that fan out over many objects. */

/**
 * Map `items` through `fn` with at most `limit` calls in flight, preserving input order in the
 * result. Browse reads are ranged network fetches; firing hundreds at once would stall every
 * one of them behind the browser's per-host connection limit. Once any call rejects, no further
 * item is started (the result is that rejection): a failed window of a whole-artifact load must
 * not be followed by the rest of the artifact.
 */
export async function mapPooled<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  let failed = false
  const worker = async (): Promise<void> => {
    while (!failed && next < items.length) {
      const i = next++
      try {
        out[i] = await fn(items[i] as T, i)
      } catch (e) {
        failed = true
        throw e
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}
