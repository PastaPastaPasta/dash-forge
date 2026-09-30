'use client'

/**
 * BlameContent — each line of a file with the commit that last changed it (`git blame
 * --first-parent`), computed in the browser over the file's History ({@link blameFile}). The walk
 * is bounded (file size, versions compared), reports progress as it goes, can be cancelled, and
 * yields between versions so the page stays responsive; long files render only the rows in view.
 * Lines a bounded or cancelled walk did not reach are shown as not attributed yet (the version it
 * stopped at "or older", QW-005), and "Continue blame" goes on from there.
 */

import Link from 'next/link'
import { useEffect, useMemo, useRef, useState } from 'react'
import { FileText, History, X } from 'lucide-react'
import { PathActions } from '@/components/repo/path-actions'
import type { BrowseReader } from '@/lib/browse'
import type { RepoHome } from '@/lib/view'
import type { RepoRef } from '@/lib/repo'
import { highlightBlob, lineHash, selectedTip, selectLine, selectRef, timeAgo } from '@/lib/view'
import { ROW_PX, scrollToRow, useRowWindow } from '@/hooks/use-row-window'
import { BLAME_MAX_COMMITS, BLAME_MAX_VERSIONS, BlameRefusedError, BlameStoppedError, blameFile, type BlameCursor, type BlameProgress, type BlameResult } from '@/lib/view/blame'
import { BlobToolbar, useLineSelection } from '@/components/repo/blob-content'
import { permalinkPath, pinnedHref, usePermalinkKey } from '@/components/repo/permalink'
import { formatDate, plural } from '@/lib/view/format'
import { BrowseBoundary } from '@/components/repo/browse-boundary'
import { ReadErrorState, ResolvedTip } from '@/components/repo/resolved-tip'
import { PathBreadcrumb } from '@/components/repo/path-breadcrumb'
import { RefDeletedState, RefNotFoundState, RefSwitcher } from '@/components/repo/ref-switcher'
import { Button } from '@/components/ui/button'
import { ScrollRegion } from '@/components/ui/scroll-region'
import { EmptyState } from '@/components/ui/states'
import { repoHref, type RepoAddress } from '@/hooks/use-query-param'
import { cn } from '@/lib/utils'
import { nextRovingIndex } from '@/lib/view/gutter-rove'

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
        {(reader, retry) => (
          <ResolvedTip reader={reader} retry={retry} repo={home.repo} tip={tipOid} pinned={selected.pinned !== undefined} name={selected.name} addr={addr} refParam={refParam} accepts="commit" label="Reading the file’s history">
            {(tip) => (
              <BlameBody key={`${tip.oid}\0${path}`} reader={reader} tipOid={tip.oid} path={path} addr={addr} privateRepo={home.repo.visibility === 'private'} repo={home.repo} />
            )}
          </ResolvedTip>
        )}
      </BrowseBoundary>
    </div>
  )
}

type RunState =
  | { readonly kind: 'running'; readonly progress: BlameProgress | null }
  | { readonly kind: 'done'; readonly result: BlameResult }
  | { readonly kind: 'cancelled'; readonly progress: BlameProgress | null; readonly partial: BlameResult | null }
  | { readonly kind: 'failed'; readonly error: unknown }

