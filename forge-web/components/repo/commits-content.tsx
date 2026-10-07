'use client'

/**
 * CommitsContent — the commit log (browse plane), a page at a time ("Older" continues the walk
 * where the last page stopped): every commit reachable from the tip in `git log`'s order
 * ({@link dateOrderedPage}, QW-006), or with `?first-parent=1` the first-parent log alone (the
 * commits made on the branch itself, merges standing for what they brought in), labelled so. With
 * `path`, a file's or a directory's History: by default the first-parent commits that changed it
 * ({@link pathVersions}: from the push-time history index when one covers the tip, with no walk),
 * labelled first-parent too; with `?first-parent=0` every commit that changed it, as
 * `git log -- <path>` lists them ({@link pathDateOrderedPage}, QW2-041: always a walk). Pages walk one shared read-ahead walker
 * and the session memo of `lib/view/path-history.ts`, so an older page reads only what it adds.
 *
 * How many pages are shown is in the URL (`?pages=3`, L-31), and the scroll position is kept for
 * the tab, so Back from a commit returns to the same place in the list. Each row's date is the
 * author date, labelled so, with the exact time on hover (L-27). The footer says how many commits
 * are shown, out of how many when a history index gives the count (L-35). Each commit gets its CI
 * status dot once its page is shown (`./check-dot`: three proved counts per page of commits, plus a run read per head whose re-runs disagree).
 */

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { usePathname, useSearchParams } from '@/hooks/use-route'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { GitCommit, History } from 'lucide-react'
import type { BrowseReader } from '@/lib/browse'
import type { RepoRef } from '@/lib/repo'
import type { RepoHome } from '@/lib/view'
import { selectedTip, selectRef, type LogEntry } from '@/lib/view'
import { historyWalker } from '@/lib/view/commit-log'
import { dateOrderedPage, pathDateOrderedPage, type DateWalk } from '@/lib/view/date-log'
import { LOG_PAGE, PATH_WALK_CAP, pathVersions } from '@/lib/view/path-history'
import { historyOf } from '@/lib/view/history-source'
import { useAsync } from '@/hooks/use-async'
import { Time } from '@/components/repo/byline'
import { formatDate, plural } from '@/lib/view/format'
import { dayRuns } from '@/lib/view/commit-days'
import { BrowseBoundary } from '@/components/repo/browse-boundary'
import { ResolvedTip } from '@/components/repo/resolved-tip'
import { PathBreadcrumb } from '@/components/repo/path-breadcrumb'
import { RefDeletedState, RefSwitcher, unknownRefState } from '@/components/repo/ref-switcher'
import { Oid } from '@/components/ui/oid'
import { CheckDot, useCheckOutcomes } from '@/components/repo/check-dot'
import { SignatureBadge } from '@/components/repo/signature-badge'
import { useCommitSignatures } from '@/hooks/use-commit-signatures'
import { Button } from '@/components/ui/button'
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/states'
import { repoHref, type RepoAddress } from '@/hooks/use-query-param'
import { cn, errorMessage } from '@/lib/utils'

export function CommitsContent({
  home,
  addr,
  refParam = '',
  path = '',
  firstParentParam = '',
}: {
  home: RepoHome
  addr: RepoAddress
  refParam?: string
  /** A file or directory: its History ('' = the whole log). */
  path?: string
  /** The `?first-parent=` value ({@link isFirstParent}). */
  firstParentParam?: string
}): JSX.Element {
  const firstParent = isFirstParent(path, firstParentParam)
  const selected = selectRef(home.branches, home.tags, home.defaultBranch, refParam)
  const unknown = unknownRefState(home, addr, selected, refParam, path)
  if (unknown !== null) return unknown
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
            {(tip) => (
              <LogBody key={`${tip.oid}\0${path}\0${firstParent}`} repo={home.repo} reader={reader} retry={retry} tipOid={tip.oid} addr={addr} path={path} firstParent={firstParent} />
            )}
          </ResolvedTip>
        )}
      </BrowseBoundary>
    </div>
  )
}

/** Where a log's next page starts: a commit (the first-parent walk), or the full log's walk. */
export type LogCursor = string | DateWalk

/** One page of a log, from either walk. */
export interface LogPageOf {
  readonly entries: readonly LogEntry[]
  readonly next: LogCursor | null
  readonly examined: number
  readonly capped: boolean
  readonly indexed: number
}

