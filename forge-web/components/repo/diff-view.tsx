'use client'

/**
 * DiffView — a change set rendered as reviewable patches, shared by the commit, PR and compare views.
 *
 * A file list with per-file +/- counts, then one collapsible patch per file. Everything is
 * bounded so a huge change cannot freeze the tab: patches load {@link FILE_PAGE} files at a
 * time (a "show more" button loads the next page), each file renders {@link LINE_PAGE} rows
 * before offering the rest, and binary, oversized, submodule and unreadable files get a
 * placeholder saying why rather than a diff. Callers key this component by the comparison so
 * a new one starts from a clean slate.
 *
 * The header's +/- totals cover the whole change or are not shown (L-25): up to
 * {@link AUTO_COUNT} files are counted as soon as the view opens, a bigger change on request.
 * A renamed file is one row, old path → new path (L-24). "⋯ N unchanged lines" expands (L-69).
 * Hide whitespace is kept in the URL as `?w=1` (L-71), falling back to the reader's preference.
 */

import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { createContext, Fragment, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight, FileDiff } from 'lucide-react'
import {
  diffTotals,
  loadFilePatch,
  mapPooled,
  modeString,
  plural,
  type DiffSides,
  type FileChange,
  type FilePatch,
  type TextDiffLine,
} from '@/lib/view'
import { compactDiffLines, DIFF_CONTEXT, EXPAND_STEP, expandGap, splitRows, type DiffGap, type Revealed } from '@/lib/view/text-diff'
import { createBatcher } from '@/lib/view/batcher'
import { DIFF_PALETTES, type DiffPalette } from '@/lib/view/prefs'
import { lineKey } from '@/lib/view/inline-threads'
import { useMinWidth, usePrefs } from '@/hooks/use-prefs'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/states'
import { ScrollRegion } from '@/components/ui/scroll-region'
import { cn } from '@/lib/utils'

/**
 * Inline comments on a diff (the PR view provides this; a commit diff has none): what to show
 * under a line, and how to start a comment on one. `side` is 0 for the old file, 1 for the new.
 */
export interface InlineComments {
  render(path: string, side: 0 | 1, line: number): ReactNode | null
  /** Whether this reader may start a comment (a private repo it cannot write to: no). */
  readonly canComment: boolean
  /**
   * Start a comment on a line; `extend` (shift-click) makes it a range from the line picked
   * before, on the same file and side (review-parity §4.2).
   */
  start(path: string, side: 0 | 1, line: number, extend?: boolean): void
  /** How a line is marked: the selected range, a commented range, or nothing. */
  mark?(path: string, side: 0 | 1, line: number): 'selected' | 'range' | null
  /** Told which lines a file's patch shows (`lineKey`s), or null once it shows none. */
  report(path: string, keys: ReadonlySet<string> | null): void
}

export const InlineCommentsContext = createContext<InlineComments | null>(null)

/** Files whose patches load per page. */
const FILE_PAGE = 25
/** A change set of at most this many files has its lines counted as it opens; a bigger one on request. */
const AUTO_COUNT = 100
/** Rows a file renders before a "show more lines" button. */
const LINE_PAGE = 400
/** Patch reads in flight at once. */
const PATCH_CONCURRENCY = 4
/** Finished patches are committed to state in batches at most this often (ms). */
const PATCH_FLUSH_MS = 100

/**
 * A changed file's A / M / D letter. Added and deleted take the diff palette's marker colors
 * (AA-checked in `lib/design/contrast.test.ts`), so the color-blind palette recolors them too.
 */
function statusMeta(status: FileChange['status'], palette: DiffPalette): { label: string; klass: string } {
  if (status === 'added') return { label: 'A', klass: DIFF_PALETTES[palette].added.marker }
  if (status === 'deleted') return { label: 'D', klass: DIFF_PALETTES[palette].deleted.marker }
  if (status === 'renamed') return { label: 'R', klass: 'text-anvil-600 dark:text-anvil-300' }
  return { label: 'M', klass: 'text-caution-700 dark:text-caution-400' }
}

