'use client'

/**
 * PullsContent — the PR list (L-44), at parity with the Issues list: Open / Merged / Closed tabs
 * with exact counts, filters for label, author and assignee, sort, a search box with the Issues
 * qualifiers (plus `is:merged`), pages of {@link PULL_PAGE_SIZE}, label chips, assignees and
 * comment counts. Everything the list shows is in the URL, so a reload or a shared link shows the
 * same list.
 *
 * Reads go through the pull index (`lib/repo/pull-index`): one composite for the newest 100 PRs,
 * their comment counts and author names, the labels and the first feed page, and one proved sum
 * of their transitions for their states; the rest of the feed once per repo (shared with the
 * issue index); keyset composites of 100 for later pages (L-77). The tab counts are the proved
 * totals. The search box and filters are the Issues list's (`./list-controls`). Once the page is
 * shown, each row's head gets its CI status dot (`./check-dot`: three proved counts for the page, plus a run read per head whose re-runs disagree).
 *
 * "New pull request" opens `/repo/pulls/new` to propose an already-pushed branch.
 */

import { Byline } from '@/components/repo/byline'
import { useMirrorTrust } from '@/hooks/use-mirror-trust'
import { trustedOrigin } from '@/lib/repo/provenance'
import { useMemo } from 'react'
import Link from 'next/link'
import { GitMerge, GitPullRequest, GitPullRequestClosed, X } from 'lucide-react'
import type { RepoHome } from '@/lib/view'
import { branchName } from '@/lib/view'
import {
  PULL_PAGE_SIZE,
  emptyPullsBody,
  hasPullFilters,
  parsePullQuery,
  parsePullSearch,
  pullDroppedReason,
  pullQueryParams,
  pullSubmitBase,
  pullSearchText,
  unresolvedPullQualifiers,
  type PullListQuery,
} from '@/lib/view/pull-query'
import { queryPulls, repoContractIds, repoKey, rowFiltersOf, type PullListPage, type PullRow, type PullSelection } from '@/lib/repo'
import { pastLastPage } from '@/lib/view/issue-query'
import { useSdk } from '@/hooks/use-sdk'
import { useAsync } from '@/hooks/use-async'
import { useAuth } from '@/contexts/auth-context'
import { useRepoWriteGeneration } from '@/hooks/use-repo-chrome'
import { useRepoTotals } from '@/components/repo/use-repo-totals'
import { useMilestones } from '@/components/repo/use-milestones'
import {
  AuthorLoginNote,
  CommentCount,
  DroppedNote,
  LabelChipFilter,
  LabelFilter,
  MilestoneFilter,
  Pager,
  PastLastPage,
  PersonFilter,
  RowLink,
  SearchBox,
  SearchedNote,
  SortSelect,
  StateTab,
  tabCount,
  useListQuery,
  type ListGrammar,
} from '@/components/repo/list-controls'
import { AssigneeAvatars } from '@/components/repo/issue-bits'
import { CheckDot, useCheckOutcomes } from '@/components/repo/check-dot'
import { HiddenNote } from '@/components/repo/hidden-note'
import { MirrorNote } from '@/components/repo/mirror-note'
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/states'
import { repoHref, type RepoAddress } from '@/hooks/use-query-param'
import { cn } from '@/lib/utils'

/** The PR list's search grammar (`lib/view/pull-query`): a submit keeps the state tab. */
const PULL_GRAMMAR: ListGrammar<PullListQuery> = {
  text: pullSearchText,
  parse: parsePullSearch,
  unresolved: unresolvedPullQualifiers,
  submitBase: pullSubmitBase,
}

function pullStatus(p: PullRow): { label: string; icon: JSX.Element; klass: string } {
  // State is the proved transition sum, even when the event feed (labels, assignees) was incomplete.
  if (p.state.merged) return { label: 'Merged', icon: <GitMerge className="h-4 w-4" aria-hidden />, klass: 'text-dash' }
  if (!p.state.open) return { label: 'Closed', icon: <GitPullRequestClosed className="h-4 w-4" aria-hidden />, klass: 'text-danger-700 dark:text-danger-400' }
  if (p.state.draft) return { label: 'Draft', icon: <GitPullRequest className="h-4 w-4" aria-hidden />, klass: 'text-anvil-500 dark:text-anvil-400' }
  return { label: 'Open', icon: <GitPullRequest className="h-4 w-4" aria-hidden />, klass: 'text-verify-700 dark:text-verify-400' }
}

