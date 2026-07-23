'use client'

/**
 * useAsync — a tiny data-fetch state machine for the read pages.
 *
 * Runs an async producer whenever its `deps` change and exposes `{ data, loading, error,
 * reload }`. `enabled: false` holds the call (e.g. until the SDK is ready). Stale results
 * from a superseded run are discarded so fast navigation never flashes the wrong repo.
 *
 * The producer is held in a ref (callers pass an inline closure whose identity changes every
 * render); the effect re-runs only on the caller's declared `deps`, the reload nonce, and the
 * enabled flag — so the dependency list stays honest without any lint escape hatch.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

export interface AsyncState<T> {
  readonly data: T | null
  readonly loading: boolean
  readonly error: string | null
  reload: () => void
}

export function useAsync<T>(
  producer: () => Promise<T>,
  deps: readonly unknown[],
  options: { enabled?: boolean } = {},
): AsyncState<T> {
  const enabled = options.enabled !== false
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState<boolean>(enabled)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)

  const producerRef = useRef(producer)
  producerRef.current = producer

  const reload = useCallback(() => setNonce((n) => n + 1), [])

  // Serialize the caller's deps into a stable key so the effect depends on their values,
  // not on the array's identity — keeping the dependency array a constant shape.
  const depKey = JSON.stringify(deps.map((d) => (typeof d === 'object' ? String(d) : d)))

  useEffect(() => {
    if (!enabled) {
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    producerRef
      .current()
      .then((result) => {
        if (cancelled) return
        setData(result)
        setLoading(false)
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setError(e instanceof Error ? e.message : String(e))
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [enabled, nonce, depKey])

  return { data, loading, error, reload }
}
