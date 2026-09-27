'use client'

/**
 * "Platform is busy — waiting Ns": shown while a DAPI node has asked this browser to wait
 * (`ratelimit-reset`) and a request is held for it. This is a status, not an error; the
 * request goes out again by itself when the wait ends (`lib/sdk/budget.ts`).
 *
 * The browser's own pacing is not shown: those waits are short and the page is simply
 * loading.
 */

import { Hourglass } from 'lucide-react'
import { useEffect, useState, useSyncExternalStore } from 'react'

import { dapiBudget, IDLE } from '@/lib/sdk/budget'

export function PlatformBusy(): JSX.Element | null {
  const { waitingUntil, cause } = useSyncExternalStore(dapiBudget.subscribe, dapiBudget.status, () => IDLE)
  const [now, setNow] = useState(() => Date.now())
  const waiting = cause === 'rate-limit' && waitingUntil !== null

  useEffect(() => {
    if (!waiting) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(timer)
  }, [waiting, waitingUntil])

  if (!waiting) return null
  const seconds = Math.max(1, Math.ceil((waitingUntil - now) / 1000))
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="platform-busy"
      className="pointer-events-none fixed bottom-4 left-4 z-[60] flex items-center gap-2 rounded-full border border-caution/40 bg-white px-3 py-1.5 text-dense text-anvil-700 shadow-lg dark:bg-anvil-900 dark:text-anvil-200"
    >
      <Hourglass className="h-3.5 w-3.5 shrink-0 text-caution" aria-hidden />
      <span>
        Platform is busy — waiting <span className="font-mono tabular-nums">{seconds}s</span>
      </span>
    </div>
  )
}
