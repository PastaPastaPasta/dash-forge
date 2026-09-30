'use client'

/**
 * `/explore` (`ux-dx-spec.md` §5.11): search repos by name, trending (new stargazers this week or
 * today), most starred, recently updated,
 * recent repos (paged), recently released, and, signed in, my repos, the repos I maintain or
 * write to, my issues, my PRs, my stars, and what is assigned to me or mentions me. Every
 * section reads an index that answers it; where none exists the section says so rather than
 * implying it saw everything.
 *
 * Request budget, signed out: search 1 composite per page; trending, most starred and most forked
 * 2 each (a proved ranked read, then the ranked repos in one composite); recent 1
 * composite per page (its pushes feed "Recently updated", its first 24 repos "Recently released").
 */

import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { Suspense, useEffect, useMemo, useState, type ReactNode } from 'react'
import { CircleDot, Compass, Flame, Info, GitBranch, GitFork, GitPullRequest, History, Package, Search, Star, UserCheck } from 'lucide-react'
import { AppShell } from '@/components/app-shell'
import { SignInButton } from '@/components/sign-in-button'
import { RepoCard } from '@/components/repo-card'
import { Button } from '@/components/ui/button'
import { ErrorState, Spinner } from '@/components/ui/states'
import { DownloadProgressBar, UnreachableBanner } from '@/components/ui/platform-status'
import { NotDeployedState, isForgeDeployed } from '@/components/ui/network-badge'
import { useAuth } from '@/contexts/auth-context'
import { useAsync, type AsyncState } from '@/hooks/use-async'
import { repoHref } from '@/hooks/use-query-param'
import { useRepoPages, type RepoPages } from '@/hooks/use-repo-pages'
import { useSdk } from '@/hooks/use-sdk'
import { NETWORKS, type Network } from '@/lib/constants'
import { listReposByOwner, plural, resolveDpnsName, timeAgo, type DiscoveredRepo } from '@/lib/view'
import { rankedRepos, recentReposPage, recentlyUpdated, searchPrefix, searchRepos, PUSH_WINDOW_MS, type RankedRepos } from '@/lib/view/discovery'
import type { TrendingWindow } from '@/lib/repo/trending'
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

/** "My repos" and "maintain or write to" read at most this many each (listReposByOwner's page). */
const MY_REPOS_MAX = 50
/** The assignment / mention scan looks at this many repos (one feed read each, 3 at a time). */
const SCAN_REPOS_MAX = 20

/** "Trending", "Most starred" and "Recently updated" show this many. */
const TOP_N = 12

