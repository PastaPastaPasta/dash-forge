'use client'

/**
 * useQuorumCheck — the quorum-key cross-check for the active network, run once the SDK is
 * connected (so it never competes with the first paint), and again when its result reaches
 * `QUORUM_CHECK_MAX_AGE_MS` (an hour), not on every routine reconnect. While a re-run goes,
 * the previous result for the same network stays on screen. `undefined` only before the
 * network's first result.
 */

import { useEffect, useState } from 'react'

import { NETWORKS, type Network } from '@/lib/constants'
import { crossCheckQuorumKeysCached, lastQuorumCheck, quorumCheckDueInMs, type QuorumCrossCheck } from '@/lib/view'

export function useQuorumCheck(network: Network, enabled: boolean): QuorumCrossCheck | undefined {
  const config = NETWORKS[network]
  // Re-renders when a check settles; the result itself is read from the per-network cache,
  // so a network switch never shows another network's result.
  const [, setSeen] = useState<QuorumCrossCheck>()
  // Bumped when the held result is due again, so a page left open re-checks on time.
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!enabled) return
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    void crossCheckQuorumKeysCached(config).then((result) => {
      if (!live) return
      setSeen(result)
      // Due from when the cached result settled, not from this mount; at least a minute
      // apart, so a transient outcome is retried without a tight loop.
      timer = setTimeout(() => setTick((t) => t + 1), Math.max(60_000, quorumCheckDueInMs(config)))
    })
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [config, enabled, tick])
  return lastQuorumCheck(config)
}
