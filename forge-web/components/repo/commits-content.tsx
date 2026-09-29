'use client'

/**
 * CommitsContent — the first-parent commit log (browse plane), newest first, a page at a time
 * ("Older" continues the walk where the last page stopped), and with `path` a file's or a
 * directory's History: only the commits that changed it ({@link pathVersions}: from the push-time
 * history index when one covers the tip, with no walk). Pages walk one shared read-ahead walker
 * and the session memo of `lib/view/path-history.ts`, so an older page reads only what it adds.
 */

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { GitCommit, History } from 'lucide-react'
import type { BrowseReader } from '@/lib/browse'
import type { RepoHome } from '@/lib/view'
import { selectedTip, selectRef, timeAgo, type LogEntry } from '@/lib/view'
import { historyWalker } from '@/lib/view/commit-log'
import { PATH_WALK_CAP, pathVersions, type PathVersionsPage } from '@/lib/view/path-history'
import { plural } from '@/lib/view/format'
import { BrowseBoundary } from '@/components/repo/browse-boundary'
import { ResolvedTip } from '@/components/repo/resolved-tip'
import { PathBreadcrumb } from '@/components/repo/path-breadcrumb'
import { RefDeletedState, RefNotFoundState, RefSwitcher } from '@/components/repo/ref-switcher'
import { Oid } from '@/components/ui/oid'
import { Button } from '@/components/ui/button'
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/states'
import { repoHref, type RepoAddress } from '@/hooks/use-query-param'
import { errorMessage } from '@/lib/utils'

export function CommitsContent({
  home,
  addr,
  refParam = '',
  path = '',
}: {
  home: RepoHome
  addr: RepoAddress
  refParam?: string
  /** A file or directory: its History ('' = the whole log). */
  path?: string
}): JSX.Element {
  const selected = selectRef(home.branches, home.tags, home.defaultBranch, refParam)
  if (refParam && !selected.ref && !selected.pinned) {
    return <RefNotFoundState addr={addr} refParam={refParam} defaultBranch={home.defaultBranch} />
  }
  const tipOid = selectedTip(selected)
  // An enumerated ref with no tip was deleted; only a ref with no entry at all is "empty".
  if (!tipOid && selected.ref) {
    return <RefDeletedState addr={addr} name={selected.name} defaultBranch={home.defaultBranch} />
  }
  if (!tipOid) return <EmptyState icon={GitCommit} title="No commits yet" body={`History appears once the first commit is pushed to ${selected.name}.`} />
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <RefSwitcher home={home} addr={addr} current={selected} path={path || undefined} />
        {path ? (
          <>
            <span className="inline-flex items-center gap-1 text-dense text-anvil-500 dark:text-anvil-400">
              <History className="h-3.5 w-3.5" aria-hidden /> History of
            </span>
            <PathBreadcrumb addr={addr} path={path} refParam={refParam} />
          </>
        ) : null}
      </div>
      <BrowseBoundary repo={home.repo} addr={addr}>
        {(reader, retry) => (
          <ResolvedTip reader={reader} retry={retry} repo={home.repo} tip={tipOid} pinned={selected.pinned !== undefined} name={selected.name} addr={addr} refParam={refParam} accepts="commit" label="Walking history">
            {(tip) => <LogBody key={`${tip.oid}\0${path}`} reader={reader} retry={retry} tipOid={tip.oid} addr={addr} path={path} />}
          </ResolvedTip>
        )}
      </BrowseBoundary>
    </div>
  )
}

export interface LogState {
  readonly entries: readonly LogEntry[]
  /** Where the next page starts; null once the walk reached the root (or the path's first commit). */
  readonly next: string | null
  readonly loading: boolean
  readonly error: string | null
  /** Commits examined so far by a path walk (for the "no change in the last n" note). */
  readonly examined: number
  readonly capped: boolean
  /** Entries the push-time history index listed (no walk). */
  readonly indexed: number
}

/** A log before its first page. */
export function freshLog(tipOid: string): LogState {
  return { entries: [], next: tipOid, loading: true, error: null, examined: 0, capped: false, indexed: 0 }
}

/** `state` with one more page appended (a page that repeats what is shown adds nothing twice). */
export function withPage(state: LogState, page: PathVersionsPage): LogState {
  const shown = new Set(state.entries.map((e) => e.oid))
  return {
    entries: [...state.entries, ...page.entries.filter((e) => !shown.has(e.oid))],
    next: page.next,
    loading: false,
    error: null,
    examined: state.examined + page.examined,
    capped: page.capped,
    indexed: state.indexed + page.indexed,
  }
}

