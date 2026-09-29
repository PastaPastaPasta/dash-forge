/**
 * Retry a read that failed because the network or Platform did not answer, once it can answer
 * again (L-10, L-56): offline waits for the browser's `online` event, a hidden tab for it to be
 * shown, and otherwise the retry backs off ({@link RECONNECT_BACKOFF_MS}), so a node that stays
 * down is not hammered (the DAPI rate budget is shared by every tab).
 *
 * Per-repo read outages are recorded here too: a browse read whose bytes never arrived
 * ({@link noteReadOutage}) has the view re-read once the connection is back.
 */

/** Waits before an automatic retry while the browser says it is online (the last repeats). */
export const RECONNECT_BACKOFF_MS: readonly number[] = [2_000, 5_000, 15_000, 30_000, 60_000]
/** After the browser comes back online, give its connections this long before retrying. */
export const ONLINE_SETTLE_MS = 1_000
/** Automatic retries this close together count as one streak (the backoff grows along it). */
const STREAK_WINDOW_MS = 90_000

let streak = 0
let lastRetryAt = -Infinity

/** The wait before the next automatic retry, growing while retries keep failing. */
export function nextBackoff(now: number = Date.now()): number {
  streak = now - lastRetryAt < STREAK_WINDOW_MS ? streak + 1 : 0
  lastRetryAt = now
  return RECONNECT_BACKOFF_MS[Math.min(streak, RECONNECT_BACKOFF_MS.length - 1)] as number
}

/** Test hook. */
export function resetReconnectBackoff(): void {
  streak = 0
  lastRetryAt = -Infinity
}

/**
 * Run `retry` once the page can plausibly read again. Returns a cancel function. Browser only;
 * a no-op elsewhere.
 */
export function scheduleReconnect(retry: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const cleanups: (() => void)[] = []
  const cancel = (): void => {
    clearTimeout(timer)
    cleanups.forEach((c) => c())
    cleanups.length = 0
  }
  const once = (target: EventTarget, event: string, then: () => void): void => {
    const on = (): void => {
      target.removeEventListener(event, on)
      then()
    }
    target.addEventListener(event, on)
    cleanups.push(() => target.removeEventListener(event, on))
  }
  const arm = (): void => {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      once(window, 'online', () => {
        timer = setTimeout(retry, ONLINE_SETTLE_MS)
      })
      return
    }
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      once(document, 'visibilitychange', arm)
      return
    }
    timer = setTimeout(retry, nextBackoff())
  }
  arm()
  return cancel
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
