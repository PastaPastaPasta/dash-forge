'use client'

/**
 * RepoHeader — the repo identity line + nav tabs. Owner/name (owner links to profile), backend
 * badge, star button, and the archived banner. Nav tabs are query-param links that keep the
 * `(owner, name)` address.
 */

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Archive, Code2, GitFork, GitPullRequest, Lock, MessageSquare, Settings, Tag, Users } from 'lucide-react'
import type { RepoHome } from '@/lib/view'
import { BackendBadge } from '@/components/ui/backend-badge'
import { CopyLinkButton } from '@/components/ui/copy-link'
import { Author } from '@/components/author'
import { StarButton } from '@/components/repo/star-button'
import { WatchButton } from '@/components/repo/watch-button'
import { useTargetCounts, useViewerRole } from '@/hooks/use-repo-chrome'
import { repoHref, useParam, type RepoAddress } from '@/hooks/use-query-param'
import { cn } from '@/lib/utils'
import { TabStrip } from '@/components/ui/tab-strip'
import { bareRoute } from '@/lib/page-title'
import { ForkButton } from '@/components/repo/fork-button'
import { contributeHref, forkHeadBranch, useForkParent } from '@/components/repo/fork-contribute'

/**
 * "forked from owner/name", linking to the parent, and GitHub's Contribute: the parent's New pull
 * request form with this fork's branch as the head (QW3-012). The parent is the one the PR pages
 * read too (`readForkParent`, cached).
 */
function ForkedFrom({ home }: { home: RepoHome }): JSX.Element {
  const parent = useForkParent(home)
  const parentId = home.v2.forkOf ?? ''
  return (
    <p className="mt-1 flex flex-wrap items-center gap-1 text-[12px] text-anvil-600 dark:text-anvil-400" data-testid="forked-from">
      <GitFork className="h-3 w-3" aria-hidden /> forked from{' '}
      {parent ? (
        <>
          <Author identityId={parent.ownerId} link={false} />
          <span>/</span>
          <Link href={repoHref('/repo', { owner: parent.ownerId, name: parent.name })} className="font-mono hover:text-forge-800 dark:hover:text-forge-400">
            {parent.name}
          </Link>
          <span aria-hidden>·</span>
          <Link
            href={contributeHref(parent, home.repo, forkHeadBranch(home))}
            className="hit-area inline-flex items-center gap-1 text-forge-700 hover:underline dark:text-forge-400"
            data-testid="fork-contribute"
          >
            <GitPullRequest className="h-3 w-3" aria-hidden /> Open a pull request to {parent.name}
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
export const CODE_ROUTES = ['/repo', '/repo/tree', '/repo/blob', '/repo/blame', '/repo/branches', '/repo/tags', '/repo/commits', '/repo/commit', '/repo/compare']

/** The tab a repo route belongs to (`null`: none, e.g. Stargazers, as on GitHub). */
export function activeRepoTab(pathname: string): 'code' | 'issues' | 'pulls' | 'releases' | 'settings' | null {
  const p = bareRoute(pathname)
  if (CODE_ROUTES.includes(p)) return 'code'
  // Labels and Milestones sit under Issues, as on GitHub.
  if (p === '/repo/issues' || p === '/repo/issue' || p === '/repo/labels' || p === '/repo/milestones') return 'issues'
  if (p === '/repo/pulls' || p === '/repo/pull' || p === '/repo/pulls/new') return 'pulls'
  if (p === '/repo/releases' || p === '/repo/release') return 'releases'
  if (p === '/repo/settings') return 'settings'
  return null
}

/** Routes whose view renders its own h1 (an issue's title, a commit's subject): the repo name is not the page's heading there. */
const VIEWS_WITH_OWN_H1 = ['/repo/issue', '/repo/pull', '/repo/pulls/new', '/repo/commit', '/repo/compare', '/repo/releases', '/repo/stargazers']


export function RepoHeader({ home, addr }: { home: RepoHome; addr: RepoAddress }): JSX.Element {
  const pathname = bareRoute(usePathname())
  const current = activeRepoTab(pathname)
  const refParam = useParam('ref')
  const counts = useTargetCounts(home.repo)
  const { role } = useViewerRole(home.repo)
  const TitleTag = VIEWS_WITH_OWN_H1.includes(pathname) ? 'div' : 'h1'
  const tabs = [
    { key: 'code', label: 'Code', path: '/repo', icon: Code2, refAware: true, count: null },
    { key: 'issues', label: 'Issues', path: '/repo/issues', icon: MessageSquare, refAware: false, count: counts.issues },
    { key: 'pulls', label: 'Pull requests', path: '/repo/pulls', icon: GitPullRequest, refAware: false, count: counts.pulls },
    { key: 'releases', label: 'Releases', path: '/repo/releases', icon: Tag, refAware: false, count: null },
    ...(role === 'maintainer'
      ? [{ key: 'settings', label: 'Settings', path: '/repo/settings', icon: Settings, refAware: false, count: null }]
      : role === 'writer'
        ? [{ key: 'settings', label: 'Members', path: '/repo/settings', icon: Users, refAware: false, count: null }]
        : []),
  ]

  return (
    <div className="mb-5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {/* The chips wrap below the title on a narrow screen rather than squeezing it. */}
        <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2 text-prose">
          {/* The page's h1 (L-60), the repo's owner / name, unless the view has its own title. */}
          <TitleTag className="flex min-w-0 max-w-full items-center gap-2 text-prose font-normal" data-testid="repo-title">
            {/* The owner keeps its own width (capped at 45vw) and the name truncates: a pill
                squeezed below its width drew over the name (the id inside it cannot shrink). */}
            <span className="flex shrink-0">
              <Author identityId={home.repo.ownerId} link className="min-w-0 max-w-[45vw] sm:max-w-none" />
            </span>
            <span className="text-anvil-300 dark:text-anvil-600" aria-hidden>/</span>
            <Link href={repoHref('/repo', addr)} className="hit-area min-w-0 truncate font-mono font-semibold text-anvil-900 hover:text-forge-800 dark:text-anvil-50 dark:hover:text-forge-400">
              {home.repo.name || addr.name}
            </Link>
          </TitleTag>
          {home.repo.visibility === 'private' ? <PrivateChip home={home} /> : null}
          <BackendBadge backend={home.backend} />
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <CopyLinkButton repo={addr} />
          {home.repo.visibility === 'public' ? <ForkButton parent={home.repo} defaults={{ defaultBranch: home.defaultBranch, description: home.description }} /> : null}
          <WatchButton repo={home.repo} />
          <StarButton repo={home.repo} count={home.starCount} />
        </div>
      </div>

      {home.v2.forkOf ? <ForkedFrom home={home} /> : null}

      {home.description ? (
        <p className="mt-2 max-w-3xl text-dense text-anvil-600 dark:text-anvil-300">{home.description}</p>
      ) : null}

      {home.config?.archived ? (
        <div className="mt-3 flex items-center gap-2 rounded-md border border-caution/40 bg-caution/5 px-3 py-1.5 text-dense text-caution-700 dark:text-caution-400">
          <Archive className="h-3.5 w-3.5" aria-hidden /> A maintainer has marked this repo archived.
        </div>
      ) : null}

      {/* Nav: on a phone the tabs scroll sideways, with a fade on the side that has more. */}
      <TabStrip activeKey={pathname} label="Repository" className="mt-4">
        {tabs.map((tab) => {
          const active = tab.key === current
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
