'use client'

/**
 * The local notifications inbox, as React state (`ux-dx-spec.md` §5.10). One poller, mounted
 * by the header on every page, reads the chain every 60 s while the tab is visible and the
 * viewer is signed in; the header badge and `/notifications` read the same store. Everything
 * is computed and kept in this browser (IndexedDB); nothing is sent anywhere.
 */

import { useCallback, useEffect } from 'react'
import { create } from 'zustand'

import { useAuth } from '@/contexts/auth-context'
import { DEFAULT_NETWORK, NETWORKS, type Network } from '@/lib/constants'
import { ensureSdk } from '@/lib/sdk'
import { onSpendRecorded } from '@/lib/spend'
import { errorMessage } from '@/lib/utils'
import { resolveDpnsName } from '@/lib/view/dpns'
import {
  refreshesSubscriptions,
  threadKey,
  POLL_MS,
  loadItems,
  loadPrefs,
  loadSubs,
  markRead,
  pollOnce,
  savePrefs,
  type InboxItem,
  type InboxPrefs,
  type Subscriptions,
} from '@/lib/view/inbox'

interface InboxState {
  /** `<network>:<identity>` the state belongs to, or null when signed out. */
  readonly owner: string | null
  readonly items: readonly InboxItem[]
  readonly subs: Subscriptions | null
  readonly prefs: InboxPrefs | null
  readonly polling: boolean
  readonly lastPoll: number | null
  readonly lastFeeds: { read: number; total: number; failed: number } | null
  readonly error: string | null
  /** Bumped to ask the poller for an immediate round (optionally recomputing subscriptions). */
  readonly nudge: { n: number; refreshSubs: boolean }
}

const initial: InboxState = {
  owner: null,
  items: [],
  subs: null,
  prefs: null,
  polling: false,
  lastPoll: null,
  lastFeeds: null,
  error: null,
  nudge: { n: 0, refreshSubs: false },
}

export const useInboxStore = create<InboxState>(() => initial)

const set = (patch: Partial<InboxState>): void => useInboxStore.setState(patch)

/** How long after one of this tab's writes the poller recomputes its subscriptions. */
const PARTICIPATION_DELAY_MS = 2_000

/** Ask the poller for a round now, recomputing subscriptions (queued if one is in flight). */
function nudge(): void {
  set({ nudge: { n: useInboxStore.getState().nudge.n + 1, refreshSubs: true } })
}

/** Threads with something unread, for the header badge (the list shows one row per thread). */
export function useUnreadCount(): number {
  return useInboxStore((s) => new Set(s.items.filter((i) => !i.read).map(threadKey)).size)
}

async function reloadLocal(owner: string, network: Network, me: string): Promise<void> {
  const [items, subs, prefs] = await Promise.all([loadItems(network, me), loadSubs(network, me), loadPrefs(network, me)])
  const state = useInboxStore.getState()
  // Prefs are the store's once loaded: a poll finishing mid-toggle must not revert them.
  if (state.owner === owner) set({ items, subs: subs ?? null, prefs: state.prefs ?? prefs })
}

/**
 * Run the inbox poller for the signed-in identity. Mount exactly once, app-wide (the
 * `InboxPoller` in `Providers`), so page navigations never restart it. Polls on sign-in, then
 * every {@link POLL_MS} while the document is visible, and at once when the tab becomes
 * visible again or {@link useInboxActions} nudges. A nudge that arrives while a poll is in
 * flight is queued and runs right after it, never dropped.
 */
