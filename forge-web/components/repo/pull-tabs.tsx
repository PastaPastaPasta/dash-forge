'use client'

/**
 * The PR page's Commits and Checks tabs (review-parity P2, P3).
 *
 * - Commits: every commit the PR adds (`base..head`, newest first, capped at 250), each linking
 *   to its diff; the commits that applied review suggestions say so (`Forge-Suggestion:`).
 * - Checks: the newest `checkRun` per name on the PR head, by current members; a run whose
 *   reporter is no longer a member is listed but not counted (parity: `dg pr checks`).
 */

import Link from 'next/link'
import { CheckCircle2, CircleDashed, GitCommit, ListChecks, MinusCircle, XCircle } from 'lucide-react'

import { checkOutcome, safeDetailsUrl, type CheckRun, type ChecksSummary } from '@/lib/repo/checks'
import type { PrCommits } from '@/lib/view/pr-commits'
import { timeAgo } from '@/lib/view'
import { repoHref, type RepoAddress } from '@/hooks/use-query-param'
import { Author } from '@/components/author'
import { Oid } from '@/components/ui/oid'
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/states'

export function CommitsTab({
  commits,
  error,
  loading,
  addr,
  sourceAddr,
  onRetry,
}: {
  commits: PrCommits | null
  error: string | null
  loading: boolean
  addr: RepoAddress
  /** Where the head's commits browse (the fork), when not this repo. */
  sourceAddr: RepoAddress | null
  onRetry: () => void
}): JSX.Element {
  if (error !== null) return <ErrorState message={error} onRetry={onRetry} />
  if (commits === null) return loading ? <LoadingBlock label="Walking the PR's commits" /> : <LoadingBlock label="Comparing the PR with its base" />
  if (commits.commits.length === 0) return <EmptyState icon={GitCommit} title="No commits" body="The base branch already contains this PR's head." />
  const at = sourceAddr ?? addr
  return (
    <div data-testid="pr-commits">
      <div className="overflow-hidden rounded-lg border border-anvil-200 dark:border-anvil-800">
        {commits.commits.map((c) => (
          <div key={c.oid} className="flex items-center gap-3 border-b border-anvil-100 px-4 py-2.5 last:border-b-0 dark:border-anvil-850" data-testid="pr-commit">
            <GitCommit className="h-4 w-4 shrink-0 text-anvil-500 dark:text-anvil-400" aria-hidden />
            <div className="min-w-0 flex-1">
              <Link href={repoHref('/repo/commit', at, { oid: c.oid })} className="block truncate text-dense font-medium text-anvil-900 hover:text-forge-800 dark:text-anvil-50 dark:hover:text-forge-400">
                {c.subject || '(no message)'}
              </Link>
              <div className="mt-0.5 flex items-center gap-2 text-[12px] text-anvil-500 dark:text-anvil-400">
                <span>{c.commit.author.name || 'unknown'}</span>
                <span>· {timeAgo(c.commit.committer.when)}</span>
              </div>
            </div>
            <Oid value={c.oid} chars={7} />
          </div>
        ))}
      </div>
      {commits.truncated ? (
        <p className="mt-2 text-[12px] text-anvil-500 dark:text-anvil-400">
          Showing the newest {commits.commits.length} of {commits.total >= commits.commits.length ? `${commits.total}+` : 'many'} commits. `dg pr commits` lists them all.
        </p>
      ) : null}
    </div>
  )
}

function CheckIcon({ run }: { run: CheckRun }): JSX.Element {
  const o = checkOutcome(run)
  if (!run.trusted) return <MinusCircle className="h-4 w-4 text-anvil-500 dark:text-anvil-400" aria-hidden />
  if (o === 'passed') return <CheckCircle2 className="h-4 w-4 text-verify-700 dark:text-verify-400" aria-hidden />
  if (o === 'failing') return <XCircle className="h-4 w-4 text-danger-700 dark:text-danger-400" aria-hidden />
  return <CircleDashed className="h-4 w-4 text-caution-700 dark:text-caution-400" aria-hidden />
}

/** "3 passed, 1 failing", "No checks reported". */
export function checksPhrase(s: ChecksSummary): string {
  if (s.total === 0) return 'No checks reported'
  const parts = [s.passed > 0 ? `${s.passed} passed` : '', s.failing > 0 ? `${s.failing} failing` : '', s.pending > 0 ? `${s.pending} pending` : ''].filter((p) => p !== '')
  return parts.join(', ')
}

export function ChecksTab({
  runs,
  summary,
  headOid,
  error,
  onRetry,
}: {
  runs: readonly CheckRun[] | null
  summary: ChecksSummary | null
  headOid: string
  error: string | null
  onRetry: () => void
}): JSX.Element {
  if (error !== null) return <ErrorState message={error} onRetry={onRetry} />
  if (runs === null || summary === null) return <LoadingBlock label="Reading check runs" />
  if (runs.length === 0) {
    return (
      <EmptyState
        icon={ListChecks}
        title={`No checks reported for ${headOid.slice(0, 7)}`}
        body="A CI integration (the forge-relay or the GitHub Action) records check runs for the PR head. They are written by the repo's maintainers and writers."
      />
    )
  }
  return (
    <div data-testid="pr-checks">
      <p className="mb-2 text-dense text-anvil-700 dark:text-anvil-200">
        {checksPhrase(summary)} on <Oid value={headOid} chars={7} copyable={false} />
      </p>
      <ul className="overflow-hidden rounded-lg border border-anvil-200 dark:border-anvil-800">
        {runs.map((r) => {
          const url = safeDetailsUrl(r.detailsUrl)
          const state = r.status === 'completed' ? r.conclusion || 'completed' : r.status
          return (
            <li key={r.id} className="flex flex-wrap items-center gap-3 border-b border-anvil-100 px-4 py-2.5 last:border-b-0 dark:border-anvil-850" data-testid="check-run" data-name={r.name} data-outcome={checkOutcome(r)}>
              <CheckIcon run={r} />
              <span className="font-medium">{r.name}</span>
              <span className="text-[12px] text-anvil-500 dark:text-anvil-400">{state}</span>
              {r.summary ? <span className="min-w-0 flex-1 truncate text-[12px] text-anvil-500 dark:text-anvil-400">{r.summary}</span> : <span className="flex-1" />}
              {!r.trusted ? <span className="text-[11px] text-anvil-500 dark:text-anvil-400">reporter is no longer a member: not counted</span> : null}
              <span className="flex items-center gap-1 text-[12px] text-anvil-500 dark:text-anvil-400">
                by <Author identityId={r.reporter} link={false} /> · {timeAgo(r.createdAt)}
              </span>
              {url ? (
                <a href={url} target="_blank" rel="noopener noreferrer" className="text-[12px] text-forge-700 underline underline-offset-2 dark:text-forge-400">
                  Details
                </a>
              ) : null}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
