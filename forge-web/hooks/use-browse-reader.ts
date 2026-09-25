'use client'

/**
 * useBrowseReader — one repo's browse availability folded into a single renderable state:
 * the published index when it covers the stored packs, else the in-browser fallback clone
 * (auto-started for small repos, offered for larger ones).
 *
 * {@link BrowseBoundary} renders these states as a whole-view boundary for one repo. The PR
 * diff needs two repos at once (the base, and the contract the head was pushed to), so it
 * reads the states directly and says which side is unavailable.
 */

import { useBrowse } from '@/hooks/use-browse'
import { AUTO_LOAD_MAX_BYTES, useFallbackBrowse } from '@/hooks/use-fallback-browse'
import type { BrowseReader } from '@/lib/browse'
import type { RepoRef } from '@/lib/repo'
import { formatBytes, type FallbackProgress, type UnavailablePack } from '@/lib/view'

export type BrowseReaderState =
  | { readonly kind: 'loading'; readonly label: string }
  | {
      readonly kind: 'ready'
      readonly reader: BrowseReader
      /** Served from an in-browser clone because the published index is missing or behind. */
      readonly local: boolean
      readonly behind: boolean
      /** Live external packs the in-browser clone could not fetch (empty: nothing skipped). */
      readonly unavailable: readonly UnavailablePack[]
    }
  | { readonly kind: 'error'; readonly title?: string; readonly message: string; readonly retry: () => void }
  | { readonly kind: 'no-packs' }
  /** Too large to clone without asking: `start()` downloads `sizeBytes` of packs. */
  | { readonly kind: 'offer'; readonly behind: boolean; readonly sizeBytes: number; readonly start: () => void }

function progressLabel(p: FallbackProgress | null): string {
  if (p === null) return 'Preparing in-browser clone'
  if (p.phase === 'download') {
    return `Downloading packs — ${formatBytes(p.bytesFetched)} of ${formatBytes(p.bytesTotal)}`
  }
  return `Indexing objects — ${p.objectsIndexed} of ${p.objectsTotal}`
}

/** Resolve `repo`'s reader. `null` holds every read (the state stays `loading`). */
export function useBrowseReader(repo: RepoRef | null): BrowseReaderState {
  const { data, loading, error, settled, reload } = useBrowse(repo)
  const unindexed = data?.kind === 'unindexed' ? data : null
  const fallback = useFallbackBrowse(repo, unindexed?.livePacks ?? null)

  // A warm navigation has `data` seeded from the session browse cache — use it immediately;
  // the loading state is only for a cold (no-cache) resolve.
  if (repo === null || (loading && !settled)) return { kind: 'loading', label: 'Loading browse index' }
  if (error) return { kind: 'error', message: error, retry: reload }
  if (data === null || data.kind === 'no-packs') return { kind: 'no-packs' }
  if (data.kind === 'ready') {
    return { kind: 'ready', reader: data.context.reader, local: false, behind: false, unavailable: [] }
  }

  // No usable published index — the in-browser fallback clone takes over.
  const behind = data.reason === 'index-behind'
  if (fallback.status === 'ready' && fallback.context !== null) {
    return {
      kind: 'ready',
      reader: fallback.context.reader,
      local: true,
      behind,
      unavailable: fallback.context.unavailable ?? [],
    }
  }
  if (fallback.status === 'error') {
    return {
      kind: 'error',
      title: 'In-browser clone failed',
      message: fallback.error ?? 'unknown error',
      retry: fallback.start,
    }
  }
  if (fallback.status === 'working' || data.totalSizeBytes <= AUTO_LOAD_MAX_BYTES) {
    return { kind: 'loading', label: progressLabel(fallback.progress) }
  }
  return { kind: 'offer', behind, sizeBytes: data.totalSizeBytes, start: fallback.start }
}
