'use client'

/**
 * BlobContent — a single file view via the browse plane: resolve the path to its blob oid
 * (ranged locator lookup), reconstruct + hash-verify the bytes, and render text with line
 * numbers and lazy syntax highlighting (highlight.js loaded in its own async chunk, so it
 * never blocks first paint), an image preview, or a raw download for other binary files.
 *
 * Lines carry GitHub's `#L10` / `#L10-L20` anchors (click a number, shift-click to extend) and
 * a permalink that pins the commit (`y` pins the address bar to it). Long files render only the rows in view, and a text file
 * over 1 MB asks before rendering at all (D-054, D-055).
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
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
  selectedTip,
  selectLine,
  selectRef,
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
import type { RepoAddress } from '@/hooks/use-query-param'
import { permalinkUrl, usePermalinkKey } from '@/components/repo/permalink'
import { bytesToBase64 } from '@/lib/sdk/query'
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
  const selected = selectRef(home.branches, home.tags, home.defaultBranch, refParam)
  const tipOid = selectedTip(selected)
  if (refParam && !selected.ref && !selected.pinned) {
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
        {(reader, retry) => <BlobBody key={`${tipOid}:${path}`} reader={reader} retry={retry} tipOid={tipOid} path={path} addr={addr} />}
      </BrowseBoundary>
    </div>
  )
}

function BlobBody({
  reader,
  retry,
  tipOid,
  path,
  addr,
}: {
  reader: BrowseReader
  retry: () => void
  tipOid: string
  path: string
  addr: RepoAddress
}): JSX.Element {
  const { data, loading, error } = useAsync(() => loadBlob(reader, tipOid, path), [tipOid, path])
  usePermalinkKey(addr, 'blob', tipOid, path)
  const name = path.split('/').pop() ?? path
  const [renderLarge, setRenderLarge] = useState(false)
  // An image that is also text (SVG) can be read as code too, as on GitHub.
  const [showCode, setShowCode] = useState(false)

  const shown = data ? blobDisplay(name, data.bytes, data.text, renderLarge) : null
  const display: BlobDisplay | null =
    shown?.kind === 'image' && showCode && data?.text != null ? { kind: 'text', text: data.text } : shown
  const downloadHref = useObjectUrl(data?.bytes, 'application/octet-stream')
  // "View raw" shows text in the tab (text/plain runs no script, even for HTML content).
  const rawHref = useObjectUrl(shown?.kind === 'confirm-large' ? data?.bytes : undefined, 'text/plain;charset=utf-8')
  const imageHref = useImageUrl(data?.bytes, shown?.kind === 'image' ? shown.type : null)

  if (loading) return <LoadingBlock label="Reconstructing blob" />
  // A missing path is deterministic (common right after a ref switch) — no point retrying.
  if (error?.includes('file not found')) {
    return <EmptyState icon={FileText} title="File not found on this ref" body={`${path} does not exist here. Pick another branch or tag, or browse the tree.`} />
  }
  if (error) return <ErrorState message={error} onRetry={retry} />
  if (!data || !display) return <LoadingBlock />

  const permalink = (fragment: string): string => permalinkUrl(addr, 'blob', tipOid, path, fragment)

  return (
    <div className="overflow-hidden rounded-lg border border-anvil-200 dark:border-anvil-800">
      <div className="flex items-center justify-between gap-3 border-b border-anvil-200 bg-anvil-50 px-4 py-2 text-dense dark:border-anvil-800 dark:bg-anvil-900">
        <div className="flex min-w-0 items-center gap-2">
          <FileText className="h-3.5 w-3.5 shrink-0 text-anvil-500 dark:text-anvil-400" aria-hidden />
          <span className="truncate font-mono">{name}</span>
          <span className="shrink-0 text-anvil-500 dark:text-anvil-400">{formatBytes(data.bytes.length)}</span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {shown?.kind === 'image' && data.text !== null ? (
            <div className="inline-flex rounded-md border border-anvil-200 p-0.5 text-[12px] dark:border-anvil-750">
              {(['Preview', 'Code'] as const).map((label) => (
                <button
                  key={label}
                  type="button"
                  aria-pressed={showCode === (label === 'Code')}
                  onClick={() => setShowCode(label === 'Code')}
                  className={cn('rounded px-2 py-0.5 coarse:min-h-11 coarse:px-3', showCode === (label === 'Code') && 'bg-anvil-200 dark:bg-anvil-750')}
                >
                  {label}
                </button>
              ))}
            </div>
          ) : null}
          <Oid value={data.oid} chars={9} />
          {downloadHref ? (
            <a
              href={downloadHref}
              download={name}
              className="inline-flex items-center gap-1 rounded border border-anvil-300 px-2 py-1 text-[12px] hover:bg-anvil-100 coarse:min-h-11 coarse:px-3 dark:border-anvil-700 dark:hover:bg-anvil-800"
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
        rawHref={rawHref}
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
  rawHref,
  permalink,
  onRenderLarge,
}: {
  display: BlobDisplay
  size: number
  name: string
  imageHref: string | null
  rawHref: string | null
  permalink: (fragment: string) => string
  onRenderLarge: () => void
}): JSX.Element {
  switch (display.kind) {
    case 'image':
      if (imageHref === null) return <LoadingBlock />
      return (
        <>
          <BlobToolbar>
            <PermalinkButton href={permalink('')} />
          </BlobToolbar>
          <div className="flex justify-center bg-anvil-50 p-6 dark:bg-anvil-900/60">
            {/* An <img> runs no script and loads nothing; see useImageUrl for why SVG is a data: URL. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={imageHref} alt={name} className="max-h-[70vh] max-w-full object-contain" data-testid="blob-image" />
          </div>
        </>
      )
    case 'confirm-large':
      return (
        <div className="flex flex-col items-center gap-3 px-4 py-8 text-center text-dense text-anvil-500 dark:text-anvil-400">
          <p>This file is {formatBytes(size)}. Rendering it in the page is slow, so it is not shown by default.</p>
          <div className="flex gap-2">
            {rawHref ? (
              <a
                href={rawHref}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex h-7 items-center rounded-md border border-anvil-300 px-2.5 text-dense hover:bg-anvil-100 coarse:h-11 coarse:px-3 dark:border-anvil-700 dark:hover:bg-anvil-800"
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
        <>
          <BlobToolbar>
            <PermalinkButton href={permalink('')} />
          </BlobToolbar>
          <div className="px-4 py-8 text-center text-dense text-anvil-500 dark:text-anvil-400">
            Binary file ({formatBytes(size)}) — use Raw to download.
          </div>
        </>
      )
  }
}

/** The strip above a file's contents: the selection and the permalink. */
function BlobToolbar({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="flex items-center justify-end gap-2 border-b border-anvil-100 px-4 py-1 text-[12px] text-anvil-500 dark:border-anvil-850 dark:text-anvil-400">
      {children}
    </div>
  )
}

