'use client'

/**
 * `/explore` (`ux-dx-spec.md` §5.11): recent repos, recently released, and, signed in, my
 * repos, the repos I maintain or write to, my issues, my PRs, my stars, and what is assigned
 * to me or mentions me. Every section reads an index that answers it; where none exists the
 * section says so rather than implying it saw everything.
 */

import Link from 'next/link'
import type { ReactNode } from 'react'
import { CircleDot, Compass, GitBranch, GitPullRequest, Info, Package, Star, UserCheck } from 'lucide-react'
import { AppShell } from '@/components/app-shell'
import { RepoCard } from '@/components/repo-card'
import { Button } from '@/components/ui/button'
import { ErrorState, Spinner } from '@/components/ui/states'
import { NotDeployedState, isForgeDeployed } from '@/components/ui/network-badge'
import { useAuth } from '@/contexts/auth-context'
import { useAsync, type AsyncState } from '@/hooks/use-async'
import { repoHref } from '@/hooks/use-query-param'
import { useSdk } from '@/hooks/use-sdk'
import { useUiStore } from '@/hooks/use-ui-store'
import { NETWORKS } from '@/lib/constants'
import { listRecentRepos, listReposByOwner, resolveDpnsName, timeAgo, type DiscoveredRepo } from '@/lib/view'
import {
  latestReleases,
  listMyTargets,
  listStarredRepoIds,
  readReposByIds,
  repoLite,
  scanAssignedAndMentions,
  type RepoLite,
  type TargetRow,
} from '@/lib/view/mine'

/** The trending note, verbatim from the spec. */
const TRENDING = "Trending needs an indexer. Forge doesn't run one; you can"
/** "My repos" and "maintain or write to" read at most this many each (listReposByOwner's page). */
const MY_REPOS_MAX = 50
/** The assignment / mention scan looks at this many repos (one feed read each, 3 at a time). */
const SCAN_REPOS_MAX = 20
const INDEXER_DOCS = 'https://github.com/PastaPastaPasta/dash-forge/blob/master/docs/roadmap.md'

