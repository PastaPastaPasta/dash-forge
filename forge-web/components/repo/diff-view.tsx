'use client'

/**
 * DiffView — a change set rendered as reviewable patches, shared by the commit and PR views.
 *
 * A file list with per-file +/- counts, then one collapsible patch per file. Everything is
 * bounded so a huge change cannot freeze the tab: patches load {@link FILE_PAGE} files at a
 * time (a "show more" button loads the next page), each file renders {@link LINE_PAGE} rows
 * before offering the rest, and binary, oversized, submodule and unreadable files get a
 * placeholder saying why rather than a diff. Callers key this component by the comparison so
 * a new one starts from a clean slate.
 */

import Link from 'next/link'
import { createContext, Fragment, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight, FileDiff } from 'lucide-react'
import {
  loadFilePatch,
  mapPooled,
  modeString,
  type CompactDiffLine,
  type DiffSides,
  type FileChange,
  type FilePatch,
  type TextDiffLine,
} from '@/lib/view'
import { splitRows } from '@/lib/view/text-diff'
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
  start(path: string, side: 0 | 1, line: number): void
  /** Told which lines a file's patch shows (`lineKey`s), or null once it shows none. */
  report(path: string, keys: ReadonlySet<string> | null): void
}

export const InlineCommentsContext = createContext<InlineComments | null>(null)

/** Files whose patches load per page. */
const FILE_PAGE = 25
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
  return { label: 'M', klass: 'text-caution-700 dark:text-caution-400' }
}

const anchorId = (index: number): string => `diff-file-${index}`

