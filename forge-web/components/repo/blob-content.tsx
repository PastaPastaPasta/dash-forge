'use client'

/**
 * BlobContent — a single file view via the browse plane: resolve the path to its blob oid
 * (ranged locator lookup), reconstruct + hash-verify the bytes, and render text with line
 * numbers and lazy syntax highlighting (highlight.js loaded in its own async chunk, so it
 * never blocks first paint), or a raw download for binary. The blob oid is surfaced as a
 * struck-metal serial in the assay.
 */

import { useEffect, useMemo, useState } from 'react'
import { Download, FileText } from 'lucide-react'
import type { BrowseReader } from '@/lib/browse'
import type { RepoHome } from '@/lib/view'
import {
  commitRootTree,
  decodeTextBlob,
  findEntry,
  highlightBlob,
  readBlob,
  readTree,
  selectRef,
  tipOidOf,
  treeAtPath,
  formatBytes,
  type HighlightedBlob,
} from '@/lib/view'
import { useAsync } from '@/hooks/use-async'
import { BrowseBoundary } from '@/components/repo/browse-boundary'
import { PathBreadcrumb } from '@/components/repo/path-breadcrumb'
import { RefNotFoundState, RefSwitcher } from '@/components/repo/ref-switcher'
import { Oid } from '@/components/ui/oid'
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/states'
import type { RepoAddress } from '@/hooks/use-query-param'

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
  if (refParam && !selected.ref) {
    return <RefNotFoundState addr={addr} refParam={refParam} defaultBranch={home.defaultBranch} />
  }
  const tipOid = tipOidOf(selected.ref)
  if (!tipOid) return <EmptyState icon={FileText} title="Empty repo" body={`No commits on ${selected.name}, so no files to read.`} />
  if (!path) return <EmptyState icon={FileText} title="No file addressed" body="Add &path= to the URL." />

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <RefSwitcher home={home} addr={addr} current={selected} path={path} />
        <PathBreadcrumb addr={addr} path={path} refParam={refParam} />
      </div>
      <BrowseBoundary repo={home.repo}>
        {(reader) => <BlobBody reader={reader} tipOid={tipOid} path={path} />}
      </BrowseBoundary>
    </div>
  )
}

function BlobBody({
  reader,
  tipOid,
  path,
}: {
  reader: BrowseReader
  tipOid: string
  path: string
}): JSX.Element {
  const { data, loading, error, reload } = useAsync(() => loadBlob(reader, tipOid, path), [tipOid, path])
  const name = path.split('/').pop() ?? path

  // Lazy syntax highlighting: highlight.js loads in its own async chunk after the text is on
  // screen, then swaps in per-line highlighted HTML. Plain text renders in the meantime.
  const [highlighted, setHighlighted] = useState<HighlightedBlob | null>(null)
  const text = data?.text ?? null
  useEffect(() => {
    setHighlighted(null)
    if (text === null) return
    let active = true
    void highlightBlob(text, name).then((h) => {
      if (active) setHighlighted(h)
    })
    return () => {
      active = false
    }
  }, [text, name])

  const downloadHref = useMemo(() => {
    if (!data) return null
    const src = data.bytes
    const copy = new Uint8Array(src.byteLength)
    copy.set(src)
    const blob = new Blob([copy], { type: 'application/octet-stream' })
    return URL.createObjectURL(blob)
  }, [data])

  if (loading) return <LoadingBlock label="Reconstructing blob" />
  // A missing path is deterministic (common right after a ref switch) — no point retrying.
  if (error?.includes('file not found')) {
    return <EmptyState icon={FileText} title="File not found on this ref" body={`${path} does not exist here. Pick another branch or tag, or browse the tree.`} />
  }
  if (error) return <ErrorState message={error} onRetry={reload} />
  if (!data) return <LoadingBlock />

  const plainLines = data.text !== null ? data.text.split('\n') : []
  // Use highlighted per-line HTML when it matches the current text line count; otherwise plain.
  const hlLines = highlighted && highlighted.lines.length === plainLines.length ? highlighted.lines : null

  return (
    <div className="overflow-hidden rounded-lg border border-anvil-200 dark:border-anvil-800">
      <div className="flex items-center justify-between gap-3 border-b border-anvil-200 bg-anvil-50 px-4 py-2 text-dense dark:border-anvil-800 dark:bg-anvil-900">
        <div className="flex min-w-0 items-center gap-2">
          <FileText className="h-3.5 w-3.5 shrink-0 text-anvil-400" aria-hidden />
          <span className="truncate font-mono">{name}</span>
          <span className="shrink-0 text-anvil-400">{formatBytes(data.bytes.length)}</span>
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

      {data.text !== null ? (
        <div className="overflow-x-auto">
          <table className="hljs w-full border-collapse bg-transparent font-mono text-[13px]">
            <tbody>
              {plainLines.map((line, i) => (
                <tr key={i} className="hover:bg-anvil-50 dark:hover:bg-anvil-900/60">
                  <td className="select-none whitespace-nowrap border-r border-anvil-100 px-3 text-right align-top text-anvil-400 dark:border-anvil-850">
                    {i + 1}
                  </td>
                  {hlLines ? (
                    <td
                      className="whitespace-pre px-4 align-top text-anvil-800 dark:text-anvil-200"
                      // highlight.js escapes all text and emits only class-bearing spans.
                      dangerouslySetInnerHTML={{ __html: hlLines[i] || ' ' }}
                    />
                  ) : (
                    <td className="whitespace-pre px-4 align-top text-anvil-800 dark:text-anvil-200">
                      {line || ' '}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="px-4 py-8 text-center text-dense text-anvil-500 dark:text-anvil-400">
          Binary file ({formatBytes(data.bytes.length)}) — use Raw to download.
        </div>
      )}
    </div>
  )
}
