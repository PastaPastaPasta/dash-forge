'use client'

/**
 * RefListContent — the branches / tags listing. Renders the already-resolved refs from the
 * repo home view-model (zero extra Platform reads); each tip oid links to its commit page.
 * Deleted refs (null-oid updates — the name persists in append-only Platform history) are
 * folded behind a disclosure so the main list shows only what can be browsed.
 */

import Link from 'next/link'
import { GitBranch, Tag } from 'lucide-react'
import type { RepoHome } from '@/lib/view'
import { isDiverged, isLive, refParamFor, tipOidOf } from '@/lib/view'
import type { ResolvedRef } from '@/lib/repo'
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
  const short = (ref: ResolvedRef): string =>
    ref.refName.startsWith(prefix) ? ref.refName.slice(prefix.length) : ref.refName

  // Default branch first, then alphabetical.
  const byName = (a: ResolvedRef, b: ResolvedRef): number => {
    if (a.refName === defaultRefName) return -1
    if (b.refName === defaultRefName) return 1
    return a.refName.localeCompare(b.refName)
  }
  const live = refs.filter(isLive).sort(byName)
  const deleted = refs.filter((r) => !isLive(r)).sort(byName)

  if (live.length === 0 && deleted.length === 0) {
    return (
      <EmptyState
        icon={Icon}
        title={empty}
        body={`Push ${noun} with the git-remote-dash helper and it appears here.`}
      />
    )
  }

  return (
    <div className="space-y-4">
      {live.length > 0 ? (
        <div className="overflow-hidden rounded-lg border border-anvil-200 dark:border-anvil-800">
          {live.map((ref) => {
            const shortName = short(ref)
            const isDefault = ref.refName === defaultRefName
            const tip = tipOidOf(ref)
            const browseRef = refParamFor(shortName, kind === 'tags', home.defaultBranch)
            return (
              <div
                key={ref.refName}
                className="flex items-center gap-3 border-b border-anvil-100 px-4 py-2.5 last:border-b-0 dark:border-anvil-850"
              >
                <Icon className="h-3.5 w-3.5 shrink-0 text-anvil-400" aria-hidden />
                <Link
                  href={repoHref('/repo', addr, browseRef ? { ref: browseRef } : {})}
                  className="min-w-0 flex-1 truncate font-mono text-dense font-medium text-anvil-900 hover:text-forge-600 dark:text-anvil-50 dark:hover:text-forge-400"
                >
                  {shortName}
                </Link>
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
                ) : null}
              </div>
            )
          })}
        </div>
      ) : (
        <EmptyState
          icon={Icon}
          title={`No active ${kind}`}
          body={`Every pushed ${kind === 'branches' ? 'branch' : 'tag'} here has since been deleted. Push ${noun} with the git-remote-dash helper and it appears here.`}
        />
      )}

      {deleted.length > 0 ? (
        <details className="rounded-lg border border-anvil-200 dark:border-anvil-800">
          <summary className="cursor-pointer select-none px-4 py-2.5 text-dense text-anvil-500 hover:text-anvil-700 dark:text-anvil-400 dark:hover:text-anvil-200">
            {deleted.length} deleted {kind === 'branches' ? (deleted.length === 1 ? 'branch' : 'branches') : (deleted.length === 1 ? 'tag' : 'tags')}
          </summary>
          <div className="border-t border-anvil-100 dark:border-anvil-850">
            {deleted.map((ref) => (
              <div
                key={ref.refName}
                className="flex items-center gap-3 border-b border-anvil-100 px-4 py-2.5 last:border-b-0 dark:border-anvil-850"
              >
                <Icon className="h-3.5 w-3.5 shrink-0 text-anvil-300 dark:text-anvil-600" aria-hidden />
                <span className="min-w-0 flex-1 truncate font-mono text-dense text-anvil-400 line-through decoration-anvil-300 dark:decoration-anvil-600">
                  {short(ref)}
                </span>
                <span className="rounded-full border border-anvil-200 px-2 py-0.5 text-[11px] text-anvil-400 dark:border-anvil-700">
                  deleted
                </span>
              </div>
            ))}
          </div>
        </details>
      ) : null}
    </div>
  )
}
