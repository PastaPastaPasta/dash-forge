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
import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, FileDiff } from 'lucide-react'
import {
  loadFilePatch,
  mapPooled,
  modeString,
  type CompactDiffLine,
  type DiffSides,
  type FileChange,
  type FilePatch,
} from '@/lib/view'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/states'
import { cn } from '@/lib/utils'

/** Files whose patches load per page. */
const FILE_PAGE = 25
/** Rows a file renders before a "show more lines" button. */
const LINE_PAGE = 400
/** Patch reads in flight at once. */
const PATCH_CONCURRENCY = 4
/** Finished patches are committed to state in batches at most this often (ms). */
const PATCH_FLUSH_MS = 100

/**
 * Text shades for small added/deleted counts. The semantic `verify` / `danger` hues are one
 * weight too light for 12px text: `danger` on the dark theme's background is 4.0:1, under
 * WCAG AA's 4.5:1. These are the same hues a step darker (light) or lighter (dark).
 */
const ADDED_TEXT = 'text-green-700 dark:text-green-400'
const DELETED_TEXT = 'text-red-700 dark:text-red-400'

const STATUS_META: Record<FileChange['status'], { label: string; klass: string }> = {
  added: { label: 'A', klass: ADDED_TEXT },
  modified: { label: 'M', klass: 'text-caution' },
  deleted: { label: 'D', klass: DELETED_TEXT },
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
  const [patches, setPatches] = useState<ReadonlyMap<string, FilePatch>>(() => new Map())
  const [scrollTo, setScrollTo] = useState<number | null>(null)
  const requested = useRef(new Set<string>())
  // Patches land one by one; committing each would re-render the whole list per file.
  const pending = useRef(new Map<string, FilePatch>())
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (flushTimer.current !== null) clearTimeout(flushTimer.current)
    },
    [],
  )

  useEffect(() => {
    const flush = (): void => {
      flushTimer.current = null
      const batch = pending.current
      pending.current = new Map()
      setPatches((prev) => new Map([...prev, ...batch]))
    }
    const todo = changes.slice(0, shown).filter((c) => !requested.current.has(c.path))
    for (const c of todo) requested.current.add(c.path)
    void mapPooled(todo, PATCH_CONCURRENCY, async (change) => {
      pending.current.set(change.path, await loadFilePatch(sides, change))
      flushTimer.current ??= setTimeout(flush, PATCH_FLUSH_MS)
    })
  }, [changes, shown, sides])

  // Jump to a file picked from the list once it has rendered (it may be past `shown`).
  useEffect(() => {
    if (scrollTo === null || scrollTo >= shown) return
    document.getElementById(anchorId(scrollTo))?.scrollIntoView({ block: 'start' })
    setScrollTo(null)
  }, [scrollTo, shown])

  let added = 0
  let deleted = 0
  let counted = 0
  for (const p of patches.values()) {
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
    setPatches((prev) => {
      const next = new Map(prev)
      next.delete(change.path)
      return next
    })
    void loadFilePatch(sides, change, { ignoreSizeHint: true }).then((patch) =>
      setPatches((prev) => new Map(prev).set(change.path, patch)),
    )
  }

  const pick = (index: number): void => {
    if (index >= shown) setShown(Math.min(changes.length, Math.ceil((index + 1) / FILE_PAGE) * FILE_PAGE))
    setScrollTo(index)
  }

  return (
    <div className="space-y-3">
      <details open={changes.length <= FILE_PAGE} className="group rounded-lg border border-anvil-200 dark:border-anvil-800">
        <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-dense [&::-webkit-details-marker]:hidden">
          <ChevronRight className="h-3.5 w-3.5 text-anvil-400 transition-transform group-open:rotate-90" aria-hidden />
          <FileDiff className="h-3.5 w-3.5 text-anvil-400" aria-hidden />
          <span className="font-medium">
            {changes.length}
            {truncated ? '+' : ''} file{changes.length === 1 ? '' : 's'} changed
          </span>
          <DiffStat added={added} deleted={deleted} />
          {counted < textFiles ? (
            <span className="text-[12px] text-anvil-400">line counts cover {counted} of {textFiles} files</span>
          ) : null}
        </summary>
        <ul className="max-h-80 overflow-y-auto border-t border-anvil-200 dark:border-anvil-800">
          {changes.map((c, index) => {
            const meta = STATUS_META[c.status]
            const p = patches.get(c.path)
            return (
              <li key={c.path}>
                <button
                  type="button"
                  onClick={() => pick(index)}
                  className="flex w-full items-center gap-3 px-3 py-1 text-left text-dense hover:bg-anvil-50 dark:hover:bg-anvil-850"
                >
                  <span className={cn('w-4 shrink-0 text-center font-mono font-semibold', meta.klass)} title={c.status}>
                    {meta.label}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono">{c.path}</span>
                  {p?.kind === 'text' ? <DiffStat added={p.added} deleted={p.deleted} /> : null}
                  {p?.kind === 'placeholder' ? <span className="text-[12px] text-anvil-400">{p.reason}</span> : null}
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
  return (
    <span className="shrink-0 font-mono text-[12px]">
      <span className={ADDED_TEXT}>+{added}</span> <span className={DELETED_TEXT}>−{deleted}</span>
    </span>
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
  const meta = STATUS_META[change.status]
  const modeChanged =
    change.baseMode !== null && change.headMode !== null && change.baseMode !== change.headMode

  return (
    <div id={id} className="scroll-mt-4 overflow-hidden rounded-lg border border-anvil-200 dark:border-anvil-800">
      <div className="flex items-center gap-2 bg-anvil-50 px-3 py-2 text-dense dark:bg-anvil-900">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-label={`${open ? 'Collapse' : 'Expand'} ${change.path}`}
          className="rounded p-0.5 text-anvil-400 hover:bg-anvil-200 hover:text-anvil-700 dark:hover:bg-anvil-800 dark:hover:text-anvil-200"
        >
          {open ? <ChevronDown className="h-4 w-4" aria-hidden /> : <ChevronRight className="h-4 w-4" aria-hidden />}
        </button>
        <span className={cn('w-4 shrink-0 text-center font-mono font-semibold', meta.klass)} title={change.status}>
          {meta.label}
        </span>
        {href ? (
          <Link href={href} className="min-w-0 flex-1 truncate font-mono hover:text-forge-600 dark:hover:text-forge-400">
            {change.path}
          </Link>
        ) : (
          <span className="min-w-0 flex-1 truncate font-mono">{change.path}</span>
        )}
        {modeChanged ? (
          <span className="shrink-0 font-mono text-[12px] text-anvil-400">
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

function PatchLines({ path, lines }: { path: string; lines: readonly CompactDiffLine[] }): JSX.Element {
  const [limit, setLimit] = useState(LINE_PAGE)
  const visible = lines.slice(0, limit)
  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse font-mono text-[12px] leading-5" aria-label={`Changes to ${path}`}>
          <tbody>
            {visible.map((line, index) => {
              if (line.kind === 'gap') {
                return (
                  <tr key={`gap-${index}`} className="bg-dash/5 text-anvil-500 dark:text-anvil-400">
                    <td colSpan={3} className="px-3 py-0.5">
                      ⋯ {line.hidden} unchanged line{line.hidden === 1 ? '' : 's'}
                    </td>
                  </tr>
                )
              }
              const marker = line.kind === 'added' ? '+' : line.kind === 'deleted' ? '-' : ' '
              return (
                <tr
                  key={`${line.oldLine ?? 'n'}-${line.newLine ?? 'n'}`}
                  className={cn(line.kind === 'added' && 'bg-verify/10', line.kind === 'deleted' && 'bg-danger/10')}
                >
                  <td className="w-12 select-none border-r border-anvil-100 px-2 text-right align-top text-anvil-400 dark:border-anvil-850">
                    {line.oldLine ?? ''}
                  </td>
                  <td className="w-12 select-none border-r border-anvil-100 px-2 text-right align-top text-anvil-400 dark:border-anvil-850">
                    {line.newLine ?? ''}
                  </td>
                  <td className="whitespace-pre px-3 text-anvil-800 dark:text-anvil-200">
                    <span className="select-none text-anvil-400">{marker}</span>
                    {line.text || ' '}
                    {line.noNewline ? (
                      <span className="ml-2 select-none font-sans text-anvil-400">(no newline at end of file)</span>
                    ) : null}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
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
