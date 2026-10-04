'use client'

/**
 * The PR page's Commits and Checks tabs (review-parity P2, P3).
 *
 * - Commits: every commit the PR adds (`base..head`, newest first, capped at 250), each linking
 *   to its diff; the commits that applied review suggestions say so (`Forge-Suggestion:`).
 * - Checks: the newest `checkRun` per name on the PR head (or a commit), by current members and
 *   runners; a run whose reporter is no longer one is listed but not counted (parity: `dg pr
 *   checks`, `dg ci status`). A run's log is read from the reporter's storage and shown only
 *   with whether it hashed to the SHA-256 the run records. A required check pinned to a source
 *   (RC1 R-08) names it ("from ci-bot"); a run by anyone else is "not from the required source",
 *   and a required check nothing reported yet is listed as "Expected". A run's artifacts are
 *   offered for download the way release assets are: streamed from the reporter's storage and
 *   saved only if they hash to the recorded SHA-256. A maintainer or writer can ask the runners
 *   to re-run one completed forge-runner check, or every check (a CI re-run request, event kind
 *   26); a request no newer run answers yet is shown as requested, to everyone.
 */

import Link from 'next/link'
import { useState } from 'react'
import { CheckCircle2, CircleDashed, GitCommit, ListChecks, MinusCircle, RefreshCw, XCircle } from 'lucide-react'

import {
  checkOutcome,
  checksPhrase,
  fetchVerifiedLog,
  isRerunnable,
  runCounts,
  runDuration,
  safeDetailsUrl,
  safeLogUrl,
  untrustedWords,
  type CheckRun,
  type ChecksSummary,
  type ExpectedCheck,
  type VerifiedLog,
} from '@/lib/repo/checks'
import type { PrCommits } from '@/lib/view/pr-commits'
import { plural, timeAgo } from '@/lib/view'
import { Time } from '@/components/repo/byline'
import { repoHref, type RepoAddress } from '@/hooks/use-query-param'
import { errorMessage } from '@/lib/utils'
import { Author } from '@/components/author'
import { Oid } from '@/components/ui/oid'
import { ScrollRegion } from '@/components/ui/scroll-region'
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/states'
import { AssetRow } from '@/components/repo/releases-content'
import { Button } from '@/components/ui/button'
import type { RerunRequest } from '@/lib/rules/ci-rerun'

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
            {/* Touch: the subject link stretches over the whole text column (both lines and the
                row's padding), as on the commits list; the copy button beside it stays its own. */}
            <div className="relative min-w-0 flex-1">
              <Link href={repoHref('/repo/commit', at, { oid: c.oid })} className="block truncate text-dense font-medium text-anvil-900 hover:text-forge-800 coarse:after:absolute coarse:after:inset-x-0 coarse:after:-inset-y-2.5 coarse:after:content-[''] dark:text-anvil-50 dark:hover:text-forge-400">
                {c.subject || '(no message)'}
              </Link>
              {/* One line on a phone: the name gives way (ellipsis), the age never breaks. */}
              <div className="mt-0.5 flex min-w-0 items-center gap-1 text-[12px] text-anvil-500 dark:text-anvil-400">
                <span className="min-w-0 truncate">{c.commit.author.name || 'unknown'}</span>
                <span className="shrink-0 whitespace-nowrap">
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
  if (!runCounts(run)) return <MinusCircle className="h-4 w-4 text-anvil-500 dark:text-anvil-400" aria-hidden />
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
      {log.verified ? (
        <ScrollRegion as="pre" label={`Log of ${run.name}`} className="mt-1 max-h-96 overflow-auto rounded border border-anvil-200 bg-anvil-50 p-2 font-mono text-[12px] dark:border-anvil-800 dark:bg-anvil-950">
          {log.text}
        </ScrollRegion>
      ) : null}
    </div>
  )
}

/**
 * A run's artifacts, each downloaded from the reporter's storage and saved only when its bytes hash to the SHA-256 the
 * run records (the release-asset download, {@link AssetRow}).
 */
