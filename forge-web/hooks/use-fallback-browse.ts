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
  fallbackNeedsAsk,
  FallbackTooLargeError,
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
  /** The thrown value behind `error` (e.g. a StorageUnreachableError listing the places tried). */
  readonly cause: unknown
  /**
   * A clone of this pack set that started without asking stopped at its smaller budget (on this
   * page or an earlier one): it waits for `start()` (the user asking), even for a repo small
   * enough to start without asking.
   */
  readonly needsAsk: boolean
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
  const [cause, setCause] = useState<unknown>(null)
  const [needsAsk, setNeedsAsk] = useState(false)
  const mounted = useRef(true)
  // The repo key the state is for: a run started for an earlier one (the repo before its
  // published keys or a session arrived) settles nothing, whichever finishes last.
  const key = repo === null ? '' : repoKey(repo)
  const current = useRef(key)
  current.current = key
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const settle = useCallback((run: Promise<BrowseContext>, runKey: string) => {
    setStatus('working')
    setError(null)
    setNeedsAsk(false)
    const live = (): boolean => mounted.current && current.current === runKey
    run
      .then((ctx) => {
        if (!live()) return
        setContext(ctx)
        setStatus('ready')
      })
      .catch((e: unknown) => {
        if (!live()) return
        // Decided by the run itself: this page may have joined one another page started.
        if (e instanceof FallbackTooLargeError && e.automatic) {
          setProgress(null)
          setNeedsAsk(true)
          setStatus('idle')
          return
        }
        setError(errorMessage(e))
        setCause(e)
        setStatus('error')
      })
  }, [])

  const run = useCallback((automatic: boolean) => {
    if (sdk === null || repo === null || livePacks === null || livePacks.length === 0) return
    const runKey = repoKey(repo)
    settle(
      startFallback(sdk, repo, livePacks, (p) => {
        if (mounted.current && current.current === runKey) setProgress(p)
      }, automatic),
      runKey,
    )
  }, [sdk, repo, livePacks, settle])
  const start = useCallback(() => run(false), [run])

  // Resume a memory/IndexedDB-cached run silently; auto-start small repos once the SDK is up.
  const totalSizeBytes = (livePacks ?? []).reduce((s, m) => s + m.sizeBytes, 0)
  const startRef = useRef(run)
  startRef.current = run
  useEffect(() => {
    if (repo === null) return
    if (livePacks === null || livePacks.length === 0) return
    const cached = cachedFallback(key, livePacks)
    if (cached !== null) {
      settle(cached, key)
      return
    }

    let cancelled = false
    setStatus('working')
    setError(null)
    setNeedsAsk(false)
    restoreFallback(repo, livePacks, sdk)
      .then((ctx) => {
        if (cancelled || !mounted.current) return
        if (ctx !== null) {
          setContext(ctx)
          setStatus('ready')
        } else if (fallbackNeedsAsk(key, livePacks)) {
          // One that started without asking already stopped at its budget: ask, not decode again.
          setProgress(null)
          setNeedsAsk(true)
          setStatus('idle')
        } else if (sdk !== null && totalSizeBytes <= AUTO_LOAD_MAX_BYTES) {
          startRef.current(true)
        } else {
          setProgress(null)
          setStatus('idle')
        }
      })
      .catch((e: unknown) => {
        if (cancelled || !mounted.current) return
        setError(errorMessage(e))
        setCause(e)
        setStatus('error')
      })
    return () => {
      cancelled = true
    }
    // livePacks identity tracks its load; the repo key scopes the cache probe.
  }, [key, sdk, livePacks, totalSizeBytes, settle]) // eslint-disable-line react-hooks/exhaustive-deps

  return { status, progress, context, error, cause, needsAsk, start }
}
