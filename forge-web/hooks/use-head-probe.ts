'use client'

/**
 * The open PR page notices new pushes (#453, qa5 C): {@link probeHead} every {@link PROBE_MS}
 * while the tab is visible, and when the tab is shown again or regains focus (at most once per
 * {@link FOCUS_THROTTLE_MS}). A hidden tab reads nothing: its timer skips the read, and showing
 * the tab reads at once, as the inbox poller does (`hooks/use-inbox.ts`).
 *
 * No probe on load (the page just read everything): the first is one interval after the page's
 * read, or on focus once the throttle allows. Once a probe finds something new the hook stops
 * until the page re-reads (a new `key`): the reader's Refresh, never the timer, re-reads the PR.
 *
 * Request budget: one composite per probe (`lib/repo/head-probe.ts`), so an idle visible tab
 * makes one request a minute and a hidden tab none.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import type { EvoSDK } from '@dashevo/evo-sdk'

import { probeHead, type EventMark, type NewPush, type ProbeBase } from '@/lib/repo/head-probe'

/** How often a visible tab probes. */
export const PROBE_MS = 60_000
/** Showing or focusing the tab probes at once, but not sooner than this after the last probe (or the page's read). */
export const FOCUS_THROTTLE_MS = 15_000

/**
 * Probe while `enabled` (an open PR, the SDK ready). `base` is what the page shows; `key` names
 * it (the PR, its head, its event mark, the branch state read): a new key is a new read of the
 * page, which starts the probe over (nothing found, the next probe an interval away).
 */
export function useHeadProbe(sdk: EvoSDK | null, enabled: boolean, base: ProbeBase | null, key: string): { found: NewPush | null; dismiss: () => void } {
  const [found, setFound] = useState<{ key: string; push: NewPush } | null>(null)
  const baseRef = useRef(base)
  baseRef.current = base
  // Ref updates announced on this page: an update the resolver ignores is not announced after every Refresh.
  const announced = useRef(new Set<string>())

  useEffect(() => {
    if (!enabled || sdk === null || baseRef.current === null) return
    let cancelled = false
    let inFlight = false
    let timer: ReturnType<typeof setTimeout> | null = null
    // The page's read counts as the last probe: the first is an interval (or a throttle) away.
    let last = Date.now()
    let events: EventMark | null = baseRef.current.events
    const schedule = (): void => {
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(() => void run(), Math.max(0, last + PROBE_MS - Date.now()))
    }
    const run = async (): Promise<void> => {
      const b = baseRef.current
      if (cancelled || inFlight || b === null) return
      if (document.visibilityState !== 'visible') {
        // Hidden: no read. Showing the tab probes (onShown), and the timer runs on from then.
        timer = null
        return
      }
      inFlight = true
      last = Date.now()
      try {
        const out = await probeHead(sdk, { ...b, events, announced: announced.current })
        if (cancelled) return
        if (out.found !== null) {
          if (out.found.refUpdateId !== null) announced.current.add(out.found.refUpdateId)
          setFound({ key, push: out.found })
          // Found: no more probes until the page re-reads (a new key).
          cancelled = true
          return
        }
        events = out.events
      } catch {
        // A failed probe is no news: the next one asks again.
      } finally {
        inFlight = false
      }
      if (!cancelled) schedule()
    }
    const onShown = (): void => {
      if (document.visibilityState !== 'visible' || Date.now() - last < FOCUS_THROTTLE_MS) {
        // Too soon after the last probe: keep (or restart) the interval instead.
        if (document.visibilityState === 'visible' && timer === null && !inFlight) schedule()
        return
      }
      void run()
    }
    schedule()
    document.addEventListener('visibilitychange', onShown)
    window.addEventListener('focus', onShown)
    return () => {
      cancelled = true
      if (timer !== null) clearTimeout(timer)
      document.removeEventListener('visibilitychange', onShown)
      window.removeEventListener('focus', onShown)
    }
  }, [sdk, enabled, key])

  const dismiss = useCallback(() => setFound(null), [])
  // A finding about an older read of the page is not news about this one.
  return { found: found !== null && found.key === key ? found.push : null, dismiss }
}
