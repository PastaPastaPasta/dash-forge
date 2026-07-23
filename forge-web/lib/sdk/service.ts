/**
 * evo-sdk singleton service — the one Platform connection for the whole app.
 *
 * S0.3 (DECIDED): the ONLY WASM-viable connection is `EvoSDK.testnetTrusted()` /
 * `mainnetTrusted()` with `*WithProof` reads. `EvoSDK.testnet()` and `{proofs:false}`
 * both crash WASM, so forge-web is trust-minimized (quorum keys from a known endpoint),
 * never "fully trustless". Proofs are always on (~0% per-query overhead).
 *
 * Pattern ported from yappr's `evo-sdk-service`: idempotent initialize, in-flight promise
 * dedupe, contract preload before marking ready, and reconnect. One process-wide instance.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import type { Network } from '../constants'
import { setPlatformVersion } from './query'

export interface EvoSdkConfig {
  readonly network: Network
  /** Contract ids to preload (registry + the repo contract(s) in view + DPNS). */
  readonly contractIds: readonly string[]
  /** Per-request timeout (ms). */
  readonly timeoutMs?: number
}

interface ContractsFacadeLike {
  fetch: (contractId: string) => Promise<unknown>
}
interface SdkContractsLike {
  contracts: ContractsFacadeLike
}

class EvoSdkService {
  private sdk: EvoSDK | null = null
  private initPromise: Promise<void> | null = null
  private config: EvoSdkConfig | null = null
  private ready = false

  /** Whether the SDK is connected and its contracts are preloaded. */
  get isReady(): boolean {
    return this.ready
  }

  /**
   * Connect (idempotent). Re-initializes only if the network changed; if new contract ids
   * appear for the same network they are preloaded without tearing down the connection.
   */
  async initialize(config: EvoSdkConfig): Promise<void> {
    if (this.ready && this.config && this.config.network === config.network) {
      const missing = config.contractIds.filter((id) => !this.config?.contractIds.includes(id))
      if (missing.length > 0) {
        await this.preload(missing)
        this.config = { ...config, contractIds: [...this.config.contractIds, ...missing] }
      }
      return
    }
    if (this.initPromise) {
      await this.initPromise
      if (this.config?.network === config.network) return
    }
    if (this.ready && this.config && this.config.network !== config.network) {
      this.cleanup()
    }

    this.config = config
    this.initPromise = this.perform(config)
    try {
      await this.initPromise
    } finally {
      this.initPromise = null
    }
  }

  private async perform(config: EvoSdkConfig): Promise<void> {
    const options = { settings: { timeoutMs: config.timeoutMs ?? 8000 } }
    // Dynamic import so the ~9.4 MB evo-sdk WASM chunk loads on first data need (post-paint),
    // never in the initial bundle — the whole app is a static-export SPA (yappr lazy-init pattern).
    const { EvoSDK } = await import('@dashevo/evo-sdk')
    this.sdk =
      config.network === 'mainnet'
        ? EvoSDK.mainnetTrusted(options)
        : EvoSDK.testnetTrusted(options)
    await this.sdk.connect()
    // Pin the DPP version so read normalization (`toJSON`) matches the connected network.
    try {
      const version = (this.sdk as unknown as { version(): number }).version()
      setPlatformVersion(version)
    } catch {
      // Keep the default version if the SDK cannot report one.
    }
    // Preload BEFORE marking ready so getSdk() callers never see an unwarmed SDK.
    await this.preload(config.contractIds)
    this.ready = true
  }

  private async preload(contractIds: readonly string[]): Promise<void> {
    if (!this.sdk) return
    const contracts = (this.sdk as unknown as SdkContractsLike).contracts
    await Promise.all(
      contractIds.map((id) =>
        contracts.fetch(id).catch(() => {
          // A missing/unreachable contract must not abort the whole warm-up; the caller's
          // first query against it will surface the real error with context.
          return undefined
        }),
      ),
    )
  }

  /** The connected SDK. Throws if not yet initialized. */
  getSdk(): EvoSDK {
    if (!this.sdk || !this.ready) {
      throw new Error('EvoSDK not initialized — call initialize() first')
    }
    return this.sdk
  }

  /** Force a fresh connection (e.g. after a network drop). Preserves the config. */
  async reconnect(): Promise<void> {
    if (!this.config) throw new Error('cannot reconnect before initialize()')
    const config = this.config
    this.cleanup()
    this.config = config
    this.initPromise = this.perform(config)
    try {
      await this.initPromise
    } finally {
      this.initPromise = null
    }
  }

  /** Drop the connection and reset state. */
  cleanup(): void {
    this.sdk = null
    this.ready = false
    this.config = null
    this.initPromise = null
  }
}

/** The process-wide evo-sdk service singleton. */
export const evoSdkService = new EvoSdkService()
