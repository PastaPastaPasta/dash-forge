'use client'

/** TreeContent — a directory listing at an arbitrary path (browse plane, ranged reads). */

import type { BrowseReader } from '@/lib/browse'
import type { RepoHome } from '@/lib/view'
import { commitRootTree, findBranch, readTree, tipOidOf, treeAtPath, type TreeEntry } from '@/lib/view'
import { useAsync } from '@/hooks/use-async'
import { BrowseBoundary } from '@/components/repo/browse-boundary'
import { FileList } from '@/components/repo/file-list'
import { PathBreadcrumb } from '@/components/repo/path-breadcrumb'
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
}: {
  home: RepoHome
  addr: RepoAddress
  path: string
}): JSX.Element {
  const tipOid = tipOidOf(findBranch(home.branches, home.defaultBranch))
  if (!tipOid) {
    return <EmptyState icon={FolderOpen} title="Empty repo" body="No commits, so no tree to browse." />
  }
  return (
    <div className="space-y-4">
      <PathBreadcrumb addr={addr} path={path} />
      <BrowseBoundary repo={home.repo}>
        {(reader) => <DirBody reader={reader} tipOid={tipOid} path={path} addr={addr} />}
      </BrowseBoundary>
    </div>
  )
}

function DirBody({
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
  const { data, loading, error, reload } = useAsync(() => loadDir(reader, tipOid, path), [tipOid, path])
  if (loading) return <LoadingBlock label="Reading tree" />
  if (error) return <ErrorState message={error} onRetry={reload} />
  if (!data) return <LoadingBlock />
  return <FileList entries={data} addr={addr} basePath={path} />
}