export default function ExplorePage(): JSX.Element {
  const { sdk, ready, network, error: sdkError } = useSdk()
  const { identity } = useAuth()
  const openLogin = useUiStore((s) => s.openLogin)
  const forge = NETWORKS[network].v2
  const on = ready && sdk !== null && forge !== null

  const recent = useAsync(() => listRecentRepos(sdk!, { network, limit: 24 }), [ready, network], { enabled: on })
  const recentV2 = recent.data ?? []
  const releases = useAsync(() => latestReleases(sdk!, forge!, recentV2.map(repoLite)), [recentV2.map((r) => r.key).join(',')], {
    enabled: on && recent.data !== null,
  })

  const me = identity ?? ''
  const signedIn = on && identity !== null
  const mine = useAsync(() => listReposByOwner(sdk!, me, { network, limit: MY_REPOS_MAX }), [me, network], { enabled: signedIn })
  const issues = useAsync(() => listMyTargets(sdk!, forge!, me, 'issue'), [me, 'issues'], { enabled: signedIn })
  const pulls = useAsync(() => listMyTargets(sdk!, forge!, me, 'pull'), [me, 'pulls'], { enabled: signedIn })
  const stars = useAsync(
    async () => {
      const page = await listStarredRepoIds(sdk!, forge!, me)
      const repos = await readReposByIds(sdk!, forge!, page.rows)
      return { repos: page.rows.map((id) => repos.get(id)).filter((r): r is RepoLite => r !== undefined), more: page.more }
    },
    [me, 'stars'],
    { enabled: signedIn },
  )
  // Assigned / mentioned: no index, so scan the repos I own or belong to (the inbox's set).
  const owned = mine.data?.owned ?? []
  const memberOf = [...owned, ...(mine.data?.member ?? [])]
  const watched = memberOf.slice(0, SCAN_REPOS_MAX)
  const scan = useAsync(
    async () => scanAssignedAndMentions(sdk!, forge!, me, await resolveDpnsName(sdk!, me, network), watched.map(repoLite)),
    [me, watched.map((r) => r.key).join(',')],
    { enabled: signedIn && mine.data !== null },
  )

  if (!isForgeDeployed()) {
    return (
      <AppShell wide>
        <NotDeployedState />
      </AppShell>
    )
  }

  return (
    <AppShell wide>
      <div className="space-y-10">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-2xl">
              <Compass className="h-6 w-6 text-forge-500" aria-hidden /> Explore
            </h1>
            <p className="mt-1 text-dense text-anvil-600 dark:text-anvil-300">Read straight from {NETWORKS[network].key}, proof-checked. No server ranks or filters this.</p>
          </div>
          <p role="note" className="flex items-center gap-2 rounded-md border border-anvil-200 px-3 py-1.5 text-dense text-anvil-600 dark:border-anvil-800 dark:text-anvil-300" data-testid="trending-note">
            <Info className="h-4 w-4 shrink-0 text-anvil-500" aria-hidden />
            <span>
              {TRENDING} (
              <a href={INDEXER_DOCS} className="text-forge-700 underline dark:text-forge-300" target="_blank" rel="noopener noreferrer">
                docs
              </a>
              ).
            </span>
          </p>
        </header>

        {sdkError ? <ErrorState title="Could not reach Platform" message={sdkError} /> : null}

        {signedIn ? (
          <div className="space-y-10" data-testid="explore-mine">
            <Section title="My repos" icon={GitBranch} state={mine} empty="You don't own any repos yet." emptyAction={<NewRepoLink />}>
              {() => (
                <>
                  <RepoGrid repos={owned} />
                  <FirstN shown={owned.length} cap={MY_REPOS_MAX} what="repos" order="by name" />
                </>
              )}
              {() => owned.length === 0}
            </Section>
            <Section title="Repos I maintain or write to" icon={UserCheck} state={mine} empty="No one has added you as a maintainer or writer.">
              {(d) => (
                <>
                  <RepoGrid repos={d.member} />
                  <FirstN shown={d.member.length} cap={MY_REPOS_MAX} what="memberships" order="newest first" />
                </>
              )}
              {(d) => d.member.length === 0}
            </Section>
            <Section title="My issues" icon={CircleDot} state={issues} empty="You haven't opened an issue.">
              {(d) => <TargetList rows={d.rows} more={d.more} />}
              {(d) => d.rows.length === 0}
            </Section>
            <Section title="My pull requests" icon={GitPullRequest} state={pulls} empty="You haven't opened a pull request.">
              {(d) => <TargetList rows={d.rows} more={d.more} />}
              {(d) => d.rows.length === 0}
            </Section>
            <Section title="Starred" icon={Star} state={stars} empty="You haven't starred a repo.">
              {(d) => <RepoLinks repos={d.repos} more={d.more} />}
              {(d) => d.repos.length === 0}
            </Section>
            <Section
              title="Assigned to me or mentioning me"
              icon={Info}
              state={scan}
              empty="Nothing assigned to you or mentioning you in the recent activity of your repos."
              note={`Partial by necessity: assignments and @mentions have no index. This looks only at the newest 100 events and 30 issues and 30 pull requests of ${
                watched.length < memberOf.length ? `${watched.length} of the ${memberOf.length} repos` : `the ${watched.length} repos`
              } you own or belong to, and at issue and pull request descriptions only (not comments).`}
              partial={(d) => (d.failed > 0 ? `${d.failed} of ${d.reposScanned} repos could not be read; results cover the rest.` : null)}
            >
              {(d) => (
                <div className="space-y-4">
                  {d.assigned.length > 0 ? <TargetList label="Assigned to you" rows={d.assigned} more={false} /> : null}
                  {d.mentioned.length > 0 ? <TargetList label="Mentions you" rows={d.mentioned} more={false} /> : null}
                </div>
              )}
              {(d) => d.assigned.length + d.mentioned.length === 0}
            </Section>
          </div>
        ) : on ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed border-anvil-300 px-4 py-3 text-dense dark:border-anvil-700">
            <span>Sign in to see your repos, issues, pull requests and stars.</span>
            <Button variant="primary" size="sm" onClick={() => openLogin()}>
              Sign in
            </Button>
          </div>
        ) : null}

        <Section title="Recent repos" icon={GitBranch} state={recent} empty="No repos on this network yet." emptyAction={<NewRepoLink />}>
          {(d) => <RepoGrid repos={d} />}
          {(d) => d.length === 0}
        </Section>

        <Section
          title="Recently released"
          icon={Package}
          state={releases}
          empty="None of the recent repos above has published a release."
          note="Releases have no cross-repo index, so this lists the newest release of each recent repo above. A full feed needs an indexer."
          partial={(d) => (d.failed > 0 ? `${d.failed} of ${d.total} repos could not be read; their releases are not shown.` : null)}
        >
          {(d) => (
            <ul className="divide-y divide-anvil-200 rounded-lg border border-anvil-200 dark:divide-anvil-800 dark:border-anvil-800">
              {d.rows.map((r) => (
                <li key={`${r.repo.id}:${r.tagName}`} className="flex flex-wrap items-center gap-2 px-4 py-2 text-dense">
                  <Package className="h-4 w-4 text-anvil-500" aria-hidden />
                  <Link href={repoHref('/repo/tags', { owner: r.repo.ownerId, name: r.repo.name, repoId: r.repo.id })} className="font-mono hover:underline">
                    {r.repo.name} {r.tagName}
                  </Link>
                  {r.name && r.name !== r.tagName ? <span className="text-anvil-600 dark:text-anvil-300">{r.name}</span> : null}
                  <span className="ml-auto text-[12px] text-anvil-500 dark:text-anvil-400">{timeAgo(r.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
          {(d) => d.rows.length === 0}
        </Section>
      </div>
    </AppShell>
  )
}

function NewRepoLink(): JSX.Element {
  return (
    <Link href="/new" className="text-dense text-forge-700 underline dark:text-forge-300">
      Create a repository
    </Link>
  )
}

/** A titled section over one async read: spinner, error with retry, honest empty, or data. */
function Section<T>({
  title,
  icon: Icon,
  state,
  empty,
  emptyAction,
  note,
  partial,
  children: [render, isEmpty],
}: {
  title: string
  icon: typeof Compass
  state: AsyncState<T>
  empty: string
  emptyAction?: ReactNode
  note?: string
  /** A "could not read all of it" line for the data, or null when it is complete. */
  partial?: (d: T) => string | null
  children: [(d: T) => ReactNode, (d: T) => boolean]
}): JSX.Element {
  const id = `explore-${title.toLowerCase().replace(/[^a-z]+/g, '-')}`
  return (
    <section aria-labelledby={id} data-testid={id}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 id={id} className="flex items-center gap-2 text-lg">
          <Icon className="h-4 w-4 text-forge-500" aria-hidden /> {title}
        </h2>
        {state.loading ? <Spinner label="Reading" /> : null}
      </div>
      {note ? <p className="mb-3 text-[12px] text-anvil-500 dark:text-anvil-400">{note}</p> : null}
      {state.error ? (
        <ErrorState message={state.error} onRetry={state.reload} />
      ) : state.data !== null ? (
        <>
          {partial?.(state.data) ? (
            <p role="note" className="mb-3 rounded-md border border-caution/30 bg-caution/5 px-3 py-1.5 text-[12px] text-anvil-700 dark:text-anvil-200" data-partial="true">
              {partial(state.data)}
            </p>
          ) : null}
          {isEmpty(state.data) ? (
          <div className="rounded-lg border border-dashed border-anvil-300 px-4 py-4 text-dense text-anvil-600 dark:border-anvil-700 dark:text-anvil-300" data-empty="true">
            {empty} {emptyAction}
          </div>
          ) : (
            render(state.data)
          )}
        </>
      ) : null}
    </section>
  )
}

/** "Showing the first N" when a capped read came back full. */
function FirstN({ shown, cap, what, order }: { shown: number; cap: number; what: string; order: string }): JSX.Element | null {
  if (shown < cap) return null
  return (
    <p className="mt-2 text-[12px] text-anvil-500 dark:text-anvil-400">
      Showing the first {cap} {what} ({order}); there may be more.
    </p>
  )
}

function RepoGrid({ repos }: { repos: readonly DiscoveredRepo[] }): JSX.Element {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {repos.map((r) => (
        <RepoCard key={r.key} repo={r} />
      ))}
    </div>
  )
}

function RepoLinks({ repos, more }: { repos: readonly RepoLite[]; more: boolean }): JSX.Element {
  return (
    <div>
      <ul className="flex flex-wrap gap-2">
        {repos.map((r) => (
          <li key={r.id}>
            <Link
              href={repoHref('/repo', { owner: r.ownerId, name: r.name, repoId: r.id })}
              className="inline-flex items-center gap-1.5 rounded-md border border-anvil-200 px-2.5 py-1 font-mono text-dense hover:border-forge-400 dark:border-anvil-800"
            >
              <Star className="h-3.5 w-3.5 text-anvil-500" aria-hidden /> {r.name}
            </Link>
          </li>
        ))}
      </ul>
      {more ? <p className="mt-2 text-[12px] text-anvil-500 dark:text-anvil-400">Showing the first {repos.length} stars (index order); there may be more.</p> : null}
    </div>
  )
}

function TargetList({ rows, more, label }: { rows: readonly TargetRow[]; more: boolean; label?: string }): JSX.Element {
  return (
    <div>
      {label ? <h3 className="mb-1.5 text-dense font-medium text-anvil-600 dark:text-anvil-300">{label}</h3> : null}
      <ul className="divide-y divide-anvil-200 rounded-lg border border-anvil-200 dark:divide-anvil-800 dark:border-anvil-800">
        {rows.map((t) => {
          const Icon = t.kind === 'issue' ? CircleDot : GitPullRequest
          const addr = t.repo ? { owner: t.repo.ownerId, name: t.repo.name, repoId: t.repo.id } : null
          return (
            <li key={t.id} className="flex flex-wrap items-center gap-2 px-4 py-2 text-dense">
              <Icon className="h-4 w-4 shrink-0 text-anvil-500" aria-hidden />
              <span className="sr-only">{t.kind === 'issue' ? 'Issue' : 'Pull request'}</span>
              {addr ? (
                <Link href={repoHref(t.kind === 'issue' ? '/repo/issue' : '/repo/pull', addr, { number: String(t.number) })} className="min-w-0 flex-1 truncate hover:underline">
                  <span className="font-mono text-anvil-500 dark:text-anvil-400">
                    {addr.name}#{t.number}
                  </span>{' '}
                  {t.title}
                </Link>
              ) : (
                <span className="min-w-0 flex-1 truncate">
                  #{t.number} {t.title} <span className="text-anvil-500">(repo not found)</span>
                </span>
              )}
              <span className="text-[12px] text-anvil-500 dark:text-anvil-400">{timeAgo(t.createdAt)}</span>
            </li>
          )
        })}
      </ul>
      {more ? (
        <p className="mt-2 text-[12px] text-anvil-500 dark:text-anvil-400">
          Read the first {rows.length} (in repo order, not by date); any past that are not shown.
        </p>
      ) : null}
    </div>
  )
}