export function ExploreClient(): JSX.Element {
  const { sdk, ready, network, status: sdkStatus, retry: retrySdk } = useSdk()
  const { identity, locked } = useAuth()
  const forge = NETWORKS[network].v2
  const on = ready && sdk !== null && forge !== null

  const recent = useRepoPages<number>((after) => recentReposPage(sdk!, { network, after }), network, on)
  const [trendWindow, setTrendWindow] = useState<TrendingWindow>('week')
  const trending = useAsync(() => rankedRepos(sdk!, trendWindow, { network, limit: TOP_N }), [ready, network, trendWindow], { enabled: on })
  const starred = useAsync(() => rankedRepos(sdk!, 'most-starred', { network, limit: TOP_N }), [ready, network], { enabled: on })
  const forked = useAsync(() => rankedRepos(sdk!, 'most-forked', { network, limit: TOP_N }), [ready, network], { enabled: on })
  // Pushes rode along with the repos already read; rank those (the section says so).
  const updated = useMemo(
    () => recentlyUpdated([recent.repos, starred.data?.repos ?? [], trending.data?.repos ?? [], forked.data?.repos ?? []], TOP_N),
    [recent.repos, starred.data, trending.data, forked.data],
  )
  const recentRepos = recent.repos.slice(0, 24)
  const releases = useAsync(() => latestReleases(sdk!, forge!, recentRepos.map(repoLite)), [recentRepos.map((r) => r.key).join(',')], {
    enabled: on && recent.settled,
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
        </header>

        {sdkStatus.phase === 'error' ? (
          <UnreachableBanner status={sdkStatus} onRetry={retrySdk} cached={recent.settled} />
        ) : sdkStatus.phase === 'downloading' ? (
          <DownloadProgressBar status={sdkStatus} />
        ) : null}

        {/* Only the search reads the URL's query, so only it waits on Suspense: the page shell
            (and its skip link) is the static HTML, never swapped out on hydration. */}
        <Suspense fallback={null}>
          <ExploreSearch on={on} network={network} />
        </Suspense>

        <Section
          title={trendWindow === 'week' ? 'Trending this week' : 'Trending today'}
          testId="explore-trending"
          icon={Flame}
          state={trending}
          empty={trendWindow === 'week' ? 'Nobody starred a repo in the last week.' : 'Nobody has starred a repo today yet.'}
          emptyAction={<TrendWindowToggle value={trendWindow} onChange={setTrendWindow} />}
          note="Ranked by new stargazers in the window, proved by the network (a star counts toward Trending unless the starrer turned that off). An unstar does not take a count back before its week ends."
          partial={missingNote}
        >
          {(d) => (
            <>
              <TrendWindowToggle value={trendWindow} onChange={setTrendWindow} />
              <RankedGrid repos={d.repos} unit="new star" />
            </>
          )}
          {(d) => d.repos.length === 0}
        </Section>

        <Section
          title="Most starred"
          testId="explore-most-starred"
          icon={Star}
          state={starred}
          empty="No repo on this network has a star yet."
          note="All time, over every star on the network, proved by the ranked star index."
          partial={missingNote}
        >
          {(d) => <RankedGrid repos={d.repos} unit="star" />}
          {(d) => d.repos.length === 0}
        </Section>

        <Section
          title="Most forked"
          testId="explore-most-forked"
          icon={GitFork}
          state={forked}
          empty="No repo on this network has been forked yet."
          note="All time, over every fork on the network, proved by the ranked fork index."
          partial={missingNote}
        >
          {(d) => <RankedGrid repos={d.repos} unit="fork" />}
          {(d) => d.repos.length === 0}
        </Section>

        <Section
          title="Recently updated, among the repos on this page"
          testId="explore-recently-updated"
          icon={History}
          state={updatedState(recent, [starred, trending, forked], updated)}
          empty="None of the repos shown here was pushed to in the last week."
          note={`Pushes have no cross-repo index, so this ranks the recent, trending, most-starred and most-forked repos above by their newest push that uploaded objects in the last ${Math.round(PUSH_WINDOW_MS / 86_400_000)} days. Load more recent repos to widen it.`}
          partial={() =>
            recent.fallback
              ? 'This node refused the combined read, so recent repos came without their pushes and are not ranked here.'
              : recent.pushesComplete && (starred.data?.pushesComplete ?? true) && (trending.data?.pushesComplete ?? true) && (forked.data?.pushesComplete ?? true)
                ? null
                : 'Each read looks at the newest 100 pushes of its repos; repos whose pushes fell past those 100 are not ranked here.'
          }
        >
          {(d) => <RepoGrid repos={d} />}
          {(d) => d.length === 0}
        </Section>

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
                watched.length < memberOf.length ? `${watched.length} of the ${plural(memberOf.length, 'repo')}` : `the ${plural(watched.length, 'repo')}`
              } you own or belong to, and at issue and pull request descriptions only (not comments).`}
              partial={(d) => (d.failed > 0 ? `${d.failed} of ${plural(d.reposScanned, 'repo')} could not be read; results cover the rest.` : null)}
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
            <span>{locked ? 'Unlock' : 'Sign in'} to see your repos, issues, pull requests and stars.</span>
            <SignInButton size="sm" />
          </div>
        ) : null}

        <Section title="Recent repos" testId="explore-recent-repos" icon={GitBranch} state={pagesState(recent)} empty="No repos on this network yet." emptyAction={<NewRepoLink />}>
          {(d) => (
            <>
              <FallbackNote pages={recent} />
              <PagedGrid repos={d} pages={recent} what="repos" />
            </>
          )}
          {(d) => d.length === 0}
        </Section>

        <Section
          title="Recently released"
          icon={Package}
          state={releases}
          empty="None of the 24 newest repos has published a release."
          note="Releases have no cross-repo index, so this lists the newest release of each of the 24 newest repos. A full feed needs an indexer."
          partial={(d) => (d.failed > 0 ? `${d.failed} of ${plural(d.total, 'repo')} could not be read; their releases are not shown.` : null)}
        >
          {(d) => (
            <ul className="divide-y divide-anvil-200 rounded-lg border border-anvil-200 dark:divide-anvil-800 dark:border-anvil-800">
              {d.rows.map((r) => (
                <li key={`${r.repo.id}:${r.tagName}`} className="flex flex-wrap items-center gap-2 px-4 py-2 text-dense">
                  <Package className="h-4 w-4 text-anvil-500 dark:text-anvil-400" aria-hidden />
                  <Link href={repoHref('/repo/tags', { owner: r.repo.ownerId, name: r.repo.name, repoId: r.repo.id })} className="hit-area font-mono hover:underline">
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

/** The repo-name search: the box writes `?q=`, and the results page through the `repo.name` index. */
function ExploreSearch({ on, network }: { on: boolean; network: Network }): JSX.Element {
  const { sdk } = useSdk()
  // Search lives in the URL (`?q=`), so a search can be shared and survives a reload.
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const q = (params.get('q') ?? '').trim()
  const prefix = searchPrefix(q)
  const search = useRepoPages<string>((after) => searchRepos(sdk!, q, { network, after }), `${network}:${q}`, on && prefix !== null)
  return (
    <>
      <SearchBox
        initial={q}
        onSearch={(text) => {
          const next = new URLSearchParams(params.toString())
          if (text === '') next.delete('q')
          else next.set('q', text)
          const qs = next.toString()
          router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
        }}
      />
      {q !== '' ? (
        prefix === null ? (
          <p role="status" className="rounded-lg border border-dashed border-anvil-300 px-4 py-3 text-dense text-anvil-600 dark:border-anvil-700 dark:text-anvil-300" data-testid="explore-search-invalid">
            Repo names use only a-z, 0-9, dot, dash and underscore, so no repo name starts with “{q}”.
          </p>
        ) : (
          <Section
            title={`Repos starting with “${prefix}”`}
            testId="explore-search-results"
            icon={Search}
            state={pagesState(search)}
            empty={`No repo name starts with “${prefix}”.`}
            note="Matched on the repo name index, A to Z. Descriptions and code are not searched: that needs an indexer."
          >
            {(d) => (
              <>
                <FallbackNote pages={search} />
                <PagedGrid repos={d} pages={search} what="results" />
              </>
            )}
            {(d) => d.length === 0}
          </Section>
        )
      ) : null}
    </>
  )
}

function NewRepoLink(): JSX.Element {
  return (
    <Link href="/new/" className="hit-area text-dense text-forge-700 underline dark:text-forge-300">
      Create a repository
    </Link>
  )
}

type SectionState<T> = Pick<AsyncState<T>, 'data' | 'loading' | 'error' | 'reload'>

/** A titled section over one async read: spinner, error with retry, honest empty, or data. */
function Section<T>({
  title,
  testId,
  icon: Icon,
  state,
  empty,
  emptyAction,
  note,
  partial,
  children: [render, isEmpty],
}: {
  title: string
  /** The section's id and test id (default: from the title). */
  testId?: string
  icon: typeof Compass
  state: SectionState<T>
  empty: string
  emptyAction?: ReactNode
  note?: string
  /** A "could not read all of it" line for the data, or null when it is complete. */
  partial?: (d: T) => string | null
  children: [(d: T) => ReactNode, (d: T) => boolean]
}): JSX.Element {
  const id = testId ?? `explore-${title.toLowerCase().replace(/[^a-z]+/g, '-')}`
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

/** A paged list as a section's state: data once the first page settled. */
function pagesState(p: RepoPages): SectionState<DiscoveredRepo[]> {
  return { data: p.settled ? p.repos : null, loading: p.loading, error: p.settled ? null : p.error, reload: p.reload }
}

/** A ranked repo the ranked read named but whose `repo` document could not be read. */
function missingNote(d: RankedRepos): string | null {
  return d.missing > 0 ? `${plural(d.missing, 'ranked repo')} could not be read and ${d.missing === 1 ? 'is' : 'are'} not shown.` : null
}

/** Week (the oldest open window, a near-full trailing week) or today (the newest window). */
function TrendWindowToggle({ value, onChange }: { value: TrendingWindow; onChange: (v: TrendingWindow) => void }): JSX.Element {
  return (
    <div role="group" aria-label="Trending window" className="mb-3 inline-flex overflow-hidden rounded-md border border-anvil-200 text-dense dark:border-anvil-800">
      {(['week', 'today'] as const).map((w) => (
        <button
          key={w}
          type="button"
          aria-pressed={value === w}
          onClick={() => onChange(w)}
          className={`hit-area px-3 py-1 ${value === w ? 'bg-anvil-100 font-medium dark:bg-anvil-800' : 'text-anvil-600 dark:text-anvil-300'}`}
          data-testid={`trending-${w}`}
        >
          {w === 'week' ? 'This week' : 'Today'}
        </button>
      ))}
    </div>
  )
}

/** A ranked grid: the repo cards in the proved order, each with its count in the window. */
function RankedGrid({ repos, unit }: { repos: RankedRepos['repos']; unit: string }): JSX.Element {
  return (
    <ol className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="ranked-grid">
      {repos.map((r, i) => (
        <li key={r.key} className="relative" data-testid="ranked-row" data-repo-id={r.key} data-count={r.rankCount}>
          <span className="absolute right-2 top-2 z-10 rounded bg-anvil-100 px-1.5 font-mono text-[11px] text-anvil-600 dark:bg-anvil-800 dark:text-anvil-300" aria-label={`rank ${i + 1}, ${plural(r.rankCount, unit)}`}>
            #{i + 1} · {plural(r.rankCount, unit)}
          </span>
          <RepoCard repo={r} />
        </li>
      ))}
    </ol>
  )
}

/** "Recently updated" settles with the reads it ranks (recent, most starred and trending). */
function updatedState(recent: RepoPages, ranked: readonly AsyncState<unknown>[], rows: DiscoveredRepo[]): SectionState<DiscoveredRepo[]> {
  const settled = recent.settled && ranked.every((r) => r.data !== null || r.error !== null)
  return { data: settled ? rows : null, loading: recent.loading || ranked.some((r) => r.loading), error: recent.settled ? null : recent.error, reload: recent.reload }
}

/** The repo-name search box: submits into `?q=` (Enter or the button; empty clears it). */
function SearchBox({ initial, onSearch }: { initial: string; onSearch: (text: string) => void }): JSX.Element {
  const [text, setText] = useState(initial)
  useEffect(() => setText(initial), [initial])
  return (
    <form
      role="search"
      aria-label="Search repos"
      className="flex max-w-xl items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault()
        onSearch(text.trim())
      }}
    >
      <label htmlFor="explore-search" className="sr-only">
        Search repos by name
      </label>
      <div className="relative flex-1">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-anvil-500 dark:text-anvil-400" aria-hidden />
        <input
          id="explore-search"
          type="search"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Search repos by name (e.g. ripgrep)"
          autoComplete="off"
          spellCheck={false}
          className="h-9 w-full rounded-md border border-anvil-300 bg-white pl-8 pr-2 text-dense placeholder:text-anvil-500 focus-visible:border-forge-400 coarse:h-11 coarse:text-base dark:border-anvil-700 dark:bg-anvil-900 dark:placeholder:text-anvil-400"
        />
      </div>
      <Button type="submit" variant="primary" size="sm">
        Search
      </Button>
    </form>
  )
}

/** Say when a list came from the plain-query fallback (no counts) or skipped part of a tie. */
function FallbackNote({ pages }: { pages: RepoPages }): JSX.Element | null {
  const lines = [
    pages.fallback ? 'This node refused the combined read, so these repos show without star and issue counts.' : null,
    pages.skippedTies ? 'More than 100 repos share one boundary value here; some of them were skipped to keep paging.' : null,
  ].filter((l): l is string => l !== null)
  if (lines.length === 0) return null
  return (
    <p role="note" className="mb-3 rounded-md border border-caution/30 bg-caution/5 px-3 py-1.5 text-[12px] text-anvil-700 dark:text-anvil-200" data-partial="true">
      {lines.join(' ')}
    </p>
  )
}

/** A repo grid with "Load more" while the keyset has a next page (Retry instead after a failure). */
function PagedGrid({ repos, pages, what }: { repos: readonly DiscoveredRepo[]; pages: RepoPages; what: string }): JSX.Element {
  return (
    <div className="space-y-3">
      <RepoGrid repos={repos} />
      {pages.error ? <ErrorState message={pages.error} onRetry={pages.loadMore} /> : pages.hasMore ? (
        <Button variant="outline" size="sm" onClick={pages.loadMore} loading={pages.loading}>
          Load more {what}
        </Button>
      ) : null}
    </div>
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
              <Star className="h-3.5 w-3.5 text-anvil-500 dark:text-anvil-400" aria-hidden /> {r.name}
            </Link>
          </li>
        ))}
      </ul>
      {more ? <p className="mt-2 text-[12px] text-anvil-500 dark:text-anvil-400">Showing the first {plural(repos.length, 'star')} (index order); there may be more.</p> : null}
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
              <Icon className="h-4 w-4 shrink-0 text-anvil-500 dark:text-anvil-400" aria-hidden />
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
                  #{t.number} {t.title} <span className="text-anvil-500 dark:text-anvil-400">(repo not found)</span>
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