function RunArtifacts({ run }: { run: CheckRun }): JSX.Element {
  return (
    <div className="basis-full" data-testid="check-artifacts">
      <p className="text-[12px] text-anvil-500 dark:text-anvil-400">
        {plural(run.artifacts.length, 'artifact')}
        {runCounts(run) ? '' : ' (from a run that does not count)'}
      </p>
      <ul aria-label={`Artifacts of ${run.name}`} className="mt-1 divide-y divide-anvil-100 overflow-hidden rounded border border-anvil-200 dark:divide-anvil-850 dark:border-anvil-800">
        {run.artifacts.map((a, i) => (
          <AssetRow key={`${i}:${a.name}:${a.sha256}`} asset={a} />
        ))}
      </ul>
    </div>
  )
}

/** The Checks tab's CI re-run controls (a PR's head only). */
export interface RerunControls {
  /** The repo's runners: which runs a request reaches ({@link isRerunnable}). */
  readonly runners: ReadonlySet<string>
  /** Counted requests on the head that no newer run answers yet, by check (null: every check). */
  readonly pending: ReadonlyMap<string | null, RerunRequest>
  /** The viewer may ask (a maintainer or writer, on an open PR). */
  readonly canRequest: boolean
  /** Ask for `check` (null: every check) again: the page confirms and signs. */
  readonly onRerun: (check: string | null) => void
}

/**
 * A request no newer run answered this long after it is taken for one no runner will answer (a
 * runner polls every 2 minutes by default and handles a request once): Re-run is offered again.
 */
export const RERUN_STALE_MS = 10 * 60 * 1000

/** Whether a pending request still holds back Re-run ({@link RERUN_STALE_MS}). */
function holdsRerun(request: RerunRequest | undefined, now: number): boolean {
  return request !== undefined && now - request.createdAt < RERUN_STALE_MS
}

/** "Re-run requested 2 minutes ago": a request no newer run answers yet ("no run yet" once stale). */
function RerunRequested({ request, testId, now }: { request: RerunRequest; testId: string; now: number }): JSX.Element {
  return (
    <span className="flex items-center gap-1 text-[12px] text-caution-700 dark:text-caution-400" data-testid={testId}>
      <RefreshCw className="h-3.5 w-3.5" aria-hidden />
      Re-run requested {timeAgo(request.createdAt, now)}
      {holdsRerun(request, now) ? '' : ', no run yet'}
    </span>
  )
}

/** One row of the Checks tab list: a run, or an expected check. */
const CHECK_ROW = 'flex flex-wrap items-center gap-3 border-b border-anvil-100 px-4 py-2.5 last:border-b-0 dark:border-anvil-850'

