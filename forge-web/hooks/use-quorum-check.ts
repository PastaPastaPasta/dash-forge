'use client'

/**
 * useQuorumCheck — the quorum-key cross-check for the active network, run once the SDK is
 * connected (so it never competes with the first paint), and again once its result is an hour
 * old (`QUORUM_CHECK_MAX_AGE_MS`), not on every routine reconnect. While a re-run goes, the
 * previous result stays on screen. `undefined` only before the first result.
 */

import { useEffect, useState } from 'react'

import { NETWORKS, type Network } from '@/lib/constants'
import { QUORUM_CHECK_MAX_AGE_MS, crossCheckQuorumKeysCached, lastQuorumCheck, type QuorumCrossCheck } from '@/lib/view'

export function useQuorumCheck(network: Network, enabled: boolean): QuorumCrossCheck | undefined {
  const config = NETWORKS[network]
  const [result, setResult] = useState<QuorumCrossCheck | undefined>(() => lastQuorumCheck(config))
  // Bumped each hour while mounted, so a page left open re-checks.
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), QUORUM_CHECK_MAX_AGE_MS)
    return () => clearInterval(id)
  }, [])
  useEffect(() => {
    if (!enabled) return
    let live = true
    setResult((r) => r ?? lastQuorumCheck(config))
    void crossCheckQuorumKeysCached(config).then((r) => {
      if (live) setResult(r)
    })
    return () => {
      live = false
    }
  }, [config, enabled, tick])
  return result
}
