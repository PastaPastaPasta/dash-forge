'use client'

/**
 * PullsContent — the patch (PR) list with folded PR state (open/draft/merged/closed). PR state
 * is the FORGE_RULES fold of the event log including the historical-tips merge predicate (core
 * listPulls). Composing PRs from the browser needs a pushed head branch (helper); the web app
 * lists, reviews, and merges.
 */

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { GitPullRequest, GitMerge, GitPullRequestClosed } from 'lucide-react'
import type { RepoHome } from '@/lib/view'
import type { PullView } from '@/lib/repo'
import { listPulls } from '@/lib/repo'
import { timeAgo } from '@/lib/view'
import { useSdk } from '@/hooks/use-sdk'
import { useAsync } from '@/hooks/use-async'
import { Author } from '@/components/author'
import { Oid } from '@/components/ui/oid'
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/states'
import { repoHref, type RepoAddress } from '@/hooks/use-query-param'
import { cn } from '@/lib/utils'

type Filter = 'open' | 'closed' | 'all'

function pullStatus(p: PullView): { label: string; icon: JSX.Element; klass: string } {
  if (p.state.merged) return { label: 'Merged', icon: <GitMerge className="h-4 w-4" aria-hidden />, klass: 'text-dash' }
  if (!p.state.open) return { label: 'Closed', icon: <GitPullRequestClosed className="h-4 w-4" aria-hidden />, klass: 'text-danger' }
  if (p.state.draft) return { label: 'Draft', icon: <GitPullRequest className="h-4 w-4" aria-hidden />, klass: 'text-anvil-400' }
  return { label: 'Open', icon: <GitPullRequest className="h-4 w-4" aria-hidden />, klass: 'text-verify' }
}

export function PullsContent({ home, addr }: { home: RepoHome; addr: RepoAddress }): JSX.Element {
  const { sdk, ready } = useSdk([home.repo.contractId])
  const [filter, setFilter] = useState<Filter>('open')
  const { data, loading, error, reload } = useAsync<PullView[]>(
    () => listPulls(sdk!, home.repo, undefined, 100),
    [ready, home.repo.contractId],
    { enabled: ready && sdk !== null },
  )

  const filtered = useMemo(() => {
    if (!data) return []
    if (filter === 'all') return data
    return data.filter((p) => (filter === 'open' ? p.state.open : !p.state.open))
  }, [data, filter])

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-4 inline-flex rounded-md border border-anvil-200 p-0.5 dark:border-anvil-750">
        {(['open', 'closed', 'all'] as Filter[]).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={cn(
              'rounded px-3 py-1.5 text-dense font-medium capitalize transition-colors',
              filter === f ? 'bg-anvil-100 text-anvil-900 dark:bg-anvil-800 dark:text-anvil-50' : 'text-anvil-500 hover:text-anvil-800 dark:text-anvil-400',
            )}
          >
            {f}
          </button>
        ))}
      </div>

      {loading ? (
        <LoadingBlock label="Folding PR state" />
      ) : error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={GitPullRequest}
          title="No pull requests"
          body="Open a PR by pushing a head branch with the helper, then propose it here."
        />
      ) : (
        <div className="overflow-hidden rounded-lg border border-anvil-200 dark:border-anvil-800">
          {filtered.map((p) => {
            const st = pullStatus(p)
            return (
              <Link
                key={p.id}
                href={repoHref('/repo/pull', addr, { number: String(p.number) })}
                className="flex items-start gap-3 border-b border-anvil-100 px-4 py-3 last:border-b-0 hover:bg-anvil-50 dark:border-anvil-850 dark:hover:bg-anvil-900"
              >
                <span className={cn('mt-0.5 shrink-0', st.klass)}>{st.icon}</span>
                <div className="min-w-0 flex-1">
                  <span className="text-dense font-medium text-anvil-900 dark:text-anvil-50">{p.title || '(untitled)'}</span>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-anvil-400">
                    <span className="font-mono">#{p.number}</span>
                    <span>{st.label} · into <span className="font-mono">{p.baseRefName || '?'}</span> · {timeAgo(p.createdAt)} by</span>
                    <Author identityId={p.author} link={false} />
                    {p.headOid ? <Oid value={p.headOid} chars={7} copyable={false} /> : null}
                  </div>
                </div>
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}
