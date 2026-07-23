'use client'

/** TreeContent — a directory listing at an arbitrary path (browse plane, ranged reads). */

import type { BrowseReader } from '@/lib/browse'
import type { RepoHome } from '@/lib/view'
import { commitRootTree, readTree, selectRef, tipOidOf, treeAtPath, type TreeEntry } from '@/lib/view'
import { useAsync } from '@/hooks/use-async'
import { BrowseBoundary } from '@/components/repo/browse-boundary'
import { FileList } from '@/components/repo/file-list'
import { PathBreadcrumb } from '@/components/repo/path-breadcrumb'
import { RefNotFoundState, RefSwitcher } from '@/components/repo/ref-switcher'
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/states'
import type { RepoAddress } from '@/hooks/use-query-param'
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
  if (refParam && !selected.ref) {
    return <RefNotFoundState addr={addr} refParam={refParam} defaultBranch={home.defaultBranch} />
  }
  const tipOid = tipOidOf(selected.ref)
  if (!tipOid) {
    return <EmptyState icon={FolderOpen} title="Empty repo" body={`No commits on ${selected.name}, so no tree to browse.`} />
  }
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <RefSwitcher home={home} addr={addr} current={selected} path={path} />
        <PathBreadcrumb addr={addr} path={path} refParam={refParam} />
      </div>
      <BrowseBoundary repo={home.repo}>
        {(reader) => <DirBody reader={reader} tipOid={tipOid} path={path} addr={addr} refParam={refParam} />}
      </BrowseBoundary>
    </div>
  )
}

function DirBody({
  reader,
  tipOid,
  path,
  addr,
  refParam,
}: {
  reader: BrowseReader
  tipOid: string
  path: string
  addr: RepoAddress
  refParam: string
}): JSX.Element {
  const { data, loading, error, reload } = useAsync(() => loadDir(reader, tipOid, path), [tipOid, path])
  if (loading) return <LoadingBlock label="Reading tree" />
  // A missing path is deterministic (common right after a ref switch) — no point retrying.
  if (error?.includes('path not found')) {
    return <EmptyState icon={FolderOpen} title="Directory not found on this ref" body={`${path} does not exist here. Pick another branch or tag, or browse from the repo root.`} />
  }
  if (error) return <ErrorState message={error} onRetry={reload} />
  if (!data) return <LoadingBlock />
  return <FileList entries={data} addr={addr} basePath={path} refParam={refParam} />
}
