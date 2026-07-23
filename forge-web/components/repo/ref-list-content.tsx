'use client'

/**
 * RefListContent — the branches / tags listing. Renders the already-resolved refs from the
 * repo home view-model (zero extra Platform reads); each tip oid links to its commit page.
 */

import Link from 'next/link'
import { GitBranch, Tag } from 'lucide-react'
import type { RepoHome } from '@/lib/view'
import { isDiverged, tipOidOf } from '@/lib/view'
import type { ResolvedRef } from '@/lib/repo'
import { Oid } from '@/components/ui/oid'
import { EmptyState } from '@/components/ui/states'
import { repoHref, type RepoAddress } from '@/hooks/use-query-param'

const KIND = {
  branches: { prefix: 'refs/heads/', icon: GitBranch, empty: 'No branches yet' },
  tags: { prefix: 'refs/tags/', icon: Tag, empty: 'No tags yet' },
} as const

export function RefListContent({
  home,
  addr,
  kind,
}: {
  home: RepoHome
  addr: RepoAddress
  kind: keyof typeof KIND
}): JSX.Element {
  const meta = KIND[kind]
  const refs = kind === 'branches' ? home.branches : home.tags
  const defaultRefName = `refs/heads/${home.defaultBranch}`

  if (refs.length === 0) {
    return (
      <EmptyState
        icon={meta.icon}
        title={meta.empty}
        body={`Push ${kind === 'branches' ? 'a branch' : 'a tag'} with the git-remote-dash helper and it appears here.`}
      />
    )
  }

  // Default branch first, then alphabetical.
  const sorted = [...refs].sort((a, b) => {
    if (a.refName === defaultRefName) return -1
    if (b.refName === defaultRefName) return 1
    return a.refName.localeCompare(b.refName)
  })

  return (
    <div className="overflow-hidden rounded-lg border border-anvil-200 dark:border-anvil-800">
      {sorted.map((ref) => (
        <RefRow
          key={ref.refName}
          refItem={ref}
          shortName={ref.refName.startsWith(meta.prefix) ? ref.refName.slice(meta.prefix.length) : ref.refName}
          isDefault={ref.refName === defaultRefName}
          addr={addr}
          icon={<meta.icon className="h-3.5 w-3.5 shrink-0 text-anvil-400" aria-hidden />}
        />
      ))}
    </div>
  )
}

function RefRow({
  refItem,
  shortName,
  isDefault,
  addr,
  icon,
}: {
  refItem: ResolvedRef
  shortName: string
  isDefault: boolean
  addr: RepoAddress
  icon: React.ReactNode
}): JSX.Element {
  const tip = tipOidOf(refItem)
  return (
    <div className="flex items-center gap-3 border-b border-anvil-100 px-4 py-2.5 last:border-b-0 dark:border-anvil-850">
      {icon}
      <span className="min-w-0 flex-1 truncate font-mono text-dense font-medium text-anvil-900 dark:text-anvil-50">
        {shortName}
      </span>
      {isDefault ? (
        <span className="rounded-full border border-anvil-200 px-2 py-0.5 text-[11px] text-anvil-500 dark:border-anvil-700 dark:text-anvil-400">
          default
        </span>
      ) : null}
      {isDiverged(refItem) ? (
        <span className="rounded-full border border-caution/40 bg-caution/5 px-2 py-0.5 text-[11px] text-caution">
          diverged
        </span>
      ) : null}
      {tip ? (
        <Link
          href={repoHref('/repo/commit', addr, { oid: tip })}
          className="hover:text-forge-600 dark:hover:text-forge-400"
        >
          <Oid value={tip} copyable={false} />
        </Link>
      ) : (
        <span className="text-[12px] text-anvil-400">unborn</span>
      )}
    </div>
  )
}