function LogBody({
  reader,
  retry,
  tipOid,
  addr,
  path,
}: {
  reader: BrowseReader
  retry: () => void
  tipOid: string
  addr: RepoAddress
  path: string
}): JSX.Element {
  // One read-ahead walker for every page of this log, so an older page reuses its blocks.
  const walker = useMemo(() => historyWalker(reader), [reader])
  const [state, setState] = useState<LogState>(() => freshLog(tipOid))
  const run = useRef<AbortController | null>(null)

  /** Walk one more page from where the last one stopped (a capped path walk resumes there too). */
  const loadMore = useCallback(
    (from: string | null) => {
      if (from === null || run.current !== null) return
      const stop = new AbortController()
      run.current = stop
      setState((s) => ({ ...s, loading: true, error: null }))
      pathVersions(reader, from, path, { walker, signal: stop.signal }).then(
        (page) => {
          if (stop.signal.aborted) return
          run.current = null
          setState((s) => withPage(s, page))
        },
        (e: unknown) => {
          if (stop.signal.aborted) return
          run.current = null
          setState((s) => ({ ...s, loading: false, error: errorMessage(e) }))
        },
      )
    },
    [reader, walker, path],
  )
  // The first page on mount, and again from scratch for a new reader (the same tip reached by
  // another URL, a push that replaced the reader): a remount (StrictMode) aborts the first run and
  // starts again. Never appended to what an earlier reader showed.
  useEffect(() => {
    setState(freshLog(tipOid))
    loadMore(tipOid)
    return () => {
      run.current?.abort()
      run.current = null
    }
  }, [loadMore, tipOid])

  if (state.error !== null && state.entries.length === 0) return <ErrorState message={state.error} onRetry={retry} />
  if (state.entries.length === 0 && state.loading) return <LoadingBlock label={path ? `Walking the history of ${path}` : 'Walking history'} />
  if (state.entries.length === 0) {
    return (
      <EmptyState
        icon={GitCommit}
        title="No commits found"
        body={state.capped ? `No change to ${path} in the last ${plural(state.examined, 'commit')}.` : `Nothing in this history touches ${path || 'the repo'}.`}
      />
    )
  }

  return (
    <div className="space-y-3">
      <div
        className="overflow-hidden rounded-lg border border-anvil-200 dark:border-anvil-800"
        data-testid="commit-log"
        data-source={state.indexed > 0 ? 'index' : 'walk'}
      >
        {state.entries.map((entry) => (
          <div key={entry.oid} className="flex items-center gap-3 border-b border-anvil-100 px-4 py-2.5 last:border-b-0 dark:border-anvil-850" data-testid="commit-row">
            {/* Touch: the message link stretches over its whole text column (both lines and the
                row's padding): a 44px+ target that leaves the copy button beside it alone. */}
            <div className="relative min-w-0 flex-1">
              <Link href={repoHref('/repo/commit', addr, { oid: entry.oid })} className="block truncate text-dense font-medium text-anvil-900 hover:text-forge-800 coarse:after:absolute coarse:after:inset-x-0 coarse:after:-inset-y-2.5 coarse:after:content-[''] dark:text-anvil-50 dark:hover:text-forge-400">
                {entry.subject || '(no message)'}
              </Link>
              <div className="mt-0.5 flex items-center gap-2 text-[12px] text-anvil-500 dark:text-anvil-400">
                <span>{entry.author.name || 'unknown'}</span>
                <span>· {timeAgo(entry.author.when)}</span>
              </div>
            </div>
            <Oid value={entry.oid} chars={7} />
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-[12px] text-anvil-500 dark:text-anvil-400">
        <span data-testid="log-status">
          {plural(state.entries.length, 'commit')}
          {path && state.capped ? ` · searched the last ${plural(state.examined, 'commit')} (up to ${PATH_WALK_CAP} a page)` : ''}
          {state.next === null ? ' · the whole history' : ''}
          {state.indexed > 0 ? (
            <span title="Listed by the history index the last push published: no history walk in your browser" data-testid="log-from-index">
              {' · from the history index'}
            </span>
          ) : null}
        </span>
        {state.error !== null ? <span className="text-danger-700 dark:text-danger-400">{state.error}</span> : null}
        {state.next !== null ? (
          <Button size="sm" loading={state.loading} onClick={() => loadMore(state.next)} data-testid="older-commits">
            Older
          </Button>
        ) : null}
      </div>
    </div>
  )
}
