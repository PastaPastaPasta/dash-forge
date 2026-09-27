'use client'

/**
 * RepoHeader — the repo identity line + nav tabs. Owner/name (owner links to profile), backend
 * badge, star button, and the archived banner. Nav tabs are query-param links that keep the
 * `(owner, name)` address.
 */

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Archive, Code2, GitFork, GitPullRequest, Lock, MessageSquare, Settings, Tag, Users } from 'lucide-react'
import type { RepoHome } from '@/lib/view'
import { BackendBadge } from '@/components/ui/backend-badge'
import { CopyLinkButton } from '@/components/ui/copy-link'
import { Author } from '@/components/author'
import { StarButton } from '@/components/repo/star-button'
import { useTargetCounts, useViewerRole } from '@/hooks/use-repo-chrome'
import { repoHref, useParam, type RepoAddress } from '@/hooks/use-query-param'
import { cn } from '@/lib/utils'
import { ForkButton } from '@/components/repo/fork-button'
import { readRepoById } from '@/lib/repo'
import type { ForgeIds } from '@/lib/deployments'
import { useSdk } from '@/hooks/use-sdk'
import { useAsync } from '@/hooks/use-async'

/** "forked from owner/name", linking to the parent (read by its id). */
function ForkedFrom({ forge, parentId }: { forge: ForgeIds; parentId: string }): JSX.Element {
  const { sdk, ready } = useSdk()
  const parent = useAsync(() => readRepoById(sdk!, forge, parentId), [ready, parentId], { enabled: ready && sdk !== null })
  const doc = parent.data
  return (
    <p className="mt-1 flex flex-wrap items-center gap-1 text-[12px] text-anvil-600 dark:text-anvil-400" data-testid="forked-from">
      <GitFork className="h-3 w-3" aria-hidden /> forked from{' '}
      {doc ? (
        <>
          <Author identityId={doc.ownerId} link={false} />
          <span>/</span>
          <Link href={repoHref('/repo', { owner: doc.ownerId, name: doc.name })} className="font-mono hover:text-forge-800 dark:hover:text-forge-400">
            {doc.name}
          </Link>
        </>
      ) : (
        <span className="font-mono">{parentId.slice(0, 8)}…</span>
      )}
    </p>
  )
}

/**
 * The five tabs (`ux-dx-spec.md` §5.2): Code · Issues (n) · Pull requests (n) · Releases ·
 * Settings. Commits live under Code (the ref bar's `n commits`). Settings is a maintainer's
 * tab; a writer sees the same page as a read-only Members list.
 */
const CODE_ROUTES = ['/repo', '/repo/tree', '/repo/blob', '/repo/branches', '/repo/tags', '/repo/stargazers', '/repo/commits', '/repo/commit']

/** Match a route with or without the export's trailing slash. */
const bare = (p: string): string => (p.length > 1 ? p.replace(/\/+$/, '') : p)

export function RepoHeader({ home, addr }: { home: RepoHome; addr: RepoAddress }): JSX.Element {
  const pathname = bare(usePathname())
  const refParam = useParam('ref')
  const counts = useTargetCounts(home.repo)
  const { role } = useViewerRole(home.repo)
  const tabs = [
    { label: 'Code', path: '/repo', icon: Code2, refAware: true, match: CODE_ROUTES, count: null },
    { label: 'Issues', path: '/repo/issues', icon: MessageSquare, refAware: false, match: ['/repo/issues', '/repo/issue'], count: counts.issues },
    { label: 'Pull requests', path: '/repo/pulls', icon: GitPullRequest, refAware: false, match: ['/repo/pulls', '/repo/pull', '/repo/pulls/new'], count: counts.pulls },
    { label: 'Releases', path: '/repo/releases', icon: Tag, refAware: false, match: ['/repo/releases', '/repo/release'], count: null },
    ...(role === 'maintainer'
      ? [{ label: 'Settings', path: '/repo/settings', icon: Settings, refAware: false, match: ['/repo/settings'], count: null }]
      : role === 'writer'
        ? [{ label: 'Members', path: '/repo/settings', icon: Users, refAware: false, match: ['/repo/settings'], count: null }]
        : []),
  ]

  return (
    <div className="mb-5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex items-center gap-2 text-prose">
          <Author identityId={home.repo.ownerId} link />
          <span className="text-anvil-300 dark:text-anvil-600" aria-hidden>/</span>
          <Link href={repoHref('/repo', addr)} className="hit-area font-mono font-semibold text-anvil-900 hover:text-forge-800 dark:text-anvil-50 dark:hover:text-forge-400">
            {home.repo.name || addr.name}
          </Link>
          {home.repo.visibility === 'private' ? <PrivateChip home={home} /> : null}
          <BackendBadge backend={home.backend} />
        </div>
        <div className="ml-auto flex items-center gap-2">
          <CopyLinkButton repo={addr} />
          {home.repo.visibility === 'public' ? <ForkButton parent={home.repo} /> : null}
          <StarButton repo={home.repo} count={home.starCount} />
        </div>
      </div>

      {home.v2.forkOf ? <ForkedFrom forge={home.repo.forge} parentId={home.v2.forkOf} /> : null}

      {home.description ? (
        <p className="mt-2 max-w-3xl text-dense text-anvil-600 dark:text-anvil-300">{home.description}</p>
      ) : null}

      {home.config?.archived ? (
        <div className="mt-3 flex items-center gap-2 rounded-md border border-caution/40 bg-caution/5 px-3 py-1.5 text-dense text-caution-700 dark:text-caution-400">
          <Archive className="h-3.5 w-3.5" aria-hidden /> A maintainer has marked this repo archived.
        </div>
      ) : null}

      {/* Nav: on a phone the tabs scroll sideways, with a fade on the side that has more. */}
      <TabStrip activeKey={pathname}>
        {tabs.map((tab) => {
          const active = tab.match.includes(pathname)
          const Icon = tab.icon
          return (
            <Link
              key={tab.path}
              href={repoHref(tab.path, addr, tab.refAware && refParam ? { ref: refParam } : {})}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'inline-flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-dense transition-colors coarse:min-h-11',
                active
                  ? 'border-forge-500 text-anvil-900 dark:text-anvil-50'
                  : 'border-transparent text-anvil-600 hover:text-anvil-800 dark:text-anvil-400 dark:hover:text-anvil-100',
              )}
            >
              <Icon className="h-3.5 w-3.5" aria-hidden />
              {tab.label}
              {tab.count !== null ? (
                <span className="rounded-full bg-anvil-100 px-1.5 text-[11px] tabular-nums text-anvil-700 dark:bg-anvil-800 dark:text-anvil-200">
                  {tab.count}
                </span>
              ) : null}
            </Link>
          )
        })}
      </TabStrip>
    </div>
  )
}