/** Copy the file's link at this commit (`y` puts it in the address bar). */
function PermalinkButton({ href }: { href: string }): JSX.Element {
  const [copied, setCopied] = useState(false)
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(href)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch {
      /* insecure context: nothing to copy to */
    }
  }
  return (
    <button
      type="button"
      onClick={copy}
      data-testid="copy-permalink"
      data-href={href}
      aria-keyshortcuts="y"
      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-anvil-100 coarse:min-h-11 coarse:px-3 dark:hover:bg-anvil-800"
      title="Copy a link to this file at this commit (press y to show it in the address bar)"
    >
      {copied ? <Check className="h-3 w-3 text-verify" aria-hidden /> : <Link2 className="h-3 w-3" aria-hidden />}
      {copied ? 'Copied' : 'Copy permalink'}
    </button>
  )
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

/**
 * The URL an image preview is shown from. Raster images get a `blob:` URL. An SVG gets a
 * `data:` URL instead: a `blob:` URL has this app's origin, so "Open image in new tab" would
 * load the SVG as a same-origin document and run its script (an XSS any committer could plant).
 * A `data:` document is opaque-origin, and browsers refuse top-level `data:` navigation.
 */
function useImageUrl(bytes: Uint8Array | undefined, type: string | null): string | null {
  const svg = type === 'image/svg+xml'
  const dataUrl = useMemo(() => (svg && bytes ? `data:image/svg+xml;base64,${bytesToBase64(bytes)}` : null), [svg, bytes])
  const blobUrl = useObjectUrl(svg ? undefined : bytes, svg ? null : type)
  return dataUrl ?? blobUrl
}

