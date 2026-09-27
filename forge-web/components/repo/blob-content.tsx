'use client'

/**
 * BlobContent — a single file view via the browse plane: resolve the path to its blob oid
 * (ranged locator lookup), reconstruct + hash-verify the bytes, and render text with line
 * numbers and lazy syntax highlighting (highlight.js loaded in its own async chunk, so it
 * never blocks first paint), an image preview, or a raw download for other binary files.
 *
 * Lines carry GitHub's `#L10` / `#L10-L20` anchors (click a number, shift-click to extend) and
 * a permalink that pins the commit. Long files render only the rows in view, and a text file
 * over 1 MB asks before rendering at all (D-054, D-055).
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Check, Download, FileText, Link2 } from 'lucide-react'
import type { BrowseReader } from '@/lib/browse'
import type { RepoHome } from '@/lib/view'
import {
  blobDisplay,
  commitRootTree,
  decodeTextBlob,
  findEntry,
  formatBytes,
  highlightBlob,
  lineHash,
  parseLineHash,
  readBlob,
  readTree,
  selectBrowseRef,
  selectLine,
  treeAtPath,
  visibleRows,
  VIRTUALIZE_LINES,
  type BlobDisplay,
  type HighlightedBlob,
  type LineRange,
} from '@/lib/view'
import { useAsync } from '@/hooks/use-async'
import { BrowseBoundary } from '@/components/repo/browse-boundary'
import { PathBreadcrumb } from '@/components/repo/path-breadcrumb'
import { RefDeletedState, RefNotFoundState, RefSwitcher } from '@/components/repo/ref-switcher'
import { Oid } from '@/components/ui/oid'
import { ScrollRegion } from '@/components/ui/scroll-region'
import { Button } from '@/components/ui/button'
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/states'
import { repoHref, type RepoAddress } from '@/hooks/use-query-param'
import { BASE_PATH } from '@/lib/short-url'
import { cn } from '@/lib/utils'

interface BlobData {
  readonly oid: string
  readonly bytes: Uint8Array
  readonly text: string | null
}

async function loadBlob(reader: BrowseReader, tipOid: string, path: string): Promise<BlobData> {
  const { tree } = await commitRootTree(reader, tipOid)
  const slash = path.lastIndexOf('/')
  const dir = slash === -1 ? '' : path.slice(0, slash)
  const name = slash === -1 ? path : path.slice(slash + 1)
  const entries = dir ? await treeAtPath(reader, tree, dir) : await readTree(reader, tree)
  const entry = findEntry(entries, name)
  if (!entry) throw new Error(`file not found: ${path}`)
  const bytes = await readBlob(reader, entry.oid)
  return { oid: entry.oid, bytes, text: decodeTextBlob(bytes) }
}

export function BlobContent({
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
  const { selected, tipOid } = selectBrowseRef(home.branches, home.tags, home.defaultBranch, refParam)
  if (refParam && !selected.ref && !tipOid) {
    return <RefNotFoundState addr={addr} refParam={refParam} defaultBranch={home.defaultBranch} />
  }
  // An enumerated ref with no tip was deleted; only a ref with no entry at all is "empty".
  if (!tipOid && selected.ref) {
    return <RefDeletedState addr={addr} name={selected.name} defaultBranch={home.defaultBranch} />
  }
  if (!tipOid) return <EmptyState icon={FileText} title="Empty repo" body={`No commits on ${selected.name}, so no files to read.`} />
  if (!path) return <EmptyState icon={FileText} title="No file addressed" body="Add &path= to the URL." />

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <RefSwitcher home={home} addr={addr} current={selected} path={path} />
        <PathBreadcrumb addr={addr} path={path} refParam={refParam} />
      </div>
      <BrowseBoundary repo={home.repo} addr={addr}>
        {(reader) => <BlobBody reader={reader} tipOid={tipOid} path={path} addr={addr} />}
      </BrowseBoundary>
    </div>
  )
}

function BlobBody({
  reader,
  tipOid,
  path,
  addr,
}: {
  reader: BrowseReader
  tipOid: string
  path: string
  addr: RepoAddress
}): JSX.Element {
  const { data, loading, error, reload } = useAsync(() => loadBlob(reader, tipOid, path), [tipOid, path])
  const name = path.split('/').pop() ?? path
  const [renderLarge, setRenderLarge] = useState(false)

  const display = data ? blobDisplay(name, data.bytes, data.text, renderLarge) : null
  const downloadHref = useObjectUrl(data?.bytes, 'application/octet-stream')
  const imageHref = useObjectUrl(data?.bytes, display?.kind === 'image' ? display.type : null)

  if (loading) return <LoadingBlock label="Reconstructing blob" />
  // A missing path is deterministic (common right after a ref switch) — no point retrying.
  if (error?.includes('file not found')) {
    return <EmptyState icon={FileText} title="File not found on this ref" body={`${path} does not exist here. Pick another branch or tag, or browse the tree.`} />
  }
  if (error) return <ErrorState message={error} onRetry={reload} />
  if (!data || !display) return <LoadingBlock />

  const origin = typeof window === 'undefined' ? '' : window.location.origin
  const permalink = `${origin}${BASE_PATH}${repoHref('/repo/blob', addr, { path, ref: tipOid })}`

  return (
    <div className="overflow-hidden rounded-lg border border-anvil-200 dark:border-anvil-800">
      <div className="flex items-center justify-between gap-3 border-b border-anvil-200 bg-anvil-50 px-4 py-2 text-dense dark:border-anvil-800 dark:bg-anvil-900">
        <div className="flex min-w-0 items-center gap-2">
          <FileText className="h-3.5 w-3.5 shrink-0 text-anvil-500 dark:text-anvil-400" aria-hidden />
          <span className="truncate font-mono">{name}</span>
          <span className="shrink-0 text-anvil-500 dark:text-anvil-400">{formatBytes(data.bytes.length)}</span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Oid value={data.oid} chars={9} />
          {downloadHref ? (
            <a
              href={downloadHref}
              download={name}
              className="inline-flex items-center gap-1 rounded border border-anvil-300 px-2 py-1 text-[12px] hover:bg-anvil-100 dark:border-anvil-700 dark:hover:bg-anvil-800"
            >
              <Download className="h-3 w-3" aria-hidden /> Raw
            </a>
          ) : null}
        </div>
      </div>
      <BlobView
        display={display}
        size={data.bytes.length}
        name={name}
        imageHref={imageHref}
        downloadHref={downloadHref}
        permalink={permalink}
        onRenderLarge={() => setRenderLarge(true)}
      />
    </div>
  )
}

function BlobView({
  display,
  size,
  name,
  imageHref,
  downloadHref,
  permalink,
  onRenderLarge,
}: {
  display: BlobDisplay
  size: number
  name: string
  imageHref: string | null
  downloadHref: string | null
  permalink: string
  onRenderLarge: () => void
}): JSX.Element {
  switch (display.kind) {
    case 'image':
      if (imageHref === null) return <LoadingBlock />
      return (
        <div className="flex justify-center bg-anvil-50 p-6 dark:bg-anvil-900/60">
          {/* An <img> of a blob: URL: an SVG shown this way runs no script and loads nothing. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={imageHref} alt={name} className="max-h-[70vh] max-w-full object-contain" data-testid="blob-image" />
        </div>
      )
    case 'confirm-large':
      return (
        <div className="flex flex-col items-center gap-3 px-4 py-8 text-center text-dense text-anvil-500 dark:text-anvil-400">
          <p>This file is {formatBytes(size)}. Rendering it in the page is slow, so it is not shown by default.</p>
          <div className="flex gap-2">
            {downloadHref ? (
              <a
                href={downloadHref}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex h-7 items-center rounded-md border border-anvil-300 px-2.5 text-dense hover:bg-anvil-100 dark:border-anvil-700 dark:hover:bg-anvil-800"
              >
                View raw
              </a>
            ) : null}
            <Button size="sm" onClick={onRenderLarge}>
              Render anyway
            </Button>
          </div>
        </div>
      )
    case 'text':
      return <TextLines text={display.text} name={name} permalink={permalink} />
    case 'binary':
      return (
        <div className="px-4 py-8 text-center text-dense text-anvil-500 dark:text-anvil-400">
          Binary file ({formatBytes(size)}) — use Raw to download.
        </div>
      )
  }
}

/**
 * A `blob:` URL of `bytes` typed `type` (null: none), revoked when either changes or on
 * unmount. Created in the effect, not a memo, so StrictMode's effect replay cannot revoke a
 * URL that is still rendered.
 */