export interface LogState {
  readonly entries: readonly LogEntry[]
  /** Where the next page starts; null once the walk reached the root (or the path's first commit). */
  readonly next: LogCursor | null
  readonly loading: boolean
  readonly error: string | null
  /** Commits examined so far by a path walk (for the "no change in the last n" note). */
  readonly examined: number
  readonly capped: boolean
  /** Entries the push-time history index listed (no walk). */
  readonly indexed: number
  /** Pages loaded so far. */
  readonly pages: number
}

/** A log before its first page. */
export function freshLog(tipOid: string): LogState {
  return { entries: [], next: tipOid, loading: true, error: null, examined: 0, capped: false, indexed: 0, pages: 0 }
}

/** Most pages a `?pages=` link loads on open (40 commits each). */
export const MAX_URL_PAGES = 50

/** The pages a `?pages=` value asks for: 1 to {@link MAX_URL_PAGES}, 1 for anything else. */
export function pagesParam(raw: string | null): number {
  const n = Number(raw)
  return Number.isInteger(n) && n >= 1 ? Math.min(n, MAX_URL_PAGES) : 1
}

/**
 * `?first-parent=`: `1` lists the first-parent log instead of every commit; a path's History is
 * first-parent unless it is `0` (the history index answers that one without a walk).
 */
export const FIRST_PARENT_PARAM = 'first-parent'

/** Whether a log lists first-parent commits only: the whole log with `?first-parent=1`, a path's History unless `?first-parent=0`. */
export function isFirstParent(path: string, param: string): boolean {
  return path === '' ? param === '1' : param !== '0'
}

/**
 * The footer's count (L-35): what is shown, and of how many when that is known; for a path's
 * History, what changed it. A first-parent list says so (QW-006): it is not the whole history.
 */
export function logStatus(state: Pick<LogState, 'entries' | 'next'>, total: number | null, path = '', firstParent = path !== ''): string {
  const n = state.entries.length
  const fp = firstParent ? 'first-parent ' : ''
  if (path) {
    if (state.next === null) return `The ${fp}history of ${path}: ${plural(n, 'commit')}`
    return `Showing ${n.toLocaleString('en-US')} ${fp}${n === 1 ? 'commit' : 'commits'} that changed ${path}`
  }
  if (state.next === null) return firstParent ? `Every first-parent commit: ${n.toLocaleString('en-US')}` : `The whole history: ${plural(n, 'commit')}`
  if (total !== null && total >= n) return `Showing ${n.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} ${fp}${total === 1 ? 'commit' : 'commits'}`
  return `Showing the newest ${n.toLocaleString('en-US')} ${fp}${n === 1 ? 'commit' : 'commits'}`
}

/** `state` with one more page appended (a page that repeats what is shown adds nothing twice). */
export function withPage(state: LogState, page: LogPageOf): LogState {
  const shown = new Set(state.entries.map((e) => e.oid))
  return {
    entries: [...state.entries, ...page.entries.filter((e) => !shown.has(e.oid))],
    next: page.next,
    loading: false,
    error: null,
    examined: state.examined + page.examined,
    capped: page.capped,
    indexed: state.indexed + page.indexed,
    pages: state.pages + 1,
  }
}

/**
 * All commits (git log's order) or the first-parent log (QW-006), for the whole log and a path's
 * History alike (QW2-041): the same URL with the other `?first-parent=`, from its first page.
 */