/**
 * The tab row. When it is wider than the screen it scrolls sideways: the active tab is
 * scrolled into view, and an edge fade marks the side with more tabs (`data-more`).
 */
function TabStrip({ activeKey, children }: { activeKey: string; children: React.ReactNode }): JSX.Element {
  const ref = useRef<HTMLElement>(null)
  const [more, setMore] = useState<{ left: boolean; right: boolean }>({ left: false, right: false })
  const measure = useCallback(() => {
    const el = ref.current
    if (!el) return
    const left = el.scrollLeft > 1
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1
    setMore((m) => (m.left === left && m.right === right ? m : { left, right }))
  }, [])
  useEffect(() => {
    const el = ref.current
    if (!el) return
    // Keep the active tab inside the strip by scrolling the strip only (scrollIntoView would
    // also scroll the page, e.g. jump to the tabs when Back restores a scrolled position).
    const reveal = (): void => {
      const active = el.querySelector<HTMLElement>('[aria-current="page"]')
      if (active) {
        const t = active.getBoundingClientRect()
        const n = el.getBoundingClientRect()
        if (t.left < n.left) el.scrollLeft += t.left - n.left
        else if (t.right > n.right) el.scrollLeft += t.right - n.right
      }
      measure()
    }
    reveal()
    // Again whenever the strip or a tab resizes (a count that loads later widens its tab).
    const ro = new ResizeObserver(reveal)
    ro.observe(el)
    for (const tab of el.children) ro.observe(tab)
    return () => ro.disconnect()
  }, [activeKey, measure])
  const fade = 'pointer-events-none absolute inset-y-0 w-8 from-anvil-50 to-transparent dark:from-anvil-950'
  return (
    <div className="relative mt-4" data-more={[more.left && 'left', more.right && 'right'].filter(Boolean).join(' ') || undefined}>
      <nav
        ref={ref}
        aria-label="Repository"
        onScroll={measure}
        className="flex gap-1 overflow-x-auto overscroll-x-contain border-b border-anvil-200 [scrollbar-width:none] dark:border-anvil-800 [&::-webkit-scrollbar]:hidden"
      >
        {children}
      </nav>
      {more.left ? <span aria-hidden className={cn(fade, 'left-0 bg-gradient-to-r')} /> : null}
      {more.right ? <span aria-hidden className={cn(fade, 'right-0 bg-gradient-to-l')} /> : null}
    </div>
  )
}

/**
 * The lock chip (`ux-dx-spec.md` §9): a member reading with their key sees which epoch the view
 * decrypted with; everyone else sees that the repo is private.
 */
function PrivateChip({ home }: { home: RepoHome }): JSX.Element {
  // The newest epoch the reader holds a key for (the current one, unless it is not readable yet).
  const keys = home.private?.access === 'member' ? [...home.private.session.resolution.keys.keys()] : []
  const epoch = keys.length > 0 ? Math.max(...keys) : null
  return (
    <span
      data-testid="private-chip"
      className="inline-flex items-center gap-1 rounded bg-anvil-100 px-1.5 py-0.5 text-[11px] text-anvil-600 dark:bg-anvil-800 dark:text-anvil-300"
    >
      <Lock className="h-3 w-3" aria-hidden />
      {epoch !== null ? `Private · decrypted with your key (epoch ${epoch})` : 'private'}
    </span>
  )
}