/** A change's status for its letter's tooltip: `renamed (87% similar)`. */
const statusTitle = (c: FileChange): string => (c.status === 'renamed' ? `renamed (${c.similarity ?? 100}% similar)` : c.status)

/** A change's path as shown: `old → new` for a rename. */
function ChangePath({ change }: { change: FileChange }): JSX.Element {
  if (change.status !== 'renamed' || change.oldPath === undefined) return <>{change.path}</>
  return (
    <>
      <span className="text-anvil-500 dark:text-anvil-400">{change.oldPath}</span> → {change.path}
    </>
  )
}

/**
 * Hide whitespace: `?w=1` / `?w=0` when the URL says, else the reader's preference. Setting it
 * writes both (`w=0` too), so a copied link shows what its sender saw (L-71).
 */
function useIgnoreWhitespace(): [boolean, (on: boolean) => void] {
  const [prefs, update] = usePrefs()
  const params = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const w = params.get('w')
  const on = w === '1' || (w !== '0' && prefs.ignoreWhitespace)
  const set = (next: boolean): void => {
    update({ ignoreWhitespace: next })
    const q = new URLSearchParams(params.toString())
    q.set('w', next ? '1' : '0')
    router.replace(`${pathname}?${q.toString()}${window.location.hash}`, { scroll: false })
  }
  return [on, set]
}

const anchorId = (index: number): string => `diff-file-${index}`

