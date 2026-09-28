'use client'

/** TreeContent — a directory listing at an arbitrary path (browse plane, ranged reads). */

import type { BrowseReader } from '@/lib/browse'
import type { RepoHome } from '@/lib/view'
import { commitRootTree, readTree, selectedTip, selectRef, treeAtPath, type TreeEntry } from '@/lib/view'
import { useAsync } from '@/hooks/use-async'
import { BrowseBoundary } from '@/components/repo/browse-boundary'
import { FileList } from '@/components/repo/file-list'
import { PathBreadcrumb } from '@/components/repo/path-breadcrumb'
import { RefDeletedState, RefNotFoundState, RefSwitcher } from '@/components/repo/ref-switcher'
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/states'
import type { RepoAddress } from '@/hooks/use-query-param'
import { pinnedHref, usePermalinkKey } from '@/components/repo/permalink'
import { FolderOpen } from 'lucide-react'

async function loadDir(reader: BrowseReader, tipOid: string, path: string): Promise<TreeEntry[]> {
  const { tree } = await commitRootTree(reader, tipOid)
  return path ? treeAtPath(reader, tree, path) : readTree(reader, tree)
}

export function TreeContent({
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
  if (!tipOid) {
    return <EmptyState icon={FolderOpen} title="Empty repo" body={`No commits on ${selected.name}, so no tree to browse.`} />
  }
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <RefSwitcher home={home} addr={addr} current={selected} path={path} />
        <PathBreadcrumb addr={addr} path={path} refParam={refParam} />
      </div>
      <BrowseBoundary repo={home.repo} addr={addr}>
        {(reader, retry) => (
          <DirBody reader={reader} retry={retry} tipOid={tipOid} path={path} addr={addr} refParam={refParam} privateRepo={home.repo.visibility === 'private'} />
        )}
      </BrowseBoundary>
    </div>
  )
}

function DirBody({
  reader,
  retry,
  tipOid,
  path,
  addr,
  refParam,
  privateRepo,
}: {
  reader: BrowseReader
  retry: () => void
  tipOid: string
  path: string
  addr: RepoAddress
  refParam: string
  privateRepo: boolean
}): JSX.Element {
  const { data, loading, error } = useAsync(() => loadDir(reader, tipOid, path), [tipOid, path])
  usePermalinkKey(pinnedHref(addr, 'tree', tipOid, path, privateRepo))
  if (loading) return <LoadingBlock label="Reading tree" />
  // A missing path is deterministic (common right after a ref switch) — no point retrying.
  if (error?.includes('path not found')) {
    return <EmptyState icon={FolderOpen} title="Directory not found on this ref" body={`${path} does not exist here. Pick another branch or tag, or browse from the repo root.`} />
  }
  if (error) return <ErrorState message={error} onRetry={retry} />
  if (!data) return <LoadingBlock />
  return <FileList entries={data} addr={addr} basePath={path} refParam={refParam} />
}
