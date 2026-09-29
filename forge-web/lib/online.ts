/**
 * The browser's own view of the network (`navigator.onLine` and its `online`/`offline` events).
 * `false` from the browser is reliable (no network at all); `true` only means a network exists,
 * so reads still classify their own failures (`lib/sdk/unreachable.ts`).
 */

/** Whether the browser says it has no network now (false outside a browser). */
export function isOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false
}

/** Follow `online` / `offline` events (for `useSyncExternalStore`). Returns the unsubscribe. */
export function subscribeOnlineStatus(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined
  window.addEventListener('online', listener)
  window.addEventListener('offline', listener)
  return () => {
    window.removeEventListener('online', listener)
    window.removeEventListener('offline', listener)
  }
}
