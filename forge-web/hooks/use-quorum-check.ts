'use client'

/**
 * useQuorumCheck — the session's quorum-key cross-check for the active network, run once the
 * SDK is connected (so it never competes with the first paint). `undefined` while it runs.
 */

import { useAsync } from '@/hooks/use-async'
import { NETWORKS, type Network } from '@/lib/constants'
import { crossCheckQuorumKeysCached, type QuorumCrossCheck } from '@/lib/view'

export function useQuorumCheck(network: Network, enabled: boolean): QuorumCrossCheck | undefined {
  return useAsync(() => crossCheckQuorumKeysCached(NETWORKS[network]), [network], { enabled }).data ?? undefined
}
