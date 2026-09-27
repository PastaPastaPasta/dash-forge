'use client'

/**
 * useSdk — lazy, client-only evo-sdk connection for read paths.
 *
 * The WASM SDK cannot run during SSG (S0.3), so every data page mounts a loading shell on the
 * server and calls this hook after hydration. It initializes the process-wide {@link evoSdkService}
 * on the active network with the DPNS and forge-v2 contracts preloaded (plus any extra ids the
 * caller names). Idempotent: repeated mounts share the one connection.
 *
 * The hook follows the service: a failed connect reports `error` and the service retries it
 * with backoff (`retry` tries at once); a later successful connect, or a connection swapped in
 * by a refresh, re-renders every caller with `ready` and a new `generation`.
 */

import { useCallback, useEffect, useSyncExternalStore } from 'react'
import type { EvoSDK } from '@dashevo/evo-sdk'

import { DEFAULT_NETWORK, NETWORKS, type Network } from '@/lib/constants'
import { evoSdkService, type SdkStatus } from '@/lib/sdk'

interface SdkState {
  readonly sdk: EvoSDK | null
  readonly ready: boolean
  /** The connection proof-checks its reads (see `evoSdkService.isTrusted`). */
  readonly trusted: boolean
  /** Why the connect failed, while it is failing; null otherwise. */
  readonly error: string | null
  readonly network: Network
  /** Download / connect / failure detail for the loading and unreachable UI. */
  readonly status: SdkStatus
  /** Increments whenever a new connection goes live. */
  readonly generation: number
  /** Increments when Platform is reachable again after an outage (re-read what failed). */
  readonly recoveries: number
  /** Try a failed connect again now. */
  readonly retry: () => void
}

const subscribe = (listener: () => void): (() => void) => evoSdkService.subscribe(listener)
const getStatus = (): SdkStatus => evoSdkService.getStatus()
const getGeneration = (): number => evoSdkService.generation
const getRecoveries = (): number => evoSdkService.recoveryCount
const SERVER_STATUS: SdkStatus = { phase: 'idle' }

/** Connect the SDK (idempotent). Pass extra contract ids (e.g. a repo contract) to preload. */
export function useSdk(extraContractIds: readonly string[] = []): SdkState {
  const network = DEFAULT_NETWORK
  const status = useSyncExternalStore(subscribe, getStatus, () => SERVER_STATUS)
  const generation = useSyncExternalStore(subscribe, getGeneration, () => 0)
  const recoveries = useSyncExternalStore(subscribe, getRecoveries, () => 0)

  // Stable dependency key so a changing array identity doesn't reconnect on every render.
  // The effect reconstructs the id list from `key` alone (never closes over the array prop),
  // which keeps the dependency list exhaustive without a lint escape hatch.
  const key = extraContractIds.join(',')

  useEffect(() => {
    const { dpnsContractId: dpns, v2 } = NETWORKS[network]
    const extras = key.length > 0 ? key.split(',') : []
    const contractIds = [
      ...new Set(
        [dpns, v2?.core, v2?.collab, ...extras].filter(
          (id): id is string => typeof id === 'string' && id.length > 0,
        ),
      ),
    ]
    // The outcome reaches every caller through the service's status.
    evoSdkService.initialize({ network, contractIds, timeoutMs: 15000 }).catch(() => undefined)
  }, [key, network])

  const retry = useCallback(() => evoSdkService.retryNow(), [])
  // A connection exists. It stays true while Platform is unreachable after a connect, so views
  // keep what they already read (under the unreachable banner) instead of resetting.
  const ready = generation > 0 && evoSdkService.isReady
  return {
    sdk: ready ? evoSdkService.getSdk() : null,
    ready,
    trusted: ready && evoSdkService.isTrusted,
    error: status.phase === 'error' ? status.message : null,
    network,
    status,
    generation,
    recoveries,
    retry,
  }
}