export function PullsContent({ home, addr }: { home: RepoHome; addr: RepoAddress }): JSX.Element {
  const { sdk, ready, network } = useSdk(repoContractIds(home.repo))
  const { identity } = useAuth()
  const generation = useRepoWriteGeneration(home.repo)
  const trust = useMirrorTrust(home.repo)
  const total = useRepoTotals(home.repo, 'pulls')
  const milestones = useMilestones(home.repo)

  // The list query lives in the URL (a reload or a shared link shows the same list).
  const { query, search } = useListQuery({ addr, parse: parsePullQuery, toParams: pullQueryParams, grammar: PULL_GRAMMAR, sdk, ready, network })
  const change = search.change

  // `me` needs a signed-in viewer; signed out, a `me` filter shows nothing rather than everything.
  const needsViewer = query.author === 'me' || query.assignee === 'me' || query.reviewRequested === 'me'
  // `author:<login>` matches only what a trusted mirror signed: the read waits for the trust set.
  const awaitingTrust = query.authorLogin !== null && trust === null
  const { data, loading, error, reload } = useAsync<PullListPage>(
    () => {
      const who = (v: string | null): string | null => (v === 'me' ? identity ?? '' : v)
      const selection: PullSelection = {
        state: query.state,
        labels: query.labels,
        author: who(query.author),
        assignee: who(query.assignee),
        sort: query.sort,
        text: query.q,
        page: query.page,
        pageSize: PULL_PAGE_SIZE,
        draft: query.draft,
        reviewRequested: who(query.reviewRequested),
        ...rowFiltersOf(query, trust),
      }
      return queryPulls(sdk!, home.repo, selection, total, network)
    },
    [ready, repoKey(home.repo), generation, JSON.stringify(query), identity ?? '', total ?? -1, query.authorLogin !== null && trust !== null ? [...trust].sort().join(',') : null],
    { enabled: ready && sdk !== null && (!needsViewer || identity !== null) && !awaitingTrust },
  )

  const labelDefs = useMemo(() => new Map((data?.labels ?? []).map((l) => [l.name, l])), [data])
  // The page's heads, for the status dots, read once the rows are shown. A row's head is the one
  // the list knows (the member feed's): a newer head the author pushed shows on the PR's page.
  const heads = useMemo(() => (data?.rows ?? []).map((p) => p.headOid), [data])
  const outcomes = useCheckOutcomes(home.repo, heads)
  const filtered = hasPullFilters(query)
  const lastPage = data !== null && data.rows.length === 0 ? pastLastPage(query.page, data.matching, PULL_PAGE_SIZE) : null
  const counts = data?.counts
  const settled = counts?.merged != null && counts.closed != null ? counts.merged + counts.closed : null

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <SearchBox id="pull-search" label="Search pull requests" search={search} placeholder="is:open label:bug author:@me" />
        <Link
          href={repoHref('/repo/pulls/new', addr)}
          className="inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-md bg-forge-700 px-2.5 text-dense font-medium text-white hover:bg-forge-800 coarse:h-11"
        >
          <GitPullRequest className="h-3.5 w-3.5" aria-hidden /> New pull request
        </Link>
      </div>
      <DroppedNote search={search} reason={pullDroppedReason(search.dropped, search.notFound)} testId="pull-search-dropped" />
      <AuthorLoginNote login={query.authorLogin} notFound={search.notFound} />

      <MirrorNote home={home} kind="pull" />

      {filtered ? (
        <button
          type="button"
          onClick={search.clear}
          className="mb-3 inline-flex items-center gap-1 text-dense text-anvil-500 hover:text-forge-700 dark:text-anvil-400 dark:hover:text-forge-400"
        >
          <X className="h-3.5 w-3.5" aria-hidden /> Clear filters
        </button>
      ) : null}

      <div className="overflow-hidden rounded-lg border border-anvil-200 dark:border-anvil-800">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-anvil-200 bg-anvil-50 px-4 py-2 dark:border-anvil-800 dark:bg-anvil-900">
          <div className="flex items-center gap-3" role="tablist" aria-label="Pull request state">
            <StateTab active={query.state === 'open'} onClick={() => change({ state: 'open' })}>
              <GitPullRequest className="h-3.5 w-3.5" aria-hidden /> {tabCount(counts?.open)}Open
            </StateTab>
            <StateTab active={query.state === 'merged'} onClick={() => change({ state: 'merged' })}>
              <GitMerge className="h-3.5 w-3.5" aria-hidden /> {tabCount(counts?.merged)}Merged
            </StateTab>
            <StateTab active={query.state === 'closed'} onClick={() => change({ state: 'closed' })}>
              <GitPullRequestClosed className="h-3.5 w-3.5" aria-hidden /> {tabCount(counts?.closed)}Closed
            </StateTab>
            <StateTab active={query.state === 'all'} onClick={() => change({ state: 'all' })}>
              All
            </StateTab>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <LabelFilter labels={data?.labels ?? []} selected={query.labels} onChange={(labels) => change({ labels })} />
            <MilestoneFilter milestones={milestones.data} value={query.milestone} none={query.noMilestone} onChange={(c) => change(c)} />
            <PersonFilter label="Author" value={query.author} signedIn={identity !== null} onChange={(author) => change({ author, authorLogin: null })} />
            <PersonFilter label="Assignee" value={query.assignee} signedIn={identity !== null} allowNone onChange={(assignee) => change({ assignee })} />
            <SortSelect id="pull-sort" value={query.sort} onChange={(sort) => change({ sort })} />
          </div>
        </div>

        {needsViewer && identity === null ? (
          <p className="px-4 py-6 text-dense text-anvil-500 dark:text-anvil-400">Sign in to filter by your own pull requests, assignments and review requests.</p>
        ) : (loading || awaitingTrust) && !data ? (
          <LoadingBlock label="Reading pull requests" />
        ) : error ? (
          <div className="p-4"><ErrorState message={error} onRetry={reload} /></div>
        ) : lastPage !== null ? (
          <PastLastPage page={query.page} last={lastPage} onPage={(page) => change({ page })} />
        ) : data !== null && data.rows.length === 0 ? (
          <EmptyState
            icon={GitPullRequest}
            title={filtered ? 'No pull requests match' : query.state === 'all' ? 'No pull requests yet' : `No ${query.state} pull requests`}
            body={emptyPullsBody(filtered, query.state, settled)}
          />
        ) : (
          <ul aria-label="Pull requests" aria-busy={loading}>
            {data?.rows.map((p) => {
              const st = pullStatus(p)
              return (
                <li key={p.id} className="flex items-start gap-3 border-b border-anvil-100 px-4 py-3 last:border-b-0 hover:bg-anvil-50 dark:border-anvil-850 dark:hover:bg-anvil-900" data-testid="pull-row" data-number={p.number}>
                  <span className={cn('mt-0.5 shrink-0', st.klass)}>{st.icon}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <RowLink href={repoHref('/repo/pull', addr, { number: String(p.number) })} title={p.title} />
                      <CheckDot counts={outcomes.get(p.headOid)} />
                      {p.state.labels.map((l) => (
                        <LabelChipFilter key={l} name={l} def={labelDefs.get(l)} selected={query.labels} onChange={(labels) => change({ labels })} />
                      ))}
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-anvil-500 dark:text-anvil-400">
                      <span className="font-mono">#{p.number}</span>
                      <span>{st.label} · into <span className="font-mono">{branchName(p.baseRefName) || '?'}</span> · opened by</span>
                      <Byline author={p.author} createdAt={p.createdAt} origin={trustedOrigin(p.origin, p.author, trust)} link={false} />
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-3 pt-0.5">
                    <AssigneeAvatars ids={p.state.assignees} />
                    <CommentCount n={p.comments} />
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      <SearchedNote searchedOf={data?.searchedOf} noun="pull requests" />
      {data !== null && !data.stateComplete ? (
        <p className="mt-2 text-[12px] text-danger-700 dark:text-danger-400">
          This repository&apos;s event history is too large to read completely, so labels and assignees are unverified.
        </p>
      ) : null}

      <Pager label="Pull request pages" page={query.page} hasNext={data?.hasNext ?? false} matching={data?.matching ?? null} pageSize={PULL_PAGE_SIZE} onPage={(page) => change({ page })} />

      <HiddenNote hidden={data?.hidden ?? 0} what={data?.hidden === 1 ? 'pull request' : 'pull requests'} home={home} by={data?.hiddenBy} />
    </div>
  )
}