function OrderToggle({ firstParent, path, pathname, params }: { firstParent: boolean; path: string; pathname: string; params: { toString(): string } }): JSX.Element {
  const hrefFor = (fp: boolean): string => {
    const q = new URLSearchParams(params.toString())
    q.delete('pages')
    // Each log's default is its bare URL: every commit for the whole log, first-parent for a path.
    const value = path === '' ? (fp ? '1' : null) : fp ? null : '0'
    if (value === null) q.delete(FIRST_PARENT_PARAM)
    else q.set(FIRST_PARENT_PARAM, value)
    return `${pathname}?${q.toString()}`
  }
  const option = (fp: boolean, label: string, title: string): JSX.Element => {
    const on = fp === firstParent
    return (
      <Link
        href={hrefFor(fp)}
        replace
        aria-current={on ? 'true' : undefined}
        title={title}
        className={cn(
          // 44 px tall to a finger (e2e/mobile.spec.ts), as the other controls.
          'rounded-md px-2.5 py-1 font-medium coarse:inline-flex coarse:min-h-11 coarse:items-center',
          on ? 'bg-white text-anvil-900 shadow-sm dark:bg-anvil-800 dark:text-anvil-50' : 'text-anvil-500 hover:text-anvil-800 dark:text-anvil-400 dark:hover:text-anvil-100',
        )}
        data-testid={fp ? 'log-first-parent' : 'log-all-commits'}
      >
        {label}
      </Link>
    )
  }
  return (
    <div className="flex flex-wrap items-center gap-2 text-[12px]">
      <nav aria-label="Which commits" className="inline-flex rounded-lg bg-anvil-100 p-0.5 dark:bg-anvil-900">
        {path === '' ? (
          <>
            {option(false, 'All commits', 'Every commit reachable from this ref, newest first, as git log lists them')}
            {option(true, 'First-parent only', 'Only the commits made on this branch itself: a merge stands for the commits it brought in (git log --first-parent)')}
          </>
        ) : (
          <>
            {option(false, 'All commits', `Every commit that changed ${path}, including those on merged branches, as git log -- ${path} lists them back to when the path was added (walked in your browser)`)}
            {option(true, 'First-parent only', `Only the commits on this branch itself that changed ${path}: a merge stands for the changes it brought in`)}
          </>
        )}
      </nav>
      {firstParent ? (
        <span className="text-anvil-500 dark:text-anvil-400" data-testid="log-first-parent-note">
          Merged branches’ own commits are not listed.
        </span>
      ) : null}
    </div>
  )
}

/**
 * What a log row's day header groups it by (QW2-044): its commit date, which `git log` orders the
 * list by (so each day is one header, as on GitHub), else its author date (a row the history index
 * listed carries the author time only). Per row, so a page appended later never regroups the
 * rows already shown.
 */
export const dayOf = (e: LogEntry): number => e.committedAt ?? e.author.when

/** Where the list was scrolled, per route (the same while the address bar shows its short URL), for this tab. */
const scrollKey = (pathname: string, params: URLSearchParams): string => `forge:log-scroll:${pathname}?${params.toString()}`

