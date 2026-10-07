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
import { usePathname } from '@/hooks/use-route'
import { Code2, GitPullRequest, MessageSquare, Tag } from 'lucide-react'
import { activeRepoTab } from '@/components/repo/repo-header'
import { repoHref, useParam, type RepoAddress } from '@/hooks/use-query-param'
import { cn } from '@/lib/utils'
import { ownerLabel } from '@/lib/page-title'
import { TabStrip } from '@/components/ui/tab-strip'

const TABS = [
  { key: 'code', label: 'Code', path: '/repo', icon: Code2, refAware: true },
  { key: 'issues', label: 'Issues', path: '/repo/issues', icon: MessageSquare, refAware: false },
  { key: 'pulls', label: 'Pull requests', path: '/repo/pulls', icon: GitPullRequest, refAware: false },
  { key: 'releases', label: 'Releases', path: '/repo/releases', icon: Tag, refAware: false },
] as const

export function RepoShellHeader({ addr }: { addr: RepoAddress }): JSX.Element {
  const current = activeRepoTab(usePathname())
  const refParam = useParam('ref')
  return (
    <div className="mb-5" data-testid="repo-shell-header">
      {/* The page's h1 while it loads, one line on a phone (L-58, L-60), like the real header. */}
      <h1 className="flex min-w-0 items-center gap-2 text-prose font-normal">
        {/* The owner as the address gives it: an identity id shortened, a DPNS name as written. */}
        <span className="min-w-0 max-w-[45vw] truncate font-mono text-anvil-600 dark:text-anvil-300 sm:max-w-none" title={addr.owner}>
          {ownerLabel(addr.owner.replace(/^@/, ''))}
        </span>
        <span className="text-anvil-300 dark:text-anvil-600" aria-hidden>
          /
        </span>
        <Link href={repoHref('/repo', addr)} className="min-w-0 truncate font-mono font-semibold text-anvil-900 dark:text-anvil-50">
          {addr.name}
        </Link>
      </h1>
      <TabStrip activeKey={current ?? ''} label="Repository" className="mt-4">
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
      </TabStrip>
    </div>
  )
}
