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
import { errorMessage } from '@/lib/utils'
import {
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

/** Unread items, for the header badge. */
export function useUnreadCount(): number {
  return useInboxStore((s) => s.items.reduce((n, i) => n + (i.read ? 0 : 1), 0))
}

async function reloadLocal(owner: string, network: Network, me: string): Promise<void> {
  const [items, subs, prefs] = await Promise.all([loadItems(network, me), loadSubs(network, me), loadPrefs(network, me)])
  const state = useInboxStore.getState()
  // Prefs are the store's once loaded: a poll finishing mid-toggle must not revert them.
  if (state.owner === owner) set({ items, subs: subs ?? null, prefs: state.prefs ?? prefs })
}

/**
 * Run the inbox poller for the signed-in identity. Mount once (the header does). Polls on
 * sign-in, then every {@link POLL_MS} while the document is visible, and at once when the tab
 * becomes visible again or something {@link useInboxActions} nudges.
 */
export function useInboxPoller(): void {
  const { identity } = useAuth()
  const network = DEFAULT_NETWORK
  const forge = NETWORKS[network].v2
  const nudge = useInboxStore((s) => s.nudge)

  useEffect(() => {
    if (identity === null || forge === null) {
      set(initial)
      return
    }
    const owner = `${network}:${identity}`
    if (useInboxStore.getState().owner !== owner) set({ ...initial, owner })
    void reloadLocal(owner, network, identity)
  }, [identity, forge, network])

  useEffect(() => {
    if (identity === null || forge === null) return
    const owner = `${network}:${identity}`
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let refreshSubs = nudge.refreshSubs
    const run = async (): Promise<void> => {
      if (cancelled || useInboxStore.getState().polling) return
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
      set({ polling: true })
      try {
        const sdk = await ensureSdk(network)
        const r = await pollOnce(sdk, network, forge, identity, { refreshSubs })
        refreshSubs = false
        if (cancelled || useInboxStore.getState().owner !== owner) return
        set({ lastPoll: Date.now(), lastFeeds: { read: r.feedsRead, total: r.feedsTotal, failed: r.failed }, error: null })
        await reloadLocal(owner, network, identity)
      } catch (e) {
        if (!cancelled) set({ error: errorMessage(e) })
      } finally {
        set({ polling: false })
      }
    }
    const schedule = (): void => {
      timer = setTimeout(() => {
        void run().finally(() => {
          if (!cancelled) schedule()
        })
      }, POLL_MS)
    }
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void run()
    }
    void run()
    schedule()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      if (timer !== null) clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [identity, forge, network, nudge])
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
        set({ nudge: { n: useInboxStore.getState().nudge.n + 1, refreshSubs: true } })
      },
      [identity, network],
    ),
    pollNow: useCallback(() => set({ nudge: { n: useInboxStore.getState().nudge.n + 1, refreshSubs: true } }), []),
  }
}
