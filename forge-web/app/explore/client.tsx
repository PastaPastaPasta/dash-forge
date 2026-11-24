'use client'

/**
 * `/explore` (`ux-dx-spec.md` §5.11): search repos by name, trending (new stargazers this week or
 * today), most starred, recently active,
 * recent repos (paged), recently released, and, signed in, my repos, the repos I maintain or
 * write to, my issues, my PRs, my stars, and what is assigned to me or mentions me. Every
 * section reads an index that answers it; where none exists the section says so rather than
 * implying it saw everything.
 *
 * `?topic=` lists the public repos tagged with a topic (the `topic` documents' name index), newest
 * tag first; a repo's topic chips link there.
 *
 * Request budget, signed out: search 1 composite per page; a topic 2 (its tags, then those repos); trending, most starred and most forked
 * 2 each (a proved ranked read, then the ranked repos in one composite); recent 1
 * composite per page (its pushes feed "Recently active", its first 24 repos "Recently released").
 */

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { usePathname, useSearchParams } from '@/hooks/use-route'
import { Suspense, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Award, CircleDot, Compass, Flame, Hash, Info, GitBranch, GitFork, GitPullRequest, History, Package, Search, Star, UserCheck, X } from 'lucide-react'
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
import { ACTIVE_NETWORK, NETWORKS, networkName, type Network } from '@/lib/constants'
import { dropTestFixtures, isTestFixture, listShowcaseRepos, showcaseFor } from '@/lib/view/showcase'
import { ForgeIntro } from '@/components/forge-intro'
import { listReposByOwner, plural, resolveDpnsName, timeAgo, type DiscoveredRepo } from '@/lib/view'
import { MIN_STARGAZERS } from '@/lib/repo/trending'
import { curates } from '@/lib/view/curation'
import { DOCS } from '@/lib/docs-links'
import { rankedRepos, recentReposPage, recentlyActive, reposWithTopic, searchPrefix, searchRepos, PUSH_WINDOW_MS, REPO_PAGE, TOPIC_PAGE, type RankedRepos } from '@/lib/view/discovery'
import { MAX_TOPIC_CHARS, TOPIC_PATTERN } from '@/lib/repo/settings'
import { trendingNote, trendingWindowStart, type TrendingWindow } from '@/lib/repo/trending'
import { useStarShape } from '@/hooks/use-star-shape'
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

/** Explore reads on past test fixtures until "Recent repos" shows this many, at most FILL_PAGES pages in all. */
const FILL_SHOWN = 6
const FILL_PAGES = 4

/** "Trending", "Most starred" and "Recently active" show this many. */
const TOP_N = 12

/** What both star rankings say about their counts (ABU-02). */
const UNWEIGHTED = 'Counts are unweighted: every identity counts once, however new.'
const TRENDING_FLOOR = `A repo needs ${MIN_STARGAZERS} new stars to be listed. ${UNWEIGHTED}`
const STARRED_FLOOR = `A repo needs ${MIN_STARGAZERS} stars to be listed. ${UNWEIGHTED}`

