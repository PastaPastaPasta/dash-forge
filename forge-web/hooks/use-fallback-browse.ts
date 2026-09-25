'use client'

/**
 * useFallbackBrowse — drive the in-browser fallback clone for a repo with no published
 * objectLocator. Small repos (≤ {@link AUTO_LOAD_MAX_BYTES}) start automatically; larger
 * ones wait for `start()` (the "Load repo in browser (~X MB)" button). A session or browser
 * profile already holding the repo's exact fallback context resumes silently on mount, so
 * navigation and hard reloads never re-download or re-ask.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import { useSdk } from '@/hooks/use-sdk'
import { repoContractIds, repoKey, type PackManifest, type RepoRef } from '@/lib/repo'
import { errorMessage } from '@/lib/utils'
import {
  cachedFallback,
  restoreFallback,
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
  const { sdk } = useSdk(repoContractIds(repo))
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

  // Resume a memory/IndexedDB-cached run silently; auto-start small repos once the SDK is up.
  const totalSizeBytes = (livePacks ?? []).reduce((s, m) => s + m.sizeBytes, 0)
  const startRef = useRef(start)
  startRef.current = start
  useEffect(() => {
    if (repo === null) return
    if (livePacks === null || livePacks.length === 0) return
    const cached = cachedFallback(repoKey(repo), livePacks)
    if (cached !== null) {
      settle(cached)
      return
    }

    let cancelled = false
    setStatus('working')
    setError(null)
    restoreFallback(repo, livePacks)
      .then((ctx) => {
        if (cancelled || !mounted.current) return
        if (ctx !== null) {
          setContext(ctx)
          setStatus('ready')
        } else if (sdk !== null && totalSizeBytes <= AUTO_LOAD_MAX_BYTES) {
          startRef.current()
        } else {
          setProgress(null)
          setStatus('idle')
        }
      })
      .catch((e: unknown) => {
        if (cancelled || !mounted.current) return
        setError(errorMessage(e))
        setStatus('error')
      })
    return () => {
      cancelled = true
    }
    // livePacks identity tracks its load; the repo key scopes the cache probe.
  }, [repo === null ? '' : repoKey(repo), sdk, livePacks, totalSizeBytes, settle]) // eslint-disable-line react-hooks/exhaustive-deps

  return { status, progress, context, error, start }
}
