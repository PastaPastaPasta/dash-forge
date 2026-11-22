'use client'

/**
 * What a write is doing while the user waits (`lib/sdk/write-progress.ts`): sending it, waiting
 * for Platform to confirm it, or checking whether it landed after that wait ran out, with the
 * seconds so far. Past {@link SLOW_MS} it says Platform is slow and that waiting is safe.
 *
 * {@link WriteProgressSteps} sits in a confirm dialog. {@link WriteInFlight} is the floating pill
 * for writes started outside one (a comment box, a star), shown once a write takes a moment;
 * it stays hidden while a dialog shows the steps, and while PlatformBusy says a request is held.
 */

import { Check, Loader2 } from 'lucide-react'
import { useEffect, useState, useSyncExternalStore } from 'react'

import { evoSdkService } from '@/lib/sdk'
import { dapiBudget, IDLE } from '@/lib/sdk/budget'
import { subscribeWriteProgress, writeProgress, type WritePhase, type WriteProgress } from '@/lib/sdk/write-progress'
import { cn } from '@/lib/utils'

/** When a write counts as slow: Platform usually confirms within a few seconds. */
const SLOW_MS = 15_000
/** How long a write runs before the floating pill shows (most land before it). */
const PILL_DELAY_MS = 2_500

const STEPS: readonly { readonly phase: WritePhase; readonly label: string }[] = [
  { phase: 'sending', label: 'Sign and send' },
  { phase: 'confirming', label: 'Platform confirms' },
]

const NOW: Readonly<Record<WritePhase, string>> = {
  sending: 'Signing and sending to Dash Platform…',
  confirming: 'Waiting for Dash Platform to confirm…',
  rechecking: 'No answer yet. Checking whether it landed…',
}

let dialogsShowing = 0
const dialogListeners = new Set<() => void>()
function setDialogsShowing(delta: number): void {
  dialogsShowing += delta
  for (const l of dialogListeners) l()
}
function subscribeDialogs(listener: () => void): () => void {
  dialogListeners.add(listener)
  return () => dialogListeners.delete(listener)
}
const dialogShowing = (): boolean => dialogsShowing > 0
const subscribeSdk = (listener: () => void): (() => void) => evoSdkService.subscribe(listener)
const quorumHeld = (): boolean => evoSdkService.quorumWaitSince !== null

/** The write in flight and the seconds it has run, re-rendered every second while it runs. */
function useWriteProgress(): { progress: WriteProgress | null; elapsed: number } {
  const progress = useSyncExternalStore(subscribeWriteProgress, writeProgress, () => null)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (progress === null) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [progress])
  return { progress, elapsed: progress === null ? 0 : Math.max(0, now - progress.startedAt) }
}

function seconds(ms: number): string {
  return `${Math.floor(ms / 1_000)}s`
}

/** The steps of the write in flight, for a confirm dialog while it runs. */
export function WriteProgressSteps(): JSX.Element {
  const { progress, elapsed } = useWriteProgress()
  useEffect(() => {
    setDialogsShowing(1)
    return () => setDialogsShowing(-1)
  }, [])
  // Between the writes of a multi-write action (or before the first is signed) there is no
  // write in flight: the action is still sending.
  const phase: WritePhase = progress?.phase ?? 'sending'
  const at = phase === 'sending' ? 0 : 1
  return (
    <div data-testid="write-progress" role="status" className="rounded-md border border-anvil-200 px-3 py-2.5 text-dense dark:border-anvil-750">
      <ol className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {STEPS.map((s, i) => (
          <li key={s.phase} className={cn('flex items-center gap-1.5', i > at ? 'text-anvil-400 dark:text-anvil-500' : 'text-anvil-800 dark:text-anvil-100')}>
            {i < at ? (
              <Check className="h-3.5 w-3.5 text-verify-700 dark:text-verify-400" aria-hidden />
            ) : i === at ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin text-forge-600 dark:text-forge-400" aria-hidden />
            ) : (
              <span className="inline-block h-3.5 w-3.5 rounded-full border border-current" aria-hidden />
            )}
            {s.label}
          </li>
        ))}
        {progress !== null ? <li aria-hidden className="ml-auto font-mono tabular-nums text-anvil-500 dark:text-anvil-400">{seconds(elapsed)}</li> : null}
      </ol>
      <p className="mt-1.5 text-[12px] text-anvil-600 dark:text-anvil-300">{NOW[phase]}</p>
      {elapsed >= SLOW_MS ? (
        <p data-testid="write-slow" className="mt-1 text-[12px] text-anvil-600 dark:text-anvil-300">
          Dash Platform is slower than usual. Keep this tab open: the write keeps going, and it is never sent twice.
        </p>
      ) : null}
    </div>
  )
}

/** The floating pill for a write running outside a confirm dialog. */
export function WriteInFlight(): JSX.Element | null {
  const { progress, elapsed } = useWriteProgress()
  const inDialog = useSyncExternalStore(subscribeDialogs, dialogShowing, () => false)
  // A held request says so in its own pill (PlatformBusy), in the same corner.
  const budget = useSyncExternalStore(dapiBudget.subscribe, dapiBudget.status, () => IDLE)
  const held = budget.cause === 'rate-limit' && budget.waitingUntil !== null
  const quorum = useSyncExternalStore(subscribeSdk, quorumHeld, () => false)
  if (progress === null || inDialog || held || quorum || elapsed < PILL_DELAY_MS) return null
  return (
    <div
      role="status"
      data-testid="write-in-flight"
      className="pointer-events-none fixed bottom-4 left-4 z-[60] flex max-w-[calc(100vw-2rem)] items-center gap-2 rounded-full border border-anvil-200 bg-white px-3 py-1.5 text-dense text-anvil-700 shadow-lg dark:border-anvil-750 dark:bg-anvil-900 dark:text-anvil-200"
    >
      <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-forge-600 dark:text-forge-400" aria-hidden />
      <span className="truncate">{elapsed >= SLOW_MS ? 'Platform is slow; still waiting…' : NOW[progress.phase]}</span>
      <span aria-hidden className="font-mono tabular-nums text-anvil-500 dark:text-anvil-400">{seconds(elapsed)}</span>
    </div>
  )
}
