'use client'

/**
 * BlameContent — each line of a file with the commit that last changed it (`git blame
 * --first-parent`), computed in the browser over the file's History ({@link blameFile}). The walk
 * is bounded (file size, versions compared), reports progress as it goes, can be cancelled, and
 * yields between versions so the page stays responsive; long files render only the rows in view.
 */

import Link from 'next/link'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { FileText, History, X } from 'lucide-react'
import { PathActions } from '@/components/repo/path-actions'
import type { BrowseReader } from '@/lib/browse'
import type { RepoHome } from '@/lib/view'
import { commitSubject, parseLineHash, selectedTip, selectRef, timeAgo } from '@/lib/view'
import { ROW_PX, scrollToRow, useRowWindow } from '@/hooks/use-row-window'
import { BLAME_MAX_COMMITS, BLAME_MAX_VERSIONS, BlameRefusedError, blameFile, type BlameProgress, type BlameResult } from '@/lib/view/blame'
import { plural } from '@/lib/view/format'
import { BrowseBoundary } from '@/components/repo/browse-boundary'
import { PathBreadcrumb } from '@/components/repo/path-breadcrumb'
import { RefDeletedState, RefNotFoundState, RefSwitcher } from '@/components/repo/ref-switcher'
import { Button } from '@/components/ui/button'
import { ScrollRegion } from '@/components/ui/scroll-region'
import { EmptyState, ErrorState } from '@/components/ui/states'
import { repoHref, type RepoAddress } from '@/hooks/use-query-param'
import { cn, errorMessage } from '@/lib/utils'

export function BlameContent({
  home,
  addr,
  path,
  refParam = '',
}: {
  home: RepoHome
  addr: RepoAddress
  path: string
  refParam?: string
}): JSX.Element {
  const selected = selectRef(home.branches, home.tags, home.defaultBranch, refParam)
  const tipOid = selectedTip(selected)
  if (refParam && !selected.ref && !selected.pinned) {
    return <RefNotFoundState addr={addr} refParam={refParam} defaultBranch={home.defaultBranch} />
  }
  if (!tipOid && selected.ref) return <RefDeletedState addr={addr} name={selected.name} defaultBranch={home.defaultBranch} />
  if (!tipOid) return <EmptyState icon={FileText} title="Empty repo" body={`No commits on ${selected.name}, so nothing to blame.`} />
  if (!path) return <EmptyState icon={FileText} title="No file addressed" body="Add &path= to the URL." />
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <RefSwitcher home={home} addr={addr} current={selected} path={path} />
        <PathBreadcrumb addr={addr} path={path} refParam={refParam} />
        <PathActions addr={addr} path={path} refParam={refParam} show={['code', 'history']} />
      </div>
      <BrowseBoundary repo={home.repo} addr={addr}>
        {(reader) => <BlameBody key={`${tipOid}\0${path}`} reader={reader} tipOid={tipOid} path={path} addr={addr} />}
      </BrowseBoundary>
    </div>
  )
}

type RunState =
  | { readonly kind: 'running'; readonly progress: BlameProgress | null }
  | { readonly kind: 'done'; readonly result: BlameResult }
  | { readonly kind: 'cancelled'; readonly progress: BlameProgress | null }
  | { readonly kind: 'failed'; readonly error: unknown }

