'use client'

/**
 * useQuorumCheck — the session's quorum-key cross-check for the active network, run once the
 * SDK is connected (so it never competes with the first paint). `undefined` while it runs.
 */

import { useEffect, useState } from 'react'

import { NETWORKS, type Network } from '@/lib/constants'
import { crossCheckQuorumKeysCached, type QuorumCrossCheck } from '@/lib/view'

export function useQuorumCheck(network: Network, enabled: boolean): QuorumCrossCheck | undefined {
  const [result, setResult] = useState<QuorumCrossCheck | undefined>(undefined)
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    void crossCheckQuorumKeysCached(NETWORKS[network]).then((r) => {
      if (!cancelled) setResult(r)
    })
    return () => {
      cancelled = true
    }
  }, [network, enabled])
  return result
}