/** One blame run over a reader (exported for its StrictMode test). */
export function BlameBody({
  reader,
  tipOid,
  path,
  addr,
  privateRepo = false,
  repo,
}: {
  reader: BrowseReader
  tipOid: string
  path: string
  addr: RepoAddress
  privateRepo?: boolean
  /** For the storage card when a pack's storage stops answering (tests may leave it out). */
  repo?: RepoRef
}): JSX.Element {
  const [run, setRun] = useState<RunState>({ kind: 'running', progress: null })
  // Each run: a fresh walk (`from` null), or one continued from where a partial one stopped.
  const [job, setJob] = useState<{ readonly from: BlameCursor | null }>({ from: null })
  const stopRef = useRef<AbortController | null>(null)
  // `y` pins the address to this commit (as the file view does), keeping the `#L` selection (L-33).
  usePermalinkKey(pinnedHref(addr, 'blame', tipOid, path, privateRepo))
  // A full URL, as the file view copies (null in the instant a private repo's vault locks).
  const pinned = permalinkPath(addr, 'blame', tipOid, path, privateRepo)
  const permalink = pinned === null ? null : `${typeof window === 'undefined' ? '' : window.location.origin}${pinned}`
  const restart = (): void => setJob({ from: null })
  const resume = (from: BlameCursor): void => setJob({ from })

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
      ...(job.from !== null ? { resume: job.from } : {}),
      onProgress: (p) => {
        last = p
        if (current() && !stop.signal.aborted) setRun({ kind: 'running', progress: p })
      },
    }).then(
      (result) => current() && setRun({ kind: 'done', result }),
      (error: unknown) =>
        current() &&
        setRun(
          stop.signal.aborted
            ? { kind: 'cancelled', progress: last, partial: error instanceof BlameStoppedError ? error.partial : null }
            : { kind: 'failed', error },
        ),
    )
    return () => {
      // Unmount or a new run: stop this one without it reporting (Cancel aborts while it is current).
      if (stopRef.current === stop) stopRef.current = null
      stop.abort()
    }
  }, [reader, tipOid, path, job])

  if (run.kind === 'failed') {
    if (run.error instanceof BlameRefusedError) return <EmptyState icon={FileText} title="Can't blame this file" body={run.error.message} />
    // Retry runs the same job again: a failed continuation keeps the walk it was continuing.
    return <ReadErrorState cause={run.error} retry={() => setJob((j) => ({ ...j }))} addr={addr} repo={repo} />
  }
  if (run.kind === 'cancelled' && run.partial !== null) {
    // Cancel keeps what was worked out (L-23): the table, marked stopped, and a way to run again.
    return <BlameTable result={run.partial} name={path} addr={addr} permalink={permalink} onRestart={restart} onContinue={resume} />
  }
  if (run.kind === 'cancelled') {
    return (
      <EmptyState
        icon={History}
        title="Blame stopped"
        body={
          run.progress
            ? `Stopped after examining ${plural(run.progress.examined, 'commit')}, before any version was found.`
            : 'Stopped before any commit was examined.'
        }
        action={<Button onClick={restart}>Start again</Button>}
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
            : p.versions === 0
              ? `Looking for the file’s versions · ${plural(p.examined, 'commit')} examined`
              : `Compared ${plural(p.versions, 'version')} of up to ${p.versionLimit} · ${plural(p.total - p.pending, 'line')} of ${p.total} attributed · ${plural(p.examined, 'commit')} examined`}
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
  return <BlameTable result={run.result} name={path} addr={addr} permalink={permalink} onContinue={resume} />
}

/**
 * The commit cell of lines the walk has not attributed (QW-005): the version it stopped at is a
 * bound ("this or older"), never shown as their commit. With a cursor, it continues the walk.
 */
function UnresolvedCell({ oid, onContinue }: { oid: string; onContinue: (() => void) | undefined }): JSX.Element {
  const short = oid.slice(0, 7)
  const title = `Not attributed yet: last changed by ${short} or an older commit. The walk stopped at ${short}’s version of the file${onContinue ? '; click to continue it' : ''}.`
  const text = (
    <>
      <span className="shrink-0 sm:hidden">older</span>
      <span className="hidden min-w-0 truncate sm:inline">
        Not attributed yet: <span className="font-mono">{short}</span> or older
      </span>
    </>
  )
  const cls = 'flex min-w-0 items-center gap-2 italic text-caution-700 dark:text-caution-400'
  return onContinue ? (
    // One per unattributed hunk, inside a 20 px code row (exempt, as the commit links are).
    <button type="button" onClick={onContinue} className={cn(cls, 'hover:underline')} title={title} data-tap-exempt="code-line" data-testid="blame-unresolved" tabIndex={-1}>
      {text}
    </button>
  ) : (
    <span className={cls} title={title} data-testid="blame-unresolved">
      {text}
    </span>
  )
}

/** Why the walk stopped short, for the summary line. */
function stopReason(result: BlameResult): string {
  switch (result.boundary?.reason) {
    case 'stopped':
      return 'Stopped'
    case 'versions':
      return `The walk stopped after ${plural(result.versions, 'version')} of the file`
    case 'commits':
      return `The walk stopped after examining ${BLAME_MAX_COMMITS.toLocaleString('en-US')} commits`
    case 'rename':
      return 'The walk reached the commit that added this path, a change too large to check for a rename here'
    default:
      return 'Partial'
  }
}

/** The code cell, as the file view's. */
const CODE_CELL = 'whitespace-pre px-4 py-0 align-top text-anvil-800 dark:text-anvil-200'

/** `lines` highlighted for a file named `name` (one HTML string per line), or null until ready or when it stays plain. */
function useHighlightedLines(lines: readonly string[], name: string): readonly string[] | null {
  const [highlighted, setHighlighted] = useState<{ readonly of: readonly string[]; readonly lines: readonly string[] } | null>(null)
  useEffect(() => {
    let active = true
    void highlightBlob(lines.join('\n'), name).then((h) => {
      if (active && h !== null && h.lines.length === lines.length) setHighlighted({ of: lines, lines: h.lines })
    })
    return () => {
      active = false
    }
  }, [lines, name])
  return highlighted !== null && highlighted.of === lines ? highlighted.lines : null
}

