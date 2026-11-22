'use client'

/**
 * What a repo page shows while the repo resolves: the shell header from the address, the steps
 * of the read with the current one named ("Finding pocket-wallet on Dash Platform"), the seconds
 * spent, and a skeleton of the page under them. A read past {@link SLOW_AFTER_MS} says the
 * network is slow and offers Try again, instead of a bare spinner that could as well be stuck.
 */

import { Check, Circle, Loader2 } from 'lucide-react'
import { RepoShellHeader } from '@/components/repo/repo-shell-header'
import { DownloadProgressBar } from '@/components/ui/platform-status'
import { ListSkeleton, SLOW_AFTER_MS, SlowNote, useElapsed, useRetryAttempt } from '@/components/ui/states'
import { HOME_STAGES, type HomeStage } from '@/lib/view/home-progress'
import { ownerLabel } from '@/lib/page-title'
import type { SdkStatus } from '@/lib/sdk'
import type { RepoAddress } from '@/hooks/use-query-param'
import { cn } from '@/lib/utils'

type Step = 'connect' | HomeStage

const STEPS: readonly Step[] = ['connect', ...HOME_STAGES]

/** The words for a step of the read of the repo at `addr`. */
export function stepLabel(step: Step, addr: RepoAddress): string {
  switch (step) {
    case 'connect':
      return 'Connecting to Dash Platform'
    case 'owner':
      return `Looking up ${ownerLabel(addr.owner.replace(/^@/, ''))}`
    case 'repo':
      return `Finding ${addr.name || 'the repo'} on Dash Platform`
    case 'refs':
      return 'Loading branches and settings'
  }
}

/** The step under way: the SDK first, then the home read's own step (its first until it reports). */
export function currentStep(ready: boolean, stage: HomeStage | undefined): Step {
  return ready ? (stage ?? 'owner') : 'connect'
}

export function RepoLoading({
  addr,
  ready,
  stage,
  sdkStatus,
  onRetry,
}: {
  addr: RepoAddress
  /** The SDK is connected. */
  ready: boolean
  stage: HomeStage | undefined
  sdkStatus: SdkStatus
  onRetry: () => void
}): JSX.Element {
  const current = currentStep(ready, stage)
  const at = STEPS.indexOf(current)
  const [attempt, retry] = useRetryAttempt(onRetry)
  const elapsed = useElapsed(`${addr.owner}/${addr.name}/${addr.repoId ?? ''}/${attempt}`)
  const slow = elapsed * 1000 >= SLOW_AFTER_MS
  return (
    <>
      <RepoShellHeader addr={addr} />
      <div data-testid="repo-loading" data-step={current}>
        <div className="mb-4 rounded-lg border border-anvil-200 px-4 py-3 dark:border-anvil-800">
          <ol className="space-y-1.5" aria-label="Loading steps">
            {STEPS.map((step, i) => {
              const state = i < at ? 'done' : i === at ? 'current' : 'pending'
              return (
                <li
                  key={step}
                  className={cn(
                    'flex items-center gap-2 text-dense',
                    state === 'current' ? 'text-anvil-900 dark:text-anvil-50' : 'text-anvil-500 dark:text-anvil-400',
                  )}
                  aria-current={state === 'current' ? 'step' : undefined}
                >
                  {state === 'done' ? (
                    <Check className="h-4 w-4 text-verify-700 dark:text-verify-400" aria-hidden />
                  ) : state === 'current' ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                  ) : (
                    <Circle className="h-4 w-4" aria-hidden />
                  )}
                  <span>
                    {stepLabel(step, addr)}
                    {state === 'done' ? <span className="sr-only"> (done)</span> : null}
                  </span>
                  {state === 'current' ? (
                    <span className="ml-auto tabular-nums text-anvil-500 dark:text-anvil-400" data-testid="repo-loading-elapsed">
                      {elapsed} s
                    </span>
                  ) : null}
                </li>
              )
            })}
          </ol>
          <p role="status" className="sr-only">
            {stepLabel(current, addr)}…
          </p>
          {!ready && sdkStatus.phase === 'downloading' ? (
            <div className="mt-3 flex justify-center">
              <DownloadProgressBar status={sdkStatus} />
            </div>
          ) : null}
          {slow ? (
            <div className="mt-3 border-t border-anvil-200 pt-3 dark:border-anvil-800" data-testid="repo-loading-slow">
              <SlowNote onRetry={ready ? retry : undefined} />
            </div>
          ) : null}
        </div>
        <div aria-busy="true">
          <ListSkeleton rows={6} />
        </div>
      </div>
    </>
  )
}