export function DiffView({
  sides,
  changes,
  truncated,
  fileHref,
  renameLimit = null,
}: {
  sides: DiffSides
  changes: readonly FileChange[]
  /** The tree comparison stopped at its node cap, so `changes` is incomplete. */
  truncated: boolean
  /** Where a file's path links (omit for no links). Not called for deleted files. */
  fileHref?: (path: string) => string
  /** Why renames with edits may not be shown (`TreeDiff.renameLimit`). */
  renameLimit?: string | null | undefined
}): JSX.Element {
  const [shown, setShown] = useState(Math.min(FILE_PAGE, changes.length))
  const [{ palette }] = usePrefs()
  const [ignoreWhitespace, setIgnoreWhitespace] = useIgnoreWhitespace()
  // Every file's patch is loaded to count the totals: at once for a small change, on request for a big one.
  const [countAll, setCountAll] = useState(changes.length <= AUTO_COUNT)
  // Patches are keyed by mode + path: toggling whitespace loads the other mode's patches
  // without discarding these (toggling back is instant).
  const keyOf = (path: string): string => `${ignoreWhitespace ? 'w' : 'x'}:${path}`
  const [loaded, setPatches] = useState<ReadonlyMap<string, FilePatch>>(() => new Map())
  const patches = { get: (path: string): FilePatch | undefined => loaded.get(keyOf(path)) }
  const [scrollTo, setScrollTo] = useState<number | null>(null)
  const requested = useRef(new Set<string>())
  // Patches land one by one; committing each would re-render the whole list per file. The
  // batcher owns its pending map, so a patch that lands after a flush is never written into
  // an already-committed batch (D-005: files stuck on "Reading file…" with nothing in flight).
  const [batcher] = useState(() =>
    createBatcher<string, FilePatch>(PATCH_FLUSH_MS, (batch) => setPatches((prev) => new Map([...prev, ...batch]))),
  )
  // Flush rather than drop on cleanup: a Fast Refresh remount keeps `requested`, so a dropped
  // patch would never be asked for again.
  useEffect(() => () => batcher.flush(), [batcher])

  useEffect(() => {
    const key = (path: string): string => `${ignoreWhitespace ? 'w' : 'x'}:${path}`
    const todo = (countAll ? changes : changes.slice(0, shown)).filter((c) => !requested.current.has(key(c.path)))
    for (const c of todo) requested.current.add(key(c.path))
    void mapPooled(todo, PATCH_CONCURRENCY, async (change) => {
      // loadFilePatch turns read failures into placeholders; anything else must still settle
      // the file, or it would sit on "Reading file…" with its key already requested.
      const patch = await loadFilePatch(sides, change, { ignoreWhitespace }).catch(
        (e: unknown): FilePatch => ({ kind: 'placeholder', change, reason: 'unreadable', note: e instanceof Error ? e.message : String(e) }),
      )
      batcher.add(key(change.path), patch)
    })
  }, [changes, shown, countAll, sides, ignoreWhitespace, batcher])

  // Jump to a file picked from the list once it has rendered (it may be past `shown`).
  useEffect(() => {
    if (scrollTo === null || scrollTo >= shown) return
    document.getElementById(anchorId(scrollTo))?.scrollIntoView({ block: 'start' })
    setScrollTo(null)
  }, [scrollTo, shown])

  const totals = diffTotals(changes, (c) => patches.get(c.path))

  if (changes.length === 0) {
    return (
      <div className="rounded-lg border border-anvil-200 px-4 py-6 text-center text-dense text-anvil-500 dark:border-anvil-800 dark:text-anvil-400">
        No file changes.
      </div>
    )
  }

  // A size skip taken from the (unverified) browse index can be overridden: download the
  // blobs and let the measured size decide.
  const loadAnyway = (change: FileChange): void => {
    const key = keyOf(change.path)
    setPatches((prev) => {
      const next = new Map(prev)
      next.delete(key)
      return next
    })
    void loadFilePatch(sides, change, { ignoreSizeHint: true, ignoreWhitespace }).then((patch) =>
      setPatches((prev) => new Map(prev).set(key, patch)),
    )
  }

  const pick = (index: number): void => {
    if (index >= shown) setShown(Math.min(changes.length, Math.ceil((index + 1) / FILE_PAGE) * FILE_PAGE))
    setScrollTo(index)
  }

  return (
    <div className="space-y-3">
      <DiffToolbar ignoreWhitespace={ignoreWhitespace} setIgnoreWhitespace={setIgnoreWhitespace} />
      <details open={changes.length <= FILE_PAGE} className="group rounded-lg border border-anvil-200 dark:border-anvil-800">
        <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 px-3 py-2 text-dense coarse:min-h-11 [&::-webkit-details-marker]:hidden">
          <ChevronRight className="h-3.5 w-3.5 text-anvil-500 dark:text-anvil-400 transition-transform group-open:rotate-90" aria-hidden />
          <FileDiff className="h-3.5 w-3.5 text-anvil-500 dark:text-anvil-400" aria-hidden />
          <span className="font-medium">
            {plural(truncated ? `${changes.length.toLocaleString('en-US')}+` : changes.length, 'file')} changed
          </span>
          {totals.pending === 0 ? (
            <span className="flex items-center gap-2" data-testid="diff-totals">
              <DiffStat added={totals.added} deleted={totals.deleted} />
              {truncated ? <span className="text-[12px] text-anvil-500 dark:text-anvil-400">in the {plural(changes.length, 'listed file')}</span> : null}
              {totals.uncounted > 0 ? (
                <span className="text-[12px] text-anvil-500 dark:text-anvil-400">{plural(totals.uncounted, 'file')} not counted</span>
              ) : null}
            </span>
          ) : countAll ? (
            <span className="text-[12px] text-anvil-500 dark:text-anvil-400" data-testid="diff-totals-pending">
              counting lines: {(changes.length - totals.pending).toLocaleString('en-US')} of {plural(changes.length, 'file')}
            </span>
          ) : (
            <button
              type="button"
              className="rounded px-1.5 text-[12px] font-medium text-forge-700 underline underline-offset-2 hover:text-forge-800 coarse:min-h-11 dark:text-forge-400 dark:hover:text-forge-300"
              data-testid="count-lines"
              onClick={(e) => {
                // Inside the summary: count, without also folding the file list.
                e.preventDefault()
                setCountAll(true)
              }}
            >
              Count lines in all {plural(changes.length, 'file')}
            </button>
          )}
        </summary>
        <ul className="max-h-80 overflow-y-auto border-t border-anvil-200 dark:border-anvil-800">
          {changes.map((c, index) => {
            const meta = statusMeta(c.status, palette)
            const p = patches.get(c.path)
            return (
              <li key={c.path}>
                <button
                  type="button"
                  onClick={() => pick(index)}
                  className="flex w-full items-center gap-3 px-3 py-1 text-left text-dense hover:bg-anvil-50 coarse:min-h-11 dark:hover:bg-anvil-850"
                >
                  <span className={cn('w-4 shrink-0 text-center font-mono font-semibold', meta.klass)} title={statusTitle(c)}>
                    {meta.label}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono">
                    <ChangePath change={c} />
                  </span>
                  {p?.kind === 'text' ? <DiffStat added={p.added} deleted={p.deleted} /> : null}
                  {p?.kind === 'placeholder' ? <span className="text-[12px] text-anvil-500 dark:text-anvil-400">{p.reason}</span> : null}
                </button>
              </li>
            )
          })}
        </ul>
      </details>

      {renameLimit != null ? (
        <p className="text-[12px] text-anvil-500 dark:text-anvil-400" data-testid="rename-limit">
          {renameLimit}
        </p>
      ) : null}

      {truncated ? (
        <p className="rounded-md border border-caution/30 bg-caution/5 px-3 py-2 text-dense text-anvil-600 dark:text-anvil-300">
          This comparison is too large to list completely: {changes.length} changed files are listed, and others
          (mostly deeper in the tree) are not. Clone the repo to see the rest.
        </p>
      ) : null}

      {changes.slice(0, shown).map((change, index) => (
        <FilePatchView
          key={change.path}
          id={anchorId(index)}
          change={change}
          patch={patches.get(change.path)}
          href={fileHref && change.status !== 'deleted' ? fileHref(change.path) : undefined}
          onLoadAnyway={() => loadAnyway(change)}
          ignoreWhitespace={ignoreWhitespace}
        />
      ))}

      {shown < changes.length ? (
        <div className="flex items-center justify-center gap-3 py-2">
          <span className="text-dense text-anvil-500 dark:text-anvil-400">
            Showing {shown.toLocaleString('en-US')} of {plural(changes.length, 'file')}
          </span>
          <Button size="sm" onClick={() => setShown((n) => Math.min(changes.length, n + FILE_PAGE))}>
            Show {plural(Math.min(FILE_PAGE, changes.length - shown), 'more file')}
          </Button>
        </div>
      ) : null}
    </div>
  )
}