function LogBody({
  repo,
  reader,
  retry,
  tipOid,
  addr,
  path,
  firstParent,
}: {
  repo: RepoRef
  reader: BrowseReader
  retry: () => void
  tipOid: string
  addr: RepoAddress
  path: string
  firstParent: boolean
}): JSX.Element {
  // One read-ahead walker for every page of this log, so an older page reuses its blocks.
  const walker = useMemo(() => historyWalker(reader), [reader])
  const [state, setState] = useState<LogState>(() => freshLog(tipOid))
  const run = useRef<AbortController | null>(null)
  const params = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const wanted = pagesParam(params.get('pages'))
  // The count, when a history index covers this tip: the log's "of N" (every commit, or the first-parent ones).
  const history = historyOf(reader)
  const total = useAsync(
    async () => {
      const ix = await history!.load(tipOid)
      return firstParent ? ix.firstParentCount : ix.commitCount
    },
    [tipOid, history !== null, firstParent],
    { enabled: path === '' && history?.covers(tipOid) === true },
  )
  // The status dots: read once a page is shown, only for the commits it adds; a `?pages=` restore
  // waits for its last page, so its pages share batches of 100 rather than reading one by one.
  const restoring = state.pages < wanted && state.next !== null && state.error === null
  const oids = useMemo(() => (restoring ? [] : state.entries.map((e) => e.oid)), [restoring, state.entries])
  const outcomes = useCheckOutcomes(repo, oids)
  // Signed commits' Verified / Unverified badges (P1-7): the signers are read once one shows.
  const signatures = useCommitSignatures(repo, state.entries)

  /** Walk one more page from where the last one stopped (a capped path walk resumes there too). */
  const loadMore = useCallback(
    (from: LogCursor | null) => {
      if (from === null || run.current !== null) return
      const stop = new AbortController()
      run.current = stop
      setState((s) => ({ ...s, loading: true, error: null }))
      const page: Promise<LogPageOf> =
        firstParent && typeof from === 'string'
          ? pathVersions(reader, from, path, { walker, signal: stop.signal, withEntries: false })
          : path !== ''
            ? pathDateOrderedPage(reader, from, path, { walker, signal: stop.signal }).then((p) => ({ ...p, indexed: 0 }))
            : dateOrderedPage(reader, from, { walker, signal: stop.signal }).then((p) => ({ ...p, capped: false, indexed: 0 }))
      page.then(
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
    [reader, walker, path, firstParent],
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
    const key = scrollKey(pathname, params)
    const y = Number(sessionStorage.getItem(key))
    sessionStorage.removeItem(key)
    if (y > 0) window.scrollTo(0, y)
  }, [state.loading, state.pages, state.next, wanted, pathname, params])
  const older = (): void => {
    const q = new URLSearchParams(params.toString())
    q.set('pages', String(Math.min(state.pages + 1, MAX_URL_PAGES)))
    router.replace(`${pathname}?${q.toString()}`, { scroll: false })
    loadMore(state.next)
  }
  // Leaving for a commit (or anywhere): keep the position for Back.
  const keepScroll = (): void => sessionStorage.setItem(scrollKey(pathname, params), String(Math.round(window.scrollY)))

  if (state.error !== null && state.entries.length === 0) return <ErrorState message={state.error} onRetry={retry} />
  if (state.entries.length === 0 && state.loading) return <LoadingBlock label={path ? `Walking the history of ${path}` : 'Walking history'} />
  if (state.entries.length === 0) {
    return (
      <div className="space-y-3">
        {/* The other order stays one click away (the first-parent History has the index). */}
        <OrderToggle firstParent={firstParent} path={path} pathname={pathname} params={params} />
        <EmptyState
          icon={GitCommit}
          title="No commits found"
          body={state.capped ? `No change to ${path} in the last ${plural(state.examined, 'commit')}.` : `Nothing in this history touches ${path || 'the repo'}.`}
          action={
            state.next !== null ? (
              <Button size="sm" loading={state.loading} onClick={older} data-testid="older-commits">
                Search older commits
              </Button>
            ) : undefined
          }
        />
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <OrderToggle firstParent={firstParent} path={path} pathname={pathname} params={params} />
      <div
        className="overflow-hidden rounded-lg border border-anvil-200 dark:border-anvil-800"
        data-testid="commit-log"
        data-order={firstParent ? 'first-parent' : 'all'}
        data-source={state.indexed > 0 ? 'index' : 'walk'}
        onClickCapture={keepScroll}
      >
        {dayRuns(state.entries, dayOf).flatMap((run, r) => [
          // QW-061c: "Commits on <day>", as GitHub groups its list.
          <h2 key={`day-${r}-${run.day}`} className="border-b border-anvil-100 bg-anvil-50 px-4 py-1.5 text-[12px] font-medium text-anvil-600 dark:border-anvil-850 dark:bg-anvil-900 dark:text-anvil-300" data-testid="commit-day">
            {run.day === '' ? 'Commits of unknown date' : `Commits on ${formatDate(run.at)}`}
          </h2>,
          ...run.rows.map((entry) => (
          <div key={entry.oid} className="flex items-center gap-3 border-b border-anvil-100 px-4 py-2.5 last:border-b-0 dark:border-anvil-850" data-testid="commit-row">
            {/* Touch: the message link stretches over its whole text column (both lines and the
                row's padding): a 44px+ target that leaves the copy button beside it alone. */}
            <div className="relative min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-1.5">
                <Link href={repoHref('/repo/commit', addr, { oid: entry.oid })} className="block min-w-0 truncate text-dense font-medium text-anvil-900 hover:text-forge-800 coarse:after:absolute coarse:after:inset-x-0 coarse:after:-inset-y-2.5 coarse:after:content-[''] dark:text-anvil-50 dark:hover:text-forge-400">
                  {entry.subject || '(no message)'}
                </Link>
                <CheckDot counts={outcomes.get(entry.oid)} />
              </div>
              {/* One line on a phone: the name gives way (ellipsis), the age never breaks. */}
              <div className="mt-0.5 flex min-w-0 items-center gap-2 text-[12px] text-anvil-500 dark:text-anvil-400">
                <span className="min-w-0 truncate">{entry.author.name || 'unknown'}</span>
                <span className="shrink-0 whitespace-nowrap">
                  · <Time ms={entry.author.when} prefix="authored " />
                </span>
              </div>
            </div>
            <SignatureBadge state={signatures.get(entry.oid)} />
            <Oid value={entry.oid} chars={7} />
          </div>
          )),
        ])}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-[12px] text-anvil-500 dark:text-anvil-400">
        <span data-testid="log-status">
          {logStatus(state, total.data, path, firstParent)}
          {path && state.capped ? ` · searched the last ${plural(state.examined, 'commit')} (up to ${PATH_WALK_CAP} a page)` : ''}
          {state.indexed > 0 ? (
            <span title="Listed by the history index the last push published: no history walk in your browser" data-testid="log-from-index">
              {' · from the history index'}
            </span>
          ) : null}
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
