'use client'

/**
 * useRepoPages — a keyset-paged repo list (`lib/view/discovery.ts`): the first page on mount
 * (or whenever `key` changes), and "Load more" appends the next page from where the last one
 * ended. A superseded read (the key changed meanwhile) is dropped, and a new key never paints
 * the previous key's rows.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import type { DiscoveredRepo, Keyset, RepoPage } from '@/lib/view/discovery'
import { errorMessage } from '@/lib/utils'

export interface RepoPages {
  readonly repos: DiscoveredRepo[]
  /** False until the first page settles. */
  readonly settled: boolean
  readonly loading: boolean
  readonly error: string | null
  readonly hasMore: boolean
  /** Whether every loaded repo's push window was read completely. */
  readonly pushesComplete: boolean
  /** Some page came from the plain-query fallback (no counts or pushes). */
  readonly fallback: boolean
  /** Some page stepped past a boundary tie too large to read (rows skipped). */
  readonly skippedTies: boolean
  loadMore: () => void
  reload: () => void
}

interface State<T extends string | number> {
  readonly key: string
  readonly repos: DiscoveredRepo[]
  readonly next: Keyset<T> | null
  readonly settled: boolean
  readonly error: string | null
  readonly pushesComplete: boolean
  readonly fallback: boolean
  readonly skippedTies: boolean
}

const initial = <T extends string | number>(key: string): State<T> => ({
  key,
  repos: [],
  next: null,
  settled: false,
  error: null,
  pushesComplete: true,
  fallback: false,
  skippedTies: false,
})

export function useRepoPages<T extends string | number>(
  read: (after: Keyset<T> | null) => Promise<RepoPage<T>>,
  key: string,
  enabled: boolean,
): RepoPages {
  const fullKey = `${key}|${enabled ? 1 : 0}`
  const [state, setState] = useState<State<T>>(() => initial<T>(fullKey))
  const [loading, setLoading] = useState(false)
  const [nonce, setNonce] = useState(0)
  const readRef = useRef(read)
  readRef.current = read
  const generation = useRef(0)

  // A new key (or enabled flag) resets during render: its first paint is empty, never stale.
  const current = state.key === fullKey ? state : initial<T>(fullKey)
  if (state.key !== fullKey) setState(current)

  const fetchPage = useCallback(
    (after: Keyset<T> | null, append: boolean): void => {
      const mine = ++generation.current
      setLoading(true)
      setState((s) => ({ ...s, error: null }))
      readRef.current(after).then(
        (page) => {
          if (generation.current !== mine) return
          setState((s) => {
            const have = new Set(s.repos.map((r) => r.key))
            return {
              ...s,
              repos: append ? [...s.repos, ...page.repos.filter((r) => !have.has(r.key))] : page.repos,
              next: page.next,
              settled: true,
              pushesComplete: (append ? s.pushesComplete : true) && page.pushesComplete,
              fallback: (append && s.fallback) || page.fallback,
              skippedTies: (append && s.skippedTies) || page.skippedTies,
            }
          })
          setLoading(false)
        },
        (e: unknown) => {
          if (generation.current !== mine) return
          setState((s) => ({ ...s, error: errorMessage(e) }))
          setLoading(false)
        },
      )
    },
    [],
  )

  useEffect(() => {
    generation.current++
    setLoading(false)
    if (enabled) fetchPage(null, false)
  }, [fullKey, enabled, nonce, fetchPage])
  useEffect(() => () => void generation.current++, [])

  return {
    repos: current.repos,
    settled: current.settled,
    loading,
    error: current.error,
    hasMore: current.next !== null,
    pushesComplete: current.pushesComplete,
    fallback: current.fallback,
    skippedTies: current.skippedTies,
    loadMore: () => {
      if (current.next !== null && !loading) fetchPage(current.next, true)
    },
    reload: () => setNonce((n) => n + 1),
  }
}
