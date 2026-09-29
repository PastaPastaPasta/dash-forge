'use client'

/**
 * PullsContent — the PR list (L-44), at parity with the Issues list: Open / Merged / Closed tabs
 * with exact counts, filters for label, author and assignee, sort, a search box with the Issues
 * qualifiers (plus `is:merged`), pages of {@link PULL_PAGE_SIZE}, label chips, assignees and
 * comment counts. Everything the list shows is in the URL, so a reload or a shared link shows the
 * same list.
 *
 * Reads go through the pull index (`lib/repo/pull-index`): one composite for the newest 100 PRs,
 * their comment counts and author names, the labels and the first feed pages; the rest of the
 * feed once per repo (shared with the issue index and the header); keyset composites of 100 for
 * later pages (L-77). PR state is the FORGE_RULES fold with the historical-tips merge predicate.
 *
 * "New pull request" opens `/repo/pulls/new` to propose an already-pushed branch.
 */

import { Byline } from '@/components/repo/byline'
import { useMirrorTrust } from '@/hooks/use-mirror-trust'
import { trustedOrigin } from '@/lib/repo/provenance'
import { useMemo, useState, type FormEvent } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { GitMerge, GitPullRequest, GitPullRequestClosed, MessageSquare, Search, X } from 'lucide-react'
import type { RepoHome } from '@/lib/view'
import { branchName, plural } from '@/lib/view'
import {
  DEFAULT_PULL_QUERY,
  PULL_PAGE_SIZE,
  emptyPullsBody,
  hasPullFilters,
  parsePullQuery,
  parsePullSearch,
  pullQueryParams,
  pullSearchText,
  unresolvedPullQualifiers,
  type PullListQuery,
} from '@/lib/view/pull-query'
import { withQuery } from '@/lib/view/issue-query'
import { queryPulls, repoContractIds, repoKey, type PullListPage, type PullRow, type PullSelection } from '@/lib/repo'
import { useSdk } from '@/hooks/use-sdk'
import { useAsync } from '@/hooks/use-async'
import { useAuth } from '@/contexts/auth-context'
import { useRepoWriteGeneration } from '@/hooks/use-repo-chrome'
import { useRepoTotals } from '@/components/repo/use-repo-totals'
import { LabelFilter, Pager, PersonFilter, StateTab } from '@/components/repo/issues-content'
import { AssigneeAvatars, LabelChip } from '@/components/repo/issue-bits'
import { HiddenNote } from '@/components/repo/hidden-note'
import { MirrorNote } from '@/components/repo/mirror-note'
import { Input } from '@/components/ui/input'
import { Oid } from '@/components/ui/oid'
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/states'
import { repoHref, type RepoAddress } from '@/hooks/use-query-param'
import { cn } from '@/lib/utils'

function pullStatus(p: PullRow): { label: string; icon: JSX.Element; klass: string } {
  // A fold over a partial event log is not a state. Say unverified rather than guess.
  if (!p.stateComplete) return { label: 'Unverified', icon: <GitPullRequest className="h-4 w-4" aria-hidden />, klass: 'text-danger-700 dark:text-danger-400' }
  if (p.state.merged) return { label: 'Merged', icon: <GitMerge className="h-4 w-4" aria-hidden />, klass: 'text-dash' }
  if (!p.state.open) return { label: 'Closed', icon: <GitPullRequestClosed className="h-4 w-4" aria-hidden />, klass: 'text-danger-700 dark:text-danger-400' }
  if (p.state.draft) return { label: 'Draft', icon: <GitPullRequest className="h-4 w-4" aria-hidden />, klass: 'text-anvil-500 dark:text-anvil-400' }
  return { label: 'Open', icon: <GitPullRequest className="h-4 w-4" aria-hidden />, klass: 'text-verify-700 dark:text-verify-400' }
}