export function ExploreClient(): JSX.Element {
  const { sdk, ready, network, status: sdkStatus, retry: retrySdk } = useSdk()
  const { identity, locked } = useAuth()
  const forge = NETWORKS[network].v2
  const on = ready && sdk !== null && forge !== null

  const recent = useRepoPages<number>((after) => recentReposPage(sdk!, { network, after }), network, on)
  // QW-045: the network's showcase repos lead Explore too, as on the landing page (one read).
  const hasShowcase = showcaseFor(ACTIVE_NETWORK.key).length > 0
  const featured = useAsync(() => listShowcaseRepos(sdk!, network, ACTIVE_NETWORK.key), [ready, network], { enabled: on && hasShowcase })
  const [trendWindow, setTrendWindow] = useState<TrendingWindow>('week')
  const trending = useAsync(() => rankedRepos(sdk!, trendWindow, { network, limit: TOP_N }), [ready, network, trendWindow], { enabled: on })
  // The note follows the deployment's star shape, as Settings → Stars does (QW4-018).
  const starShape = useStarShape(forge)
  // "Today" is the UTC day so far (the index's grid), so the title and the empty line say so
  // (QW4-019). The clock is read after hydration: the static HTML is built without one.
  // Re-read with each Trending result, so the window named is the one the read selected.
  const [now, setNow] = useState<number | null>(null)
  useEffect(() => setNow(Date.now()), [trendWindow, trending.data])
  const todayStart = useMemo(() => (now !== null && trendWindow === 'today' ? trendingWindowStart('today', now) : null), [now, trendWindow])
  const trendNote = useMemo(() => trendingNote(starShape, trendWindow, now), [starShape, trendWindow, now])
  const starred = useAsync(() => rankedRepos(sdk!, 'most-starred', { network, limit: TOP_N }), [ready, network], { enabled: on })
  const forked = useAsync(() => rankedRepos(sdk!, 'most-forked', { network, limit: TOP_N }), [ready, network], { enabled: on })
  // The automated tests' fixture repos are left out of every list here (F15); search finds them.
  const recentShown = useMemo(() => dropTestFixtures(recent.repos), [recent.repos])
  const fixturesLeftOut = [recent.repos, trending.data?.repos ?? [], starred.data?.repos ?? [], forked.data?.repos ?? []].some((l) => l.some(isTestFixture))
  const trendingShown = withoutFixtures(trending)
  const starredShown = withoutFixtures(starred)
  const forkedShown = withoutFixtures(forked)
  // Pushes rode along with the repos already read; rank those by activity (the section says so).
  const active = useMemo(
    () => recentlyActive([recentShown, ...[starred.data, trending.data, forked.data].map((d) => dropTestFixtures(d?.repos ?? []))], TOP_N),
    [recentShown, starred.data, trending.data, forked.data],
  )
  // Nothing on the network but test fixtures (or nothing at all): say what Forge is and how to start.
  const quiet = recent.settled && !recent.hasMore && recentShown.length === 0
  // A page of nothing but fixtures would leave "Recent repos" a bare "Load more": read on by
  // itself, at most FILL_PAGES page reads in all (counted, however few rows each kept), until it
  // has real repos to show.
  const [fills, setFills] = useState({ network, n: 0 })
  const autoFills = fills.network === network ? fills.n : 0
  const filling = recent.settled && !recent.loading && recent.error === null && recent.hasMore && recentShown.length < FILL_SHOWN && autoFills < FILL_PAGES - 1
  useEffect(() => {
    if (!filling) return
    setFills({ network, n: autoFills + 1 })
    recent.loadMore()
  }, [filling, recent, network, autoFills])
  // The first page's repos, read once (later pages do not re-read releases).
  const recentRepos = useMemo(() => dropTestFixtures(recent.repos.slice(0, REPO_PAGE)), [recent.repos])
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
    async () => scanAssignedAndMentions(sdk!, forge!, network, me, await resolveDpnsName(sdk!, me, network), watched.map(repoLite)),
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
      <div className="space-y-8">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-2xl">
              <Compass className="h-6 w-6 text-fg-muted" aria-hidden /> Explore
            </h1>
            <p className="mt-1 text-dense text-anvil-600 dark:text-anvil-300">
              Verified in your browser on {networkName(NETWORKS[network])}.
            </p>
            {curates() || fixturesLeftOut ? (
              <details className="mt-1 text-[12px] text-anvil-500 dark:text-anvil-400">
                <summary className="w-fit cursor-pointer hover:text-anvil-700 coarse:inline-flex coarse:min-h-11 coarse:items-center dark:hover:text-anvil-200">
                  About these lists
                </summary>
                <p className="mt-1">
                  {curates() ? (
                    <>
                      This site hides some repos from these lists; they stay on Dash Platform.{' '}
                      <Link href={DOCS.hostedCuration} className="hit-area text-forge-700 underline dark:text-forge-400" data-testid="explore-curation-link">
                        What that means
                      </Link>
                      .{' '}
                    </>
                  ) : null}
                  {fixturesLeftOut ? (
                    <span data-testid="explore-fixtures-note">Automated test repos (e2e-…) are left out; search still finds them.</span>
                  ) : null}
                </p>
              </details>
            ) : null}
          </div>
        </header>

        {sdkStatus.phase === 'error' ? (
          <UnreachableBanner status={sdkStatus} onRetry={retrySdk} cached={recent.settled} />
        ) : sdkStatus.phase === 'downloading' ? (
          <DownloadProgressBar status={sdkStatus} />
        ) : null}

        <Suspense fallback={null}>
          <ExploreSearch on={on} network={network} />
        </Suspense>

        {hasShowcase ? (
          <Section
            title="Featured"
            testId="explore-featured"
            icon={Award}
            state={featured}
            empty="None of the featured repos could be read on this network."
            note="Picked by the Dash Forge maintainers for this network."
          >
            {(d) => <RepoGrid repos={d} />}
            {(d) => d.length === 0}
          </Section>
        ) : null}

        {quiet ? <ForgeIntro title="No projects on this network yet" heading="h2" testId="explore-intro" /> : null}

        <Section
          title="Recently active"
          testId="explore-recently-updated"
          icon={History}
          state={activeState(recent, [starredShown, trendingShown, forkedShown], active)}
          empty="No repos to show yet."
          note={`Newest first, by a push in the last ${Math.round(PUSH_WINDOW_MS / 86_400_000)} days or else by creation. Pushes have no cross-repo index, so this ranks only the repos read on this page; load more recent repos to widen it.`}
          partial={() =>
            recent.fallback
              ? 'This node refused the combined read, so recent repos came without their pushes and are ranked by when they were created.'
              : recent.pushesComplete && (starred.data?.pushesComplete ?? true) && (trending.data?.pushesComplete ?? true) && (forked.data?.pushesComplete ?? true)
                ? null
                : 'Each read looks at the newest 100 pushes of its repos; a push past those 100 is not counted here.'
          }
        >
          {(d) => <RepoGrid repos={d} />}
          {(d) => d.length === 0}
        </Section>

        <Section
          title={trendWindow === 'week' ? 'Trending this week' : 'Trending today (UTC)'}
          testId="explore-trending"
          icon={Flame}
          state={trendingShown}
          headerAction={<TrendWindowToggle value={trendWindow} onChange={setTrendWindow} />}
          empty={onlyFixtures(trending) ? ONLY_FIXTURES : trendWindow === 'week' ? `No repo has ${MIN_STARGAZERS} new stars in the last week.` : `No repo has ${MIN_STARGAZERS} new stars since ${todayStart ?? '00:00 UTC'} yet.`}
          note={`${trendNote} ${TRENDING_FLOOR}`}
          partial={missingNote}
        >
          {(d) => <RankedGrid repos={d.repos} unit="new star" />}
          {(d) => d.repos.length === 0}
        </Section>

        <Section
          title="Most starred"
          testId="explore-most-starred"
          icon={Star}
          state={starredShown}
          empty={onlyFixtures(starred) ? ONLY_FIXTURES : `No repo on this network has ${MIN_STARGAZERS} stars yet.`}
          note={`All time, over every star on the network, proved by the ranked star index. ${STARRED_FLOOR}`}
          partial={missingNote}
        >
          {(d) => <RankedGrid repos={d.repos} unit="star" />}
          {(d) => d.repos.length === 0}
        </Section>

        <Section
          title="Most forked"
          testId="explore-most-forked"
          icon={GitFork}
          state={forkedShown}
          empty={onlyFixtures(forked) ? ONLY_FIXTURES : 'No repo on this network has been forked yet.'}
          note="All time, ranked by how many different identities forked a repo, not by how many forks exist. A fork counts when it exists; forks are not checked for a push. Counts are unweighted."
          partial={(d) =>
            missingNote(d) ??
            (d.approximate ? 'A repo with more than 100 forks is counted from its first 100, so its count is a lower bound.' : null) ??
            (d.incomplete ? 'Only the most forked repos by raw fork count were examined, so one with fewer forks from more different owners may be missing.' : null)
          }
        >
          {(d) => <RankedGrid repos={d.repos} unit="fork" />}
          {(d) => d.repos.length === 0}
        </Section>


        {signedIn ? (
          <div className="space-y-8" data-testid="explore-mine">
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
              note={`Recent issues and pull requests in ${
                watched.length < memberOf.length ? `${watched.length} of your ${plural(memberOf.length, 'repo')}` : `your ${plural(watched.length, 'repo')}`
              }. Comments aren't searched yet.`}
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
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-anvil-200 px-4 py-2.5 text-dense dark:border-anvil-800">
            <span className="text-anvil-600 dark:text-anvil-300">{locked ? 'Unlock' : 'Sign in'} to see your repos, issues, pull requests and stars.</span>
            <SignInButton size="sm" variant="outline" />
          </div>
        ) : null}

        <Section title="Recent repos" testId="explore-recent-repos" icon={GitBranch} state={pagesState(recent, recentShown)} empty="No repos on this network yet." emptyAction={<NewRepoLink />}>
          {(d) => (
            <>
              <span hidden data-testid="explore-recent-read" data-read={recent.repos.length} data-pages={1 + autoFills} />
              <FallbackNote pages={recent} />
              <PagedGrid repos={d} pages={recent} what="repos" />
            </>
          )}
          {(d) => d.length === 0 && !recent.hasMore}
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
  const topic = (params.get('topic') ?? '').trim().toLowerCase()
  const topicValid = TOPIC_PATTERN.test(topic) && topic.length <= MAX_TOPIC_CHARS
  const tagged = useAsync(() => reposWithTopic(sdk!, topic, { network }), [network, topic], { enabled: on && topicValid })
  const clearTopic = (): void => {
    const next = new URLSearchParams(params.toString())
    next.delete('topic')
    const qs = next.toString()
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
  }
  return (
    <>
      {topic !== '' ? (
        topicValid ? (
          <Section
            title={`Repos tagged “${topic}”`}
            testId="explore-topic"
            icon={Hash}
            state={tagged}
            empty={`No public repo is tagged “${topic}”.`}
            emptyAction={<ClearTopic onClear={clearTopic} />}
            note="Every public repo whose owner gave it this topic, newest tag first, proved by the topic index. A private repo's topics are never listed."
            partial={(d) =>
              d.more ? `Showing the newest ${TOPIC_PAGE} repos tagged “${topic}”; more carry it.` : d.missing > 0 ? `${plural(d.missing, 'tagged repo')} could not be read.` : null
            }
          >
            {(d) => (
              <>
                <ClearTopic onClear={clearTopic} />
                <RepoGrid repos={d.repos} />
              </>
            )}
            {(d) => d.repos.length === 0}
          </Section>
        ) : (
          <p role="status" className="rounded-lg border border-dashed border-anvil-300 px-4 py-3 text-dense text-anvil-600 dark:border-anvil-700 dark:text-anvil-300" data-testid="explore-topic-invalid">
            “{topic}” is not a topic: topics are up to {MAX_TOPIC_CHARS} of a–z and 0–9, words joined by single dashes.
          </p>
        )
      ) : null}
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
            {(d) => d.length === 0 && !search.hasMore}
          </Section>
        )
      ) : null}
    </>
  )
}

