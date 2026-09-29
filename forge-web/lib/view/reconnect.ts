/**
 * Retry a read that failed because the network or Platform did not answer, once it can answer
 * again (L-10, L-56): offline waits for the browser's `online` event, a hidden tab for it to be
 * shown, and otherwise the retry backs off, so a node that stays down is not hammered (the DAPI
 * rate budget is shared by every tab).
 *
 * Per-repo read outages are recorded here too: a browse read whose bytes never arrived
 * ({@link noteReadOutage}) has the view re-read once the connection is back.
 */

import { isOffline } from '../online'

/** Waits before an automatic retry while the browser says it is online (the last repeats). */
const BACKOFF_MS: readonly number[] = [2_000, 5_000, 15_000, 30_000, 60_000]
/** After the browser comes back online, give its connections this long before retrying. */
const ONLINE_SETTLE_MS = 1_000
/** Automatic retries this close together count as one streak (the backoff grows along it). */
const STREAK_WINDOW_MS = 90_000

let streak = 0
let lastRetryAt = -Infinity

/** The wait before the next automatic retry, growing while retries keep failing. */
export function nextBackoff(now: number): number {
  streak = now - lastRetryAt < STREAK_WINDOW_MS ? streak + 1 : 0
  lastRetryAt = now
  return BACKOFF_MS[Math.min(streak, BACKOFF_MS.length - 1)] as number
}

/** Run `retry` once the page can plausibly read again. Returns a cancel function. */
export function scheduleReconnect(retry: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  let unlisten = (): void => undefined
  const wait = (target: EventTarget, event: string, then: () => void): void => {
    target.addEventListener(event, then, { once: true })
    unlisten = () => target.removeEventListener(event, then)
  }
  const arm = (): void => {
    if (isOffline()) wait(window, 'online', () => (timer = setTimeout(retry, ONLINE_SETTLE_MS)))
    else if (document.visibilityState === 'hidden') wait(document, 'visibilitychange', arm)
    else timer = setTimeout(retry, nextBackoff(Date.now()))
  }
  arm()
  return () => {
    clearTimeout(timer)
    unlisten()
  }
}

// ---------------------------------------------------------------------------------------------
// Per-repo read outages
// ---------------------------------------------------------------------------------------------

const outages = new Map<string, number>()
const listeners = new Set<() => void>()

/** A browse read of repo `key` got no bytes (offline, a node or mirror that did not answer). */
export function noteReadOutage(key: string): void {
  outages.set(key, (outages.get(key) ?? 0) + 1)
  for (const l of listeners) l()
}

/** How many read outages repo `key` has had this session (a view compares it with the last it handled). */
export function readOutages(key: string): number {
  return outages.get(key) ?? 0
}

export function subscribeReadOutages(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