function DiffStat({ added, deleted }: { added: number; deleted: number }): JSX.Element {
  const [{ palette }] = usePrefs()
  const p = DIFF_PALETTES[palette]
  return (
    <span className="shrink-0 font-mono text-[12px]">
      <span className={p.added.marker}>+{added}</span> <span className={p.deleted.marker}>−{deleted}</span>
    </span>
  )
}

/** Layout, whitespace and palette switches; remembered in this browser (whitespace also in the URL). */
function DiffToolbar({ ignoreWhitespace, setIgnoreWhitespace }: { ignoreWhitespace: boolean; setIgnoreWhitespace: (on: boolean) => void }): JSX.Element {
  const [prefs, update] = usePrefs()
  const wide = useMinWidth(1024)
  const toggle = (label: string, pressed: boolean, onClick: () => void, title?: string): JSX.Element => (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      title={title}
      className={cn(
        'rounded px-2 py-1 text-[12px] font-medium transition-colors coarse:min-h-11',
        pressed ? 'bg-anvil-200 text-anvil-900 dark:bg-anvil-750 dark:text-anvil-50' : 'text-anvil-600 hover:text-anvil-900 dark:text-anvil-400 dark:hover:text-anvil-100',
      )}
    >
      {label}
    </button>
  )
  return (
    <div role="toolbar" aria-label="Diff display" className="flex flex-wrap items-center gap-1">
      {wide ? (
        <div className="inline-flex rounded-md border border-anvil-200 p-0.5 dark:border-anvil-750">
          {toggle('Split', prefs.diffLayout === 'split', () => update({ diffLayout: 'split' }), 'Side by side')}
          {toggle('Unified', prefs.diffLayout === 'unified', () => update({ diffLayout: 'unified' }))}
        </div>
      ) : null}
      <div className="inline-flex rounded-md border border-anvil-200 p-0.5 dark:border-anvil-750">
        {toggle('Hide whitespace', ignoreWhitespace, () => setIgnoreWhitespace(!ignoreWhitespace), 'Compare lines ignoring whitespace (git diff -w)')}
      </div>
      <div className="inline-flex rounded-md border border-anvil-200 p-0.5 dark:border-anvil-750">
        {toggle('Blue/orange', prefs.palette === 'colorblind', () => update({ palette: prefs.palette === 'colorblind' ? 'standard' : 'colorblind' }), 'Color-blind friendly diff colors')}
      </div>
    </div>
  )
}