export function ChecksTab({
  runs,
  summary,
  headOid,
  error,
  onRetry,
  subject = 'PR head',
  expected = [],
  rerun = null,
}: {
  runs: readonly CheckRun[] | null
  summary: ChecksSummary | null
  headOid: string
  error: string | null
  onRetry: () => void
  /** What `headOid` is, for the empty state: the PR head or a commit. */
  subject?: string
  /** Checks the branch policy requires that no run reports yet (`expectedChecks`). */
  expected?: readonly ExpectedCheck[]
  /** CI re-runs, on a PR's head; null on a commit's checks. */
  rerun?: RerunControls | null
}): JSX.Element {
  if (error !== null) return <ErrorState message={error} onRetry={onRetry} />
  if (runs === null || summary === null) return <LoadingBlock label="Reading check runs" />
  if (runs.length === 0 && expected.length === 0) {
    return (
      <EmptyState
        icon={ListChecks}
        title={`No checks reported for ${headOid.slice(0, 7)}`}
        body={`CI records check runs for the ${subject}: a runner the owner enrolled (dg ci runner new), the GitHub Action, or a maintainer or writer (dg ci report).`}
      />
    )
  }
  const now = Date.now()
  const rerunnable = (r: CheckRun): boolean => rerun !== null && isRerunnable(r, rerun.runners, now)
  const allPending = rerun?.pending.get(null) ?? null
  const allHeld = holdsRerun(allPending ?? undefined, now)
  const rerunAll =
    rerun?.canRequest === true && !allHeld && runs.some(rerunnable) ? (
      <Button variant="outline" size="sm" onClick={() => rerun.onRerun(null)} data-testid="checks-rerun-all">
        <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Re-run all checks
      </Button>
    ) : null
  return (
    <div data-testid="pr-checks">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p className="text-dense text-anvil-700 dark:text-anvil-200">
          {checksPhrase(summary)} on <Oid value={headOid} chars={7} copyable={false} />
        </p>
        <span className="flex flex-wrap items-center gap-2">
          {allPending !== null ? <RerunRequested request={allPending} testId="checks-rerun-all-pending" now={now} /> : null}
          {rerunAll}
        </span>
      </div>
      <ul className="overflow-hidden rounded-lg border border-anvil-200 dark:border-anvil-800">
        {runs.map((r) => {
          const url = safeDetailsUrl(r.detailsUrl)
          const state = r.status === 'completed' ? r.conclusion || 'completed' : r.status
          const duration = runDuration(r)
          const asked = rerun?.pending.get(r.name)
          return (
            <li key={r.id} className={CHECK_ROW} data-testid="check-run" data-name={r.name} data-outcome={checkOutcome(r)}>
              <CheckIcon run={r} />
              <span className="min-w-0 font-medium [overflow-wrap:anywhere]">{r.name}</span>
              {r.requiredSource !== null ? <RequiredSource source={r.requiredSource} /> : null}
              <span className="text-[12px] text-anvil-500 dark:text-anvil-400">{state}</span>
              {duration ? <span className="text-[12px] text-anvil-500 dark:text-anvil-400">{duration}</span> : null}
              {r.summary ? <span className="min-w-0 flex-1 truncate text-[12px] text-anvil-500 dark:text-anvil-400">{r.summary}</span> : <span className="flex-1" />}
              {!r.trusted ? (
                <span className="text-[11px] text-anvil-500 dark:text-anvil-400">{untrustedWords(summary)}</span>
              ) : !r.fromRequiredSource ? (
                <span className="text-[11px] text-caution-700 dark:text-caution-400" data-testid="check-off-source">
                  not from the required source: not counted
                </span>
              ) : null}
              <span className="flex items-center gap-1 text-[12px] text-anvil-500 dark:text-anvil-400">
                by <Author identityId={r.reporter} link={false} /> · {timeAgo(r.createdAt)}
              </span>
              {asked !== undefined ? <RerunRequested request={asked} testId="check-rerun-pending" now={now} /> : null}
              {rerun !== null && rerun.canRequest && !allHeld && !holdsRerun(asked, now) && rerunnable(r) ? (
                <button
                  type="button"
                  className="hit-area text-[12px] text-forge-700 underline underline-offset-2 dark:text-forge-400"
                  aria-label={`Re-run ${r.name}`}
                  data-testid="check-rerun"
                  onClick={() => rerun.onRerun(r.name)}
                >
                  Re-run
                </button>
              ) : null}
              {url ? (
                <a href={url} target="_blank" rel="noopener noreferrer" className="hit-area text-[12px] text-forge-700 underline underline-offset-2 dark:text-forge-400">
                  Details
                </a>
              ) : null}
              <RunLog key={`${r.id}:${r.logSha256}`} run={r} />
              {r.artifacts.length > 0 ? <RunArtifacts run={r} /> : null}
            </li>
          )
        })}
        {expected.map((c) => (
          <li key={`expected:${c.name}`} className={CHECK_ROW} data-testid="check-expected" data-name={c.name}>
            <CircleDashed className="h-4 w-4 text-caution-700 dark:text-caution-400" aria-hidden />
            <span className="min-w-0 font-medium [overflow-wrap:anywhere]">{c.name}</span>
            {c.source !== null ? <RequiredSource source={c.source} /> : null}
            <span className="text-[12px] text-anvil-500 dark:text-anvil-400">Expected — required, waiting for it to be reported</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** "· from ci-bot": the reporter the branch policy pins a required check to. */
function RequiredSource({ source }: { source: string }): JSX.Element {
  return (
    <span className="flex items-center gap-1 text-[12px] text-anvil-500 dark:text-anvil-400" data-testid="check-source">
      · from <Author identityId={source} link={false} />
    </span>
  )
}
