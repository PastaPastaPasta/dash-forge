/**
 * The error boundaries' automatic reload (`app/error.tsx`, `app/global-error.tsx`): a page whose
 * code failed to load is fetched again by a reload, at most {@link MAX_AUTO_RELOADS} times per
 * {@link RELOAD_WINDOW_MS}, counted in sessionStorage so the count survives the reload. A page
 * that fails the same way every time must not reload forever.
 */

import { errorMessage } from './utils'

const MAX_AUTO_RELOADS = 2
const RELOAD_WINDOW_MS = 5 * 60_000
const RELOADS_KEY = 'forge.autoReloads'

/** A failure to fetch the app's own code (a webpack chunk). */
export function isLoadFailure(e: unknown): boolean {
  const name = e instanceof Error ? e.name : ''
  return name === 'ChunkLoadError' || /loading (?:css )?chunk .* failed|failed to fetch dynamically imported module/i.test(errorMessage(e, ''))
}

/** Take one automatic reload from the budget; false when it is spent (or storage is blocked). */
export function takeAutoReload(storage: Pick<Storage, 'getItem' | 'setItem'>, now: number): boolean {
  try {
    const recent = (JSON.parse(storage.getItem(RELOADS_KEY) ?? '[]') as number[]).filter((t) => now - t < RELOAD_WINDOW_MS)
    if (recent.length >= MAX_AUTO_RELOADS) return false
    storage.setItem(RELOADS_KEY, JSON.stringify([...recent, now]))
    return true
  } catch {
    return false
  }
}


/** Reload the page if the budget allows (browser only). */
export function autoReload(): void {
  if (takeAutoReload(window.sessionStorage, Date.now())) window.location.reload()
}