export function BlameTable({
  result,
  name = '',
  addr,
  permalink,
  onRestart,
  onContinue,
}: {
  result: BlameResult
  /** The file's name, for its highlighting (none: highlight.js guesses, or leaves it plain). */
  name?: string
  addr: RepoAddress
  permalink: string | null
  /** Run the blame again from the start (offered when it was cancelled). */
  onRestart?: () => void
  /** Go on from where a partial walk stopped ({@link BlameResult.cursor}). */
  onContinue?: (from: BlameCursor) => void
}): JSX.Element {
  const { lines, hunks, commits, boundary, cursor } = result
  const stopped = boundary?.reason === 'stopped'
  // The commits that own lines: the boundary's, where lines are only unresolved, is not one of them.
  const owning = useMemo(() => new Set(hunks.filter((h) => h.unresolved !== true).map((h) => h.oid)).size, [hunks])
  const oldest = boundary === null ? undefined : commits.get(boundary.oid)
  // The hunk each line is in, and whether it starts one (where the commit cell is drawn).
  const hunkOf = useMemo(() => {
    const at = new Int32Array(lines.length)
    hunks.forEach((h, k) => at.fill(k, h.start - 1, h.start - 1 + h.count))
    return at
  }, [lines.length, hunks])
  const tableRef = useRef<HTMLTableElement>(null)
  const { from, to } = useRowWindow(tableRef, lines.length)
  // The `#L` selection, kept as the file view keeps it: from the URL (scrolled to), or a click.
  const [range, select] = useLineSelection(lines.length, (r) => {
    requestAnimationFrame(() => scrollToRow(tableRef.current, r.start))
  })
  const href = permalink === null || range === null ? permalink : `${permalink}#${lineHash(range)}`
  // Up/Down (Home/End) move between the hunks' commit links.
  const onCommitKey = (e: React.KeyboardEvent<HTMLTableElement>): void => {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
    const t = e.target
    if (!(t instanceof HTMLAnchorElement) || t.dataset['testid'] !== 'blame-commit') return
    const links = [...e.currentTarget.querySelectorAll<HTMLAnchorElement>('a[data-testid="blame-commit"]')]
    const next = nextRovingIndex(links.length, links.indexOf(t), e.key)
    if (next === null) return
    e.preventDefault()
    links[next]?.focus()
  }
  // The code highlighted as the file view highlights it (QW-060), swapped in once highlight.js loads.
  const plain = useMemo(() => lines.map((l) => l.replace(/\r?\n$/, '')), [lines])
  const hlLines = useHighlightedLines(plain, name)

  const rows: JSX.Element[] = []
  for (let i = from; i < to; i++) {
    const k = hunkOf[i] as number
    const hunk = hunks[k]
    if (hunk === undefined) continue
    const first = hunk.start - 1 === i || i === from
    const commit = commits.get(hunk.oid)
    const on = range !== null && i + 1 >= range.start && i + 1 <= range.end
    const unresolved = hunk.unresolved === true
    rows.push(
      <tr
        key={i}
        id={`L${i + 1}`}
        // An unattributed line names no commit: the version where the walk stopped is only its bound.
        data-oid={unresolved ? undefined : hunk.oid}
        data-unresolved-at={unresolved ? hunk.oid : undefined}
        data-selected={on || undefined}
        className={cn('h-5', k % 2 === 1 && 'bg-anvil-50/60 dark:bg-anvil-900/40', on && 'bg-caution/15', first && i > 0 && 'border-t border-anvil-100 dark:border-anvil-850')}
      >
        <td className="w-20 max-w-[5rem] truncate whitespace-nowrap border-r sm:w-72 sm:max-w-[18rem] border-anvil-100 px-3 py-0 align-top text-[12px] text-anvil-500 dark:border-anvil-850 dark:text-anvil-400">
          {first && unresolved ? (
            <UnresolvedCell oid={hunk.oid} onContinue={cursor !== null && onContinue !== undefined ? () => onContinue(cursor) : undefined} />
          ) : first && commit ? (
            <span className="flex items-center gap-2">
              {/* On a phone the column is an age gutter linking the commit; the subject shows from sm up (L-34). */}
              <Link
                href={repoHref('/repo/commit', addr, { oid: hunk.oid })}
                className="shrink-0 tabular-nums hover:text-forge-800 dark:hover:text-forge-400"
                data-tap-exempt="code-line"
                // The subject beside it is the commit's link (and tab stop); this one is for phones.
                tabIndex={-1}
                aria-label={`Commit ${hunk.oid.slice(0, 7)}: ${commit.subject || '(no message)'}`}
              >
                {timeAgo(commit.author.when)}
              </Link>
              {/* The author, as GitHub's blame names them beside the subject (QW-060). */}
              {commit.author.name ? (
                <span className="hidden max-w-[7rem] shrink-0 truncate font-medium text-anvil-700 sm:inline dark:text-anvil-200" data-testid="blame-author" title={commit.author.name}>
                  {commit.author.name}
                </span>
              ) : null}
              {/* One per hunk, inside a 20 px code row (e2e/mobile.spec.ts exempts it, as the diff gutter). */}
              {/* One tab stop for the column (the window's top hunk), the arrow keys move between
                  hunks: a tab stop per hunk packed 20 px tab stops together (axe target-size,
                  WCAG 2.5.8) and put hundreds of stops between the toolbar and the page's end. */}
              <Link
                href={repoHref('/repo/commit', addr, { oid: hunk.oid })}
                className="hidden min-w-0 truncate hover:text-forge-800 sm:inline dark:hover:text-forge-400"
                title={`${hunk.oid.slice(0, 7)} ${commit.author.name}`}
                tabIndex={i === from ? 0 : -1}
                data-tap-exempt="code-line"
                data-testid="blame-commit"
              >
                {commit.subject || '(no message)'}
              </Link>
            </span>
          ) : null}
        </td>
        <td className="select-none whitespace-nowrap px-3 py-0 text-right align-top text-anvil-500 dark:text-anvil-400">
          <a
            href={`#L${i + 1}`}
            // Not a tab stop per line, and one per code line (e2e/mobile.spec.ts exempts it).
            tabIndex={-1}
            data-tap-exempt="code-line"
            onClick={(e) => {
              if (e.metaKey || e.ctrlKey) return
              e.preventDefault()
              select(selectLine(range, i + 1, e.shiftKey))
            }}
            className="hover:text-anvil-800 dark:hover:text-anvil-100"
          >
            {i + 1}
          </a>
        </td>
        {hlLines ? (
          // highlight.js escapes all text and emits only class-bearing spans.
          <td className={CODE_CELL} dangerouslySetInnerHTML={{ __html: hlLines[i] || ' ' }} />
        ) : (
          <td className={CODE_CELL}>{plain[i] || ' '}</td>
        )}
      </tr>,
    )
  }

  return (
    <div className="overflow-hidden rounded-lg border border-anvil-200 dark:border-anvil-800">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-anvil-200 bg-anvil-50 px-4 py-2 text-[12px] text-anvil-500 dark:border-anvil-800 dark:bg-anvil-900 dark:text-anvil-400" data-testid="blame-summary">
        <span>
          {plural(lines.length, 'line')} · {plural(owning, 'commit')} · {plural(result.versions, 'version')} compared
        </span>
        {boundary !== null ? (
          <span className="text-caution-700 dark:text-caution-400" data-testid={stopped ? 'blame-stopped' : 'blame-partial'}>
            {stopReason(result)}: {plural(boundary.lines, 'line')} {boundary.lines === 1 ? 'is' : 'are'} not attributed{cursor !== null ? ' yet' : ''}.{' '}
            {boundary.lines === 1 ? 'It was' : 'They were'} {boundary.reason === 'rename' ? 'added by' : 'last changed by'}{' '}
            <span className="font-mono">{boundary.oid.slice(0, 7)}</span>
            {oldest ? ` (${formatDate(oldest.author.when)})` : ''} {boundary.reason === 'rename' ? 'or came from a file it renamed; git blame knows which.' : 'or an older commit.'}{' '}
            {cursor !== null && onContinue !== undefined ? (
              <Button size="sm" onClick={() => onContinue(cursor)} data-testid="blame-continue" title={`Compare up to ${BLAME_MAX_VERSIONS} more versions of the file`}>
                Continue blame
              </Button>
            ) : null}{' '}
            {stopped && onRestart !== undefined ? (
              <button type="button" onClick={onRestart} className="font-medium underline">
                Run again
              </button>
            ) : null}
          </span>
        ) : null}
        {result.approximate ? <span className="text-caution-700 dark:text-caution-400">Some changes were too large to align line by line.</span> : null}
        {result.renames.map((r) => (
          <span key={r.commit}>
            Followed a rename from <span className="font-mono">{r.from}</span>
          </span>
        ))}
      </div>
      <p className="border-b border-anvil-100 px-4 py-1.5 text-[11px] text-anvil-500 dark:border-anvil-850 dark:text-anvil-400" data-testid="blame-caveat">
        Computed in your browser from the file’s history. It can attribute some lines differently from{' '}
        <span className="font-mono">git blame</span> (lines that repeat and move); <span className="font-mono">git blame --first-parent</span> is the
        authoritative answer.
      </p>
      <BlobToolbar href={href}>
        {range ? <span>{range.start === range.end ? `Line ${range.start}` : `Lines ${range.start}–${range.end}`} selected</span> : null}
      </BlobToolbar>
      <ScrollRegion label="Blame" className="overflow-x-auto">
        <table ref={tableRef} className="hljs w-full border-collapse bg-transparent font-mono text-[13px] leading-5" data-lines={lines.length} data-testid="blame-table" onKeyDown={onCommitKey}>
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
