'use client'

/**
 * CommitsContent — the first-parent commit log (browse plane), newest first, a page at a time
 * ("Older" continues the walk where the last page stopped), and with `path` a file's or a
 * directory's History: only the commits that changed it. Pages walk one shared read-ahead walker
 * and the session memo of `lib/view/path-history.ts`, so an older page reads only what it adds.
 *
 * How many pages are shown is in the URL (`?pages=3`, L-31), and the scroll position is kept for
 * the tab, so Back from a commit returns to the same place in the list. Each row's date is the
 * author date, labelled so, with the exact time on hover (L-27). The footer says how many commits
 * are shown, out of how many when a history index gives the count (L-35).
 */

import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { GitCommit, History } from 'lucide-react'
import type { BrowseReader } from '@/lib/browse'
import type { RepoHome } from '@/lib/view'
import { selectedTip, selectRef, type LogEntry } from '@/lib/view'
import { historyWalker } from '@/lib/view/commit-log'
import { LOG_PAGE, logPage, PATH_WALK_CAP, type LogPage } from '@/lib/view/path-history'
import { historyOf } from '@/lib/view/history-source'
import { useAsync } from '@/hooks/use-async'
import { Time } from '@/components/repo/byline'
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
  /** Pages loaded so far. */
  readonly pages: number
}

/** A log before its first page. */
export function freshLog(tipOid: string): LogState {
  return { entries: [], next: tipOid, loading: true, error: null, examined: 0, capped: false, pages: 0 }
}

/** Most pages a `?pages=` link loads on open (40 commits each). */
export const MAX_URL_PAGES = 50

/** The pages a `?pages=` value asks for: 1 to {@link MAX_URL_PAGES}, 1 for anything else. */
export function pagesParam(raw: string | null): number {
  const n = Number(raw)
  return Number.isInteger(n) && n >= 1 ? Math.min(n, MAX_URL_PAGES) : 1
}

/** The footer's count (L-35): what is shown, and of how many when that is known; for a path's History, what changed it. */
export function logStatus(state: Pick<LogState, 'entries' | 'next'>, total: number | null, path = ''): string {
  const n = state.entries.length
  if (path) return state.next === null ? `The whole history of ${path}: ${plural(n, 'commit')}` : `Showing ${plural(n, 'commit')} that changed ${path}`
  if (state.next === null) return `The whole history: ${plural(n, 'commit')}`
  if (total !== null && total >= n) return `Showing ${n.toLocaleString('en-US')} of ${plural(total, 'commit')}`
  return `Showing the newest ${plural(n, 'commit')}`
}

/** `state` with one more page appended (a page that repeats what is shown adds nothing twice). */
export function withPage(state: LogState, page: LogPage): LogState {
  const shown = new Set(state.entries.map((e) => e.oid))
  return {
    entries: [...state.entries, ...page.entries.filter((e) => !shown.has(e.oid))],
    next: page.next,
    loading: false,
    error: null,
    examined: state.examined + page.examined,
    capped: page.capped,
    pages: state.pages + 1,
  }
}

/** Where the list was scrolled, per URL, for this tab. */
const scrollKey = (): string => `forge:log-scroll:${window.location.pathname}${window.location.search}`

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
  const params = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const wanted = pagesParam(params.get('pages'))
  // The first-parent count, when a history index covers this tip: the log's "of N".
  const history = historyOf(reader)
  const total = useAsync(async () => (await history!.load(tipOid)).firstParentCount, [tipOid, history !== null], {
    enabled: path === '' && history?.covers(tipOid) === true,
  })

  /** Walk one more page from where the last one stopped (a capped path walk resumes there too). */
  const loadMore = useCallback(
    (from: string | null) => {
      if (from === null || run.current !== null) return
      const stop = new AbortController()
      run.current = stop
      setState((s) => ({ ...s, loading: true, error: null }))
      logPage(reader, from, { path, walker, signal: stop.signal }).then(
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

  // A `?pages=` link (Back from a commit) loads that many pages again, one after another.
  useEffect(() => {
    if (!state.loading && state.error === null && state.pages > 0 && state.pages < wanted) loadMore(state.next)
  }, [state.loading, state.error, state.pages, state.next, wanted, loadMore])
  // Back to where the list was: once the pages the URL names are in, scroll to the kept position.
  const restored = useRef(false)
  useEffect(() => {
    if (restored.current || state.loading || (state.pages < wanted && state.next !== null)) return
    restored.current = true
    // Used once: a later visit by a plain link starts at the top.
    const y = Number(sessionStorage.getItem(scrollKey()))
    sessionStorage.removeItem(scrollKey())
    if (y > 0) window.scrollTo(0, y)
  }, [state.loading, state.pages, state.next, wanted])
  const older = (): void => {
    const q = new URLSearchParams(params.toString())
    q.set('pages', String(Math.min(state.pages + 1, MAX_URL_PAGES)))
    router.replace(`${pathname}?${q.toString()}`, { scroll: false })
    loadMore(state.next)
  }
  // Leaving for a commit (or anywhere): keep the position for Back.
  const keepScroll = (): void => sessionStorage.setItem(scrollKey(), String(Math.round(window.scrollY)))

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
      <div className="overflow-hidden rounded-lg border border-anvil-200 dark:border-anvil-800" data-testid="commit-log" onClickCapture={keepScroll}>
        {state.entries.map((entry) => (
          <div key={entry.oid} className="flex items-center gap-3 border-b border-anvil-100 px-4 py-2.5 last:border-b-0 dark:border-anvil-850" data-testid="commit-row">
            {/* Touch: the message link stretches over its whole text column (both lines and the
                row's padding): a 44px+ target that leaves the copy button beside it alone. */}
            <div className="relative min-w-0 flex-1">
              <Link href={repoHref('/repo/commit', addr, { oid: entry.oid })} className="block truncate text-dense font-medium text-anvil-900 hover:text-forge-800 coarse:after:absolute coarse:after:inset-x-0 coarse:after:-inset-y-2.5 coarse:after:content-[''] dark:text-anvil-50 dark:hover:text-forge-400">
                {entry.subject || '(no message)'}
              </Link>
              <div className="mt-0.5 flex items-center gap-2 text-[12px] text-anvil-500 dark:text-anvil-400">
                <span>{entry.commit.author.name || 'unknown'}</span>
                <span>
                  · <Time ms={entry.commit.author.when} prefix="authored " />
                </span>
              </div>
            </div>
            <Oid value={entry.oid} chars={7} />
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-[12px] text-anvil-500 dark:text-anvil-400">
        <span data-testid="log-status">
          {logStatus(state, total.data, path)}
          {path && state.capped ? ` · searched the last ${plural(state.examined, 'commit')} (up to ${PATH_WALK_CAP} a page)` : ''}
        </span>
        {state.error !== null ? <span className="text-danger-700 dark:text-danger-400">{state.error}</span> : null}
        {state.next !== null ? (
          <Button size="sm" loading={state.loading} onClick={older} data-testid="older-commits" title={`The next ${LOG_PAGE} commits`}>
            Older
          </Button>
        ) : null}
      </div>
    </div>
  )
}
