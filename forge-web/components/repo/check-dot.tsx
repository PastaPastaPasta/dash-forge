'use client'

/**
 * CheckDot — GitHub's commit status icon beside a PR or a commit in a list (O-07): a red X when any
 * run failed, else a yellow dot while any is pending, else a green check; nothing when no run was
 * reported. The label says how many ("2 successful, 1 failing checks").
 *
 * The counts are proved but are display only (`lib/repo/check-outcomes`): they cover the runs a
 * maintainer, writer or runner reported at the time; where re-runs disagree, the newest run of each
 * check counts, as in the Checks tab (a mixed dot when too many heads on the page need that).
 *
 * {@link useCheckOutcomes} reads them after the list renders, never delaying it: three proved counts
 * (`OUTCOME_REQUESTS`, one per outcome) per 100 heads the list has not read yet (a grown list reads
 * only what it adds), plus a run read per head whose re-runs disagree (`RESOLVE_MAX` at most),
 * nothing for heads read in the last minute, and the last known dots meanwhile.
 */

import { useMemo, useRef } from 'react'
import { Check, X } from 'lucide-react'

import { useAsync } from '@/hooks/use-async'
import { useSdk } from '@/hooks/use-sdk'
import { repoContractIds, repoKey, type RepoRef } from '@/lib/repo'
import {
  cachedOutcomeCounts,
  checkDotState,
  headsOf,
  outcomePhrase,
  readOutcomeCounts,
  type CheckDotState,
  type OutcomeCounts,
} from '@/lib/repo/check-outcomes'

/** What the count covers, for the tooltip: reported runs, the latest of each check where re-runs disagree. */
const SCOPE = 'Runs a maintainer, writer or runner reported on this commit; where re-runs disagree, the latest run of each check counts. Open it for the checks that count.'

/**
 * The run counts of `headOids` (hex) in `repo`, keyed by lowercase head. Shows the last known counts
 * (however old) until the read answers, and keeps them when it fails.
 */
export function useCheckOutcomes(repo: RepoRef, headOids: readonly string[]): ReadonlyMap<string, OutcomeCounts> {
  const { sdk, ready } = useSdk(repoContractIds(repo))
  const heads = useMemo(() => headsOf(headOids), [headOids])
  const key = repoKey(repo)
  // Heads this list has read, per repo: a page it adds reads only its own heads, even past the TTL.
  const done = useRef({ key, heads: new Set<string>() })
  const known = (): Map<string, OutcomeCounts> => cachedOutcomeCounts(repo, heads, Infinity)
  const read = useAsync(
    async () => {
      if (done.current.key !== key) done.current = { key, heads: new Set() }
      const asked = done.current.heads
      const counts = await readOutcomeCounts(sdk!, repo, heads.filter((h) => !asked.has(h)))
      for (const h of counts.keys()) asked.add(h)
      return new Map([...known(), ...counts])
    },
    [ready, key, heads.join(',')],
    { enabled: ready && sdk !== null && heads.length > 0, initial: known },
  )
  return read.data ?? known()
}

/** The icon of a dot state: GitHub's red X, yellow dot and green check. */
function DotIcon({ state }: { state: CheckDotState }): JSX.Element {
  switch (state) {
    case 'failure':
      return <X className="h-4 w-4 text-danger-700 dark:text-danger-400" strokeWidth={2.5} aria-hidden />
    case 'pending':
      return <span className="h-2 w-2 rounded-full bg-caution dark:bg-caution-400" aria-hidden />
    case 'success':
      return <Check className="h-4 w-4 text-verify-700 dark:text-verify-400" strokeWidth={2.5} aria-hidden />
    case 'mixed':
      // Neither red nor green: open the commit for the latest run of each check.
      return <span className="h-2 w-2 rounded-full border border-anvil-500 dark:border-anvil-400" aria-hidden />
  }
}

/** The status icon for one commit's counts; nothing when none were reported (or not read yet). */
export function CheckDot({ counts }: { counts: OutcomeCounts | undefined }): JSX.Element | null {
  if (counts === undefined) return null
  const state = checkDotState(counts)
  if (state === null) return null
  const phrase = outcomePhrase(counts)
  return (
    <span
      role="img"
      aria-label={phrase}
      title={`${phrase}\n${SCOPE}`}
      data-testid="check-dot"
      data-state={state}
      className="inline-flex h-4 w-4 shrink-0 items-center justify-center"
    >
      <DotIcon state={state} />
    </span>
  )
}