export function useInboxPoller(): void {
  const { identity } = useAuth()
  const network = DEFAULT_NETWORK
  const forge = NETWORKS[network].v2

  useEffect(() => {
    if (identity === null || forge === null) {
      set(initial)
      return
    }
    const owner = `${network}:${identity}`
    if (useInboxStore.getState().owner !== owner) set({ ...initial, owner })
    void reloadLocal(owner, network, identity)

    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    // My DPNS name, for mentions (`@name`); read once per identity, and a failed read retried
    // on the next round (an id is matched meanwhile).
    let name: string | null | undefined
    // Per effect (so a new identity never waits on the old one's poll).
    let inFlight = false
    let queued: { refreshSubs: boolean } | null = null
    // A subscription refresh asked for while the tab was hidden: the next visible round does it.
    let refreshWhenVisible = false
    const run = async (asked: boolean): Promise<void> => {
      if (cancelled) return
      if (inFlight) {
        queued = { refreshSubs: asked || (queued?.refreshSubs ?? false) }
        return
      }
      if (document.visibilityState !== 'visible') {
        refreshWhenVisible ||= asked
        return
      }
      const refreshSubs = asked || refreshWhenVisible
      refreshWhenVisible = false
      inFlight = true
      set({ polling: true })
      try {
        const sdk = await ensureSdk(network)
        if (name === undefined) name = await resolveDpnsName(sdk, identity, network).catch(() => undefined)
        const r = await pollOnce(sdk, network, forge, identity, { refreshSubs, stop: () => cancelled, name: name ?? null })
        if (cancelled || useInboxStore.getState().owner !== owner) return
        set({ lastPoll: Date.now(), lastFeeds: { read: r.feedsRead, total: r.feedsTotal, failed: r.failed }, error: null })
        await reloadLocal(owner, network, identity)
      } catch (e) {
        if (!cancelled) set({ error: errorMessage(e) })
      } finally {
        inFlight = false
        if (!cancelled) set({ polling: false })
        const next = queued
        queued = null
        if (next !== null && !cancelled) void run(next.refreshSubs)
      }
    }
    const schedule = (): void => {
      timer = setTimeout(() => {
        void run(false).finally(() => {
          if (!cancelled) schedule()
        })
      }, POLL_MS)
    }
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void run(false)
    }
    const unsubscribe = useInboxStore.subscribe((state, prev) => {
      if (state.nudge.n !== prev.nudge.n) void run(state.nudge.refreshSubs)
    })
    // QW-066: a thread this identity just took part in (a comment, a new issue or PR, a watch
    // or star) is watched from the next round, not after the subscriptions' next
    // refresh (up to SUBS_TTL_MS) or a reload. The write is confirmed; a short wait lets the
    // other nodes a read may reach catch up.
    let participation: ReturnType<typeof setTimeout> | null = null
    const offSpend = onSpendRecorded((e) => {
      if (e.identityId !== identity || e.network !== network || !refreshesSubscriptions(e.kind)) return
      if (participation !== null) clearTimeout(participation)
      participation = setTimeout(() => void run(true), PARTICIPATION_DELAY_MS)
    })
    void run(false)
    schedule()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      if (timer !== null) clearTimeout(timer)
      unsubscribe()
      offSpend()
      if (participation !== null) clearTimeout(participation)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [identity, forge, network])
}

/** The app-wide inbox poller as a component, for `Providers` (renders nothing). */
export function InboxPoller(): null {
  useInboxPoller()
  return null
}

/** Mark read, mark all read, change what is watched, poll now. */
export function useInboxActions(): {
  markRead: (ids: readonly string[]) => Promise<void>
  markAllRead: () => Promise<void>
  setPrefs: (prefs: InboxPrefs) => Promise<void>
  pollNow: () => void
} {
  const { identity } = useAuth()
  const network = DEFAULT_NETWORK
  const owner = identity === null ? null : `${network}:${identity}`
  const mark = useCallback(
    async (ids?: readonly string[]) => {
      if (identity === null || owner === null) return
      await markRead(network, identity, ids)
      await reloadLocal(owner, network, identity)
    },
    [identity, network, owner],
  )
  return {
    markRead: useCallback((ids: readonly string[]) => mark(ids), [mark]),
    markAllRead: useCallback(() => mark(), [mark]),
    setPrefs: useCallback(
      async (prefs: InboxPrefs) => {
        if (identity === null) return
        set({ prefs })
        await savePrefs(network, identity, prefs)
        nudge()
      },
      [identity, network],
    ),
    pollNow: useCallback(() => nudge(), []),
  }
}
