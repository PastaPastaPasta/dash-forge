'use client'

/**
 * FileList — a directory listing at 36px rows (style guide density). Trees link to /repo/tree,
 * blobs to /repo/blob, gitlinks render as submodule pins. Sorted dirs-first, then by name.
 */

import Link from 'next/link'
import { File, FileCog, Folder, GitCommitHorizontal, Link2 } from 'lucide-react'
import type { TreeEntry } from '@/lib/view'
import { modeKind } from '@/lib/view'
import { repoHref, type RepoAddress } from '@/hooks/use-query-param'
import { cn } from '@/lib/utils'

function iconFor(kind: ReturnType<typeof modeKind>): JSX.Element {
  switch (kind) {
    case 'dir':
      return <Folder className="h-4 w-4 text-forge-500" aria-hidden />
    case 'submodule':
      return <GitCommitHorizontal className="h-4 w-4 text-dash" aria-hidden />
    case 'link':
      return <Link2 className="h-4 w-4 text-anvil-400" aria-hidden />
    case 'exe':
      return <FileCog className="h-4 w-4 text-anvil-400" aria-hidden />
    default:
      return <File className="h-4 w-4 text-anvil-400" aria-hidden />
  }
}

export function FileList({
  entries,
  addr,
  basePath,
  refParam = '',
}: {
  entries: readonly TreeEntry[]
  addr: RepoAddress
  /** The directory these entries live in (`''` = root). */
  basePath: string
  /** The `?ref=` selection to carry into child links ('' = default branch, omitted). */
  refParam?: string
}): JSX.Element {
  const sorted = [...entries].sort((a, b) => {
    const ak = a.mode === 0o40000 ? 0 : 1
    const bk = b.mode === 0o40000 ? 0 : 1
    if (ak !== bk) return ak - bk
    return a.name.localeCompare(b.name)
  })

  return (
    <div className="overflow-hidden rounded-lg border border-anvil-200 dark:border-anvil-800">
      {sorted.map((e, i) => {
        const kind = modeKind(e.mode)
        const childPath = basePath ? `${basePath}/${e.name}` : e.name
        const isDir = kind === 'dir'
        const extra = { path: childPath, ...(refParam ? { ref: refParam } : {}) }
        const href =
          kind === 'submodule'
            ? undefined
            : repoHref(isDir ? '/repo/tree' : '/repo/blob', addr, extra)
        const inner = (
          <>
            <span className="shrink-0">{iconFor(kind)}</span>
            <span className={cn('min-w-0 flex-1 truncate font-mono', href && 'group-hover:text-forge-600 dark:group-hover:text-forge-400')}>
              {e.name}
            </span>
            {kind === 'submodule' ? (
              <span className="font-mono text-[11px] text-anvil-400">@ {e.oid.slice(0, 7)}</span>
            ) : null}
          </>
        )
        const rowCls =
          'group flex h-9 items-center gap-2.5 border-b border-anvil-100 px-3 text-dense last:border-b-0 dark:border-anvil-850'
        return href ? (
          <Link key={i} href={href} className={cn(rowCls, 'hover:bg-anvil-50 dark:hover:bg-anvil-900')}>
            {inner}
          </Link>
        ) : (
          <div key={i} className={rowCls} title="Submodule (gitlink)">
            {inner}
          </div>
        )
      })}
    </div>
  )
}