function FilePatchView({
  id,
  change,
  patch,
  href,
  onLoadAnyway,
  ignoreWhitespace,
}: {
  id: string
  change: FileChange
  patch: FilePatch | undefined
  href: string | undefined
  onLoadAnyway: () => void
  ignoreWhitespace: boolean
}): JSX.Element {
  // Deleted files start collapsed: their patch is the whole old file in red.
  const [open, setOpen] = useState(change.status !== 'deleted')
  const [{ palette }] = usePrefs()
  const meta = statusMeta(change.status, palette)
  const modeChanged =
    change.baseMode !== null && change.headMode !== null && change.baseMode !== change.headMode

  return (
    <div id={id} className="scroll-mt-4 overflow-hidden rounded-lg border border-anvil-200 dark:border-anvil-800">
      <div className="flex items-center gap-2 bg-anvil-50 px-3 py-2 text-dense coarse:min-h-11 coarse:py-0 dark:bg-anvil-900">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-label={`${open ? 'Collapse' : 'Expand'} ${change.path}`}
          className="rounded p-0.5 text-anvil-500 dark:text-anvil-400 hover:bg-anvil-200 hover:text-anvil-700 coarse:-ml-3 coarse:p-3.5 dark:hover:bg-anvil-800 dark:hover:text-anvil-200"
        >
          {open ? <ChevronDown className="h-4 w-4" aria-hidden /> : <ChevronRight className="h-4 w-4" aria-hidden />}
        </button>
        <span className={cn('w-4 shrink-0 text-center font-mono font-semibold', meta.klass)} title={statusTitle(change)}>
          {meta.label}
        </span>
        {href ? (
          <Link href={href} className="min-w-0 flex-1 truncate font-mono hover:text-forge-800 coarse:py-3 dark:hover:text-forge-400">
            <ChangePath change={change} />
          </Link>
        ) : (
          <span className="min-w-0 flex-1 truncate font-mono">
            <ChangePath change={change} />
          </span>
        )}
        {modeChanged ? (
          <span className="shrink-0 font-mono text-[12px] text-anvil-500 dark:text-anvil-400">
            {modeString(change.baseMode as number)} → {modeString(change.headMode as number)}
          </span>
        ) : null}
        {patch?.kind === 'text' ? <DiffStat added={patch.added} deleted={patch.deleted} /> : null}
      </div>
      {open ? (
        <div className="border-t border-anvil-200 dark:border-anvil-800">
          {patch === undefined ? (
            <div className="px-4 py-4">
              <Spinner label="Reading file" />
            </div>
          ) : patch.kind === 'placeholder' ? (
            <div className="flex flex-wrap items-center gap-3 px-4 py-4">
              <p className="text-dense text-anvil-500 dark:text-anvil-400">{patch.note}</p>
              {patch.unverifiedSize ? (
                <Button size="sm" variant="ghost" onClick={onLoadAnyway}>
                  Download and check
                </Button>
              ) : null}
            </div>
          ) : patch.full.length === 0 ? (
            <p className="px-4 py-4 text-dense text-anvil-500 dark:text-anvil-400">Empty file.</p>
          ) : ignoreWhitespace && patch.added + patch.deleted === 0 && change.status !== 'added' && change.status !== 'deleted' ? (
            <p className="px-4 py-4 text-dense text-anvil-500 dark:text-anvil-400" data-testid="whitespace-only">
              Only whitespace changed in this file. Turn off Hide whitespace to see it.
            </p>
          ) : (
            // Keyed by mode: expanded ranges index one mode's lines, never the other's.
            <PatchLines key={ignoreWhitespace ? 'w' : 'x'} path={change.path} oldPath={change.oldPath} full={patch.full} />
          )}
        </div>
      ) : null}
    </div>
  )
}