export function DiffView({
  sides,
  changes,
  truncated,
  fileHref,
}: {
  sides: DiffSides
  changes: readonly FileChange[]
  /** The tree comparison stopped at its node cap, so `changes` is incomplete. */
  truncated: boolean
  /** Where a file's path links (omit for no links). Not called for deleted files. */
  fileHref?: (path: string) => string
}): JSX.Element {
  const [shown, setShown] = useState(Math.min(FILE_PAGE, changes.length))
  const [{ ignoreWhitespace, palette }] = usePrefs()
  // Patches are keyed by mode + path: toggling whitespace loads the other mode's patches
  // without discarding these (toggling back is instant).
  const keyOf = (path: string): string => `${ignoreWhitespace ? 'w' : 'x'}:${path}`
  const [loaded, setPatches] = useState<ReadonlyMap<string, FilePatch>>(() => new Map())
  const patches = { get: (path: string): FilePatch | undefined => loaded.get(keyOf(path)) }
  const current = changes.map((c) => loaded.get(keyOf(c.path))).filter((p): p is FilePatch => p !== undefined)
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
    const todo = changes.slice(0, shown).filter((c) => !requested.current.has(key(c.path)))
    for (const c of todo) requested.current.add(key(c.path))
    void mapPooled(todo, PATCH_CONCURRENCY, async (change) => {
      // loadFilePatch turns read failures into placeholders; anything else must still settle
      // the file, or it would sit on "Reading file…" with its key already requested.
      const patch = await loadFilePatch(sides, change, { ignoreWhitespace }).catch(
        (e: unknown): FilePatch => ({ kind: 'placeholder', change, reason: 'unreadable', note: e instanceof Error ? e.message : String(e) }),
      )
      batcher.add(key(change.path), patch)
    })
  }, [changes, shown, sides, ignoreWhitespace, batcher])

  // Jump to a file picked from the list once it has rendered (it may be past `shown`).
  useEffect(() => {
    if (scrollTo === null || scrollTo >= shown) return
    document.getElementById(anchorId(scrollTo))?.scrollIntoView({ block: 'start' })
    setScrollTo(null)
  }, [scrollTo, shown])

  let added = 0
  let deleted = 0
  let counted = 0
  for (const p of current) {
    if (p.kind !== 'text') continue
    added += p.added
    deleted += p.deleted
    counted += 1
  }
  const textFiles = changes.filter((c) => {
    const p = patches.get(c.path)
    return p === undefined || p.kind === 'text'
  }).length

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
      <DiffToolbar />
      <details open={changes.length <= FILE_PAGE} className="group rounded-lg border border-anvil-200 dark:border-anvil-800">
        <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 px-3 py-2 text-dense coarse:min-h-11 [&::-webkit-details-marker]:hidden">
          <ChevronRight className="h-3.5 w-3.5 text-anvil-500 dark:text-anvil-400 transition-transform group-open:rotate-90" aria-hidden />
          <FileDiff className="h-3.5 w-3.5 text-anvil-500 dark:text-anvil-400" aria-hidden />
          <span className="font-medium">
            {changes.length}
            {truncated ? '+' : ''} file{changes.length === 1 ? '' : 's'} changed
          </span>
          <DiffStat added={added} deleted={deleted} />
          {counted < textFiles ? (
            <span className="text-[12px] text-anvil-500 dark:text-anvil-400">line counts cover {counted} of {textFiles} files</span>
          ) : null}
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
                  <span className={cn('w-4 shrink-0 text-center font-mono font-semibold', meta.klass)} title={c.status}>
                    {meta.label}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono">{c.path}</span>
                  {p?.kind === 'text' ? <DiffStat added={p.added} deleted={p.deleted} /> : null}
                  {p?.kind === 'placeholder' ? <span className="text-[12px] text-anvil-500 dark:text-anvil-400">{p.reason}</span> : null}
                </button>
              </li>
            )
          })}
        </ul>
      </details>

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
        />
      ))}

      {shown < changes.length ? (
        <div className="flex items-center justify-center gap-3 py-2">
          <span className="text-dense text-anvil-500 dark:text-anvil-400">
            Showing {shown} of {changes.length} files
          </span>
          <Button size="sm" onClick={() => setShown((n) => Math.min(changes.length, n + FILE_PAGE))}>
            Show {Math.min(FILE_PAGE, changes.length - shown)} more files
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

/** Layout, whitespace and palette switches; remembered in this browser. */
function DiffToolbar(): JSX.Element {
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
        {toggle('Hide whitespace', prefs.ignoreWhitespace, () => update({ ignoreWhitespace: !prefs.ignoreWhitespace }), 'Compare lines ignoring whitespace (git diff -w)')}
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
}: {
  id: string
  change: FileChange
  patch: FilePatch | undefined
  href: string | undefined
  onLoadAnyway: () => void
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
        <span className={cn('w-4 shrink-0 text-center font-mono font-semibold', meta.klass)} title={change.status}>
          {meta.label}
        </span>
        {href ? (
          <Link href={href} className="min-w-0 flex-1 truncate font-mono hover:text-forge-800 coarse:py-3 dark:hover:text-forge-400">
            {change.path}
          </Link>
        ) : (
          <span className="min-w-0 flex-1 truncate font-mono">{change.path}</span>
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
          ) : patch.lines.length === 0 ? (
            <p className="px-4 py-4 text-dense text-anvil-500 dark:text-anvil-400">Empty file.</p>
          ) : (
            <PatchLines path={change.path} lines={patch.lines} />
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
  if (inline === null || !inline.canComment) return <td className={GUTTER}>{line}</td>
  return (
    <td className={cn(GUTTER, 'p-0')}>
      {/* One per code line, so as tall as the line: 44px rows would halve what a phone shows of
          the diff. The whole gutter cell is the target (e2e/mobile.spec.ts exempts it). */}
      <button
        type="button"
        onClick={() => inline.start(path, side, line)}
        aria-label={`Comment on ${side === 1 ? 'new' : 'old'} line ${line} of ${path}`}
        data-tap-exempt="code-line"
        className="w-full px-2 text-right hover:bg-forge-500/15 hover:text-anvil-900 dark:hover:text-anvil-50"
      >
        {line}
      </button>
    </td>
  )
}

/** The inline threads (and an open composer) under a row, if any. */
function ThreadRow({ path, keys, colSpan }: { path: string; keys: readonly (readonly [0 | 1, number | null])[]; colSpan: number }): JSX.Element | null {
  const inline = useContext(InlineCommentsContext)
  if (inline === null) return null
  const parts = keys.filter((k): k is readonly [0 | 1, number] => k[1] !== null).map(([side, line]) => inline.render(path, side, line)).filter((n) => n !== null)
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

function PatchLines({ path, lines }: { path: string; lines: readonly CompactDiffLine[] }): JSX.Element {
  const [limit, setLimit] = useState(LINE_PAGE)
  const inline = useContext(InlineCommentsContext)
  // Report the rows on screen (not past the "show more" cut), and withdraw them on unmount
  // (a collapsed file), so threads under lines nobody can see are listed elsewhere.
  useEffect(() => {
    if (inline === null) return
    const keys = new Set<string>()
    for (const l of lines.slice(0, limit)) {
      if (l.kind === 'gap') continue
      if (l.kind !== 'added' && l.oldLine !== null) keys.add(lineKey(path, 0, l.oldLine))
      if (l.kind !== 'deleted' && l.newLine !== null) keys.add(lineKey(path, 1, l.newLine))
    }
    inline.report(path, keys)
    return () => inline.report(path, null)
  }, [inline, path, lines, limit])
  const [prefs] = usePrefs()
  const wide = useMinWidth(1024)
  const split = wide && prefs.diffLayout === 'split'
  const palette = prefs.palette
  const visible = lines.slice(0, limit)
  const gap = (hidden: number, key: string, colSpan: number): JSX.Element => (
    <tr key={key} className="bg-dash/5 text-anvil-600 dark:text-anvil-400">
      <td colSpan={colSpan} className="px-3 py-0.5">
        ⋯ {hidden} unchanged line{hidden === 1 ? '' : 's'}
      </td>
    </tr>
  )
  return (
    <>
      <ScrollRegion label={`Changes to ${path}`} className="overflow-x-auto [container-type:inline-size]">
        <table
          className={cn('w-full border-collapse font-mono text-[12px] leading-5', split && 'table-fixed')}
          aria-label={`Changes to ${path}${split ? ' (side by side)' : ''}`}
          data-layout={split ? 'split' : 'unified'}
        >
          <tbody>
            {split
              ? splitRows(visible).map((row, index) => {
                  if (row.kind === 'gap') return gap(row.hidden, `gap-${index}`, 4)
                  const { left, right } = row
                  const same = left === right
                  return (
                    <Fragment key={`${left?.oldLine ?? 'n'}-${right?.newLine ?? 'n'}-${index}`}>
                      <tr>
                        <LineNumber path={path} side={0} line={left?.oldLine ?? null} />
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
                      <ThreadRow path={path} colSpan={4} keys={[[0, left?.oldLine ?? null], [1, right?.newLine ?? null]]} />
                    </Fragment>
                  )
                })
              : visible.map((line, index) => {
                  if (line.kind === 'gap') return gap(line.hidden, `gap-${index}`, 3)
                  return (
                    <Fragment key={`${line.oldLine ?? 'n'}-${line.newLine ?? 'n'}`}>
                      <tr className={lineTint(line.kind, palette)}>
                        <LineNumber path={path} side={0} line={line.kind === 'added' ? null : line.oldLine} />
                        <LineNumber path={path} side={1} line={line.kind === 'deleted' ? null : line.newLine} />
                        <td className="whitespace-pre px-3 text-anvil-800 dark:text-anvil-200">
                          <Marker kind={line.kind} palette={palette} />
                          <LineText line={line} />
                        </td>
                      </tr>
                      <ThreadRow path={path} colSpan={3} keys={[[0, line.oldLine], [1, line.kind === 'deleted' ? null : line.newLine]]} />
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
