'use client'

/**
 * useRepoPages — a keyset-paged repo list (`lib/view/discovery.ts`): the first page on mount
 * (or whenever `key` changes), and "Load more" appends the next page from where the last one
 * ended. A superseded read (the key changed meanwhile) is dropped.
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
  loadMore: () => void
  reload: () => void
}

export function useRepoPages<T extends string | number>(
  read: (after: Keyset<T> | null) => Promise<RepoPage<T>>,
  key: string,
  enabled: boolean,
): RepoPages {
  const [repos, setRepos] = useState<DiscoveredRepo[]>([])
  const [next, setNext] = useState<Keyset<T> | null>(null)
  const [settled, setSettled] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pushesComplete, setPushesComplete] = useState(true)
  const [nonce, setNonce] = useState(0)
  const readRef = useRef(read)
  readRef.current = read
  const generation = useRef(0)

  const fetchPage = useCallback((after: Keyset<T> | null, append: boolean): void => {
    const mine = ++generation.current
    setLoading(true)
    setError(null)
    readRef.current(after).then(
      (page) => {
        if (generation.current !== mine) return
        setRepos((prev) => {
          if (!append) return page.repos
          const have = new Set(prev.map((r) => r.key))
          return [...prev, ...page.repos.filter((r) => !have.has(r.key))]
        })
        setNext(page.next)
        setPushesComplete((prev) => (append ? prev && page.pushesComplete : page.pushesComplete))
        setSettled(true)
        setLoading(false)
      },
      (e: unknown) => {
        if (generation.current !== mine) return
        setError(errorMessage(e))
        setLoading(false)
      },
    )
  }, [])

  useEffect(() => {
    setRepos([])
    setNext(null)
    setSettled(false)
    if (!enabled) {
      generation.current++
      setLoading(false)
      return
    }
    fetchPage(null, false)
  }, [key, enabled, nonce, fetchPage])

  return {
    repos,
    settled,
    loading,
    error,
    hasMore: next !== null,
    pushesComplete,
    loadMore: () => {
      if (next !== null && !loading) fetchPage(next, true)
    },
    reload: () => setNonce((n) => n + 1),
  }
}