/** Line numbers and markers on tinted rows: AA on both themes (see `contrast.test.ts`). */
const GUTTER = 'w-12 select-none border-r border-anvil-100 px-2 text-right align-top text-anvil-600 dark:border-anvil-850 dark:text-anvil-400'

function lineTint(kind: TextDiffLine['kind'] | null, palette: DiffPalette): string {
  if (kind === 'added') return DIFF_PALETTES[palette].added.row
  if (kind === 'deleted') return DIFF_PALETTES[palette].deleted.row
  return ''
}

function Marker({ kind, palette }: { kind: TextDiffLine['kind']; palette: DiffPalette }): JSX.Element {
  const p = DIFF_PALETTES[palette]
  if (kind === 'added') return <span className={cn('select-none font-semibold', p.added.marker)}>+</span>
  if (kind === 'deleted') return <span className={cn('select-none font-semibold', p.deleted.marker)}>−</span>
  return <span className="select-none"> </span>
}

function LineText({ line }: { line: TextDiffLine }): JSX.Element {
  return (
    <>
      {line.text || ' '}
      {line.noNewline ? <span className="ml-2 select-none font-sans text-anvil-600 dark:text-anvil-400">(no newline at end of file)</span> : null}
    </>
  )
}

/** A line number that, in a PR, opens an inline comment on that line. */
function LineNumber({ path, side, line }: { path: string; side: 0 | 1; line: number | null }): JSX.Element {
  const inline = useContext(InlineCommentsContext)
  if (line === null) return <td className={GUTTER} />
  const mark = inline?.mark?.(path, side, line) ?? null
  const tint = mark === 'selected' ? 'bg-forge-500/25' : mark === 'range' ? 'bg-caution/15' : ''
  if (inline === null || !inline.canComment) return <td className={cn(GUTTER, tint)}>{line}</td>
  return (
    <td className={cn(GUTTER, 'p-0', tint)} data-mark={mark ?? undefined}>
      {/* One per code line, so as tall as the line: 44px rows would halve what a phone shows of
          the diff. The whole gutter cell is the target (e2e/mobile.spec.ts exempts it). */}
      <button
        type="button"
        onClick={(e) => inline.start(path, side, line, e.shiftKey)}
        aria-label={`Comment on ${side === 1 ? 'new' : 'old'} line ${line} of ${path}`}
        title="Click to comment; shift-click another line to comment on the range"
        data-tap-exempt="code-line"
        className="w-full px-2 text-right hover:bg-forge-500/15 hover:text-anvil-900 dark:hover:text-anvil-50"
      >
        {line}
      </button>
    </td>
  )
}

/** The inline threads (and an open composer) under a row, if any. */
function ThreadRow({ pathOf, keys, colSpan }: { pathOf: (side: 0 | 1) => string; keys: readonly (readonly [0 | 1, number | null])[]; colSpan: number }): JSX.Element | null {
  const inline = useContext(InlineCommentsContext)
  if (inline === null) return null
  const parts = keys.filter((k): k is readonly [0 | 1, number] => k[1] !== null).map(([side, line]) => inline.render(pathOf(side), side, line)).filter((n) => n !== null)
  if (parts.length === 0) return null
  return (
    <tr>
      <td colSpan={colSpan} className="border-y border-anvil-200 bg-anvil-50 p-0 font-sans text-dense dark:border-anvil-800 dark:bg-anvil-900">
        {/* As wide as the visible diff, not the (scrolling) table: a thread under a long line
            stays readable on a phone without scrolling sideways. */}
        <div className="sticky left-0 w-[100cqw] max-w-full px-3 py-2">{parts}</div>
      </td>
    </tr>
  )
}

