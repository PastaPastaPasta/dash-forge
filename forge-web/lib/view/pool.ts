/** Bounded-concurrency helper for view reads that fan out over many objects. */

/**
 * Map `items` through `fn` with at most `limit` calls in flight, preserving input order in the
 * result. Browse reads are ranged network fetches; firing hundreds at once would stall every
 * one of them behind the browser's per-host connection limit.
 */
export async function mapPooled<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i] as T, i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}