/**
 * Row height of the line table (13px text, leading-5). Windowing and `#L` scrolling position
 * rows by it, so the cells carry no vertical padding (browsers give a `td` 1px) and never wrap.
 */
const ROW_PX = 20

const CODE_CELL = 'whitespace-pre py-0 px-4 align-top text-anvil-800 dark:text-anvil-200'

/**
 * Characters some engines break a `whitespace-pre` line on (WebKit wraps U+2028/U+2029),
 * shown as the visible markers editors use, so every row stays one line high.
 */
const LINE_SEPARATORS = /[\u2028\u2029]/g
const visibleSeparators = (line: string): string => line.replace(LINE_SEPARATORS, (c) => (c === '\u2028' ? '\u23ce' : '\u00b6'))

/**
 * The selected `#L` range, kept in step with the URL fragment. `onHash` is told the range
 * whenever it comes from the URL (on open, or an edited fragment), not from a click, so only
 * those scroll the page.
 */
function useLineSelection(lineCount: number, onHash: (range: LineRange) => void): [LineRange | null, (range: LineRange) => void] {
  const [range, setRange] = useState<LineRange | null>(null)
  const onHashRef = useRef(onHash)
  onHashRef.current = onHash
  useEffect(() => {
    const read = (): void => {
      const next = parseLineHash(window.location.hash, lineCount)
      setRange(next)
      if (next !== null) onHashRef.current(next)
    }
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

function TextLines({ text, name, permalink }: { text: string; name: string; permalink: (fragment: string) => string }): JSX.Element {
  const lines = useMemo(() => text.split('\n'), [text])
  const tableRef = useRef<HTMLTableElement>(null)
  // Scroll a range from the URL into view (the table is laid out by the time effects run).
  const [range, select] = useLineSelection(lines.length, (r) => {
    requestAnimationFrame(() => {
      if (tableRef.current === null) return
      const top = tableRef.current.getBoundingClientRect().top + window.scrollY + (r.start - 1) * ROW_PX
      window.scrollTo({ top: Math.max(0, top - window.innerHeight / 3) })
    })
  })
  const href = permalink(range ? lineHash(range) : '')

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
        <td className="select-none whitespace-nowrap border-r border-anvil-100 px-3 py-0 text-right align-top text-anvil-500 dark:text-anvil-400 dark:border-anvil-850">
          <a
            href={`#L${n}`}
            // Not a tab stop per line: a long file would put thousands before the page's rail.
            tabIndex={-1}
            // One per code line, as tall as the line (e2e/mobile.spec.ts exempts it, as the diff's gutter).
            data-tap-exempt="code-line"
            onClick={(e) => {
              if (e.metaKey || e.ctrlKey) return // open in a new tab, as a link does
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
          <td className={CODE_CELL} dangerouslySetInnerHTML={{ __html: visibleSeparators(hlLines[i] || ' ') }} />
        ) : (
          <td className={CODE_CELL}>{visibleSeparators(lines[i] || ' ')}</td>
        )}
      </tr>,
    )
  }

  return (
    <>
      <BlobToolbar>
        {range ? <span>{range.start === range.end ? `Line ${range.start}` : `Lines ${range.start}–${range.end}`} selected</span> : null}
        <PermalinkButton href={href} />
      </BlobToolbar>
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