/** One blame run over a reader (exported for its StrictMode test). */
export function BlameBody({ reader, tipOid, path, addr }: { reader: BrowseReader; tipOid: string; path: string; addr: RepoAddress }): JSX.Element {
  const [run, setRun] = useState<RunState>({ kind: 'running', progress: null })
  const [attempt, setAttempt] = useState(0)
  const stopRef = useRef<AbortController | null>(null)

  useEffect(() => {
    const stop = new AbortController()
    stopRef.current = stop
    let last: BlameProgress | null = null
    setRun({ kind: 'running', progress: null })
    // Only the current run reports: a run its effect cleaned up (a new file, StrictMode's replay)
    // settles into nothing, and never shows "Blame stopped" over the run that replaced it.
    const current = (): boolean => stopRef.current === stop
    blameFile(reader, tipOid, path, {
      signal: stop.signal,
      onProgress: (p) => {
        last = p
        if (current() && !stop.signal.aborted) setRun({ kind: 'running', progress: p })
      },
    }).then(
      (result) => current() && setRun({ kind: 'done', result }),
      (error: unknown) => current() && setRun(stop.signal.aborted ? { kind: 'cancelled', progress: last } : { kind: 'failed', error }),
    )
    return () => {
      // Unmount or a new run: stop this one without it reporting (Cancel aborts while it is current).
      if (stopRef.current === stop) stopRef.current = null
      stop.abort()
    }
  }, [reader, tipOid, path, attempt])

  if (run.kind === 'failed') {
    if (run.error instanceof BlameRefusedError) return <EmptyState icon={FileText} title="Can't blame this file" body={run.error.message} />
    return <ErrorState message={errorMessage(run.error)} onRetry={() => setAttempt((n) => n + 1)} />
  }
  if (run.kind === 'cancelled') {
    return (
      <EmptyState
        icon={History}
        title="Blame stopped"
        body={run.progress ? `Stopped after comparing ${plural(run.progress.versions, 'version')}.` : 'Stopped before any version was compared.'}
        action={<Button onClick={() => setAttempt((n) => n + 1)}>Start again</Button>}
      />
    )
  }
  if (run.kind === 'running') {
    const p = run.progress
    const done = p === null || p.total === 0 ? 0 : Math.round(((p.total - p.pending) / p.total) * 100)
    return (
      <div className="flex flex-col items-center gap-3 rounded-lg border border-anvil-200 px-4 py-10 text-center text-dense text-anvil-600 dark:border-anvil-800 dark:text-anvil-300" role="status" data-testid="blame-progress">
        <p>
          {p === null
            ? 'Reading the file’s history…'
            : `Compared ${plural(p.versions, 'version')} of up to ${BLAME_MAX_VERSIONS} · ${plural(p.total - p.pending, 'line')} of ${p.total} attributed`}
        </p>
        <div className="h-1.5 w-64 max-w-full overflow-hidden rounded-full bg-anvil-100 dark:bg-anvil-800" aria-hidden>
          <div className="h-full bg-forge-500 transition-[width]" style={{ width: `${done}%` }} />
        </div>
        <Button size="sm" onClick={() => stopRef.current?.abort()} data-testid="blame-cancel">
          <X className="h-3.5 w-3.5" aria-hidden /> Cancel
        </Button>
      </div>
    )
  }
  return <BlameTable result={run.result} addr={addr} />
}

