'use client'

/**
 * RepoShellHeader — the repo's header drawn from its address alone, before the Platform SDK has
 * loaded (L-54): the owner and name, and the tabs as plain links. On a slow link the SDK's
 * WebAssembly takes minutes to arrive, and nothing about the repo showed until it had; now the
 * page names the repo, and its tabs are usable, from the first paint.
 *
 * Nothing here is read from Platform, so nothing is claimed: the owner shows as the address gives
 * it (a DPNS name or an id), with no verification mark, and the counts, stars and badges wait for
 * the real header, which replaces this one once the repo is resolved.
 */

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Code2, GitPullRequest, MessageSquare, Tag } from 'lucide-react'
import { activeRepoTab } from '@/components/repo/repo-header'
import { repoHref, useParam, type RepoAddress } from '@/hooks/use-query-param'
import { cn } from '@/lib/utils'

const TABS = [
  { key: 'code', label: 'Code', path: '/repo', icon: Code2, refAware: true },
  { key: 'issues', label: 'Issues', path: '/repo/issues', icon: MessageSquare, refAware: false },
  { key: 'pulls', label: 'Pull requests', path: '/repo/pulls', icon: GitPullRequest, refAware: false },
  { key: 'releases', label: 'Releases', path: '/repo/releases', icon: Tag, refAware: false },
] as const

/** An address's owner as the URL gives it: a long id shortened, a name as written. */
function ownerLabel(owner: string): string {
  return owner.length > 20 ? `${owner.slice(0, 8)}…` : owner.replace(/^@/, '')
}

export function RepoShellHeader({ addr }: { addr: RepoAddress }): JSX.Element {
  const current = activeRepoTab(usePathname())
  const refParam = useParam('ref')
  return (
    <div className="mb-5" data-testid="repo-shell-header">
      <div className="flex flex-wrap items-center gap-2 text-prose">
        <span className="font-mono text-anvil-600 dark:text-anvil-300" title={addr.owner}>
          {ownerLabel(addr.owner)}
        </span>
        <span className="text-anvil-300 dark:text-anvil-600" aria-hidden>
          /
        </span>
        <Link href={repoHref('/repo', addr)} className="font-mono font-semibold text-anvil-900 dark:text-anvil-50">
          {addr.name}
        </Link>
      </div>
      <nav aria-label="Repository" className="mt-4 flex gap-1 overflow-x-auto border-b border-anvil-200 dark:border-anvil-800">
        {TABS.map((tab) => {
          const Icon = tab.icon
          const active = tab.key === current
          return (
            <Link
              key={tab.path}
              href={repoHref(tab.path, addr, tab.refAware && refParam ? { ref: refParam } : {})}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'inline-flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-dense coarse:min-h-11',
                active ? 'border-forge-500 text-anvil-900 dark:text-anvil-50' : 'border-transparent text-anvil-600 dark:text-anvil-400',
              )}
            >
              <Icon className="h-3.5 w-3.5" aria-hidden />
              {tab.label}
            </Link>
          )
        })}
      </nav>
    </div>
  )
}