function useObjectUrl(bytes: Uint8Array | undefined, type: string | null): string | null {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (bytes === undefined || type === null) {
      setUrl(null)
      return
    }
    const next = URL.createObjectURL(new Blob([bytes.slice()], { type }))
    setUrl(next)
    return () => URL.revokeObjectURL(next)
  }, [bytes, type])
  return url
}

/** Row height of the line table (13px text, leading-5). Windowing positions rows by it. */
const ROW_PX = 20

const CODE_CELL = 'whitespace-pre px-4 align-top text-anvil-800 dark:text-anvil-200'

/** The selected `#L` range, kept in step with the URL fragment. */
function useLineSelection(lineCount: number): [LineRange | null, (range: LineRange) => void] {
  const [range, setRange] = useState<LineRange | null>(null)
  useEffect(() => {
    const read = (): void => setRange(parseLineHash(window.location.hash, lineCount))
    read()
    window.addEventListener('hashchange', read)
    return () => window.removeEventListener('hashchange', read)
  }, [lineCount])
  const select = (next: LineRange): void => {
    setRange(next)
    // replaceState: selecting lines should not stack history entries or jump the page.
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}#${lineHash(next)}`)
  }
  return [range, select]
}

function TextLines({ text, name, permalink }: { text: string; name: string; permalink: string }): JSX.Element {
  const lines = useMemo(() => text.split('\n'), [text])
  const [range, select] = useLineSelection(lines.length)
  const [copied, setCopied] = useState(false)
  const href = range ? `${permalink}#${lineHash(range)}` : permalink

  // Lazy syntax highlighting: highlight.js loads in its own async chunk after the text is on
  // screen, then swaps in per-line highlighted HTML. highlightBlob caps the size it takes on.
  const [highlighted, setHighlighted] = useState<HighlightedBlob | null>(null)
  useEffect(() => {
    setHighlighted(null)
    let active = true
    void highlightBlob(text, name).then((h) => {
      if (active) setHighlighted(h)
    })
    return () => {
      active = false
    }
  }, [text, name])
  const hlLines = highlighted && highlighted.lines.length === lines.length ? highlighted.lines : null

  // Long files render only the rows near the viewport (D-055: a 1 MB file was 81k DOM nodes).
  const virtual = lines.length > VIRTUALIZE_LINES
  const tableRef = useRef<HTMLTableElement>(null)
  const [win, setWin] = useState({ from: 0, to: 200 })
  const { from, to } = virtual ? win : { from: 0, to: lines.length }
  useLayoutEffect(() => {
    if (!virtual) return
    let frame = 0
    const update = (): void => {
      frame = 0
      const el = tableRef.current
      if (el === null) return
      const next = visibleRows(lines.length, ROW_PX, el.getBoundingClientRect().top, window.innerHeight)
      setWin((w) => (w.from === next.from && w.to === next.to ? w : next))
    }
    const schedule = (): void => {
      if (frame === 0) frame = requestAnimationFrame(update)
    }
    update()
    window.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame)
      window.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
    }
  }, [virtual, lines.length])

  // Scroll a linked range into view once, when the page opens on it.
  const scrolled = useRef(false)
  useEffect(() => {
    if (range === null || scrolled.current || tableRef.current === null) return
    scrolled.current = true
    const top = tableRef.current.getBoundingClientRect().top + window.scrollY + (range.start - 1) * ROW_PX
    window.scrollTo({ top: Math.max(0, top - window.innerHeight / 3) })
  }, [range])

  const copyPermalink = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(href)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch {
      /* insecure context: nothing to copy to */
    }
  }

  const rows: JSX.Element[] = []
  for (let i = from; i < to; i++) {
    const n = i + 1
    const on = range !== null && n >= range.start && n <= range.end
    rows.push(
      <tr
        key={i}
        id={`L${n}`}
        data-selected={on || undefined}
        className={cn('h-5', on ? 'bg-caution/15' : 'hover:bg-anvil-50 dark:hover:bg-anvil-900/60')}
      >
        <td className="select-none whitespace-nowrap border-r border-anvil-100 px-3 text-right align-top text-anvil-500 dark:text-anvil-400 dark:border-anvil-850">
          <a
            href={`#L${n}`}
            onClick={(e) => {
              e.preventDefault()
              select(selectLine(range, n, e.shiftKey))
            }}
            className="hover:text-anvil-800 dark:hover:text-anvil-100"
          >
            {n}
          </a>
        </td>
        {hlLines ? (
          // highlight.js escapes all text and emits only class-bearing spans.
          <td className={CODE_CELL} dangerouslySetInnerHTML={{ __html: hlLines[i] || ' ' }} />
        ) : (
          <td className={CODE_CELL}>{lines[i] || ' '}</td>
        )}
      </tr>,
    )
  }

  return (
    <>
      <div className="flex items-center justify-end gap-2 border-b border-anvil-100 px-4 py-1 text-[12px] text-anvil-500 dark:border-anvil-850 dark:text-anvil-400">
        {range ? <span>{range.start === range.end ? `Line ${range.start}` : `Lines ${range.start}–${range.end}`} selected</span> : null}
        <button
          type="button"
          onClick={copyPermalink}
          data-testid="copy-permalink"
          data-href={href}
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-anvil-100 dark:hover:bg-anvil-800"
          title="Copy a link to this file at this commit"
        >
          {copied ? <Check className="h-3 w-3 text-verify" aria-hidden /> : <Link2 className="h-3 w-3" aria-hidden />}
          {copied ? 'Copied' : 'Copy permalink'}
        </button>
      </div>
      <ScrollRegion label={`Contents of ${name}`} className="overflow-x-auto">
        <table ref={tableRef} className="hljs w-full border-collapse bg-transparent font-mono text-[13px] leading-5" data-lines={lines.length}>
          <tbody>
            {from > 0 ? <tr aria-hidden style={{ height: from * ROW_PX }} /> : null}
            {rows}
            {to < lines.length ? <tr aria-hidden style={{ height: (lines.length - to) * ROW_PX }} /> : null}
          </tbody>
        </table>
      </ScrollRegion>
    </>
  )
}
