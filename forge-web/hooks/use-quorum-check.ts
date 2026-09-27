'use client'

/**
 * useQuorumCheck — the quorum-key cross-check for the active network's current connection,
 * run once the SDK is connected (so it never competes with the first paint), and again when a
 * reconnect replaces the connection (its keys were fetched again). `undefined` while it runs.
 */

import { useAsync } from '@/hooks/use-async'
import { useSdk } from '@/hooks/use-sdk'
import { NETWORKS, type Network } from '@/lib/constants'
import { crossCheckQuorumKeysCached, type QuorumCrossCheck } from '@/lib/view'

export function useQuorumCheck(network: Network, enabled: boolean): QuorumCrossCheck | undefined {
  const { generation } = useSdk()
  return useAsync(() => crossCheckQuorumKeysCached(NETWORKS[network], generation), [network, generation], { enabled }).data ?? undefined
}
