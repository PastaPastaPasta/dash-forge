'use client'

/**
 * useSdk — lazy, client-only evo-sdk connection for read paths.
 *
 * The WASM SDK cannot run during SSG (S0.3), so every data page mounts a loading shell on the
 * server and calls this hook after hydration. It initializes the process-wide {@link evoSdkService}
 * on the active network with the registry + DPNS contracts preloaded, and (optionally) a repo
 * contract in view. Idempotent: repeated mounts share the one connection.
 */

import { useEffect, useState } from 'react'
import type { EvoSDK } from '@dashevo/evo-sdk'

import { DEFAULT_NETWORK, NETWORKS, type Network } from '@/lib/constants'
import { evoSdkService } from '@/lib/sdk'
import { errorMessage } from '@/lib/utils'

interface SdkState {
  readonly sdk: EvoSDK | null
  readonly ready: boolean
  readonly error: string | null
  readonly network: Network
}

/** Connect the SDK (idempotent). Pass extra contract ids (e.g. a repo contract) to preload. */
export function useSdk(extraContractIds: readonly string[] = []): SdkState {
  const network = DEFAULT_NETWORK
  const [state, setState] = useState<SdkState>({
    sdk: evoSdkService.isReady ? safeGet() : null,
    ready: evoSdkService.isReady,
    error: null,
    network,
  })

  // Stable dependency key so a changing array identity doesn't reconnect on every render.
  // The effect reconstructs the id list from `key` alone (never closes over the array prop),
  // which keeps the dependency list exhaustive without a lint escape hatch.
  const key = extraContractIds.join(',')

  useEffect(() => {
    let cancelled = false
    const registry = NETWORKS[network].registryContractId
    const dpns = NETWORKS[network].dpnsContractId
    const extras = key.length > 0 ? key.split(',') : []
    const contractIds = [registry, dpns, ...extras].filter(
      (id): id is string => typeof id === 'string' && id.length > 0,
    )
    evoSdkService
      .initialize({ network, contractIds, timeoutMs: 15000 })
      .then(() => {
        if (cancelled) return
        setState({ sdk: evoSdkService.getSdk(), ready: true, error: null, network })
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setState({ sdk: null, ready: false, error: errorMessage(e, 'could not reach Platform'), network })
      })
    return () => {
      cancelled = true
    }
  }, [key, network])

  return state
}

function safeGet(): EvoSDK | null {
  try {
    return evoSdkService.getSdk()
  } catch {
    return null
  }
}
