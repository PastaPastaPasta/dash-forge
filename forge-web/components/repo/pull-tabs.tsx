'use client'

/**
 * The PR page's Commits and Checks tabs (review-parity P2, P3).
 *
 * - Commits: every commit the PR adds (`base..head`, newest first, capped at 250), each linking
 *   to its diff; the commits that applied review suggestions say so (`Forge-Suggestion:`).
 * - Checks: the newest `checkRun` per name on the PR head (or a commit), by current members and
 *   runners; a run whose reporter is no longer one is listed but not counted (parity: `dg pr
 *   checks`, `dg ci status`). A run's log is read from the reporter's storage and shown only
 *   with whether it hashed to the SHA-256 the run records.
 */

import Link from 'next/link'
import { useState } from 'react'
import { CheckCircle2, CircleDashed, GitCommit, ListChecks, MinusCircle, XCircle } from 'lucide-react'

import { checkOutcome, checksPhrase, fetchVerifiedLog, runDuration, safeDetailsUrl, safeLogUrl, untrustedWords, type CheckRun, type ChecksSummary, type VerifiedLog } from '@/lib/repo/checks'
import type { PrCommits } from '@/lib/view/pr-commits'
import { plural, timeAgo } from '@/lib/view'
import { Time } from '@/components/repo/byline'
import { repoHref, type RepoAddress } from '@/hooks/use-query-param'
import { errorMessage } from '@/lib/utils'
import { Author } from '@/components/author'
import { Oid } from '@/components/ui/oid'
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/states'

export function CommitsTab({
  commits,
  error,
  loading,
  addr,
  sourceAddr,
  unavailable,
  onRetry,
}: {
  commits: PrCommits | null
  error: string | null
  loading: boolean
  /** Why the comparison cannot run at all (no head, or no side loaded), or null. */
  unavailable: string | null
  addr: RepoAddress
  /** Where the head's commits browse (the fork), when not this repo. */
  sourceAddr: RepoAddress | null
  onRetry: () => void
}): JSX.Element {
  if (error !== null) return <ErrorState message={error} onRetry={onRetry} />
  if (commits === null && unavailable !== null) return <EmptyState icon={GitCommit} title="Commits unavailable" body={unavailable} />
  if (commits === null) return loading ? <LoadingBlock label="Walking the PR's commits" /> : <LoadingBlock label="Comparing the PR with its base" />
  if (commits.commits.length === 0) return <EmptyState icon={GitCommit} title="No commits" body="The base branch already contains this PR's head." />
  return <CommitList commits={commits} addr={sourceAddr ?? addr} allHint="`dg pr commits` lists them all." />
}