function ClearTopic({ onClear }: { onClear: () => void }): JSX.Element {
  return (
    <button type="button" onClick={onClear} className="mb-3 inline-flex items-center gap-1 text-dense text-anvil-600 hover:text-forge-700 coarse:min-h-11 dark:text-anvil-300 dark:hover:text-forge-400">
      <X className="h-3.5 w-3.5" aria-hidden /> Clear topic
    </button>
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

function Section<T>({
  title,
  testId,
  icon: Icon,
  state,
  empty,
  emptyAction,
  headerAction,
  note,
  partial,
  children: [render, isEmpty],
}: {
  title: string
  testId?: string
  icon: typeof Compass
  state: SectionState<T>
  empty: string
  emptyAction?: ReactNode
  headerAction?: ReactNode
  note?: string
  partial?: (d: T) => string | null
  children: [(d: T) => ReactNode, (d: T) => boolean]
}): JSX.Element {
  const id = testId ?? `explore-${title.toLowerCase().replace(/[^a-z]+/g, '-')}`
  return (
    <section aria-labelledby={id} data-testid={id}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 id={id} className="flex items-center gap-2 text-lg">
          <Icon className="h-4 w-4 text-fg-muted" aria-hidden /> {title}
        </h2>
        {state.loading ? <Spinner label="Reading" /> : null}
        {headerAction ? <div className="ml-auto">{headerAction}</div> : null}
      </div>
      {state.error ? (
        <ErrorState message={state.error} onRetry={state.reload} />
      ) : state.data !== null ? (
        <>
          {partial?.(state.data) ? (
            <p role="note" className="mb-2 text-[12px] text-anvil-500 dark:text-anvil-400" data-partial="true">
              {partial(state.data)}
            </p>
          ) : null}
          {isEmpty(state.data) ? (
            <p className="text-dense text-anvil-500 dark:text-anvil-400" data-empty="true">
              {empty} {emptyAction}
            </p>
          ) : (
            render(state.data)
          )}
        </>
      ) : null}
      {note ? (
        <details className="mt-2 text-[12px] text-anvil-500 dark:text-anvil-400">
          <summary className="w-fit cursor-pointer hover:text-anvil-700 coarse:inline-flex coarse:min-h-11 coarse:min-w-11 coarse:items-center dark:hover:text-anvil-200">
            About {title.toLowerCase()}
          </summary>
          <p className="mt-1 max-w-2xl">{note}</p>
        </details>
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

/** A paged list as a section's state: data (`shown`, default all it read) once the first page settled. */
function pagesState(p: RepoPages, shown: DiscoveredRepo[] = p.repos): SectionState<DiscoveredRepo[]> {
  return { data: p.settled ? shown : null, loading: p.loading, error: p.settled ? null : p.error, reload: p.reload }
}

/** A ranked list that read only test fixtures: its empty line must not say nothing ranks. */
const ONLY_FIXTURES = 'Only repos made by Forge\'s automated tests rank here so far.'

function onlyFixtures(s: AsyncState<RankedRepos>): boolean {
  return s.data !== null && s.data.repos.length > 0 && s.data.repos.every(isTestFixture)
}

/** A ranked read's state without the test fixtures (F15). */
function withoutFixtures<T extends { readonly repos: readonly DiscoveredRepo[] }>(s: AsyncState<T>): AsyncState<T> {
  return s.data === null ? s : { ...s, data: { ...s.data, repos: dropTestFixtures(s.data.repos) } as T }
}

/** A ranked repo the ranked read named but whose `repo` document could not be read. */
function missingNote(d: RankedRepos): string | null {
  return d.missing > 0 ? `${plural(d.missing, 'ranked repo')} could not be read and ${d.missing === 1 ? 'is' : 'are'} not shown.` : null
}

function TrendWindowToggle({ value, onChange }: { value: TrendingWindow; onChange: (v: TrendingWindow) => void }): JSX.Element {
  return (
    <div role="group" aria-label="Trending window" className="inline-flex overflow-hidden rounded-md border border-anvil-200 text-dense dark:border-anvil-800">
      {(['week', 'today'] as const).map((w) => (
        <button
          key={w}
          type="button"
          aria-pressed={value === w}
          onClick={() => onChange(w)}
          className={`px-3 py-1 coarse:min-h-11 ${value === w ? 'bg-anvil-100 font-medium dark:bg-anvil-800' : 'text-anvil-600 dark:text-anvil-300'}`}
          data-testid={`trending-${w}`}
        >
          {w === 'week' ? 'This week' : 'Today (UTC)'}
        </button>
      ))}
    </div>
  )
}

/** A ranked grid: the repo cards in the proved order, each with its count in the window. */
function RankedGrid({ repos, unit }: { repos: RankedRepos['repos']; unit: string }): JSX.Element {
  return (
    <ol className="grid grid-cols-1 gap-3 sm:auto-rows-fr sm:grid-cols-2 lg:grid-cols-3" data-testid="ranked-grid">
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

/** "Recently active" settles with the reads it ranks (recent, most starred, trending, most forked). */
function activeState(recent: RepoPages, ranked: readonly AsyncState<unknown>[], rows: DiscoveredRepo[]): SectionState<DiscoveredRepo[]> {
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
        Search repositories by the start of their name
      </label>
      <div className="relative flex-1">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-anvil-500 dark:text-anvil-400" aria-hidden />
        <input
          id="explore-search"
          type="search"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Search repos by the start of their name…"
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
      {repos.length === 0 && pages.hasMore ? (
        <p className="text-dense text-anvil-500 dark:text-anvil-400" data-testid="explore-page-hidden">
          Nothing read so far is shown here: test repos, and any this site hides, are left out. Load more to keep reading.
        </p>
      ) : (
        <RepoGrid repos={repos} />
      )}
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
    <div className="grid grid-cols-1 gap-3 sm:auto-rows-fr sm:grid-cols-2 lg:grid-cols-3">
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
