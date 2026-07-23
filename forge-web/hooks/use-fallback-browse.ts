'use client'

/**
 * useFallbackBrowse — drive the in-browser fallback clone for a repo with no published
 * objectLocator. Small repos (≤ {@link AUTO_LOAD_MAX_BYTES}) start automatically; larger
 * ones wait for `start()` (the "Load repo in browser (~X MB)" button). A session already
 * holding the repo's fallback context (module cache in `lib/view/browse-fallback`) resumes
 * silently on mount, so navigation between repo pages never re-downloads or re-asks.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import { useSdk } from '@/hooks/use-sdk'
import type { PackManifest, RepoRef } from '@/lib/repo'
import { errorMessage } from '@/lib/utils'
import {
  cachedFallback,
  startFallback,
  type BrowseContext,
  type FallbackProgress,
} from '@/lib/view'

/** Total live pack size at/below which the fallback starts without asking (~2 MB). */
export const AUTO_LOAD_MAX_BYTES = 2 * 1024 * 1024

export interface FallbackBrowse {
  readonly status: 'idle' | 'working' | 'ready' | 'error'
  readonly progress: FallbackProgress | null
  readonly context: BrowseContext | null
  readonly error: string | null
  readonly start: () => void
}

export function useFallbackBrowse(
  repo: RepoRef | null,
  livePacks: readonly PackManifest[] | null,
): FallbackBrowse {
  const { sdk } = useSdk(repo ? [repo.contractId] : [])
  const [status, setStatus] = useState<FallbackBrowse['status']>('idle')
  const [progress, setProgress] = useState<FallbackProgress | null>(null)
  const [context, setContext] = useState<BrowseContext | null>(null)
  const [error, setError] = useState<string | null>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const settle = useCallback((run: Promise<BrowseContext>) => {
    setStatus('working')
    setError(null)
    run
      .then((ctx) => {
        if (!mounted.current) return
        setContext(ctx)
        setStatus('ready')
      })
      .catch((e: unknown) => {
        if (!mounted.current) return
        setError(errorMessage(e))
        setStatus('error')
      })
  }, [])

  const start = useCallback(() => {
    if (sdk === null || repo === null || livePacks === null || livePacks.length === 0) return
    settle(startFallback(sdk, repo, livePacks, (p) => {
      if (mounted.current) setProgress(p)
    }))
  }, [sdk, repo, livePacks, settle])

  // Resume a cached run silently; auto-start small repos once the SDK is up.
  const totalSizeBytes = (livePacks ?? []).reduce((s, m) => s + m.sizeBytes, 0)
  const startRef = useRef(start)
  startRef.current = start
  useEffect(() => {
    if (repo === null) return
    const cached = cachedFallback(repo.contractId)
    if (cached !== null) {
      settle(cached)
      return
    }
    if (sdk !== null && livePacks !== null && livePacks.length > 0 && totalSizeBytes <= AUTO_LOAD_MAX_BYTES) {
      startRef.current()
    }
    // livePacks identity tracks its load; contractId scopes the cache probe.
  }, [repo?.contractId ?? '', sdk, livePacks, totalSizeBytes, settle]) // eslint-disable-line react-hooks/exhaustive-deps

  return { status, progress, context, error, start }
}