/** Commits, newest first, each linking to its page in the repo at `addr`; `allHint` says how to see a cut list whole. */
export function CommitList({ commits, addr: at, allHint }: { commits: PrCommits; addr: RepoAddress; allHint: string }): JSX.Element {
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
                <span>
                  · <Time ms={c.commit.author.when} prefix="authored " />
                </span>
              </div>
            </div>
            <Oid value={c.oid} chars={7} />
          </div>
        ))}
      </div>
      {commits.truncated ? (
        <p className="mt-2 text-[12px] text-anvil-500 dark:text-anvil-400">
          Showing the newest {commits.commits.length} of {plural(commits.total ?? 'many', 'commit')}. {allHint}
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

type LogState = { kind: 'idle' } | { kind: 'loading' } | { kind: 'done'; log: VerifiedLog } | { kind: 'error'; message: string }

/** A run's log, fetched on demand and checked against its recorded SHA-256. */
function RunLog({ run }: { run: CheckRun }): JSX.Element | null {
  const [state, setState] = useState<LogState>({ kind: 'idle' })
  if (safeLogUrl(run.logUrl) === null || run.logSha256 === '') return null
  if (state.kind === 'idle' || state.kind === 'loading') {
    return (
      <button
        type="button"
        className="text-[12px] text-forge-700 underline underline-offset-2 dark:text-forge-400"
        data-testid="check-log-open"
        disabled={state.kind === 'loading'}
        onClick={() => {
          setState({ kind: 'loading' })
          fetchVerifiedLog(run).then(
            (log) => setState({ kind: 'done', log }),
            (e: unknown) => setState({ kind: 'error', message: errorMessage(e, 'the log could not be read') }),
          )
        }}
      >
        {state.kind === 'loading' ? 'Reading log…' : 'Log'}
      </button>
    )
  }
  if (state.kind === 'error') return <span className="basis-full text-[12px] text-danger-700 dark:text-danger-400" data-testid="check-log-error">Log: {state.message}</span>
  const { log } = state
  return (
    <div className="basis-full" data-testid="check-log" data-verified={log.verified}>
      <p className={log.verified ? 'text-[12px] text-verify-700 dark:text-verify-400' : 'text-[12px] font-medium text-danger-700 dark:text-danger-400'}>
        {log.verified
          ? `Log verified: its SHA-256 matches the one the run records (${log.bytes} bytes)`
          : `Not the reported log: these bytes hash to ${log.sha256.slice(0, 12)}…, the run records ${run.logSha256.slice(0, 12)}…`}
      </p>
      {log.verified ? <pre className="mt-1 max-h-96 overflow-auto rounded border border-anvil-200 bg-anvil-50 p-2 font-mono text-[12px] dark:border-anvil-800 dark:bg-anvil-950">{log.text}</pre> : null}
    </div>
  )
}

export function ChecksTab({
  runs,
  summary,
  headOid,
  error,
  onRetry,
  subject = 'PR head',
}: {
  runs: readonly CheckRun[] | null
  summary: ChecksSummary | null
  headOid: string
  error: string | null
  onRetry: () => void
  /** What `headOid` is, for the empty state: the PR head or a commit. */
  subject?: string
}): JSX.Element {
  if (error !== null) return <ErrorState message={error} onRetry={onRetry} />
  if (runs === null || summary === null) return <LoadingBlock label="Reading check runs" />
  if (runs.length === 0) {
    return (
      <EmptyState
        icon={ListChecks}
        title={`No checks reported for ${headOid.slice(0, 7)}`}
        body={`CI records check runs for the ${subject}: a runner the owner enrolled (dg ci runner new), the GitHub Action, or a maintainer or writer (dg ci report).`}
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
          const duration = runDuration(r)
          return (
            <li key={r.id} className="flex flex-wrap items-center gap-3 border-b border-anvil-100 px-4 py-2.5 last:border-b-0 dark:border-anvil-850" data-testid="check-run" data-name={r.name} data-outcome={checkOutcome(r)}>
              <CheckIcon run={r} />
              <span className="font-medium">{r.name}</span>
              <span className="text-[12px] text-anvil-500 dark:text-anvil-400">{state}</span>
              {duration ? <span className="text-[12px] text-anvil-500 dark:text-anvil-400">{duration}</span> : null}
              {r.summary ? <span className="min-w-0 flex-1 truncate text-[12px] text-anvil-500 dark:text-anvil-400">{r.summary}</span> : <span className="flex-1" />}
              {!r.trusted ? <span className="text-[11px] text-anvil-500 dark:text-anvil-400">{untrustedWords(summary)}</span> : null}
              <span className="flex items-center gap-1 text-[12px] text-anvil-500 dark:text-anvil-400">
                by <Author identityId={r.reporter} link={false} /> · {timeAgo(r.createdAt)}
              </span>
              {url ? (
                <a href={url} target="_blank" rel="noopener noreferrer" className="text-[12px] text-forge-700 underline underline-offset-2 dark:text-forge-400">
                  Details
                </a>
              ) : null}
              <RunLog key={`${r.id}:${r.logSha256}`} run={r} />
            </li>
          )
        })}
      </ul>
    </div>
  )
}