/** The controls of a "⋯ N unchanged lines" row (L-69): 20 more from either side, or all of it. */
function GapRow({ gap, colSpan, total, onExpand }: { gap: DiffGap; colSpan: number; total: number; onExpand: (range: readonly [number, number]) => void }): JSX.Element {
  const leading = gap.from === 0
  const trailing = gap.from + gap.hidden === total
  const btn = (how: 'up' | 'down' | 'all', text: string, label: string): JSX.Element => (
    <button
      type="button"
      onClick={() => onExpand(expandGap(gap, how))}
      aria-label={label}
      className="rounded px-1.5 font-sans font-medium text-forge-700 hover:bg-forge-500/10 coarse:min-h-11 dark:text-forge-400"
    >
      {text}
    </button>
  )
  const small = gap.hidden <= EXPAND_STEP
  return (
    <tr className="bg-dash/5 text-anvil-600 dark:text-anvil-400" data-testid="diff-gap">
      <td colSpan={colSpan} className="px-3 py-0.5">
        <span className="sticky left-3 inline-flex flex-wrap items-center gap-1">
          {small ? (
            btn('all', `⋯ Show ${plural(gap.hidden, 'unchanged line')}`, `Show ${plural(gap.hidden, 'unchanged line')}`)
          ) : (
            <>
              <span>⋯ {plural(gap.hidden, 'unchanged line')}</span>
              {!leading ? btn('down', `↓ ${EXPAND_STEP}`, `Show ${EXPAND_STEP} more unchanged lines after the change above`) : null}
              {!trailing ? btn('up', `↑ ${EXPAND_STEP}`, `Show ${EXPAND_STEP} more unchanged lines before the change below`) : null}
              {btn('all', 'Show all', `Show all ${plural(gap.hidden, 'unchanged line')}`)}
            </>
          )}
        </span>
      </td>
    </tr>
  )
}

/**
 * A text patch's rows. A renamed file's old side is its old path: inline comments on it anchor
 * there (as they did when the file showed as deleted), and its new side at its new path.
 */
