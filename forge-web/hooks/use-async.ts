'use client'

/**
 * useAsync — a tiny data-fetch state machine for the read pages.
 *
 * Runs an async producer whenever its `deps` change and exposes `{ data, loading, error,
 * settled, reload }`. `enabled: false` holds the call (e.g. until the SDK is ready). Stale
 * results from a superseded run are discarded so fast navigation never flashes the wrong repo.
 *
 * `initial` seeds data synchronously (e.g. from a session cache) so a warm navigation
 * renders content on the very first paint — the producer still runs and refreshes it.
 * Returning `undefined` means "no seed"; any other value (including `null`, when `T`
 * admits it — e.g. a cached not-found) is a real settled value. `settled` is true once
 * `data`/`error` reflect a seeded or fetched result for the CURRENT deps — the flag
 * loading shells should gate on (`loading && !settled`), since `data === null` cannot
 * distinguish "still loading" from a settled null.
 *
 * When `deps` change, `data`/`error`/`settled` reset synchronously during render (to the
 * new key's `initial`, else empty), so a page can keep rendering `data` while `loading`
 * without ever showing the previous key's data under the new key.
 *
 * The producer is held in a ref (callers pass an inline closure whose identity changes every
 * render); the effect re-runs only on the caller's declared `deps`, the reload nonce, and the
 * enabled flag — so the dependency list stays honest without any lint escape hatch.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import { errorMessage } from '@/lib/utils'

export interface AsyncState<T> {
  readonly data: T | null
  readonly loading: boolean
  readonly error: string | null
  /** True once data/error reflect a settled (seeded or fetched) result for the current deps. */
  readonly settled: boolean
  reload: () => void
}

interface KeyedState<T> {
  readonly key: string
  readonly data: T | null
  readonly error: string | null
  readonly settled: boolean
}

export function useAsync<T>(
  producer: () => Promise<T>,
  deps: readonly unknown[],
  options: { enabled?: boolean; initial?: () => T | undefined } = {},
): AsyncState<T> {
  const enabled = options.enabled !== false

  // Serialize the caller's deps into a stable key so the effect depends on their values,
  // not on the array's identity — keeping the dependency array a constant shape.
  const depKey = JSON.stringify(deps.map((d) => (typeof d === 'object' ? String(d) : d)))

  const initialRef = useRef(options.initial)
  initialRef.current = options.initial
  const seed = (key: string): KeyedState<T> => {
    const v = initialRef.current?.()
    return v === undefined
      ? { key, data: null, error: null, settled: false }
      : { key, data: v, error: null, settled: true }
  }

  // data/error are keyed by depKey so a dep change resets them during render (the
  // render-phase adjustment pattern) — never a paint of the previous key's data.
  const [state, setState] = useState<KeyedState<T>>(() => seed(depKey))
  const [loading, setLoading] = useState<boolean>(enabled)
  const [nonce, setNonce] = useState(0)

  // On a dep change, reseed for the new key and reuse that value for both the reset and this
  // paint — one `initial()` call, and the rendered frame always matches the state we set.
  const current = state.key === depKey ? state : seed(depKey)
  if (state.key !== depKey) {
    setState(current)
    // The new key's fetch is about to start — never paint a settled-empty frame for it.
    if (enabled && !loading) setLoading(true)
  }

  const producerRef = useRef(producer)
  producerRef.current = producer

  const reload = useCallback(() => setNonce((n) => n + 1), [])

  useEffect(() => {
    if (!enabled) {
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    producerRef
      .current()
      .then((result) => {
        if (cancelled) return
        setState({ key: depKey, data: result, error: null, settled: true })
        setLoading(false)
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setState({ key: depKey, data: null, error: errorMessage(e), settled: true })
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [enabled, nonce, depKey])

  return { data: current.data, loading, error: current.error, settled: current.settled, reload }
}
