/**
 * New-build detection (INC-14): a tab keeps running the build it loaded until it is reloaded, and
 * people keep Forge tabs open for days (a kept session lasts up to 12 hours). After an emergency
 * fix, nothing told an open tab. Every {@link CHECK_EVERY_MS} and whenever the tab is focused or
 * shown again, the app fetches the site's own `forge-manifest.json` (`scripts/build-manifest.mjs`)
 * with `cache: 'no-store'`; when its `commit` differs from this build's, or its operator `notice`
 * does (pausing or lifting a pause redeploys the same commit, docs/hosting.md), the shell shows
 * "A new version is available" with a reload button.
 *
 * Static and same-origin, so it stays within "we host nothing". It does nothing when it cannot
 * learn anything: no commit baked in, the IPFS variant (immutable, served by CID from any gateway,
 * and its manifest is its own), a manifest that is missing, unreadable or not a host build's.
 * There is no forced reload or `minSafeCommit` yet (post-launch).
 */

import { BUILD_COMMIT, servedCid } from './build-info'
import { PAGES_NOTICE } from './pages-notice'

/** How often an open, visible tab asks (10 to 15 minutes; the focus check covers the rest). */
export const CHECK_EVERY_MS = 12 * 60_000
/** Focus and visibility events fire in bursts; ask at most this often. */
export const MIN_GAP_MS = 60_000
/** A check that hangs must not leave detection stuck in flight for the tab's lifetime. */
const FETCH_TIMEOUT_MS = 15_000

export type BuildFreshness = 'same' | 'newer' | 'unknown'

/**
 * Compare this build with the one the site serves now. `unknown` when nothing was learned (see the
 * module comment): the caller shows nothing and asks again later.
 */
export async function checkForNewBuild(
  root: string,
  buildCommit: string = BUILD_COMMIT,
  fetchImpl: typeof fetch = fetch,
  buildNotice: string | null = PAGES_NOTICE?.mode ?? null,
): Promise<BuildFreshness> {
  if (!/^[0-9a-f]{40}$/.test(buildCommit)) return 'unknown'
  try {
    const res = await fetchImpl(new URL('forge-manifest.json', root).href, { cache: 'no-store', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!res.ok) return 'unknown'
    const manifest = (await res.json()) as { commit?: unknown; variant?: unknown; notice?: unknown }
    if (manifest.variant === 'ipfs') return 'unknown'
    if (typeof manifest.commit !== 'string' || !/^[0-9a-f]{40}$/.test(manifest.commit)) return 'unknown'
    const notice = typeof manifest.notice === 'string' ? manifest.notice : null
    return manifest.commit === buildCommit && notice === buildNotice ? 'same' : 'newer'
  } catch {
    return 'unknown'
  }
}

/** Whether this page is the IPFS variant, or is being served by CID from a gateway. */
export function isImmutableCopy(loc: Pick<Location, 'protocol' | 'hostname' | 'pathname'>): boolean {
  return process.env.FORGE_IPFS_BUILD === '1' || servedCid(loc) !== null
}

export interface NewBuildWatch {
  readonly root: string
  readonly onNewer: () => void
  readonly buildCommit?: string
  readonly fetchImpl?: typeof fetch
  readonly now?: () => number
}

/**
 * Start watching (browser only): on a timer, and on focus or visibility (the first check comes with
 * the first of those, not at start). Calls
 * `onNewer` once and then stops. Returns the stop function.
 */
export function watchForNewBuild(watch: NewBuildWatch, win: Window = window, doc: Document = document): () => void {
  const now = watch.now ?? Date.now
  let last = -Infinity
  let stopped = false
  let inFlight = false
  const stop = (): void => {
    stopped = true
    clearInterval(timer)
    win.removeEventListener('focus', check)
    doc.removeEventListener('visibilitychange', onVisible)
  }
  function check(): void {
    if (stopped || inFlight || now() - last < MIN_GAP_MS) return
    last = now()
    inFlight = true
    void checkForNewBuild(watch.root, watch.buildCommit, watch.fetchImpl).then((r) => {
      inFlight = false
      if (r === 'newer' && !stopped) {
        stop()
        watch.onNewer()
      }
    })
  }
  function onVisible(): void {
    if (doc.visibilityState === 'visible') check()
  }
  const timer = setInterval(() => {
    if (doc.visibilityState === 'visible') check()
  }, CHECK_EVERY_MS)
  win.addEventListener('focus', check)
  doc.addEventListener('visibilitychange', onVisible)
  return stop
}