function PatchLines({ path, oldPath = path, full }: { path: string; oldPath?: string | undefined; full: readonly TextDiffLine[] }): JSX.Element {
  const [limit, setLimit] = useState(LINE_PAGE)
  const [revealed, setRevealed] = useState<Revealed>([])
  const lines = useMemo(() => compactDiffLines(full, DIFF_CONTEXT, revealed), [full, revealed])
  const pathOf = (side: 0 | 1): string => (side === 0 ? oldPath : path)
  const expand = (range: readonly [number, number]): void => setRevealed((r) => [...r, range])
  const inline = useContext(InlineCommentsContext)
  // Report the rows on screen (not past the "show more" cut), and withdraw them on unmount
  // (a collapsed file), so threads under lines nobody can see are listed elsewhere.
  useEffect(() => {
    if (inline === null) return
    const shown = new Map<string, Set<string>>([
      [oldPath, new Set()],
      [path, new Set()],
    ])
    for (const l of lines.slice(0, limit)) {
      if (l.kind === 'gap') continue
      if (l.kind !== 'added' && l.oldLine !== null) shown.get(oldPath)!.add(lineKey(oldPath, 0, l.oldLine))
      if (l.kind !== 'deleted' && l.newLine !== null) shown.get(path)!.add(lineKey(path, 1, l.newLine))
    }
    for (const [p, keys] of shown) inline.report(p, keys)
    return () => {
      for (const p of shown.keys()) inline.report(p, null)
    }
  }, [inline, path, oldPath, lines, limit])
  const [prefs] = usePrefs()
  const wide = useMinWidth(1024)
  const split = wide && prefs.diffLayout === 'split'
  const palette = prefs.palette
  const visible = lines.slice(0, limit)
  const gap = (g: DiffGap, colSpan: number): JSX.Element => <GapRow key={`gap-${g.from}`} gap={g} colSpan={colSpan} total={full.length} onExpand={expand} />
  return (
    <>
      <ScrollRegion label={`Changes to ${path}`} className="overflow-x-auto [container-type:inline-size]">
        <table
          className={cn('w-full border-collapse font-mono text-[12px] leading-5', split && 'table-fixed')}
          aria-label={`Changes to ${path}${split ? ' (side by side)' : ''}`}
          data-layout={split ? 'split' : 'unified'}
        >
          {split ? (
            // A fixed layout takes its widths from the first row; a gap row there (one cell over
            // all four columns) would split them equally (L-29). The gutters are fixed here.
            <colgroup>
              <col className="w-12" />
              <col />
              <col className="w-12" />
              <col />
            </colgroup>
          ) : null}
          <tbody>
            {split
              ? splitRows(visible).map((row, index) => {
                  if (row.kind === 'gap') return gap(row, 4)
                  const { left, right } = row
                  const same = left === right
                  return (
                    <Fragment key={`${left?.oldLine ?? 'n'}-${right?.newLine ?? 'n'}-${index}`}>
                      <tr>
                        <LineNumber path={pathOf(0)} side={0} line={left?.oldLine ?? null} />
                        <td className={cn('overflow-hidden whitespace-pre-wrap break-all px-2 text-anvil-800 dark:text-anvil-200', lineTint(same ? null : left?.kind ?? null, palette), left === null && 'bg-anvil-100 dark:bg-anvil-900')}>
                          {left ? (
                            <>
                              <Marker kind={same ? 'context' : left.kind} palette={palette} /> <LineText line={left} />
                            </>
                          ) : null}
                        </td>
                        <LineNumber path={path} side={1} line={right?.newLine ?? null} />
                        <td className={cn('overflow-hidden whitespace-pre-wrap break-all px-2 text-anvil-800 dark:text-anvil-200', lineTint(same ? null : right?.kind ?? null, palette), right === null && 'bg-anvil-100 dark:bg-anvil-900')}>
                          {right ? (
                            <>
                              <Marker kind={same ? 'context' : right.kind} palette={palette} /> <LineText line={right} />
                            </>
                          ) : null}
                        </td>
                      </tr>
                      <ThreadRow pathOf={pathOf} colSpan={4} keys={[[0, left?.oldLine ?? null], [1, right?.newLine ?? null]]} />
                    </Fragment>
                  )
                })
              : visible.map((line) => {
                  if (line.kind === 'gap') return gap(line, 3)
                  return (
                    <Fragment key={`${line.oldLine ?? 'n'}-${line.newLine ?? 'n'}`}>
                      <tr className={lineTint(line.kind, palette)}>
                        <LineNumber path={pathOf(0)} side={0} line={line.kind === 'added' ? null : line.oldLine} />
                        <LineNumber path={path} side={1} line={line.kind === 'deleted' ? null : line.newLine} />
                        <td className="whitespace-pre px-3 text-anvil-800 dark:text-anvil-200">
                          <Marker kind={line.kind} palette={palette} />
                          <LineText line={line} />
                        </td>
                      </tr>
                      <ThreadRow pathOf={pathOf} colSpan={3} keys={[[0, line.oldLine], [1, line.kind === 'deleted' ? null : line.newLine]]} />
                    </Fragment>
                  )
                })}
          </tbody>
        </table>
      </ScrollRegion>
      {lines.length > limit ? (
        <div className="flex items-center justify-center gap-3 border-t border-anvil-100 py-2 dark:border-anvil-850">
          <span className="text-[12px] text-anvil-500 dark:text-anvil-400">{lines.length - limit} more rows</span>
          <Button size="sm" variant="ghost" onClick={() => setLimit((n) => n + LINE_PAGE * 5)}>
            Show more
          </Button>
        </div>
      ) : null}
    </>
  )
}
