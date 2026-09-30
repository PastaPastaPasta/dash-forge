'use client'

/**
 * A status pill for reads that are held, not failed. Both states are statuses, not errors: the
 * requests go out again by themselves.
 *
 *  - "Platform is busy — waiting Ns": a DAPI node asked this browser to wait (`ratelimit-reset`)
 *    and a request is held for it (`lib/sdk/budget.ts`).
 *  - "Waiting for the network's new quorum…": the network rotated a quorum its quorum service
 *    does not list yet, so a proof signed by it cannot be checked; reads wait and reconnect until
 *    the service catches up (`lib/sdk/service.ts` `waitForQuorum`, #212).
 *
 * The browser's own pacing is not shown: those waits are short and the page is simply
 * loading.
 */

import { Hourglass } from 'lucide-react'
import { useEffect, useState, useSyncExternalStore } from 'react'

import { evoSdkService } from '@/lib/sdk'
import { dapiBudget, IDLE } from '@/lib/sdk/budget'

const subscribeSdk = (listener: () => void): (() => void) => evoSdkService.subscribe(listener)
const quorumHeld = (): boolean => evoSdkService.quorumWaitSince !== null

export function PlatformBusy(): JSX.Element | null {
  const { waitingUntil, cause } = useSyncExternalStore(dapiBudget.subscribe, dapiBudget.status, () => IDLE)
  const quorum = useSyncExternalStore(subscribeSdk, quorumHeld, () => false)
  const [now, setNow] = useState(() => Date.now())
  const waiting = cause === 'rate-limit' && waitingUntil !== null

  useEffect(() => {
    if (!waiting) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(timer)
  }, [waiting, waitingUntil])

  if (!waiting && !quorum) return null
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid={waiting ? 'platform-busy' : 'quorum-wait'}
      className="pointer-events-none fixed bottom-4 left-4 z-[60] flex items-center gap-2 rounded-full border border-caution/40 bg-white px-3 py-1.5 text-dense text-anvil-700 shadow-lg dark:bg-anvil-900 dark:text-anvil-200"
    >
      <Hourglass className="h-3.5 w-3.5 shrink-0 text-caution" aria-hidden />
      {waiting ? (
        <span>
          Platform is busy — waiting <span className="font-mono tabular-nums">{Math.max(1, Math.ceil((waitingUntil - now) / 1000))}s</span>
        </span>
      ) : (
        <span>Waiting for the network&rsquo;s new quorum…</span>
      )}
    </div>
  )
}