export function PullsContent({ home, addr }: { home: RepoHome; addr: RepoAddress }): JSX.Element {
  const { sdk, ready, network } = useSdk(repoContractIds(home.repo))
  const { identity } = useAuth()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const generation = useRepoWriteGeneration(home.repo)
  const trust = useMirrorTrust(home.repo)
  const total = useRepoTotals(home.repo, 'pulls')

  // The list query lives in the URL: parse it on every render, write it with router.replace.
  const query = useMemo(() => parsePullQuery(params), [params])
  const setQuery = (next: PullListQuery): void => {
    const q = new URLSearchParams({ owner: addr.owner, name: addr.name })
    if (addr.repoId) q.set('repo', addr.repoId)
    for (const [k, v] of pullQueryParams(next)) q.append(k, v)
    router.replace(`${pathname}?${q.toString()}`, { scroll: false })
  }
  const change = (c: Partial<PullListQuery>): void => setQuery(withQuery(query, c))

  // `me` needs a signed-in viewer; signed out, a `me` filter shows nothing rather than everything.
  const needsViewer = query.author === 'me' || query.assignee === 'me'
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
      }
      return queryPulls(sdk!, home.repo, selection, total, network)
    },
    [ready, repoKey(home.repo), generation, JSON.stringify(query), identity ?? '', total ?? -1],
    { enabled: ready && sdk !== null && (!needsViewer || identity !== null) },
  )

  const labelDefs = useMemo(() => new Map((data?.labels ?? []).map((l) => [l.name, l])), [data])
  const [search, setSearch] = useState<string | null>(null)
  const searchValue = search ?? pullSearchText(query)
  // Qualifiers typed (or linked in `?q=`) that could not be used: said, not silently dropped.
  const [dropped, setDropped] = useState<string[]>(() => unresolvedPullQualifiers(params.get('q') ?? ''))
  const submitSearch = (e: FormEvent): void => {
    e.preventDefault()
    setDropped(unresolvedPullQualifiers(searchValue))
    setQuery(parsePullSearch(searchValue))
    setSearch(null)
  }

  const count = (n: number | null | undefined): string => (n == null ? '' : `${n} `)
  const filtered = hasPullFilters(query)
  const counts = data?.counts
  const settled = counts?.merged != null && counts.closed != null ? counts.merged + counts.closed : null

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <form onSubmit={submitSearch} className="flex min-w-[16rem] flex-1 items-center gap-2" role="search">
          <label htmlFor="pull-search" className="sr-only">Search pull requests</label>
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-anvil-500 dark:text-anvil-400" aria-hidden />
            <Input id="pull-search" value={searchValue} onChange={(e) => setSearch(e.target.value)} className="pl-8 font-mono text-[13px]" placeholder="is:open label:bug author:@me" />
          </div>
        </form>
        <Link
          href={repoHref('/repo/pulls/new', addr)}
          className="inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-md bg-forge-700 px-2.5 text-dense font-medium text-white hover:bg-forge-800 coarse:h-11"
        >
          <GitPullRequest className="h-3.5 w-3.5" aria-hidden /> New pull request
        </Link>
      </div>
      {dropped.length > 0 ? (
        <p role="note" className="mb-3 text-[12px] text-caution-700 dark:text-caution-400" data-testid="pull-search-dropped">
          Not applied: {dropped.join(' ')}. Authors and assignees take an identity id or @me; mentions: is an Issues filter.
        </p>
      ) : null}

      <MirrorNote home={home} kind="pull" />

      {filtered ? (
        <button
          type="button"
          onClick={() => {
            setDropped([])
            setQuery({ ...DEFAULT_PULL_QUERY, state: query.state })
          }}
          className="mb-3 inline-flex items-center gap-1 text-dense text-anvil-500 hover:text-forge-700 dark:text-anvil-400 dark:hover:text-forge-400"
        >
          <X className="h-3.5 w-3.5" aria-hidden /> Clear filters
        </button>
      ) : null}

      <div className="overflow-hidden rounded-lg border border-anvil-200 dark:border-anvil-800">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-anvil-200 bg-anvil-50 px-4 py-2 dark:border-anvil-800 dark:bg-anvil-900">
          <div className="flex items-center gap-3" role="tablist" aria-label="Pull request state">
            <StateTab active={query.state === 'open'} onClick={() => change({ state: 'open' })}>
              <GitPullRequest className="h-3.5 w-3.5" aria-hidden /> {count(counts?.open)}Open
            </StateTab>
            <StateTab active={query.state === 'merged'} onClick={() => change({ state: 'merged' })}>
              <GitMerge className="h-3.5 w-3.5" aria-hidden /> {count(counts?.merged)}Merged
            </StateTab>
            <StateTab active={query.state === 'closed'} onClick={() => change({ state: 'closed' })}>
              <GitPullRequestClosed className="h-3.5 w-3.5" aria-hidden /> {count(counts?.closed)}Closed
            </StateTab>
            <StateTab active={query.state === 'all'} onClick={() => change({ state: 'all' })}>
              All
            </StateTab>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <LabelFilter labels={data?.labels ?? []} selected={query.labels} onChange={(labels) => change({ labels })} />
            <PersonFilter label="Author" value={query.author} signedIn={identity !== null} onChange={(author) => change({ author })} />
            <PersonFilter label="Assignee" value={query.assignee} signedIn={identity !== null} allowNone onChange={(assignee) => change({ assignee })} />
            <label className="sr-only" htmlFor="pull-sort">Sort</label>
            <select
              id="pull-sort"
              value={query.sort}
              onChange={(e) => change({ sort: e.target.value as PullListQuery['sort'] })}
              className="rounded-md border border-anvil-300 bg-white px-2 py-1 text-dense dark:border-anvil-700 dark:bg-anvil-950 coarse:h-11"
            >
              <option value="newest">Newest</option>
              <option value="oldest">Oldest</option>
              <option value="comments">Most commented</option>
            </select>
          </div>
        </div>

        {needsViewer && identity === null ? (
          <p className="px-4 py-6 text-dense text-anvil-500 dark:text-anvil-400">Sign in to filter by your own pull requests and assignments.</p>
        ) : loading && !data ? (
          <LoadingBlock label="Reading pull requests" />
        ) : error ? (
          <div className="p-4"><ErrorState message={error} onRetry={reload} /></div>
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
                      <Link href={repoHref('/repo/pull', addr, { number: String(p.number) })} className="hit-area text-dense font-medium text-anvil-900 hover:text-forge-700 dark:text-anvil-50 dark:hover:text-forge-400">
                        {p.title || '(untitled)'}
                      </Link>
                      {p.state.labels.map((l) => (
                        <button key={l} type="button" onClick={() => change({ labels: query.labels.includes(l) ? query.labels : [...query.labels, l] })} aria-label={`Filter by label ${l}`} className="hit-area">
                          <LabelChip name={l} def={labelDefs.get(l)} />
                        </button>
                      ))}
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-anvil-500 dark:text-anvil-400">
                      <span className="font-mono">#{p.number}</span>
                      <span>{st.label} · into <span className="font-mono">{branchName(p.baseRefName) || '?'}</span> · opened by</span>
                      <Byline author={p.author} createdAt={p.createdAt} origin={trustedOrigin(p.origin, p.author, trust)} link={false} />
                      {p.headOid ? <Oid value={p.headOid} chars={7} copyable={false} /> : null}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-3 pt-0.5">
                    <AssigneeAvatars ids={p.state.assignees} />
                    {p.comments ? (
                      <span className="inline-flex items-center gap-1 text-[12px] text-anvil-500 dark:text-anvil-400" data-testid="pull-comments">
                        <MessageSquare className="h-3.5 w-3.5" aria-hidden /> <span aria-hidden>{p.comments}</span>
                        <span className="sr-only">{plural(p.comments, 'comment')}</span>
                      </span>
                    ) : null}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      {data?.searchedOf ? (
        <p className="mt-2 text-[12px] text-anvil-500 dark:text-anvil-400">
          Searched the newest {data.searchedOf.searched}
          {data.searchedOf.total !== null ? ` of ${data.searchedOf.total}` : ''} pull requests; older ones were not read for this search.
        </p>
      ) : null}
      {data !== null && !data.stateComplete ? (
        <p className="mt-2 text-[12px] text-danger-700 dark:text-danger-400">
          This repository&apos;s event history is too large to read completely, so states, labels and assignees are unverified.
        </p>
      ) : null}

      <Pager
        label="Pull request pages"
        page={query.page}
        hasNext={data?.hasNext ?? false}
        pages={data?.matching != null ? Math.max(1, Math.ceil(data.matching / PULL_PAGE_SIZE)) : null}
        onPage={(page) => change({ page })}
      />

      <HiddenNote hidden={data?.hidden ?? 0} what={data?.hidden === 1 ? 'pull request' : 'pull requests'} home={home} by={data?.hiddenBy} />
    </div>
  )
}
