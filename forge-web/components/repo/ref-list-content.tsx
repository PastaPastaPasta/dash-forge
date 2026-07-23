'use client'

/**
 * RefListContent — the branches / tags listing. Renders the already-resolved refs from the
 * repo home view-model (zero extra Platform reads); each tip oid links to its commit page.
 */

import Link from 'next/link'
import { GitBranch, Tag } from 'lucide-react'
import type { RepoHome } from '@/lib/view'
import { isDiverged, refParamFor, tipOidOf } from '@/lib/view'
import { Oid } from '@/components/ui/oid'
import { EmptyState } from '@/components/ui/states'
import { repoHref, type RepoAddress } from '@/hooks/use-query-param'

const KIND = {
  branches: { prefix: 'refs/heads/', icon: GitBranch, empty: 'No branches yet', noun: 'a branch' },
  tags: { prefix: 'refs/tags/', icon: Tag, empty: 'No tags yet', noun: 'a tag' },
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
  const { prefix, icon: Icon, empty, noun } = KIND[kind]
  const refs = kind === 'branches' ? home.branches : home.tags
  const defaultRefName = `refs/heads/${home.defaultBranch}`

  if (refs.length === 0) {
    return (
      <EmptyState
        icon={Icon}
        title={empty}
        body={`Push ${noun} with the git-remote-dash helper and it appears here.`}
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
      {sorted.map((ref) => {
        const shortName = ref.refName.startsWith(prefix) ? ref.refName.slice(prefix.length) : ref.refName
        const isDefault = ref.refName === defaultRefName
        const tip = tipOidOf(ref)
        const browseRef = refParamFor(shortName, kind === 'tags', home.defaultBranch)
        return (
          <div
            key={ref.refName}
            className="flex items-center gap-3 border-b border-anvil-100 px-4 py-2.5 last:border-b-0 dark:border-anvil-850"
          >
            <Icon className="h-3.5 w-3.5 shrink-0 text-anvil-400" aria-hidden />
            {tip ? (
              <Link
                href={repoHref('/repo', addr, browseRef ? { ref: browseRef } : {})}
                className="min-w-0 flex-1 truncate font-mono text-dense font-medium text-anvil-900 hover:text-forge-600 dark:text-anvil-50 dark:hover:text-forge-400"
              >
                {shortName}
              </Link>
            ) : (
              <span className="min-w-0 flex-1 truncate font-mono text-dense font-medium text-anvil-900 dark:text-anvil-50">
                {shortName}
              </span>
            )}
            {isDefault ? (
              <span className="rounded-full border border-anvil-200 px-2 py-0.5 text-[11px] text-anvil-500 dark:border-anvil-700 dark:text-anvil-400">
                default
              </span>
            ) : null}
            {isDiverged(ref) ? (
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
      })}
    </div>
  )
}
