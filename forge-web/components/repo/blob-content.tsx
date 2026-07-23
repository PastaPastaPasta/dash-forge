'use client'

/**
 * BlobContent — a single file view via the browse plane: resolve the path to its blob oid
 * (ranged locator lookup), reconstruct + hash-verify the bytes, and render text with line
 * numbers (mono, no highlighter in-bundle) or a raw download for binary. The blob oid is
 * surfaced as a struck-metal serial in the assay.
 */

import { useMemo } from 'react'
import { Download, FileText } from 'lucide-react'
import type { BrowseReader } from '@/lib/browse'
import type { RepoHome } from '@/lib/view'
import {
  commitRootTree,
  decodeTextBlob,
  findBranch,
  findEntry,
  readBlob,
  readTree,
  tipOidOf,
  treeAtPath,
  formatBytes,
} from '@/lib/view'
import { useAsync } from '@/hooks/use-async'
import { BrowseBoundary } from '@/components/repo/browse-boundary'
import { PathBreadcrumb } from '@/components/repo/path-breadcrumb'
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
}: {
  home: RepoHome
  addr: RepoAddress
  path: string
}): JSX.Element {
  const tipOid = tipOidOf(findBranch(home.branches, home.defaultBranch))
  if (!tipOid) return <EmptyState icon={FileText} title="Empty repo" body="No commits, so no files to read." />
  if (!path) return <EmptyState icon={FileText} title="No file addressed" body="Add &path= to the URL." />

  return (
    <div className="space-y-4">
      <PathBreadcrumb addr={addr} path={path} />
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

  const downloadHref = useMemo(() => {
    if (!data) return null
    const src = data.bytes
    const copy = new Uint8Array(src.byteLength)
    copy.set(src)
    const blob = new Blob([copy], { type: 'application/octet-stream' })
    return URL.createObjectURL(blob)
  }, [data])

  if (loading) return <LoadingBlock label="Reconstructing blob" />
  if (error) return <ErrorState message={error} onRetry={reload} />
  if (!data) return <LoadingBlock />

  const lines = data.text !== null ? data.text.split('\n') : []

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
          <table className="w-full border-collapse font-mono text-[13px]">
            <tbody>
              {lines.map((line, i) => (
                <tr key={i} className="hover:bg-anvil-50 dark:hover:bg-anvil-900/60">
                  <td className="select-none whitespace-nowrap border-r border-anvil-100 px-3 text-right align-top text-anvil-400 dark:border-anvil-850">
                    {i + 1}
                  </td>
                  <td className="whitespace-pre px-4 align-top text-anvil-800 dark:text-anvil-200">
                    {line || ' '}
                  </td>
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