function BlameTable({ result, addr }: { result: BlameResult; addr: RepoAddress }): JSX.Element {
  const { lines, hunks, commits } = result
  // The hunk each line is in, and whether it starts one (where the commit cell is drawn).
  const hunkOf = useMemo(() => {
    const at = new Int32Array(lines.length)
    hunks.forEach((h, k) => at.fill(k, h.start - 1, h.start - 1 + h.count))
    return at
  }, [lines.length, hunks])
  const tableRef = useRef<HTMLTableElement>(null)
  const { from, to } = useRowWindow(tableRef, lines.length)
  const [range] = useState(() => (typeof window === 'undefined' ? null : parseLineHash(window.location.hash, lines.length)))
  useLayoutEffect(() => {
    if (range !== null) scrollToRow(tableRef.current, range.start)
  }, [range])

  const rows: JSX.Element[] = []
  for (let i = from; i < to; i++) {
    const k = hunkOf[i] as number
    const hunk = hunks[k]
    if (hunk === undefined) continue
    const first = hunk.start - 1 === i || i === from
    const commit = commits.get(hunk.oid)
    const on = range !== null && i + 1 >= range.start && i + 1 <= range.end
    rows.push(
      <tr key={i} id={`L${i + 1}`} data-oid={hunk.oid} data-selected={on || undefined} className={cn('h-5', k % 2 === 1 && 'bg-anvil-50/60 dark:bg-anvil-900/40', on && 'bg-caution/15', first && i > 0 && 'border-t border-anvil-100 dark:border-anvil-850')}>
        <td className="w-72 max-w-[18rem] truncate whitespace-nowrap border-r border-anvil-100 px-3 py-0 align-top text-[12px] text-anvil-500 dark:border-anvil-850 dark:text-anvil-400">
          {first && commit ? (
            <span className="flex items-center gap-2">
              <span className="shrink-0 tabular-nums">{timeAgo(commit.author.when)}</span>
              {/* One per hunk, inside a 20 px code row (e2e/mobile.spec.ts exempts it, as the diff gutter). */}
              <Link href={repoHref('/repo/commit', addr, { oid: hunk.oid })} className="min-w-0 truncate hover:text-forge-800 dark:hover:text-forge-400" title={`${hunk.oid.slice(0, 7)} ${commit.author.name}`} data-tap-exempt="code-line" data-testid="blame-commit">
                {commitSubject(commit.message) || '(no message)'}
              </Link>
            </span>
          ) : null}
        </td>
        <td className="select-none whitespace-nowrap px-3 py-0 text-right align-top text-anvil-500 dark:text-anvil-400">{i + 1}</td>
        <td className="whitespace-pre px-4 py-0 align-top text-anvil-800 dark:text-anvil-200">{(lines[i] ?? '').replace(/\r?\n$/, '') || ' '}</td>
      </tr>,
    )
  }

  return (
    <div className="overflow-hidden rounded-lg border border-anvil-200 dark:border-anvil-800">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-anvil-200 bg-anvil-50 px-4 py-2 text-[12px] text-anvil-500 dark:border-anvil-800 dark:bg-anvil-900 dark:text-anvil-400" data-testid="blame-summary">
        <span>
          {plural(lines.length, 'line')} · {plural(commits.size, 'commit')} · {plural(result.versions, 'version')} compared
        </span>
        {result.partial ? (
          <span className="text-caution-700 dark:text-caution-400" data-testid="blame-partial">
            Partial: the walk hit a limit ({BLAME_MAX_VERSIONS} versions, {BLAME_MAX_COMMITS.toLocaleString('en-US')} commits, or a rename too large to look up), so the
            oldest lines may be older than shown.
          </span>
        ) : null}
        {result.approximate ? <span className="text-caution-700 dark:text-caution-400">Some changes were too large to align line by line.</span> : null}
        {result.renames.map((r) => (
          <span key={r.commit}>
            Followed a rename from <span className="font-mono">{r.from}</span>
          </span>
        ))}
        {result.unfollowedRename !== null ? (
          <span data-testid="blame-unfollowed-rename">
            Stopped where the file was added; it may have been renamed from <span className="font-mono">{result.unfollowedRename}</span> with edits, which is not
            followed.
          </span>
        ) : null}
      </div>
      <p className="border-b border-anvil-100 px-4 py-1.5 text-[11px] text-anvil-500 dark:border-anvil-850 dark:text-anvil-400" data-testid="blame-caveat">
        Computed in your browser from the file’s history. It can attribute some lines differently from{' '}
        <span className="font-mono">git blame</span> (lines that repeat and move, renames with edits); <span className="font-mono">git blame --first-parent</span> is the
        authoritative answer.
      </p>
      <ScrollRegion label="Blame" className="overflow-x-auto">
        <table ref={tableRef} className="w-full border-collapse font-mono text-[13px] leading-5" data-lines={lines.length} data-testid="blame-table">
          <tbody>
            {from > 0 ? <tr aria-hidden style={{ height: from * ROW_PX }} /> : null}
            {rows}
            {to < lines.length ? <tr aria-hidden style={{ height: (lines.length - to) * ROW_PX }} /> : null}
          </tbody>
        </table>
      </ScrollRegion>
    </div>
  )
}
