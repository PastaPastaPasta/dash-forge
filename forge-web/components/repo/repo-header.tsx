'use client'

/**
 * RepoHeader — the repo identity line + nav tabs. Owner/name (owner links to profile), backend
 * badge, star button, and the archived banner. Nav tabs are query-param links that keep the
 * `(owner, name)` address.
 */

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Archive, Code2, GitCommit, GitPullRequest, MessageSquare, Settings } from 'lucide-react'
import type { RepoHome } from '@/lib/view'
import { BackendBadge } from '@/components/ui/backend-badge'
import { Author } from '@/components/author'
import { StarButton } from '@/components/repo/star-button'
import { repoHref, type RepoAddress } from '@/hooks/use-query-param'
import { cn } from '@/lib/utils'

const TABS = [
  { label: 'Code', path: '/repo', icon: Code2, match: ['/repo', '/repo/tree', '/repo/blob'] },
  { label: 'Commits', path: '/repo/commits', icon: GitCommit, match: ['/repo/commits', '/repo/commit'] },
  { label: 'Issues', path: '/repo/issues', icon: MessageSquare, match: ['/repo/issues', '/repo/issue'] },
  { label: 'Pulls', path: '/repo/pulls', icon: GitPullRequest, match: ['/repo/pulls', '/repo/pull'] },
  { label: 'Settings', path: '/repo/settings', icon: Settings, match: ['/repo/settings'] },
]

export function RepoHeader({ home, addr }: { home: RepoHome; addr: RepoAddress }): JSX.Element {
  const pathname = usePathname()

  return (
    <div className="mb-5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex items-center gap-2 text-prose">
          <Author identityId={home.repo.ownerId} link />
          <span className="text-anvil-300 dark:text-anvil-600">/</span>
          <Link href={repoHref('/repo', addr)} className="font-mono font-semibold text-anvil-900 hover:text-forge-600 dark:text-anvil-50 dark:hover:text-forge-400">
            {addr.name}
          </Link>
          <BackendBadge backend={home.backend} />
        </div>
        <div className="ml-auto flex items-center gap-2">
          <StarButton listingId={home.listingId} count={home.starCount} />
        </div>
      </div>

      {home.config?.archived ? (
        <div className="mt-3 flex items-center gap-2 rounded-md border border-caution/40 bg-caution/5 px-3 py-1.5 text-dense text-caution">
          <Archive className="h-3.5 w-3.5" aria-hidden /> This repo is archived — read-only.
        </div>
      ) : null}

      {/* Nav */}
      <nav className="mt-4 flex gap-1 overflow-x-auto border-b border-anvil-200 dark:border-anvil-800">
        {TABS.map((tab) => {
          const active = tab.match.includes(pathname)
          const Icon = tab.icon
          return (
            <Link
              key={tab.path}
              href={repoHref(tab.path, addr)}
              className={cn(
                'inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-dense transition-colors',
                active
                  ? 'border-forge-500 text-anvil-900 dark:text-anvil-50'
                  : 'border-transparent text-anvil-500 hover:text-anvil-800 dark:text-anvil-400 dark:hover:text-anvil-100',
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
